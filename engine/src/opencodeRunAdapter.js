// Phase 24 runtime adapter: controlled, fixed-argument `opencode run` execution.
// LEVEL 1 SAFETY: default mode is `simulation` (no process is ever spawned).
// A real process is spawned ONLY with explicit mode:'real', using a fixed binary
// (HARNESS_OPENCODE_BIN || "opencode") and an argv ARRAY — never a shell string.
// No arbitrary command execution, no source rewriting, no secret exposure.
// CRITICAL: process exit 0 sets process_ok ONLY; it NEVER sets task_verified.
// task_verified is always false here and can only be set by independent validation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 30000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 300000;

const REDACTORS = [
  { re: /(sk-[A-Za-z0-9_\-]{16,})/g, tag: "[REDACTED_API_KEY]" },
  { re: /\bBearer\s+[A-Za-z0-9_\-.+/=]{8,}/gi, tag: "Bearer [REDACTED]" },
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, tag: "[REDACTED_AWS_KEY]" },
  { re: /\b(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*["']?([^\s"',;]{6,})/gi, tag: "$1=[REDACTED]" },
];

/** Best-effort credential redaction of captured process output. */
export function redactSecrets(text) {
  let out = cap(String(text ?? ""));
  for (const { re, tag } of REDACTORS) { re.lastIndex = 0; out = out.replace(re, tag); }
  return out;
}

function cap(s) {
  const str = String(s ?? "");
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + "\n[TRUNCATED]" : str;
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(n, MAX_TIMEOUT));
}

function extractSession(argv, result) {
  if (result && typeof result.session_id === "string" && result.session_id) return result.session_id;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--session") return String(argv[i + 1]);
  }
  return null;
}

function normalizeSpawnResult(r) {
  if (!r || typeof r !== "object") {
    return { exitCode: null, stdout: "", stderr: "", error: "invalid spawn result" };
  }
  const raw = r.exitCode ?? r.code ?? r.status ?? null;
  let exitCode = null;
  if (raw !== null && raw !== undefined) {
    const n = Number(raw);
    exitCode = Number.isFinite(n) ? n : null;
  }
  return {
    exitCode,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    error: r.error ? String(r.error).slice(0, 300) : null,
  };
}

// Windows npm shims (opencode.cmd/.ps1) cannot be spawned directly by Node and
// .cmd's %* forwarding mangles quoted arguments. Resolve the shim deterministically
// to its real opencode.exe beside its node_modules, then spawn that executable with
// a plain argv array — NO shell at any point. Fall back to the bare name on POSIX.
function resolveBin(bin) {
  if (process.platform !== "win32") return bin;
  const name = String(bin);
  if (/\.(exe|cmd|ps1)$/i.test(name)) return name;
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const shim = path.join(dir, `${name}.cmd`);
    if (!fs.existsSync(shim)) continue;
    try {
      const text = fs.readFileSync(shim, "utf8");
      const m = text.match(/"([^"]*[\\/]opencode\.exe)"/i);
      if (m && fs.existsSync(m[1])) return m[1];
    } catch { /* ignore unreadable shim */ }
    const exe = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return `${name}.cmd`;
}

function defaultSpawnFn(bin, argv, options) {
  return spawn(resolveBin(bin), argv, options);
}

/**
 * Run the injected spawnFn with a bounded timeout. Accepts either a promise
 * resolving to { exitCode|code, stdout, stderr } or a ChildProcess-like emitter
 * with stdout/stderr streams and 'close'/'error' events. Never throws: failures
 * are returned as { error } so the caller can fail closed.
 */
function runSpawn(fn, bin, argv, options, timeoutMs) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { if (child && typeof child.kill === "function") child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ exitCode: null, stdout: "", stderr: "", error: "spawn timeout" });
    }, timeoutMs);

    (async () => {
      let r;
      try { r = await fn(bin, argv, options); }
      catch (e) {
        finish({ exitCode: null, stdout: "", stderr: "", error: String(e?.message || e).slice(0, 300) });
        return;
      }
      child = r;
      if (!r || typeof r !== "object") {
        finish({ exitCode: null, stdout: "", stderr: "", error: "spawnFn returned no child" });
        return;
      }
      if (typeof r.then === "function") {
        try { const v = await r; finish(normalizeSpawnResult(v)); }
        catch (e) { finish({ exitCode: null, stdout: "", stderr: "", error: String(e?.message || e).slice(0, 300) }); }
        return;
      }
      if (typeof r.on !== "function") {
        finish(normalizeSpawnResult(r));
        return;
      }
      let out = "", err = "";
      if (r.stdout && typeof r.stdout.setEncoding === "function") r.stdout.setEncoding("utf8");
      if (r.stderr && typeof r.stderr.setEncoding === "function") r.stderr.setEncoding("utf8");
      if (r.stdout && typeof r.stdout.on === "function") {
        r.stdout.on("data", (d) => { out = cap(out + String(d)); });
      }
      if (r.stderr && typeof r.stderr.on === "function") {
        r.stderr.on("data", (d) => { err = cap(err + String(d)); });
      }
      r.on("error", (e) => finish({ exitCode: null, stdout: out, stderr: err, error: String(e?.message || e).slice(0, 300) }));
      r.on("close", (code) => finish({
        exitCode: code === null || code === undefined ? null : Number(code),
        stdout: out, stderr: err, error: null,
      }));
      if (r.exitCode !== null && r.exitCode !== undefined) {
        finish({ exitCode: Number(r.exitCode), stdout: out, stderr: err, error: null });
      }
    })();
  });
}

/**
 * Evidence tier helper. Tiers are first-class and are never inferred from one
 * another: 'agent' requires BOTH an explicit work-evidence flag AND process_ok
 * AND a real spawn; a bare exit 0 can only ever yield 'runtime'.
 */
export function classifyEvidence(options = {}) {
  const { mode, spawned, process_ok, work_evidence, evidence_class } = options || {};
  const explicitWorkEvidence = work_evidence === true || evidence_class === "agent";
  if (explicitWorkEvidence && spawned === true && process_ok === true) return "agent";
  if (spawned === true) return "runtime";
  if (mode === "api" || evidence_class === "api") return "api";
  return "mock";
}

/** Build a fixed, shell-free argv for `opencode run`. Only supplied flags are emitted. */
export function buildRunArgs(options = {}) {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("invalid options");
    const argv = ["run"];
    const addValue = (value, flag, name) => {
      if (value === undefined || value === null) return;
      if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
      argv.push(flag, value);
    };
    const addBool = (value, flag, name) => {
      if (value === undefined || value === null) return;
      if (typeof value !== "boolean") throw new Error(`invalid ${name}`);
      if (value) argv.push(flag);
    };

    addValue(options.agent, "--agent", "agent");
    addValue(options.model, "--model", "model");
    addValue(options.session, "--session", "session");
    addBool(options.fork, "--fork", "fork");
    if (options.worktree !== undefined && options.worktree !== null) {
      if (options.worktree === true) argv.push("--worktree");
      else if (options.worktree === false) { /* omitted */ }
      else if (typeof options.worktree === "string" && options.worktree.length > 0) argv.push("--worktree", options.worktree);
      else throw new Error("invalid worktree");
    }
    addBool(options.continue_session, "--continue", "continue_session");
    addValue(options.title, "--title", "title");
    if (options.format !== undefined && options.format !== null) {
      if (typeof options.format !== "string" || options.format.length === 0) throw new Error("invalid format");
      argv.push("--format", options.format);
    } else {
      argv.push("--format", "json");
    }
    if (options.prompt !== undefined && options.prompt !== null) {
      if (typeof options.prompt === "string") {
        if (options.prompt.length > 0) argv.push(options.prompt);
      } else if (Array.isArray(options.prompt)) {
        for (const part of options.prompt) {
          if (typeof part !== "string") throw new Error("invalid prompt element");
          argv.push(part);
        }
      } else {
        throw new Error("invalid prompt");
      }
    }
    return { ok: true, argv };
  } catch (e) {
    return { ok: false, argv: [], reason: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Execute an `opencode run` adapter call. Returns a normalized result where
 * `ok` means the adapter itself ran without internal error — NOT task success.
 * `task_verified` is always false here.
 */
export async function executeAgentRun(options = {}) {
  const started = Date.now();
  const base = {
    ok: false, evidence_class: "mock", process_exit_code: null, process_ok: false,
    task_verified: false, stdout_redacted: "", stderr_redacted: "", duration_ms: 0,
    session_id: null, error: null,
  };
  const done = (extra) => ({ ...base, ...extra, task_verified: false, duration_ms: Date.now() - started });

  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) return done({ error: "invalid options" });
    const project_id = options.project_id;
    if (typeof project_id !== "string" || !project_id.trim() || project_id === "_global") {
      return done({ error: "valid project_id required" });
    }
    const argv = options.argv === undefined || options.argv === null ? [] : options.argv;
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return done({ error: "invalid argv" });

    // SAFETY: only an explicit mode:'real' permits a spawn. Missing/unknown modes
    // degrade to simulation, never to a process.
    const mode = options.mode === "real" ? "real" : "simulation";
    const supplied = options.spawnFn;
    if (mode === "real" && supplied !== undefined && supplied !== null && typeof supplied !== "function") {
      return done({ error: "invalid spawnFn" });
    }
    const spawnFn = typeof supplied === "function" ? supplied : defaultSpawnFn;

    if (mode !== "real") {
      return done({
        ok: true,
        evidence_class: classifyEvidence({ mode: "simulation", spawned: false, process_ok: false }),
        stdout_redacted: "[SIMULATION] no process spawned",
        stderr_redacted: "[SIMULATION] no process spawned",
        session_id: extractSession(argv, null),
      });
    }

    const timeoutMs = clampTimeout(options.timeout_ms);
    const envObj = options.env && typeof options.env === "object" && !Array.isArray(options.env) ? options.env : {};
    const childOptions = {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envObj },
    };
    const bin = process.env.HARNESS_OPENCODE_BIN || "opencode";
    const result = await runSpawn(spawnFn, bin, argv, childOptions, timeoutMs);
    const error = result.error ? String(result.error).slice(0, 300) : null;
    const process_ok = !error && result.exitCode === 0;
    return done({
      ok: !error,
      evidence_class: classifyEvidence({ mode: "real", spawned: true, process_ok }),
      process_exit_code: result.exitCode,
      process_ok,
      stdout_redacted: redactSecrets(result.stdout),
      stderr_redacted: redactSecrets(result.stderr),
      session_id: extractSession(argv, result),
      error,
    });
  } catch (e) {
    return done({ error: String(e?.message || e).slice(0, 300) });
  }
}

export default { buildRunArgs, executeAgentRun, classifyEvidence, redactSecrets };
