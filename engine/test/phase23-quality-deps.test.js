// Phase 23 features D + E — test-quality gaps and dependency risks.
// Pure analysis modules: isolated DB only for the shared core pool,
// no LLM/network, no destructive SQL assertions.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase23-quality-deps.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const tq = await import("../src/testQuality.js");
const deps = await import("../src/dependencyRisk.js");

const { GAP_RULES, analyzeTestQuality } = tq;
const { DEPENDENCY_RULES, analyzeDependencies } = deps;
const uniq = (p = "p23-qd") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const CERTAINTY_RE = /certainly|definitely|guaranteed|100%|will always fail|proven cause|no doubt/i;
const blob = (v) => JSON.stringify(v ?? {});

// ---------------------------------------------------------------------------
// 0. exports / frozen rule tables
// ---------------------------------------------------------------------------
test("0. exact exports exist and rule tables are frozen", () => {
  assert.equal(typeof analyzeTestQuality, "function");
  assert.equal(typeof analyzeDependencies, "function");
  assert.equal(typeof tq.default.analyzeTestQuality, "function");
  assert.equal(typeof deps.default.analyzeDependencies, "function");
  assert.equal(Object.isFrozen(GAP_RULES), true);
  assert.equal(Object.isFrozen(GAP_RULES.categories), true);
  assert.equal(Object.isFrozen(GAP_RULES.categories.untested_module), true);
  assert.equal(Object.isFrozen(DEPENDENCY_RULES), true);
  assert.equal(Object.isFrozen(DEPENDENCY_RULES.categories.circular_dependency), true);
  for (const c of ["untested_module", "weak_assertion", "flaky_test", "unverified_change", "stale_test", "missing_failure_path"]) {
    assert.ok(GAP_RULES.categories[c]);
  }
  for (const c of ["circular_dependency", "single_point_failure", "fragile_dependency",
    "version_drift", "unpinned_version", "outdated_dependency", "missing_fallback"]) {
    assert.ok(DEPENDENCY_RULES.categories[c]);
  }
});

// ---------------------------------------------------------------------------
// 1. explicit test evidence produces bounded gaps
// ---------------------------------------------------------------------------
test("1. analyzeTestQuality emits deterministic gaps from explicit markers", () => {
  const project = uniq("gaps");
  const r = analyzeTestQuality({
    project_id: project,
    modules: ["auth", "api", "worker"],
    tests: [
      { module: "auth", status: "flaky", detail: "login test" },
      { module: "api", verdict: "no_assertion", detail: "handler test" },
    ],
    history: [{ module: "worker", marker: "unverified_change", detail: "deploy step" }],
    evidence: {
      auth: ["missing_tests: no negative-path test"],
      api: [{ marker: "stale_test", detail: "old contract" }],
    },
  });
  assert.equal(r.ok, true);
  assert.ok(r.gaps.length >= 5, `expected several gaps, got ${r.gaps.length}`);
  const byCat = Object.fromEntries(r.gaps.map((g) => [g.category, g]));
  assert.ok(byCat.flaky_test && byCat.weak_assertion && byCat.unverified_change && byCat.untested_module && byCat.stale_test);
  for (const g of r.gaps) {
    assert.equal(g.project_id, project);
    assert.equal(g.detection_method, "deterministic");
    assert.equal(g.severity, GAP_RULES.categories[g.category].severity);
    assert.ok(g.confidence > 0 && g.confidence < 1, "confidence bounded");
    assert.ok(Array.isArray(g.evidence) && g.evidence.length > 0);
    assert.equal(g.certainty_claim, "none");
    assert.equal(g.causation_claim, "none");
    assert.ok(g.description && g.remediation);
  }
  assert.equal(r.coverage, "unknown");
});

// ---------------------------------------------------------------------------
// 2. no evidence => unknown, no invented coverage percentage
// ---------------------------------------------------------------------------
test("2. empty evidence yields unknown and no invented coverage percentage", () => {
  const project = uniq("empty");
  const r = analyzeTestQuality({ project_id: project, modules: ["a", "b"], tests: [], history: [], evidence: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.coverage, "unknown");
  assert.deepEqual(r.unknown_areas, ["a", "b"]);
  assert.doesNotMatch(blob(r), /\b\d{1,3}(\.\d+)?\s*%\s*coverage\b/i);
  assert.doesNotMatch(blob(r), /\bCVE-\d{4}-\d+\b/i);
  assert.doesNotMatch(blob(r), CERTAINTY_RE);
});

// ---------------------------------------------------------------------------
// 3. unusual-looking test code is not flagged
// ---------------------------------------------------------------------------
test("3. unusual-looking code without an explicit marker is not a gap", () => {
  const r = analyzeTestQuality({
    project_id: uniq("odd"),
    modules: ["mystery"],
    tests: [
      { module: "mystery", name: "oddly named test", detail: "assert(!!(x ^ ~y));" },
      "this test file looks suspicious and unusual",
    ],
    history: ["maybe the suite was flaky once"],
    evidence: { mystery: ["TODO revisit this later"] },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.gaps, [], "no markers, no gaps");
  assert.equal(r.coverage, "unknown");
});

// ---------------------------------------------------------------------------
// 4. module scoping + bounds
// ---------------------------------------------------------------------------
test("4. gaps are module-scoped and bounded", () => {
  const project = uniq("scope");
  const scoped = analyzeTestQuality({
    project_id: project,
    modules: ["keep"],
    evidence: { keep: ["flaky_test: a"], drop: ["flaky_test: b"] },
  });
  assert.deepEqual([...new Set(scoped.gaps.map((g) => g.component))], ["keep"]);

  const markers = Array.from({ length: 8 }, (_, i) => `flaky_test: case ${i}`);
  const limited = analyzeTestQuality({ project_id: project, evidence: { x: markers }, limit: 2 });
  assert.equal(limited.gaps.length, 2);
  assert.ok(limited.limit <= GAP_RULES.bounds.max_gaps);
});

// ---------------------------------------------------------------------------
// 5. redaction
// ---------------------------------------------------------------------------
test("5. credential-like content is redacted in gaps", () => {
  const project = uniq("secret");
  const secret = `sk-${"a".repeat(32)}`;
  const r = analyzeTestQuality({
    project_id: project,
    evidence: { svc: [`unverified_change: api_key=${secret} was deployed`] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.gaps.length, 1);
  assert.equal(blob(r).includes(secret), false);
  assert.ok(r.gaps[0].description.includes("[REDACTED"));
});

// ---------------------------------------------------------------------------
// 6. dependency analysis from explicit edges
// ---------------------------------------------------------------------------
test("6. analyzeDependencies derives cycles and concentration from explicit edges", () => {
  const project = uniq("edges");
  const r = analyzeDependencies({
    project_id: project,
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "x", to: "shared" },
      { from: "y", to: "shared" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.edges_examined, 5);
  const byCat = Object.fromEntries(r.risks.map((x) => [x.category, x]));
  assert.ok(byCat.circular_dependency, "cycle detected from explicit edges");
  assert.ok(byCat.single_point_failure, "concentration detected from explicit edges");
  assert.equal(byCat.single_point_failure.component, "shared");
  for (const risk of r.risks) {
    assert.equal(risk.project_id, project);
    assert.ok(risk.confidence > 0 && risk.confidence < 1);
    assert.equal(risk.certainty_claim, "none");
    assert.equal(risk.causation_claim, "none");
    assert.equal(risk.detection_method, DEPENDENCY_RULES.categories[risk.category].detection);
  }
});

// ---------------------------------------------------------------------------
// 7. dependency evidence markers; no invented vulnerabilities
// ---------------------------------------------------------------------------
test("7. dependency evidence markers produce risks without invented CVEs", () => {
  const project = uniq("markers");
  const r = analyzeDependencies({
    project_id: project,
    edges: [],
    evidence: {
      core: ["fragile_dependency: single redis primary", "version_drift: two versions observed"],
      api: [{ marker: "unpinned_version", detail: "floating tag" }, { marker: "missing_fallback", detail: "no fallback" }],
    },
  });
  assert.equal(r.ok, true);
  const cats = r.risks.map((x) => x.category);
  for (const c of ["fragile_dependency", "version_drift", "unpinned_version", "missing_fallback"]) {
    assert.ok(cats.includes(c), `expected ${c}`);
  }
  assert.doesNotMatch(blob(r), /\bCVE-\d{4}-\d+\b/i);
  assert.doesNotMatch(blob(r), CERTAINTY_RE);
  assert.ok(r.risks.every((x) => x.confidence < 1));
});

// ---------------------------------------------------------------------------
// 8. empty edges => no structural risks, nothing invented
// ---------------------------------------------------------------------------
test("8. empty edges yield no structural risks", () => {
  const r = analyzeDependencies({ project_id: uniq("nodeps"), edges: [], evidence: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.risks, []);
  assert.equal(r.edges_examined, 0);
  assert.doesNotMatch(blob(r), /\bCVE-\d{4}-\d+\b/i);
  assert.doesNotMatch(blob(r), CERTAINTY_RE);
});

// ---------------------------------------------------------------------------
// 9. bounded and redacted dependency output
// ---------------------------------------------------------------------------
test("9. dependency analysis is bounded and redacts secrets", () => {
  const project = uniq("depbound");
  const secret = `sk-${"b".repeat(32)}`;
  const markers = Array.from({ length: 10 }, (_, i) => `outdated_dependency: pkg-${i} api_key=${secret}`);
  const r = analyzeDependencies({ project_id: project, evidence: { svc: markers }, limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.risks.length, 2);
  assert.ok(r.limit <= DEPENDENCY_RULES.bounds.max_risks);
  assert.equal(blob(r).includes(secret), false);
});

// ---------------------------------------------------------------------------
// 10. invalid inputs fail closed without throwing
// ---------------------------------------------------------------------------
test("10. invalid inputs fail closed without throwing", () => {
  assert.equal(analyzeTestQuality().ok, false);
  assert.equal(analyzeTestQuality({ project_id: "" }).ok, false);
  assert.equal(analyzeDependencies().ok, false);
  assert.equal(analyzeDependencies({ project_id: "" }).ok, false);
  assert.deepEqual(analyzeTestQuality({ project_id: "p", limit: 0 }).gaps, []);
  assert.deepEqual(analyzeDependencies({ project_id: "p", limit: 0 }).risks, []);
});

// ---------------------------------------------------------------------------
// 11. pipeline wiring token is present in testQuality source
// ---------------------------------------------------------------------------
test("11. testQuality source carries the analyzeDependencies wiring token", () => {
  const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:");
  const src = fs.readFileSync(path.join(here, "..", "src", "testQuality.js"), "utf8");
  for (const token of ["analyzeTestQuality", "GAP_RULES", "analyzeDependencies"]) {
    assert.ok(src.includes(token), `token ${token} must be present for pipeline wiring audit`);
  }
});

// close pool (exactly once, at the end)
test("close pool", async () => { await core.close(); });
