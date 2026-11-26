import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const oe = await import("../src/outcomeEvaluation.js");
const re = await import("../src/recommendationEvaluation.js");
const pe = await import("../src/predictionEvaluation.js");
const de = await import("../src/decompositionEvaluation.js");

const pid = `p27-eval-${crypto.randomUUID().slice(0, 8)}`;
const VERIFIED = [{ kind: "test_pass", result: "passed" }];
const DDL = [
  `CREATE TABLE IF NOT EXISTS ai_outcome_evaluation (id uuid PRIMARY KEY, project_id text NOT NULL, source_type text NOT NULL, source_id text NOT NULL DEFAULT '', subsystem text NOT NULL DEFAULT '', observation text NOT NULL DEFAULT '', expected_outcome jsonb NOT NULL DEFAULT '{}'::jsonb, actual_outcome jsonb NOT NULL DEFAULT '{}'::jsonb, verification_state text NOT NULL DEFAULT 'unresolved', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, confidence real NOT NULL DEFAULT 0, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, source_type, source_id))`,
  `CREATE TABLE IF NOT EXISTS ai_recommendation_evaluation (id uuid PRIMARY KEY, project_id text NOT NULL, recommendation_type text NOT NULL DEFAULT '', recommendation_id text NOT NULL DEFAULT '', original jsonb NOT NULL DEFAULT '{}'::jsonb, reason text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, confidence real NOT NULL DEFAULT 0, operator_decision text NOT NULL DEFAULT 'unknown', action_occurred boolean NOT NULL DEFAULT false, result_verified boolean NOT NULL DEFAULT false, observed_outcome text NOT NULL DEFAULT '', evaluation_status text NOT NULL DEFAULT 'not_evaluated', created_at timestamptz NOT NULL DEFAULT now(), evaluated_at timestamptz, UNIQUE (project_id, recommendation_type, recommendation_id))`,
  `CREATE TABLE IF NOT EXISTS ai_prediction_evaluation (id uuid PRIMARY KEY, project_id text NOT NULL, prediction_type text NOT NULL DEFAULT '', prediction_id text NOT NULL DEFAULT '', predicted jsonb NOT NULL DEFAULT '{}'::jsonb, confidence real NOT NULL DEFAULT 0, prediction_time timestamptz, observation_window text NOT NULL DEFAULT '', actual jsonb NOT NULL DEFAULT '{}'::jsonb, verification_evidence jsonb NOT NULL DEFAULT '[]'::jsonb, evaluation_status text NOT NULL DEFAULT 'insufficient_evidence', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, prediction_type, prediction_id))`,
  `CREATE TABLE IF NOT EXISTS ai_decomposition_evaluation (id uuid PRIMARY KEY, project_id text NOT NULL, plan_id text NOT NULL, task_count integer NOT NULL DEFAULT 0, dependency_count integer NOT NULL DEFAULT 0, ownership_conflicts integer NOT NULL DEFAULT 0, review_failures integer NOT NULL DEFAULT 0, rework_count integer NOT NULL DEFAULT 0, completion_verified boolean NOT NULL DEFAULT false, evaluation text NOT NULL DEFAULT 'insufficient_evidence', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, sample_size integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, plan_id))`,
  `CREATE TABLE IF NOT EXISTS ai_calibration_proposal (id uuid PRIMARY KEY, project_id text NOT NULL, proposal_key text NOT NULL, target_subsystem text NOT NULL DEFAULT '', current_behavior jsonb NOT NULL DEFAULT '{}'::jsonb, proposed_behavior jsonb NOT NULL DEFAULT '{}'::jsonb, reason text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, sample_size integer NOT NULL DEFAULT 0, confidence real NOT NULL DEFAULT 0, expected_benefit text NOT NULL DEFAULT '', potential_downside text NOT NULL DEFAULT '', reversal text NOT NULL DEFAULT '', approval_required boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'proposed', actor text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, proposal_key))`,
];
for (const d of DDL) { try { await core.dbQuery(d); } catch { /* migration 025 normally applied */ } }

const stubLoader = { analyzeOutcome: ({ evidence }) => {
  const has = Array.isArray(evidence) && evidence.some((e) => e && typeof e === "object" && Object.keys(e).some((k) => /test_pass|verification_result|tool_result/.test(k)));
  return has ? { ok: true, outcome: "success", verified: true, reason: "explicit marker with determinate result" }
    : { ok: true, outcome: "success", verified: false, reason: "outcome declared in experience, but no explicit verification evidence exists; not verified" };
} };

test("0. exact exports", () => {
  assert.deepEqual(Object.keys(oe.default).sort(), ["getOutcome", "ingestOutcome", "listOutcomes"]);
  assert.deepEqual(Object.keys(re.default).sort(), ["classifyRecommendation", "evaluateRecommendation", "listRecommendationEvaluations", "recommendationEffectiveness"]);
  assert.deepEqual(Object.keys(pe.default).sort(), ["evaluatePrediction", "getPredictionEvaluation", "predictionSummary"]);
  assert.deepEqual(Object.keys(de.default).sort(), ["agentSuitability", "evaluateDecomposition", "getDecompositionEvaluation"]);
});

test("1. ingestOutcome uses Phase 21 verification — verified only from explicit evidence", async () => {
  const v = await oe.ingestOutcome({ project_id: pid, source_type: "workflow", source_id: "wf-1",
    observation: "completed", evidence: VERIFIED, actual_outcome: { outcome: "success" }, _load: stubLoader });
  assert.equal(v.ok, true);
  assert.equal(v.verification_state, "independently_verified");
  assert.equal(v.verified, true);
  assert.ok(v.confidence <= 0.85);
});

test("2. agent claim without evidence is not verified", async () => {
  const r = await oe.ingestOutcome({ project_id: pid, source_type: "workflow", source_id: "wf-2",
    observation: "agent says done", actual_outcome: { outcome: "success" }, evidence: [{ kind: "agent_claim", status: "done" }],
    _load: stubLoader });
  assert.equal(r.ok, true);
  assert.notEqual(r.verification_state, "independently_verified");
  assert.equal(r.verified, false);
  assert.match(r.reason, /not verified/);
});

test("3. ingestOutcome is idempotent", async () => {
  const a = await oe.ingestOutcome({ project_id: pid, source_type: "workflow", source_id: "idem-1", evidence: VERIFIED, _load: stubLoader });
  const b = await oe.ingestOutcome({ project_id: pid, source_type: "workflow", source_id: "idem-1", evidence: VERIFIED, _load: stubLoader });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  const n = (await core.dbQuery("SELECT count(*)::int n FROM ai_outcome_evaluation WHERE project_id=$1 AND source_id='idem-1'", [pid])).rows[0].n;
  assert.equal(n, 1);
});

test("4. get/list outcomes are bounded and project-scoped", async () => {
  const g = await oe.getOutcome({ project_id: pid, source_type: "workflow", source_id: "wf-1" });
  assert.equal(g.ok, true);
  const l = await oe.listOutcomes({ project_id: pid, limit: 9999 });
  assert.equal(l.ok, true);
  assert.ok(l.count <= 200);
  const x = await oe.listOutcomes({ project_id: `${pid}-other`, limit: 10 });
  assert.equal(x.count, 0);
});

test("5. recommendation classification preserves distinctions", () => {
  assert.equal(re.classifyRecommendation({ operator_decision: "rejected" }).status, "inconclusive");
  assert.equal(re.classifyRecommendation({ operator_decision: "ignored" }).status, "inconclusive");
  assert.equal(re.classifyRecommendation({ operator_decision: "accepted", action_occurred: true }).status, "inconclusive");
  assert.equal(re.classifyRecommendation({ operator_decision: "accepted", action_occurred: true,
    result_verified: true, observed_outcome: "faster", evidence: [{ kind: "verification_result" }] }).status, "helpful");
});

test("6. recommendation evaluation stores original immutably", async () => {
  const r = await re.evaluateRecommendation({ project_id: pid, recommendation_type: "engineering",
    recommendation_id: "rec-1", original: { id: "rec-1", priority: 9 }, reason: "test",
    operator_decision: "accepted", action_occurred: true, result_verified: true,
    observed_outcome: "verified improvement", evidence: VERIFIED });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation_status, "helpful");
  const row = (await core.dbQuery("SELECT original FROM ai_recommendation_evaluation WHERE project_id=$1 AND recommendation_id='rec-1'", [pid])).rows[0];
  assert.equal(row.original.priority, 9);
});

test("7. recommendation effectiveness needs minimum samples; no accuracy %", async () => {
  const e = await re.recommendationEffectiveness({ project_id: pid, recommendation_type: "engineering", min_samples: 5 });
  assert.equal(e.ok, true);
  assert.equal(e.insufficient_evidence, true);
  assert.doesNotMatch(JSON.stringify(e), /\d+(\.\d+)?\s*%/);
  assert.ok(e.denominators.verified !== undefined);
});

test("8. prediction evaluation stored separately; original not touched", async () => {
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS p27_pred_orig (id text PRIMARY KEY, predicted text)`);
  await core.dbQuery("INSERT INTO p27_pred_orig VALUES ('pred-1','risk') ON CONFLICT DO NOTHING");
  const r = await pe.evaluatePrediction({ project_id: pid, prediction_type: "fragility", prediction_id: "pred-1",
    predicted: { outcome: "failure" }, actual: { outcome: "failure" }, observation_window: "14d" });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation_status, "matched");
  const orig = (await core.dbQuery("SELECT predicted FROM p27_pred_orig WHERE id='pred-1'")).rows[0].predicted;
  assert.equal(orig, "risk");
});

test("9. prediction without observation window is insufficient_evidence", async () => {
  const r = await pe.evaluatePrediction({ project_id: pid, prediction_type: "fragility", prediction_id: "pred-2",
    predicted: { outcome: "failure" }, actual: { outcome: "success" } });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation_status, "insufficient_evidence");
});

test("10. predictionSummary denominators + no invented accuracy", async () => {
  const s = await pe.predictionSummary({ project_id: pid, prediction_type: "fragility", min_samples: 5 });
  assert.equal(s.ok, true);
  assert.equal(s.insufficient_evidence, true);
  assert.doesNotMatch(JSON.stringify(s), /\d+(\.\d+)?\s*%/);
});

test("11. decomposition evaluation below threshold -> insufficient_evidence", async () => {
  const r = await de.evaluateDecomposition({ project_id: pid, plan_id: "plan-insufficient", task_count: 5,
    ownership_conflicts: 2, min_samples: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.insufficient_evidence, true);
  assert.equal(r.evaluation, "insufficient_evidence");
});

test("12. agent suitability below min samples -> unknown", async () => {
  const r = await de.agentSuitability({ project_id: pid, agent: "general", task_category: "refactor", min_samples: 5,
    _load: { agentWorkflowLearning: async () => ({ agentPerformance: async () => ({ items: [{ verdict: "accepted" }] }) }) } });
  assert.equal(r.ok, true);
  assert.equal(r.suitability, "unknown");
  assert.equal(r.insufficient_evidence, true);
});

test("13. agent suitability with sufficient samples uses evidence", async () => {
  const items = Array.from({ length: 6 }, () => ({ verdict: "accepted" }));
  const r = await de.agentSuitability({ project_id: pid, agent: "reviewer", task_category: "review", min_samples: 5,
    _load: { agentWorkflowLearning: async () => ({ agentPerformance: async () => ({ items }) }) } });
  assert.equal(r.ok, true);
  assert.equal(r.suitability, "favorable");
  assert.equal(r.insufficient_evidence, false);
});

test("14. cross-project isolation across evaluation ledgers", async () => {
  const other = `${pid}-iso`;
  const a = await oe.listOutcomes({ project_id: other, limit: 50 });
  assert.equal(a.count, 0);
  const b = await re.listRecommendationEvaluations({ project_id: other, limit: 50 });
  assert.equal(b.count, 0);
  const c = await pe.getPredictionEvaluation({ project_id: other, limit: 50 });
  assert.equal(c.count, 0);
  const d = await de.getDecompositionEvaluation({ project_id: other, plan_id: "plan-insufficient" });
  assert.equal(d.ok, false);
});

test("15. invalid inputs fail closed", async () => {
  for (const fn of [
    () => oe.ingestOutcome({ project_id: "_global", source_type: "x" }),
    () => re.evaluateRecommendation({ project_id: "_global", recommendation_type: "x", recommendation_id: "y" }),
    () => pe.evaluatePrediction({ project_id: "_global", prediction_type: "x", prediction_id: "y" }),
    () => de.evaluateDecomposition({ project_id: "_global", plan_id: "p" }),
    () => de.agentSuitability({ project_id: "_global", agent: "a" }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("16. credential-like content is redacted", async () => {
  const r = await oe.ingestOutcome({ project_id: pid, source_type: "audit", source_id: "red-1",
    observation: "token sk-abcdefgh12345678 used", evidence: ["sk-abcdefgh12345678"],
    actual_outcome: { detail: "Bearer abcdef123456" }, _load: stubLoader });
  assert.equal(r.ok, true);
  const blob = JSON.stringify(r);
  assert.doesNotMatch(blob, /sk-abcdefgh12345678|Bearer abcdef123456/);
});

test("close pool", async () => { await core.close(); });
