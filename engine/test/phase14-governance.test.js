import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import {
  classifyGlobalMemories,
  proposeScopeCorrections,
  listScopeReviews,
  approveScopeReview,
  rejectScopeReview,
  rollbackScopeReview,
  staleDuplicateContradictionReport,
  memoryQualityExplainability,
} from "../src/memoryGovernance.js";

const uniq = () => `p14g-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

async function makeGlobal(overrides = {}) {
  return core.saveMemory({
    layer: "knowledge",
    project_id: "_global",
    title: `gov-${uniq()}`,
    content: "governance test memory content",
    noEmbed: true,
    ...overrides,
  });
}

const pick = async (sql, params) => (await core.dbQuery(sql, params)).rows[0];

test("1. classifyGlobalMemories is read-only and returns bounded counts + items", async () => {
  const m = await makeGlobal({ source_session: `gov-${uniq()}`, metadata: { note: "x" } });
  const before = await pick("SELECT content, metadata, project_id, global_eligible FROM memory WHERE id=$1", [m.id]);

  const r = await classifyGlobalMemories({ limit: 25 });
  const after = await pick("SELECT content, metadata, project_id, global_eligible FROM memory WHERE id=$1", [m.id]);

  assert.deepEqual(after, before, "classification must not mutate the memory row");
  assert.equal(r.auto_applied, 0);
  assert.equal(r.destructive_operations, 0);
  assert.equal(typeof r.total, "number");
  assert.ok(Array.isArray(r.items) && r.items.length <= 25);
  for (const k of ["proven_global", "project_private_candidate", "uncertain_origin", "historical_record"]) {
    assert.equal(typeof r.counts[k], "number", `count.${k} must be a number`);
  }
  assert.equal(
    r.counts.proven_global + r.counts.project_private_candidate + r.counts.uncertain_origin + r.counts.historical_record,
    r.total,
    "counts must sum to total",
  );
});

test("2. proposeScopeCorrections is idempotent against pending reviews", async () => {
  const target = `proj-${uniq()}`;
  const m = await makeGlobal({ source_session: "some/path/session", metadata: { project_id: target } });

  const first = await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const second = await proposeScopeCorrections({ dry_run: false, memory_id: m.id });

  assert.ok(first.created >= 1, "first run should create a review");
  assert.equal(second.created, 0, "second run must not create a duplicate");
  assert.ok(second.skipped_existing >= 1);
  const rows = await core.dbQuery("SELECT * FROM scope_review WHERE memory_id=$1 AND status='pending'", [m.id]);
  assert.equal(rows.rowCount, 1, "exactly one pending review for the memory");
  assert.notEqual(rows.rows[0].proposed_scope, "global");
});

test("3. dry_run does not insert any scope_review row", async () => {
  const m = await makeGlobal({ source_session: "some/path/session", metadata: { project_id: `proj-${uniq()}` } });
  const dry = await proposeScopeCorrections({ dry_run: true, memory_id: m.id });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.created, 0);
  assert.ok(dry.proposals.length >= 1);
  const rows = await core.dbQuery("SELECT * FROM scope_review WHERE memory_id=$1", [m.id]);
  assert.equal(rows.rowCount, 0, "dry run must not write scope_review rows");
});

test("4. approval requires an explicit approved:true or non-empty reviewer", async () => {
  const m = await makeGlobal({ source_session: "some/path/session", metadata: { project_id: `proj-${uniq()}` } });
  await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const rev = await pick("SELECT * FROM scope_review WHERE memory_id=$1 AND status='pending'", [m.id]);

  await assert.rejects(() => approveScopeReview({ id: rev.id }), /explicit approval/);
  const ok = await approveScopeReview({ id: rev.id, reviewer: "gov-test" });
  assert.equal(ok.ok, true);
  const after = await pick("SELECT status FROM scope_review WHERE id=$1", [rev.id]);
  assert.equal(after.status, "approved");

  // A second approval of a non-pending review must fail.
  await assert.rejects(() => approveScopeReview({ id: rev.id, reviewer: "gov-test" }), /not pending/);
});

test("5. approved change preserves original values in rollback", async () => {
  const target = `proj-${uniq()}`;
  const metadata = { project_id: target, extra: "keep" };
  const m = await makeGlobal({ source_session: "some/path/session", metadata });
  const before = await pick("SELECT project_id, global_eligible, metadata FROM memory WHERE id=$1", [m.id]);

  await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const rev = await pick("SELECT * FROM scope_review WHERE memory_id=$1 AND status='pending'", [m.id]);
  assert.equal(rev.proposed_scope, "project");
  await approveScopeReview({ id: rev.id, approved: true, note: "n" });

  const after = await pick("SELECT project_id, global_eligible FROM memory WHERE id=$1", [m.id]);
  assert.equal(after.project_id, target, "memory project_id should be changed to the proposed project");
  const withRollback = await pick("SELECT rollback FROM scope_review WHERE id=$1", [rev.id]);
  assert.equal(withRollback.rollback.previous.project_id, before.project_id);
  assert.equal(withRollback.rollback.previous.global_eligible, before.global_eligible);
  assert.deepEqual(withRollback.rollback.previous.metadata, before.metadata);
});

test("6. rollback restores original values and status becomes rolled_back", async () => {
  const target = `proj-${uniq()}`;
  const m = await makeGlobal({ source_session: "some/path/session", metadata: { project_id: target } });
  const before = await pick("SELECT project_id, global_eligible, metadata FROM memory WHERE id=$1", [m.id]);

  await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const rev = await pick("SELECT * FROM scope_review WHERE memory_id=$1 AND status='pending'", [m.id]);
  await approveScopeReview({ id: rev.id, reviewer: "gov-test" });
  const changed = await pick("SELECT project_id FROM memory WHERE id=$1", [m.id]);
  assert.equal(changed.project_id, target);

  const rb = await rollbackScopeReview({ id: rev.id, reviewer: "gov-test" });
  assert.equal(rb.ok, true);
  const restored = await pick("SELECT project_id, global_eligible, metadata FROM memory WHERE id=$1", [m.id]);
  assert.deepEqual(restored, before, "rollback must restore all previous values");
  const reviewAfter = await pick("SELECT status FROM scope_review WHERE id=$1", [rev.id]);
  assert.equal(reviewAfter.status, "rolled_back");
});

test("7. reject changes only review status, never the memory", async () => {
  const m = await makeGlobal({ source_session: "some/path/session", metadata: { project_id: `proj-${uniq()}` } });
  await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const rev = await pick("SELECT * FROM scope_review WHERE memory_id=$1 AND status='pending'", [m.id]);
  const before = await pick("SELECT project_id, global_eligible, metadata, content FROM memory WHERE id=$1", [m.id]);

  await assert.rejects(() => rejectScopeReview({ id: rev.id }), /explicit rejection/);
  const r = await rejectScopeReview({ id: rev.id, reviewer: "gov-test", note: "no" });
  assert.equal(r.ok, true);
  assert.equal(r.memory_changed, false);

  const after = await pick("SELECT project_id, global_eligible, metadata, content FROM memory WHERE id=$1", [m.id]);
  assert.deepEqual(after, before, "reject must not touch the memory row");
  const reviewAfter = await pick("SELECT status FROM scope_review WHERE id=$1", [rev.id]);
  assert.equal(reviewAfter.status, "rejected");
});

test("8. cross-project safety: a private project memory is never proposed for global", async () => {
  const pid = `govprivate-${uniq()}`;
  const m = await core.saveMemory({
    layer: "project", project_id: pid, title: `priv-${uniq()}`,
    content: "private project fact", noEmbed: true, metadata: { private: true },
  });
  const before = await pick("SELECT project_id, global_eligible, metadata FROM memory WHERE id=$1", [m.id]);

  // Propose scoped to this memory: no review should be created for a non-_global row.
  await proposeScopeCorrections({ dry_run: false, memory_id: m.id });
  const anyReview = await core.dbQuery("SELECT * FROM scope_review WHERE memory_id=$1", [m.id]);
  assert.equal(anyReview.rowCount, 0, "a project-scoped memory must not be reviewed by propose");
  const globalReview = await core.dbQuery(
    "SELECT * FROM scope_review WHERE memory_id=$1 AND proposed_scope='global'", [m.id]);
  assert.equal(globalReview.rowCount, 0);

  // Across all proposals, 'global' is never emitted automatically.
  const dry = await proposeScopeCorrections({ dry_run: true, limit: 500 });
  assert.ok(dry.proposals.every((p) => p.proposed_scope !== "global"), "no proposal may request global scope");
  const after = await pick("SELECT project_id, global_eligible, metadata FROM memory WHERE id=$1", [m.id]);
  assert.deepEqual(after, before);
});

test("9. staleDuplicateContradictionReport is read-only and project-scoped", async () => {
  const pid = `govreport-${uniq()}`;
  const m = await core.saveMemory({
    layer: "knowledge", project_id: pid, title: `rep-${uniq()}`,
    content: "report content", noEmbed: true,
  });
  await core.dbQuery("UPDATE memory SET valid_until=now() - interval '1 day' WHERE id=$1", [m.id]);
  const before = await pick("SELECT content, valid_until FROM memory WHERE id=$1", [m.id]);

  const r = await staleDuplicateContradictionReport({ project_id: pid });
  const after = await pick("SELECT content, valid_until FROM memory WHERE id=$1", [m.id]);

  assert.deepEqual(after, before, "report must not mutate any memory row");
  assert.equal(r.changes_applied, 0);
  assert.equal(r.destructive_operations, 0);
  assert.ok(r.counts.scanned >= 1);
  assert.ok(r.counts.stale >= 1, "the expired memory should be counted as stale");
  assert.ok(Array.isArray(r.stale) && Array.isArray(r.duplicate_relations) && Array.isArray(r.contradictions));
});

test("10. memoryQualityExplainability returns measured components for a real row", async () => {
  const m = await makeGlobal({ verified: true, confidence: 0.8, provenance: "production" });
  const r = await memoryQualityExplainability({ memory_id: m.id });
  assert.equal(r.ok, true);
  for (const k of ["provenance", "confidence", "usefulness", "retrieval_count", "verification", "contradictions", "recency"]) {
    assert.ok(r.components[k] && "value" in r.components[k], `component ${k} missing`);
    assert.ok(r.components[k].source, `component ${k} must name its source`);
  }
  assert.equal(typeof r.computed_score, "number");
  assert.ok(r.computed_score >= 0 && r.computed_score <= 1);
  assert.equal(r.accuracy_claim, "not assessed");
});

test("11. listScopeReviews filters by status read-only", async () => {
  const r = await listScopeReviews({ status: "pending", limit: 5 });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.reviews) && r.reviews.length <= 5);
  assert.ok(r.reviews.every((x) => x.status === "pending"));
});

test("close", async () => { await core.close(); });
