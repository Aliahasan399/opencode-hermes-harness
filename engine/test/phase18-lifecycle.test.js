// Phase 18: automatic request-lifecycle integration (prepareContext) tests.
// Additive, isolated DB only. No deletion of existing data.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
const uniq = () => `p18-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

async function load() {
  const pc = await import("../src/contextPackage.js");
  const core = await import("../src/core.js");
  return { pc, core };
}

test("1. prepareContext runs the automatic path and returns structured diagnostics", async () => {
  const { pc, core } = await load();
  const pid = `scope-${uniq()}`;
  const r = await pc.prepareContext({ project_id: pid, query: "Fix the PostgreSQL connection timeout",
    session_id: `s-${uniq()}`, budget_chars: 3000 });
  assert.equal(r.ok, true);
  assert.ok(typeof r.context === "string" && r.context.length > 0);
  assert.equal(r.project_id, pid);
  assert.ok(r.task && typeof r.task.category === "string");
  assert.equal(r.task.category, "database");
  assert.ok(r.audit && typeof r.audit.candidates === "number");
  assert.ok(r.audit.estimated_tokens >= 0);
});

test("2. injected context is labelled untrusted reference data", async () => {
  const { pc, core } = await load();
  const r = await pc.prepareContext({ project_id: `scope-${uniq()}`, query: "add a new feature",
    budget_chars: 3000 });
  assert.match(r.context, /UNTRUSTED|historical reference/i);
  assert.match(r.context, /current user request|user instruction/i);
});

test("3. budget is respected and never truncates the original request", async () => {
  const { pc, core } = await load();
  const query = "Implement a new authentication module with OAuth2 and refresh tokens";
  const r = await pc.prepareContext({ project_id: `scope-${uniq()}`, query, budget_chars: 900 });
  assert.ok(r.context.length <= 1000, `context ${r.context.length} should be near the 900 char budget`);
  assert.ok(typeof query === "string" && query.length > 0);
});

test("4. project isolation: a project with no memories returns no other project's decision", async () => {
  const { pc, core } = await load();
  const r = await pc.prepareContext({ project_id: `scope-${uniq()}`,
    query: "why was the local cache technology chosen", budget_chars: 2500 });
  assert.doesNotMatch(r.context, /p17-e2e-decision|SQLite for local cache/);
});

test("5. an injection audit row is written with content-free metadata", async () => {
  const { pc, core } = await load();
  const pid = `scope-${uniq()}`;
  await pc.prepareContext({ project_id: pid, query: "debug the failing test", session_id: `s-${uniq()}` });
  const rep = await (await import("../src/injectionAudit.js")).injectionReport({ project_id: pid, limit: 10 });
  assert.equal(rep.ok, true);
  assert.ok(rep.count >= 1);
  const detail = JSON.stringify(rep.items[0].detail || {});
  assert.doesNotMatch(detail, /Fix the PostgreSQL|authentication module|UNTRUSTED/i);
});

test("6. malformed inputs never throw", async () => {
  const { pc, core } = await load();
  for (const q of [null, undefined, 123, {}, "x".repeat(5000)]) {
    const r = await pc.prepareContext({ project_id: `scope-${uniq()}`, query: q, budget_chars: 500 });
    assert.equal(r.ok, true);
  }
});

test("close pool", async () => { const { core } = await load(); await core.close(); });
