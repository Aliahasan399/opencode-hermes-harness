/**
 * OpenCode V2 plugin for the persistent memory engine.
 * Automatic retrieval: on each prompt it asks the local CLI for compact, relevant
 * memories and injects them as additional system context.
 * Automatic learning: when a turn ends it sends the collected prompt/tool transcript
 * to the local CLI's heuristic learner. Everything fails open.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = "E:\\OpenCodeData\\memory\\engine\\src\\cli.js";
const FINALIZER = "E:\\OpenCodeData\\memory\\engine\\src\\finalize-session.js";
const LOG_DIR = "E:\\OpenCodeData\\memory\\logs\\sessions";
const HIDDEN = { windowsHide: true } as const;

// OpenCode runs plugins from its native CLI process, where process.execPath is
// opencode.exe, not node. Spawning that binary with our CLI path makes OpenCode
// print help instead of executing the command. Always resolve a real node binary.
function nodeBinary(): string {
  const override = process.env.HARNESS_NODE_BIN;
  if (override) return override;
  const exe = String(process.execPath || "");
  return /opencode/i.test(exe) ? "node" : exe;
}

function run(args: string[], stdin?: string, timeout = 30000): Promise<string> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(nodeBinary(), [CLI, ...args], { ...HIDDEN, stdio: ["pipe", "pipe", "ignore"] });
    } catch { done(""); return; }
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(""); }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", () => { clearTimeout(timer); done(""); });
    child.on("close", () => { clearTimeout(timer); done(out); });
    child.stdin.on("error", () => {});
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// Append one line to the durable, append-only transcript (single source of truth in CLI).
// Returns a structured result so callers can detect a failed write instead of
// silently losing it. seq is the authoritative durable sequence of the line.
type AppendResult = { ok: boolean; seq: number };
function durableAppend(sessionId: string, rec: Record<string, unknown>): Promise<AppendResult> {
  return run(["transcript-append"], JSON.stringify({ session_id: sessionId, ...rec }), 8000)
    .then((out) => {
      try {
        const j = JSON.parse(out.trim().split("\n").pop() || "{}");
        if (j.ok !== true) console.error(`[opencode-memory] durable append failed for ${sessionId}: ${out.slice(0, 200)}`);
        return { ok: j.ok === true, seq: Number(j.seq || 0) };
      } catch {
        console.error(`[opencode-memory] durable append unreadable for ${sessionId}`);
        return { ok: false, seq: 0 };
      }
    });
}

const setupV2 = async (ctx: any) => {
  const directory: string = ctx.location?.directory ?? ctx.location?.path ?? process.cwd();
  // Startup recovery (idempotent, rate-limited server-side). Never blocks interaction.
  void run(["automation-recover-if-due"]);
  const contexts = new Map<string, string>();
  const transcripts = new Map<string, string[]>();
  const toolStart = new Map<string, number>();
  const toolSignatures = new Map<string, string[]>();
  const endTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const processedSeq = new Map<string, number>();
  // Per-session append chain. Serializes durable writes for one session (preserving
  // order and preventing seq collisions) while different sessions stay independent.
  // Turn-end automation awaits this chain before reading the transcript, so it can
  // never observe a partially persisted session as complete.
  const pendingAppends = new Map<string, Promise<AppendResult[]>>();
  const APPEND_WAIT_MS = Math.max(10000, Number(process.env.HARNESS_APPEND_WAIT_MS || 20000));
  const COALESCE_MS = Math.max(1000, Number(process.env.HARNESS_END_COALESCE_MS || 4000));
  const SETTLE_MS = Math.max(1000, Number(process.env.HARNESS_SETTLE_MS || 3000));
  const MAX_SETTLE_CHECKS = Math.max(1, Number(process.env.HARNESS_MAX_SETTLE_CHECKS || 20));
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const trackedSessions = new Set<string>();

  // Plugin teardown runs while the OpenCode process is still alive. A synchronous
  // finalizer keeps it alive until the complete transcript has been processed,
  // which is more reliable than a detached child on Windows (job-object cleanup
  // kills descendants as soon as the parent command exits).
  function spawnFinalizer(id: string, dir: string) {
    try {
      execFileSync(nodeBinary(), [FINALIZER, id, dir], {
        ...HIDDEN, timeout: 60000, stdio: "ignore",
      });
    } catch (e) {
      console.error(`[opencode-memory] finalizer failed for ${id}: ${String(e).slice(0, 200)}`);
    }
  }

  function trackAppend(id: string, rec: Record<string, unknown>): Promise<AppendResult[]> {
    const prev = pendingAppends.get(id) || Promise.resolve([] as AppendResult[]);
    const next = prev.then(async (acc) => [...acc, await durableAppend(id, rec)]);
    pendingAppends.set(id, next);
    // Drop only this settled chain; a newer chain (if any) is left untouched.
    void next.then(
      () => { if (pendingAppends.get(id) === next) pendingAppends.delete(id); },
      () => { if (pendingAppends.get(id) === next) pendingAppends.delete(id); },
    );
    return next;
  }

  async function flushAppends(id: string): Promise<AppendResult[]> {
    const pending = pendingAppends.get(id);
    if (!pending) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<AppendResult[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error("append flush timed out")), APPEND_WAIT_MS);
        }),
      ]);
    } catch (e) {
      console.error(`[opencode-memory] append flush failed for ${id}: ${String(e).slice(0, 200)}`);
      return [{ ok: false, seq: 0 }];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // One turn-end pass. The plugin's in-memory transcript is updated SYNCHRONOUSLY
  // by the prompt/tool/event hooks, so it is complete at this point even while
  // durable append children are still in flight. It is passed to the existing
  // stage pipeline via stdin; the durable file remains the persistence layer and
  // is still flushed/checked for failed writes. Returns the processed line count.
  async function runTurnEndFor(id: string, directory: string): Promise<number | null> {
    try {
      const appends = await flushAppends(id);
      const failedWrites = appends.filter((a) => !a.ok).length;
      if (failedWrites > 0) {
        console.error(`[opencode-memory] ${failedWrites} durable append(s) failed for ${id}; in-memory transcript still processed`);
      }

      const inMemory = transcripts.get(id) || [];
      const seq = inMemory.length;
      if (!seq || seq <= (processedSeq.get(id) || 0)) return null;

      const out = await run(["automate", "--session", id, "--project", directory, "--stdin",
        "--seq", String(seq)], inMemory.join("\n"), 120000);
      let parsed: any = null;
      try { parsed = JSON.parse(out.trim().split("\n").pop() || "{}"); } catch { /* keep raw for report */ }
      if (parsed?.ok || parsed?.duplicate) {
        processedSeq.set(id, seq);
        return seq;
      }
      console.error(`[opencode-memory] turn-end automation failed for ${id}: ${out.slice(0, 300)}`);
      return null;
    } catch (e) {
      console.error(`[opencode-memory] turn-end automation error for ${id}: ${String(e).slice(0, 200)}`);
      return null;
    }
  }

  // The tool hook fires for every executed tool, including the last one, and is
  // more reliable than session.idle/execution events in short-lived CLI sessions.
  // Debounce it so a burst of tool calls produces one turn-end; the settling loop
  // still runs again if more lines arrive afterwards.
  function scheduleTurnEnd(id: string, directory: string) {
    const prior = endTimers.get(id);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(async () => {
      endTimers.delete(id);
      await runTurnEndFor(id, directory);
      scheduleSettleCheck(id, directory, 0);
    }, COALESCE_MS);
    endTimers.set(id, timer);
  }

  // session.execution.* fires per step, so the first turn-end is not proof the
  // session is finished. Re-check the in-memory transcript after a bounded
  // settling window and run again whenever new lines appeared. The last run sees
  // the complete tool trajectory; earlier provisional runs are superseded by the
  // engine when a higher sequence completes.
  function scheduleSettleCheck(id: string, directory: string, attempts: number) {
    if (attempts >= MAX_SETTLE_CHECKS) return;
    const prior = settleTimers.get(id);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(async () => {
      settleTimers.delete(id);
      await runTurnEndFor(id, directory);
      scheduleSettleCheck(id, directory, attempts + 1);
    }, SETTLE_MS);
    settleTimers.set(id, timer);
  }

  try {
    await ctx.session.hook("prompt", async (e: any) => {
      const id: string = e.sessionID;
      trackedSessions.add(id);
      const text: string = e.prompt?.text ?? "";
      transcripts.set(id, [...(transcripts.get(id) || []), `USER: ${text}`]);
      void trackAppend(id, { role: "USER", text, kind: "user_statement", language: "unknown" });
      const budget = process.env.HARNESS_CONTEXT_BUDGET || "2500";
      const out = await run(["context-package", "--session", id, "--project", directory,
        "--prompt", text.slice(0, 2000), "--budget", budget]);
      if (out.trim()) contexts.set(id, out.trim());
    });
  } catch {}

  try {
    await ctx.session.hook("context", (e: any) => {
      const extra = contexts.get(e.sessionID);
      if (extra && Array.isArray(e.system)) {
        e.system.push({ type: "text", text: `Relevant memory (retrieved automatically):\n${extra}` });
      }
    });
  } catch {}

  try {
    await ctx.tool.hook("execute.before", async (e: any) => {
      toolStart.set(String(e.id ?? `${e.sessionID}:${e.tool}:${Date.now()}`), Date.now());
    });
  } catch {}

  try {
    await ctx.tool.hook("execute.after", async (e: any) => {
      const id: string = e.sessionID;
      trackedSessions.add(id);
      const okRun = e.status === "completed";
      const content = okRun ? e.result?.content : e.error?.message;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.map((c: any) => c?.text ?? "").join(" ")
        : String(content ?? "");
      if (text) {
        transcripts.set(id, [...(transcripts.get(id) || []), `TOOL ${e.tool}: ${text.slice(0, 600)}`].slice(-40));
        void trackAppend(id, { role: "TOOL", text, tool: String(e.tool), kind: "technical_knowledge", language: "unknown" });
      }

      // Only record measurements the harness actually exposes.
      const key = String(e.id ?? `${id}:${e.tool}:${Date.now()}`);
      const started = toolStart.get(key);
      toolStart.delete(key);
      const duration = started !== undefined ? Math.max(0, Date.now() - started) : 0;
      const exit = typeof e.result?.metadata?.exit === "number" ? e.result.metadata.exit : undefined;
      const isError = !okRun || (exit !== undefined && exit !== 0);
      const sig = `${e.tool}:${JSON.stringify(e.input ?? {}).slice(0, 300)}`;
      const prior = toolSignatures.get(id) || [];
      const retryOf = prior.includes(sig) ? prior[prior.length - 1] : undefined;
      toolSignatures.set(id, [...prior.slice(-19), sig]);
      if (duration > 0 || exit !== undefined || isError) {
        const args = ["observe", "--session", id, "--project", directory, "--tool", String(e.tool),
          "--ms", String(duration), "--error", isError ? "1" : "0"];
        if (exit !== undefined) args.push("--exit", String(exit));
        if (retryOf) args.push("--retry-of", retryOf);
        await run(args);
      }
      // The tool hook is the reliable "work happened here" signal. Debounce a
      // turn-end from it; if more tools follow, later calls reset the timer and
      // the settling loop processes the accumulated transcript again.
      scheduleTurnEnd(id, directory);
    });
  } catch {}

  const controller = new AbortController();
  (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        const t: string = ev?.type ?? "";
        const p = ev?.properties ?? ev?.data ?? ev;
        const id: string = p?.sessionID;
        if (!id) continue;
        if (t === "session.step.ended") {
          const answer = p?.text ?? p?.content ?? p?.message?.content;
          if (answer) {
            transcripts.set(id, [...(transcripts.get(id) || []), `ASSISTANT: ${String(answer).slice(0, 800)}`].slice(-40));
            void trackAppend(id, { role: "ASSISTANT", text: String(answer), kind: "agent_reasoning", language: "unknown" });
          }
        }
        if (t === "session.idle" || t.startsWith("session.execution.")) {
          // Coalesce rapid signals, then hand off to the bounded settling loop.
          // A single execution signal is not proof the session is finished, so the
          // loop re-checks the durable seq and runs again whenever new lines arrive.
          const prior = endTimers.get(id);
          if (prior) clearTimeout(prior);
          const timer = setTimeout(async () => {
            endTimers.delete(id);
            await runTurnEndFor(id, directory);
            scheduleSettleCheck(id, directory, 0);
          }, COALESCE_MS);
          endTimers.set(id, timer);
        }
      }
    } catch {}
  })();

  return () => {
    for (const timer of endTimers.values()) clearTimeout(timer);
    endTimers.clear();
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    // Final boundary: the complete transcript is processed even if the last tool
    // output landed during teardown. Detached work is deduped by (session, event).
    for (const id of trackedSessions) spawnFinalizer(id, directory);
    trackedSessions.clear();
    controller.abort();
  };
};

export default { id: "opencode-memory", setup: setupV2 };
