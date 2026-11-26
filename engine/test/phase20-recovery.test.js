// Phase 20 workstream D: version history, explicit restoration, reversible
// archive -- all audited. Isolated DB only; unique ids, no deletion of any row.
// Run: MEMORY_DB_NAME=opencode_memory_test node --test test/phase20-recovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.MEMORY_DB_NAME = process.env.MEMORY_DB_NAME || "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

let core;
let recovery;
async function load() {
  if (!core) {
    core = await import("../src/core.js");
    recovery = await import("../src/memoryRecovery.js");
  }
  return { core, recovery };
}

const uniq = () => `p20d-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function makeMemory({
  project_id, lifecycle = "HYPOTHESIS", importance = 0.5, verified = false,
  category = null, metadata = {}, title = "Fact title", content = "Fact body",
}) {
  const { core: db } = await load();
  const r = await db.dbQuery(
    `INSERT INTO memory (layer, project_id, title, content, category, importance, verified,
                         lifecycle, metadata, source_kind, provenance)
     VALUES ('project', $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'observed', 'test_fixture')
     RETURNING id`,
    [project_id, title, content, category, importance, verified, lifecycle, JSON.stringify(metadata)],
  );
  return r.rows[0].id;
}

async function addHistory(memory_id, version, content, reason = "seed") {
  const { core: db } = await load();
  await db.dbQuery(
    "INSERT INTO memory_history (memory_id, version, content, reason) VALUES ($1,$2,$3,$4)",
    [memory_id, version, content, reason],
  );
}

// ---- 1. version history retrieval ---------------------------------------
test("1. version history is retrievable, metadata-only and project-scoped", async () => {
  const { recovery: rec } = await load();
  const p = `hist-${uniq()}`;
  const id = await makeMemory({ project_id: p, content: `current body ${uniq()}` });
  await addHistory(id, 1, "old body one", "initial");
  await addHistory(id, 2, "old body two", "edit");

  const r = await rec.getVersionHistory({ memory_id: id, project_id: p });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.deepEqual(r.versions.map((v) => v.version).sort((a, b) => b - a), [2, 1]);
  assert.ok(r.versions.every((v) => v.changed_at && typeof v.reason === "string"));
  assert.ok(r.versions.every((v) => !("content" in v)), "history must not expose content");
});

// ---- 2. restore creates a NEW memory; original intact -------------------
test("2. restoreVersion creates a new memory and preserves the original", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `restore-${uniq()}`;
  const marker = uniq();
  const originalContent = `original body ${marker}`;
  const oldContent = `old version body ${marker}`;
  const id = await makeMemory({
    project_id: p, title: `Fact ${marker}`, content: originalContent,
    importance: 0.7, lifecycle: "SUPPORTED", metadata: { user_explicit: false },
  });
  await addHistory(id, 1, oldContent, "pre-edit");

  const r = await rec.restoreVersion({
    memory_id: id, project_id: p, version: 1, actor: "test",
    explicit: true, reason: "recover known good state",
  });
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(r.new_memory_id, id);
  assert.ok(r.event_id);

  const original = await db.getMemory(id);
  assert.equal(original.content, originalContent, "original content must be unchanged");
  const fresh = await db.getMemory(r.new_memory_id);
  assert.equal(fresh.content, oldContent, "new row must carry the historical content");
  assert.equal(fresh.project_id, p);
  assert.equal(fresh.source_kind, "observed");
  assert.equal(fresh.verified, false, "restoration must never promote verification");
  assert.equal(fresh.metadata.restored_from.memory_id, id);
  assert.equal(fresh.metadata.restored_from.version, 1);
  assert.equal(fresh.metadata.restoration_reason, "recover known good state");
  assert.equal(fresh.metadata.original_project_id, p);
  assert.equal(fresh.metadata.historical.lifecycle, "SUPPORTED");
  assert.equal(fresh.metadata.historical.verified, false);
});

// ---- 3. explicit authorization required ---------------------------------
test("3. restoration without explicit=true is refused and writes no event", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `explicit-${uniq()}`;
  const id = await makeMemory({ project_id: p });
  await addHistory(id, 1, "old body");

  const before = await db.dbQuery("SELECT count(*)::int n FROM memory_recovery_event WHERE project_id=$1", [p]);
  const r = await rec.restoreVersion({ memory_id: id, project_id: p, version: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "explicit authorization required");

  const after = await db.dbQuery("SELECT count(*)::int n FROM memory_recovery_event WHERE project_id=$1", [p]);
  assert.equal(after.rows[0].n, before.rows[0].n);
  const count = await db.dbQuery("SELECT count(*)::int n FROM memory WHERE project_id=$1", [p]);
  assert.equal(count.rows[0].n, 1, "no new memory may be created without authorization");
});

// ---- 4. idempotent restore ----------------------------------------------
test("4. repeated restoreVersion for the same version is idempotent", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `idem-restore-${uniq()}`;
  const id = await makeMemory({ project_id: p });
  await addHistory(id, 1, "stable old body");

  const args = { memory_id: id, project_id: p, version: 1, explicit: true, reason: "idempotency check" };
  const a = await rec.restoreVersion(args);
  const b = await rec.restoreVersion(args);
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.duplicate, true);
  assert.equal(a.new_memory_id, b.new_memory_id);
  assert.equal(a.event_id, b.event_id);

  const events = await db.dbQuery(
    "SELECT count(*)::int n FROM memory_recovery_event WHERE memory_id=$1 AND operation='restore_version' AND version=1",
    [id],
  );
  assert.equal(events.rows[0].n, 1);
  const copies = await db.dbQuery(
    "SELECT count(*)::int n FROM memory WHERE metadata->'restored_from'->>'memory_id'=$1", [id],
  );
  assert.equal(copies.rows[0].n, 1);
});

// ---- 5. no cross-project restore ----------------------------------------
test("5. another project can neither restore nor read the history", async () => {
  const { core: db, recovery: rec } = await load();
  const pa = `own-${uniq()}`;
  const pb = `other-${uniq()}`;
  const id = await makeMemory({ project_id: pa });
  await addHistory(id, 1, "private old body");

  const r = await rec.restoreVersion({ memory_id: id, project_id: pb, version: 1, explicit: true });
  assert.equal(r.ok, false);
  const h = await rec.getVersionHistory({ memory_id: id, project_id: pb });
  assert.equal(h.ok, false);
  assert.equal(h.count, 0);
  assert.equal(h.versions.length, 0);
  const count = await db.dbQuery("SELECT count(*)::int n FROM memory WHERE project_id=$1", [pb]);
  assert.equal(count.rows[0].n, 0, "no memory may leak into the other project");
});

// ---- 6. protected memories refuse archive --------------------------------
test("6. important, verified, VERIFIED-lifecycle and constraint memories are protected", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `protected-${uniq()}`;
  const important = await makeMemory({ project_id: p, importance: 0.95, lifecycle: "REJECTED" });
  const verified = await makeMemory({ project_id: p, verified: true, importance: 0.2, lifecycle: "REJECTED" });
  const vLife = await makeMemory({ project_id: p, lifecycle: "VERIFIED", verified: true, importance: 0.2 });
  const constraint = await makeMemory({ project_id: p, category: "security-constraint", importance: 0.2, lifecycle: "REJECTED" });
  const userExplicit = await makeMemory({ project_id: p, importance: 0.2, lifecycle: "REJECTED", metadata: { user_explicit: true } });

  for (const id of [important, verified, vLife, constraint, userExplicit]) {
    const r = await rec.archiveMemorySafe({ memory_id: id, project_id: p });
    assert.equal(r.ok, false, r.reason);
    assert.equal(r.archived, false);
    assert.equal(r.protected, true);
    const m = await db.getMemory(id);
    assert.notEqual(m.lifecycle, "ARCHIVED", "a refused archive must not change state");
  }
  const overrideNoEvidence = await rec.archiveMemorySafe({ memory_id: important, project_id: p, override: true });
  assert.equal(overrideNoEvidence.ok, false, "override without evidence must still be refused");
});

// ---- 7. authorized archive succeeds and is reversible -------------------
test("7. an authorized archive succeeds, is reversible and deletes nothing", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `archive-${uniq()}`;
  const id = await makeMemory({
    project_id: p, importance: 0.9, lifecycle: "REJECTED", title: "Archivable fact", content: `keep me ${uniq()}`,
  });
  const before = await db.getMemory(id);

  const archived = await rec.archiveMemorySafe({
    memory_id: id, project_id: p, actor: "test",
    reason: "approved exception", evidence: ["ticket:OPS-7"], override: true,
  });
  assert.equal(archived.ok, true, archived.reason);
  assert.equal(archived.archived, true);
  const mid = await db.getMemory(id);
  assert.equal(mid.lifecycle, "ARCHIVED");
  assert.equal(mid.metadata.archived_by, "test");
  assert.equal(mid.content, before.content, "archive must not rewrite content");

  const restored = await rec.restoreArchived({ memory_id: id, project_id: p, actor: "test" });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.restored_to, "REJECTED");
  const final = await db.getMemory(id);
  assert.equal(final.lifecycle, "REJECTED");
  assert.equal(final.content, before.content);
  assert.notEqual(final, null, "the row must still exist after archive + restore");

  // An unprotected memory archives without an override.
  const p2 = `archive-open-${uniq()}`;
  const open = await makeMemory({ project_id: p2, lifecycle: "REJECTED", importance: 0.2 });
  const plain = await rec.archiveMemorySafe({ memory_id: open, project_id: p2 });
  assert.equal(plain.ok, true, plain.reason);
  assert.equal(plain.archived, true);
  assert.equal((await db.getMemory(open)).lifecycle, "ARCHIVED");
});

// ---- 8. restoreArchived guards and idempotency --------------------------
test("8. restoreArchived refuses non-archived rows and is idempotent", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `restore-archived-${uniq()}`;
  const notArchived = await makeMemory({ project_id: p, lifecycle: "REJECTED", importance: 0.2 });
  const refused = await rec.restoreArchived({ memory_id: notArchived, project_id: p });
  assert.equal(refused.ok, false);

  const archived = await rec.archiveMemorySafe({ memory_id: notArchived, project_id: p });
  assert.equal(archived.ok, true, archived.reason);
  const first = await rec.restoreArchived({ memory_id: notArchived, project_id: p });
  const second = await rec.restoreArchived({ memory_id: notArchived, project_id: p });
  assert.equal(first.ok, true, first.reason);
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.duplicate, true);
  assert.equal(second.restored_to, first.restored_to);

  const events = await db.dbQuery(
    "SELECT count(*)::int n FROM memory_recovery_event WHERE memory_id=$1 AND operation='restore_archive'",
    [notArchived],
  );
  assert.equal(events.rows[0].n, 1);
});

// ---- 9. audit events are content-free -----------------------------------
test("9. recovery and lifecycle audit rows contain no memory content", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `no-content-${uniq()}`;
  const marker = uniq();
  const body = `SENSITIVE_BODY_${marker}`;
  const title = `SENSITIVE_TITLE_${marker}`;
  const oldBody = `OLD_BODY_${marker}`;
  const id = await makeMemory({ project_id: p, lifecycle: "REJECTED", importance: 0.2, title, content: body });
  await addHistory(id, 1, oldBody, "seed");

  assert.equal((await rec.restoreVersion({ memory_id: id, project_id: p, version: 1, explicit: true })).ok, true);
  assert.equal((await rec.archiveMemorySafe({ memory_id: id, project_id: p })).ok, true);
  assert.equal((await rec.restoreArchived({ memory_id: id, project_id: p })).ok, true);

  const recRows = await db.dbQuery("SELECT detail FROM memory_recovery_event WHERE project_id=$1", [p]);
  const lifeRows = await db.dbQuery("SELECT reason, evidence FROM memory_lifecycle_event WHERE project_id=$1", [p]);
  const report = await rec.lifecycleReport({ project_id: p, limit: 50 });
  const blob = JSON.stringify({
    rec: recRows.rows, life: lifeRows.rows, events: report.events, recoveries: report.recoveries,
  });
  assert.doesNotMatch(blob, new RegExp(`SENSITIVE_BODY_${marker}`));
  assert.doesNotMatch(blob, new RegExp(`SENSITIVE_TITLE_${marker}`));
  assert.doesNotMatch(blob, new RegExp(`OLD_BODY_${marker}`));
});

// ---- 10. project isolation ----------------------------------------------
test("10. reports and history never cross project boundaries", async () => {
  const { core: db, recovery: rec } = await load();
  const pa = `iso-a-${uniq()}`;
  const pb = `iso-b-${uniq()}`;
  const a = await makeMemory({ project_id: pa, lifecycle: "REJECTED", importance: 0.2 });
  const b = await makeMemory({ project_id: pb, lifecycle: "REJECTED", importance: 0.2 });
  await addHistory(a, 1, "a private body");
  assert.equal((await rec.archiveMemorySafe({ memory_id: a, project_id: pa })).ok, true);

  const repA = await rec.lifecycleReport({ project_id: pa });
  assert.equal(repA.ok, true);
  const blobA = JSON.stringify(repA.events) + JSON.stringify(repA.recoveries);
  assert.match(blobA, new RegExp(a));
  assert.doesNotMatch(blobA, new RegExp(b));

  const repB = await rec.lifecycleReport({ project_id: pb });
  assert.equal(repB.ok, true);
  const blobB = JSON.stringify(repB.events) + JSON.stringify(repB.recoveries);
  assert.doesNotMatch(blobB, new RegExp(a));

  const cross = await rec.getVersionHistory({ memory_id: a, project_id: pb });
  assert.equal(cross.ok, false);
  assert.equal(cross.count, 0);
  const countB = await db.dbQuery("SELECT count(*)::int n FROM memory WHERE project_id=$1", [pb]);
  assert.equal(countB.rows[0].n, 1);
});

// ---- 11. invalid inputs never throw -------------------------------------
test("11. malformed inputs return ok:false without throwing", async () => {
  const { recovery: rec } = await load();
  const p = `invalid-${uniq()}`;
  for (const bad of [undefined, null, 123, {}, "not-a-uuid", []]) {
    assert.equal((await rec.getVersionHistory({ memory_id: bad, project_id: p })).ok, false);
    assert.equal((await rec.restoreVersion({ memory_id: bad, project_id: p, version: 1, explicit: true })).ok, false);
    assert.equal((await rec.archiveMemorySafe({ memory_id: bad, project_id: p })).ok, false);
    assert.equal((await rec.restoreArchived({ memory_id: bad, project_id: p })).ok, false);
  }
  assert.equal((await rec.getVersionHistory({ memory_id: randomUUID(), project_id: null })).ok, false);
  assert.equal((await rec.restoreVersion({ memory_id: randomUUID(), project_id: p, version: 0, explicit: true })).ok, false);
  assert.equal((await rec.restoreVersion({ memory_id: randomUUID(), project_id: p, version: 1, explicit: "true" })).ok, false);
  assert.equal((await rec.lifecycleReport({})).ok, false);
  assert.equal((await rec.lifecycleReport({ project_id: p, limit: "all" })).ok, true);
});

// ---- 12. no data deletion ------------------------------------------------
test("12. recovery never deletes memory or history rows", async () => {
  const { core: db, recovery: rec } = await load();
  const p = `no-delete-${uniq()}`;
  const id = await makeMemory({ project_id: p, lifecycle: "REJECTED", importance: 0.2, content: `preserve ${uniq()}` });
  await addHistory(id, 1, "preserve old body");

  const r1 = await rec.restoreVersion({ memory_id: id, project_id: p, version: 1, explicit: true });
  assert.equal(r1.ok, true, r1.reason);
  assert.equal((await rec.archiveMemorySafe({ memory_id: id, project_id: p })).ok, true);
  assert.equal((await rec.restoreArchived({ memory_id: id, project_id: p })).ok, true);

  const rows = await db.dbQuery("SELECT id FROM memory WHERE project_id=$1", [p]);
  assert.ok(rows.rows.length >= 2);
  assert.ok(rows.rows.some((x) => x.id === id));
  assert.ok(rows.rows.some((x) => x.id === r1.new_memory_id));
  const hist = await db.dbQuery("SELECT count(*)::int n FROM memory_history WHERE memory_id=$1", [id]);
  assert.equal(hist.rows[0].n, 1, "history row must survive");
  const dels = await db.dbQuery("SELECT count(*)::int n FROM audit_log WHERE action='memory.delete_hard' AND resource=$1", [id]);
  assert.equal(dels.rows[0].n, 0);
  const valid = await db.dbQuery("SELECT valid_until FROM memory WHERE id=$1", [id]);
  assert.equal(valid.rows[0].valid_until, null, "restored memory must be live again");
});

test("close pool", async () => {
  const { core: db } = await load();
  await db.close();
});
