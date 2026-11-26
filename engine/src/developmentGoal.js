// Phase 19 workstreams B + D: Development Goal Understanding and evidence-backed
// task continuity. Additive-only layer over `dev_goal` / `dev_task` (migration 017).
//
// Invariants:
//   - history is preserved (evidence is only ever appended, never deleted);
//   - no same-key duplicate ever overwrites an existing row;
//   - a task may not be marked `completed` without explicit verification evidence
//     (an agent claim such as "done" or "implemented" is never sufficient);
//   - every read is project-scoped and bounded; no LLM calls, no cross-project access;
//   - audit events are content-free (ids, status, counts only -- never titles or payloads).
import crypto from "node:crypto";
import * as core from "./core.js";

export const GOAL_STATUSES = Object.freeze(["active", "completed", "blocked", "superseded"]);
export const TASK_STATUSES = Object.freeze([
  "not_started", "in_progress", "blocked", "completed", "failed", "abandoned", "superseded",
]);

const GOAL_FIELDS = "id, project_id, title, description, status, requirements, constraints, evidence, source_session, created_at, updated_at";
const TASK_FIELDS = "id, project_id, goal_id, task_key, title, status, parent_task_id, evidence, source_session, created_at, updated_at";
const UNFINISHED_TASK_STATUSES = ["not_started", "in_progress", "blocked", "failed"];

// Verification markers that count as real evidence. A bare agent claim ("done",
// "implemented", "completed") contains none of these and is therefore rejected.
const VERIFICATION_MARKERS = ["test_pass", "verification_result", "tool_result", "test_result"];
const SUCCESS_RE = /\b(pass(?:ed)?|success(?:ful)?|succeeded|ok|green|true)\b/i;
const FAILURE_RE = /\b(fail(?:ed|ure)?|error|false|red)\b/i;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedLimit(limit, fallback, cap) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
}

function valueIndicatesSuccess(value) {
  if (value === true || (typeof value === "number" && value === 1)) return true;
  if (typeof value === "string") return SUCCESS_RE.test(value) && !FAILURE_RE.test(value);
  return false;
}

function objectIndicatesSuccess(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.success === true || obj.ok === true || obj.passed === true) return true;
  for (const key of ["status", "result", "outcome"]) {
    const v = obj[key];
    if (typeof v === "string" && SUCCESS_RE.test(v) && !FAILURE_RE.test(v)) return true;
    if (v === true) return true;
  }
  return false;
}

/**
 * True only when `evidence` holds at least one explicit verification marker with
 * a success signal. Agent assertions alone never qualify.
 */
export function canMarkComplete(evidence = []) {
  if (!Array.isArray(evidence)) return false;
  for (const item of evidence) {
    if (item === null || item === undefined) continue;

    if (typeof item === "string") {
      const s = item.toLowerCase().slice(0, 2000);
      // "test_pass" carries its own success signal ("pass").
      if (/\btest_pass\b/.test(s) && !FAILURE_RE.test(s)) return true;
      if (VERIFICATION_MARKERS.some((m) => s.includes(m)) && SUCCESS_RE.test(s) && !FAILURE_RE.test(s)) return true;
      continue;
    }

    if (typeof item !== "object") continue;

    for (const key of Object.keys(item)) {
      const k = key.toLowerCase();
      if (k === "test_pass") {
        const v = item[key];
        if (v !== false && v !== 0 && !FAILURE_RE.test(String(v))) return true;
        continue;
      }
      if (VERIFICATION_MARKERS.includes(k)) {
        const v = item[key];
        if (valueIndicatesSuccess(v)) return true;
        if (v && typeof v === "object" && objectIndicatesSuccess(v)) return true;
      }
    }

    const kind = String(item.kind ?? item.type ?? "").toLowerCase();
    if (VERIFICATION_MARKERS.includes(kind)) {
      if (kind === "test_pass" && !FAILURE_RE.test(String(item.result ?? item.status ?? ""))) return true;
      if (objectIndicatesSuccess(item)) return true;
    }
  }
  return false;
}

// Phrases that describe an explicit user goal/request (not a passing observation).
const GOAL_PATTERNS = [
  /^\s*(?:goal|objective|aim)\s*:\s*(.+)$/i,
  /^\s*(?:we|i)\s+(?:need|want|must|should|have)\s+to\s+(.+)$/i,
  /^\s*(?:please\s+)?(?:implement|build|create|add|develop|design|refactor|fix)\s+(.+)$/i,
  /^\s*(?:the\s+)?(?:goal|objective|aim)\s+is\s+to\s+(.+)$/i,
  /^\s*requirement\s*:\s*(.+)$/i,
];
// A single instruction must never be promoted into a permanent preference.
const PREFERENCE_RE = /\b(prefer|prefers|always|never|from now on|henceforth|every time|in general)\b/i;

/**
 * Pure, deterministic extraction of goal candidates from explicit user requests.
 * Returns only {title, description, requirements, constraints, evidence} and is
 * bounded to at most 10 candidates with truncated fields.
 */
export function extractGoalCandidates({ lines = [], summary = {}, project_id } = {}) {
  const out = [];
  const seen = new Set();
  // Durable transcript lines are objects ({role,text,...}); accept both shapes.
  // Only USER statements should become goals — tool output is evidence, not intent.
  const sourceLines = (Array.isArray(lines) ? lines : []).map((l) => {
    if (typeof l === "string") return { role: "USER", text: l };
    if (l && typeof l === "object") return { role: String(l.role || "USER"), text: String(l.text || "") };
    return { role: "UNKNOWN", text: "" };
  }).filter((l) => l.text && (l.role === "USER" || l.role === "UNKNOWN"));

  const summaryTexts = [];
  if (summary && typeof summary === "object") {
    for (const key of ["summary", "text", "goal", "description"]) {
      if (typeof summary[key] === "string" && summary[key].trim()) summaryTexts.push(summary[key]);
    }
    for (const key of ["goal_hints", "unfinished"]) {
      if (Array.isArray(summary[key])) summaryTexts.push(...summary[key].filter((s) => typeof s === "string"));
    }
  } else if (typeof summary === "string" && summary.trim()) {
    summaryTexts.push(summary);
  }

  for (const raw of [...sourceLines, ...summaryTexts]) {
    if (out.length >= 10) break;
    const line = (typeof raw === "string" ? raw : raw?.text || "").trim().slice(0, 500);
    if (!line || PREFERENCE_RE.test(line)) continue;

    let title = null;
    for (const re of GOAL_PATTERNS) {
      const m = line.match(re);
      if (m && m[1] && m[1].trim()) { title = m[1].trim(); break; }
    }
    // Also handle realistic prompts with a leading clause, e.g.
    // "In this dir create cache_store.py ...".
    if (!title) {
      const m = line.match(/\b(?:create|implement|build|develop|refactor|fix|add)\s+(.+)$/i);
      if (m && m[1] && m[1].trim()) title = m[1].trim();
    }
    if (!title) continue;

    title = title.replace(/[.!?]+$/, "").trim().slice(0, 160);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    // Explicit negative instructions are constraints, not completed work.
    const constraints = [];
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (/\b(?:do not|don't|must not|not yet|remains?|later|unfinished|leave .* for)\b/i.test(sentence)) {
        constraints.push(sentence.trim().slice(0, 200));
      }
    }
    out.push({
      title,
      description: line.slice(0, 400),
      requirements: [],
      constraints: constraints.slice(0, 5),
      evidence: [{ kind: "user_request", source: "session_line", text: line.slice(0, 200) }],
    });
  }
  return out;
}

/** Record a goal. A same-title goal in the project is a no-op duplicate. */
export async function recordGoal({
  project_id,
  title,
  description = "",
  requirements = [],
  constraints = [],
  evidence = [],
  source_session,
  id,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, created: false, reason: "project_id is required" };
  if (!nonEmptyString(title)) return { ok: false, created: false, reason: "title is required" };
  if (!Array.isArray(requirements)) requirements = [];
  if (!Array.isArray(constraints)) constraints = [];
  if (!Array.isArray(evidence)) evidence = [];

  const newId = nonEmptyString(id) ? String(id).slice(0, 512) : crypto.randomUUID();

  return core.withDb(async (c) => {
    const dup = await c.query(
      `SELECT id FROM dev_goal WHERE project_id=$1 AND title=$2 LIMIT 1`,
      [project_id, title],
    );
    if (dup.rowCount) {
      return { ok: false, created: false, duplicate: true, id: dup.rows[0].id, reason: "goal with this title already exists" };
    }
    if (nonEmptyString(id)) {
      const pk = await c.query("SELECT id FROM dev_goal WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) {
        return { ok: false, created: false, duplicate: true, id: newId, reason: "goal id already exists" };
      }
    }

    await c.query(
      `INSERT INTO dev_goal (id, project_id, title, description, requirements, constraints, evidence, source_session)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) RETURNING id`,
      [
        newId, project_id, title.slice(0, 512), String(description ?? "").slice(0, 20000),
        JSON.stringify(requirements.slice(0, 100)), JSON.stringify(constraints.slice(0, 100)),
        JSON.stringify(evidence.slice(0, 200)),
        source_session ? String(source_session).slice(0, 512) : null,
      ],
    );
    await core.audit("dev_goal.record", project_id, { id: newId, evidence_count: Math.min(evidence.length, 200) });
    return { ok: true, id: newId, created: true };
  });
}

/** Project-scoped, bounded goal listing. */
export async function getGoals({ project_id, status, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, goals: [], reason: "project_id is required" };
  const n = boundedLimit(limit, 50, 200);
  const r = await core.dbQuery(
    `SELECT ${GOAL_FIELDS} FROM dev_goal
      WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY updated_at DESC, id DESC LIMIT $3`,
    [project_id, status ?? null, n],
  );
  return { ok: true, goals: r.rows };
}

/** Update goal status, appending (never deleting) evidence. */
export async function setGoalStatus({ id, status, evidence = [], actor = "system" } = {}) {
  if (!nonEmptyString(id)) return { ok: false, changed: false, reason: "id is required" };
  if (!GOAL_STATUSES.includes(status)) return { ok: false, changed: false, reason: "invalid goal status" };
  if (!Array.isArray(evidence)) evidence = [];

  return core.withDb(async (c) => {
    const cur = await c.query(
      `SELECT id, project_id, evidence FROM dev_goal WHERE id=$1 LIMIT 1`,
      [String(id).slice(0, 512)],
    );
    if (!cur.rowCount) return { ok: false, changed: false, reason: "goal not found" };
    const row = cur.rows[0];
    const merged = [...(Array.isArray(row.evidence) ? row.evidence : []), ...evidence].slice(0, 500);

    const upd = await c.query(
      `UPDATE dev_goal SET status=$2, evidence=$3::jsonb, updated_at=now()
       WHERE id=$1 AND project_id=$4 RETURNING id`,
      [row.id, status, JSON.stringify(merged), row.project_id],
    );
    await core.audit("dev_goal.status", row.project_id, {
      id: row.id, status, actor: String(actor ?? "system").slice(0, 120), evidence_count: Math.min(evidence.length, 500),
    });
    return { ok: true, changed: upd.rowCount > 0 };
  });
}

/** Record a task. A same-key task in the project is a no-op duplicate. */
export async function recordTask({
  project_id,
  goal_id,
  task_key,
  title,
  status = "not_started",
  parent_task_id,
  evidence = [],
  source_session,
  id,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, reason: "project_id is required" };
  if (!nonEmptyString(task_key)) return { ok: false, reason: "task_key is required" };
  if (!nonEmptyString(title)) return { ok: false, reason: "title is required" };
  if (!TASK_STATUSES.includes(status)) return { ok: false, reason: "invalid task status" };
  if (!Array.isArray(evidence)) evidence = [];

  const newId = nonEmptyString(id) ? String(id).slice(0, 512) : crypto.randomUUID();

  return core.withDb(async (c) => {
    const dup = await c.query(
      "SELECT id FROM dev_task WHERE project_id=$1 AND task_key=$2 LIMIT 1",
      [project_id, task_key],
    );
    if (dup.rowCount) {
      return { ok: false, duplicate: true, id: dup.rows[0].id, reason: "task with this key already exists" };
    }
    if (nonEmptyString(goal_id)) {
      const g = await c.query(
        "SELECT id FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
        [String(goal_id).slice(0, 512), project_id],
      );
      if (!g.rowCount) return { ok: false, reason: "goal_id not found in project" };
    }
    if (nonEmptyString(parent_task_id)) {
      const p = await c.query(
        "SELECT id FROM dev_task WHERE id=$1 AND project_id=$2 LIMIT 1",
        [String(parent_task_id).slice(0, 512), project_id],
      );
      if (!p.rowCount) return { ok: false, reason: "parent_task_id not found in project" };
    }
    if (nonEmptyString(id)) {
      const pk = await c.query("SELECT id FROM dev_task WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) return { ok: false, duplicate: true, id: newId, reason: "task id already exists" };
    }

    await c.query(
      `INSERT INTO dev_task (id, project_id, goal_id, task_key, title, status, parent_task_id, evidence, source_session)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [
        newId, project_id, nonEmptyString(goal_id) ? String(goal_id).slice(0, 512) : null,
        task_key.slice(0, 256), title.slice(0, 512), status,
        nonEmptyString(parent_task_id) ? String(parent_task_id).slice(0, 512) : null,
        JSON.stringify(evidence.slice(0, 200)),
        source_session ? String(source_session).slice(0, 512) : null,
      ],
    );
    await core.audit("dev_task.record", project_id, {
      id: newId, task_key: task_key.slice(0, 256), goal_id: nonEmptyString(goal_id) ? String(goal_id).slice(0, 512) : null,
    });
    return { ok: true, id: newId };
  });
}

/** Update task status. Completion requires explicit verification evidence. */
export async function setTaskStatus({ id, project_id, task_key, status, evidence = [], actor = "system" } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, changed: false, reason: "project_id is required" };
  if (!nonEmptyString(id) && !nonEmptyString(task_key)) {
    return { ok: false, changed: false, reason: "id or task_key is required" };
  }
  if (!TASK_STATUSES.includes(status)) return { ok: false, changed: false, reason: "invalid task status" };
  if (!Array.isArray(evidence)) evidence = [];
  if (status === "completed" && !canMarkComplete(evidence)) {
    return { ok: false, changed: false, reason: "insufficient_evidence" };
  }

  return core.withDb(async (c) => {
    const byId = nonEmptyString(id);
    const key = byId ? String(id).slice(0, 512) : String(task_key).slice(0, 256);
    const where = byId ? "id=$1 AND project_id=$2" : "task_key=$1 AND project_id=$2";
    const cur = await c.query(
      `SELECT id, project_id, task_key, evidence FROM dev_task WHERE ${where} LIMIT 1`,
      [key, project_id],
    );
    if (!cur.rowCount) return { ok: false, changed: false, reason: "task not found in project" };
    const row = cur.rows[0];
    if (nonEmptyString(task_key) && row.task_key !== task_key) {
      return { ok: false, changed: false, reason: "task not found in project" };
    }

    const merged = [...(Array.isArray(row.evidence) ? row.evidence : []), ...evidence].slice(0, 500);
    const upd = await c.query(
      `UPDATE dev_task SET status=$2, evidence=$3::jsonb, updated_at=now()
       WHERE id=$1 AND project_id=$4 RETURNING id`,
      [row.id, status, JSON.stringify(merged), project_id],
    );
    await core.audit("dev_task.status", project_id, {
      id: row.id, status, actor: String(actor ?? "system").slice(0, 120), evidence_count: Math.min(evidence.length, 500),
    });
    return { ok: true, changed: upd.rowCount > 0 };
  });
}

/** Unfinished tasks (not_started / in_progress / blocked / failed), project-scoped. */
export async function getUnfinishedTasks({ project_id, goal_id, limit = 20 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, tasks: [], reason: "project_id is required" };
  const n = boundedLimit(limit, 20, 100);
  const r = await core.dbQuery(
    `SELECT ${TASK_FIELDS} FROM dev_task
      WHERE project_id=$1 AND status = ANY($2::text[])
        AND ($3::text IS NULL OR goal_id=$3)
      ORDER BY updated_at DESC, id DESC LIMIT $4`,
    [project_id, UNFINISHED_TASK_STATUSES, goal_id ?? null, n],
  );
  return { ok: true, tasks: r.rows };
}

/** Bounded continuity view: each goal with its project-scoped tasks. */
export async function getGoalContinuity({ project_id, limit = 20 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, goals: [], reason: "project_id is required" };
  const n = boundedLimit(limit, 20, 100);
  const g = await core.dbQuery(
    `SELECT ${GOAL_FIELDS} FROM dev_goal WHERE project_id=$1
      ORDER BY updated_at DESC, id DESC LIMIT $2`,
    [project_id, n],
  );
  const goals = [];
  for (const goal of g.rows) {
    const t = await core.dbQuery(
      `SELECT ${TASK_FIELDS} FROM dev_task WHERE project_id=$1 AND goal_id=$2
        ORDER BY updated_at DESC, id DESC LIMIT 50`,
      [project_id, goal.id],
    );
    goals.push({ ...goal, tasks: t.rows });
  }
  return { ok: true, goals };
}

/** Mark a goal superseded, preserving history and appending a supersession marker. */
export async function supersedeGoal({ id, by_id, reason, evidence = [] } = {}) {
  if (!nonEmptyString(id)) return { ok: false, reason: "id is required" };
  if (!Array.isArray(evidence)) evidence = [];

  return core.withDb(async (c) => {
    const cur = await c.query(
      "SELECT id, project_id, status, evidence FROM dev_goal WHERE id=$1 LIMIT 1",
      [String(id).slice(0, 512)],
    );
    if (!cur.rowCount) return { ok: false, reason: "goal not found" };
    const row = cur.rows[0];
    if (row.status === "superseded") return { ok: false, reason: "goal is already superseded" };

    if (nonEmptyString(by_id)) {
      const rep = await c.query(
        "SELECT id FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
        [String(by_id).slice(0, 512), row.project_id],
      );
      if (!rep.rowCount) return { ok: false, reason: "by_id goal not found in project" };
    }

    const marker = { kind: "supersession", by_id: nonEmptyString(by_id) ? String(by_id).slice(0, 512) : null, reason: String(reason ?? "").slice(0, 500) };
    const merged = [...(Array.isArray(row.evidence) ? row.evidence : []), ...evidence, marker].slice(0, 500);
    await c.query(
      `UPDATE dev_goal SET status='superseded', evidence=$2::jsonb, updated_at=now()
       WHERE id=$1 AND project_id=$3`,
      [row.id, JSON.stringify(merged), row.project_id],
    );
    await core.audit("dev_goal.supersede", row.project_id, {
      id: row.id, by_id: nonEmptyString(by_id) ? String(by_id).slice(0, 512) : null,
    });
    return { ok: true, changed: true };
  });
}
