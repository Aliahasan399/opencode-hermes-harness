// Phase 26 §2.3: evidence-backed progress snapshots and deterministic completion
// classification. Additive-only layer over `pm_progress_snapshot` (migration 024)
// and `dev_task` (migration 017). LEVEL 1 and HARNESS_SEMANTIC_LLM=0 unchanged.
//
// Invariants (fail closed):
//   - every operation is project-scoped; empty / "_global" project ids are rejected;
//   - reads are bounded; writes are idempotent by UNIQUE(project_id, snapshot_key)
//     and never overwrite an existing row;
//   - a 'verified' snapshot requires explicit verification evidence as judged by
//     developmentGoal.canMarkComplete -- an agent claim is never sufficient;
//   - completion is reported as an enum plus a reason and counts. A completion
//     percentage is NEVER computed or emitted;
//   - content is redacted and length-bounded, audits are content-free, and a
//     missing sibling module or an unavailable DB degrades instead of throwing.
import crypto from "node:crypto";
import * as core from "./core.js";

export const SNAPSHOT_STATUSES = Object.freeze([
  "complete", "verified", "partial", "in_progress", "blocked", "unverified",
]);
export const COMPLETION = Object.freeze(["unknown", "insufficient_evidence", "not_applicable"]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const UNFINISHED = new Set(["not_started", "in_progress", "blocked", "failed"]);

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const validProject = (p) => nonEmpty(p) && p !== "_global";
const short = (v, n = 220) => core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n);
const clampLimit = (limit, fallback = DEFAULT_LIMIT, cap = MAX_LIMIT) =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
const clipId = (v, n = 512) => String(v ?? "").slice(0, n);

/** Recursively redact strings and cap structure (references/ids survive intact). */
function redactValue(v, depth = 0) {
  if (typeof v === "string") return short(v, 2000);
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort().slice(0, 30)) out[k.slice(0, 60)] = redactValue(v[k], depth + 1);
    return out;
  }
  return v;
}
function boundEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.slice(0, 200).map((e) => {
    if (typeof e === "string") return short(e, 2000);
    if (e && typeof e === "object") return redactValue(e);
    return e;
  });
}
function boundRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, 100).map((r) => redactValue(r));
}
function boundSummary(summary) {
  if (summary && typeof summary === "object" && !Array.isArray(summary)) return redactValue(summary);
  if (summary === undefined || summary === null) return {};
  return { text: short(summary, 1000) };
}
async function audit(action, project_id, detail) {
  try {
    await core.audit(action, project_id, {
      ...detail, snapshot_key: detail?.snapshot_key ? clipId(detail.snapshot_key, 256) : null,
    });
  } catch { /* auditing is best-effort and never blocks a gate */ }
}

// ---------------------------------------------------------------------------
// 1. Record (idempotent, verification-gated)
// ---------------------------------------------------------------------------

/**
 * Append a progress snapshot. Returns the existing row's id (duplicate:true)
 * when (project_id, snapshot_key) already exists; no row is ever overwritten.
 */
export async function recordSnapshot({
  project_id, snapshot_key, goal_id = "", milestone_id = "", task_id = "", session_id = "",
  status = "partial", evidence = [], summary = {}, source_refs = [],
} = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, id: null, duplicate: false, reason, ...extra });
  if (!validProject(project_id)) return fail("valid project_id required");
  if (!nonEmpty(snapshot_key)) return fail("snapshot_key is required");

  const st = status === undefined || status === null ? "partial" : String(status);
  if (!SNAPSHOT_STATUSES.includes(st)) return fail("invalid status");

  const dg = await load("developmentGoal");
  const can = dg?.canMarkComplete;
  const ev = boundEvidence(evidence);
  const degraded = [];
  if (typeof can !== "function") degraded.push("developmentGoal.canMarkComplete unavailable");

  // 'verified' is a strict gate: no explicit, successful verification evidence
  // means the claim is rejected before any database access.
  if (st === "verified" && (typeof can !== "function" || !can(ev))) {
    return fail("insufficient_evidence", { degraded });
  }

  const key = clipId(snapshot_key, 256);
  const refs = boundRefs(source_refs);
  const sum = boundSummary(summary);

  try {
    return await core.withDb(async (client) => {
      const dup = await client.query(
        "SELECT id FROM pm_progress_snapshot WHERE project_id=$1 AND snapshot_key=$2 LIMIT 1",
        [project_id, key],
      );
      if (dup.rowCount) {
        await audit("p26.progress.duplicate", project_id, { snapshot_key: key });
        return { ok: true, id: dup.rows[0].id, duplicate: true, degraded };
      }
      // Snapshot ids are bigserial and assigned by the database.
      const r = await client.query(
        `INSERT INTO pm_progress_snapshot
           (project_id, snapshot_key, goal_id, milestone_id, task_id, session_id,
            status, evidence, summary, source_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
         RETURNING id`,
        [project_id, key, clipId(goal_id), clipId(milestone_id), clipId(task_id), clipId(session_id),
          st, JSON.stringify(ev), JSON.stringify(sum), JSON.stringify(refs)],
      );
      await audit("p26.progress.record", project_id, { snapshot_key: key, status: st, evidence_count: ev.length });
      return { ok: true, id: r.rows[0].id, duplicate: false, degraded };
    });
  } catch (e) {
    return fail(`snapshot recording failed: ${short(e?.message || e, 120)}`, { degraded });
  }
}

// ---------------------------------------------------------------------------
// 2. Bounded, project-scoped reads
// ---------------------------------------------------------------------------

async function listSnapshots({ project_id, goal_id, milestone_id, task_id, limit, direction } = {}) {
  const n = clampLimit(limit);
  const empty = { ok: false, snapshots: [], items: [], count: 0, limit: n, reason: "valid project_id required" };
  if (!validProject(project_id)) return empty;
  const order = direction === "ASC" ? "ASC" : "DESC"; // constant, never user SQL
  try {
    const r = await core.dbQuery(
      `SELECT id, project_id, snapshot_key, goal_id, milestone_id, task_id, session_id,
              status, evidence, summary, source_refs, created_at
         FROM pm_progress_snapshot
        WHERE project_id=$1
          AND ($2::text IS NULL OR goal_id=$2)
          AND ($3::text IS NULL OR milestone_id=$3)
          AND ($4::text IS NULL OR task_id=$4)
        ORDER BY created_at ${order}, id ${order} LIMIT $5`,
      [project_id, nonEmpty(goal_id) ? clipId(goal_id) : null,
        nonEmpty(milestone_id) ? clipId(milestone_id) : null,
        nonEmpty(task_id) ? clipId(task_id) : null, n],
    );
    return { ok: true, snapshots: r.rows, items: r.rows, count: r.rows.length, limit: n };
  } catch (e) {
    return { ...empty, reason: `snapshot listing failed: ${short(e?.message || e, 120)}` };
  }
}

/** Most-recent-first progress view. */
export async function getProgress(args = {}) {
  return listSnapshots({ ...args, direction: "DESC" });
}

/** Oldest-first append-only history for the same project scope. */
export async function progressHistory(args = {}) {
  return listSnapshots({ ...args, direction: "ASC" });
}

// ---------------------------------------------------------------------------
// 3. Completion classification (no percentages, no invented completion)
// ---------------------------------------------------------------------------

/**
 * Classify completion from authoritative records only. `completion` is one of:
 *   unknown               - authoritative records could not be read;
 *   not_applicable        - there is no in-scope work to assess;
 *   insufficient_evidence - work exists but verified evidence is incomplete.
 * `status` carries the observed state; counts carry the evidence summary. There
 * is deliberately no `percentage`, `percent` or `progress_pct` field.
 */
export async function computeProgress({ project_id, goal_id, milestone_id, limit } = {}) {
  const degraded = [];
  const base = {
    ok: false, project_id: project_id ?? null, status: "unknown", verified_count: 0, total: 0,
    completion: "unknown", reason: "valid project_id required", evidence: [], degraded,
    note: "No completion percentage is computed or emitted. Insufficient evidence is never treated as success.",
  };
  if (!validProject(project_id)) return base;

  const n = clampLimit(limit, 100, 200);
  try {
    const dg = await load("developmentGoal");
    const can = dg?.canMarkComplete;
    if (typeof can !== "function") {
      degraded.push("developmentGoal.canMarkComplete unavailable");
      return { ...base, reason: "verification gate unavailable; completion is unknown" };
    }

    const snapshots = (await core.dbQuery(
      `SELECT id, snapshot_key, goal_id, milestone_id, task_id, status, evidence, created_at
         FROM pm_progress_snapshot
        WHERE project_id=$1
          AND ($2::text IS NULL OR goal_id=$2)
          AND ($3::text IS NULL OR milestone_id=$3)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [project_id, nonEmpty(goal_id) ? clipId(goal_id) : null,
        nonEmpty(milestone_id) ? clipId(milestone_id) : null, n],
    )).rows;

    let tasks = (await core.dbQuery(
      `SELECT id, task_key, goal_id, status, evidence, updated_at
         FROM dev_task
        WHERE project_id=$1 AND ($2::text IS NULL OR goal_id=$2)
        ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [project_id, nonEmpty(goal_id) ? clipId(goal_id) : null, n],
    )).rows;

    // A milestone scope is expressed through progress snapshots (dev_task has no
    // milestone column). Restrict tasks to those referenced by in-scope snapshots.
    if (nonEmpty(milestone_id)) {
      const referenced = new Set(snapshots.map((s) => clipId(s.task_id)).filter(nonEmpty));
      if (referenced.size) tasks = tasks.filter((t) => referenced.has(clipId(t.id)));
      else if (!nonEmpty(goal_id)) tasks = [];
    }
    const seen = new Set();
    tasks = tasks.filter((t) => !seen.has(clipId(t.id)) && seen.add(clipId(t.id))).slice(0, n);

    let milestone = null;
    if (nonEmpty(milestone_id)) {
      const m = await core.dbQuery(
        "SELECT id, success_criteria, status FROM pm_milestone WHERE project_id=$1 AND id=$2 LIMIT 1",
        [project_id, clipId(milestone_id)],
      );
      milestone = m.rows[0] || null;
    }

    // Prefer tasks as units of work; snapshots are the fallback when a scope has
    // recorded progress but no concrete tasks.
    const units = tasks.length
      ? tasks.map((t) => ({ kind: "dev_task", id: clipId(t.id), status: String(t.status ?? ""),
        verified: can(Array.isArray(t.evidence) ? t.evidence : []), evidence: t.evidence }))
      : snapshots.map((s) => ({ kind: "pm_progress_snapshot", id: s.id,
        status: String(s.status ?? ""),
        verified: ["verified", "complete"].includes(String(s.status)) &&
          can(Array.isArray(s.evidence) ? s.evidence : []), evidence: s.evidence }));

    const total = units.length;
    const verified_count = units.filter((u) => u.verified).length;
    const evidence = units.slice(0, 20).map((u) => ({
      kind: u.kind, id: u.id, status: u.status,
      verification: u.verified ? "explicit_verification_evidence" : "none",
    }));

    let status;
    if (total === 0) status = "not_applicable";
    else if (verified_count === total) status = "verified";
    else if (units.some((u) => u.status === "blocked")) status = "blocked";
    else if (units.some((u) => UNFINISHED.has(u.status))) status = "in_progress";
    else if (verified_count > 0) status = "partial";
    else status = "unverified";

    let completion;
    let reason;
    if (total === 0) {
      completion = "not_applicable";
      reason = "No in-scope tasks or progress snapshots exist; completion is not applicable.";
    } else if (verified_count === 0) {
      completion = "insufficient_evidence";
      reason = `None of the ${total} in-scope unit(s) carries explicit verification evidence; completion cannot be established.`;
    } else if (verified_count < total) {
      completion = "insufficient_evidence";
      reason = `Explicit verification evidence covers ${verified_count} of ${total} in-scope unit(s); completion cannot be established.`;
    } else {
      completion = "insufficient_evidence";
      const criteria = milestone ? (Array.isArray(milestone.success_criteria) && milestone.success_criteria.length
        ? "milestone success criteria are recorded" : "milestone success criteria are absent")
        : "no milestone record was scoped";
      reason = `All ${total} in-scope unit(s) carry verification evidence, but ${criteria}; computeProgress never asserts project completion.`;
    }

    return { ok: true, project_id, status, verified_count, total, completion, reason, evidence, degraded,
      note: "Counts and references only. No percentage, no runtime proof and no completion claim." };
  } catch (e) {
    return { ...base, reason: `authoritative records unavailable: ${short(e?.message || e, 120)}` };
  }
}

export default { SNAPSHOT_STATUSES, COMPLETION, recordSnapshot, getProgress, progressHistory, computeProgress };
