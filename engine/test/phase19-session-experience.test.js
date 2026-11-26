// Phase 19 workstream A — session experience (connected events) tests.
// Pure module: no DB, no network, no LLM, no writes. Run with:
//   cd E:\OpenCodeData\memory\engine
//   node --test test/phase19-session-experience.test.js
import test from "node:test";
import assert from "node:assert/strict";

// Set the isolated DB name defensively even though this module is pure.
process.env.MEMORY_DB_NAME = "opencode_memory_test";

const {
  CHANGE_STATES,
  parseSessionEvents,
  classifyChange,
  analyzeSessionExperience,
} = await import("../src/sessionExperience.js");

const SUMMARY_KEYS = [
  "goal_hints", "changes", "errors", "tests", "decisions",
  "unfinished", "constraints", "tools_used",
];

function assertShape(r) {
  assert.equal(r.ok, true);
  assert.equal(typeof r.session_id === "string" || r.session_id === null, true);
  assert.equal(typeof r.project_id === "string" || r.project_id === null, true);
  assert.ok(Number.isInteger(r.analyzed_lines) && r.analyzed_lines >= 0);
  assert.ok(Array.isArray(r.events));
  assert.ok(Array.isArray(r.evidence));
  assert.deepEqual(Object.keys(r.summary).sort(), [...SUMMARY_KEYS].sort(), "exact summary keys");
  for (const k of SUMMARY_KEYS) assert.ok(Array.isArray(r.summary[k]), `${k} is an array`);
}

// ---- 0. exports -------------------------------------------------------------
test("0. CHANGE_STATES is frozen with the exact six states", () => {
  assert.ok(Object.isFrozen(CHANGE_STATES));
  assert.deepEqual([...Object.values(CHANGE_STATES)], [
    "proposed", "attempted", "executed", "verified", "rejected", "reverted",
  ]);
});

// ---- 1. connected event parsing --------------------------------------------
test("1. parseSessionEvents preserves order and role/kind/phase shape", () => {
  const events = parseSessionEvents([
    { seq: 1, role: "USER", text: "Please build a CSV export feature" },
    { seq: 2, role: "ASSISTANT", text: "I will create the exporter module" },
    { seq: 3, role: "TOOL", tool: "write", text: "File written: src/exporter.js" },
    { seq: 4, role: "TOOL", tool: "bash", text: "3 tests passed" },
    { seq: 5, role: "TOOL", tool: "bash", text: "AssertionError: assert -1 == 5", metadata: { exit: 1 } },
  ]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5], "input order preserved");
  assert.deepEqual(events.map((e) => e.role), ["USER", "ASSISTANT", "TOOL", "TOOL", "TOOL"]);
  assert.deepEqual(events.map((e) => e.kind), [
    "user_request", "assistant_statement", "edit_write_result", "test_output", "error_output",
  ]);
  assert.deepEqual(events.map((e) => e.phase), [
    "request", "plan", "execute", "verify", "error",
  ]);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ["evidence", "kind", "phase", "role", "seq", "text", "tool"].sort());
    assert.equal(typeof e.evidence.excerpt, "string");
    assert.equal(e.evidence.seq, e.seq);
  }
  assert.equal(events[4].evidence.exit, 1, "non-zero exit preserved in evidence");
});

test("2. parseSessionEvents detects test/error/edit-write outputs without metadata", () => {
  const events = parseSessionEvents([
    { seq: 1, role: "TOOL", tool: "pytest", text: "all tests passed" },
    { seq: 2, role: "TOOL", text: "error: connection refused" },
    { seq: 3, role: "TOOL", text: "updated config file settings.json" },
  ]);
  assert.deepEqual(events.map((e) => e.kind), ["test_output", "error_output", "edit_write_result"]);
});

test("3. parseSessionEvents tolerates malformed lines and empty input", () => {
  assert.deepEqual(parseSessionEvents(null), []);
  assert.deepEqual(parseSessionEvents("not an array"), []);
  const events = parseSessionEvents([
    null,
    "bare string",
    { seq: 3, role: "TOOL", text: "" },
    { seq: 4, role: "USER", text: "a valid request to build things here" },
    { toString() { throw new Error("hostile"); } },
  ]);
  assert.equal(events.length, 1, "empty and hostile lines are skipped");
  assert.equal(events[0].seq, 4);
});

// ---- 2. change classification ----------------------------------------------
test("4. classifyChange returns every change state for representative events", () => {
  assert.equal(classifyChange({ role: "ASSISTANT", text: "I will create the new module", kind: "assistant_statement" }), CHANGE_STATES.PROPOSED);
  assert.equal(classifyChange({ role: "TOOL", text: "running npm install", kind: "tool_call", tool: "bash" }), CHANGE_STATES.ATTEMPTED);
  assert.equal(classifyChange({ role: "TOOL", text: "File written: src/a.js", kind: "edit_write_result", tool: "write" }), CHANGE_STATES.EXECUTED);
  assert.equal(classifyChange({ role: "TOOL", text: "3 tests passed", kind: "test_output", tool: "bash" }), CHANGE_STATES.VERIFIED);
  assert.equal(classifyChange({ role: "TOOL", text: "AssertionError: assert -1 == 5", kind: "error_output", evidence: { exit: 1 } }), CHANGE_STATES.REJECTED);
  assert.equal(classifyChange({ role: "TOOL", text: "reverted the change to a.js", kind: "tool_result", tool: "bash" }), CHANGE_STATES.REVERTED);
});

test("5. non-zero exit code alone yields rejected", () => {
  const state = classifyChange({ role: "TOOL", text: "command completed", kind: "tool_result", evidence: { exit: 2 } });
  assert.equal(state, CHANGE_STATES.REJECTED);
});

test("6. a bare assistant claim is never verified or executed", () => {
  const r = analyzeSessionExperience({
    session_id: "claim-only",
    project_id: "p",
    lines: [{ seq: 1, role: "ASSISTANT", text: "All tests passed, I wrote and verified the file src/claim.js" }],
  });
  assertShape(r);
  const states = r.summary.changes.map((c) => c.state);
  assert.equal(states.includes(CHANGE_STATES.VERIFIED), false, "no assistant change is verified");
  assert.equal(states.includes(CHANGE_STATES.EXECUTED), false, "no assistant change is executed");
  const passTests = r.summary.tests.filter((t) => t.result === "pass");
  assert.equal(passTests.length, 0, "assistant claim of passing is not recorded as a pass");
});

// ---- 3. summary extraction --------------------------------------------------
test("7. full session: changes, errors, tests, decisions, unfinished, constraints", () => {
  const lines = [
    { seq: 1, role: "USER", text: "Please implement a CSV export in src/export.js; it must keep existing tests passing" },
    { seq: 2, role: "ASSISTANT", text: "I will create the exporter and decided to stream rows" },
    { seq: 3, role: "TOOL", tool: "write", text: "File written: src/export.js" },
    { seq: 4, role: "TOOL", tool: "bash", text: "error: ENOENT at src/export.js", metadata: { exit: 1 } },
    { seq: 5, role: "TOOL", tool: "bash", text: "2 tests passed" },
    { seq: 6, role: "ASSISTANT", text: "We chose streaming; TODO add docs, never log raw rows" },
  ];
  const r = analyzeSessionExperience({ session_id: "s1", project_id: "proj", lines });
  assertShape(r);
  assert.equal(r.session_id, "s1");
  assert.equal(r.project_id, "proj");
  assert.equal(r.analyzed_lines, 6);

  assert.ok(r.summary.changes.length >= 3, "several change events captured");
  const states = new Set(r.summary.changes.map((c) => c.state));
  assert.ok(states.has(CHANGE_STATES.PROPOSED));
  assert.ok(states.has(CHANGE_STATES.EXECUTED));
  assert.ok(states.has(CHANGE_STATES.REJECTED));
  assert.ok(states.has(CHANGE_STATES.VERIFIED));
  const executed = r.summary.changes.find((c) => c.state === CHANGE_STATES.EXECUTED);
  assert.equal(executed.file, "src/export.js", "file extracted from transcript text only");

  assert.ok(r.summary.errors.some((e) => e.seq === 4 && e.signature.length > 0));
  assert.ok(r.summary.tests.some((t) => t.result === "pass" && t.seq === 5));
  assert.ok(r.summary.decisions.some((d) => /decided|chose/.test(d.text) && d.seq === 2));
  assert.ok(r.summary.unfinished.some((u) => /todo/i.test(u.text) && u.seq === 6));
  assert.ok(r.summary.constraints.some((c) => /must|never/.test(c.text)));
  assert.ok(r.summary.tools_used.includes("bash") && r.summary.tools_used.includes("write"));
  assert.deepEqual(r.summary.tools_used, [...r.summary.tools_used].sort(), "tools sorted deterministically");
  assert.ok(r.evidence.length > 0 && r.evidence.every((e) => typeof e.seq === "number"));
});

test("8. goal hints come from user requests only", () => {
  const r = analyzeSessionExperience({
    session_id: "s2",
    lines: [
      { seq: 1, role: "ASSISTANT", text: "I want to build a helper for you" },
      { seq: 2, role: "USER", text: "Please fix the failing login test" },
      { seq: 3, role: "USER", text: "hello thanks" },
    ],
  });
  assertShape(r);
  assert.equal(r.summary.goal_hints.length, 1, "non-goal assistant/user lines excluded");
  assert.match(r.summary.goal_hints[0], /fix/i);
});

// ---- 4. safety: redaction, boundaries, no invented evidence ----------------
test("9. secrets are redacted from events and every summary extract", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz";
  const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9payloadsignature";
  const r = analyzeSessionExperience({
    session_id: "s3",
    project_id: "p3",
    lines: [
      { seq: 1, role: "USER", text: `please build export with token ${key}` },
      { seq: 2, role: "TOOL", tool: "bash", text: `error: auth failed for ${bearer}`, metadata: { exit: 1 } },
    ],
  });
  assertShape(r);
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes(key), false, "sk- key fully redacted");
  assert.equal(serialized.includes(bearer), false, "bearer token fully redacted");
  assert.ok(serialized.includes("[REDACTED]"));
});

test("10. long input is bounded to 60 lines and text is capped", () => {
  const lines = Array.from({ length: 500 }, (_, i) => ({
    seq: i + 1, role: i % 2 ? "ASSISTANT" : "TOOL", text: `line ${i} ` + "x".repeat(9000),
  }));
  const events = parseSessionEvents(lines);
  assert.equal(events.length, 60, "line count capped at 60");
  for (const e of events) assert.ok(e.text.length <= 1200, "event text capped");
  const r = analyzeSessionExperience({ session_id: "long", lines });
  assertShape(r);
  assert.equal(r.analyzed_lines, 60);
  assert.ok(r.evidence.length <= 60);
});

test("11. no file is claimed unless it appears in the transcript", () => {
  const r = analyzeSessionExperience({
    session_id: "s4",
    lines: [{ seq: 1, role: "TOOL", tool: "bash", text: "all tests passed in the suite" }],
  });
  assertShape(r);
  for (const c of r.summary.changes) if (c.kind === "edit") assert.ok(c.file, "edit changes carry a file from text");
  assert.equal(JSON.stringify(r).includes("src/imaginary.js"), false);
});

test("12. malformed options fall back safely and never throw", () => {
  const bad = [undefined, null, 123, "string", [], { lines: null }, { lines: {} }, { lines: [null, 1, "x"] }];
  for (const input of bad) {
    let r;
    assert.doesNotThrow(() => { r = analyzeSessionExperience(input); });
    assertShape(r);
    assert.equal(r.ok, true);
  }
});

// ---- 5. determinism and multi-tool sessions --------------------------------
test("13. analyzeSessionExperience is deterministic", () => {
  const lines = [
    { seq: 1, role: "USER", text: "build a runner in src/run.js" },
    { seq: 2, role: "TOOL", tool: "write", text: "File written: src/run.js" },
    { seq: 3, role: "TOOL", tool: "bash", text: "1 passed" },
  ];
  const a = analyzeSessionExperience({ session_id: "d", project_id: "p", lines });
  const b = analyzeSessionExperience({ session_id: "d", project_id: "p", lines });
  assert.deepEqual(a, b);
});

test("14. multi-tool sessions collect a bounded, unique, sorted tool list", () => {
  const lines = [
    { seq: 1, role: "TOOL", tool: "write", text: "File written: a.js" },
    { seq: 2, role: "TOOL", tool: "bash", text: "2 tests passed" },
    { seq: 3, role: "TOOL", tool: "pytest", text: "pytest failed: crash with assertionerror in b.py", metadata: { exit: 1 } },
    { seq: 4, role: "TOOL", tool: "bash", text: "reverted the write" },
  ];
  const r = analyzeSessionExperience({ session_id: "multi", lines });
  assertShape(r);
  assert.deepEqual(r.summary.tools_used, ["bash", "pytest", "write"]);
  assert.ok(r.summary.changes.some((c) => c.state === CHANGE_STATES.REVERTED));
  assert.ok(r.summary.errors.some((e) => e.seq === 3));
  assert.ok(r.summary.tests.some((t) => t.seq === 2 && t.result === "pass"));
  assert.ok(r.summary.tests.some((t) => t.seq === 3 && t.result === "fail"));
  assert.equal(new Set(r.summary.tools_used).size, r.summary.tools_used.length, "tool list unique");
});
