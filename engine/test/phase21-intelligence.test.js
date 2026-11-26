// Phase 21 workstream B — learning intelligence tests.
// Outcome analysis, evidence-backed confidence and pattern recognition over the
// EXISTING pattern / pattern_evidence tables. No LLM, no network.
//
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase21-intelligence.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const li = await import("../src/learningIntelligence.js");

const uniq = () => `p21li${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

async function insertLearning({
  project, session = null, signature, category = "successful_solution",
  problem = "widget retry fix", approach = "applied known remedy",
  outcome = "success", verification = "verified", confidence = 0.1, evidence = [],
}) {
  const id = crypto.randomUUID();
  await core.dbQuery(
    `INSERT INTO learning_record
       (id, project_id, session_id, signature, category, problem, approach, outcome,
        verification, confidence, confidence_breakdown, evidence, reusability, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,'project','active')`,
    [id, project, session, signature, category, problem, approach, outcome, verification,
      confidence, "{}", JSON.stringify(evidence)],
  );
  return id;
}

async function insertFeedback({ project, learning_id, verdict, explicit = false }) {
  await core.dbQuery(
    `INSERT INTO learning_feedback (project_id, learning_id, verdict, explicit_feedback, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [project, learning_id, verdict, explicit, "phase21 test", "[]"],
  );
}

// ===========================================================================
// A. Outcome analysis (pure)
// ===========================================================================

test("1. success from explicit test_pass evidence is verified", () => {
  const r = li.analyzeOutcome({
    experience: { outcome: "success", explanation: "I believe it worked" },
    evidence: [{ marker: "test_pass", value: "true" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "success");
  assert.equal(r.verified, true);
  assert.match(r.reason, /explicit verification marker/i);
});

test("2. failure from explicit verification_result evidence is verified", () => {
  const r = li.analyzeOutcome({ evidence: [{ type: "verification_result", value: "fail" }] });
  assert.equal(r.outcome, "failure");
  assert.equal(r.verified, true);
});

test("3. tool_result success and failure exit codes are verified", () => {
  const ok = li.analyzeOutcome({ evidence: [{ type: "tool_result", exit_code: 0 }] });
  const bad = li.analyzeOutcome({ evidence: [{ type: "tool_result", exit_code: 1 }] });
  assert.equal(ok.outcome, "success");
  assert.equal(ok.verified, true);
  assert.equal(bad.outcome, "failure");
  assert.equal(bad.verified, true);
});

test("4. an AI explanation alone never verifies", () => {
  const cases = [
    li.analyzeOutcome({ experience: { explanation: "All tests passed, trust me" } }),
    li.analyzeOutcome({ experience: { verification: "verified", outcome: "success" } }),
    li.analyzeOutcome({ evidence: ["I am sure the build succeeded"] }),
    li.analyzeOutcome({ evidence: [{ marker: "explanation", value: "success" }] }),
  ];
  for (const r of cases) {
    assert.equal(r.verified, false, "no explicit marker => not verified");
    assert.equal(r.ok, true);
  }
  assert.equal(cases[1].outcome, "success", "declared outcome still reported, but unverified");
});

test("5. uncertain when nothing determinate is available", () => {
  const r = li.analyzeOutcome({});
  assert.equal(r.outcome, "uncertain");
  assert.equal(r.verified, false);
  const r2 = li.analyzeOutcome({ evidence: [{ marker: "test_pass", note: "ran the suite" }] });
  assert.equal(r2.outcome, "uncertain", "marker without a determinate result is not a signal");
  assert.equal(r2.verified, false);
});

test("6. analyzeOutcome is defensive against invalid input", () => {
  for (const bad of [null, undefined, 123, "text", [], { experience: null, evidence: "x" }]) {
    let r;
    assert.doesNotThrow(() => { r = li.analyzeOutcome(bad); });
    assert.equal(r.ok, true);
    assert.ok(["success", "failure", "uncertain"].includes(r.outcome));
    assert.equal(typeof r.verified, "boolean");
  }
});

// ===========================================================================
// B. Explainable confidence (pure)
// ===========================================================================

test("7. verification sets the base; observed never exceeds the unverified cap", () => {
  const observed = li.calculateConfidence({ verification: "observed" });
  const verified = li.calculateConfidence({ verification: "verified" });
  assert.equal(observed.ok, true);
  assert.ok(observed.confidence <= 0.5);
  assert.ok(verified.confidence > observed.confidence);
  assert.ok(verified.confidence > 0.5);
});

test("8. repeated unverified claims are capped at 0.5", () => {
  const r = li.calculateConfidence({
    verification: "inferred", occurrences: 500, evidence_quality: 1,
    supports: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}` })),
  });
  assert.ok(r.confidence <= 0.5, `expected <= 0.5, got ${r.confidence}`);
  assert.equal(r.breakdown.unverified_cap_applied, true);
  assert.equal(r.breakdown.occurrence_bonus, 0, "unverified repetition earns no bonus");
});

test("9. verification allows a bounded occurrence bonus", () => {
  const one = li.calculateConfidence({ verification: "verified", occurrences: 1 });
  const many = li.calculateConfidence({ verification: "verified", occurrences: 100 });
  assert.ok(many.confidence > one.confidence);
  assert.ok(many.breakdown.occurrence_bonus <= 0.10, "occurrence bonus is capped");
  assert.ok(many.confidence <= 1);
});

test("10. contradictions reduce confidence", () => {
  const clean = li.calculateConfidence({ verification: "verified" });
  const dirty = li.calculateConfidence({ verification: "verified", contradictions: [{ id: "c1" }] });
  assert.ok(dirty.confidence < clean.confidence);
  assert.equal(dirty.breakdown.contradictions, 1);
  assert.ok(dirty.breakdown.contradiction_penalty > 0);
});

test("11. independent supports are counted once by id", () => {
  const dup = li.calculateConfidence({
    verification: "verified",
    supports: [{ id: "same" }, { id: "same" }, { id: "same" }],
  });
  const distinct = li.calculateConfidence({
    verification: "verified",
    supports: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  assert.equal(dup.breakdown.independent_supports, 1);
  assert.equal(distinct.breakdown.independent_supports, 3);
  assert.ok(distinct.confidence > dup.confidence);
});

test("12. evidence quality scales support contribution and recency is a small factor", () => {
  const low = li.calculateConfidence({ verification: "verified", supports: [{ id: "a" }], evidence_quality: 0.1 });
  const high = li.calculateConfidence({ verification: "verified", supports: [{ id: "a" }], evidence_quality: 1 });
  assert.ok(high.confidence > low.confidence);
  const fresh = li.calculateConfidence({ verification: "verified", recency_days: 0 });
  const stale = li.calculateConfidence({ verification: "verified", recency_days: 365 });
  assert.ok(fresh.confidence > stale.confidence);
  assert.ok(Math.abs(fresh.breakdown.recency_adjustment) <= 0.03);
  assert.match(fresh.note, /Confidence =/);
});

test("13. calculateConfidence is deterministic, bounded and defensive", () => {
  const args = {
    supports: [{ id: "a" }, "s", { noId: 1 }], contradictions: [{ id: "c" }],
    verification: "weird-value", recency_days: -4, occurrences: 0, evidence_quality: 9,
  };
  const a = li.calculateConfidence(args);
  const b = li.calculateConfidence(args);
  assert.deepEqual(a, b);
  assert.ok(a.confidence >= 0 && a.confidence <= 1);
  assert.ok(a.breakdown.evidence_quality <= 1 && a.breakdown.evidence_quality >= 0);
  assert.doesNotThrow(() => li.calculateConfidence({ supports: "bad", contradictions: 3 }));
});

// ===========================================================================
// C. Pattern detection over existing tables
// ===========================================================================

test("14. detection groups sessions in one project into one pattern row", async () => {
  const project = `proj-${uniq()}`;
  // learning_record has UNIQUE(project_id, signature); use case/whitespace
  // variants that share one normalized signature to model two sessions.
  const token = uniq();
  const sigA = `Signature ${token} WIDGET Retry Fix`;
  const sigB = `signature ${token} widget retry fix`;
  const s1 = `sess-${uniq()}`, s2 = `sess-${uniq()}`;
  const ev = [{ id: "e1", marker: "test_pass", value: "true" }];
  await insertLearning({ project, session: s1, signature: sigA, evidence: ev });
  await insertLearning({ project, session: s2, signature: sigB, evidence: ev });

  const r = await li.detectPatterns({ project_id: project });
  assert.equal(r.ok, true);
  assert.ok(r.examined >= 2);
  const p = r.patterns[0];
  assert.ok(p, "a pattern was produced");
  assert.ok(p.occurrences >= 2, `occurrence count ${p.occurrences}`);
  assert.ok(p.distinct_sessions >= 2);
  assert.ok(p.sessions.includes(s1) && p.sessions.includes(s2));
  assert.ok(p.projects.includes(project));
  assert.equal(p.status, "verified_fact");

  const pe = await core.dbQuery(
    "SELECT session_id FROM pattern_evidence WHERE pattern_id=$1", [p.id]);
  assert.ok(pe.rows.some((x) => x.session_id === s1));
  assert.ok(pe.rows.some((x) => x.session_id === s2));
});

test("15. repeated detection is idempotent for counts and evidence rows", async () => {
  const project = `proj-${uniq()}`;
  const token = uniq();
  await insertLearning({ project, session: `sess-${uniq()}`, signature: `Signature ${token} WIDGET Retry`,
    evidence: [{ id: "e", marker: "test_pass", value: "true" }] });
  await insertLearning({ project, session: `sess-${uniq()}`, signature: `signature ${token} widget retry`,
    evidence: [{ id: "e", marker: "test_pass", value: "true" }] });

  const a = await li.detectPatterns({ project_id: project });
  const b = await li.detectPatterns({ project_id: project });
  const pa = a.patterns[0], pb = b.patterns[0];
  assert.equal(pa.id, pb.id);
  assert.equal(pa.occurrences, pb.occurrences, "occurrences do not inflate");
  assert.equal(pa.distinct_sessions, pb.distinct_sessions);
  const peA = await core.dbQuery("SELECT count(*)::int n FROM pattern_evidence WHERE pattern_id=$1", [pa.id]);
  const peB = await core.dbQuery("SELECT count(*)::int n FROM pattern_evidence WHERE pattern_id=$1", [pb.id]);
  assert.equal(peB.rows[0].n, peA.rows[0].n, "evidence rows are not duplicated");
});

test("16. supersession preserves the old row and detection never resurrects it", async () => {
  const project = `proj-${uniq()}`;
  const sig = `signature ${uniq()} widget retry fix`;
  await insertLearning({ project, session: `sess-${uniq()}`, signature: sig,
    evidence: [{ id: "e", marker: "test_pass", value: "true" }] });
  const r = await li.detectPatterns({ project_id: project });
  const p = r.patterns[0];

  const s = await li.supersedePattern({
    id: p.id, by_id: crypto.randomUUID(), project_id: project,
    reason: "replaced by a newer approach", evidence: [{ marker: "note" }],
  });
  assert.equal(s.ok, true);
  assert.equal(s.changed, true);

  const still = await core.dbQuery("SELECT status FROM pattern WHERE id=$1", [p.id]);
  assert.equal(still.rowCount, 1, "old row is never deleted");
  assert.equal(still.rows[0].status, "superseded");

  const again = await li.supersedePattern({ id: p.id, project_id: project, reason: "again" });
  assert.equal(again.changed, false, "already superseded is a no-op");

  await li.detectPatterns({ project_id: project });
  const after = await core.dbQuery("SELECT status FROM pattern WHERE id=$1", [p.id]);
  assert.equal(after.rows[0].status, "superseded", "re-detection must not un-supersede");
});

test("17. project isolation: patterns and detection never cross projects", async () => {
  const projA = `proj-${uniq()}`, projB = `proj-${uniq()}`;
  const sigA = `signature ${uniq()} alpha widget`, sigB = `signature ${uniq()} beta gadget`;
  await insertLearning({ project: projA, session: `sess-${uniq()}`, signature: sigA });
  await insertLearning({ project: projB, session: `sess-${uniq()}`, signature: sigB });
  const ra = await li.detectPatterns({ project_id: projA });
  const rb = await li.detectPatterns({ project_id: projB });

  const a = await li.getPatterns({ project_id: projA });
  const b = await li.getPatterns({ project_id: projB });
  assert.ok(a.items.length >= 1 && b.items.length >= 1);
  assert.ok(a.items.every((x) => x.projects.includes(projA)));
  assert.ok(b.items.every((x) => x.projects.includes(projB)));
  assert.equal(a.items.some((x) => x.id === rb.patterns[0]?.id), false, "A must not see B's pattern");
  assert.equal(b.items.some((x) => x.id === ra.patterns[0]?.id), false, "B must not see A's pattern");
});

test("18. reads and detection are bounded", async () => {
  const project = `proj-${uniq()}`;
  for (let i = 0; i < 4; i++) {
    await insertLearning({ project, session: `sess-${uniq()}`, signature: `signature ${uniq()} bound${i} widget` });
  }
  await li.detectPatterns({ project_id: project });

  const one = await li.getPatterns({ project_id: project, limit: 1 });
  assert.ok(one.items.length <= 1);
  const zero = await li.getPatterns({ project_id: project, limit: 0 });
  assert.equal(zero.items.length, 0);
  const huge = await li.getPatterns({ project_id: project, limit: 1e9 });
  assert.ok(huge.items.length <= 200 && huge.limit <= 200);

  const detZero = await li.detectPatterns({ project_id: project, limit: 0 });
  assert.equal(detZero.patterns.length, 0);
  const detOne = await li.detectPatterns({ project_id: project, limit: 1 });
  assert.ok(detOne.patterns.length <= 1);

  const byStatus = await li.getPatterns({ project_id: project, status: "hypothesis" });
  assert.ok(byStatus.items.every((x) => x.status === "hypothesis"));
});

// ===========================================================================
// D. Conservative confidence recalculation
// ===========================================================================

test("19. recalculation does not promote unsupported 'verified' and is idempotent", async () => {
  const project = `proj-${uniq()}`;
  const id = await insertLearning({
    project, signature: `signature ${uniq()} recalc widget`, verification: "verified",
    evidence: [{ marker: "explanation", value: "success" }],
  });
  const a = await li.recalculateLearningConfidence({ project_id: project, learning_id: id });
  assert.equal(a.ok, true);
  assert.ok(a.confidence <= 0.5, "demoted to observed => capped");
  assert.equal(a.changed, true);
  const b = await li.recalculateLearningConfidence({ project_id: project, learning_id: id });
  assert.equal(b.changed, false, "second recalculation is idempotent");

  const row = await core.dbQuery("SELECT verification FROM learning_record WHERE id=$1", [id]);
  assert.equal(row.rows[0].verification, "verified", "module never writes verification");
});

test("20. recalculation reflects explicit evidence, supports and contradictions conservatively", async () => {
  const project = `proj-${uniq()}`;
  const id = await insertLearning({
    project, signature: `signature ${uniq()} feedback widget`, verification: "verified",
    evidence: [{ id: "ev1", marker: "test_pass", value: "true" }],
  });
  const base = await li.recalculateLearningConfidence({ project_id: project, learning_id: id });
  assert.ok(base.confidence > 0.5, "explicit evidence keeps verified status");

  await insertFeedback({ project, learning_id: id, verdict: "useful", explicit: true });
  const supported = await li.recalculateLearningConfidence({ project_id: project, learning_id: id });
  assert.ok(supported.confidence >= base.confidence, "supporting feedback does not lower confidence");

  await insertFeedback({ project, learning_id: id, verdict: "not_useful", explicit: true });
  const contradicted = await li.recalculateLearningConfidence({ project_id: project, learning_id: id });
  assert.ok(contradicted.breakdown.contradictions >= 1);
  assert.ok(contradicted.confidence < supported.confidence, "contradicting feedback lowers confidence");
});

// ===========================================================================
// E. Invalid inputs + teardown
// ===========================================================================

test("21. invalid inputs fail closed without throwing", async () => {
  const project = `proj-${uniq()}`;
  const d0 = await li.detectPatterns({});
  assert.equal(d0.ok, false);
  const d1 = await li.detectPatterns({ project_id: project, limit: -5 });
  assert.equal(d1.ok, true);
  assert.equal(d1.patterns.length, 0);

  assert.equal((await li.getPatterns({})).ok, false);
  assert.equal((await li.supersedePattern({ id: "not-a-uuid", project_id: project })).ok, false);
  assert.equal((await li.recalculateLearningConfidence({ learning_id: "bad", project_id: project })).ok, false);
  assert.equal((await li.recalculateLearningConfidence({ learning_id: crypto.randomUUID(), project_id: project })).ok, false);
});

test("close pool", async () => { await core.close(); });
