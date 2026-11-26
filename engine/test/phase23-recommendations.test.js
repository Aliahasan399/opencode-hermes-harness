// Phase 23 features F + G + H — recommendations, architectural risk, roadmap.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network,
// unique project ids per test, no destructive assertions outside test-owned ids.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase23-recommendations.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const rec = await import("../src/recommendationEngine.js");
const road = await import("../src/engineeringRoadmap.js");
const decisionIntel = await import("../src/decisionIntel.js");

const {
  PRIORITY_RULES, RECOMMENDATION_STATUSES, scorePriority, buildRecommendations,
  recordRecommendation, updateRecommendationStatus, getRecommendations,
  explainRecommendation, analyzeArchitecturalRisk,
} = rec;
const { ROADMAP_RULES, buildRoadmap, roadmapHistory } = road;

const uniq = (p = "p23r") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const aid = () => crypto.randomUUID();
const createdRecs = new Set();
const createdFindings = new Set();
const createdDecisions = new Set();
const createdAssessments = new Set();

// Idempotent schema guards: no-ops when migration 021 is already applied.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS engineering_recommendation (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      category text NOT NULL,
      description text NOT NULL DEFAULT '',
      finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      learning_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      priority text NOT NULL DEFAULT 'medium',
      expected_benefit text NOT NULL DEFAULT '',
      effort text NOT NULL DEFAULT 'unknown',
      confidence real NOT NULL DEFAULT 0,
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
      change_risk text NOT NULL DEFAULT 'unknown',
      status text NOT NULL DEFAULT 'proposed',
      decided_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_finding (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      component text NOT NULL DEFAULT '',
      category text NOT NULL,
      description text NOT NULL DEFAULT '',
      detection_method text NOT NULL DEFAULT 'deterministic',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0,
      severity text NOT NULL DEFAULT 'low',
      impact text NOT NULL DEFAULT '',
      remediation text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'new',
      first_detected timestamptz NOT NULL DEFAULT now(),
      last_observed timestamptz NOT NULL DEFAULT now(),
      resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (project_id, component, category, description)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_assessment (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      component text NOT NULL DEFAULT '_project',
      dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      unknown_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
});

const makeFinding = (over = {}) => ({
  id: aid(), project_id: uniq(), component: "svc", category: "repeated_workaround",
  description: "Repeated manual workaround in deploy step", severity: "high",
  confidence: 0.7, impact: "blocking production releases", remediation: "Add an automated retry with tests",
  evidence: [{ marker: "workaround", detail: "manual retry", occurrences: 2 }],
  ...over,
});

// ---------------------------------------------------------------------------
// 0. exports + frozen rule tables
// ---------------------------------------------------------------------------
test("0. exact exports exist and rule tables are frozen and complete", () => {
  for (const name of ["buildRecommendations", "recordRecommendation", "updateRecommendationStatus",
    "getRecommendations", "explainRecommendation", "analyzeArchitecturalRisk"]) {
    assert.equal(typeof rec[name], "function", `${name} must be a function`);
  }
  for (const name of ["buildRoadmap", "roadmapHistory"]) {
    assert.equal(typeof road[name], "function", `${name} must be a function`);
  }
  assert.equal(typeof scorePriority, "function");
  assert.equal(Object.isFrozen(PRIORITY_RULES), true);
  assert.equal(Object.isFrozen(PRIORITY_RULES.weights), true);
  assert.equal(Object.isFrozen(PRIORITY_RULES.weights.severity), true);
  assert.deepEqual([...PRIORITY_RULES.priorities], ["critical", "high", "medium", "low"]);
  for (const f of ["severity", "impact", "evidence", "confidence", "recurrence", "dependency", "effort"]) {
    assert.ok(PRIORITY_RULES.weights[f], `weight ${f} documented`);
  }
  assert.deepEqual([...RECOMMENDATION_STATUSES].sort(), [
    "accepted", "completed", "deferred", "in_progress", "proposed", "rejected", "reviewed", "superseded",
  ]);
  assert.deepEqual([...ROADMAP_RULES.buckets], ["critical", "high", "medium", "long_term", "low_confidence"]);
  assert.equal(Object.isFrozen(ROADMAP_RULES), true);
  assert.equal(typeof rec.default.buildRecommendations, "function");
  assert.equal(typeof road.default.buildRoadmap, "function");
});

// ---------------------------------------------------------------------------
// 1. consolidation of related findings (no duplicates)
// ---------------------------------------------------------------------------
test("1. related findings consolidate into one recommendation with merged evidence", () => {
  const project_id = uniq();
  const f1 = makeFinding({ project_id, id: aid(), description: "Repeated workaround during deploy step" });
  const f2 = makeFinding({ project_id, id: aid(), description: "Repeated workaround during deploy step",
    evidence: [{ marker: "workaround", detail: "second manual retry", occurrences: 1 }] });
  const r = buildRecommendations({ project_id, findings: [f1, f2] });
  assert.equal(r.ok, true);
  assert.equal(r.recommendations.length, 1, "two related findings -> one recommendation");
  const item = r.recommendations[0];
  assert.ok(item.finding_ids.includes(f1.id) && item.finding_ids.includes(f2.id), "both finding ids retained");
  assert.equal(item.category, "repeated_workaround");
  assert.ok(item.evidence.length >= 2, "evidence merged");
  assert.ok(item.why.includes("consolidated 2 finding"), "consolidation explained");
  assert.deepEqual(r.degraded, []);
});

test("2. duplicate finding ids and duplicate signals never emit duplicate recommendations", () => {
  const project_id = uniq();
  const f = makeFinding({ project_id });
  const r = buildRecommendations({ project_id, findings: [f, f, { ...f }] });
  assert.equal(r.recommendations.length, 1);
  assert.deepEqual(r.recommendations[0].finding_ids, [f.id]);
  const r2 = buildRecommendations({
    project_id, findings: [
      makeFinding({ project_id, category: "fragile_dependency", description: "A" }),
      makeFinding({ project_id, category: "fragile_dependency", description: "B" }),
    ],
  });
  assert.equal(r2.recommendations.length, 2, "distinct categories stay distinct");
});

// ---------------------------------------------------------------------------
// 3. explainable priority, no arbitrary inflation
// ---------------------------------------------------------------------------
test("3. priority is explainable and cannot be inflated without explicit inputs", () => {
  const bare = scorePriority({ severity: "high" });
  assert.ok(["low", "medium", "high", "critical"].includes(bare.priority));
  assert.ok(bare.why.includes("severity") && bare.why.includes("confidence") && bare.why.includes("effort"));
  assert.equal(bare.factors.length, 7, "all seven factors reported");
  for (const factor of ["severity", "impact", "evidence", "confidence", "recurrence", "dependency_criticality", "effort"]) {
    assert.ok(bare.factors.some((f) => f.factor === factor), `${factor} explained`);
  }
  const rich = scorePriority({ severity: "critical", confidence: 0.9, evidenceCount: 5,
    recurrence: 4, impact: "cascade data loss", dependencies: ["core dependency"], effort: "low" });
  assert.ok(rich.score > bare.score, "explicit evidence raises score deterministically");
  assert.equal(rich.priority, "critical");
  assert.ok(PRIORITY_RULES.rules.some((r) => /never a default-high|zero/i.test(r)), "no-default rule documented");
  const heavy = scorePriority({ severity: "high", confidence: 0.7, effort: "high" });
  const light = scorePriority({ severity: "high", confidence: 0.7, effort: "low" });
  assert.ok(heavy.score < light.score, "high effort lowers priority; no inflation");
});

// ---------------------------------------------------------------------------
// 4. record lifecycle + duplicate preserves history
// ---------------------------------------------------------------------------
test("4. record -> read -> status lifecycle is append-only and preserves content", async () => {
  const project_id = uniq();
  const id = aid(); createdRecs.add(id);
  const first = await recordRecommendation({ project_id, id, category: "repeated_workaround",
    description: "Automate the repeated deploy workaround", priority: "high", confidence: 0.7,
    finding_ids: [aid()], steps: [{ action: "Add retry" }], expected_benefit: "blocking releases" });
  assert.equal(first.ok, true); assert.equal(first.id, id);

  const dup = await recordRecommendation({ project_id, id: aid(), category: "repeated_workaround",
    description: "Automate the repeated deploy workaround", priority: "critical", confidence: 0.99 });
  assert.equal(dup.ok, true); assert.equal(dup.duplicate, true); assert.equal(dup.id, id);

  const explained = await explainRecommendation({ id, project_id });
  assert.equal(explained.ok, true);
  assert.equal(explained.recommendation.priority, "high", "original content preserved, not overwritten");
  assert.equal(explained.recommendation.confidence, 0.7);

  const changed = await updateRecommendationStatus({ id, project_id, status: "accepted", decided_by: "operator-1" });
  assert.equal(changed.ok, true); assert.equal(changed.changed, true);
  const after = await explainRecommendation({ id, project_id });
  assert.equal(after.recommendation.status, "accepted");
  assert.equal(after.recommendation.decided_by, "operator-1");
  assert.equal(after.recommendation.description, "Automate the repeated deploy workaround");
});

test("5. status lifecycle rejects invalid inputs, requires attribution and never auto-applies", async () => {
  const project_id = uniq();
  const id = aid(); createdRecs.add(id);
  await recordRecommendation({ project_id, id, category: "quality", description: "Review error handling" });
  assert.equal((await updateRecommendationStatus({ id, project_id, status: "bogus", decided_by: "op" })).ok, false);
  assert.equal((await updateRecommendationStatus({ id, project_id, status: "accepted" })).ok, false, "no anonymous status change");
  assert.equal((await updateRecommendationStatus({ id, project_id: uniq(), status: "accepted", decided_by: "op" })).ok, false);
  const noop = await updateRecommendationStatus({ id, project_id, status: "proposed", decided_by: "op" });
  assert.equal(noop.ok, true); assert.equal(noop.changed, false, "same status is a no-op");

  // No decision is created or superseded automatically by a status change.
  const before = await decisionIntel.getDecisions({ project_id });
  await updateRecommendationStatus({ id, project_id, status: "accepted", decided_by: "op" });
  const after = await decisionIntel.getDecisions({ project_id });
  assert.equal(before.decisions.length, 0);
  assert.equal(after.decisions.length, 0, "no auto-applied decision");
  assert.match((await updateRecommendationStatus({ id, project_id, status: "rejected", decided_by: "op" })).note,
    /no code|not applied|never auto/i);
});

// ---------------------------------------------------------------------------
// 6. bounded, project-scoped reads + filters
// ---------------------------------------------------------------------------
test("6. getRecommendations is project-scoped, filterable and bounded", async () => {
  const pa = uniq("p23a"), pb = uniq("p23b");
  for (let i = 0; i < 3; i++) {
    const id = aid(); createdRecs.add(id);
    await recordRecommendation({ project_id: pa, id, category: i === 0 ? "quality" : "test_gap",
      description: `Rec ${i}`, priority: i === 0 ? "high" : "low" });
  }
  const idb = aid(); createdRecs.add(idb);
  await recordRecommendation({ project_id: pb, id: idb, category: "quality", description: "Rec B" });

  const all = await getRecommendations({ project_id: pa });
  assert.equal(all.ok, true); assert.equal(all.count, 3);
  assert.ok(all.recommendations.every((r) => r.project_id === pa));
  const limited = await getRecommendations({ project_id: pa, limit: 2 });
  assert.equal(limited.recommendations.length, 2);
  const filtered = await getRecommendations({ project_id: pa, category: "quality", priority: "high" });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.recommendations[0].description, "Rec 0");
  const statusFiltered = await getRecommendations({ project_id: pa, status: "proposed" });
  assert.equal(statusFiltered.count, 3);
  assert.equal((await getRecommendations({ project_id: pb })).count, 1, "strict project isolation");
});

// ---------------------------------------------------------------------------
// 7. explanation carries evidence / why / steps
// ---------------------------------------------------------------------------
test("7. explainRecommendation resolves finding evidence and explains why/steps", async () => {
  const project_id = uniq();
  const fid = aid(); createdFindings.add(fid);
  await core.dbQuery(
    `INSERT INTO project_finding (id, project_id, component, category, description, evidence, confidence, severity)
     VALUES ($1,$2,'svc','repeated_workaround','Manual retry', $3::jsonb, 0.8, 'high')`,
    [fid, project_id, JSON.stringify([{ marker: "workaround", detail: "manual retry" }])],
  );
  const id = aid(); createdRecs.add(id);
  await recordRecommendation({ project_id, id, category: "repeated_workaround", description: "Automate retries",
    finding_ids: [fid], steps: [{ action: "Add automated retry" }], priority: "high", confidence: 0.8 });
  const ex = await explainRecommendation({ id, project_id });
  assert.equal(ex.ok, true);
  assert.equal(ex.evidence.length, 1, "supporting finding resolved in project scope");
  assert.match(ex.why, /priority=high/);
  assert.match(ex.why, /PRIORITY_RULES/);
  assert.deepEqual(ex.steps, [{ action: "Add automated retry" }]);
});

// ---------------------------------------------------------------------------
// 8. architectural risk: evidence requirement + confirmed violation
// ---------------------------------------------------------------------------
test("8. a violation needs explicit evidence tied to an active decision", async () => {
  const noEvidenceProject = uniq("p23ne");
  const decision = { id: aid(), title: "Use local cache", status: "active" };
  const weak = await analyzeArchitecturalRisk({
    project_id: noEvidenceProject,
    decisions: [decision],
    findings: [{ id: aid(), category: "quality", severity: "critical", confidence: 0.9,
      description: "violates_decision Use local cache", evidence: [] }],
  });
  assert.equal(weak.ok, true);
  assert.equal(weak.risks.some((r) => r.classification === "confirmed_violation"), false,
    "no confirmed violation without explicit evidence");

  const project_id = uniq("p23cv");
  const decided = await decisionIntel.recordDecision({ project_id, title: "Use local cache",
    description: "cache choice", evidence: ["doc-1"] });
  assert.equal(decided.ok, true);
  createdDecisions.add(decided.id);
  const strong = await analyzeArchitecturalRisk({
    project_id,
    findings: [{ id: aid(), project_id, category: "quality", severity: "critical", confidence: 0.8,
      description: "Cache layer does not invalidate on write", decision_id: decided.id,
      impact: "production data loss", evidence: [{ marker: "violates_decision", detail: decided.id }] }],
  });
  assert.equal(strong.ok, true);
  const violation = strong.risks.find((r) => r.classification === "confirmed_violation");
  assert.ok(violation, "confirmed violation emitted with explicit evidence");
  assert.equal(violation.category, "decision_violation");
  assert.equal(violation.decision_id, decided.id);
  assert.ok(strong.stored >= 1, "risk stored as project_finding");
  assert.match(strong.note, /NEVER silently supersedes/);
});

test("9. architecture analysis never silently supersedes a decision", async () => {
  const project_id = uniq("p23ns");
  const decided = await decisionIntel.recordDecision({ project_id, title: "Cache strategy",
    description: "active choice", evidence: ["doc-2"] });
  assert.equal(decided.ok, true);
  createdDecisions.add(decided.id);

  // A stale view shows the decision as superseded and a finding still relies on it.
  const result = await analyzeArchitecturalRisk({
    project_id,
    decisions: [{ id: decided.id, title: "Cache strategy", status: "superseded" }],
    findings: [{ id: aid(), project_id, category: "outdated_pattern", severity: "medium", confidence: 0.6,
      description: "Still relies on Cache strategy", evidence: [{ marker: "outdated_decision", detail: "Cache strategy" }] }],
  });
  const risk = result.risks.find((r) => r.category === "outdated_decision_in_use");
  assert.ok(risk, "outdated decision risk reported");
  assert.equal(risk.classification, "recommendation", "advisory, not a confirmed auto-change");
  const current = await decisionIntel.getDecisionById({ id: decided.id, project_id });
  assert.equal(current.decision.status, "active", "decision remains active; nothing superseded silently");
  assert.match(risk.remediation, /Confirm the current decision/);
});

test("10. repeated workarounds and conflicting patterns are stored with history", async () => {
  const project_id = uniq("p23hist");
  const findings = [
    { id: aid(), project_id, category: "repeated_workaround", severity: "high", confidence: 0.6,
      description: "Manual fix repeated", evidence: [{ marker: "workaround", occurrences: 3 }] },
    { id: aid(), project_id, category: "quality", severity: "medium", confidence: 0.5,
      description: "conflicting_pattern in config", evidence: [{ marker: "conflicting_pattern" }] },
  ];
  const first = await analyzeArchitecturalRisk({ project_id, findings });
  assert.equal(first.ok, true);
  assert.ok(first.risks.some((r) => r.category === "repeated_workaround"));
  assert.ok(first.risks.some((r) => r.category === "conflicting_pattern"));
  const stored = await core.dbQuery(
    `SELECT id, resolution FROM project_finding WHERE project_id=$1 AND category='architecture_risk'`, [project_id]);
  assert.equal(stored.rows.length, first.stored, "every risk persisted");
  for (const row of stored.rows) { createdFindings.add(row.id); }

  const second = await analyzeArchitecturalRisk({ project_id, findings });
  const stored2 = await core.dbQuery(
    `SELECT id, resolution FROM project_finding WHERE project_id=$1 AND category='architecture_risk'`, [project_id]);
  assert.equal(stored2.rows.length, stored.rows.length, "repeated analysis does not create duplicates");
  assert.ok(stored2.rows.some((r) => (r.resolution?.history || []).length >= 2), "history preserved across repeats");
});

// ---------------------------------------------------------------------------
// 11. roadmap buckets + deterministic ranking
// ---------------------------------------------------------------------------
test("11. buildRoadmap assigns exactly one explainable bucket per recommendation", () => {
  const project_id = uniq();
  const input = [
    { id: aid(), category: "a", description: "critical item", priority: "critical", confidence: 0.9 },
    { id: aid(), category: "b", description: "high item", priority: "high", confidence: 0.8 },
    { id: aid(), category: "c", description: "medium item", priority: "medium", confidence: 0.7 },
    { id: aid(), category: "d", description: "low item", priority: "low", confidence: 0.6 },
    { id: aid(), category: "e", description: "unsupported item", priority: "critical", confidence: 0.2 },
    { id: aid(), category: "f", description: "deferred item", priority: "high", confidence: 0.9, status: "deferred" },
  ];
  const r = buildRoadmap({ project_id, recommendations: input });
  assert.equal(r.ok, true);
  assert.equal(r.total, 6);
  assert.equal(r.buckets.critical.length, 1);
  assert.equal(r.buckets.high.length, 1);
  assert.equal(r.buckets.medium.length, 1);
  assert.equal(r.buckets.long_term.length, 2);
  assert.equal(r.buckets.low_confidence.length, 1);
  assert.equal(r.buckets.low_confidence[0].description, "unsupported item");
  for (const bucket of ROADMAP_RULES.buckets) {
    for (const item of r.buckets[bucket]) {
      assert.equal(item.bucket, bucket);
      assert.match(item.why, /priority=/);
      assert.match(item.why, /score=/);
    }
  }
  assert.match(r.explanation, /read-only/);
});

test("12. roadmap is deterministic, bounded and redacted", () => {
  const project_id = uniq();
  const input = [
    { id: aid(), category: "x", description: "one", priority: "high", confidence: 0.8,
      expected_benefit: "token=sk-1234567890abcdefghijklmnop" },
    { id: aid(), category: "y", description: "two", priority: "high", confidence: 0.8 },
    { id: aid(), category: "z", description: "three", priority: "medium", confidence: 0.6 },
  ];
  const a = buildRoadmap({ project_id, recommendations: input });
  const b = buildRoadmap({ project_id, recommendations: input });
  assert.deepEqual(a, b, "same input -> identical roadmap");
  assert.equal(JSON.stringify(a).includes("sk-1234567890abcdefghijklmnop"), false, "redacted");
  assert.match(JSON.stringify(a), /REDACTED/);
  const bounded = buildRoadmap({ project_id, recommendations: input, limit: 2 });
  assert.equal(bounded.total, 2);
  assert.equal(Object.values(bounded.buckets).flat().length, 2);
});

// ---------------------------------------------------------------------------
// 13. roadmapHistory is read-only, bounded and project-scoped
// ---------------------------------------------------------------------------
test("13. roadmapHistory reads assessment/recommendation changes without mutating", async () => {
  const project_id = uniq();
  const rid = aid(); createdRecs.add(rid);
  await recordRecommendation({ project_id, id: rid, category: "quality", description: "History item" });
  const aid1 = aid(); createdAssessments.add(aid1);
  await core.dbQuery(
    `INSERT INTO project_assessment (id, project_id, component, dimensions) VALUES ($1,$2,'svc','{"reliability":"unknown"}'::jsonb)`,
    [aid1, project_id],
  );
  const h = await roadmapHistory({ project_id });
  assert.equal(h.ok, true);
  assert.ok(h.history.some((e) => e.source === "engineering_recommendation" && e.id === rid));
  assert.ok(h.history.some((e) => e.source === "project_assessment" && e.id === aid1));
  assert.match(h.note, /Read-only/);
  const limited = await roadmapHistory({ project_id, limit: 1 });
  assert.equal(limited.count, 1);
  const other = await roadmapHistory({ project_id: uniq() });
  assert.equal(other.history.some((e) => e.id === rid), false, "project isolation");
});

// ---------------------------------------------------------------------------
// 14. cross-project isolation across all read paths
// ---------------------------------------------------------------------------
test("14. all reads are strictly project-scoped", async () => {
  const pa = uniq("p23ia"), pb = uniq("p23ib");
  const id = aid(); createdRecs.add(id);
  await recordRecommendation({ project_id: pa, id, category: "quality", description: "Secret item" });
  assert.equal((await explainRecommendation({ id, project_id: pb })).ok, false);
  assert.equal((await getRecommendations({ project_id: pb })).count, 0);
  const riskA = await analyzeArchitecturalRisk({ project_id: pa, findings: [
    { id: aid(), project_id: pa, category: "repeated_workaround", severity: "high", confidence: 0.6,
      description: "Manual fix repeated twice", evidence: [{ marker: "workaround", occurrences: 2 }] },
  ] });
  const riskB = await analyzeArchitecturalRisk({ project_id: pb, findings: [] });
  assert.equal(riskB.risks.length, 0, "no cross-project risk leakage");
  const rows = await core.dbQuery("SELECT id FROM project_finding WHERE project_id=$1", [pb]);
  assert.equal(rows.rows.length, 0);
  for (const r of riskA.risks) if (r.finding_id) createdFindings.add(r.finding_id);
});

// ---------------------------------------------------------------------------
// 15. redaction on build and persistence
// ---------------------------------------------------------------------------
test("15. secrets are redacted on build, persistence and explanation", async () => {
  const project_id = uniq();
  const secret = "sk-1234567890abcdefghijklmnop";
  const built = buildRecommendations({ project_id, findings: [makeFinding({
    project_id, description: `Workaround uses ${secret}`, impact: `password=${secret}`,
  })] });
  assert.equal(JSON.stringify(built).includes(secret), false);
  assert.match(JSON.stringify(built), /REDACTED/);

  const id = aid(); createdRecs.add(id);
  await recordRecommendation({ project_id, id, category: "quality", description: `Use ${secret}`,
    expected_benefit: `token=${secret}`, steps: [{ action: `password=${secret}` }] });
  const ex = await explainRecommendation({ id, project_id });
  assert.equal(JSON.stringify(ex).includes(secret), false, "stored row redacted on read");
});

// ---------------------------------------------------------------------------
// 16. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("16. invalid inputs fail closed without throwing", async () => {
  assert.equal(buildRecommendations({}).ok, false);
  assert.equal((await recordRecommendation({ category: "x", description: "y" })).ok, false);
  assert.equal((await recordRecommendation({ project_id: uniq(), category: "x", description: "" })).ok, false);
  assert.equal((await recordRecommendation({ project_id: uniq(), category: "x", description: "d", id: "bad" })).ok, false);
  assert.equal((await updateRecommendationStatus({})).ok, false);
  assert.equal((await getRecommendations({})).ok, false);
  assert.equal((await explainRecommendation({})).ok, false);
  assert.equal((await analyzeArchitecturalRisk({})).ok, false);
  assert.equal(buildRoadmap({}).ok, false);
  assert.equal((await roadmapHistory({})).ok, false);
});

// ---------------------------------------------------------------------------
// 17. cleanup + close pool (once)
// ---------------------------------------------------------------------------
test("close pool", async () => {
  const recIds = [...createdRecs];
  if (recIds.length) await core.dbQuery("DELETE FROM engineering_recommendation WHERE id = ANY($1)", [recIds]);
  const findingIds = [...createdFindings];
  if (findingIds.length) await core.dbQuery("DELETE FROM project_finding WHERE id = ANY($1)", [findingIds]);
  const decisionIds = [...createdDecisions];
  if (decisionIds.length) await core.dbQuery("DELETE FROM technical_decision WHERE id = ANY($1)", [decisionIds]);
  const assessmentIds = [...createdAssessments];
  if (assessmentIds.length) await core.dbQuery("DELETE FROM project_assessment WHERE id = ANY($1)", [assessmentIds]);
  await core.close();
});
