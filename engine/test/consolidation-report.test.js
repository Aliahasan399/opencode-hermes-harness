import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/core.js";
import { backlogReport, staleSuggestionReport, consolidationCoverage } from "../src/consolidationReport.js";

const projectA = `report-${randomUUID()}`;
const projectB = `report-${randomUUID()}`;
const bulkProject = `report-${randomUUID()}`;
const memoryA = randomUUID();
const memoryB = randomUUID();
const bulkMemory = randomUUID();
const missingMemory = randomUUID();
const DAY_MS = 86_400_000;
const serialTables = ["memory_relationships", "memory_contradictions", "memory_history"];
const tables = ["consolidation_suggestion", "memory", ...serialTables];
const fixtures = {};

async function addSuggestion(label, { days, confidence, memory_ids = [memoryA], kind = "duplicate",
  status = "pending", triage_status = "pending", triage_reason = null }) {
  const id = randomUUID();
  const created_at = new Date(Date.now() - days * DAY_MS).toISOString();
  const title = `Test ${label}`;
  const explanation = `Fixture for ${label}`;
  await core.dbQuery(
    `INSERT INTO pg_temp.consolidation_suggestion
       (id, kind, memory_ids, title, description, confidence, status, triage_status, triage_reason, created_at)
     VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, $10)`,
    [id, kind, memory_ids, title, explanation, confidence, status, triage_status, triage_reason, created_at],
  );
  fixtures[label] = { id, created_at, title, explanation, memory_ids };
}

test.before(async () => {
  // Sequential tests reuse the pool's single opened connection. Fixture writes
  // are explicitly limited to session-local tables, which vanish on disconnect.
  await core.dbQuery(tables.map((table) =>
    `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  ).join(";\n"));
  // LIKE copies serial defaults that would otherwise advance public sequences.
  for (const table of serialTables) await core.dbQuery(`ALTER TABLE pg_temp.${table} ALTER COLUMN id DROP DEFAULT`);
  await core.dbQuery("SET search_path TO pg_temp");
  await core.dbQuery(
    `INSERT INTO pg_temp.memory (id, project_id, layer, title, content)
     VALUES ($1, $2, 'project', 'Source A', 'Test source A'),
            ($3, $4, 'project', 'Source B', 'Test source B'),
            ($5, $6, 'project', 'Bulk source', 'Test bulk source')`,
    [memoryA, projectA, memoryB, projectB, bulkMemory, bulkProject],
  );
  await core.dbQuery(
    `INSERT INTO pg_temp.memory_relationships (id, source_id, target_id, relation) VALUES (1, $1, $2, 'related')`,
    [memoryA, memoryB],
  );
  await core.dbQuery(
    `INSERT INTO pg_temp.memory_contradictions (id, memory_a, memory_b, description) VALUES (1, $1, $2, 'Test contradiction')`,
    [memoryA, memoryB],
  );
  await core.dbQuery(
    `INSERT INTO pg_temp.memory_history (id, memory_id, version, content) VALUES (1, $1, 1, 'Test history')`,
    [memoryA],
  );
  await addSuggestion("old", { days: 40, confidence: 0.625 });
  await addSuggestion("recent", { days: 4, confidence: 0.875, memory_ids: [memoryA, memoryB] });
  await addSuggestion("review", { days: 35, confidence: 0.9375, kind: "contradiction",
    triage_status: "review_required", triage_reason: "Needs human review" });
  await addSuggestion("ready", { days: 50, confidence: 0.75, kind: "merge", triage_status: "ready_for_review" });
  await addSuggestion("deferred", { days: 60, confidence: 0.5, kind: "merge", triage_status: "deferred" });
  await addSuggestion("closed", { days: 80, confidence: 1, status: "rejected", triage_status: "review_required" });
  await addSuggestion("other", { days: 32, confidence: 0.984375, memory_ids: [memoryB, memoryA] });
  await addSuggestion("emptySources", { days: 2, confidence: 0.6875, kind: "review", memory_ids: [] });
  await addSuggestion("missingSource", { days: 90, confidence: 0.65625, kind: "merge", memory_ids: [missingMemory, memoryA] });
  await core.dbQuery(
    `INSERT INTO pg_temp.consolidation_suggestion (kind, memory_ids, title, description)
     SELECT 'review', ARRAY[$1::uuid], 'Bulk fixture ' || n, 'Test fixture' FROM generate_series(1, 205) AS n`,
    [bulkMemory],
  );
});

test.after(() => core.close());

test("backlog groups unresolved suggestions and reports full counts and statistics", async () => {
  const report = await backlogReport({ project_id: projectA, limit: 1 });
  assert.equal(report.total, 5);
  assert.equal(new Date(report.oldest_at).toISOString(), fixtures.deferred.created_at);
  assert.equal(new Date(report.newest_at).toISOString(), fixtures.recent.created_at);
  assert.equal(report.average_confidence, 0.7375);
  assert.deepEqual(report.groups.map(({ project_id, kind, triage_status, count }) =>
    [project_id, kind, triage_status, count]), [
    [projectA, "contradiction", "review_required", 1],
    [projectA, "duplicate", "pending", 2],
    [projectA, "merge", "deferred", 1],
    [projectA, "merge", "ready_for_review", 1],
  ]);
  const duplicate = report.groups.find(({ kind }) => kind === "duplicate");
  assert.equal(new Date(duplicate.oldest_at).toISOString(), fixtures.old.created_at);
  assert.equal(new Date(duplicate.newest_at).toISOString(), fixtures.recent.created_at);
  assert.equal(duplicate.average_confidence, 0.75);
});

test("project isolation uses the first memory ID and falls back to _global", async () => {
  const all = await backlogReport({ limit: 0 });
  assert.equal(all.total, 213);
  assert.deepEqual(new Set(all.groups.map(({ project_id }) => project_id)),
    new Set([projectA, projectB, bulkProject, "_global"]));
  const other = await backlogReport({ project_id: projectB });
  assert.equal(other.total, 1);
  assert.deepEqual(other.items.map(({ id }) => id), [fixtures.other.id]);
  const global = await backlogReport({ project_id: "_global" });
  assert.equal(global.total, 2);
  assert.deepEqual(global.items.map(({ id }) => id), [fixtures.emptySources.id, fixtures.missingSource.id]);
  const staleOther = await staleSuggestionReport({ project_id: projectB });
  assert.deepEqual(staleOther.items.map(({ id }) => id), [fixtures.other.id]);
  const staleGlobal = await staleSuggestionReport({ project_id: "_global" });
  assert.deepEqual(staleGlobal.items.map(({ id }) => id), [fixtures.missingSource.id]);
});

test("backlog samples the highest-confidence items within default and explicit limits", async () => {
  const report = await backlogReport({ project_id: projectA, limit: 2 });
  assert.deepEqual(report.items.map(({ id }) => id), [fixtures.review.id, fixtures.recent.id]);
  const [item] = report.items;
  assert.equal(item.kind, "contradiction");
  assert.equal(item.confidence, 0.9375);
  assert.equal(item.title, fixtures.review.title);
  assert.equal(item.explanation, fixtures.review.explanation);
  assert.deepEqual(item.memory_ids, fixtures.review.memory_ids);
  assert.equal(item.triage_reason, "Needs human review");
  assert.deepEqual(report.items[1].memory_ids, [memoryA, memoryB]);
  assert.equal((await backlogReport({ project_id: bulkProject })).items.length, 100);
  assert.equal((await backlogReport({ project_id: bulkProject, limit: 10_000 })).items.length, 200);
  assert.deepEqual((await backlogReport({ project_id: bulkProject, limit: 0 })).items, []);
  const staleBulk = { project_id: bulkProject, older_than_days: 0 };
  assert.equal((await staleSuggestionReport(staleBulk)).items.length, 100);
  assert.equal((await staleSuggestionReport({ ...staleBulk, limit: 10_000 })).items.length, 200);
  const countOnly = await staleSuggestionReport({ ...staleBulk, limit: 0 });
  assert.equal(countOnly.total, 205);
  assert.deepEqual(countOnly.items, []);
});

test("stale report limits oldest-first results to open pending or review-required suggestions", async () => {
  const report = await staleSuggestionReport({ project_id: projectA });
  assert.equal(report.total, 2);
  assert.deepEqual(report.items.map(({ id }) => id), [fixtures.old.id, fixtures.review.id]);
  assert.ok(report.items.every(({ created_at }) => new Date(created_at) < new Date(report.cutoff)));
  const limited = await staleSuggestionReport({ project_id: projectA, limit: 1 });
  assert.equal(limited.total, 2);
  assert.deepEqual(limited.items.map(({ id }) => id), [fixtures.old.id]);
  const older = await staleSuggestionReport({ project_id: projectA, older_than_days: 36 });
  assert.deepEqual(older.items.map(({ id }) => id), [fixtures.old.id]);
});

async function snapshot() {
  const { rows } = await core.dbQuery(tables.map((table) =>
    `SELECT '${table}' AS name, count(*)::int AS count,
            md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.id)) AS fingerprint
     FROM pg_temp.${table} t`,
  ).join(" UNION ALL ") + " ORDER BY name");
  return rows;
}

test("report calls preserve table counts and row contents", async () => {
  const before = await snapshot();
  const backlog = await backlogReport({ project_id: projectA });
  const stale = await staleSuggestionReport({ project_id: projectA });
  const coverage = await consolidationCoverage();
  for (const report of [backlog, stale, coverage]) {
    assert.equal(report.auto_applied, 0);
    assert.equal(report.destructive_operations, 0);
    assert.match(report.note, /never changes memory/i);
  }
  assert.deepEqual(await snapshot(), before);
});

test("coverage computes status counts and triaged fraction from stored suggestions", async () => {
  const coverage = await consolidationCoverage();
  assert.equal(coverage.total, 214);
  assert.deepEqual(coverage.by_status, { pending: 213, rejected: 1 });
  assert.deepEqual(coverage.by_triage_status, { pending: 210, ready_for_review: 1, deferred: 1, review_required: 2 });
  assert.equal(coverage.triaged, 4);
  assert.equal(coverage.fraction_triaged, 4 / 214);
  assert.deepEqual(coverage.table_counts, { memory: 3, memory_relationships: 1, memory_contradictions: 1, memory_history: 1 });
});

test("unknown projects return empty groups and items with null statistics", async () => {
  const project_id = `empty-${randomUUID()}`;
  const backlog = await backlogReport({ project_id });
  assert.equal(backlog.total, 0);
  assert.equal(backlog.average_confidence, null);
  assert.equal(backlog.oldest_at, null);
  assert.equal(backlog.newest_at, null);
  assert.deepEqual(backlog.groups, []);
  assert.deepEqual(backlog.items, []);
  const stale = await staleSuggestionReport({ project_id });
  assert.equal(stale.total, 0);
  assert.deepEqual(stale.items, []);
});

test("invalid limits and age thresholds cannot create an unbounded query", async () => {
  for (const limit of [-1, 0.5, NaN, Infinity, "10", null]) {
    await assert.rejects(() => backlogReport({ limit }), RangeError);
    await assert.rejects(() => staleSuggestionReport({ limit }), RangeError);
  }
  for (const older_than_days of [-1, NaN, Infinity, "30", null]) {
    await assert.rejects(() => staleSuggestionReport({ older_than_days }), RangeError);
  }
});

test("live aggregate reports run in a read-only transaction", async (t) => {
  await core.dbQuery("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await core.dbQuery("SET LOCAL search_path TO public, pg_temp");
    const backlog = await backlogReport({ limit: 0 });
    const stale = await staleSuggestionReport({ limit: 0 });
    const coverage = await consolidationCoverage();
    const countTriageStatus = (status) => backlog.groups.reduce((sum, group) =>
      sum + (group.triage_status === status ? group.count : 0), 0);
    assert.equal(backlog.total, coverage.by_status.pending ?? 0);
    assert.equal(backlog.groups.reduce((sum, group) => sum + group.count, 0), backlog.total);
    assert.ok(stale.total <= backlog.total);
    t.diagnostic(JSON.stringify({
      backlog: backlog.total,
      awaiting_triage: countTriageStatus("pending"),
      ready_for_review: countTriageStatus("ready_for_review"),
      review_required: countTriageStatus("review_required"),
      deferred: countTriageStatus("deferred"),
      stale_30_days: stale.total,
      all_suggestions: coverage.total,
      triaged: coverage.triaged,
      fraction_triaged: coverage.fraction_triaged,
      auto_applied: backlog.auto_applied,
      destructive_operations: backlog.destructive_operations,
    }));
  } finally {
    await core.dbQuery("ROLLBACK");
  }
});
