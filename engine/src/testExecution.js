// Phase 24 — bounded test execution adapter. Test output is EVIDENCE only:
// task_verified is always false here; post-condition validation is a separate
// capability. SAFETY: never runs against a non-isolated database unless an
// explicit real-mode approval is supplied; no shell; fixed arguments; redacted
// output; LEVEL 1 preserved (simulation is the default).
import { spawn } from "node:child_process";
import * as core from "./core.js";

const short = (v, n = 600) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const SAFE_CMD = /^[A-Za-z0-9_./\\:\-=]+$/;
const SHELL_META = /[;&|`$><(){}!*?\[\]]/;

// Bounded, process-local ledger (also mirrored via core.audit).
const ledger = [];

function redact(text) {
  let s = core.redact(String(text ?? ""));
  s = s.replace(/\bBearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_API_KEY]");
  s = s.replace(/AKIA[A-Z0-9]{12,}/g, "[REDACTED_AWS_KEY]");
  return short(s, 4000);
}

/** Parse deterministic TAP/node--test summary numbers from test output. */
function parseCounts(text) {
  const tests = String(text).match(/\btests\s+(\d+)/gi) || [];
  const pass = String(text).match(/\bpass\s+(\d+)/gi) || [];
  const fail = String(text).match(/\bfail\s+(\d+)/gi) || [];
  const num = (arr) => (arr.length ? Number(arr[arr.length - 1].replace(/\D/g, "")) : 0);
  let total = num(tests);
  let passed = num(pass);
  let failed = num(fail);
  if (!total && !passed && !failed) {
    const ok = (String(text).match(/^✔/gm) || []).length;
    const bad = (String(text).match(/^✖/gm) || []).length;
    total = ok + bad;
    passed = ok;
    failed = bad;
  }
  return { pass: passed, fail: failed, total };
}

/**
 * Run a bounded test command against an ISOLATED database and return evidence.
 * `task_verified` is always false: tests supply evidence, not post-condition proof.
 */
export async function runTests({ project_id, run_id, task_key, mode, test_command, spawnFn,
  dry_run, db_name, approval, timeout_ms } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", task_verified: false };
  const db = String(db_name || process.env.MEMORY_DB_NAME || "opencode_memory_test");
  const isolated = db.endsWith("_test");
  const real = mode === "real" && dry_run !== true;
  if (!isolated && !(real && approval)) {
    return { ok: false, reason: "refusing to run tests against a non-isolated database without explicit real-mode approval",
      task_verified: false };
  }
  const base = { ok: true, run_id: String(run_id || ""), task_key: String(task_key || ""), db,
    evidence_class: "mock", pass: 0, fail: 0, total: 0, output_redacted: "", task_verified: false };

  if (!real) {
    ledger.push({ ...base, at: new Date().toISOString() });
    if (ledger.length > 100) ledger.shift();
    return { ...base, reason: "simulation: no process spawned" };
  }

  // Fixed-argument execution only: reject shell metacharacters and tokenize on whitespace.
  const cmd = String(test_command || "").trim();
  if (!cmd || SHELL_META.test(cmd)) {
    return { ok: false, reason: "test_command must be a fixed command without shell metacharacters", task_verified: false };
  }
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (!argv.every((a) => SAFE_CMD.test(a))) {
    return { ok: false, reason: "test_command contains unsafe arguments", task_verified: false };
  }

  const result = await new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      resolve({ code, stdout: short(stdout, 200000), stderr: short(stderr, 200000), error: error || null });
    };
    try {
      const child = (typeof spawnFn === "function" ? spawnFn : spawn)(argv[0], argv.slice(1), {
        windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MEMORY_DB_NAME: db },
      });
      child.stdout?.on("data", (d) => { stdout += String(d); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
      child.stderr?.on("data", (d) => { stderr += String(d); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
      child.on("error", (e) => finish(-1, String(e?.message || e)));
      child.on("close", (code) => finish(code, null));
    } catch (e) { finish(-1, String(e?.message || e)); }
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const counts = parseCounts(combined);
  const out = {
    ok: true, run_id: String(run_id || ""), task_key: String(task_key || ""), db,
    evidence_class: "runtime", ...counts,
    output_redacted: redact(combined), process_exit_code: result.code,
    process_ok: result.code === 0, task_verified: false,
    error: result.error ? redact(result.error) : null,
    note: "Test evidence only. A passing suite does not by itself verify task post-conditions.",
  };
  ledger.push({ ...out, at: new Date().toISOString() });
  if (ledger.length > 100) ledger.shift();
  try { await core.audit("p24.test_execution", project_id, { run_id: out.run_id,
    task_key: out.task_key, pass: out.pass, fail: out.fail, evidence_class: out.evidence_class }); }
  catch { /* best effort */ }
  return out;
}

/** Bounded, process-local status of recent test executions. */
export async function testExecutionStatus({ project_id, run_id, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [] };
  const n = clamp(limit, 1, 100, 50);
  return { ok: true, items: ledger.slice(-n).map((x) => ({ ...x, output_redacted: short(x.output_redacted, 300) })),
    note: "Process-local ledger; not a durable cross-process record." };
}

export default { runTests, testExecutionStatus };
