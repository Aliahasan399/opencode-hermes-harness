// Phase 24 — read-only monitoring of durable workflow runs. Bounded, project-scoped,
// fail-closed. Reporting presence is never runtime proof.
import * as core from "./core.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const STALE_MS = 5 * 60 * 1000;
const ACTIVE = new Set(["claimed", "running", "verifying"]);

/** Summarize one run: status counts and stale active tasks. */
export async function monitorRun({ project_id, run_id, limit, stale_after_ms } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required" };
  const n = clamp(limit, 1, 200, 100);
  const staleMs = clamp(stale_after_ms, 1000, 86400000, STALE_MS);
  try {
    const run = (await core.dbQuery(
      "SELECT * FROM workflow_run WHERE id=$1 AND project_id=$2", [run_id, project_id])).rows[0];
    if (!run) return { ok: false, reason: "run not found in project scope" };
    const tasks = (await core.dbQuery(
      "SELECT * FROM workflow_task WHERE run_id=$1 AND project_id=$2 ORDER BY created_at, task_key LIMIT $3",
      [run_id, project_id, n])).rows;
    const cutoffMs = Date.now() - staleMs;
    const stale = tasks.filter((t) => {
      if (!ACTIVE.has(t.status)) return false;
      const ts = new Date(t.updated_at).getTime();
      return Number.isFinite(ts) && ts < cutoffMs;
    }).map((t) => ({ task_key: t.task_key, status: t.status, updated_at: t.updated_at }));
    const summary = { total: tasks.length };
    for (const t of tasks) summary[t.status] = (summary[t.status] || 0) + 1;
    summary.stale = stale.length;
    return { ok: true, run, tasks, stale, summary,
      note: "Observed durable state only. Never implies successful task execution or verified outcomes." };
  } catch (e) { return { ok: false, reason: `monitorRun: ${short(e?.message || e, 140)}` }; }
}

/** Stale active tasks across all runs of a project. */
export async function listStale({ project_id, stale_after_ms, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const n = clamp(limit, 1, 200, 50);
  const staleMs = clamp(stale_after_ms, 1000, 86400000, STALE_MS);
  try {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const r = await core.dbQuery(
      `SELECT run_id,task_key,status,attempts,updated_at FROM workflow_task
         WHERE project_id=$1 AND status IN ('claimed','running','verifying') AND updated_at < $2
         ORDER BY updated_at ASC LIMIT $3`, [project_id, cutoff, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: `listStale: ${short(e?.message || e, 140)}` }; }
}

/** Project-level health snapshot aggregated from run/task status counts. */
export async function workflowHealth({ project_id } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  try {
    const runs = await core.dbQuery(
      "SELECT status,count(*)::int AS n FROM workflow_run WHERE project_id=$1 GROUP BY status", [project_id]);
    const tasks = await core.dbQuery(
      "SELECT status,count(*)::int AS n FROM workflow_task WHERE project_id=$1 GROUP BY status", [project_id]);
    const by = (rows) => Object.fromEntries(rows.rows.map((r) => [r.status, r.n]));
    const stale = await listStale({ project_id, limit: 200 });
    const verification = await core.dbQuery(
      "SELECT verified,count(*)::int AS n FROM workflow_verification WHERE project_id=$1 GROUP BY verified", [project_id]);
    return { ok: true, runs: by(runs), tasks: by(tasks),
      stale_count: stale.ok ? stale.count : 0,
      verification: Object.fromEntries(verification.rows.map((r) => [String(r.verified), r.n])),
      note: "Counts reflect recorded state. Wiring/presence is not runtime proof; process_ok is not task_verified." };
  } catch (e) { return { ok: false, reason: `workflowHealth: ${short(e?.message || e, 140)}` }; }
}

export default { monitorRun, listStale, workflowHealth };
