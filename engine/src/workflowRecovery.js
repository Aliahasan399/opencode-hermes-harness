// Phase 24 — controlled, bounded retry/recovery. Never bypasses the approval gate:
// each retry consumes one explicit single-use approval bound to the run's plan.
// No destructive operations, no source writes, no unbounded loops, LEVEL 1 preserved.
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}
const ACTIVE = new Set(["claimed", "running", "verifying"]);

/**
 * Retry failed or stale tasks. `approvals` is an array of { approval_id, token };
 * a single { approval_id, token } pair is also accepted for one retry. Tasks without
 * a matching approval are skipped — recovery never dispatches without approval.
 */
export async function recoverRun({ project_id, run_id, approvals, approval_id, token,
  max_attempts, spawnFn, dry_run, stale_after_ms } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required", retried: 0, results: [], degraded: [] };
  const maxAttempts = clamp(max_attempts, 1, 5, 2);
  const staleMs = clamp(stale_after_ms, 1000, 86400000, 5 * 60 * 1000);
  const approvalList = Array.isArray(approvals) ? approvals.slice(0, 20)
    : (approval_id && token ? [{ approval_id, token }] : []);
  const degraded = [];
  const results = [];

  const sm = await load("workflowStateMachine");
  const dispatcher = await load("workflowDispatcher");
  if (!sm?.getRun || !dispatcher?.dispatchTask) return { ok: false, reason: "recovery dependencies unavailable", retried: 0, results, degraded };

  let got;
  try { got = await sm.getRun({ project_id, run_id }); }
  catch (e) { return { ok: false, reason: `run lookup: ${short(e?.message || e, 120)}`, retried: 0, results, degraded }; }
  if (!got.ok) return { ok: false, reason: got.reason, retried: 0, results, degraded };

  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const candidates = (got.tasks || []).filter((t) => {
    const attempts = Number(t.attempts || 0);
    if (attempts >= maxAttempts) return false;
    if (t.status === "failed" || t.status === "blocked") return true;
    if (ACTIVE.has(t.status) && String(t.updated_at) < cutoff) return true;
    return false;
  }).slice(0, 20);

  if (!candidates.length) return { ok: true, retried: 0, results, degraded,
    note: "No failed or stale tasks eligible for retry." };
  if (!approvalList.length) return { ok: false, reason: "approval required for recovery", retried: 0, results, degraded };

  for (let i = 0; i < candidates.length; i++) {
    const task = candidates[i];
    const ap = approvalList[i];
    if (!ap) {
      degraded.push(`${task.task_key}: no approval available`);
      results.push({ task_key: task.task_key, skipped: true, reason: "no approval available" });
      continue;
    }
    // Bring the task back to 'pending' using only legal transitions.
    try {
      if (ACTIVE.has(task.status)) {
        await sm.transitionTask({ project_id, run_id, task_key: task.task_key, to_status: "failed" });
      }
      const cur = await sm.transitionTask({ project_id, run_id, task_key: task.task_key, to_status: "pending" });
      if (!cur.ok && !/illegal/.test(cur.reason || "")) {
        degraded.push(`${task.task_key}: ${cur.reason}`);
        continue;
      }
    } catch (e) { degraded.push(`${task.task_key}: ${short(e?.message || e, 80)}`); continue; }

    let r;
    try {
      r = await dispatcher.dispatchTask({ project_id, run_id, task_key: task.task_key,
        approval_id: ap.approval_id, token: ap.token, mode: dry_run ? "simulation" : "real",
        dry_run: dry_run !== false, spawnFn });
    } catch (e) { degraded.push(`${task.task_key}: ${short(e?.message || e, 80)}`); continue; }
    if (!r?.ok) degraded.push(`${task.task_key}: ${r?.reason || "dispatch rejected"}`);
    results.push({ task_key: task.task_key, ok: !!r?.ok, reason: r?.reason || null,
      evidence_class: r?.results?.[0]?.evidence_class || "mock", task_verified: false });
  }

  const retried = results.filter((x) => x.ok && !x.skipped).length;
  await audit("workflow.recover", project_id, { run_id, retried, degraded: degraded.slice(0, 10) });
  return { ok: retried > 0 || degraded.length === 0, retried, results, degraded,
    note: "Recovery retries only with explicit approval; it never verifies task success." };
}

/** Retry one task with a single approval. */
export async function retryTask({ project_id, run_id, task_key, approval_id, token, ...opts } = {}) {
  return recoverRun({ project_id, run_id, approvals: [{ approval_id, token }], ...opts });
}

export default { recoverRun, retryTask };
