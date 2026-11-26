// Phase 21 workstream B — learning intelligence.
//
// Outcome analysis, explainable confidence and evidence-backed pattern
// recognition over the EXISTING pattern / pattern_evidence tables.
//
// Design rules (deliberately strict, consistent with knowledgeQuality.js and
// patterns-v2.js):
//   * Verification is NEVER derived from an AI explanation. Only explicit
//     verification markers (test_pass / verification_result / tool_result, ...)
//     with a determinate result can set verified=true.
//   * Confidence is deterministic and explainable. Repeated *unverified*
//     claims are capped (never cross 0.5); contradictions reduce confidence;
//     independent supports are counted once (deduped by id).
//   * Patterns are project-scoped, idempotent and bounded. Supersession is
//     non-destructive: the old row keeps its history with status='superseded'.
//   * No LLM, no network. patterns-v2.tokens/clusterKey are reused when present
//     via dynamic import, with a deterministic local fallback.
import crypto from "node:crypto";
import * as core from "./core.js";

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

const SUCCESS_WORDS = new Set([
  "true", "pass", "passed", "success", "succeeded", "successful", "green",
  "ok", "fixed", "resolved", "complete", "completed",
]);
const FAILURE_WORDS = new Set([
  "false", "fail", "failed", "failure", "red", "error", "crash", "crashed",
  "regression", "exception", "blocked",
]);

// The explicit marker vocabulary that is allowed to establish verification.
const VERIFICATION_MARKERS = new Set([
  "test_pass", "test_result", "test_success", "test_suite", "tests",
  "verification_result", "verification", "verified_outcome",
  "tool_result", "tool_success", "build_success", "build_result",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === "string" && UUID_RE.test(v.trim());
const finite = (n, fallback) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
const clamp01 = (n) => Math.max(0, Math.min(1, finite(n, 0.5)));
const round4 = (n) => Math.round(finite(n, 0) * 10000) / 10000;

function clampLimit(limit, fallback, max) {
  const n = Number.isInteger(limit) ? limit : fallback;
  return Math.max(0, Math.min(n, max));
}

function wordOf(value) {
  return String(value ?? "").trim().toLowerCase().split(/[^a-z]+/)[0] || "";
}

function stableString(value) {
  if (value && typeof value === "object") {
    try { return JSON.stringify(value, Object.keys(value).sort()); }
    catch { return String(value); }
  }
  return String(value);
}

function keyOf(item) {
  if (item && typeof item === "object" && item.id != null) return `id:${String(item.id)}`;
  return `val:${stableString(item)}`;
}

function uniqueBy(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || item === undefined) continue;
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function union(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function mergeEvidence(prev, incoming, cap = 200) {
  const seen = new Set();
  const out = [];
  for (const e of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

// ---- explicit evidence marker parsing (shared by analyzeOutcome + recalc) --

function markerOf(entry) {
  if (typeof entry === "string") {
    const m = entry.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
    return m ? m[1].toLowerCase() : "";
  }
  if (entry && typeof entry === "object") {
    for (const k of ["marker", "type", "kind", "metric", "name", "source", "signal"]) {
      const v = entry[k];
      if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
    }
    // Also accept the marker as the key itself: { test_pass: true }.
    for (const k of Object.keys(entry)) {
      const lower = k.toLowerCase();
      if (VERIFICATION_MARKERS.has(lower)) return lower;
    }
  }
  return "";
}

function resultOf(entry) {
  if (entry && typeof entry === "object") {
    if (entry.success === true || entry.passed === true || entry.ok === true) return "success";
    if (entry.success === false || entry.passed === false || entry.ok === false || entry.is_error === true) return "failure";
    for (const k of ["exit_code", "exit"]) {
      const raw = entry[k];
      if (raw !== undefined && raw !== null && raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) return n === 0 ? "success" : "failure";
      }
    }
    for (const k of ["value", "result", "status", "outcome"]) {
      const raw = entry[k];
      if (raw !== undefined && raw !== null) {
        const w = wordOf(raw);
        if (SUCCESS_WORDS.has(w)) return "success";
        if (FAILURE_WORDS.has(w)) return "failure";
      }
    }
    return null;
  }
  if (typeof entry === "string") {
    const em = entry.match(/exit\s*[:=]\s*(-?\d+)/i);
    if (em) return Number(em[1]) === 0 ? "success" : "failure";
    const after = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : entry;
    const w = wordOf(after);
    if (SUCCESS_WORDS.has(w)) return "success";
    if (FAILURE_WORDS.has(w)) return "failure";
    const lower = entry.toLowerCase();
    if (/\b(fail|failed|failure|error|crash|regression|exception)\b/.test(lower)) return "failure";
    if (/\b(pass|passed|success|succeeded|green|fixed|resolved)\b/.test(lower)) return "success";
  }
  return null;
}

function explicitSignals(evidence) {
  const signals = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const marker = markerOf(item);
    if (!marker || !VERIFICATION_MARKERS.has(marker)) continue;
    const result = resultOf(item);
    if (result) signals.push({ marker, result });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// 1. Outcome analysis
// ---------------------------------------------------------------------------

/**
 * Derive an outcome from evidence. Only explicit verification markers with a
 * determinate result can set verified=true; an AI explanation never does.
 */
export function analyzeOutcome(input = {}) {
  const { experience = {}, evidence = [] } = input && typeof input === "object" ? input : {};
  const exp = experience && typeof experience === "object" ? experience : {};
  const expEvidence = Array.isArray(exp.evidence) ? exp.evidence : [];
  const argEvidence = Array.isArray(evidence) ? evidence : [];
  const all = [...expEvidence, ...argEvidence];

  const signals = explicitSignals(all);
  if (signals.length) {
    const failed = signals.some((s) => s.result === "failure");
    const outcome = failed ? "failure" : "success";
    const markers = [...new Set(signals.map((s) => s.marker))];
    return {
      ok: true,
      outcome,
      verified: true,
      reason: `explicit verification marker(s) [${markers.join(", ")}] with a determinate result; outcome derived from evidence, not from explanation`,
    };
  }

  // No explicit evidence. A declared outcome may be reported, but is NOT verified.
  const declared = wordOf(exp.outcome ?? exp.result ?? exp.status);
  if (SUCCESS_WORDS.has(declared)) {
    return { ok: true, outcome: "success", verified: false,
      reason: "outcome declared in experience, but no explicit verification evidence exists; not verified" };
  }
  if (FAILURE_WORDS.has(declared)) {
    return { ok: true, outcome: "failure", verified: false,
      reason: "outcome declared in experience, but no explicit verification evidence exists; not verified" };
  }
  return { ok: true, outcome: "uncertain", verified: false,
    reason: "no explicit verification marker and no determinate outcome; an AI explanation alone cannot verify a result" };
}

// ---------------------------------------------------------------------------
// 2. Explainable confidence
// ---------------------------------------------------------------------------

/**
 * Deterministic, documented confidence calculation.
 *
 * Weights:
 *   base by verification: verified .70 | observed .45 | inferred .30 |
 *                         uncertain .15 | contradicted/stale .10 | superseded .05
 *   independent supports: +.10 each, capped +.30, scaled by evidence_quality
 *   contradictions:       -.20 each, capped -.60
 *   occurrences bonus:    +.02 per extra occurrence, capped +.10, ONLY when verified
 *   recency adjustment:   +.03 (0 days) .. -.03 (>=30 days)
 *   unverified cap:       confidence never exceeds 0.50 without verification
 *
 * Supports/contradictions are deduped by their `id` (or stable value), so
 * repeated reporting of the same source is counted once.
 */
export function calculateConfidence(input = {}) {
  const {
    supports = [], contradictions = [], verification = "observed",
    recency_days = 0, occurrences = 1, evidence_quality = 0.5,
  } = input && typeof input === "object" ? input : {};
  const BASE = {
    verified: 0.70, confirmed: 0.70, observed: 0.45, inferred: 0.30,
    uncertain: 0.15, contradicted: 0.10, stale: 0.10, superseded: 0.05,
  };
  const v = String(verification ?? "observed").trim().toLowerCase();
  const base = BASE[v] ?? BASE.observed;
  const isVerified = v === "verified" || v === "confirmed";

  const eq = clamp01(evidence_quality);
  const supportCount = uniqueBy(supports).length;
  const contradictionCount = uniqueBy(contradictions).length;

  const supportBonus = round4(Math.min(0.30, supportCount * 0.10) * eq);
  const contradictionPenalty = round4(Math.min(0.60, contradictionCount * 0.20));

  const occ = Math.max(1, Math.floor(finite(occurrences, 1)));
  const occurrenceBonus = isVerified ? round4(Math.min(0.10, (occ - 1) * 0.02)) : 0;

  const days = Math.max(0, finite(recency_days, 0));
  const recencyAdjustment = round4(0.03 - (Math.min(days, 30) / 30) * 0.06);

  let confidence = clamp01(base + supportBonus + occurrenceBonus + recencyAdjustment - contradictionPenalty);
  let capApplied = false;
  if (!isVerified && confidence > 0.5) {
    confidence = 0.5;
    capApplied = true;
  }
  confidence = round4(confidence);

  const breakdown = {
    verification: v,
    base,
    evidence_quality: eq,
    independent_supports: supportCount,
    support_bonus: supportBonus,
    contradictions: contradictionCount,
    contradiction_penalty: contradictionPenalty,
    occurrences: occ,
    occurrence_bonus: occurrenceBonus,
    recency_days: days,
    recency_adjustment: recencyAdjustment,
    unverified_cap_applied: capApplied,
    confidence,
  };

  const parts = [
    `base ${base} for '${v}'`,
    `+${supportBonus} from ${supportCount} independent support(s) at quality ${eq}`,
    `+${occurrenceBonus} occurrence bonus`,
    `${recencyAdjustment >= 0 ? "+" : ""}${recencyAdjustment} recency adjustment`,
    `-${contradictionPenalty} from ${contradictionCount} contradiction(s)`,
  ];
  const note = `Confidence = ${confidence}. ${parts.join("; ")}.${capApplied ? " Capped at 0.50 because the claim is not verified." : ""}` +
    (isVerified ? "" : " Repetition alone never raises an unverified claim above 0.50.");

  return { ok: true, confidence, breakdown, note };
}

// ---------------------------------------------------------------------------
// Tokenizer: reuse patterns-v2 when available, else a deterministic fallback
// ---------------------------------------------------------------------------

function fallbackTokens(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
}

function fallbackClusterKey(kind, text) {
  const ts = fallbackTokens(text).sort().slice(0, 7);
  const suffix = ts.length
    ? ts.join("|")
    : crypto.createHash("md5").update(String(text).slice(0, 80)).digest("hex").slice(0, 12);
  return `${kind}:${suffix}`;
}

let tokenizerPromise = null;
async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = import("./patterns-v2.js")
      .then((m) => ({
        tokens: typeof m.tokens === "function" ? m.tokens : fallbackTokens,
        clusterKey: typeof m.clusterKey === "function" ? m.clusterKey : fallbackClusterKey,
        source: "patterns-v2",
      }))
      .catch(() => ({ tokens: fallbackTokens, clusterKey: fallbackClusterKey, source: "fallback" }));
  }
  return tokenizerPromise;
}

const VALID_KINDS = new Set([
  "repeated_failure", "successful_solution", "user_preference", "debugging_pattern",
  "workflow_inefficiency", "project_experience", "historical_decision", "user_correction",
  "root_cause_candidate", "failed_approach", "technical_knowledge", "project_decision",
  "architecture_decision", "environment_config", "temporary_observation", "user_statement",
]);

function kindFor(record) {
  const c = String(record?.category || "").toLowerCase();
  if (VALID_KINDS.has(c)) return c;
  if (/(success|solution|fix|resolv|worked)/.test(c)) return "successful_solution";
  if (/(fail|error|bug|crash|exception)/.test(c)) return "repeated_failure";
  if (/(decision|decided)/.test(c)) return "project_decision";
  return "technical_knowledge";
}

function normalizedSignature(record) {
  return String(record?.signature ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---------------------------------------------------------------------------
// 3. Pattern detection (reuses existing pattern / pattern_evidence tables)
// ---------------------------------------------------------------------------

/** Group project learning records into existing pattern rows. Idempotent. */
export async function detectPatterns(input = {}) {
  const { project_id, limit = 100 } = input && typeof input === "object" ? input : {};
  if (!project_id || typeof project_id !== "string") {
    return { ok: false, patterns: [], examined: 0, reason: "a valid project_id is required" };
  }
  const n = clampLimit(limit, 100, 200);
  const maxRecords = Math.min(Math.max(n * 20, 200), 2000);
  const { clusterKey } = await getTokenizer();

  const rows = (await core.dbQuery(
    `SELECT id, project_id, session_id, signature, category, problem, approach,
            outcome, verification, confidence, evidence, created_at, updated_at
       FROM learning_record
      WHERE project_id=$1 AND (status IS NULL OR status <> 'superseded')
      ORDER BY created_at DESC, id::text ASC
      LIMIT $2`,
    [project_id, maxRecords],
  )).rows;

  // Group by normalized signature (scoped to this project by the query above).
  const groups = new Map();
  for (const r of rows) {
    const sig = normalizedSignature(r);
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  }

  const patterns = [];
  let evidenceInserts = 0;
  const MAX_EVIDENCE_INSERTS = 100;

  for (const [sig, records] of groups) {
    if (patterns.length >= n) break;
    const kind = kindFor(records[0]);
    const key = clusterKey(kind, sig);
    if (!key || key.length < 12) continue;

    const groupSessions = union(records.map((r) => r.session_id).filter(Boolean));
    const groupVerified = records.some((r) => {
      const ao = analyzeOutcome({
        experience: { outcome: r.outcome, verification: r.verification },
        evidence: Array.isArray(r.evidence) ? r.evidence : [],
      });
      return ao.verified && String(r.verification || "").toLowerCase() !== "contradicted";
    }) || records.some((r) => String(r.verification || "").toLowerCase() === "verified");

    const existing = (await core.dbQuery(
      "SELECT * FROM pattern WHERE kind=$1 AND pattern_key=$2", [kind, key],
    )).rows[0] || null;

    const sessions = union([...(existing?.sessions || []), ...groupSessions]);
    const projects = union([...(existing?.projects || []), project_id]);
    const occurrences = Math.max(sessions.length, records.length);
    const distinctSessions = sessions.length;

    const newEvidence = records.map((r) => ({
      id: String(r.id),
      session: r.session_id || null,
      project: project_id,
      outcome: r.outcome,
      verification: r.verification,
      excerpt: String(r.problem || r.approach || sig).slice(0, 400),
    }));
    const mergedEvidence = mergeEvidence(existing?.evidence, newEvidence);

    const conf = calculateConfidence({
      supports: newEvidence,
      contradictions: [],
      verification: groupVerified ? "verified" : "observed",
      recency_days: records.reduce((max, r) => {
        const d = r.updated_at ? (Date.now() - new Date(r.updated_at).getTime()) / 86400000 : 0;
        return Math.max(max, Number.isFinite(d) ? d : 0);
      }, 0),
      occurrences,
      evidence_quality: groupVerified ? 0.7 : 0.5,
    });

    let status = "hypothesis";
    if (groupVerified && distinctSessions >= 2) status = "verified_fact";
    else if (distinctSessions >= 2) status = "repeated_observation";
    else if (groupVerified) status = "root_cause_candidate";

    const superseded = existing?.status === "superseded";
    const description = String(records[0].problem || records[0].signature || key).slice(0, 300);
    const reason = groupVerified
      ? `${distinctSessions} distinct session(s) with explicit verification evidence`
      : `${distinctSessions} session(s), no verified outcome evidence yet`;

    const up = (await core.dbQuery(
      `INSERT INTO pattern (kind, pattern_key, description, occurrences, sessions, projects,
          evidence, confidence, verified, suggested_improvement, status, distinct_sessions,
          verification_reason, language)
       VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (kind, pattern_key) DO UPDATE SET
         description = CASE WHEN pattern.verified AND NOT EXCLUDED.verified THEN pattern.description ELSE EXCLUDED.description END,
         occurrences = EXCLUDED.occurrences,
         sessions = EXCLUDED.sessions,
         projects = EXCLUDED.projects,
         distinct_sessions = EXCLUDED.distinct_sessions,
         status = CASE WHEN pattern.status='superseded' THEN 'superseded' ELSE EXCLUDED.status END,
         verification_reason = EXCLUDED.verification_reason,
         confidence = EXCLUDED.confidence,
         verified = CASE WHEN pattern.status='superseded' THEN pattern.verified ELSE EXCLUDED.verified END,
         last_observed = now(), updated_at = now()
       RETURNING id, kind, pattern_key, description, occurrences, sessions, projects,
                 confidence, verified, status, distinct_sessions`,
      [kind, key, description, occurrences, sessions, projects, JSON.stringify(mergedEvidence),
        conf.confidence, Boolean(existing?.verified || groupVerified),
        "Review as an evidence-backed pattern before reuse.", status, distinctSessions,
        reason, "unknown"],
    )).rows[0];

    // Idempotent, bounded evidence rows. Never insert an identical triple twice.
    const patternId = up.id;
    for (const r of records) {
      if (evidenceInserts >= MAX_EVIDENCE_INSERTS) break;
      if (!r.session_id) continue;
      const excerpt = String(r.problem || r.approach || sig).slice(0, 400);
      await core.dbQuery(
        `INSERT INTO pattern_evidence (pattern_id, session_id, project_id, excerpt)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
           SELECT 1 FROM pattern_evidence WHERE pattern_id=$1 AND session_id=$2 AND excerpt=$4)`,
        [patternId, r.session_id, project_id, excerpt],
      );
      evidenceInserts++;
    }

    patterns.push(up);
    if (patterns.length >= n) break;
  }

  return { ok: true, patterns, examined: rows.length, evidence_inserts: evidenceInserts };
}

// ---------------------------------------------------------------------------
// 4. Project-scoped pattern reads
// ---------------------------------------------------------------------------

export async function getPatterns(input = {}) {
  const { project_id, kind, status, limit = 50 } = input && typeof input === "object" ? input : {};
  if (!project_id || typeof project_id !== "string") {
    return { ok: false, items: [], reason: "a valid project_id is required" };
  }
  const n = clampLimit(limit, 50, 200);
  const r = await core.dbQuery(
    `SELECT id, kind, pattern_key, description, occurrences, sessions, projects, confidence,
            verified, status, distinct_sessions, verification_reason, language,
            first_observed, last_observed
       FROM pattern
      WHERE $1 = ANY(projects)
        AND ($2::text IS NULL OR kind=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY occurrences DESC, last_observed DESC NULLS LAST
      LIMIT $4`,
    [project_id, kind || null, status || null, n],
  );
  return { ok: true, items: r.rows, limit: n };
}

// ---------------------------------------------------------------------------
// 5. Non-destructive supersession
// ---------------------------------------------------------------------------

export async function supersedePattern(input = {}) {
  const { id, by_id, project_id, reason, evidence = [] } = input && typeof input === "object" ? input : {};
  if (!isUuid(id) || !project_id || typeof project_id !== "string") {
    return { ok: false, changed: false, reason: "a valid id and project_id are required" };
  }
  return core.withDb(async (client) => {
    const cur = await client.query("SELECT id, status, projects, evidence, verification_reason FROM pattern WHERE id=$1", [id]);
    const row = cur.rows[0];
    if (!row || !Array.isArray(row.projects) || !row.projects.includes(project_id)) {
      return { ok: false, changed: false, reason: "pattern not found in project" };
    }
    if (row.status === "superseded") {
      return { ok: true, changed: false, reason: "pattern already superseded" };
    }
    const note = `superseded${by_id ? ` by ${by_id}` : ""}${reason ? `: ${reason}` : ""}`.slice(0, 1000);
    const prevReason = row.verification_reason ? `${row.verification_reason} | ` : "";
    const supersedeEvidence = {
      id: `supersede-${id}`,
      by_id: by_id || null,
      reason: reason || "",
      evidence: Array.isArray(evidence) ? evidence.slice(0, 20) : [],
      at: new Date().toISOString(),
    };
    const merged = mergeEvidence(row.evidence, [supersedeEvidence]);
    const upd = await client.query(
      `UPDATE pattern SET status='superseded', verification_reason=$2, evidence=$3::jsonb,
              updated_at=now()
        WHERE id=$1 AND status <> 'superseded'`,
      [id, `${prevReason}${note}`, JSON.stringify(merged)],
    );
    return { ok: true, changed: upd.rowCount > 0 };
  });
}

// ---------------------------------------------------------------------------
// 6. Conservative confidence recalculation for a learning record
// ---------------------------------------------------------------------------

export async function recalculateLearningConfidence(input = {}) {
  const { project_id, learning_id } = input && typeof input === "object" ? input : {};
  const empty = { ok: false, confidence: 0, breakdown: {}, changed: false };
  if (!isUuid(learning_id) || !project_id || typeof project_id !== "string") {
    return { ...empty, reason: "a valid learning_id and project_id are required" };
  }
  return core.withDb(async (client) => {
    const r = await client.query(
      "SELECT * FROM learning_record WHERE id=$1 AND project_id=$2", [learning_id, project_id],
    );
    const rec = r.rows[0];
    if (!rec) return { ...empty, reason: "learning record not found in project" };

    const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
    const fb = (await client.query(
      `SELECT id, verdict, explicit_feedback, evidence
         FROM learning_feedback
        WHERE learning_id=$1 AND project_id=$2
        ORDER BY created_at DESC LIMIT 100`,
      [learning_id, project_id],
    )).rows;

    const ao = analyzeOutcome({
      experience: { outcome: rec.outcome, verification: rec.verification },
      evidence,
    });
    // Never promote: an unsupported 'verified' claim is demoted to 'observed'.
    let verification = String(rec.verification || "observed").trim().toLowerCase();
    if (verification === "verified" && !ao.verified) verification = "observed";

    const supports = [];
    const contradictions = [];
    const SUPPORT_VERDICTS = new Set(["useful", "helpful", "confirmed", "positive", "correct", "explicit_support"]);
    const CONTRA_VERDICTS = new Set(["not_useful", "unhelpful", "contradicted", "negative", "false", "incorrect", "explicit_contradiction"]);
    for (const f of fb) {
      const verdict = String(f.verdict || "").toLowerCase();
      const item = { id: `fb-${f.id}`, explicit: Boolean(f.explicit_feedback) };
      if (SUPPORT_VERDICTS.has(verdict)) supports.push(item);
      else if (CONTRA_VERDICTS.has(verdict)) contradictions.push(item);
    }
    evidence.forEach((e, i) => {
      const id = e && typeof e === "object" && e.id != null ? `ev-${e.id}` : `ev-${i}`;
      const marker = markerOf(e);
      if (marker && VERIFICATION_MARKERS.has(marker) && resultOf(e)) supports.push({ id });
      else if (marker && /contradict|negat|refut|stale/.test(marker)) contradictions.push({ id });
    });

    // Whole days keep recency stable across repeated recalculations.
    const days = Math.max(0, Math.round(rec.updated_at
      ? (Date.now() - new Date(rec.updated_at).getTime()) / 86400000 : 0));
    const eq = fb.some((f) => f.explicit_feedback) ? 0.8 : 0.5;
    const out = calculateConfidence({
      supports,
      contradictions,
      verification,
      recency_days: days,
      occurrences: Math.max(1, evidence.length),
      evidence_quality: eq,
    });

    // JSONB reorders object keys on read, so compare breakdowns canonically.
    const changed = Number(rec.confidence) !== out.confidence
      || stableString(rec.confidence_breakdown || {}) !== stableString(out.breakdown);
    if (changed) {
      // Deliberately do NOT touch verification/outcome/updated_at: no promotion,
      // and recency stays stable so repeated recalculation is idempotent.
      await client.query(
        "UPDATE learning_record SET confidence=$2, confidence_breakdown=$3::jsonb WHERE id=$1",
        [learning_id, out.confidence, JSON.stringify(out.breakdown)],
      );
    }
    return {
      ok: true,
      confidence: out.confidence,
      breakdown: out.breakdown,
      note: out.note,
      changed,
      verification_unchanged: true,
    };
  });
}
