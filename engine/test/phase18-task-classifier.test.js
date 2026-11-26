// Phase 18 workstream B — deterministic task classifier tests.
// Pure module: no DB, no network, no LLM. Run with:
//   cd E:\OpenCodeData\memory\engine
//   node --test test/phase18-task-classifier.test.js
import test from "node:test";
import assert from "node:assert/strict";

// Set the isolated DB name defensively even though this module is pure.
process.env.MEMORY_DB_NAME = "opencode_memory_test";

const { CATEGORIES, classifyTask, classifyBatch } = await import("../src/taskClassifier.js");

const EXPECTED = [
  "implementation", "bugfix", "debugging", "architecture", "refactoring",
  "database", "api", "testing", "security", "documentation", "planning",
  "research", "general",
];
const FLAG_KEYS = ["projectFacts", "decisions", "fixes", "relationships", "verification"];

function assertShape(r) {
  assert.equal(r.ok, true);
  assert.ok(EXPECTED.includes(r.category), `category must be known, got ${r.category}`);
  assert.ok(Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1,
    `confidence in [0,1], got ${r.confidence}`);
  assert.ok(Array.isArray(r.signals), "signals is an array");
  assert.deepEqual(Object.keys(r.retrieve).sort(), [...FLAG_KEYS].sort(), "exact retrieve flags");
  for (const k of FLAG_KEYS) assert.equal(typeof r.retrieve[k], "boolean", `${k} is boolean`);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
}

// ---- 0. exports -------------------------------------------------------------
test("0. CATEGORIES is frozen and contains the full fixed set in order", () => {
  assert.ok(Object.isFrozen(CATEGORIES));
  assert.deepEqual([...CATEGORIES], EXPECTED);
});

// ---- 1. every category has a representative query --------------------------
test("1. implementation category", () => {
  const r = classifyTask({ query: "Implement a new feature to build CSV export" });
  assertShape(r);
  assert.equal(r.category, "implementation");
  assert.ok(r.confidence > 0.1);
  assert.ok(r.signals.length > 0);
});

test("2. bugfix category", () => {
  const r = classifyTask({ query: "Fix the failing assertion in the login test" });
  assertShape(r);
  assert.equal(r.category, "bugfix");
  assert.equal(r.retrieve.fixes, true, "bugfix prioritizes fixes");
});

test("3. debugging category", () => {
  const r = classifyTask({ query: "Debug the hanging process and find the root cause" });
  assertShape(r);
  assert.equal(r.category, "debugging");
  assert.equal(r.retrieve.fixes, true, "debugging prioritizes fixes");
});

test("4. architecture category", () => {
  const r = classifyTask({ query: "Design the microservice architecture for a distributed system" });
  assertShape(r);
  assert.equal(r.category, "architecture");
});

test("5. refactoring category", () => {
  const r = classifyTask({ query: "Refactor and rename the module boundaries" });
  assertShape(r);
  assert.equal(r.category, "refactoring");
});

test("6. database category", () => {
  const r = classifyTask({ query: "Postgres database connection timeout" });
  assertShape(r);
  assert.equal(r.category, "database");
  assert.ok(r.signals.some((s) => ["postgres", "database", "timeout", "connection"].includes(s)));
});

test("7. api category", () => {
  const r = classifyTask({ query: "Design REST API endpoints with pagination" });
  assertShape(r);
  assert.equal(r.category, "api");
  assert.equal(r.retrieve.fixes, false, "api baseline does not force fixes");
});

test("8. testing category", () => {
  const r = classifyTask({ query: "Write unit tests with Jest for coverage" });
  assertShape(r);
  assert.equal(r.category, "testing");
  assert.equal(r.retrieve.verification, true, "testing prioritizes verification");
});

test("9. security category", () => {
  const r = classifyTask({ query: "Fix SQL injection and XSS vulnerability" });
  assertShape(r);
  assert.equal(r.category, "security", "specific security signals outweigh a generic 'fix'");
});

test("10. documentation category", () => {
  const r = classifyTask({ query: "Update the README and architecture docs" });
  assertShape(r);
  assert.equal(r.category, "documentation");
});

test("11. planning category", () => {
  const r = classifyTask({ query: "Plan the roadmap and milestones for the release" });
  assertShape(r);
  assert.equal(r.category, "planning");
});

test("12. research category", () => {
  const r = classifyTask({ query: "Research alternatives and compare options" });
  assertShape(r);
  assert.equal(r.category, "research");
});

test("13. general fallback category", () => {
  const r = classifyTask({ query: "hello there friend" });
  assertShape(r);
  assert.equal(r.category, "general");
  assert.equal(r.confidence, 0.1, "fallback confidence is low");
  for (const k of FLAG_KEYS) assert.equal(r.retrieve[k], true, "general enables all flags");
});

// ---- 2. ambiguous / deterministic tie-breaking -----------------------------
test("14. deterministic tie-break by fixed category order", () => {
  // "implement" (implementation, weight 3) and "fix" (bugfix, weight 3) tie.
  // implementation is earlier in CATEGORIES, so it must win.
  const r = classifyTask({ query: "implement fix" });
  assertShape(r);
  assert.equal(r.category, "implementation");
  // Same input on repeated calls must be byte-identical.
  assert.deepEqual(r, classifyTask({ query: "implement fix" }));
});

test("15. ambiguous query resolves stably (no exceptions, single category)", () => {
  const q = "fix error test connection debug refactor api document plan research";
  const a = classifyTask({ query: q });
  const b = classifyTask({ query: q });
  assertShape(a);
  assert.deepEqual(a, b, "classification is deterministic");
});

// ---- 3. empty / malformed input never throws -------------------------------
test("16. empty and malformed inputs return safe defaults", () => {
  const inputs = [
    undefined,
    null,
    "a bare string",
    123,
    {},
    { query: "" },
    { query: null },
    { query: undefined },
    { query: 123 },
    { query: ["array", "query"] },
    { query: { toString() { throw new Error("hostile"); } } },
  ];
  for (const input of inputs) {
    let r;
    assert.doesNotThrow(() => { r = classifyTask(input); });
    assertShape(r);
    assert.equal(r.ok, true);
  }
});

// ---- 4. secret redaction ----------------------------------------------------
test("17. secrets in the query never appear in signals or reason", () => {
  const secretKey = "sk-abcdefghijklmnopqrstuvwxyz";
  const secretPw = "supersecretvalue123";
  const r = classifyTask({
    query: `Fix the postgres timeout with api_key=${secretKey} password=${secretPw}`,
    project_id: secretKey,
    session_id: secretPw,
  });
  assertShape(r);
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(secretKey), false, "sk- key redacted/absent");
  assert.equal(serialized.includes(secretPw), false, "password redacted/absent");
  assert.equal(JSON.stringify(r.signals).includes(secretKey), false);
  assert.equal(r.reason.includes(secretKey), false);
  assert.equal(r.reason.includes(secretPw), false);
});

test("18. bearer and AWS-style keys are redacted", () => {
  const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9payloadsignature";
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const r = classifyTask({ query: `debug auth with ${bearer} and ${aws}` });
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(bearer), false);
  assert.equal(serialized.includes(aws), false);
});

// ---- 5. bounded output ------------------------------------------------------
test("19. output is bounded for very long input", () => {
  const r = classifyTask({ query: "implement ".repeat(5000) });
  assertShape(r);
  assert.ok(r.signals.length <= 12, `signals capped, got ${r.signals.length}`);
  assert.ok(r.reason.length <= 300, `reason capped, got ${r.reason.length}`);
});

// ---- 6. retrieve-flag correctness ------------------------------------------
test("20. documentation keeps decisions available when historical explanation is needed", () => {
  const r = classifyTask({ query: "Why did we chose this approach? document the decision" });
  assertShape(r);
  assert.equal(r.category, "documentation");
  assert.equal(r.retrieve.decisions, true,
    "decision-history signals force decisions flag on for documentation");
});

test("21. debugging prioritizes fixes even without a literal 'fix' word", () => {
  const r = classifyTask({ query: "Debug the memory leak in the worker" });
  assertShape(r);
  assert.equal(r.category, "debugging");
  assert.equal(r.retrieve.fixes, true, "debugging baseline enables fixes");
});

test("22. decisions signals force the flag on for any category", () => {
  const r = classifyTask({ query: "Refactor the parser, but first explain why we chose this design and the alternatives" });
  assertShape(r);
  assert.equal(r.retrieve.decisions, true);
});

// ---- 7. batch helper --------------------------------------------------------
test("23. classifyBatch classifies each query and preserves order", () => {
  const res = classifyBatch([
    "postgres database timeout",
    "Fix the failing assertion",
    "hello world",
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.equal(res.results.length, 3);
  assert.equal(res.results[0].category, "database");
  assert.equal(res.results[1].category, "bugfix");
  assert.equal(res.results[2].category, "general");
});

test("24. classifyBatch tolerates malformed containers", () => {
  for (const bad of [null, undefined, 123, "string"]) {
    const r = classifyBatch(bad);
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    assert.deepEqual(r.results, []);
  }
});
