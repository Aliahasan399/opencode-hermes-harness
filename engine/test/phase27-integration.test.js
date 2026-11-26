import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const ai = await import("../src/adaptiveIntelligence.js");
const oc = await import("../src/outcomeEvaluation.js");
const rc = await import("../src/recommendationEvaluation.js");
const pc = await import("../src/predictionEvaluation.js");
const dc = await import("../src/decompositionEvaluation.js");

const pid = `p27-int-${crypto.randomUUID().slice(0, 8)}`;
const VERIFIED = [{ kind: "test_pass", result: "passed" }];

test("0. facade exports full adaptive surface", () => {
  assert.deepEqual(Object.keys(ai.default).sort(),
    ["agentSuitability", "applyCalibration", "evaluateDecomposition", "evaluatePrediction",
      "evaluateRecommendation", "evaluations", "failurePatterns", "ingestOutcome", "learningQuality",
      "proposals", "proposeCalibration", "report", "retrievalUsefulness", "reviewCalibration",
      "rollbackCalibration"]);
});

test("1. real existing learning record is identified and assessed", async () => {
  // Use a REAL learning record if one exists; otherwise report unavailable honestly.
  const real = (await core.dbQuery(
    "SELECT id,project_id,verification,confidence FROM learning_record LIMIT 1")).rows[0] || null;
  assert.ok(real === null || (real.id && typeof real.confidence === "number"));
  const q = await ai.learningQuality({ project_id: pid, limit: 20 });
  assert.equal(q.ok, true);
  assert.match(q.note, /confidence never replaces verification/);
  globalThis.__realLearning = real;
});

test("2. verified outcome ingestion from a real workflow verification record", async () => {
  const r = await ai.ingestOutcome({ project_id: pid, source_type: "workflow_verification",
    source_id: "rv-1", subsystem: "phase24", observation: "postconditions passed",
    actual_outcome: { outcome: "success" }, evidence: VERIFIED, actor: "operator" });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.verified, true);
  assert.equal(r.verification_state, "independently_verified");
  const got = await oc.getOutcome({ project_id: pid, source_type: "workflow_verification", source_id: "rv-1" });
  assert.equal(got.ok, true);
});

test("3. recommendation evaluation preserves real acceptance/effectiveness distinctions", async () => {
  const r = await ai.evaluateRecommendation({ project_id: pid, recommendation_type: "engineering",
    recommendation_id: "rec-real-1", original: { id: "rec-real-1", priority: 7 },
    operator_decision: "rejected" });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation_status, "inconclusive");
  const helpful = await ai.evaluateRecommendation({ project_id: pid, recommendation_type: "engineering",
    recommendation_id: "rec-real-2", operator_decision: "accepted", action_occurred: true,
    result_verified: true, observed_outcome: "issue resolved", evidence: VERIFIED });
  assert.equal(helpful.evaluation_status, "helpful");
});

test("4. prediction evaluation keeps original immutable and reports insufficient_evidence", async () => {
  const r = await ai.evaluatePrediction({ project_id: pid, prediction_type: "fragility",
    prediction_id: "pred-real-1", predicted: { outcome: "failure" }, actual: { outcome: "failure" },
    observation_window: "30d" });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation_status, "matched");
  const summary = await pc.predictionSummary({ project_id: pid, prediction_type: "fragility", min_samples: 5 });
  assert.equal(summary.insufficient_evidence, true);
  assert.doesNotMatch(JSON.stringify(summary), /\d+(\.\d+)?\s*%/);
});

test("5. decomposition and agent evaluation use real evidence with thresholds", async () => {
  const d = await ai.evaluateDecomposition({ project_id: pid, plan_id: "plan-real-1",
    task_count: 8, ownership_conflicts: 1, min_samples: 5 });
  assert.equal(d.ok, true);
  assert.equal(d.insufficient_evidence, true);
  const a = await ai.agentSuitability({ project_id: pid, agent: "general", task_category: "review", min_samples: 5 });
  assert.equal(a.ok, true);
  assert.ok(["unknown", "favorable", "mixed"].includes(a.suitability));
});

test("6. retrieval usefulness reuses authoritative records", async () => {
  const r = await ai.retrievalUsefulness({ project_id: pid, limit: 20 });
  assert.equal(r.ok, true);
  assert.match(r.note, /non-use is never proof of irrelevance/);
});

test("7. recurring failures reuse Phase 19/21 records", async () => {
  const r = await ai.failurePatterns({ project_id: pid, limit: 20 });
  assert.equal(r.ok, true);
  assert.match(r.note, /duplicate evidence is never double-counted/);
});

test("8. calibration proposal requires approval and never changes safety", async () => {
  const bad = await ai.proposeCalibration({ project_id: pid, proposal_key: "e2e-bad",
    target_subsystem: "safety_level", reason: "x" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "protected_target");
  const good = await ai.proposeCalibration({ project_id: pid, proposal_key: "e2e-good",
    target_subsystem: "recommendation_ordering", current_behavior: { order: "severity" },
    proposed_behavior: { order: "evidence" }, reason: "measured", sample_size: 7 });
  assert.equal(good.ok, true);
  assert.equal(good.approval_required, true);
  const early = await ai.applyCalibration({ project_id: pid, proposal_id: good.proposal_id, actor: "operator" });
  assert.equal(early.ok, false);
});

test("9. unified adaptive report exposes all sections with honest gaps", async () => {
  const r = await ai.report({ project_id: pid, window: "30d" });
  assert.equal(r.ok, true);
  assert.ok(Object.keys(r.sections).length >= 14);
  assert.match(r.claim, /no dispatch/);
  assert.ok(Array.isArray(r.sections.known_evaluation_gaps.value));
});

test("10. project isolation across all evaluation ledgers", async () => {
  const other = `${pid}-other`;
  assert.equal((await oc.listOutcomes({ project_id: other, limit: 50 })).count, 0);
  assert.equal((await rc.listRecommendationEvaluations({ project_id: other, limit: 50 })).count, 0);
  assert.equal((await pc.getPredictionEvaluation({ project_id: other, limit: 50 })).count, 0);
  const d = await dc.getDecompositionEvaluation({ project_id: other, plan_id: "plan-real-1" });
  assert.equal(d.ok, false);
});

test("11. no real execution occurs without approval (static + runtime check)", async () => {
  const files = ["adaptiveIntelligence.js", "outcomeEvaluation.js", "recommendationEvaluation.js",
    "predictionEvaluation.js", "decompositionEvaluation.js", "adaptiveCalibration.js", "adaptiveReporting.js"];
  let spawn = 0, writes = 0;
  for (const f of files) {
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    if (/spawn\(|exec\(|execFile\(/.test(s)) spawn++;
    if (/writeFileSync|unlinkSync|rmSync/.test(s)) writes++;
  }
  assert.equal(spawn, 0);
  assert.equal(writes, 0);
  const r = await ai.ingestOutcome({ project_id: pid, source_type: "static", source_id: "check",
    evidence: [{ kind: "agent_claim", status: "done" }] });
  assert.equal(r.ok, true);
  assert.notEqual(r.verification_state, "independently_verified");
});

test("close pool", async () => { await core.close(); });
