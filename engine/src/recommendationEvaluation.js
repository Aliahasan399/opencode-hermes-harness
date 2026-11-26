// Phase 27 — recommendation outcome evaluation. Preserves the distinctions that
// matter: ignored≠ineffective, rejected≠incorrect, accepted≠successful, and a
// successful process exit≠a good recommendation. No invented accuracy percentages.
import crypto from "node:crypto";
import * as core from "./core.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
};
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}
const redactEvidence = (ev) => (Array.isArray(ev) ? ev.slice(0, 100).map((x) => {
  if (x && typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x)) out[short(k, 80)] = typeof x[k] === "string" ? core.redact(x[k]).slice(0, 400) : x[k];
    return out;
  }
  return core.redact(String(x)).slice(0, 400);
}) : []);

/**
 * Decide evaluation_status from explicit fields. Deliberately conservative.
 */
export function classifyRecommendation({ operator_decision, action_occurred, result_verified,
  observed_outcome, evidence } = {}) {
  const decision = String(operator_decision || "unknown").toLowerCase();
  const hasOutcome = short(observed_outcome || "").length > 0;
  const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
  if (decision === "rejected") return { status: "inconclusive", reason: "rejected is not evidence the recommendation was incorrect" };
  if (decision === "ignored") return { status: "inconclusive", reason: "ignored is not evidence the recommendation was ineffective" };
  if (["deferred", "modified", "unknown", ""].includes(decision)) {
    return { status: hasOutcome && result_verified && hasEvidence ? "partially_helpful" : "inconclusive",
      reason: "no decisive operator decision; outcome evidence required for effectiveness" };
  }
  if (decision !== "accepted") return { status: "inconclusive", reason: "unrecognized operator decision" };
  if (!action_occurred) return { status: "inconclusive", reason: "accepted but no action occurred" };
  if (!result_verified || !hasEvidence || !hasOutcome) {
    return { status: "inconclusive", reason: "action occurred but result was not independently verified" };
  }
  return { status: "helpful", reason: "accepted, action occurred, verified outcome with evidence" };
}

export async function evaluateRecommendation({ project_id, recommendation_type, recommendation_id,
  original, reason, evidence, confidence, operator_decision, action_occurred, result_verified,
  observed_outcome } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", degraded };
  if (!recommendation_type || !recommendation_id) {
    return { ok: false, reason: "recommendation_type and recommendation_id required", degraded };
  }
  const classification = classifyRecommendation({ operator_decision, action_occurred,
    result_verified, observed_outcome, evidence });
  const ev = redactEvidence(evidence);
  const rid = short(recommendation_id, 300);
  try {
    const ins = await core.dbQuery(
      `INSERT INTO ai_recommendation_evaluation (id,project_id,recommendation_type,recommendation_id,
         original,reason,evidence,confidence,operator_decision,action_occurred,result_verified,
         observed_outcome,evaluation_status,evaluated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (project_id,recommendation_type,recommendation_id) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), project_id, short(recommendation_type, 120), rid,
        JSON.stringify(original || { id: rid, type: recommendation_type }), short(reason || "", 2000),
        JSON.stringify(ev), clamp01(confidence), String(operator_decision || "unknown"),
        action_occurred === true, result_verified === true, short(observed_outcome || "", 2000),
        classification.status, classification.status === "not_evaluated" ? null : new Date().toISOString()]);
    await audit("p27.recommendation.evaluate", project_id, { type: recommendation_type, status: classification.status });
    return { ok: true, id: ins.rows[0]?.id || null, duplicate: ins.rowCount === 0,
      evaluation_status: classification.status, reason: classification.reason,
      note: "Original recommendation is never mutated; evaluation stored separately.", degraded };
  } catch (e) { return { ok: false, reason: `persist: ${short(e?.message || e, 140)}`, degraded }; }
}

export async function listRecommendationEvaluations({ project_id, status, recommendation_type, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [] };
  const n = clamp(limit, 1, 200, 50);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM ai_recommendation_evaluation WHERE project_id=$1
         AND ($2::text IS NULL OR evaluation_status=$2)
         AND ($3::text IS NULL OR recommendation_type=$3)
         ORDER BY created_at DESC LIMIT $4`, [project_id, status || null, recommendation_type || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), items: [] }; }
}

/** Effectiveness summary with explicit denominators and minimum sample threshold. */
export async function recommendationEffectiveness({ project_id, recommendation_type, min_samples, window } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const min = clamp(min_samples, 1, 200, 5);
  try {
    const r = await core.dbQuery(
      `SELECT evaluation_status, count(*)::int AS n FROM ai_recommendation_evaluation
         WHERE project_id=$1 AND ($2::text IS NULL OR recommendation_type=$2)
         GROUP BY evaluation_status`, [project_id, recommendation_type || null]);
    const counts = Object.fromEntries(r.rows.map((x) => [x.evaluation_status, x.n]));
    const verified = (counts.helpful || 0) + (counts.partially_helpful || 0) + (counts.ineffective || 0)
      + (counts.harmful || 0);
    const insufficient_evidence = verified < min;
    return { ok: true, counts, verified_samples: verified, min_samples: min,
      denominators: { evaluated: Object.values(counts).reduce((a, b) => a + b, 0), verified },
      insufficient_evidence, window: window || "all_recorded",
      note: insufficient_evidence
        ? `only ${verified} verified evaluation(s); below the minimum sample threshold of ${min}`
        : "counts of explicit evaluations only; no accuracy percentage is computed",
    };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140) }; }
}

export default { evaluateRecommendation, listRecommendationEvaluations, recommendationEffectiveness, classifyRecommendation };
