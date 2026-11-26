// Phase 19 integration: orchestrator idempotency, continuity augmentation, isolation.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
const uniq = () => `p19-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

async function load() {
  const su = await import("../src/sessionUnderstanding.js");
  const core = await import("../src/core.js");
  return { su, core };
}

const LINES = [
  { role: "USER", text: "Build a persistent redis caching integration with full tests", seq: 1 },
  { role: "TOOL", tool: "shell", text: "FAILED test_cache.py::test_ttl - AssertionError: expected 600", seq: 2 },
  { role: "ASSISTANT", text: "The ttl default is wrong; changing it to 600 seconds as the fix", seq: 3 },
  { role: "TOOL", tool: "shell", text: "1 passed in 0.11s", seq: 4 },
];

test("1. a complete session is understood and stored idempotently", async () => {
  const { su, core } = await load();
  const project = `scope-${uniq()}`, session = `ses-${uniq()}`;
  const r = await su.runSessionUnderstanding({ session_id: session, project_id: project,
    lines: LINES, sequence: 4 });
  assert.equal(r.ok, true);
  assert.ok(r.understanding_id);
  assert.ok(r.result.analyzed_lines >= 4);
  const again = await su.runSessionUnderstanding({ session_id: session, project_id: project,
    lines: LINES, sequence: 4 });
  assert.equal(again.duplicate, true);
});

test("2. incomplete transcript is refused with no ledger claim", async () => {
  const { su, core } = await load();
  const r = await su.runSessionUnderstanding({ session_id: `ses-${uniq()}`,
    project_id: `scope-${uniq()}`, lines: LINES, sequence: 4, min_sequence: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
});

test("3. status listing is project scoped", async () => {
  const { su, core } = await load();
  const project = `scope-${uniq()}`;
  const r = await su.sessionUnderstandingStatus({ project_id: project, limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  const bad = await su.sessionUnderstandingStatus({ project_id: "_global" });
  assert.equal(bad.ok, false);
});

test("4. continuity items reach the automatic context pipeline", async () => {
  const { su, core } = await load();
  const project = `scope-${uniq()}`, session = `ses-${uniq()}`;
  await su.runSessionUnderstanding({ session_id: session, project_id: project,
    lines: LINES, sequence: 4 });
  const pc = await import("../src/contextPackage.js");
  const r = await pc.prepareContext({ project_id: project,
    query: "continue the redis caching integration and its tests", budget_chars: 3000 });
  assert.equal(r.ok, true);
  assert.match(r.context, /UNTRUSTED|historical reference/i);
  assert.ok(typeof r.context === "string");
});

test("5. retry is safe and content-free", async () => {
  const { su, core } = await load();
  const r = await su.retrySessionUnderstanding({ limit: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.attempted >= 0);
});

test("close pool", async () => { const { core } = await load(); await core.close(); });
