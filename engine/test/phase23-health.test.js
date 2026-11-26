// Phase 23 Feature A — project/component health assessments (historical health I).
// Deterministic, project-scoped, append-only. No LLM/network.
// Standalone: $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase23-health.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const ph = await import("../src/projectHealth.js");

const uniq = () => `p23h-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const aid = () => crypto.randomUUID();
const createdIds = new Set();

// Defensive, idempotent schema guard (migration 021 is normally already applied).
before(async () => {
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

const allPositive = () => {
  const e = {};
  for (const d of ph.SCORING_RULES.dimensions) e[d] = ["positive", { signal: "good", source: "observed" }];
  return e;
};

// ---- 0. exports / frozen rules ---------------------------------------------
test("0. exports present and SCORING_RULES is frozen and complete", () => {
  for (const name of [
    "analyzeProjectHealth", "recordAssessment", "getAssessment",
    "getHealthHistory", "compareAssessments",
  ]) {
    assert.equal(typeof ph[name], "function", `${name} exported`);
  }
  assert.ok(ph.SCORING_RULES && Object.isFrozen(ph.SCORING_RULES), "SCORING_RULES frozen");
  assert.deepEqual([...ph.SCORING_RULES.dimensions].sort(), [
    "architectural_consistency", "change_risk", "dependency_stability", "maintainability",
    "reliability", "technical_debt", "testability",
  ]);
  assert.equal(ph.SCORING_RULES.unknown, "unknown");
  assert.ok(ph.SCORING_RULES.rules.some((r) => /never a default/i.test(r)), "rules forbid default healthy");
  assert.equal(typeof ph.default, "object");
});

// ---- 1. healthy component with evidence ------------------------------------
test("1. a component with explicit positive evidence scores healthy per dimension", () => {
  const project_id = uniq();
  const r = ph.analyzeProjectHealth({
    project_id, components: ["svc-api"], evidence: { "svc-api": allPositive() },
  });
  assert.equal(r.ok, true);
  assert.equal(r.assessments.length, 1);
  const a = r.assessments[0];
  assert.equal(a.component, "svc-api");
  for (const d of ph.SCORING_RULES.dimensions) assert.equal(a.dimensions[d], "healthy", `${d} healthy`);
  assert.deepEqual(a.unknown_areas, []);
  assert.ok(a.evidence.length > 0, "evidence captured");
  assert.deepEqual(r.degraded, []);
});

// ---- 2. unknown component stays unknown ------------------------------------
test("2. a component with no evidence stays unknown on every dimension", () => {
  const r = ph.analyzeProjectHealth({ project_id: uniq(), components: ["svc-empty"], evidence: {} });
  assert.equal(r.ok, true);
  const a = r.assessments[0];
  for (const d of ph.SCORING_RULES.dimensions) assert.equal(a.dimensions[d], "unknown");
  assert.deepEqual(new Set(a.unknown_areas), new Set(ph.SCORING_RULES.dimensions));
  assert.deepEqual(a.evidence, []);
  assert.match(a.explanation, /unknown/);
});

// ---- 3. evidence-free assessment never healthy -----------------------------
test("3. evidence-free analysis never claims healthy by default", () => {
  const r = ph.analyzeProjectHealth({
    project_id: uniq(), components: ["a", "b", "c"], evidence: {},
  });
  const labels = r.assessments.flatMap((a) => Object.values(a.dimensions));
  assert.ok(labels.length > 0);
  assert.ok(!labels.includes("healthy"), "no healthy without evidence");
  assert.ok(labels.every((v) => v === "unknown"));
});

// ---- 4. scoring explanation + mixed evidence -------------------------------
test("4. explanation documents derivation; mixed markers net out deterministically", () => {
  const dims = Object.fromEntries(ph.SCORING_RULES.dimensions.map((d) => [d, ["positive"]]));
  dims.reliability = ["positive", "negative", "negative"]; // ratio 0.33 -> at_risk
  const r = ph.analyzeProjectHealth({
    project_id: uniq(), components: ["svc-mixed"], evidence: { "svc-mixed": dims },
  });
  const a = r.assessments[0];
  assert.equal(a.dimensions.reliability, "at_risk");
  assert.equal(a.dimensions.maintainability, "healthy");
  assert.match(a.explanation, /reliability=at_risk/);
  assert.match(a.explanation, /ratio=0\.33/);
  assert.ok(a.explanation.length <= ph.SCORING_RULES.bounds.max_explanation_chars);
  // pure determinism
  assert.deepEqual(
    ph.analyzeProjectHealth({ project_id: "p", components: ["svc-mixed"], evidence: { "svc-mixed": dims } }).assessments,
    [a],
  );
});

// ---- 5. unrecognised markers cannot manufacture a score --------------------
test("5. unrecognised markers do not create a non-unknown label", () => {
  const dims = Object.fromEntries(ph.SCORING_RULES.dimensions.map((d) => [d, ["maybe", "unclear"]]));
  const a = ph.analyzeProjectHealth({
    project_id: uniq(), components: ["x"], evidence: { x: dims },
  }).assessments[0];
  assert.ok(Object.values(a.dimensions).every((v) => v === "unknown"));
});

// ---- 6. bounded -------------------------------------------------------------
test("6. components and evidence are bounded", () => {
  const components = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const dims = Object.fromEntries(
    ph.SCORING_RULES.dimensions.map((d) => [d, Array.from({ length: 200 }, () => "positive")]),
  );
  const r = ph.analyzeProjectHealth({
    project_id: uniq(), components, evidence: Object.fromEntries(components.map((c) => [c, dims])), limit: 5,
  });
  assert.equal(r.assessments.length, 5);
  assert.ok(r.assessments[0].evidence.length <= ph.SCORING_RULES.bounds.max_evidence_per_assessment);
});

// ---- 7. record + history preserved -----------------------------------------
test("7. assessments are append-only; history is preserved", async () => {
  const project_id = uniq();
  const i1 = aid(), i2 = aid(); createdIds.add(i1); createdIds.add(i2);
  const r1 = await ph.recordAssessment({ project_id, component: "svc", id: i1,
    dimensions: { reliability: "unknown" }, evidence: ["e1"], unknown_areas: ["reliability"] });
  const r2 = await ph.recordAssessment({ project_id, component: "svc", id: i2,
    dimensions: { reliability: "healthy", maintainability: "stable" }, evidence: ["e2"], unknown_areas: [] });
  assert.equal(r1.ok, true); assert.equal(r1.id, i1);
  assert.equal(r2.ok, true); assert.equal(r2.id, i2);

  const h = await ph.getHealthHistory({ project_id, component: "svc" });
  assert.equal(h.ok, true);
  assert.equal(h.count, 2);
  assert.deepEqual(new Set(h.assessments.map((a) => a.id)), new Set([i1, i2]));
  const latest = await ph.getAssessment({ project_id, component: "svc" });
  assert.equal(latest.assessment.id, i2);
});

// ---- 8. idempotency ---------------------------------------------------------
test("8. recording an existing id is an idempotent duplicate, not an overwrite", async () => {
  const project_id = uniq();
  const id = aid(); createdIds.add(id);
  const first = await ph.recordAssessment({ project_id, component: "svc", id,
    dimensions: { reliability: "unknown" }, evidence: ["original"] });
  const dup = await ph.recordAssessment({ project_id, component: "svc", id,
    dimensions: { reliability: "healthy" }, evidence: ["replacement"] });
  assert.equal(first.ok, true); assert.equal(first.duplicate, undefined);
  assert.equal(dup.ok, true); assert.equal(dup.duplicate, true); assert.equal(dup.id, id);
  const h = await ph.getHealthHistory({ project_id, component: "svc" });
  assert.equal(h.count, 1, "no new row");
  const stored = h.assessments[0];
  assert.equal(stored.dimensions.reliability, "unknown", "original content preserved");
  assert.deepEqual(stored.evidence, ["original"]);
});

// ---- 9. comparison ----------------------------------------------------------
test("9. comparison reports descriptive deltas, never a success claim", async () => {
  const project_id = uniq();
  const f = aid(), t = aid(); createdIds.add(f); createdIds.add(t);
  await ph.recordAssessment({ project_id, component: "svc", id: f,
    dimensions: { reliability: "unknown", maintainability: "at_risk" }, evidence: ["before"] });
  await ph.recordAssessment({ project_id, component: "svc", id: t,
    dimensions: { reliability: "healthy", maintainability: "at_risk" }, evidence: ["after"] });
  const c = await ph.compareAssessments({ project_id, component: "svc", from_id: f, to_id: t });
  assert.equal(c.ok, true);
  const rel = c.changes.find((x) => x.dimension === "reliability");
  assert.equal(rel.from, "unknown"); assert.equal(rel.to, "healthy"); assert.equal(rel.delta, 4);
  const maint = c.changes.find((x) => x.dimension === "maintainability");
  assert.equal(maint.delta, 0);
  assert.equal(c.changes.length, ph.SCORING_RULES.dimensions.length);
  assert.deepEqual(c.evidence.from, ["before"]);
  assert.deepEqual(c.evidence.to, ["after"]);
  assert.match(c.note, /not proof of improvement/);
  assert.ok(!/success/i.test(c.note), "no success claim");
});

// ---- 10. project isolation --------------------------------------------------
test("10. reads and comparisons are strictly project-scoped", async () => {
  const pa = uniq(), pb = uniq();
  const ida = aid(); createdIds.add(ida);
  await ph.recordAssessment({ project_id: pa, component: "svc", id: ida,
    dimensions: { reliability: "healthy" }, evidence: ["secret-a"] });
  assert.equal((await ph.getAssessment({ project_id: pb, component: "svc" })).count, 0);
  assert.equal((await ph.getHealthHistory({ project_id: pb, component: "svc" })).count, 0);

  const idb = aid(); createdIds.add(idb);
  await ph.recordAssessment({ project_id: pb, component: "svc", id: idb, dimensions: {} });
  const cross = await ph.compareAssessments({ project_id: pb, component: "svc", from_id: ida, to_id: idb });
  assert.equal(cross.ok, false, "cross-project id rejected");
  const wrongComponentID = aid();
  await ph.recordAssessment({ project_id: pb, component: "other", id: wrongComponentID, dimensions: {} });
  const wc = await ph.recordAssessment({ project_id: pb, component: "svc", id: wrongComponentID, dimensions: {} });
  assert.equal(wc.ok, false, "id from another component rejected");
});

// ---- 11. redaction ----------------------------------------------------------
test("11. evidence and dimensions are redacted via core.redact on write and read", async () => {
  const project_id = uniq();
  const secret = "sk-1234567890abcdefghijklmnop";
  const id = aid(); createdIds.add(id);
  const analysis = ph.analyzeProjectHealth({
    project_id, components: ["svc"],
    evidence: { svc: { reliability: [`token used ${secret}`] } },
  });
  assert.ok(!JSON.stringify(analysis).includes(secret), "analysis redacted");
  assert.ok(JSON.stringify(analysis).includes("[REDACTED_API_KEY]"));

  await ph.recordAssessment({ project_id, component: "svc", id,
    dimensions: { reliability: "unknown" }, evidence: [`password=${secret}`], unknown_areas: ["reliability"] });
  const stored = (await ph.getAssessment({ project_id, component: "svc" })).assessment;
  assert.ok(!JSON.stringify(stored).includes(secret), "stored row redacted");
  assert.match(JSON.stringify(stored.evidence), /\[REDACTED/, "redaction tag present");
});

// ---- 12. invalid inputs fail closed ----------------------------------------
test("12. invalid inputs fail closed without throwing", async () => {
  assert.equal(ph.analyzeProjectHealth({}).ok, false);
  assert.equal((await ph.recordAssessment({ component: "svc", dimensions: {} })).ok, false);
  assert.equal((await ph.recordAssessment({ project_id: uniq(), dimensions: null })).ok, false);
  assert.equal((await ph.getAssessment({ project_id: "" })).ok, false);
  assert.equal((await ph.getHealthHistory({})).ok, false);
  assert.equal((await ph.compareAssessments({ project_id: uniq(), from_id: "bad", to_id: "bad" })).ok, false);
});

// ---- cleanup + close pool (once) -------------------------------------------
test("close pool", async () => {
  const ids = [...createdIds];
  if (ids.length) await core.dbQuery("DELETE FROM project_assessment WHERE id = ANY($1)", [ids]);
  await core.close();
});
