// Phase 27 facade: advanced self-improvement & adaptive intelligence.
// EVALUATION and ADVISORY PROPOSALS only over existing Phase 18-26 systems.
// Does NOT create a second learning/retrieval/failure/risk/workflow engine.
// LEVEL 1 and HARNESS_SEMANTIC_LLM=0 unchanged; no source rewrite, no auto-approval,
// no dispatch, and model confidence is NEVER treated as verification.
async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";

export const ADVISORY_CLAIM = "Evaluation and advisory proposals only. No source was rewritten, no approval was auto-granted, no workflow was dispatched, and model confidence never establishes verification.";

async function call(module, fn, args, label, degraded) {
  try {
    const m = await load(module);
    if (!m?.[fn]) { degraded.push(`${label}: ${module}.${fn} unavailable`); return null; }
    return await m[fn](args);
  } catch (e) { degraded.push(`${label}: ${short(e?.message || e, 120)}`); return null; }
}
async function audit(action, project_id, detail) {
  try { const core = await import("./core.js"); await core.audit(action, project_id, detail); }
  catch { /* best effort */ }
}

// --- New evaluation capabilities -------------------------------------------

export async function ingestOutcome(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("outcomeEvaluation", "ingestOutcome", args, "ingest", degraded);
  await audit("p27.outcome.ingest", args.project_id, { ok: !!r?.ok, source_type: args.source_type || null });
  return r || { ok: false, reason: "outcome ingestion unavailable", degraded };
}

export async function evaluateRecommendation(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("recommendationEvaluation", "evaluateRecommendation", args, "recommendation", degraded);
  await audit("p27.recommendation.evaluate", args.project_id, { ok: !!r?.ok });
  return r || { ok: false, reason: "recommendation evaluation unavailable", degraded };
}

export async function evaluatePrediction(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("predictionEvaluation", "evaluatePrediction", args, "prediction", degraded);
  await audit("p27.prediction.evaluate", args.project_id, { ok: !!r?.ok });
  return r || { ok: false, reason: "prediction evaluation unavailable", degraded };
}

export async function evaluateDecomposition(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("decompositionEvaluation", "evaluateDecomposition", args, "decomposition", degraded);
  await audit("p27.decomposition.evaluate", args.project_id, { ok: !!r?.ok });
  return r || { ok: false, reason: "decomposition evaluation unavailable", degraded };
}

export async function agentSuitability(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  return (await call("decompositionEvaluation", "agentSuitability", args, "agent", degraded))
    || { ok: false, reason: "agent suitability unavailable", degraded };
}

export async function proposeCalibration(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveCalibration", "proposeCalibration", args, "propose", degraded);
  await audit("p27.calibration.propose", args.project_id, { ok: !!r?.ok, target: args.target_subsystem || null });
  return r || { ok: false, reason: "calibration proposal unavailable", degraded };
}

export async function reviewCalibration(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveCalibration", "reviewCalibration", args, "review", degraded);
  await audit("p27.calibration.review", args.project_id, { ok: !!r?.ok, decision: args.decision || null });
  return r || { ok: false, reason: "calibration review unavailable", degraded };
}

export async function applyCalibration(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveCalibration", "applyCalibration", args, "apply", degraded);
  await audit("p27.calibration.apply", args.project_id, { ok: !!r?.ok });
  return r || { ok: false, reason: "calibration apply unavailable", degraded };
}

export async function rollbackCalibration(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveCalibration", "rollbackCalibration", args, "rollback", degraded);
  await audit("p27.calibration.rollback", args.project_id, { ok: !!r?.ok });
  return r || { ok: false, reason: "calibration rollback unavailable", degraded };
}

// --- Thin delegating wrappers over REUSED existing capabilities -------------

/** Retrieval usefulness is owned by Phase 18/20 (retrievalFeedback + adaptiveRetrieval). */
export async function retrievalUsefulness(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("retrievalFeedback", "usefulnessSummary", args, "retrieval", degraded);
  return { ...(r || { ok: false, reason: "retrieval usefulness unavailable" }), degraded,
    note: "Reuses the authoritative Phase 18/20 retrieval usefulness records; non-use is never proof of irrelevance." };
}

/** Recurring failures are owned by Phase 19/21 (errorLearning + debuggingExperience). */
export async function failurePatterns(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("errorLearning", "fixEvidenceReport", args, "failures", degraded);
  return { ...(r || { ok: false, reason: "failure evidence unavailable" }), degraded,
    note: "Reuses Phase 19/21 recurring-failure and fix-evidence records; duplicate evidence is never double-counted here." };
}

/** Learning quality is owned by Phase 21 (learningIntelligence.calculateConfidence). */
export async function learningQuality(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const [status, patterns] = await Promise.all([
    call("learningEngine", "learningStatus", args, "status", degraded),
    call("learningIntelligence", "getPatterns", args, "patterns", degraded),
  ]);
  return { ok: !!status?.ok || !!patterns?.ok, status: status || null, patterns: patterns || null, degraded,
    note: "Reuses Phase 21 verification/confidence/contradiction logic; confidence never replaces verification." };
}

/** Lists bounded evaluations/proposals from the Phase 27 ledgers. */
export async function evaluations(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const kind = args.kind || "outcomes";
  const [mod, fn] = kind === "recommendations" ? ["recommendationEvaluation", "listRecommendationEvaluations"]
    : kind === "predictions" ? ["predictionEvaluation", "getPredictionEvaluation"]
      : ["outcomeEvaluation", "listOutcomes"];
  const r = await call(mod, fn, args, kind, degraded);
  return r || { ok: false, reason: `${kind} listing unavailable`, degraded };
}

export async function proposals(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveCalibration", "listCalibrationProposals", args, "proposals", degraded);
  return r || { ok: false, reason: "proposal listing unavailable", degraded };
}

/** Unified adaptive-intelligence report. */
export async function report(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("adaptiveReporting", "adaptiveReport", args, "report", degraded);
  return r || { ok: false, reason: "adaptive report unavailable", degraded, claim: ADVISORY_CLAIM };
}

export default { ingestOutcome, evaluateRecommendation, evaluatePrediction, evaluateDecomposition,
  agentSuitability, proposeCalibration, reviewCalibration, applyCalibration, rollbackCalibration,
  retrievalUsefulness, failurePatterns, learningQuality, evaluations, proposals, report };
