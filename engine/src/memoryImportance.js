// Phase 20 workstream B — explainable importance and advisory freshness.
//
// Design rules (deliberately strict, and distinct from verification/confidence):
//   * Importance signals explain WHY a memory matters. They NEVER change
//     memory.verified, memory.confidence or memory.importance.
//   * Retrieval frequency never establishes correctness. A frequently retrieved
//     but unverified memory is never promoted to a correctness-bearing tier.
//   * A critical decision is never demoted because it is rarely accessed. The
//     tier is the highest-rank explicit signal, full stop.
//   * Freshness review is ADVISORY and read-only: no memory row is written.
//     Age alone never marks a memory stale/false; only explicit status/evidence
//     can indicate supersession.
//   * Evidence history is append-only (prior values are preserved), all reads
//     and writes are project-scoped and bounded, and `_global` is rejected.
import * as core from "./core.js";

export const IMPORTANCE_SIGNALS = Object.freeze({
  USER_EXPLICIT: "user_explicit",
  VERIFIED_EVIDENCE: "verified_evidence",
  CRITICAL_DECISION: "critical_decision",
  FREQUENT_REUSE: "frequent_reuse",
  RELATIONSHIP_REFERENCE: "relationship_reference",
  ACTIVE_CONSTRAINT: "active_constraint",
  TASK_SPECIFIC: "task_specific",
  REDUNDANT: "redundant",
});

export const IMPORTANCE_TIERS = Object.freeze({
  CRITICAL: "critical",
  IMPORTANT: "important",
  REUSABLE: "reusable",
  TEMPORARY: "temporary",
  LOW: "low",
});

export const FRESHNESS_VERDICTS = Object.freeze({
  CURRENT: "current",
  STALE: "stale",
  NEEDS_REVIEW: "needs_review",
});

const DAY = 86400000;
const GLOBAL_PROJECT_ID = "_global";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE = 100;
const MAX_EVIDENCE_CHARS = 1000;
const MAX_REASON = 2000;
const MAX_ACTION = 200;
const MAX_LIMIT = 200;
const VALID_SIGNALS = new Set(Object.values(IMPORTANCE_SIGNALS));
const VALID_VERDICTS = new Set(Object.values(FRESHNESS_VERDICTS));

// Highest-rank wins. A critical decision outranks everything, so a rare
// critical decision can never be demoted by reuse/task/redundancy signals.
const TIER_RANK = {
  [IMPORTANCE_TIERS.CRITICAL]: 5,
  [IMPORTANCE_TIERS.IMPORTANT]: 4,
  [IMPORTANCE_TIERS.REUSABLE]: 3,
  [IMPORTANCE_TIERS.TEMPORARY]: 2,
  [IMPORTANCE_TIERS.LOW]: 1,
};

// Frequency maps only to "reusable". It is intentionally NOT a correctness,
// verification, critical or important signal.
const SIGNAL_TIER = {
  [IMPORTANCE_SIGNALS.CRITICAL_DECISION]: IMPORTANCE_TIERS.CRITICAL,
  [IMPORTANCE_SIGNALS.USER_EXPLICIT]: IMPORTANCE_TIERS.IMPORTANT,
  [IMPORTANCE_SIGNALS.VERIFIED_EVIDENCE]: IMPORTANCE_TIERS.IMPORTANT,
  [IMPORTANCE_SIGNALS.ACTIVE_CONSTRAINT]: IMPORTANCE_TIERS.IMPORTANT,
  [IMPORTANCE_SIGNALS.FREQUENT_REUSE]: IMPORTANCE_TIERS.REUSABLE,
  [IMPORTANCE_SIGNALS.RELATIONSHIP_REFERENCE]: IMPORTANCE_TIERS.REUSABLE,
  [IMPORTANCE_SIGNALS.TASK_SPECIFIC]: IMPORTANCE_TIERS.TEMPORARY,
  [IMPORTANCE_SIGNALS.REDUNDANT]: IMPORTANCE_TIERS.LOW,
};

// ---------------------------------------------------------------------------
// Validation / normalization helpers (fail closed; no writes on bad input).
// ---------------------------------------------------------------------------
function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function validProjectId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim() !== GLOBAL_PROJECT_ID;
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function boundedLimit(value, fallback = 50) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_LIMIT) : fallback;
}

function boundReason(value) {
  return String(value ?? "").slice(0, MAX_REASON);
}

function normalizeEvidence(value) {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return list.slice(0, MAX_EVIDENCE).map((entry) => {
    if (typeof entry === "string") return entry.slice(0, MAX_EVIDENCE_CHARS);
    if (entry && typeof entry === "object") {
      try { return JSON.parse(JSON.stringify(entry)); }
      catch { return String(entry).slice(0, MAX_EVIDENCE_CHARS); }
    }
    return String(entry).slice(0, MAX_EVIDENCE_CHARS);
  });
}

function evidenceKey(entry) {
  return typeof entry === "string" ? `s:${entry}` : `j:${JSON.stringify(entry)}`;
}

function dedupeEvidence(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const key = evidenceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.slice(0, MAX_EVIDENCE);
}

// Both the stored {current, history} object and legacy plain arrays are accepted.
function evidenceValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const current = Array.isArray(value.current) ? value.current : [];
    const history = Array.isArray(value.history) ? value.history : [];
    return [...history, ...current];
  }
  return [];
}

function combineReasons(oldReason, newReason) {
  const parts = String(oldReason || "").split("|").map((s) => s.trim()).filter(Boolean);
  const added = String(newReason || "").trim();
  if (added && !parts.includes(added)) parts.push(added);
  return parts.join(" | ").slice(0, MAX_REASON);
}

async function scopedMemory(memory_id, project_id, fields) {
  const r = await core.dbQuery(
    `SELECT ${fields} FROM memory WHERE id=$1 AND project_id=$2`,
    [memory_id, project_id],
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Importance signals — persist WHY a memory matters, without touching the
// verification/confidence/importance columns on `memory`.
// ---------------------------------------------------------------------------

/**
 * Upsert an importance signal on (memory_id, signal_type). Never deletes and
 * never rewrites a prior evidence value: all previously stored values are
 * appended to the evidence history, reasons are kept, and weight is clamped.
 * Returns { ok, id, duplicate? } or { ok:false, reason }.
 */
export async function recordSignal({
  memory_id,
  project_id,
  signal_type,
  weight = 0.5,
  reason = "",
  evidence = [],
} = {}) {
  if (!validUuid(memory_id)) return { ok: false, reason: "invalid_memory_id" };
  if (!validProjectId(project_id)) return { ok: false, reason: "invalid_project_id" };
  if (!VALID_SIGNALS.has(signal_type)) return { ok: false, reason: "invalid_signal_type" };

  const w = clamp01(weight);
  const incomingReason = boundReason(reason);
  const incomingEvidence = normalizeEvidence(evidence);

  return core.withDb(async (client) => {
    const scope = await client.query(
      "SELECT 1 FROM memory WHERE id=$1 AND project_id=$2",
      [memory_id, project_id],
    );
    if (!scope.rowCount) return { ok: false, reason: "memory_not_found_in_project" };

    const prev = await client.query(
      "SELECT id, reason, evidence FROM memory_importance_signal WHERE memory_id=$1 AND signal_type=$2",
      [memory_id, signal_type],
    );

    if (!prev.rowCount) {
      const ins = await client.query(
        `INSERT INTO memory_importance_signal
           (memory_id, project_id, signal_type, weight, reason, evidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())
         RETURNING id`,
        [memory_id, project_id, signal_type, w, incomingReason,
          JSON.stringify({ current: incomingEvidence, history: [] })],
      );
      return { ok: true, id: ins.rows[0].id, duplicate: false };
    }

    // Append-only history: every prior value (history + previous current) is
    // preserved in `history`; the freshly supplied values become `current`.
    const old = prev.rows[0];
    const priorValues = dedupeEvidence(evidenceValues(old.evidence));
    const storedEvidence = { current: incomingEvidence, history: priorValues };
    const mergedReason = combineReasons(old.reason, incomingReason);

    const upd = await client.query(
      `UPDATE memory_importance_signal SET weight=$3, reason=$4, evidence=$5::jsonb
        WHERE id=$1 AND memory_id=$2 AND project_id=$6`,
      [old.id, memory_id, w, mergedReason, JSON.stringify(storedEvidence), project_id],
    );
    if (!upd.rowCount) return { ok: false, reason: "memory_not_found_in_project" };
    return { ok: true, id: old.id, duplicate: true };
  });
}

/**
 * Pure proposed tier + explanation over an explicit signal list. No DB access,
 * no writes. Retrieval frequency is capped at "reusable" and can never produce
 * a verification or correctness claim.
 */
export function classifyImportance({ memory_id = null, project_id = null, signals = [] } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  let tier = null;
  const contributions = [];

  for (const item of list) {
    const type = typeof item === "string" ? item : item && item.signal_type;
    const mapped = SIGNAL_TIER[type];
    if (!mapped) continue;
    const weight = typeof item === "object" && item !== null ? clamp01(item.weight) : null;
    contributions.push(weight === null ? `${type}->${mapped}` : `${type}->${mapped}(w=${weight})`);
    if (tier === null || TIER_RANK[mapped] > TIER_RANK[tier]) tier = mapped;
  }

  const finalTier = tier || IMPORTANCE_TIERS.LOW;
  const explanation = contributions.length === 0
    ? "No explicit importance signals recorded; default tier is low (a provisional explanation, not a verdict on accuracy)."
    : `Tier derived deterministically from ${contributions.length} explicit signal(s): ${contributions.join(", ")}. ` +
      "The highest-rank signal wins, so a critical decision is never demoted by low access frequency, and frequent retrieval alone never raises a memory to a correctness-bearing tier.";

  return {
    ok: true,
    memory_id,
    project_id,
    tier: finalTier,
    explanation,
    signals: list.map((item) => (typeof item === "string" ? { signal_type: item } : item)),
    note: "Pure classification; no writes. Importance is explainability metadata, not a truth or verification claim. Retrieval frequency never establishes correctness.",
    changes_applied: 0,
  };
}

/** Explain a stored memory's importance from its recorded signals. Read-only. */
export async function explainImportance({ memory_id, project_id } = {}) {
  if (!validUuid(memory_id)) return { ok: false, reason: "invalid_memory_id", signals: [] };
  if (!validProjectId(project_id)) return { ok: false, reason: "invalid_project_id", signals: [] };

  const mem = await scopedMemory(
    memory_id,
    project_id,
    "id, project_id, importance, verified, confidence, retrieved_count, category, lifecycle, updated_at",
  );
  if (!mem) return { ok: false, reason: "memory_not_found_in_project", signals: [] };

  const rows = (await core.dbQuery(
    `SELECT id, memory_id, signal_type, weight, reason, evidence, created_at
       FROM memory_importance_signal
      WHERE memory_id=$1 AND project_id=$2
      ORDER BY created_at DESC, id DESC`,
    [memory_id, project_id],
  )).rows;

  const classified = classifyImportance({ memory_id, project_id, signals: rows });
  return {
    ok: true,
    memory_id,
    project_id,
    importance: Number(mem.importance),
    verified: !!mem.verified,
    confidence: Number(mem.confidence),
    retrieved_count: Number(mem.retrieved_count || 0),
    tier: classified.tier,
    signals: rows,
    explanation: classified.explanation,
    note: "Explainable importance from explicit signals only. Retrieval frequency never establishes correctness; verification and confidence are unchanged by this report.",
    changes_applied: 0,
  };
}

// ---------------------------------------------------------------------------
// Advisory freshness — deterministic policy + read-only review.
// ---------------------------------------------------------------------------

/** Deterministic freshness policy by category. Decisions/constraints are long-lived; config/dependencies are short-lived. */
export function freshnessPolicy({ category = "knowledge" } = {}) {
  const c = typeof category === "string" && category.trim() ? category.trim().toLowerCase() : "knowledge";
  const policies = {
    decision: { max_age_days: 365, note: "Decisions are long-lived; age alone never invalidates them." },
    constraint: { max_age_days: 365, note: "Active constraints are long-lived; only explicit supersession changes them." },
    knowledge: { max_age_days: 180, note: "General knowledge has a moderate review horizon; age is informational only." },
    config: { max_age_days: 30, note: "Configuration drifts quickly; shorter review horizon (advisory only)." },
    configuration: { max_age_days: 30, note: "Configuration drifts quickly; shorter review horizon (advisory only)." },
    dependency: { max_age_days: 30, note: "Dependencies change often; shorter review horizon (advisory only)." },
  };
  const p = policies[c] || policies.knowledge;
  return { category: c, max_age_days: p.max_age_days, note: p.note };
}

const STALE_MARKER = /\b(status\s*:\s*(stale|outdated|superseded|contradicted)|stale|outdated|superseded|deprecated|replaced\s+by|no\s+longer\s+valid)\b/i;
const REVIEW_MARKER = /\b(needs[_ -]?review|review|verify|uncertain|maybe[_ -]?stale|check[_ -]?freshness)\b/i;

function markerText(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const strings = Object.values(entry).filter((v) => typeof v === "string");
    return strings.join(" ");
  }
  return String(entry ?? "");
}

/**
 * Advisory freshness review. NO writes. Age alone never means stale/false:
 * only explicit lifecycle status, a passed valid_until, or explicit evidence
 * markers can indicate supersession.
 */
export async function reviewFreshness({ memory_id, project_id, now, evidence = [] } = {}) {
  if (!validUuid(memory_id)) return { ok: false, reason: "invalid_memory_id", evidence: [] };
  if (!validProjectId(project_id)) return { ok: false, reason: "invalid_project_id", evidence: [] };

  const mem = await scopedMemory(
    memory_id,
    project_id,
    "id, project_id, category, lifecycle, valid_until, updated_at, verified, confidence",
  );
  if (!mem) return { ok: false, reason: "memory_not_found_in_project", evidence: [] };

  const ref = now === undefined || now === null ? new Date() : new Date(now);
  if (Number.isNaN(ref.getTime())) return { ok: false, reason: "invalid_now", evidence: [] };

  const ev = normalizeEvidence(evidence);
  const texts = ev.map(markerText);
  const policy = freshnessPolicy({ category: mem.category || "knowledge" });
  const ageDays = (ref.getTime() - new Date(mem.updated_at).getTime()) / DAY;
  const lifecycle = String(mem.lifecycle || "").toUpperCase();
  const expired = !!mem.valid_until && new Date(mem.valid_until).getTime() <= ref.getTime();

  let verdict = FRESHNESS_VERDICTS.CURRENT;
  let reason = "";
  let suggested_action = "none";

  if (["OUTDATED", "ARCHIVED", "REJECTED"].includes(lifecycle)) {
    verdict = FRESHNESS_VERDICTS.STALE;
    reason = `Explicit lifecycle status '${lifecycle}' marks the memory as no longer current.`;
    suggested_action = "archive_or_replace";
  } else if (expired) {
    verdict = FRESHNESS_VERDICTS.STALE;
    reason = `Explicit valid_until (${new Date(mem.valid_until).toISOString()}) has passed; this is a stated expiry, not an age inference.`;
    suggested_action = "replace_or_extend";
  } else if (lifecycle === "DISPUTED") {
    verdict = FRESHNESS_VERDICTS.NEEDS_REVIEW;
    reason = "Lifecycle 'DISPUTED' requires human review; the memory is not auto-invalidated.";
    suggested_action = "human_review";
  } else {
    const staleHit = texts.find((t) => STALE_MARKER.test(t));
    const reviewHit = texts.find((t) => REVIEW_MARKER.test(t));
    if (staleHit) {
      verdict = FRESHNESS_VERDICTS.STALE;
      reason = `New evidence explicitly indicates staleness: ${staleHit.slice(0, 160)}`;
      suggested_action = "verify_and_update";
    } else if (reviewHit) {
      verdict = FRESHNESS_VERDICTS.NEEDS_REVIEW;
      reason = `New evidence requests a freshness review: ${reviewHit.slice(0, 160)}`;
      suggested_action = "human_review";
    } else {
      const overPolicy = ageDays > policy.max_age_days;
      verdict = FRESHNESS_VERDICTS.CURRENT;
      reason = `No explicit staleness evidence. Lifecycle '${lifecycle || "unspecified"}', valid_until '${mem.valid_until || "none"}'. ` +
        `Age ~${Math.max(0, Math.round(ageDays))}d is ${overPolicy ? "past" : "within"} the ${policy.category} policy horizon of ${policy.max_age_days}d, ` +
        "but age alone never marks a memory stale or false; a recheck is merely optional.";
      suggested_action = overPolicy ? "optional_recheck" : "none";
    }
  }

  return {
    ok: true,
    memory_id,
    project_id,
    verdict,
    reason,
    explanation: reason,
    suggested_action,
    age_days: Number(Math.max(0, ageDays).toFixed(2)),
    policy,
    evidence: ev,
    changes_applied: 0,
    note: "Advisory only. No memory row is written and verification/confidence are untouched; only explicit status or evidence can indicate supersession.",
  };
}

/** Persist an advisory freshness review. Project-scoped and bounded; never touches memory. */
export async function recordFreshnessReview({
  memory_id,
  project_id,
  verdict,
  reason = "",
  evidence = [],
  suggested_action = "none",
} = {}) {
  if (!validUuid(memory_id)) return { ok: false, reason: "invalid_memory_id" };
  if (!validProjectId(project_id)) return { ok: false, reason: "invalid_project_id" };
  if (!VALID_VERDICTS.has(verdict)) return { ok: false, reason: "invalid_verdict" };

  const boundedReason = boundReason(reason);
  const ev = normalizeEvidence(evidence);
  const action = boundReason(suggested_action).slice(0, MAX_ACTION) || "none";

  return core.withDb(async (client) => {
    const scope = await client.query(
      "SELECT 1 FROM memory WHERE id=$1 AND project_id=$2",
      [memory_id, project_id],
    );
    if (!scope.rowCount) return { ok: false, reason: "memory_not_found_in_project" };

    const ins = await client.query(
      `INSERT INTO memory_freshness_review
         (memory_id, project_id, verdict, reason, evidence, suggested_action, reviewed_at, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,now(),now())
       RETURNING id, reviewed_at`,
      [memory_id, project_id, verdict, boundedReason, JSON.stringify(ev), action],
    );
    return { ok: true, id: ins.rows[0].id, reviewed_at: ins.rows[0].reviewed_at };
  });
}

/** Bounded, project-scoped, read-only list of freshness reviews. */
export async function getFreshnessReviews({ project_id, memory_id, limit = 50 } = {}) {
  if (!validProjectId(project_id)) {
    return { ok: false, reason: "invalid_project_id", items: [], count: 0 };
  }
  const n = boundedLimit(limit);
  const params = [project_id];
  let where = "project_id=$1";
  if (memory_id !== undefined && memory_id !== null) {
    if (!validUuid(memory_id)) {
      return { ok: false, reason: "invalid_memory_id", items: [], count: 0 };
    }
    where += " AND memory_id=$2";
    params.push(memory_id);
  }
  params.push(n);
  const r = await core.dbQuery(
    `SELECT id, memory_id, project_id, verdict, reason, evidence, suggested_action, reviewed_at, created_at
       FROM memory_freshness_review
      WHERE ${where}
      ORDER BY reviewed_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    ok: true,
    project_id,
    items: r.rows,
    count: r.rows.length,
    limit: n,
    note: "Project-scoped, bounded, read-only advisory reviews.",
  };
}

/** Bounded, project-scoped, read-only list of importance signals. */
export async function getSignals({ project_id, memory_id, limit = 50 } = {}) {
  if (!validProjectId(project_id)) {
    return { ok: false, reason: "invalid_project_id", items: [], count: 0 };
  }
  const n = boundedLimit(limit);
  const params = [project_id];
  let where = "project_id=$1";
  if (memory_id !== undefined && memory_id !== null) {
    if (!validUuid(memory_id)) {
      return { ok: false, reason: "invalid_memory_id", items: [], count: 0 };
    }
    where += " AND memory_id=$2";
    params.push(memory_id);
  }
  params.push(n);
  const r = await core.dbQuery(
    `SELECT id, memory_id, project_id, signal_type, weight, reason, evidence, created_at
       FROM memory_importance_signal
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    ok: true,
    project_id,
    items: r.rows,
    count: r.rows.length,
    limit: n,
    note: "Project-scoped, bounded, read-only importance signals.",
  };
}
