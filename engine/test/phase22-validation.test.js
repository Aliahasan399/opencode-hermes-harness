// Phase 22 workstreams G+H+I — validation, integration coordination, workflow
// learning. Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase22-validation.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import {
  validateTaskResult, recordReview, getReviews, VALID_VERDICTS,
} from "../src/agentValidation.js";
import { integrateResults } from "../src/agentIntegration.js";
import {
  recordWorkflowExperience, agentPerformance,
} from "../src/agentWorkflowLearning.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const uniq = () => `p22-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const createdPlans = new Set();
const createdLearningIds = new Set();
function plan() { const p = uniq(); createdPlans.add(p); return p; }
function task() { return uniq(); }

async function insertExecution({ plan_id, task_id, project_id, agent, status = "completed", result = {}, error = null, attempts = 1 }) {
  await core.dbQuery(
    `INSERT INTO agent_execution (plan_id, task_id, project_id, agent, status, result, error, attempts)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [plan_id, task_id, project_id, agent, status, JSON.stringify(result), error, attempts],
  );
}

// ---- 0. exported verdict vocabulary ---------------------------------------
test("0. verdict vocabulary is the expected four values", () => {
  assert.deepEqual([...VALID_VERDICTS].sort(), ["accepted", "blocked", "needs_revision", "rejected"]);
});

// ---- 1. bare claim is never accepted --------------------------------------
test("1. a claimed result without verification evidence is rejected", async () => {
  const r = await validateTaskResult({
    plan_id: plan(), task_id: task(), project_id: uniq(), claimed_done: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "rejected");
  assert.ok(r.reasons.includes("no_explicit_verification"));
  assert.ok(r.reasons.includes("bare_claim_not_accepted"));
  assert.ok(Array.isArray(r.evidence));
});

// ---- 2. explicit verification evidence allows acceptance ------------------
test("2. an explicit test_pass marker allows acceptance; unauthorized files reject", async () => {
  const base = { plan_id: plan(), task_id: task(), project_id: uniq(), claimed_done: true };
  const ok = await validateTaskResult({
    ...base, test_results: [{ marker: "test_pass", success: true }],
    files_changed: ["src/a.js"], file_whitelist: ["src/a.js", "src/b.js"],
  });
  assert.equal(ok.verdict, "accepted");
  assert.ok(ok.evidence.some((e) => e.marker === "test_pass" && e.result === "success"));

  const strOk = await validateTaskResult({ ...base, test_results: ["test_pass: 3 passed"] });
  assert.equal(strOk.verdict, "accepted");

  const bad = await validateTaskResult({
    ...base, test_results: [{ marker: "test_pass", success: true }],
    files_changed: ["src/a.js", "src/evil.js"], file_whitelist: ["src/a.js"],
  });
  assert.equal(bad.verdict, "rejected");
  assert.ok(bad.reasons.includes("unauthorized_file_change"));

  const fail = await validateTaskResult({
    ...base, test_results: [{ marker: "test_result", success: false }],
  });
  assert.equal(fail.verdict, "rejected");
  assert.ok(fail.reasons.includes("explicit_verification_failure"));
});

// ---- 3. review is recorded and audited content-free -----------------------
test("3. a review is stored redacted and audited without content", async () => {
  const pl = plan(), t = task(), proj = uniq();
  const secret = "sk-1234567890abcdefghijklmnop";
  const reasonText = `applied fix using token=${secret}`;
  const rec = await recordReview({
    plan_id: pl, task_id: t, project_id: proj, verdict: "accepted",
    reasons: [reasonText], evidence: [{ marker: "test_pass", success: true, note: secret }],
  });
  assert.equal(rec.ok, true);
  assert.ok(rec.id);

  const list = await getReviews({ plan_id: pl, task_id: t, project_id: proj });
  assert.equal(list.count, 1);
  assert.ok(!JSON.stringify(list).includes(secret), "redacted on read");

  const aud = await core.dbQuery(
    "SELECT detail FROM audit_log WHERE action='agent.review_recorded' AND resource LIKE $1",
    [`%${pl}%`],
  );
  assert.ok(aud.rows.length >= 1);
  const detail = JSON.stringify(aud.rows[aud.rows.length - 1].detail);
  assert.ok(!detail.includes(secret), "audit has no secret");
  assert.ok(!detail.includes("applied fix"), "audit has no reason content");
  assert.ok(detail.includes("reason_count"), "audit stores counts only");
});

// ---- 4. integration detects overlaps and incompatible verdicts ------------
test("4. integration reports file overlaps and incompatible verdicts without discarding work", async () => {
  const pl = plan(), proj = uniq();
  const t1 = task(), t2 = task(), t3 = task();
  await insertExecution({ plan_id: pl, task_id: t1, project_id: proj, agent: "agentA", result: { files_changed: ["src/shared.js"] } });
  await insertExecution({ plan_id: pl, task_id: t2, project_id: proj, agent: "agentB", result: { files_changed: ["src/shared.js"] } });
  await insertExecution({ plan_id: pl, task_id: t3, project_id: proj, agent: "agentA", status: "failed", error: "boom", result: {} });
  // Insert rejected first, accepted last so the newest review wins for t1.
  await recordReview({ plan_id: pl, task_id: t1, project_id: proj, verdict: "rejected", reasons: [], evidence: [] });
  await recordReview({ plan_id: pl, task_id: t1, project_id: proj, verdict: "accepted", reasons: [], evidence: [] });

  const r = await integrateResults({ plan_id: pl, project_id: proj });
  assert.equal(r.ok, true);
  const rep = r.report;
  assert.ok(rep.overlaps.some((o) => o.file === "src/shared.js" && o.tasks.length >= 2), "overlap detected");
  assert.ok(rep.integration_failures.some((f) => f.type === "incompatible_verdicts" && f.task_id === t1),
    "incompatible verdicts detected");
  assert.equal(rep.accepted + rep.rejected + rep.needs_revision + rep.blocked, 3, "no work discarded");
  assert.ok(rep.notes.some((n) => /no work discarded/i.test(n)));
  assert.ok(rep.notes.some((n) => /no git operations/i.test(n)));
});

// ---- 5. workflow learning is idempotent -----------------------------------
test("5. recording the same workflow twice is idempotent", async () => {
  const pl = plan(), proj = uniq();
  const payload = {
    plan_id: pl, project_id: proj,
    tasks: [{ id: "t1", assigned_agent: "agentA" }, { id: "t2", assigned_agent: "agentA" }],
    reviews: [{ task_id: "t1", verdict: "accepted", evidence: ["test_pass: 2 passed"] }],
    executions: [{ task_id: "t1", agent: "agentA", status: "completed", result: {} }],
    outcome: "success",
  };
  const a = await recordWorkflowExperience(payload);
  assert.equal(a.ok, true);
  assert.ok(a.learning_id, "a learning id is returned");
  assert.equal(a.duplicate, false);
  createdLearningIds.add(a.learning_id);

  const b = await recordWorkflowExperience(payload);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true, "second call is a duplicate");
  assert.equal(b.learning_id, a.learning_id);

  const le = await import("../src/learningExperience.js");
  const got = await le.getLearningExperiences({ project_id: proj });
  assert.ok(got.items.some((x) => x.id === a.learning_id && x.category === "workflow"));
});

// ---- 6. agent performance aggregate ---------------------------------------
test("6. agentPerformance aggregates executions and reviews", async () => {
  const pl = plan(), proj = uniq(), agent = `perf-${uniq()}`;
  const ta = task(), tb = task(), tc = task();
  await insertExecution({ plan_id: pl, task_id: ta, project_id: proj, agent, status: "completed", result: {} });
  await insertExecution({ plan_id: pl, task_id: tb, project_id: proj, agent, status: "completed", result: {} });
  await insertExecution({ plan_id: pl, task_id: tc, project_id: proj, agent, status: "failed", error: "x", result: {} });
  await recordReview({ plan_id: pl, task_id: ta, project_id: proj, verdict: "accepted", reasons: [], evidence: [] });
  await recordReview({ plan_id: pl, task_id: tb, project_id: proj, verdict: "rejected", reasons: [], evidence: [] });

  const perf = await agentPerformance({ project_id: proj, agent });
  assert.equal(perf.ok, true);
  assert.equal(perf.total, 3);
  assert.equal(perf.accepted, 1);
  assert.equal(perf.rejected, 1);
  assert.equal(perf.failed, 1);
  assert.ok(perf.note.includes("Read-only"));
});

// ---- 7. project isolation --------------------------------------------------
test("7. reads are strictly project-scoped", async () => {
  const pl = plan(), projA = uniq(), projB = uniq();
  const t = task();
  await insertExecution({ plan_id: pl, task_id: t, project_id: projA, agent: "iso" });
  await recordReview({ plan_id: pl, task_id: t, project_id: projA, verdict: "accepted" });

  assert.equal((await getReviews({ project_id: projB })).count, 0);
  const otherInt = await integrateResults({ plan_id: pl, project_id: projB });
  assert.equal(otherInt.ok, true);
  assert.equal(otherInt.report.accepted + otherInt.report.rejected + otherInt.report.needs_revision + otherInt.report.blocked, 0);
  const otherPerf = await agentPerformance({ project_id: projB, agent: "iso" });
  assert.equal(otherPerf.total, 0);
});

// ---- 8. invalid input fails closed ----------------------------------------
test("8. invalid inputs fail closed without throwing", async () => {
  assert.equal((await validateTaskResult({})).verdict, "blocked");
  assert.equal((await recordReview({ plan_id: "p", task_id: "t", project_id: "p", verdict: "bogus" })).ok, false);
  assert.equal((await recordReview({ plan_id: "", task_id: "t", project_id: "p", verdict: "accepted" })).ok, false);
  assert.equal((await getReviews({})).ok, false);
  assert.equal((await integrateResults({})).ok, false);
  assert.equal((await recordWorkflowExperience({ project_id: "_global" })).ok, false);
  assert.equal((await agentPerformance({})).ok, false);
  assert.equal((await agentPerformance({ project_id: "p", agent: "a", limit: -5 })).total, 0);
});

// ---- cleanup + close pool (once) ------------------------------------------
test("close pool", async () => {
  const plans = [...createdPlans];
  if (plans.length) {
    await core.dbQuery("DELETE FROM agent_review WHERE plan_id = ANY($1)", [plans]);
    await core.dbQuery("DELETE FROM agent_execution WHERE plan_id = ANY($1)", [plans]);
  }
  const ids = [...createdLearningIds];
  if (ids.length) await core.dbQuery("DELETE FROM learning_record WHERE id = ANY($1)", [ids]);
  await core.close();
});
