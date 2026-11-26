// Phase 19 workstream C — Debugging Experience tests.
// Deterministic analysis + evidence-graded, project-scoped persistence.
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase19-debugging-experience.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import {
  DEBUG_STAGES,
  analyzeDebugging,
  recordDebuggingExperience,
  getDebuggingExperiences,
  linkRecurringFailure,
} from "../src/debuggingExperience.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const uniq = () => `p19de-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

function shapeExperience(ex) {
  assert.ok(ex, "experience must exist");
  assert.deepEqual(Object.keys(ex).sort(), [
    "evidence", "failed_approaches", "fix", "investigation", "outcome",
    "problem", "root_cause", "root_cause_status", "symptoms", "verification",
    "environment",
  ].sort());
  for (const k of ["symptoms", "environment", "investigation", "failed_approaches", "evidence"]) {
    assert.ok(Array.isArray(ex[k]), `${k} must be an array`);
  }
  assert.ok(Array.isArray(ex.verification.evidence), "verification.evidence must be an array");
  assert.ok(["unverified", "observed", "verified", "regression_tested"].includes(ex.verification.status),
    `verification.status must be known, got ${ex.verification.status}`);
  assert.ok(["hypothesis", "confirmed"].includes(ex.root_cause_status));
}

// ---- 0. exports -------------------------------------------------------------
test("0. DEBUG_STAGES is frozen and enumerates the nine debugging stages", () => {
  assert.ok(Object.isFrozen(DEBUG_STAGES));
  const expected = ["problem", "symptoms", "environment", "investigation", "failed_approach", "root_cause", "fix", "verification", "outcome"];
  assert.deepEqual(Object.keys(DEBUG_STAGES), expected);
  assert.deepEqual(Object.values(DEBUG_STAGES), expected);
  assert.deepEqual([...DEBUG_STAGES], expected);
  assert.equal(DEBUG_STAGES.root_cause, "root_cause");
});

// ---- 1. connected debugging analysis ---------------------------------------
test("1. analyzeDebugging connects symptoms, environment and investigation from tool evidence", () => {
  const sid = `p19-session-${uniq()}`;
  const lines = [
    { role: "USER", text: "The add helper returns wrong values in the calc module", seq: 1, session_id: sid },
    { role: "TOOL", tool: "shell", text: "node v20.11.0 on Windows, postgres 16", seq: 2, session_id: sid },
    { role: "TOOL", tool: "shell", text: "pytest -q test_calc.py: FAILED test_calc.py::test_add - AssertionError: assert -1 == 5", seq: 3, session_id: sid },
    { role: "ASSISTANT", text: "I investigated the add helper and checked the source file", seq: 4, session_id: sid },
  ];
  const r = analyzeDebugging({ lines, project_id: `p19-${uniq()}`, session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.analyzed_lines, 4);
  shapeExperience(r.experience);
  assert.match(r.experience.problem, /add helper/);
  assert.ok(r.experience.symptoms.some((s) => /AssertionError/.test(s)), "a symptom must be captured");
  assert.ok(r.experience.environment.some((s) => /node v20/.test(s)), "environment must be captured");
  assert.ok(r.experience.investigation.some((s) => /investigated/.test(s)), "investigation must be captured");
  assert.ok(r.experience.evidence.length >= 4);
});

// ---- 2. hypothesis vs confirmed root cause ---------------------------------
test("2. assistant-only root cause is a hypothesis; tool-evidenced cause is confirmed", () => {
  const hypo = analyzeDebugging({ lines: [
    { role: "TOOL", text: "FAILED test_x.py::test_a - AssertionError: assert 1 == 2", seq: 1 },
    { role: "ASSISTANT", text: "I think the root cause is the cache being stale because the key was not invalidated", seq: 2 },
  ] });
  shapeExperience(hypo.experience);
  assert.equal(hypo.experience.root_cause_status, "hypothesis", "an AI explanation alone stays a hypothesis");
  assert.match(hypo.experience.root_cause, /cache/);

  const confirmed = analyzeDebugging({ lines: [
    { role: "TOOL", text: "FAILED test_x.py::test_a - AssertionError: assert 1 == 2", seq: 1 },
    { role: "TOOL", tool: "shell", text: "root cause: add() subtracts because the operator is wrong in calc.py", seq: 2 },
  ] });
  assert.equal(confirmed.experience.root_cause_status, "confirmed", "explicit tool evidence confirms the root cause");
});

// ---- 3. attempted vs verified vs regression-tested fix ----------------------
test("3. fix verification status distinguishes attempted, local and regression success", () => {
  const attempted = analyzeDebugging({ lines: [
    { role: "TOOL", text: "FAILED test_a.py - AssertionError: assert 1 == 2", seq: 1 },
    { role: "ASSISTANT", text: "I changed the config value to fix the failing check", seq: 2 },
  ] });
  assert.match(attempted.experience.fix, /fix/);
  assert.equal(attempted.experience.verification.status, "observed", "attempted fix, no pass evidence");

  const local = analyzeDebugging({ lines: [
    { role: "ASSISTANT", text: "I fixed the typo in the config", seq: 1 },
    { role: "TOOL", tool: "shell", text: "pytest -q test_cfg.py: 1 passed in 0.1s", seq: 2 },
  ] });
  assert.equal(local.experience.verification.status, "verified", "focused pass is local success");
  assert.match(local.experience.outcome, /locally verified only/);

  const regression = analyzeDebugging({ lines: [
    { role: "ASSISTANT", text: "I fixed the typo in the config", seq: 1 },
    { role: "TOOL", tool: "shell", text: "all tests: full test suite passed, regression check green", seq: 2 },
  ] });
  assert.equal(regression.experience.verification.status, "regression_tested", "full suite pass is regression-tested");
  assert.match(regression.experience.outcome, /regression-tested/);
});

// ---- 4. failed approaches preserved, not recommended ------------------------
test("4. failed approaches are preserved but never become the fix", () => {
  const r = analyzeDebugging({ lines: [
    { role: "USER", text: "Debug the add helper failure", seq: 1 },
    { role: "ASSISTANT", text: "First I tried swapping the arguments; that did not work and made no effect", seq: 2 },
    { role: "ASSISTANT", text: "I changed the operator to + to fix it", seq: 3 },
    { role: "TOOL", tool: "shell", text: "pytest -q test_calc.py: 1 passed", seq: 4 },
  ] });
  assert.ok(r.experience.failed_approaches.some((f) => /swapping the arguments/.test(f)), "failed approach preserved");
  assert.match(r.experience.fix, /operator/);
  assert.ok(!r.experience.fix.includes("swapping the arguments"), "failed approach is not the recommended fix");
  assert.match(r.experience.outcome, /do not retry/);
  assert.ok(r.experience.evidence.some((e) => e.kind === "failed_approach"));
});

// ---- 5. workaround vs permanent ---------------------------------------------
test("5. workaround is distinguished from a permanent fix", () => {
  const temp = analyzeDebugging({ lines: [
    { role: "ASSISTANT", text: "I changed the config as a temporary workaround for now to fix it", seq: 1 },
    { role: "TOOL", tool: "shell", text: "pytest -q test_cfg.py: 1 passed", seq: 2 },
  ] });
  assert.match(temp.experience.outcome, /workaround|temporary/);
  assert.ok(temp.experience.evidence.some((e) => e.kind === "workaround"));

  const perm = analyzeDebugging({ lines: [
    { role: "ASSISTANT", text: "I changed the config value to fix it permanently", seq: 1 },
    { role: "TOOL", tool: "shell", text: "pytest -q test_cfg.py: 1 passed", seq: 2 },
  ] });
  assert.match(perm.experience.outcome, /permanent fix/);
});

// ---- 6. dedupe ---------------------------------------------------------------
test("6. recordDebuggingExperience dedupes on (project_id,title) without overwrite", async () => {
  const project = `p19-proj-${uniq()}`;
  const title = "Recurring add-helper debugging";
  const a = await recordDebuggingExperience({ project_id: project, title,
    problem: "add helper wrong", result: "first result", failed_approaches: ["swap args"] });
  assert.equal(a.ok, true);
  assert.ok(a.id && !a.duplicate);
  const b = await recordDebuggingExperience({ project_id: project, title,
    problem: "different text that must not overwrite", result: "second result" });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id, "duplicate returns the existing id without overwriting");
  const list = await getDebuggingExperiences({ project_id: project });
  assert.equal(list.experiences.length, 1);
  assert.equal(list.experiences[0].result, "first result", "original content preserved");
});

// ---- 7. verification downgrade + fail closed --------------------------------
test("7. verification and root-cause claims are downgraded without evidence; empty inputs fail closed", async () => {
  const project = `p19-proj-${uniq()}`;
  const downgraded = await recordDebuggingExperience({ project_id: project,
    title: "Unproven fix", verification_status: "verified", root_cause_status: "confirmed", evidence: [] });
  assert.equal(downgraded.ok, true);
  const list = await getDebuggingExperiences({ project_id: project });
  assert.equal(list.experiences[0].verification_status, "observed", "verified downgraded with no evidence");
  assert.equal(list.experiences[0].root_cause_status, "hypothesis", "confirmed downgraded with no evidence");

  const kept = await recordDebuggingExperience({ project_id: project,
    title: "Proven fix", verification_status: "verified", root_cause_status: "confirmed",
    evidence: ["pytest -q: 1 passed", "root cause confirmed: operator was wrong"] });
  assert.equal(kept.ok, true);
  const list2 = await getDebuggingExperiences({ project_id: project });
  const row = list2.experiences.find((e) => e.id === kept.id);
  assert.equal(row.verification_status, "verified", "verification evidence keeps verified");
  assert.equal(row.root_cause_status, "confirmed", "root-cause evidence keeps confirmed");

  assert.equal((await recordDebuggingExperience({ project_id: "", title: "x" })).ok, false);
  assert.equal((await recordDebuggingExperience({ project_id: project, title: "  " })).ok, false);
});

// ---- 8. retrieval with limitations ------------------------------------------
test("8. getDebuggingExperiences is keyword-filtered and returns limitations", async () => {
  const project = `p19-proj-${uniq()}`;
  await recordDebuggingExperience({ project_id: project, title: "Stale cache debugging",
    problem: "stale cache after deploy caused wrong reads",
    root_cause: "cache key not invalidated", root_cause_status: "hypothesis",
    verification_status: "observed", failed_approaches: ["reverted config change"] });
  const hit = await getDebuggingExperiences({ project_id: project, problem_query: "stale cache" });
  assert.equal(hit.ok, true);
  assert.equal(hit.experiences.length, 1);
  const row = hit.experiences[0];
  assert.ok(Array.isArray(row.limitations) && row.limitations.length > 0);
  assert.ok(row.limitations.some((l) => /hypothesis/i.test(l)));
  assert.ok(row.limitations.some((l) => /failed approach/i.test(l)));
  assert.ok(row.limitations.some((l) => /not verified|observed/i.test(l)));
  const miss = await getDebuggingExperiences({ project_id: project, problem_query: "unrelated quantum" });
  assert.equal(miss.experiences.length, 0, "keyword filter must exclude non-matching experiences");
  assert.equal((await getDebuggingExperiences({ project_id: "" })).ok, false);
});

// ---- 9. recurring failure linkage -------------------------------------------
test("9. linkRecurringFailure appends evidence and preserves history", async () => {
  const project = `p19-proj-${uniq()}`;
  const created = await recordDebuggingExperience({ project_id: project, title: "Timeout debugging" });
  const sig = "AssertionError: assert -1 == 5 in test_add";
  const l1 = await linkRecurringFailure({ project_id: project, error_signature: sig,
    experience_id: created.id, evidence: ["session:abc", "API_KEY=sk-1234567890abcdefghijklmnop"] });
  assert.equal(l1.ok, true);
  assert.equal(l1.occurrences, 1);
  const l2 = await linkRecurringFailure({ project_id: project, error_signature: sig,
    experience_id: created.id });
  assert.equal(l2.ok, true);
  assert.equal(l2.occurrences, 2, "repeat link increments occurrence instead of overwriting");

  const rows = (await core.dbQuery("SELECT evidence FROM dev_experience WHERE id=$1", [created.id])).rows;
  const evidence = rows[0].evidence;
  const link = evidence.find((e) => e && e.kind === "recurring_failure");
  assert.ok(link, "linkage stored as evidence on the experience");
  assert.equal(link.occurrences, 2);
  assert.ok(!JSON.stringify(evidence).includes("sk-1234567890"), "secrets must be redacted from stored evidence");
  assert.ok(link.evidence.includes("session:abc"), "original evidence history is preserved inside the link");
  assert.equal((await linkRecurringFailure({ project_id: project, error_signature: "" , experience_id: created.id })).ok, false);
});

// ---- 10. project isolation ---------------------------------------------------
test("10. experiences and linkages are project-scoped", async () => {
  const a = `p19-A-${uniq()}`, b = `p19-B-${uniq()}`;
  const created = await recordDebuggingExperience({ project_id: a, title: "Isolated experience",
    problem: "private to project A" });
  const inA = await getDebuggingExperiences({ project_id: a });
  const inB = await getDebuggingExperiences({ project_id: b });
  assert.ok(inA.experiences.some((e) => e.id === created.id));
  assert.ok(!inB.experiences.some((e) => e.id === created.id), "other projects cannot see the experience");
  const cross = await linkRecurringFailure({ project_id: b, error_signature: "boom", experience_id: created.id });
  assert.equal(cross.ok, false, "cannot link a failure to another project's experience");
});

// ---- 11. malformed input -----------------------------------------------------
test("11. analyzeDebugging never throws on malformed or oversized input", () => {
  assert.doesNotThrow(() => {
    const a = analyzeDebugging();
    shapeExperience(a.experience);
    assert.equal(a.analyzed_lines, 0);

    const b = analyzeDebugging({ lines: null });
    shapeExperience(b.experience);

    const c = analyzeDebugging({ lines: [null, 42, "plain string", { text: 123 }, { role: {}, text: null }] });
    shapeExperience(c.experience);
    assert.equal(c.ok, true);

    const big = Array.from({ length: 200 }, (_, i) => ({ role: "TOOL", text: `error ${i}`, seq: i }));
    const d = analyzeDebugging({ lines: big });
    assert.equal(d.analyzed_lines, 80, "input is bounded to 80 lines");
    shapeExperience(d.experience);
  });
});

test("close pool", async () => { await core.close(); });
