// Phase 24 — runtime adapter tests. DB-light: no core import, no DB pool, no real
// process ever spawned. All "real" runs use an injected spawnFn.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   node --test test/phase24-run-adapter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import adapter, { buildRunArgs, executeAgentRun, classifyEvidence, redactSecrets }
  from "../src/opencodeRunAdapter.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test"; // defensive; adapter is DB-light

const PROJECT = "p24-adapter-test";
const canaries = {
  sk: "sk-" + "a".repeat(32),
  bearer: "Bearer eyJhbGciOi" + "b".repeat(24),
  akia: "AKIA" + "C".repeat(16),
  api: "api_key=" + "z".repeat(28),
};
const blob = (v) => JSON.stringify(v ?? {});

/** Injected spawnFn that resolves immediately with a plain result object. */
function promiseSpawn(result) {
  const calls = [];
  const fn = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}

/** Injected spawnFn returning a ChildProcess-like emitter; optional behavior(child). */
function emitterSpawn(behavior) {
  const calls = [];
  const fn = (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    if (behavior) behavior(child);
    return child;
  };
  fn.calls = calls;
  return fn;
}

const emitClose = (code, out = "", err = "") => (child) => {
  process.nextTick(() => {
    if (out) child.stdout.emit("data", out);
    if (err) child.stderr.emit("data", err);
    child.emit("close", code);
  });
};

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports exist", () => {
  assert.equal(typeof buildRunArgs, "function");
  assert.equal(typeof executeAgentRun, "function");
  assert.equal(typeof classifyEvidence, "function");
  assert.equal(typeof redactSecrets, "function");
  assert.equal(typeof adapter.buildRunArgs, "function");
  assert.equal(typeof adapter.executeAgentRun, "function");
  assert.equal(typeof adapter.classifyEvidence, "function");
  assert.equal(adapter.default, undefined);
});

// ---------------------------------------------------------------------------
// 1. defaults
// ---------------------------------------------------------------------------
test("1. buildRunArgs defaults to ['run','--format','json']", () => {
  const r = buildRunArgs();
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["run", "--format", "json"]);
});

// ---------------------------------------------------------------------------
// 2. value flags
// ---------------------------------------------------------------------------
test("2. buildRunArgs includes only supplied value flags with correct values", () => {
  const r = buildRunArgs({ agent: "reviewer", model: "claude-sonnet", session: "s-1", title: "T" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, [
    "run", "--agent", "reviewer", "--model", "claude-sonnet",
    "--session", "s-1", "--title", "T", "--format", "json",
  ]);
  const custom = buildRunArgs({ format: "text" });
  assert.deepEqual(custom.argv, ["run", "--format", "text"]);
});

// ---------------------------------------------------------------------------
// 3. boolean flags and worktree forms
// ---------------------------------------------------------------------------
test("3. buildRunArgs boolean flags --fork/--continue and --worktree forms", () => {
  const r = buildRunArgs({ fork: true, continue_session: true, worktree: true });
  assert.deepEqual(r.argv, ["run", "--fork", "--worktree", "--continue", "--format", "json"]);
  const named = buildRunArgs({ worktree: "/tmp/wt", fork: false, continue_session: false });
  assert.deepEqual(named.argv, ["run", "--worktree", "/tmp/wt", "--format", "json"]);
});

// ---------------------------------------------------------------------------
// 4. trailing prompt
// ---------------------------------------------------------------------------
test("4. buildRunArgs appends prompt as trailing string or array args", () => {
  const single = buildRunArgs({ prompt: "do the thing" });
  assert.deepEqual(single.argv, ["run", "--format", "json", "do the thing"]);
  const multi = buildRunArgs({ agent: "a", prompt: ["one", "two", "three"] });
  assert.deepEqual(multi.argv, ["run", "--agent", "a", "--format", "json", "one", "two", "three"]);
});

// ---------------------------------------------------------------------------
// 5. never shell-interpret
// ---------------------------------------------------------------------------
test("5. argv is an array; shell metacharacters are never interpreted", () => {
  const evil = "; rm -rf / && echo hi > /root/.ssh/authorized_keys `whoami` $(id)";
  const r = buildRunArgs({ prompt: evil });
  assert.equal(Array.isArray(r.argv), true);
  assert.deepEqual(r.argv, ["run", "--format", "json", evil]);
  assert.equal(r.argv.filter((x) => x.includes("rm -rf")).length, 1, "prompt stays a single element");
  assert.equal(r.argv.includes(evil), true);
});

// ---------------------------------------------------------------------------
// 6. invalid buildRunArgs types fail closed
// ---------------------------------------------------------------------------
test("6. buildRunArgs rejects clearly invalid types", () => {
  for (const bad of [
    { agent: 42 }, { model: {} }, { session: true }, { title: [] },
    { fork: "true" }, { continue_session: 1 }, { worktree: 123 },
    { format: 7 }, { prompt: { x: 1 } }, { prompt: ["ok", 5] },
  ]) {
    const r = buildRunArgs(bad);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.deepEqual(r.argv, []);
  }
});

// ---------------------------------------------------------------------------
// 7. simulation default never spawns
// ---------------------------------------------------------------------------
test("7. simulation (mode missing) never calls spawnFn and returns mock evidence", async () => {
  const fn = promiseSpawn({ exitCode: 0 });
  const r = await executeAgentRun({ project_id: PROJECT, argv: ["run", "--format", "json"], spawnFn: fn });
  assert.equal(fn.calls.length, 0, "injected spawnFn must not be invoked");
  assert.equal(r.ok, true);
  assert.equal(r.evidence_class, "mock");
  assert.equal(r.process_exit_code, null);
  assert.equal(r.process_ok, false);
  assert.equal(r.task_verified, false);
});

// ---------------------------------------------------------------------------
// 8. explicit simulation
// ---------------------------------------------------------------------------
test("8. explicit simulation still never spawns and extracts session from argv", async () => {
  const fn = emitterSpawn(emitClose(0));
  const r = await executeAgentRun({
    project_id: PROJECT, mode: "simulation", argv: ["run", "--session", "sess-1"], spawnFn: fn,
  });
  assert.equal(fn.calls.length, 0);
  assert.equal(r.evidence_class, "mock");
  assert.equal(r.session_id, "sess-1");
  assert.equal(r.task_verified, false);
});

// ---------------------------------------------------------------------------
// 9. real mode passes argv to spawnFn
// ---------------------------------------------------------------------------
test("9. real mode calls injected spawnFn with the argv array", async () => {
  const argv = ["run", "--agent", "reviewer", "--format", "json", "prompt text"];
  const fn = promiseSpawn({ exitCode: 0, stdout: "ok" });
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv, spawnFn: fn });
  assert.equal(fn.calls.length, 1);
  assert.deepEqual(fn.calls[0].argv, argv);
  assert.equal(typeof fn.calls[0].bin, "string");
  assert.deepEqual(fn.calls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(fn.calls[0].opts.windowsHide, true);
  assert.equal(r.ok, true);
  assert.equal(r.evidence_class, "runtime");
});

// ---------------------------------------------------------------------------
// 10. exit 0 != verified
// ---------------------------------------------------------------------------
test("10. exit 0 sets process_ok true but task_verified stays false", async () => {
  const fn = emitterSpawn(emitClose(0, "all good", ""));
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn });
  assert.equal(r.process_exit_code, 0);
  assert.equal(r.process_ok, true);
  assert.equal(r.ok, true);
  assert.equal(r.task_verified, false, "exit 0 must never imply a verified task");
  assert.equal(r.evidence_class, "runtime", "bare process_ok is runtime, not agent");
  assert.equal(r.stdout_redacted, "all good");
});

// ---------------------------------------------------------------------------
// 11. nonzero exit
// ---------------------------------------------------------------------------
test("11. nonzero exit sets process_ok false while adapter ok stays true", async () => {
  const fn = emitterSpawn(emitClose(7, "", "bad things"));
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn });
  assert.equal(r.process_exit_code, 7);
  assert.equal(r.process_ok, false);
  assert.equal(r.ok, true, "adapter itself ran without internal error");
  assert.equal(r.evidence_class, "runtime");
  assert.equal(r.task_verified, false);
});

// ---------------------------------------------------------------------------
// 12. spawnFn throws
// ---------------------------------------------------------------------------
test("12. spawnFn throwing returns ok:false without throwing", async () => {
  const fn = () => { throw new Error("spawn exploded"); };
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn });
  assert.equal(r.ok, false);
  assert.equal(r.process_ok, false);
  assert.equal(r.process_exit_code, null);
  assert.match(r.error, /spawn exploded/);
});

// ---------------------------------------------------------------------------
// 13. bounded timeout
// ---------------------------------------------------------------------------
test("13. a stalled child times out (bounded) and returns ok:false", async () => {
  const fn = emitterSpawn(null); // never emits 'close'
  const before = Date.now();
  const r = await executeAgentRun({
    project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn, timeout_ms: 50,
  });
  const elapsed = Date.now() - before;
  assert.equal(r.ok, false);
  assert.equal(r.process_ok, false);
  assert.match(r.error, /timeout/);
  assert.ok(elapsed >= 900 && elapsed < 5000, `timeout clamped to >=1000ms, got ${elapsed}`);
});

// ---------------------------------------------------------------------------
// 14. redaction
// ---------------------------------------------------------------------------
test("14. stdout/stderr credential-like content is redacted", async () => {
  const fn = promiseSpawn({
    exitCode: 0,
    stdout: `key ${canaries.sk} and ${canaries.bearer} done`,
    stderr: `${canaries.akia} ${canaries.api} failed`,
  });
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn });
  const out = r.stdout_redacted + "\n" + r.stderr_redacted;
  for (const v of Object.values(canaries)) assert.equal(out.includes(v), false, `leaked ${v}`);
  assert.match(out, /\[REDACTED_API_KEY\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /\[REDACTED_AWS_KEY\]/);
  assert.match(out, /api_key=\[REDACTED\]/);
  assert.equal(blob(r).includes(canaries.sk), false);
});

// ---------------------------------------------------------------------------
// 15. evidence tier separation
// ---------------------------------------------------------------------------
test("15. evidence tiers are distinct classes", () => {
  assert.equal(classifyEvidence({ mode: "simulation" }), "mock");
  assert.equal(classifyEvidence({ mode: "api" }), "api");
  assert.equal(classifyEvidence({ spawned: true }), "runtime");
  assert.equal(classifyEvidence({ spawned: true, process_ok: true, work_evidence: true }), "agent");
  assert.notEqual(classifyEvidence({ mode: "simulation" }), classifyEvidence({ spawned: true }));
  assert.notEqual(classifyEvidence({ spawned: true }), classifyEvidence({ spawned: true, process_ok: true, work_evidence: true }));
});

// ---------------------------------------------------------------------------
// 16. classifyEvidence logic
// ---------------------------------------------------------------------------
test("16. classifyEvidence requires explicit work evidence AND process_ok AND spawn", () => {
  assert.equal(classifyEvidence(), "mock");
  assert.equal(classifyEvidence({ spawned: true, process_ok: false, work_evidence: true }), "runtime");
  assert.equal(classifyEvidence({ work_evidence: true, process_ok: true }), "mock", "no spawn => not agent");
  assert.equal(classifyEvidence({ mode: "agent", spawned: true, process_ok: true }), "runtime", "mode alone is not work evidence");
  assert.equal(classifyEvidence({ spawned: true, process_ok: true, evidence_class: "agent" }), "agent");
});

// ---------------------------------------------------------------------------
// 17. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("17. invalid inputs fail closed without spawning", async () => {
  const fn = promiseSpawn({ exitCode: 0 });
  for (const bad of [{}, { project_id: "" }, { project_id: "  " }, { project_id: "_global" }]) {
    const r = await executeAgentRun({ ...bad, mode: "real", argv: ["run"], spawnFn: fn });
    assert.equal(r.ok, false);
    assert.equal(r.task_verified, false);
  }
  assert.equal(fn.calls.length, 0);
  const badArgv = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: "run", spawnFn: fn });
  assert.equal(badArgv.ok, false);
  const badFn = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: "nope" });
  assert.equal(badFn.ok, false);
  const unknownMode = await executeAgentRun({ project_id: PROJECT, mode: "bogus", argv: ["run"], spawnFn: fn });
  assert.equal(unknownMode.evidence_class, "mock", "unknown mode degrades to simulation");
  assert.equal(fn.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 18. final degradation / no overclaim
// ---------------------------------------------------------------------------
test("18. final degradation: no secret leak, no overclaim, never task_verified", async () => {
  const fn = promiseSpawn({
    exitCode: 0,
    stdout: `ok ${canaries.sk} ${canaries.api}`,
    stderr: "",
    session_id: "sess-final",
  });
  const r = await executeAgentRun({ project_id: PROJECT, mode: "real", argv: ["run"], spawnFn: fn });
  assert.equal(r.task_verified, false);
  assert.equal(r.evidence_class, "runtime");
  assert.ok(r.duration_ms >= 0);
  assert.equal(blob(r).includes(canaries.sk), false);
  assert.equal(blob(r).includes(canaries.api), false);
  assert.equal(r.session_id, "sess-final");
  assert.doesNotMatch(blob(r), /certainly|definitely|guaranteed|100%|proven/i);
});
