// Phase 20 integration: orchestrator, lifecycle status, bounded maintenance, isolation.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
const uniq = () => `p20-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

async function load() {
  const lc = await import("../src/memoryLifecycle.js");
  const core = await import("../src/core.js");
  return { lc, core };
}

async function fixture(core, project) {
  return core.saveMemory({ layer: "knowledge", project_id: project,
    title: `P20 fixture ${uniq()}`, content: `Postgres cache ttl policy for ${project}.`,
    source_kind: "observed", category: "configuration", importance: 0.7 });
}

test("1. lifecycle status is project scoped and includes advisory metadata", async () => {
  const { lc, core } = await load();
  const project = `scope-${uniq()}`;
  const m = await fixture(core, project);
  const r = await lc.getLifecycleStatus({ project_id: project, memory_id: m.id });
  assert.equal(r.ok, true);
  assert.ok(r.lifecycle);
  assert.ok(Array.isArray(r.events));
  assert.ok(Array.isArray(r.freshness));
  assert.ok(Array.isArray(r.importance_signals));
  const other = await lc.getLifecycleStatus({ project_id: `scope-${uniq()}`, memory_id: m.id });
  assert.equal(other.ok, false);
});

test("2. maintenance is bounded, advisory and idempotent", async () => {
  const { lc, core } = await load();
  const project = `scope-${uniq()}`;
  await fixture(core, project);
  const a = await lc.runLifecycleMaintenance({ project_id: project, limit: 5, dry_run: true });
  assert.equal(a.ok, true);
  assert.equal(a.dry_run, true);
  assert.ok(a.examined <= 5);
  assert.ok(Array.isArray(a.degraded));
  const b = await lc.runLifecycleMaintenance({ project_id: project, limit: 5, dry_run: true });
  assert.equal(b.ok, true);
  assert.equal(b.examined, a.examined);
});

test("3. invalid inputs fail closed", async () => {
  const { lc, core } = await load();
  assert.equal((await lc.runLifecycleMaintenance({ project_id: "_global" })).ok, false);
  assert.equal((await lc.getLifecycleStatus({ project_id: "p", memory_id: "bad-id" })).ok, false);
  assert.equal((await lc.lifecycleMaintenanceStatus({ project_id: "_global" })).ok, false);
});

test("4. report is bounded and project scoped", async () => {
  const { lc, core } = await load();
  const project = `scope-${uniq()}`;
  const r = await lc.lifecycleMaintenanceStatus({ project_id: project, limit: 10 });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.events_by_state));
  assert.ok(Array.isArray(r.by_lifecycle));
});

test("close pool", async () => { const { core } = await load(); await core.close(); });
