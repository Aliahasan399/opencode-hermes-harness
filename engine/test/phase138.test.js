import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { scopeFilter, filterMemoryResults, isGloballyEligible, globalMisclassificationReport, memoryAccessGuard } from "../src/memoryScope.js";
import { recoverEvents } from "../src/automation.js";

const uniq = () => `p138-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("1. project A private memory is not returned to project B via scoped SQL", async () => {
  const a = `A-${uniq()}`, b = `B-${uniq()}`;
  const marker = await core.saveMemory({ layer: "project", project_id: a, title: `Secret ${uniq()}`, content: `private marker ${uniq()}`, provenance: "production" });
  const scope = scopeFilter({ project_id: b });
  const rows = (await core.dbQuery(`SELECT id FROM memory WHERE ${scope.sql}`, scope.params)).rows;
  assert.equal(rows.some((r) => r.id === marker.id), false);
});

test("2. direct access guard blocks unscoped retrieval and cross-project memory", async () => {
  const p = `guard-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p, title: `Guard ${uniq()}`, content: "guarded" });
  const denied = memoryAccessGuard({ tool: "memory_get", args: {} });
  assert.equal(denied.allowed, false);
  assert.equal(filterMemoryResults([m], { project_id: `other-${uniq()}` }).length, 0);
  assert.equal(filterMemoryResults([m], { project_id: p }).length, 1);
});

test("3. global eligibility rules and approval metadata", async () => {
  const eligible = { project_id: "_global", layer: "user", source_kind: "user", verified: true, metadata: { global_approval: true } };
  const notEligible = { project_id: "_global", layer: "knowledge", source_kind: "observed", verified: true, metadata: {} };
  assert.equal(isGloballyEligible(eligible), true);
  assert.equal(isGloballyEligible(notEligible), false);
  assert.equal(filterMemoryResults([eligible, notEligible], { project_id: "any-project" }).length, 1);
});

test("4. misclassification report is read-only", async () => {
  const before = (await core.dbQuery("SELECT count(*)::int n FROM memory")).rows[0].n;
  const r = await globalMisclassificationReport({ limit: 10 });
  const after = (await core.dbQuery("SELECT count(*)::int n FROM memory")).rows[0].n;
  assert.equal(after, before);
  assert.equal(r.auto_applied, 0);
  assert.equal(r.destructive_operations, 0);
});

test("5. pending event recovery succeeds and is idempotent", async () => {
  const sid = `rec-${uniq()}`;
  const eid = `evt-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO automation_events (session_id,event_id,payload,status,attempts,sequence)
     VALUES ($1,$2,'{"transcript":"USER: recovery test"}'::jsonb,'pending',1,1)`, [sid, eid]);
  const r = await recoverEvents({ limit: 50, max_attempts: 20 });
  assert.ok(r.examined >= 1);
  const row = (await core.dbQuery("SELECT status FROM automation_events WHERE session_id=$1 AND event_id=$2", [sid, eid])).rows[0];
  assert.equal(row.status, "done");
  const again = await recoverEvents({ limit: 50, max_attempts: 20 });
  assert.equal(again.examined, 0);
});

test("6. supersede older pending events behind a completed newer sequence", async () => {
  const sid = `sup-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO automation_events (session_id,event_id,payload,status,attempts,sequence)
     VALUES ($1,$2,'{}'::jsonb,'done',1,10),($1,$3,'{}'::jsonb,'pending',1,5)`,
    [sid, `done-${uniq()}`, `old-${uniq()}`]);
  await recoverEvents({ limit: 50, max_attempts: 20 });
  const row = (await core.dbQuery("SELECT status FROM automation_events WHERE session_id=$1 AND sequence=5", [sid])).rows[0];
  assert.equal(row.status, "superseded");
});

test("7. administrative tools remain allowed", () => {
  assert.equal(memoryAccessGuard({ tool: "memory_update", args: { id: "x" } }).allowed, true);
  assert.equal(memoryAccessGuard({ tool: "consolidation_apply_approved", args: {} }).allowed, true);
});

test("close", async () => { await core.close(); });
