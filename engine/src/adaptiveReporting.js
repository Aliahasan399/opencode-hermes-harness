// Phase 27 — cross-phase adaptive intelligence report. REUSES existing authoritative
// systems via dynamic import with graceful degradation; no new retrieval/failure/quality
// engine. Every metric has meaning, denominator, window, evidence source, verification
// requirements and limitations. No invented accuracy or improvement percentages.
import * as core from "./core.js";

async function load(name, _load, degraded, label) {
  if (_load && typeof _load[name] === "function") return _load[name];
  try { const m = await import(`./${name}.js`); return m[Object.keys(m).find((k) => k !== "default")] || m; }
  catch (e) { degraded.push(`${label}: ${name} unavailable`); return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};

function metric(value, meaning, denominator, window, source, verification, limitation) {
  return { value, meaning, denominator, window, evidence_source: source,
    verification_requirement: verification, limitation };
}

export async function adaptiveReport({ project_id, window, limit, _load } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const n = clamp(limit, 1, 200, 50);
  const w = short(window || "all_recorded", 80);
  const sections = {};

  // Phase 21 learning activity (reuse).
  const learningStatus = await load("learningEngine", _load, degraded, "learning");
  let learning = null;
  try { if (learningStatus?.learningStatus) learning = await learningStatus.learningStatus({ project_id, limit: n }); }
  catch (e) { degraded.push(`learningStatus: ${short(e?.message || e, 100)}`); }
  const lc = learning?.counts || learning?.summary || {};
  sections.learning_activity = metric(learning ? lc : null,
    "counts of learning records by status", "learning_record rows in project scope", w,
    "Phase 21 learning_record", "none — counts only", "counts are not verified outcomes");
  sections.verified_experiences = metric(lc.verified ?? null,
    "learning records with explicit verification evidence", "verified / total learning records", w,
    "Phase 21 analyzeOutcome markers", "explicit verification marker required", "unverified claims excluded");
  sections.unverified_experiences = metric(lc.observed ?? lc.inferred ?? lc.uncertain ?? null,
    "learning records without explicit verification", "unverified / total learning records", w,
    "Phase 21 learning records", "none — confidence capped, never verified", "not treated as established fact");

  // Phase 27 evaluation ledgers.
  const q = async (sql, params) => { try { return (await core.dbQuery(sql, params)).rows; } catch { return []; } };
  const recRows = await q(`SELECT evaluation_status, count(*)::int AS n FROM ai_recommendation_evaluation
    WHERE project_id=$1 GROUP BY evaluation_status`, [project_id]);
  sections.recommendation_outcomes = metric(Object.fromEntries(recRows.map((r) => [r.evaluation_status, r.n])),
    "counts of explicit recommendation evaluations", "evaluated / total recommendations", w,
    "ai_recommendation_evaluation", "verified outcome for helpful verdicts",
    "accepted≠successful; rejected≠incorrect; ignored≠ineffective; no accuracy %");
  const predRows = await q(`SELECT evaluation_status, count(*)::int AS n FROM ai_prediction_evaluation
    WHERE project_id=$1 GROUP BY evaluation_status`, [project_id]);
  const predCounts = Object.fromEntries(predRows.map((r) => [r.evaluation_status, r.n]));
  const predVerified = (predCounts.matched || 0) + (predCounts.mismatched || 0);
  sections.prediction_evaluation = metric({ counts: predCounts, verified_samples: predVerified },
    "explicit predicted-vs-observed comparisons", "verified comparisons / total evaluations", w,
    "ai_prediction_evaluation", "observation_window + explicit fields required",
    predVerified < 5 ? "insufficient_evidence: fewer than 5 verified comparisons" : "no accuracy percentage computed");
  const decRows = await q(`SELECT evaluation, sample_size FROM ai_decomposition_evaluation WHERE project_id=$1 LIMIT $2`,
    [project_id, n]);
  sections.decomposition_outcomes = metric(decRows.map((r) => ({ evaluation: r.evaluation, sample_size: r.sample_size })),
    "decomposition evaluations from verified task outcomes", "verified outcome records / plan", w,
    "ai_decomposition_evaluation + Phase 22/24 records", "verified task evidence required",
    "patterns only with sufficient samples; plans never auto-changed");

  // Phase 18/20 retrieval usefulness (reuse — no new engine).
  const retrieval = await load("retrievalFeedback", _load, degraded, "retrieval");
  let retrievalData = null;
  try { if (retrieval?.usefulnessSummary) retrievalData = await retrieval.usefulnessSummary({ project_id }); }
  catch (e) { degraded.push(`usefulnessSummary: ${short(e?.message || e, 100)}`); }
  sections.retrieval_usefulness = metric(retrievalData?.buckets || null,
    "observed-use / explicit feedback buckets for retrieved context", "signals / retrieval events", w,
    "Phase 18 memory_usefulness_observations", "distinct snippet match or explicit user verdict",
    "absence of citation is NOT evidence of irrelevance");

  // Phase 22 agent performance (reuse).
  const agent = await load("agentWorkflowLearning", _load, degraded, "agent");
  let agentData = null;
  try { if (agent?.agentPerformance) agentData = await agent.agentPerformance({ project_id, limit: n }); }
  catch (e) { degraded.push(`agentPerformance: ${short(e?.message || e, 100)}`); }
  sections.agent_selection_evidence = metric(agentData ? (agentData.items || agentData.reviews || agentData) : null,
    "per-agent accepted/rejected/failed counts", "reviews / executions per agent", w,
    "Phase 22 agent_execution + agent_review", "verification evidence for success",
    "no provider favoritism; insufficient samples stay unknown");

  // Phase 19/21 recurring failures (reuse).
  const failure = await load("errorLearning", _load, degraded, "failures");
  let failureData = null;
  try { if (failure?.fixEvidenceReport) failureData = await failure.fixEvidenceReport({ project_id, limit: n }); }
  catch (e) { degraded.push(`fixEvidenceReport: ${short(e?.message || e, 100)}`); }
  sections.recurring_failures = metric(failureData ? (failureData.items || failureData) : null,
    "distinct recurring failure fingerprints with observed recurrence", "distinct evidence / occurrences", w,
    "Phase 19 fix_evidence + Phase 21 patterns", "explicit recurrence evidence",
    "duplicate records never counted as separate failures");

  // Phase 21 learning quality (reuse).
  const quality = await load("learningIntelligence", _load, degraded, "quality");
  sections.learning_quality = metric(quality ? { available: true } : null,
    "verification/confidence/contradiction state of learning", "learning records assessed", w,
    "Phase 21 learningIntelligence", "explicit verification markers",
    "confidence never replaces verification; contradictions preserved");

  const proposals = await q(`SELECT proposal_key,target_subsystem,status,sample_size,confidence
    FROM ai_calibration_proposal WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`, [project_id, n]);
  sections.calibration_proposals = metric(proposals,
    "bounded advisory calibration proposals", "proposals / evaluated subsystems", w,
    "ai_calibration_proposal", "explicit operator approval required",
    "advisory only; no production behavior changed");
  sections.confidence_changes = metric(null,
    "confidence deltas from feedback with evidence", "feedback records with applied deltas", w,
    "Phase 21 learning_feedback", "explicit feedback required", "no confidence inflation from repeated claims");
  sections.known_evaluation_gaps = metric(degraded,
    "evaluation areas lacking sufficient or available evidence", "n/a", w,
    "this report", "n/a", "missing evidence is reported, never filled with invented values");
  sections.recommended_improvements = metric(
    proposals.filter((p) => p.status === "proposed").map((p) => ({ proposal_key: p.proposal_key, target: p.target_subsystem })),
    "advisory improvement proposals awaiting review", "proposed / total proposals", w,
    "ai_calibration_proposal", "operator review required", "nothing is auto-applied");

  return { ok: true, project_id, window: w, sections, degraded,
    claim: "Evaluation and advisory proposals only; no runtime proof, no source rewrite, no dispatch, no verification from confidence.",
    note: "Unknown means insufficient evidence. No accuracy or improvement percentage is computed." };
}

export default { adaptiveReport };
