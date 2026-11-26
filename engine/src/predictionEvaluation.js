// Phase 27 — prediction vs outcome evaluation. Original predictions are NEVER updated;
// evaluations are stored separately. No accuracy percentages from incomplete/selective data.
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
const redact = (ev) => (Array.isArray(ev) ? ev.slice(0, 100).map((x) => {
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x)) o[short(k, 80)] = typeof x[k] === "string" ? core.redact(x[k]).slice(0, 400) : x[k];
    return o;
  }
  return core.redact(String(x)).slice(0, 400);
}) : []);

function comparePrediction(predicted, actual) {
  const p = predicted && typeof predicted === "object" ? predicted : {};
  const a = actual && typeof actual === "object" ? actual : {};
  const pv = p.outcome ?? p.risk_level ?? p.value ?? p.label ?? null;
  const av = a.outcome ?? a.risk_level ?? a.value ?? a.label ?? null;
  if (pv === null || av === null) return { status: "indeterminate", reason: "predicted/actual result fields not explicit" };
  return { status: String(pv).toLowerCase() === String(av).toLowerCase() ? "matched" : "mismatched",
    predicted: String(pv).slice(0, 120), actual: String(av).slice(0, 120),
    reason: "direction derived from explicit predicted vs observed fields only" };
}

/** Store prediction evaluation separately; never mutate the original prediction. */
export async function evaluatePrediction({ project_id, prediction_type, prediction_id, predicted,
  confidence, prediction_time, observation_window, actual, verification_evidence } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", degraded };
  if (!prediction_type || !prediction_id) {
    return { ok: false, reason: "prediction_type and prediction_id required", degraded };
  }
  let comparison = { status: "indeterminate", reason: "no comparison" };
  if (short(observation_window || "")) {
    comparison = comparePrediction(predicted, actual);
  } else {
    degraded.push("no observation_window; comparison withheld");
    comparison = { status: "insufficient_evidence", reason: "observation_window required for comparison" };
  }
  const pid = short(prediction_id, 300);
  try {
    const ins = await core.dbQuery(
      `INSERT INTO ai_prediction_evaluation (id,project_id,prediction_type,prediction_id,predicted,
         confidence,prediction_time,observation_window,actual,verification_evidence,evaluation_status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
       ON CONFLICT (project_id,prediction_type,prediction_id) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), project_id, short(prediction_type, 120), pid, JSON.stringify(predicted || {}),
        clamp01(confidence), prediction_time ? new Date(prediction_time).toISOString() : null,
        short(observation_window || "", 120), JSON.stringify(actual || {}),
        JSON.stringify(redact(verification_evidence)), comparison.status]);
    await audit("p27.prediction.evaluate", project_id, { type: prediction_type, status: comparison.status });
    return { ok: true, id: ins.rows[0]?.id || null, duplicate: ins.rowCount === 0,
      evaluation_status: comparison.status, comparison,
      note: "Evaluation stored separately; original prediction was not modified.", degraded };
  } catch (e) { return { ok: false, reason: `persist: ${short(e?.message || e, 140)}`, degraded }; }
}

export async function getPredictionEvaluation({ project_id, prediction_type, prediction_id, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [] };
  const n = clamp(limit, 1, 200, 50);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM ai_prediction_evaluation WHERE project_id=$1
         AND ($2::text IS NULL OR prediction_type=$2)
         AND ($3::text IS NULL OR prediction_id=$3)
         ORDER BY created_at DESC LIMIT $4`, [project_id, prediction_type || null, prediction_id || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), items: [] }; }
}

/** Explicit denominators; insufficient_evidence under minimum verified samples; no accuracy %. */
export async function predictionSummary({ project_id, prediction_type, min_samples, window } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const min = clamp(min_samples, 1, 200, 5);
  try {
    const r = await core.dbQuery(
      `SELECT evaluation_status, count(*)::int AS n FROM ai_prediction_evaluation
         WHERE project_id=$1 AND ($2::text IS NULL OR prediction_type=$2)
         GROUP BY evaluation_status`, [project_id, prediction_type || null]);
    const counts = Object.fromEntries(r.rows.map((x) => [x.evaluation_status, x.n]));
    const verified = (counts.matched || 0) + (counts.mismatched || 0);
    const insufficient_evidence = verified < min;
    return { ok: true, counts, verified_samples: verified, min_samples: min,
      denominators: { evaluated: Object.values(counts).reduce((a, b) => a + b, 0), verified },
      insufficient_evidence, window: window || "all_recorded",
      note: insufficient_evidence
        ? `only ${verified} verified observation(s); below the minimum sample threshold of ${min}`
        : "counts of explicit comparisons only; no accuracy percentage is computed",
    };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140) }; }
}

export default { evaluatePrediction, getPredictionEvaluation, predictionSummary };
