// Phase 24 — durable run/task state machine for controlled workflow execution.
// Prepared runs and tasks only; NO dispatch, NO process spawn, NO source writes.
// Legal transitions are enforced. Every function is fail-closed (returns ok:false
// instead of throwing), project-scoped, bounded and best-effort audited.
import crypto from "node:crypto";
import * as core from "./core.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const TERMINAL = new Set(["done", "failed", "blocked", "cancelled"]);
const LEGAL = {
  pending: ["claimed", "cancelled"],
  claimed: ["running", "cancelled"],
  running: ["verifying", "failed", "blocked", "cancelled"],
  verifying: ["done", "failed", "blocked", "cancelled"],
  failed: ["pending", "cancelled"],
  blocked: ["pending", "cancelled"],
  done: [],
  cancelled: [],
};
const RUN_TERMINAL = new Set(["done", "failed", "blocked", "cancelled"]);

async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 100).map((t, i) => {
    const src = t && typeof t === "object" ? t : {};
    const key = short(src.task_key || src.id || src.key || `task-${i + 1}`, 120) || `task-${i + 1}`;
    return {
      task_key: key,
      title: short(src.title || src.description || key, 280),
      dependencies: Array.isArray(src.dependencies) ? src.dependencies.slice(0, 50).map((d) => String(d)) : [],
      file_ownership: Array.isArray(src.file_ownership) ? src.file_ownership.slice(0, 100).map((f) => String(f)) : [],
      assigned_agent: short(src.assigned_agent || src.agent || "", 120),
      model: short(src.model || "", 120),
      risk: ["low", "medium", "high"].includes(src.risk) ? src.risk : "low",
    };
  });
}

/** Create (or return an existing) durable run plus its pending tasks. */
export async function startRun({ project_id, plan_id, plan_version, plan_hash, approval_id,
  mode, tasks, template, source_ref, created_by } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const taskDefs = normalizeTasks(tasks);
  try {
    const existing = await core.dbQuery(
      `SELECT id FROM workflow_run WHERE project_id=$1 AND plan_id=$2 AND plan_version=$3
         AND plan_hash=$4 AND COALESCE(approval_id,'')=COALESCE($5,'')
         AND status NOT IN ('cancelled') ORDER BY created_at DESC LIMIT 1`,
      [project_id, String(plan_id || ""), String(plan_version || ""), String(plan_hash || ""), approval_id || null]);
    if (existing.rowCount) return { ok: true, run_id: existing.rows[0].id, duplicate: true, tasks: [] };
    const run_id = crypto.randomUUID();
    await core.dbQuery(
      `INSERT INTO workflow_run (id,project_id,plan_id,plan_version,plan_hash,approval_id,mode,status,
         template,source_ref,created_by,summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8,$9,$10,$11::jsonb)`,
      [run_id, project_id, String(plan_id || ""), String(plan_version || ""), String(plan_hash || ""),
        approval_id || null, mode === "real" ? "real" : "simulation", String(template || ""),
        String(source_ref || ""), String(created_by || ""), JSON.stringify({ task_count: taskDefs.length })]);
    for (const t of taskDefs) {
      await core.dbQuery(
        `INSERT INTO workflow_task (id,run_id,project_id,task_key,title,dependencies,file_ownership,
           assigned_agent,model,risk,status,attempts,result_ref)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,'pending',0,'{}'::jsonb)
         ON CONFLICT (run_id,task_key) DO NOTHING`,
        [crypto.randomUUID(), run_id, project_id, t.task_key, t.title, JSON.stringify(t.dependencies),
          JSON.stringify(t.file_ownership), t.assigned_agent, t.model, t.risk]);
    }
    await audit("workflow.run.start", project_id, { run_id, task_count: taskDefs.length, mode });
    return { ok: true, run_id, duplicate: false, tasks: taskDefs,
      note: "Run and pending tasks prepared. No agent dispatched and no process spawned." };
  } catch (e) { return { ok: false, reason: `startRun: ${short(e?.message || e, 140)}` }; }
}

/** Enforce the legal state transition for one task. */
export async function transitionTask({ project_id, run_id, task_key, to_status, evidence } = {}) {
  if (!validProject(project_id) || !run_id || !task_key) return { ok: false, reason: "valid scope required", changed: false };
  if (!LEGAL[to_status]) return { ok: false, reason: "unknown target status", changed: false };
  try {
    const r = await core.dbQuery(
      "SELECT id,status,attempts FROM workflow_task WHERE run_id=$1 AND project_id=$2 AND task_key=$3",
      [run_id, project_id, task_key]);
    if (!r.rowCount) return { ok: false, reason: "task not found in project scope", changed: false };
    const from = r.rows[0].status;
    if (from === to_status) return { ok: true, from, to: to_status, changed: false };
    if (!LEGAL[from]?.includes(to_status)) {
      return { ok: false, reason: `illegal transition ${from}->${to_status}`, from, to: to_status, changed: false };
    }
    const attempts = r.rows[0].attempts + (to_status === "running" ? 1 : 0);
    const result_ref = evidence ? JSON.stringify({ evidence: short(core.redact(String(evidence)), 400) }) : undefined;
    await core.dbQuery(
      `UPDATE workflow_task SET status=$1, attempts=$2,
         result_ref=COALESCE($3::jsonb,result_ref), updated_at=now()
       WHERE id=$4 AND project_id=$5`,
      [to_status, attempts, result_ref || null, r.rows[0].id, project_id]);
    if (TERMINAL.has(to_status)) {
      const rest = await core.dbQuery(
        "SELECT status FROM workflow_task WHERE run_id=$1 AND project_id=$2", [run_id, project_id]);
      const statuses = rest.rows.map((x) => x.status);
      if (statuses.length && statuses.every((s) => TERMINAL.has(s))) {
        const runStatus = statuses.includes("failed") || statuses.includes("blocked") ? "failed"
          : statuses.includes("cancelled") ? "cancelled" : "done";
        await core.dbQuery("UPDATE workflow_run SET status=$1,updated_at=now() WHERE id=$2 AND project_id=$3",
          [runStatus, run_id, project_id]);
      }
    }
    await audit("workflow.task.transition", project_id, { run_id, task_key, from, to: to_status });
    return { ok: true, from, to: to_status, changed: true };
  } catch (e) { return { ok: false, reason: `transitionTask: ${short(e?.message || e, 140)}`, changed: false }; }
}

/** Read a run and its tasks (project-scoped, bounded). */
export async function getRun({ project_id, run_id, limit } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required" };
  const n = clamp(limit, 1, 200, 100);
  try {
    const run = await core.dbQuery("SELECT * FROM workflow_run WHERE id=$1 AND project_id=$2", [run_id, project_id]);
    if (!run.rowCount) return { ok: false, reason: "run not found in project scope" };
    const tasks = await core.dbQuery(
      "SELECT * FROM workflow_task WHERE run_id=$1 AND project_id=$2 ORDER BY created_at, task_key LIMIT $3",
      [run_id, project_id, n]);
    return { ok: true, run: run.rows[0], tasks: tasks.rows };
  } catch (e) { return { ok: false, reason: `getRun: ${short(e?.message || e, 140)}` }; }
}

/** List runs for a project (optionally by status). */
export async function listRuns({ project_id, status, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const n = clamp(limit, 1, 200, 50);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM workflow_run WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
         ORDER BY created_at DESC LIMIT $3`, [project_id, status || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: `listRuns: ${short(e?.message || e, 140)}` }; }
}

/** Tasks whose dependencies are all 'done' (bounded, deterministic order). */
export async function getReadyTasks({ project_id, run_id, limit } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required" };
  const n = clamp(limit, 1, 100, 20);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM workflow_task WHERE run_id=$1 AND project_id=$2 AND status='pending'
         ORDER BY created_at, task_key LIMIT $3`, [run_id, project_id, n]);
    const all = await core.dbQuery(
      "SELECT task_key,status FROM workflow_task WHERE run_id=$1 AND project_id=$2", [run_id, project_id]);
    const byKey = new Map(all.rows.map((x) => [x.task_key, x.status]));
    const ready = r.rows.filter((t) => {
      const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
      return deps.every((d) => byKey.get(String(d)) === "done");
    });
    return { ok: true, items: ready, count: ready.length };
  } catch (e) { return { ok: false, reason: `getReadyTasks: ${short(e?.message || e, 140)}` }; }
}

export default { startRun, transitionTask, getRun, listRuns, getReadyTasks };
