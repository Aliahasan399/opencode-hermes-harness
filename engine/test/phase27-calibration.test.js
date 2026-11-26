import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const ac = await import("../src/adaptiveCalibration.js");
const ar = await import("../src/adaptiveReporting.js");
const facade = await import("../src/adaptiveIntelligence.js");
const pipelineAudit = await import("../src/pipelineAudit.js");

const pid = `p27-cal-${crypto.randomUUID().slice(0, 8)}`;
const DDL = `CREATE TABLE IF NOT EXISTS ai_calibration_proposal (id uuid PRIMARY KEY, project_id text NOT NULL, proposal_key text NOT NULL, target_subsystem text NOT NULL DEFAULT '', current_behavior jsonb NOT NULL DEFAULT '{}'::jsonb, proposed_behavior jsonb NOT NULL DEFAULT '{}'::jsonb, reason text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, sample_size integer NOT NULL DEFAULT 0, confidence real NOT NULL DEFAULT 0, expected_benefit text NOT NULL DEFAULT '', potential_downside text NOT NULL DEFAULT '', reversal text NOT NULL DEFAULT '', approval_required boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'proposed', actor text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, proposal_key))`;
try { await core.dbQuery(DDL); } catch { /* migration 025 normally applied */ }

test("0. exact exports", () => {
  assert.deepEqual(Object.keys(ac.default).sort(), ["applyCalibration", "listCalibrationProposals", "proposeCalibration", "reviewCalibration", "rollbackCalibration"]);
  assert.deepEqual(Object.keys(ar.default).sort(), ["adaptiveReport"]);
});

test("1. bounded proposal target succeeds and requires approval", async () => {
  const r = await ac.proposeCalibration({ project_id: pid, proposal_key: "c1",
    target_subsystem: "recommendation_ordering", current_behavior: { order: "severity" },
    proposed_behavior: { order: "evidence" }, reason: "test", sample_size: 12, evidence: [{ kind: "evaluation" }] });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.approval_required, true);
  assert.equal(r.status, "proposed");
});

test("2. all protected targets are blocked", async () => {
  for (const target of ["safety_level", "approval_gates", "execution_permissions", "project_isolation",
    "secret_handling", "verification_gates"]) {
    const r = await ac.proposeCalibration({ project_id: pid, proposal_key: `blocked-${target}`,
      target_subsystem: target, reason: "attempt" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "protected_target");
  }
});

test("3. review requires actor and valid decision", async () => {
  const bad = await ac.reviewCalibration({ project_id: pid, proposal_id: "x", decision: "approve" });
  assert.equal(bad.ok, false);
  const bad2 = await ac.reviewCalibration({ project_id: pid, proposal_id: "x", decision: "maybe", actor: "op" });
  assert.equal(bad2.ok, false);
});

test("4. apply requires explicit approval", async () => {
  const row = (await core.dbQuery("SELECT id FROM ai_calibration_proposal WHERE project_id=$1 AND proposal_key='c1'", [pid])).rows[0];
  const r = await ac.applyCalibration({ project_id: pid, proposal_id: row.id, actor: "operator" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /approved/);
});

test("5. approve -> apply -> rollback with audit and previous config", async () => {
  const row = (await core.dbQuery("SELECT id FROM ai_calibration_proposal WHERE project_id=$1 AND proposal_key='c1'", [pid])).rows[0];
  const reviewed = await ac.reviewCalibration({ project_id: pid, proposal_id: row.id, decision: "approve", actor: "operator" });
  assert.equal(reviewed.ok, true);
  const applied = await ac.applyCalibration({ project_id: pid, proposal_id: row.id, actor: "operator" });
  assert.equal(applied.ok, true);
  assert.equal(applied.status, "applied");
  assert.match(applied.note, /NO production behavior/);
  assert.ok(applied.previous);
  const rolled = await ac.rollbackCalibration({ project_id: pid, proposal_id: row.id, actor: "operator" });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.status, "rolled_back");
});

test("6. proposal idempotency and bounded listing", async () => {
  const a = await ac.proposeCalibration({ project_id: pid, proposal_key: "idem", target_subsystem: "confidence_calibration" });
  const b = await ac.proposeCalibration({ project_id: pid, proposal_key: "idem", target_subsystem: "confidence_calibration" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  const l = await ac.listCalibrationProposals({ project_id: pid, limit: 9999 });
  assert.equal(l.ok, true);
  assert.ok(l.count <= 200);
});

test("7. report has all sections with metric metadata and no invented percentages", async () => {
  const r = await ar.adaptiveReport({ project_id: pid, window: "30d", _load: {
    learningEngine: async () => ({ learningStatus: async () => ({ ok: true, counts: { verified: 2, observed: 3 } }) }),
    retrievalFeedback: async () => ({ usefulnessSummary: async () => ({ ok: true, buckets: { observed_usage: 4 } }) }),
    agentWorkflowLearning: async () => ({ agentPerformance: async () => ({ ok: true, items: [] }) }),
    errorLearning: async () => ({ fixEvidenceReport: async () => ({ ok: true, items: [] }) }),
    learningIntelligence: async () => ({ getPatterns: async () => ({ ok: true, items: [] }) }),
  } });
  assert.equal(r.ok, true);
  for (const k of ["learning_activity", "verified_experiences", "unverified_experiences", "recommendation_outcomes",
    "prediction_evaluation", "retrieval_usefulness", "decomposition_outcomes", "agent_selection_evidence",
    "recurring_failures", "learning_quality", "calibration_proposals", "confidence_changes",
    "known_evaluation_gaps", "recommended_improvements"]) {
    assert.ok(k in r.sections, `missing section ${k}`);
    const m = r.sections[k];
    assert.ok("meaning" in m && "denominator" in m && "window" in m && "evidence_source" in m
      && "verification_requirement" in m && "limitation" in m, `${k} missing metric metadata`);
  }
  assert.doesNotMatch(JSON.stringify(r), /\d+(\.\d+)?\s*%/);
  assert.match(r.claim, /no source rewrite/);
});

test("8. facade delegates and rejects invalid scope", async () => {
  for (const op of ["ingestOutcome", "evaluateRecommendation", "evaluatePrediction", "evaluateDecomposition",
    "agentSuitability", "proposeCalibration", "reviewCalibration", "applyCalibration", "rollbackCalibration",
    "retrievalUsefulness", "failurePatterns", "learningQuality", "evaluations", "proposals", "report"]) {
    let r;
    try { r = await facade[op]({ project_id: "_global", proposal_id: "x", agent: "a" }); }
    catch (e) { assert.fail(`${op} must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false, `${op} must reject _global`);
  }
  const rep = await facade.report({ project_id: pid });
  assert.equal(rep.ok, true);
});

test("9. adversarial: no source rewriting, spawn, unsafe env, or approval bypass in p27 modules", () => {
  const files = ["adaptiveIntelligence.js", "outcomeEvaluation.js", "recommendationEvaluation.js",
    "predictionEvaluation.js", "decompositionEvaluation.js", "adaptiveCalibration.js", "adaptiveReporting.js"];
  for (const f of files) {
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /writeFileSync|appendFileSync|unlinkSync|rmSync/, `${f} writes files`);
    assert.doesNotMatch(s, /\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(/, `${f} spawns`);
    assert.doesNotMatch(s, /process\.env\.(OPTIMIZATION_LEVEL|HARNESS_SEMANTIC_LLM)\s*=/, `${f} sets safety env`);
    assert.doesNotMatch(s, /auto_execute\s*:\s*true/, `${f} enables auto_execute`);
  }
  assert.notEqual(process.env.OPTIMIZATION_LEVEL, "3");
  assert.notEqual(process.env.HARNESS_SEMANTIC_LLM, "1");
});

test("10. adversarial: cross-project isolation for calibration proposals", async () => {
  const other = `${pid}-other`;
  const l = await ac.listCalibrationProposals({ project_id: other, limit: 50 });
  assert.equal(l.count, 0);
  const row = (await core.dbQuery("SELECT id FROM ai_calibration_proposal WHERE project_id=$1 AND proposal_key='c1'", [pid])).rows[0];
  const r = await ac.reviewCalibration({ project_id: other, proposal_id: row.id, decision: "approve", actor: "op" });
  assert.equal(r.ok, false);
});

test("11. pipeline audit covers Phase 27 without runtime claims", () => {
  const a = pipelineAudit.auditPipelineIntegrity();
  assert.equal(a.ok, true);
  assert.ok(Object.keys(a.sources.phase27).length >= 7);
  assert.equal(a.verifiedBehavior, false);
  assert.ok(a.checks.filter((c) => c.id.startsWith("p27.")).length >= 12);
});

test("12. FINAL degradation after database close", async () => {
  await core.close();
  const r = await facade.report({ project_id: pid });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.degraded));
  const l = await ac.listCalibrationProposals({ project_id: pid });
  assert.equal(l.ok, false);
});
