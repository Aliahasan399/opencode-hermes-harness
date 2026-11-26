// Phase 26 §2.1: long-term project goals. This module EXTENDS the Phase 19
// `dev_goal` table and DELEGATES the base insert to `developmentGoal.recordGoal`;
// it never creates a second goal store. Additive-only metadata columns come from
// migration 024. LEVEL 1 and HARNESS_SEMANTIC_LLM=0 unchanged.
//
// Invariants (fail closed):
//   - every operation is project-scoped; empty / "_global" project ids are rejected;
//   - goal_type / provenance come from frozen vocabularies; a parent goal must exist
//     in the same project; a goal id from another project is never accepted;
//   - no goal is ever changed without an explicit, non-empty actor;
//   - evidence is only appended, never deleted; all reads are bounded and redacted;
//   - audits are best-effort and content-free (ids, status, counts only);
//   - a missing sibling module or an unavailable DB degrades instead of throwing.
import * as core from "./core.js";

export const GOAL_TYPES = Object.freeze(["vision", "long_term", "short_term"]);
export const PROVENANCE = Object.freeze([
  "user_approved", "inferred", "ai_recommendation", "verified_outcome",
]);
export const GOAL_STATES = Object.freeze([
  "proposed", "active", "paused", "achieved", "cancelled", "superseded", "at_risk",
]);
export const DETAIL_FIELDS = Object.freeze([
  "description", "priority", "target_date", "owner", "success_criteria",
  "goal_type", "provenance", "parent_goal_id",
]);

export const GOALS_NOTE =
  "Static, record-based goal metadata only. No goal is changed without an explicit actor; " +
  "no execution, approval or dispatch is performed. Unknown means insufficient evidence.";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_HISTORY = 500;
const GOAL_FIELDS =
  "id, project_id, title, description, status, requirements, constraints, evidence, source_session, " +
  "goal_type, priority, target_date, owner, success_criteria, provenance, parent_goal_id, created_at, updated_at";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* best effort; auditing never blocks a gate */ }
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const validProject = (p) => nonEmpty(p) && p !== "_global";
const short = (v, n = 220) => core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n);
const clipId = (v, n = 512) => String(v ?? "").slice(0, n);
const clampLimit = (limit, fallback = DEFAULT_LIMIT, cap = MAX_LIMIT) =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
const clampPriority = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1000, Math.min(1000, Math.trunc(n)));
};

/** Recursively redact strings and cap structure (ids/references survive intact). */
function redactValue(v, depth = 0) {
  if (typeof v === "string") return short(v, 2000);
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactValue(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).sort().slice(0, 30)) out[k.slice(0, 60)] = redactValue(v[k], depth + 1);
  return out;
}
function boundEvidence(evidence, cap = 200) {
  if (!Array.isArray(evidence)) return [];
  return evidence.slice(0, cap).map((e) => {
    if (typeof e === "string") return short(e, 2000);
    if (e && typeof e === "object") return redactValue(e);
    return e;
  });
}
function boundCriteria(criteria, cap = 50) {
  if (!Array.isArray(criteria)) return [];
  return criteria.slice(0, cap).map((c) => {
    if (typeof c === "string") return short(c, 400);
    if (c && typeof c === "object") return redactValue(c);
    return c;
  });
}
function normalizeDate(v) {
  if (v === null || v === undefined || v === "") return { value: null };
  if (typeof v !== "string" && !(v instanceof Date)) return { error: "invalid target_date" };
  const t = Date.parse(v instanceof Date ? v.toISOString() : v);
  if (!Number.isFinite(t)) return { error: "invalid target_date" };
  return { value: new Date(t).toISOString() };
}
function publicGoal(row) {
  if (!row) return null;
  return {
    ...row,
    title: core.redact(String(row.title ?? "")),
    description: core.redact(String(row.description ?? "")),
    owner: core.redact(String(row.owner ?? "")),
    success_criteria: redactValue(
      Array.isArray(row.success_criteria) ? row.success_criteria : [],
    ),
  };
}
function fail(reason, extra = {}) {
  return { ok: false, reason, degraded: [], note: GOALS_NOTE, ...extra };
}
function degradedFail(reason, e, extra = {}) {
  const d = short(e?.message || e, 160);
  return fail(reason, { degraded: [d], error_detail: d, ...extra });
}

// ---------------------------------------------------------------------------
// 1. Reads
// ---------------------------------------------------------------------------

/** Project-scoped, bounded goal listing including migration-024 metadata. */
export async function listGoals({ project_id, status, limit } = {}) {
  if (!validProject(project_id)) return fail("valid project_id required", { goals: [] });
  const n = clampLimit(limit);
  try {
    const r = await core.dbQuery(
      `SELECT ${GOAL_FIELDS} FROM dev_goal
        WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
        ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [project_id, nonEmpty(status) ? status : null, n],
    );
    return { ok: true, goals: r.rows.map(publicGoal), count: r.rows.length, limit: n, note: GOALS_NOTE };
  } catch (e) {
    return degradedFail("goal listing unavailable", e, { goals: [], limit: n });
  }
}

/** A single project-scoped goal with its extended metadata. */
export async function getGoalDetail({ project_id, goal_id } = {}) {
  if (!validProject(project_id)) return fail("valid project_id required", { goal: null });
  if (!nonEmpty(goal_id)) return fail("goal_id required", { goal: null });
  try {
    const r = await core.dbQuery(
      `SELECT ${GOAL_FIELDS} FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1`,
      [clipId(goal_id), project_id],
    );
    return {
      ok: true, found: r.rowCount > 0, goal: publicGoal(r.rows[0] ?? null), note: GOALS_NOTE,
    };
  } catch (e) {
    return degradedFail("goal detail unavailable", e, { goal: null });
  }
}

/** Append-only evidence timeline for one goal (never deletes an entry). */
export async function getGoalHistory({ project_id, goal_id, limit } = {}) {
  if (!validProject(project_id)) return fail("valid project_id required", { history: [], count: 0 });
  if (!nonEmpty(goal_id)) return fail("goal_id required", { history: [], count: 0 });
  const n = clampLimit(limit, 100, MAX_HISTORY);
  try {
    const r = await core.dbQuery(
      "SELECT evidence FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
      [clipId(goal_id), project_id],
    );
    if (!r.rowCount) {
      return { ok: true, found: false, history: [], count: 0, limit: n,
        reason: "goal not found in project", note: GOALS_NOTE };
    }
    const evidence = Array.isArray(r.rows[0].evidence) ? r.rows[0].evidence : [];
    const history = boundEvidence(evidence, n);
    return { ok: true, found: true, history, count: history.length, limit: n, note: GOALS_NOTE };
  } catch (e) {
    return degradedFail("goal history unavailable", e, { history: [], count: 0, limit: n });
  }
}

// ---------------------------------------------------------------------------
// 2. Writes (all require an explicit actor where state/detail can change)
// ---------------------------------------------------------------------------

/**
 * Record an extended goal. The base row is inserted by the existing Phase 19
 * engine; this module only UPDATEs additive columns on that same id. A failed
 * delegation never produces a parallel goal record.
 */
export async function recordGoalExtended({
  project_id, title, description = "", goal_type = "short_term", priority = 0,
  target_date, owner = "", success_criteria = [], provenance = "user_approved",
  parent_goal_id = "", evidence = [], source_session, created_by,
} = {}) {
  const baseFail = (reason, extra = {}) => fail(reason, {
    ok: false, id: null, created: false, duplicate: false, ...extra,
  });
  if (!validProject(project_id)) return baseFail("valid project_id required");
  if (!nonEmpty(title)) return baseFail("title is required");

  const gt = goal_type === undefined || goal_type === null || goal_type === "" ? "short_term" : String(goal_type);
  if (!GOAL_TYPES.includes(gt)) return baseFail("invalid goal_type");
  const prov = provenance === undefined || provenance === null || provenance === "" ? "user_approved" : String(provenance);
  if (!PROVENANCE.includes(prov)) return baseFail("invalid provenance");

  const date = normalizeDate(target_date);
  if (date.error) return baseFail(date.error);
  const pid = nonEmpty(parent_goal_id) ? clipId(parent_goal_id) : "";
  const crit = boundCriteria(success_criteria);
  const ev = boundEvidence(evidence);

  try {
    // A parent must exist in the same project; cross-project ancestry is rejected
    // before any row is created.
    if (pid) {
      const p = await core.dbQuery(
        "SELECT id FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
        [pid, project_id],
      );
      if (!p.rowCount) return baseFail("parent_goal_id not found in project");
    }

    const dg = await load("developmentGoal");
    if (!dg || typeof dg.recordGoal !== "function") {
      return baseFail("goal store unavailable (delegation failed)", {
        degraded: ["developmentGoal.recordGoal unavailable"],
      });
    }
    // Delegate the base insert: same dedupe, same table, same history rules.
    const inserted = await dg.recordGoal({
      project_id,
      title: short(title, 512),
      description: short(description, 20000),
      requirements: [],
      constraints: [],
      evidence: ev,
      source_session,
    });
    if (!inserted?.ok || !inserted?.id) {
      return {
        ok: false, id: inserted?.id ?? null, created: false,
        duplicate: !!inserted?.duplicate, reason: inserted?.reason || "base goal insert failed",
        degraded: [], note: GOALS_NOTE,
      };
    }
    const id = clipId(inserted.id);

    // A previous duplicate must never have its extended metadata overwritten;
    // delegation reports duplicates with ok:false, so only fresh rows reach here.
    await core.withDb(async (client) => {
      await client.query(
        `UPDATE dev_goal SET goal_type=$2, priority=$3, target_date=$4, owner=$5,
           success_criteria=$6::jsonb, provenance=$7, parent_goal_id=$8
         WHERE id=$1 AND project_id=$9`,
        [id, gt, clampPriority(priority), date.value, short(owner, 200),
          JSON.stringify(crit), prov, pid, project_id],
      );
    });
    await audit("p26.goal_extended", project_id, {
      id, goal_type: gt, provenance: prov, has_parent: !!pid,
      created_by: clipId(created_by, 120), evidence_count: Math.min(ev.length, 200),
    });
    return { ok: true, id, created: true, duplicate: false, degraded: [], note: GOALS_NOTE };
  } catch (e) {
    return degradedFail("goal recording unavailable", e, {
      id: null, created: false, duplicate: false,
    });
  }
}

/** Full seven-state setter. Evidence is appended; an explicit actor is mandatory. */
export async function setGoalState({ project_id, goal_id, status, evidence = [], actor } = {}) {
  const baseFail = (reason, extra = {}) => fail(reason, { changed: false, ...extra });
  if (!validProject(project_id)) return baseFail("valid project_id required");
  if (!nonEmpty(goal_id)) return baseFail("goal_id required");
  if (!GOAL_STATES.includes(status)) return baseFail("invalid goal state");
  if (!nonEmpty(actor)) return baseFail("actor is required");

  const ev = boundEvidence(evidence);
  const gid = clipId(goal_id);
  try {
    return await core.withDb(async (client) => {
      const cur = await client.query(
        "SELECT id, status, evidence FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
        [gid, project_id],
      );
      if (!cur.rowCount) return baseFail("goal not found in project");
      const row = cur.rows[0];
      const merged = [
        ...(Array.isArray(row.evidence) ? row.evidence : []), ...ev,
      ].slice(0, MAX_HISTORY);
      const upd = await client.query(
        `UPDATE dev_goal SET status=$2, evidence=$3::jsonb, updated_at=now()
          WHERE id=$1 AND project_id=$4 RETURNING id`,
        [row.id, status, JSON.stringify(merged), project_id],
      );
      await audit("p26.goal_state", project_id, {
        id: row.id, status, actor: clipId(actor, 120), evidence_count: Math.min(ev.length, MAX_HISTORY),
      });
      return { ok: true, changed: upd.rowCount > 0, id: row.id, status,
        evidence_count: merged.length, degraded: [], note: GOALS_NOTE };
    });
  } catch (e) {
    return degradedFail("goal state change unavailable", e, { status, actor: null });
  }
}

/**
 * Bounded, whitelisted metadata patch. Unknown keys (status, title, id, ...)
 * are ignored; an explicit actor is mandatory. Parent goals are same-project only.
 */
export async function updateGoalDetails({ project_id, goal_id, patch, actor } = {}) {
  const baseFail = (reason, extra = {}) => fail(reason, { changed: false, ...extra });
  if (!validProject(project_id)) return baseFail("valid project_id required");
  if (!nonEmpty(goal_id)) return baseFail("goal_id required");
  if (!nonEmpty(actor)) return baseFail("actor is required");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return baseFail("patch must be an object");

  const gid = clipId(goal_id);
  const values = [];
  const assigns = [];
  const add = (col, value) => { values.push(value); assigns.push(`${col}=$${values.length}`); };
  const applied = [];
  try {
    for (const field of DETAIL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      const v = patch[field];
      if (field === "description") add(field, short(v, 20000));
      else if (field === "owner") add(field, short(v, 200));
      else if (field === "priority") add(field, clampPriority(v));
      else if (field === "target_date") {
        const d = normalizeDate(v);
        if (d.error) return baseFail(d.error);
        add(field, d.value);
      } else if (field === "success_criteria") {
        if (!Array.isArray(v)) return baseFail("success_criteria must be an array");
        add(field, JSON.stringify(boundCriteria(v)));
      } else if (field === "goal_type") {
        const gt = String(v ?? "");
        if (!GOAL_TYPES.includes(gt)) return baseFail("invalid goal_type");
        add(field, gt);
      } else if (field === "provenance") {
        const p = String(v ?? "");
        if (!PROVENANCE.includes(p)) return baseFail("invalid provenance");
        add(field, p);
      } else if (field === "parent_goal_id") {
        const p = nonEmpty(v) ? clipId(v) : "";
        if (p === gid) return baseFail("a goal cannot be its own parent");
        if (p) {
          const found = await core.dbQuery(
            "SELECT id FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1", [p, project_id],
          );
          if (!found.rowCount) return baseFail("parent_goal_id not found in project");
        }
        add(field, p);
      }
      applied.push(field);
    }
    if (!assigns.length) return baseFail("no allowed fields in patch");

    const idParam = `$${values.length + 1}`;
    const projectParam = `$${values.length + 2}`;
    values.push(gid, project_id);
    return await core.withDb(async (client) => {
      const upd = await client.query(
        `UPDATE dev_goal SET ${assigns.join(", ")}, updated_at=now()
          WHERE id=${idParam} AND project_id=${projectParam} RETURNING id`,
        values,
      );
      if (!upd.rowCount) return baseFail("goal not found in project");
      await audit("p26.goal_update", project_id, {
        id: gid, actor: clipId(actor, 120), fields: applied,
      });
      return { ok: true, changed: true, id: gid, fields: applied, degraded: [], note: GOALS_NOTE };
    });
  } catch (e) {
    return degradedFail("goal detail update unavailable", e, { fields: applied });
  }
}

export default {
  GOAL_TYPES, PROVENANCE, GOAL_STATES, DETAIL_FIELDS,
  listGoals, recordGoalExtended, setGoalState, updateGoalDetails, getGoalDetail, getGoalHistory,
};
