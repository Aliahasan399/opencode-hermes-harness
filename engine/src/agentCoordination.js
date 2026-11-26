// Phase 22 Features B+C — task claim/complete/fail coordination and bounded
// project-scoped execution views. All state is in agent_execution / dev_task
// (migration 020). No LLM, no network, no clock-based scheduling.
//
// Invariants:
//   - claimTask only claims tasks whose dependencies are all 'completed', and
//     respects a per-plan parallel bound. It is idempotent: a repeated claim
//     returns the existing execution (duplicate:true) and inserts nothing.
//   - UNIQUE (plan_id, task_id, attempts) is the idempotency key; attempts are
//     monotonic and history rows are never deleted or rewritten to hide a fail.
//   - Retries are bounded to MAX_ATTEMPTS (3). After that the task goes to
//     'exhausted' and retryFailed will not touch it.
//   - Every read is project-scoped and bounded.

import * as core from "./core.js";

const MAX_ATTEMPTS = 3;
const DEFAULT_PARALLEL = 4;
const MAX_PARALLEL = 50;
const MAX_READ = 200;

const TASK_FIELDS =
  "id, project_id, plan_id, task_key, title, status, dependencies, required_capabilities, " +
  "assigned_agent, attempts, result_ref, priority, updated_at";
const EXEC_FIELDS =
  "id, plan_id, task_id, project_id, agent, session_id, status, result, error, attempts, claimed_at, finished_at";

// 'pending' is written by taskDecomposition.savePlan; 'not_started' is the
// dev_task default. Both mean "ready to claim".
const READY_STATUSES = ["pending", "not_started"];

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function safeStr(v, cap = Infinity) {
  let s = "";
  try { s = v === undefined || v === null ? "" : String(v); } catch { s = ""; }
  return s.slice(0, cap);
}

function boundedLimit(v, fallback, cap) {
  return Number.isInteger(v) && v > 0 ? Math.min(v, cap) : fallback;
}

function requireScope(input) {
  if (!input || typeof input !== "object") return "input must be an object";
  if (!nonEmptyString(input.project_id)) return "project_id is required";
  if (!nonEmptyString(input.plan_id)) return "plan_id is required";
  if (!nonEmptyString(input.task_id)) return "task_id is required";
  return null;
}

function depIds(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const d of raw.slice(0, 100)) {
    const id = typeof d === "string" ? d
      : (d && typeof d === "object" ? (d.id ?? d.task_id ?? d.dependency) : null);
    if (nonEmptyString(id) && !seen.has(id)) { seen.add(id); out.push(safeStr(id, 256)); }
  }
  return out;
}

function hasContent(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  for (const [k, v] of Object.entries(result)) {
    if (!k) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return true;
  }
  return false;
}

function normalizeResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 100));
  }
  if (typeof value === "string" && value.trim()) return { summary: safeStr(value, 2000) };
  return {};
}

async function auditInTransaction(c, action, project_id, detail) {
  try {
    await c.query("INSERT INTO audit_log (action, resource, detail) VALUES ($1,$2,$3::jsonb)",
      [action, safeStr(project_id, 200), JSON.stringify(detail)]);
  } catch { /* audit is best effort; never fail the coordination write */ }
}

async function parallelLimit(c, plan_id, project_id) {
  const r = await c.query(
    "SELECT decomposition FROM agent_plan WHERE id=$1 AND project_id=$2 LIMIT 1",
    [plan_id, project_id],
  );
  let decomposition = r.rows[0]?.decomposition;
  if (typeof decomposition === "string") {
    try { decomposition = JSON.parse(decomposition); } catch { decomposition = null; }
  }
  const requested = decomposition && !Array.isArray(decomposition)
    ? decomposition.max_parallel : null;
  const n = Number(requested);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PARALLEL) : DEFAULT_PARALLEL;
}

// --- Claim -----------------------------------------------------------------

/**
 * Atomically claim a ready task. Returns the existing execution on a duplicate
 * claim; refuses tasks with unfinished dependencies or when the plan is at its
 * parallel bound.
 */
export async function claimTask(options = {}) {
  const bad = requireScope(options);
  if (bad) return { ok: false, reason: bad };
  if (!nonEmptyString(options.agent)) return { ok: false, reason: "agent is required" };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const task_id = safeStr(options.task_id, 256).trim();
  const agent = safeStr(options.agent, 120).trim();
  const session_id = nonEmptyString(options.session_id) ? safeStr(options.session_id, 256) : null;

  return core.withDb(async (c) => {
    const t = (await c.query(
      `SELECT ${TASK_FIELDS} FROM dev_task
       WHERE id=$1 AND project_id=$2 AND plan_id=$3 LIMIT 1`,
      [task_id, project_id, plan_id],
    )).rows[0];
    if (!t) return { ok: false, reason: "task not found in plan/project" };

    // Idempotency: a still-running claim for this task is the same claim.
    const dup = (await c.query(
      `SELECT id FROM agent_execution
       WHERE plan_id=$1 AND task_id=$2 AND project_id=$3 AND status='running'
       ORDER BY id DESC LIMIT 1`,
      [plan_id, task_id, project_id],
    )).rows[0];
    if (dup) return { ok: true, execution_id: Number(dup.id), duplicate: true };

    if (!READY_STATUSES.includes(t.status)) {
      return { ok: false, reason: "task is not claimable", status: t.status };
    }

    const deps = depIds(t.dependencies);
    if (deps.length) {
      const done = (await c.query(
        `SELECT id, status FROM dev_task
         WHERE project_id=$1 AND plan_id=$2 AND id = ANY($3::text[])`,
        [project_id, plan_id, deps],
      )).rows;
      const statusById = new Map(done.map((d) => [d.id, d.status]));
      const unfinished = deps.filter((d) => statusById.get(d) !== "completed");
      if (unfinished.length) {
        return { ok: false, reason: "dependencies not completed", dependencies: unfinished };
      }
    }

    const max = await parallelLimit(c, plan_id, project_id);
    const running = (await c.query(
      `SELECT count(*)::int AS n FROM agent_execution
       WHERE plan_id=$1 AND project_id=$2 AND status='running'`,
      [plan_id, project_id],
    )).rows[0].n;
    if (running >= max) {
      return { ok: false, reason: "parallel bound reached", running, max };
    }

    const prevAttempt = (await c.query(
      `SELECT COALESCE(max(attempts),0)::int AS n FROM agent_execution
       WHERE plan_id=$1 AND task_id=$2 AND project_id=$3`,
      [plan_id, task_id, project_id],
    )).rows[0].n;
    const attempts = Math.max(prevAttempt + 1, 1);

    const ins = await c.query(
      `INSERT INTO agent_execution (plan_id, task_id, project_id, agent, session_id, status, attempts)
       VALUES ($1,$2,$3,$4,$5,'running',$6)
       ON CONFLICT (plan_id, task_id, attempts) DO NOTHING
       RETURNING id`,
      [plan_id, task_id, project_id, agent, session_id, attempts],
    );
    if (!ins.rowCount) {
      const existing = (await c.query(
        `SELECT id FROM agent_execution
         WHERE plan_id=$1 AND task_id=$2 AND project_id=$3 AND attempts=$4 ORDER BY id DESC LIMIT 1`,
        [plan_id, task_id, project_id, attempts],
      )).rows[0];
      return { ok: true, execution_id: existing ? Number(existing.id) : null, duplicate: true };
    }

    await c.query(
      `UPDATE dev_task SET assigned_agent=$2, status='in_progress',
         attempts=GREATEST(attempts,$3), updated_at=now()
       WHERE id=$1 AND project_id=$4 AND plan_id=$5`,
      [task_id, agent, attempts, project_id, plan_id],
    );
    await auditInTransaction(c, "agent.execution.claim", project_id,
      { plan_id, task_id, agent, attempts, execution_id: Number(ins.rows[0].id) });
    return { ok: true, execution_id: Number(ins.rows[0].id), duplicate: false, attempts };
  });
}

// --- Complete --------------------------------------------------------------

async function newlyUnblocked(c, plan_id, project_id, completedTaskId) {
  const candidates = (await c.query(
    `SELECT id, dependencies FROM dev_task
     WHERE plan_id=$1 AND project_id=$2 AND status = ANY($3::text[])
       AND dependencies @> $4::jsonb
     ORDER BY priority ASC, id ASC LIMIT $5`,
    [plan_id, project_id, READY_STATUSES, JSON.stringify([completedTaskId]), MAX_READ],
  )).rows;

  const out = [];
  for (const task of candidates) {
    const deps = depIds(task.dependencies);
    if (!deps.length) continue;
    const done = (await c.query(
      `SELECT count(*)::int AS n FROM dev_task
       WHERE project_id=$1 AND plan_id=$2 AND id = ANY($3::text[]) AND status='completed'`,
      [project_id, plan_id, deps],
    )).rows[0].n;
    if (done === deps.length) out.push(task.id);
  }
  return out;
}

/** Mark a running execution done, complete its task, and report newly-ready tasks. */
export async function completeTask(options = {}) {
  const bad = requireScope(options);
  if (bad) return { ok: false, unblocked: [], reason: bad };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const task_id = safeStr(options.task_id, 256).trim();
  const agent = nonEmptyString(options.agent) ? safeStr(options.agent, 120).trim() : null;
  const result = normalizeResult(options.result);
  if (!hasContent(result)) return { ok: false, unblocked: [], reason: "non-empty result is required" };

  return core.withDb(async (c) => {
    const ex = (await c.query(
      `SELECT id, agent FROM agent_execution
       WHERE plan_id=$1 AND task_id=$2 AND project_id=$3 AND status='running'
       ORDER BY id DESC LIMIT 1`,
      [plan_id, task_id, project_id],
    )).rows[0];
    if (!ex) return { ok: false, unblocked: [], reason: "no running execution for task" };
    if (agent && ex.agent !== agent) return { ok: false, unblocked: [], reason: "agent does not own execution" };

    await c.query(
      "UPDATE agent_execution SET status='done', result=$2::jsonb, finished_at=now() WHERE id=$1",
      [ex.id, JSON.stringify(result)],
    );
    await c.query(
      `UPDATE dev_task SET status='completed', result_ref=$1::jsonb,
         assigned_agent=$2, updated_at=now()
       WHERE id=$3 AND project_id=$4 AND plan_id=$5`,
      [JSON.stringify(result), ex.agent, task_id, project_id, plan_id],
    );
    const unblocked = await newlyUnblocked(c, plan_id, project_id, task_id);
    await auditInTransaction(c, "agent.execution.complete", project_id,
      { plan_id, task_id, agent: ex.agent, execution_id: Number(ex.id), unblocked });
    return { ok: true, execution_id: Number(ex.id), unblocked };
  });
}

// --- Fail / retry ----------------------------------------------------------

/** Fail the running execution. Retries are bounded; failed history is preserved. */
export async function failTask(options = {}) {
  const bad = requireScope(options);
  if (bad) return { ok: false, reason: bad };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const task_id = safeStr(options.task_id, 256).trim();
  const agent = nonEmptyString(options.agent) ? safeStr(options.agent, 120).trim() : null;
  const error = safeStr(options.error || "execution failed", 1000);

  return core.withDb(async (c) => {
    const ex = (await c.query(
      `SELECT id, agent, attempts FROM agent_execution
       WHERE plan_id=$1 AND task_id=$2 AND project_id=$3 AND status='running'
       ORDER BY id DESC LIMIT 1`,
      [plan_id, task_id, project_id],
    )).rows[0];
    if (!ex) return { ok: false, reason: "no running execution for task" };
    if (agent && ex.agent !== agent) return { ok: false, reason: "agent does not own execution" };

    const attempts = Math.max(Number(ex.attempts) || 1, 1);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const status = exhausted ? "exhausted" : "failed";
    await c.query(
      "UPDATE agent_execution SET status='failed', error=$2, finished_at=now() WHERE id=$1",
      [ex.id, error],
    );
    await c.query(
      `UPDATE dev_task SET status=$1, attempts=GREATEST(attempts,$2), updated_at=now()
       WHERE id=$3 AND project_id=$4 AND plan_id=$5`,
      [status, attempts, task_id, project_id, plan_id],
    );
    await auditInTransaction(c, "agent.execution.fail", project_id,
      { plan_id, task_id, agent: ex.agent, execution_id: Number(ex.id), attempts, exhausted });
    return { ok: true, status, attempts, exhausted, execution_id: Number(ex.id) };
  });
}

/** Requeue retryable failed tasks (bounded attempts), project-scoped and bounded. */
export async function retryFailed(options = {}) {
  if (!options || typeof options !== "object") return { ok: false, retried: [], reason: "input must be an object" };
  if (!nonEmptyString(options.project_id)) return { ok: false, retried: [], reason: "project_id is required" };
  if (!nonEmptyString(options.plan_id)) return { ok: false, retried: [], reason: "plan_id is required" };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const limit = boundedLimit(options.limit, 20, 100);

  return core.withDb(async (c) => {
    const rows = (await c.query(
      `SELECT id FROM dev_task
       WHERE plan_id=$1 AND project_id=$2 AND status='failed' AND attempts < $3
       ORDER BY priority ASC, id ASC LIMIT $4`,
      [plan_id, project_id, MAX_ATTEMPTS, limit],
    )).rows;
    const retried = [];
    for (const r of rows) {
      const u = await c.query(
        `UPDATE dev_task SET status='pending', updated_at=now()
         WHERE id=$1 AND project_id=$2 AND plan_id=$3 AND status='failed' AND attempts < $4
         RETURNING id`,
        [r.id, project_id, plan_id, MAX_ATTEMPTS],
      );
      if (u.rowCount) retried.push(r.id);
    }
    await auditInTransaction(c, "agent.execution.retry", project_id,
      { plan_id, retried: retried.length });
    return { ok: true, retried, count: retried.length };
  });
}

// --- Bounded, project-scoped reads -----------------------------------------

/** Tasks in a plan whose dependencies are all completed and are ready to claim. */
export async function getReadyTasks(options = {}) {
  if (!options || typeof options !== "object") return { ok: false, tasks: [], reason: "input must be an object" };
  if (!nonEmptyString(options.project_id)) return { ok: false, tasks: [], reason: "project_id is required" };
  if (!nonEmptyString(options.plan_id)) return { ok: false, tasks: [], reason: "plan_id is required" };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const limit = boundedLimit(options.limit, 100, MAX_READ);

  const candidates = (await core.dbQuery(
    `SELECT ${TASK_FIELDS} FROM dev_task
     WHERE plan_id=$1 AND project_id=$2 AND status = ANY($3::text[])
     ORDER BY priority ASC, id ASC LIMIT $4`,
    [plan_id, project_id, READY_STATUSES, limit],
  )).rows;

  const tasks = [];
  for (const task of candidates) {
    const deps = depIds(task.dependencies);
    if (!deps.length) { tasks.push(task); continue; }
    const done = (await core.dbQuery(
      `SELECT count(*)::int AS n FROM dev_task
       WHERE project_id=$1 AND plan_id=$2 AND id = ANY($3::text[]) AND status='completed'`,
      [project_id, plan_id, deps],
    )).rows[0].n;
    if (done === deps.length) tasks.push(task);
  }
  return { ok: true, tasks, count: tasks.length };
}

/** Bounded view of executions and task status for a plan. */
export async function executionStatus(options = {}) {
  if (!options || typeof options !== "object") return { ok: false, items: [], reason: "input must be an object" };
  if (!nonEmptyString(options.project_id)) return { ok: false, items: [], reason: "project_id is required" };
  if (!nonEmptyString(options.plan_id)) return { ok: false, items: [], reason: "plan_id is required" };
  const plan_id = safeStr(options.plan_id, 256).trim();
  const project_id = safeStr(options.project_id, 256).trim();
  const limit = boundedLimit(options.limit, 50, MAX_READ);

  const items = (await core.dbQuery(
    `SELECT ${EXEC_FIELDS} FROM agent_execution
     WHERE plan_id=$1 AND project_id=$2 ORDER BY id DESC LIMIT $3`,
    [plan_id, project_id, limit],
  )).rows;
  const byStatusRows = (await core.dbQuery(
    `SELECT status, count(*)::int AS n FROM agent_execution
     WHERE plan_id=$1 AND project_id=$2 GROUP BY status`,
    [plan_id, project_id],
  )).rows;
  const taskRows = (await core.dbQuery(
    `SELECT status, count(*)::int AS n FROM dev_task
     WHERE plan_id=$1 AND project_id=$2 GROUP BY status`,
    [plan_id, project_id],
  )).rows;
  const byStatus = {};
  for (const r of byStatusRows) byStatus[r.status] = r.n;
  const taskStatus = {};
  for (const r of taskRows) taskStatus[r.status] = r.n;

  return { ok: true, items, executions: items, by_status: byStatus, task_status: taskStatus, degraded: [] };
}

export default { claimTask, completeTask, failTask, retryFailed, getReadyTasks, executionStatus };
