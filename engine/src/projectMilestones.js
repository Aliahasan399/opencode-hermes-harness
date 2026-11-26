// Phase 26 §2.2: evidence-gated project milestones. Additive-only layer over
// `pm_milestone` (migration 024) and `dev_task` (migration 017). LEVEL 1 and
// HARNESS_SEMANTIC_LLM=0 unchanged.
//
// Invariants (fail closed):
//   - every operation is project-scoped; empty / "_global" project ids are rejected;
//   - a goal_id must reference a dev_goal in the same project;
//   - 'completed' requires BOTH recorded success_criteria and explicit verification
//     evidence as judged by developmentGoal.canMarkComplete -- a process success
//     or agent claim is never sufficient;
//   - evidence is only appended, never deleted; an explicit actor is mandatory;
//   - progress is counts + a completion enum + a reason. No percentage is emitted;
//   - content is redacted and bounded, audits are best-effort and content-free,
//     and a missing sibling module or unavailable DB degrades instead of throwing.
import crypto from "node:crypto";
import * as core from "./core.js";

export const MILESTONE_STATUSES = Object.freeze([
  "planned", "active", "at_risk", "blocked", "completed", "delayed", "cancelled",
]);
export const COMPLETION = Object.freeze(["unknown", "insufficient_evidence", "not_applicable"]);

export const MILESTONE_NOTE =
  "Static, record-based milestone evidence only. Completion is never asserted from process success or " +
  "an agent claim, and no completion percentage is computed. No execution, approval or dispatch is performed.";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_HISTORY = 500;
const MILESTONE_FIELDS =
  "id, project_id, milestone_key, goal_id, title, description, success_criteria, priority, " +
  "target_date, status, evidence, created_by, created_at, updated_at";

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
function publicMilestone(row) {
  if (!row) return null;
  return {
    ...row,
    title: core.redact(String(row.title ?? "")),
    description: core.redact(String(row.description ?? "")),
    created_by: core.redact(String(row.created_by ?? "")),
    success_criteria: redactValue(Array.isArray(row.success_criteria) ? row.success_criteria : []),
  };
}
function fail(reason, extra = {}) {
  return { ok: false, reason, degraded: [], note: MILESTONE_NOTE, ...extra };
}
function degradedFail(reason, e, extra = {}) {
  const d = short(e?.message || e, 160);
  return fail(reason, { degraded: [d], error_detail: d, ...extra });
}
async function goalExists(project_id, goal_id) {
  if (!nonEmpty(goal_id)) return true; // milestones may exist without a linked goal
  const g = await core.dbQuery(
    "SELECT id FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
    [clipId(goal_id), project_id],
  );
  return g.rowCount > 0;
}

// ---------------------------------------------------------------------------
// 1. Record and read
// ---------------------------------------------------------------------------

/**
 * Record a milestone. Idempotent by UNIQUE(project_id, milestone_key): a repeat
 * returns the existing row (duplicate:true) without overwriting anything. An
 * empty success_criteria list is accepted but the milestone stays 'planned' and
 * can never be completed until criteria are recorded.
 */
export async function recordMilestone({
  project_id, milestone_key, title = "", description = "", goal_id = "",
  success_criteria = [], priority = 0, target_date, evidence = [], created_by = "",
} = {}) {
  const baseFail = (reason, extra = {}) => fail(reason, {
    id: null, duplicate: false, created: false, ...extra,
  });
  if (!validProject(project_id)) return baseFail("valid project_id required");
  if (!nonEmpty(milestone_key)) return baseFail("milestone_key is required");
  if (!nonEmpty(title)) return baseFail("title is required");

  const date = normalizeDate(target_date);
  if (date.error) return baseFail(date.error);
  const key = clipId(milestone_key, 256);
  const crit = boundCriteria(success_criteria);
  const ev = boundEvidence(evidence);
  const gid = nonEmpty(goal_id) ? clipId(goal_id) : "";
  const missingCriteria = crit.length === 0;

  try {
    if (!(await goalExists(project_id, gid))) return baseFail("goal_id not found in project");

    const dup = await core.dbQuery(
      "SELECT id FROM pm_milestone WHERE project_id=$1 AND milestone_key=$2 LIMIT 1",
      [project_id, key],
    );
    if (dup.rowCount) {
      await audit("p26.milestone_duplicate", project_id, { milestone_key: key });
      return { ok: true, id: dup.rows[0].id, duplicate: true, created: false, degraded: [],
        note: MILESTONE_NOTE };
    }

    const id = crypto.randomUUID();
    try {
      await core.withDb(async (client) => {
        await client.query(
          `INSERT INTO pm_milestone
             (id, project_id, milestone_key, goal_id, title, description, success_criteria,
              priority, target_date, status, evidence, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'planned',$10::jsonb,$11)`,
          [id, project_id, key, gid, short(title, 512), short(description, 20000),
            JSON.stringify(crit), clampPriority(priority), date.value,
            JSON.stringify(ev), clipId(created_by, 120)],
        );
      });
    } catch (e) {
      // Concurrent insert on the unique key: return the winner, never overwrite.
      if (String(e?.code || "") === "23505") {
        const again = await core.dbQuery(
          "SELECT id FROM pm_milestone WHERE project_id=$1 AND milestone_key=$2 LIMIT 1",
          [project_id, key],
        );
        if (again.rowCount) {
          return { ok: true, id: again.rows[0].id, duplicate: true, created: false, degraded: [],
            note: MILESTONE_NOTE };
        }
      }
      throw e;
    }
    await audit("p26.milestone_recorded", project_id, {
      id, milestone_key: key, has_goal: !!gid, missing_criteria: missingCriteria,
      created_by: clipId(created_by, 120), evidence_count: Math.min(ev.length, 200),
    });
    return {
      ok: true, id, duplicate: false, created: true, degraded: [],
      note: missingCriteria
        ? "success_criteria is empty: this milestone cannot be completed until criteria are recorded."
        : MILESTONE_NOTE,
    };
  } catch (e) {
    return degradedFail("milestone recording unavailable", e, { id: null });
  }
}

/** Project-scoped, bounded milestone listing (optionally by status / goal). */
export async function listMilestones({ project_id, status, goal_id, limit } = {}) {
  if (!validProject(project_id)) return fail("valid project_id required", { milestones: [], items: [], count: 0 });
  const n = clampLimit(limit);
  try {
    const r = await core.dbQuery(
      `SELECT ${MILESTONE_FIELDS} FROM pm_milestone
        WHERE project_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::text IS NULL OR goal_id=$3)
        ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [project_id, nonEmpty(status) ? status : null,
        nonEmpty(goal_id) ? clipId(goal_id) : null, n],
    );
    const rows = r.rows.map(publicMilestone);
    return { ok: true, milestones: rows, items: rows, count: rows.length, limit: n, note: MILESTONE_NOTE };
  } catch (e) {
    return degradedFail("milestone listing unavailable", e, { milestones: [], items: [], count: 0, limit: n });
  }
}

/** Look up one milestone by its project-scoped key. */
export async function getMilestone({ project_id, milestone_key } = {}) {
  if (!validProject(project_id)) return fail("valid project_id required", { milestone: null });
  if (!nonEmpty(milestone_key)) return fail("milestone_key required", { milestone: null });
  try {
    const r = await core.dbQuery(
      `SELECT ${MILESTONE_FIELDS} FROM pm_milestone
        WHERE project_id=$1 AND milestone_key=$2 LIMIT 1`,
      [project_id, clipId(milestone_key, 256)],
    );
    return { ok: true, found: r.rowCount > 0, milestone: publicMilestone(r.rows[0] ?? null), note: MILESTONE_NOTE };
  } catch (e) {
    return degradedFail("milestone lookup unavailable", e, { milestone: null });
  }
}

// ---------------------------------------------------------------------------
// 2. Status lifecycle and evidence-backed progress
// ---------------------------------------------------------------------------

/**
 * Set milestone status. Evidence is appended (never deleted) and an explicit
 * actor is mandatory. 'completed' is gated on recorded success_criteria AND
 * explicit verification evidence (developmentGoal.canMarkComplete).
 */
export async function setMilestoneStatus({ project_id, milestone_key, status, evidence = [], actor } = {}) {
  const baseFail = (reason, extra = {}) => fail(reason, { changed: false, ...extra });
  if (!validProject(project_id)) return baseFail("valid project_id required");
  if (!nonEmpty(milestone_key)) return baseFail("milestone_key is required");
  if (!MILESTONE_STATUSES.includes(status)) return baseFail("invalid milestone status");
  if (!nonEmpty(actor)) return baseFail("actor is required");

  const ev = boundEvidence(evidence);
  const key = clipId(milestone_key, 256);
  try {
    const dg = await load("developmentGoal");
    const can = dg?.canMarkComplete;
    if (typeof can !== "function") {
      return baseFail("verification gate unavailable", {
        degraded: ["developmentGoal.canMarkComplete unavailable"],
      });
    }
    return await core.withDb(async (client) => {
      const cur = await client.query(
        "SELECT id, status, success_criteria, evidence FROM pm_milestone WHERE project_id=$1 AND milestone_key=$2 LIMIT 1",
        [project_id, key],
      );
      if (!cur.rowCount) return baseFail("milestone not found in project");
      const row = cur.rows[0];
      const criteria = Array.isArray(row.success_criteria) ? row.success_criteria : [];

      if (status === "completed") {
        const missing = [];
        if (!criteria.length) missing.push("success_criteria");
        // Verification must travel WITH the completion transition; previously
        // recorded process output never counts as verification.
        if (!can(ev)) missing.push("verification_evidence");
        if (missing.length) {
          await audit("p26.milestone_complete_rejected", project_id, {
            milestone_key: key, missing, actor: clipId(actor, 120),
          });
          return baseFail("insufficient_evidence", { missing, id: row.id, status: row.status });
        }
      }

      const merged = [...(Array.isArray(row.evidence) ? row.evidence : []), ...ev].slice(0, MAX_HISTORY);
      const upd = await client.query(
        `UPDATE pm_milestone SET status=$2, evidence=$3::jsonb, updated_at=now()
          WHERE id=$1 AND project_id=$4 RETURNING id`,
        [row.id, status, JSON.stringify(merged), project_id],
      );
      await audit("p26.milestone_status", project_id, {
        id: row.id, milestone_key: key, status, actor: clipId(actor, 120),
        evidence_count: Math.min(ev.length, MAX_HISTORY),
      });
      return { ok: true, changed: upd.rowCount > 0, id: row.id, status,
        evidence_count: merged.length, degraded: [], note: MILESTONE_NOTE };
    });
  } catch (e) {
    return degradedFail("milestone status change unavailable", e, { status });
  }
}

/**
 * Evidence-backed progress for one milestone. `status` carries the observed
 * milestone state; `verified_count`/`total` count dev_task rows linked to the
 * milestone's goal that carry explicit verification evidence. `completion` is a
 * bounded enum and is NEVER a percentage or a completion claim.
 */
export async function milestoneProgress({ project_id, milestone_key } = {}) {
  const base = {
    ok: false, project_id: project_id ?? null, milestone_key: milestone_key ?? null,
    status: "unknown", verified_count: 0, total: 0, completion: "unknown",
    reason: "valid project_id required", evidence: [], degraded: [], note: MILESTONE_NOTE,
  };
  if (!validProject(project_id)) return base;
  if (!nonEmpty(milestone_key)) return { ...base, reason: "milestone_key is required" };

  try {
    const dg = await load("developmentGoal");
    const can = dg?.canMarkComplete;
    if (typeof can !== "function") {
      return { ...base, reason: "verification gate unavailable; completion is unknown",
        degraded: ["developmentGoal.canMarkComplete unavailable"] };
    }
    const key = clipId(milestone_key, 256);
    const m = await core.dbQuery(
      `SELECT ${MILESTONE_FIELDS} FROM pm_milestone
        WHERE project_id=$1 AND milestone_key=$2 LIMIT 1`,
      [project_id, key],
    );
    if (!m.rowCount) {
      return { ...base, reason: "milestone not found in project", milestone_key: key };
    }
    const milestone = m.rows[0];
    const status = String(milestone.status ?? "planned");
    const gid = nonEmpty(milestone.goal_id) ? clipId(milestone.goal_id) : "";
    const criteria = Array.isArray(milestone.success_criteria) ? milestone.success_criteria : [];

    if (!gid) {
      return { ok: true, milestone_key: key, status, verified_count: 0, total: 0,
        completion: "not_applicable", reason: "Milestone has no linked goal; task-based verification is not applicable.",
        evidence: [], degraded: [], note: MILESTONE_NOTE };
    }

    const tasks = (await core.dbQuery(
      `SELECT id, status, evidence FROM dev_task
        WHERE project_id=$1 AND goal_id=$2 ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [project_id, gid, MAX_LIMIT],
    )).rows;
    const total = tasks.length;
    const verified = tasks.filter((t) => can(Array.isArray(t.evidence) ? t.evidence : []));
    const verified_count = verified.length;
    const evidence = tasks.slice(0, 20).map((t) => ({
      kind: "dev_task", id: clipId(t.id), status: String(t.status ?? ""),
      verification: can(Array.isArray(t.evidence) ? t.evidence : [])
        ? "explicit_verification_evidence" : "none",
    }));

    let completion;
    let reason;
    if (total === 0) {
      completion = "not_applicable";
      reason = `No dev_task is linked to goal ${gid}; completion cannot be assessed from tasks.`;
    } else if (verified_count < total) {
      completion = "insufficient_evidence";
      reason = `Explicit verification evidence covers ${verified_count} of ${total} linked task(s); completion cannot be established.`;
    } else {
      completion = "insufficient_evidence";
      const criteriaText = criteria.length
        ? "success_criteria are recorded" : "success_criteria are absent";
      reason = `All ${total} linked task(s) carry verification evidence and ${criteriaText}; ` +
        "milestoneProgress never asserts completion (a percentage is never emitted).";
    }
    return { ok: true, milestone_key: key, goal_id: gid, status, verified_count, total,
      completion, reason, evidence, degraded: [], note: MILESTONE_NOTE };
  } catch (e) {
    return { ...base, reason: `authoritative records unavailable: ${short(e?.message || e, 120)}`,
      degraded: [short(e?.message || e, 160)] };
  }
}

export default {
  MILESTONE_STATUSES, COMPLETION,
  recordMilestone, listMilestones, getMilestone, setMilestoneStatus, milestoneProgress,
};
