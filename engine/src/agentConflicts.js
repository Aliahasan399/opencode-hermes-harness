// Phase 22 Feature E — file-ownership registration and conflict detection.
//
// All state lives in the existing dev_task.file_ownership jsonb column that
// migration 020 added. Ownership registration is a UNION merge: it never
// replaces another task's claim and never drops an existing claim of the target
// task. Every read is scoped to (project_id, plan_id); output is bounded and
// file paths are redacted with core.redact(). No LLM, no network.
//
// Run: MEMORY_DB_NAME=opencode_memory_test node --test test/phase22-context-conflicts.test.js

import * as core from "./core.js";

const MAX_TASKS_SCAN = 200;
const MAX_FILES = 100;
const MAX_CONFLICTS = 50;
const MAX_TASKS_PER_CONFLICT = 10;
const MAX_PATH = 512;

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function short(v, n = MAX_PATH) {
  return core.redact(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, n);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    let p = short(f, MAX_PATH).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

async function planTasks(project_id, plan_id) {
  const r = await core.dbQuery(
    `SELECT id, task_key, file_ownership, assigned_agent, parallel_group, status
       FROM dev_task
      WHERE project_id=$1 AND plan_id=$2
      ORDER BY created_at NULLS LAST, id
      LIMIT $3`,
    [project_id, plan_id, MAX_TASKS_SCAN],
  );
  return r.rows.map((row) => ({
    id: row.id,
    files: normalizeFiles(row.file_ownership),
    agent: short(row.assigned_agent ?? "", 120),
    group: Number.isFinite(Number(row.parallel_group)) ? Number(row.parallel_group) : 0,
    status: short(row.status ?? "", 40),
  }));
}

function fileMapFrom(tasks) {
  const map = new Map();
  for (const t of tasks) {
    for (const f of t.files) {
      if (!map.has(f)) map.set(f, []);
      if (!map.get(f).includes(t.id)) map.get(f).push(t.id);
    }
  }
  return map;
}

/**
 * Deterministic, explainable resolution for one contested file.
 *   - >=3 claimants                     -> split
 *   - one (shared) agent, different groups -> single-owner
 *   - same parallel group               -> sequentialize
 *   - otherwise                         -> single-owner
 */
function recommend(ids, byId) {
  const tasks = ids.map((id) => byId.get(id)).filter(Boolean);
  const groups = new Set(tasks.map((t) => t.group));
  const withAgent = tasks.filter((t) => t.agent);
  const agents = new Set(withAgent.map((t) => t.agent));
  if (ids.length >= 3) return "split";
  if (withAgent.length === tasks.length && agents.size === 1) return "single-owner";
  if (groups.size === 1) return "sequentialize";
  return "single-owner";
}

function conflictFrom(file, ids, byId) {
  const tasks = [...new Set(ids)].slice(0, MAX_TASKS_PER_CONFLICT);
  return { file, tasks, recommendation: recommend(tasks, byId) };
}

function sortConflicts(conflicts) {
  conflicts.sort((a, b) =>
    a.file.localeCompare(b.file) || a.tasks.join(",").localeCompare(b.tasks.join(",")));
  return conflicts.slice(0, MAX_CONFLICTS);
}

/**
 * Register file ownership for one task in a plan. Overlap with ownership
 * already registered by OTHER tasks in the same plan is reported with a
 * recommended resolution. The requested files are union-merged into the
 * target task's claim (never overwrite). `accepted` is true only when the
 * registration is conflict-free; a contested claim is still recorded so that
 * detectConflicts/validateHandoff can see it.
 */
export async function registerFileOwnership({
  plan_id, task_id, agent, files = [], project_id,
} = {}) {
  if (!nonEmptyString(project_id) || !nonEmptyString(plan_id) || !nonEmptyString(task_id)) {
    return {
      ok: false, accepted: false, conflicts: [],
      reason: "project_id, plan_id and task_id are required",
    };
  }
  const pid = project_id.trim().slice(0, 200);
  const plan = plan_id.trim().slice(0, 200);
  const tid = task_id.trim().slice(0, 200);
  const requested = normalizeFiles(files);

  let tasks;
  try {
    tasks = await planTasks(pid, plan);
  } catch (e) {
    return { ok: false, accepted: false, conflicts: [], reason: `lookup failed: ${short(e?.message || e, 160)}` };
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const target = byId.get(tid);
  if (!target) {
    return { ok: false, accepted: false, conflicts: [], reason: "task not found in plan" };
  }

  const map = fileMapFrom(tasks);
  for (const f of requested) {
    if (!map.has(f)) map.set(f, []);
    if (!map.get(f).includes(tid)) map.get(f).push(tid);
  }

  const conflicts = [];
  for (const [file, ids] of map) {
    if (!requested.includes(file) || ids.length < 2) continue;
    conflicts.push(conflictFrom(file, ids, byId));
    if (conflicts.length >= MAX_CONFLICTS) break;
  }
  sortConflicts(conflicts);

  // Union merge — never overwrite the target's existing claim or any other task.
  const merged = [...new Set([...target.files, ...requested])].slice(0, MAX_FILES * 2);
  try {
    await core.dbQuery(
      `UPDATE dev_task SET file_ownership=$1::jsonb, updated_at=now()
        WHERE project_id=$2 AND plan_id=$3 AND id=$4`,
      [JSON.stringify(merged), pid, plan, tid],
    );
  } catch (e) {
    return { ok: false, accepted: false, conflicts, reason: `persist failed: ${short(e?.message || e, 160)}` };
  }
  try {
    await core.audit("agent.file_ownership.register", pid, {
      plan_id: plan, task_id: tid, agent: short(agent ?? "unknown", 120),
      files: requested.length, conflicts: conflicts.length,
    });
  } catch { /* audit is best-effort; ownership state is already persisted */ }

  return { ok: true, accepted: conflicts.length === 0, conflicts };
}

/** Bounded, project/plan-scoped scan for all files claimed by 2+ tasks. */
export async function detectConflicts({ plan_id, project_id } = {}) {
  if (!nonEmptyString(project_id) || !nonEmptyString(plan_id)) {
    return { ok: false, conflicts: [], reason: "project_id and plan_id are required" };
  }
  try {
    const tasks = await planTasks(project_id.trim().slice(0, 200), plan_id.trim().slice(0, 200));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const map = fileMapFrom(tasks);
    const conflicts = [];
    for (const [file, ids] of map) {
      if (ids.length < 2) continue;
      conflicts.push(conflictFrom(file, ids, byId));
      if (conflicts.length >= MAX_CONFLICTS) break;
    }
    return { ok: true, conflicts: sortConflicts(conflicts) };
  } catch (e) {
    return { ok: false, conflicts: [], reason: `scan failed: ${short(e?.message || e, 160)}` };
  }
}

/** Check whether two tasks in a plan can hand off cleanly (no shared file). */
export async function validateHandoff({ plan_id, from_task, to_task, project_id } = {}) {
  if (!nonEmptyString(project_id) || !nonEmptyString(plan_id)
    || !nonEmptyString(from_task) || !nonEmptyString(to_task)) {
    return {
      ok: false, clean: false, conflicts: [],
      reason: "project_id, plan_id, from_task and to_task are required",
    };
  }
  try {
    const tasks = await planTasks(project_id.trim().slice(0, 200), plan_id.trim().slice(0, 200));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const a = byId.get(from_task.trim().slice(0, 200));
    const b = byId.get(to_task.trim().slice(0, 200));
    if (!a || !b) {
      return { ok: false, clean: false, conflicts: [], reason: "task(s) not found in plan" };
    }
    const overlap = a.files.filter((f) => b.files.includes(f));
    const conflicts = overlap.map((f) => conflictFrom(f, [a.id, b.id], byId));
    return { ok: true, clean: conflicts.length === 0, conflicts: sortConflicts(conflicts) };
  } catch (e) {
    return { ok: false, clean: false, conflicts: [], reason: `validation failed: ${short(e?.message || e, 160)}` };
  }
}

export default { registerFileOwnership, detectConflicts, validateHandoff };
