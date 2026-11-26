// Phase 17.D — Knowledge confidence, verification, conflict detection and freshness.
//
// Design rules (kept deliberately strict):
//   * Verification status is SEPARATE from numeric confidence. Confidence never
//     derives a verification status; only an explicit caller assertion does.
//   * Evidence history is append-only. Repeated sources are deduplicated, but no
//     previously recorded source is ever removed (no destructive SQL).
//   * INFERRED / UNCERTAIN are never auto-promoted to VERIFIED.
//   * All reads/writes are bounded and project-scoped.
import * as core from "./core.js";

export const VERIFICATION = Object.freeze({
  VERIFIED: "verified",
  OBSERVED: "observed",
  INFERRED: "inferred",
  UNCERTAIN: "uncertain",
  CONTRADICTED: "contradicted",
  STALE: "stale",
  SUPERSEDED: "superseded",
});

export const VERIFIED = VERIFICATION.VERIFIED;
export const OBSERVED = VERIFICATION.OBSERVED;
export const INFERRED = VERIFICATION.INFERRED;
export const UNCERTAIN = VERIFICATION.UNCERTAIN;
export const CONTRADICTED = VERIFICATION.CONTRADICTED;
export const STALE = VERIFICATION.STALE;
export const SUPERSEDED = VERIFICATION.SUPERSEDED;
export const VERIFICATION_STATUS = VERIFICATION;

const VALID = new Set(Object.values(VERIFICATION));

// Sorting-only weights. These are NOT confidence values.
const RANK = {
  [VERIFICATION.VERIFIED]: 7,
  [VERIFICATION.OBSERVED]: 6,
  [VERIFICATION.INFERRED]: 5,
  [VERIFICATION.UNCERTAIN]: 4,
  [VERIFICATION.STALE]: 3,
  [VERIFICATION.CONTRADICTED]: 2,
  [VERIFICATION.SUPERSEDED]: 1,
};

export function qualityRank(quality) {
  const v = normalizeVerification(quality);
  return RANK[v] ?? RANK[VERIFICATION.OBSERVED];
}

function normalizeVerification(value) {
  const raw = value && typeof value === "object" ? value.verification : value;
  const v = String(raw ?? "").trim().toLowerCase();
  return VALID.has(v) ? v : VERIFICATION.OBSERVED;
}

function evidenceString(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    try { return JSON.stringify(value, Object.keys(value).sort()); }
    catch { return String(value); }
  }
  return String(value ?? "").trim();
}

// Dedupe by the source string; only plain strings are stored so the column stays
// a simple, comparable list. Empty sources are ignored.
function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const s = evidenceString(entry);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Upsert quality for a subject. Never deletes evidence; merges and dedupes it.
 * Returns { ok, promoted, changed, quality }.
 */
export async function recordQuality({
  project_id,
  subject_type,
  subject_id,
  verification = VERIFICATION.OBSERVED,
  confidence = null,
  evidence_sources = [],
  freshness_at,
} = {}) {
  if (!project_id || !subject_type || !subject_id) {
    throw new Error("project_id, subject_type and subject_id are required");
  }
  const requested = normalizeVerification(verification);
  const incoming = dedupeSources(evidence_sources);
  const freshness = isoDate(freshness_at);

  return core.withDb(async (client) => {
    const prev = await client.query(
      `SELECT id, verification, confidence, evidence_sources, freshness_at
         FROM knowledge_quality
        WHERE project_id=$1 AND subject_type=$2 AND subject_id=$3`,
      [project_id, subject_type, subject_id],
    );
    const existing = prev.rows[0] || null;

    let finalVerification = requested;
    let promoted = false;
    if (existing) {
      const old = normalizeVerification(existing.verification);
      if ([VERIFICATION.INFERRED, VERIFICATION.UNCERTAIN].includes(old)
          && finalVerification === VERIFICATION.VERIFIED) {
        // Explicit rule: an inferred/uncertain claim never becomes VERIFIED here.
        finalVerification = old;
      } else {
        promoted = qualityRank(finalVerification) > qualityRank(old);
      }
    }

    const oldSources = Array.isArray(existing?.evidence_sources) ? existing.evidence_sources : [];
    const merged = dedupeSources([...oldSources, ...incoming]);
    const finalConfidence = (confidence === null || confidence === undefined)
      ? (existing?.confidence ?? null)
      : Number(confidence);
    const finalFreshness = freshness || isoDate(existing?.freshness_at) || new Date().toISOString();

    const r = await client.query(
      `INSERT INTO knowledge_quality
         (project_id, subject_type, subject_id, verification, confidence,
          evidence_sources, freshness_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::real,$6::jsonb,$7::timestamptz,now(),now())
       ON CONFLICT (project_id, subject_type, subject_id) DO UPDATE SET
         verification = EXCLUDED.verification,
         confidence = $5::real,
         evidence_sources = EXCLUDED.evidence_sources,
         freshness_at = $7::timestamptz,
         updated_at = now()
       RETURNING id, project_id, subject_type, subject_id, verification, confidence,
                 evidence_sources, freshness_at, created_at, updated_at`,
      [project_id, subject_type, subject_id, finalVerification, finalConfidence,
        JSON.stringify(merged), finalFreshness],
    );

    const changed = !existing
      || normalizeVerification(existing.verification) !== finalVerification
      || Number(existing.confidence) !== Number(finalConfidence)
      || JSON.stringify(oldSources) !== JSON.stringify(merged)
      || new Date(existing.freshness_at).getTime() !== new Date(finalFreshness).getTime();

    return { ok: true, promoted, changed, quality: r.rows[0] };
  });
}

/** Read quality for a subject. Absent records default to OBSERVED (never guessed). */
export async function getQuality({ project_id, subject_type, subject_id } = {}) {
  const r = await core.dbQuery(
    `SELECT id, project_id, subject_type, subject_id, verification, confidence,
            evidence_sources, freshness_at, created_at, updated_at
       FROM knowledge_quality
      WHERE project_id=$1 AND subject_type=$2 AND subject_id=$3`,
    [project_id, subject_type, subject_id],
  );
  const row = r.rows[0];
  if (row) return { ok: true, default: false, quality: row };
  return {
    ok: true,
    default: true,
    quality: {
      project_id, subject_type, subject_id,
      verification: VERIFICATION.OBSERVED,
      confidence: null,
      evidence_sources: [],
      freshness_at: null,
      default: true,
    },
  };
}

// Only EXPLICIT markers count. Keyword overlap between claims is never a conflict.
const NEGATION_MARKER = /^\s*(contradicts?|negates?|refutes?|opposes?)\s*:/i;
const STALE_MARKER = /^\s*status\s*:\s*(stale|contradicted|outdated)\b/i;

// Check the marker at the start of a string OR inside any string value of an
// evidence object (e.g. { marker: "status:stale" }). Keyword overlap still never
// counts: only these explicit markers do.
function markerReason(entry) {
  const candidates = [];
  if (typeof entry === "string") {
    candidates.push(entry);
  } else if (entry && typeof entry === "object") {
    for (const value of Object.values(entry)) {
      if (typeof value === "string") candidates.push(value);
    }
    candidates.push(evidenceString(entry));
  }
  for (const text of candidates) {
    if (NEGATION_MARKER.test(text)) {
      return `new evidence explicitly negates the stored claim: ${text.slice(0, 160)}`;
    }
    if (STALE_MARKER.test(text)) {
      return `new evidence marks the stored claim as stale/contradicted: ${text.slice(0, 160)}`;
    }
  }
  return null;
}

/**
 * Detect an explicit contradiction. When found, flag the subject CONTRADICTED
 * and append the new evidence to history (never delete). Read-only otherwise.
 */
export async function detectConflict({
  project_id, subject_type, subject_id, new_evidence = [], new_claim,
} = {}) {
  const current = await getQuality({ project_id, subject_type, subject_id });
  const rawEvidence = (Array.isArray(new_evidence) ? new_evidence : [new_evidence])
    .filter((e) => e !== null && e !== undefined);
  const evidence = rawEvidence.map(evidenceString);

  let conflict = false;
  let reason = "";
  for (const e of rawEvidence) {
    const found = markerReason(e);
    if (found) {
      conflict = true;
      reason = found;
      break;
    }
  }
  if (!conflict) {
    return {
      ok: current.ok,
      conflict: false,
      reason: "no explicit contradiction marker in new evidence; keyword overlap alone is not a conflict",
    };
  }

  const stamped = await recordQuality({
    project_id, subject_type, subject_id,
    verification: VERIFICATION.CONTRADICTED,
    evidence_sources: evidence,
  });
  return {
    ok: stamped.ok && current.ok,
    conflict: true,
    reason,
    verification: VERIFICATION.CONTRADICTED,
    quality: stamped.quality,
    new_claim: new_claim ? evidenceString(new_claim).slice(0, 200) : null,
  };
}

/** Bounded, read-only report of stale subjects using freshness_at. */
export async function freshnessReport({ project_id, older_than_days = 30, limit = 50 } = {}) {
  const numDays = Number(older_than_days);
  const days = Number.isFinite(numDays) ? Math.max(0, Math.min(3650, Math.floor(numDays))) : 30;
  const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 200) : 50;
  const r = await core.dbQuery(
    `SELECT id, project_id, subject_type, subject_id, verification, confidence,
            freshness_at, updated_at
       FROM knowledge_quality
      WHERE project_id=$1
        AND freshness_at < now() - ($2::int * interval '1 day')
      ORDER BY freshness_at ASC
      LIMIT $3`,
    [project_id, days, n],
  );
  return {
    ok: true,
    items: r.rows,
    count: r.rows.length,
    older_than_days: days,
    limit: n,
    note: "bounded read-only query; staleness measured against freshness_at",
  };
}
