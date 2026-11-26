// Phase 21 workstream A — automatic experience extraction + project-scoped
// evidence-backed persistence. Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase21-experience.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import {
  EXPERIENCE_CATEGORIES,
  extractExperiences,
  recordLearningExperience,
  getLearningExperiences,
  getLearningBySession,
} from "../src/learningExperience.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const uniq = () => `p21-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// ---- 0. exports -------------------------------------------------------------
test("0. EXPERIENCE_CATEGORIES is frozen and holds the seven categories", () => {
  assert.ok(Object.isFrozen(EXPERIENCE_CATEGORIES));
  assert.deepEqual(Object.values(EXPERIENCE_CATEGORIES).sort(), [
    "correction", "debugging", "decision", "failure", "pattern", "success", "workflow",
  ]);
});

// ---- 1. passing test command => success + verified --------------------------
test("1. a passing test command is extracted as verified success", async () => {
  const sid = `p21-s-${uniq()}`;
  const r = await extractExperiences({
    session_id: sid, project_id: `p21-${uniq()}`,
    lines: [
      { role: "USER", text: "Fix the add helper in calc module", seq: 1 },
      { role: "ASSISTANT", text: "I will update calc.js and run the tests", seq: 2 },
      { role: "TOOL", tool: "shell", text: "pytest -q test_calc.py: 1 passed in 0.1s", seq: 3 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.analyzed_lines, 3);
  const hit = r.experiences.find((e) => e.category === "success");
  assert.ok(hit, "a success experience must be produced");
  assert.equal(hit.outcome, "success");
  assert.equal(hit.verification, "verified");
  assert.ok(hit.evidence.length >= 1);
  assert.ok(hit.confidence_hint > 0);
});

// ---- 2. tool error with no fix => failure -----------------------------------
test("2. an unresolved tool error is extracted as a failure (observed)", async () => {
  const r = await extractExperiences({ lines: [
    { role: "USER", text: "Run the project test suite", seq: 1 },
    { role: "TOOL", tool: "shell", text: "pytest -q: 2 failed, AssertionError: assert -1 == 5", seq: 2 },
  ] });
  const hit = r.experiences.find((e) => e.category === "failure");
  assert.ok(hit, "a failure experience must be produced");
  assert.equal(hit.outcome, "failure");
  assert.equal(hit.verification, "observed");
});

// ---- 3. error followed by a fix => debugging --------------------------------
test("3. an error with a later fix is extracted as debugging", async () => {
  const r = await extractExperiences({ lines: [
    { role: "USER", text: "Debug the add helper failure", seq: 1 },
    { role: "TOOL", tool: "shell", text: "FAILED test_calc.py::test_add - AssertionError: assert -1 == 5", seq: 2 },
    { role: "ASSISTANT", text: "I changed the operator in calc.py to fix it", seq: 3 },
    { role: "TOOL", tool: "shell", text: "pytest -q test_calc.py: 1 passed", seq: 4 },
  ] });
  assert.ok(r.experiences.some((e) => e.category === "debugging"), "debugging experience expected");
  assert.ok(r.experiences.some((e) => e.category === "success"), "the pass is also a verified success");
});

// ---- 4. user correction => correction ---------------------------------------
test("4. explicit user correction text is extracted as a correction", async () => {
  const r = await extractExperiences({ lines: [
    { role: "ASSISTANT", text: "Use fetch with a GET request for the call", seq: 1 },
    { role: "USER", text: "No, use axios instead and add a timeout", seq: 2 },
  ] });
  const hit = r.experiences.find((e) => e.category === "correction");
  assert.ok(hit, "a correction experience must be produced");
  assert.equal(hit.verification, "observed");
  assert.match(hit.approach, /axios/);
});

// ---- 5. assistant claim alone is never verified ----------------------------
test("5. a bare assistant claim is uncertain/observed, never verified", async () => {
  const r = await extractExperiences({ lines: [
    { role: "USER", text: "Fix the failing bug", seq: 1 },
    { role: "ASSISTANT", text: "I fixed the bug and all tests pass now", seq: 2 },
  ] });
  assert.ok(!r.experiences.some((e) => e.verification === "verified"),
    "no experience may be verified without tool evidence");
  assert.ok(!r.experiences.some((e) => e.outcome === "success"),
    "no experience may claim success without tool evidence");
  const pattern = r.experiences.find((e) => e.category === "pattern");
  assert.ok(pattern, "an observed pattern experience is produced for the claim");
  assert.equal(pattern.outcome, "uncertain");
  assert.equal(pattern.verification, "observed");
});

// ---- 6. duplicate signature is idempotent ----------------------------------
test("6. recording the same signature twice is idempotent", async () => {
  const project = `p21-proj-${uniq()}`;
  const sid = `p21-s-${uniq()}`;
  const extracted = (await extractExperiences({ lines: [
    { role: "USER", text: "Add the missing helper", seq: 1 },
    { role: "TOOL", tool: "shell", text: "pytest -q: 1 passed", seq: 2 },
  ] })).experiences[0];
  const payload = { ...extracted, project_id: project, session_id: sid,
    confidence: extracted.confidence_hint };
  const a = await recordLearningExperience(payload);
  assert.equal(a.ok, true);
  assert.equal(a.created, true);
  const b = await recordLearningExperience(payload);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  const list = await getLearningBySession({ session_id: sid, project_id: project });
  assert.equal(list.count, 1);
});

// ---- 7. duplicate preserves history and never overwrites --------------------
test("7. duplicate appends evidence to history and preserves original fields", async () => {
  const project = `p21-proj-${uniq()}`;
  const sid = `p21-s-${uniq()}`;
  const signature = `p21-sig-${uniq()}`;
  const first = await recordLearningExperience({ project_id: project, session_id: sid,
    signature, category: "debugging", problem: "original problem", approach: "original approach",
    outcome: "uncertain", verification: "observed", confidence: 0.5,
    evidence: ["session:first"] });
  assert.equal(first.created, true);
  const second = await recordLearningExperience({ project_id: project, session_id: sid,
    signature, problem: "OVERWRITE", approach: "OVERWRITE", verification: "observed",
    confidence: 0.99, evidence: ["session:second"] });
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const list = await getLearningExperiences({ project_id: project });
  assert.equal(list.count, 1);
  const row = list.items[0];
  assert.equal(row.problem, "original problem", "original content is never overwritten");
  assert.equal(row.approach, "original approach");
  assert.equal(row.status, "active", "status is kept");
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const history = evidence.find((e) => e && typeof e === "object" && e.event === "learning.record_duplicate");
  assert.ok(history, "a duplicate-history entry must be stored");
  assert.ok(Array.isArray(history.history) && history.history.includes("session:second"),
    "new evidence is appended into the history");
  assert.ok(evidence.includes("session:first"), "original evidence is preserved");
});

// ---- 8. no cross-project writes --------------------------------------------
test("8. records are strictly project-scoped and '_global' is rejected", async () => {
  const a = `p21-A-${uniq()}`, b = `p21-B-${uniq()}`, c = `p21-C-${uniq()}`;
  const sid = `p21-s-${uniq()}`;
  const sig = `shared-${uniq()}`;
  const ra = await recordLearningExperience({ project_id: a, session_id: sid, signature: sig });
  const rb = await recordLearningExperience({ project_id: b, session_id: sid, signature: sig });
  assert.equal(ra.created, true);
  assert.equal(rb.created, true, "the same signature in a different project is a new row");
  assert.notEqual(ra.id, rb.id);
  assert.equal((await getLearningExperiences({ project_id: c })).count, 0);
  const inB = await getLearningBySession({ session_id: sid, project_id: b });
  assert.equal(inB.count, 1);
  assert.equal(inB.items[0].id, rb.id, "a session lookup cannot cross project boundaries");
  assert.equal((await recordLearningExperience({ project_id: "_global", signature: sig })).ok, false);
  assert.equal((await recordLearningExperience({ project_id: "", signature: sig })).ok, false);
});

// ---- 9. bounded long transcript --------------------------------------------
test("9. a long transcript is bounded and fields stay short", async () => {
  const big = Array.from({ length: 200 }, (_, i) => ({
    role: "TOOL", tool: "shell", text: `pytest failure error number ${i}`, seq: i + 1,
  }));
  const r = await extractExperiences({ lines: big });
  assert.equal(r.ok, true);
  assert.equal(r.analyzed_lines, 80, "input is bounded to 80 lines");
  assert.ok(r.experiences.length <= 12, "experience count is bounded");
  for (const e of r.experiences) {
    assert.ok(e.problem.length <= 240);
    assert.ok(e.approach.length <= 240);
    assert.ok(e.evidence.length <= 6);
    for (const ev of e.evidence) assert.ok(ev.excerpt.length <= 160);
  }
});

// ---- 10. secret redaction ---------------------------------------------------
test("10. secrets are redacted before extraction and persistence", async () => {
  const secret = "sk-1234567890abcdefghijklmnop";
  const project = `p21-proj-${uniq()}`;
  const r = await extractExperiences({ lines: [
    { role: "USER", text: `Fix config with API_KEY=${secret}`, seq: 1 },
    { role: "TOOL", tool: "shell", text: `pytest -q: 1 passed using token=${secret}`, seq: 2 },
  ] });
  assert.ok(!JSON.stringify(r.experiences).includes(secret), "extraction redacts secrets");
  const success = r.experiences.find((e) => e.category === "success");
  assert.ok(success);
  const saved = await recordLearningExperience({ ...success, project_id: project,
    confidence: success.confidence_hint });
  assert.equal(saved.ok, true);
  const row = (await getLearningExperiences({ project_id: project })).items[0];
  assert.ok(!JSON.stringify(row).includes(secret), "stored record has no raw secret");
});

// ---- 11. invalid inputs fail closed ----------------------------------------
test("11. invalid inputs fail closed without throwing", async () => {
  const r0 = await extractExperiences();
  assert.equal(r0.ok, true);
  assert.equal(r0.analyzed_lines, 0);
  assert.deepEqual(r0.experiences, []);
  assert.ok(Array.isArray(r0.degraded));
  assert.equal((await extractExperiences({ lines: [null, 42, "text", { text: 5 }] })).ok, true);
  assert.equal((await recordLearningExperience({ project_id: "p", signature: "" })).ok, false);
  assert.equal((await recordLearningExperience({ project_id: "p", signature: "s", evidence: "no" })).ok, false);
  assert.equal((await getLearningExperiences({ project_id: "" })).ok, false);
  assert.equal((await getLearningBySession({ session_id: "s" })).ok, false);
  assert.equal((await getLearningExperiences({ project_id: "p", category: "bogus" })).ok, false);
});

// ---- 12. verification is never auto-promoted -------------------------------
test("12. verification promotion requires strictly stronger evidence", async () => {
  const project = `p21-proj-${uniq()}`;
  const sig1 = `v1-${uniq()}`;
  await recordLearningExperience({ project_id: project, signature: sig1,
    verification: "inferred", confidence: 0.4, evidence: ["initial observation"] });
  await recordLearningExperience({ project_id: project, signature: sig1,
    verification: "verified", confidence: 0.95, evidence: ["pytest -q: 1 passed"] });
  let row = (await getLearningExperiences({ project_id: project })).items.find((x) => x.signature === sig1);
  assert.equal(row.verification, "inferred", "inferred is never promoted to verified");

  const sig2 = `v2-${uniq()}`;
  await recordLearningExperience({ project_id: project, signature: sig2,
    verification: "observed", confidence: 0.5, evidence: ["a plain note"] });
  const weak = await recordLearningExperience({ project_id: project, signature: sig2,
    verification: "verified", confidence: 0.9, evidence: ["another plain note"] });
  assert.equal(weak.promoted, false);
  row = (await getLearningExperiences({ project_id: project })).items.find((x) => x.signature === sig2);
  assert.equal(row.verification, "observed", "no explicit verification evidence => no promotion");

  const sig3 = `v3-${uniq()}`;
  await recordLearningExperience({ project_id: project, signature: sig3,
    verification: "observed", confidence: 0.5, evidence: ["a plain note"] });
  const strong = await recordLearningExperience({ project_id: project, signature: sig3,
    verification: "verified", confidence: 0.9, evidence: ["pytest -q: 1 passed"] });
  assert.equal(strong.promoted, true);
  row = (await getLearningExperiences({ project_id: project })).items.find((x) => x.signature === sig3);
  assert.equal(row.verification, "verified", "explicit evidence allows promotion");
});

// ---- 13. filtered, bounded reads -------------------------------------------
test("13. getLearningExperiences and getLearningBySession filter and bound", async () => {
  const project = `p21-proj-${uniq()}`;
  const sid = `p21-s-${uniq()}`;
  for (const [cat, sig] of [["success", `a-${uniq()}`], ["failure", `b-${uniq()}`], ["correction", `c-${uniq()}`]]) {
    const r = await recordLearningExperience({ project_id: project, session_id: sid, signature: sig,
      category: cat, verification: "observed" });
    assert.equal(r.created, true);
  }
  assert.equal((await getLearningExperiences({ project_id: project })).count, 3);
  assert.equal((await getLearningExperiences({ project_id: project, category: "success" })).count, 1);
  assert.equal((await getLearningExperiences({ project_id: project, status: "active" })).count, 3);
  assert.equal((await getLearningExperiences({ project_id: project, limit: 2 })).count, 2);
  assert.equal((await getLearningBySession({ session_id: sid, project_id: project })).count, 3);
});

// ---- close pool -------------------------------------------------------------
test("close pool", async () => { await core.close(); });
