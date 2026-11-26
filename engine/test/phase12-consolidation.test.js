import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as intel from "../src/intelligence.js";
import { triageSuggestions, qualityReport, applyApprovedConsolidation, rollbackConsolidation,
  resolveSuggestion } from "../src/consolidation.js";

const uniq = () => `p12b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeSuggestion(memoryIds, kind, confidence, projectId) {
  const r = await core.dbQuery(
    `INSERT INTO consolidation_suggestion (kind,memory_ids,title,description,confidence,triage_status)
     VALUES ($1,$2::uuid[],$3,$4,$5,'pending') RETURNING id`,
    [kind, memoryIds, `Test ${kind} ${uniq()}`, "test suggestion", confidence],
  );
  return r.rows[0].id;
}

test("1. exact duplicate detection", async () => {
  const p = `dup-${uniq()}`;
  const text = `Exact duplicate content about redis ttl in ${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Same fact A", content: text });
  const b = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Same fact B", content: text });
  const r = await intel.detectDuplicates({ memory_id: a.id, threshold: 0.9 });
  assert.ok(r.candidates.some((x) => x.id === b.id));
  assert.equal(r.auto_merged, false);
});

test("2. near duplicate detection", async () => {
  const p = `near-${uniq()}`;
  const tag = uniq();
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: `Cache ttl ${tag}`, content: `Use redis cache with a ten minute ttl for ${tag}.` });
  const b = await core.saveMemory({ layer: "knowledge", project_id: p, title: `Cache policy ${tag}`, content: `Use redis cache with a ten minute ttl for ${tag} in this service.` });
  const r = await intel.detectDuplicates({ memory_id: a.id, threshold: 0.7 });
  assert.ok(r.candidates.length >= 1);
});

test("3. contradiction detection", async () => {
  const p = `con-${uniq()}`;
  const a = await core.saveMemory({ layer: "project", project_id: p, title: "Always redis", content: `Always use redis for caching in ${p}.`, source_kind: "verified" });
  await core.saveMemory({ layer: "project", project_id: p, title: "Never redis", content: `Never use redis for caching in ${p}; remove it.`, source_kind: "verified" });
  const r = await intel.detectContradictions({ memory_id: a.id });
  assert.equal(r.records_preserved, true);
  assert.notEqual(await core.getMemory(a.id), null);
});

test("4. cross-project consolidation is refused", async () => {
  const p1 = `x1-${uniq()}`, p2 = `x2-${uniq()}`;
  const a = await core.saveMemory({ layer: "project", project_id: p1, title: "A", content: `Fact for ${p1}.` });
  const b = await core.saveMemory({ layer: "project", project_id: p2, title: "B", content: `Fact for ${p2}.` });
  const sid = await makeSuggestion([a.id, b.id], "merge", 0.99, p1);
  await core.dbQuery("UPDATE consolidation_suggestion SET triage_status='ready_for_review' WHERE id=$1", [sid]);
  await assert.rejects(() => applyApprovedConsolidation({ suggestion_id: sid, approved: true }));
});

test("5-6. approval gating and candidate preservation", async () => {
  const p = `app-${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Source A", content: `Important fact one ${uniq()}.`, confidence: 0.9 });
  const b = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Source B", content: `Important fact two ${uniq()}.`, confidence: 0.6 });
  const sid = await makeSuggestion([a.id, b.id], "duplicate", 0.995, p);
  await core.dbQuery("UPDATE consolidation_suggestion SET triage_status='ready_for_review' WHERE id=$1", [sid]);
  await assert.rejects(() => applyApprovedConsolidation({ suggestion_id: sid, approved: false }));
  const r = await applyApprovedConsolidation({ suggestion_id: sid, approved: true, actor: "test" });
  assert.equal(r.verified, false);
  assert.notEqual(await core.getMemory(a.id), null);
  assert.notEqual(await core.getMemory(b.id), null);
  assert.equal((await core.getMemory(r.derived_id)).verified, false);
});

test("7. rollback expires only the derived memory", async () => {
  const p = `rb-${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "RB source", content: `Rollback source ${uniq()}.` });
  const sid = await makeSuggestion([a.id], "merge", 0.99, p);
  await core.dbQuery("UPDATE consolidation_suggestion SET triage_status='ready_for_review' WHERE id=$1", [sid]);
  const applied = await applyApprovedConsolidation({ suggestion_id: sid, approved: true });
  const rb = (await core.dbQuery("SELECT id FROM consolidation_rollback WHERE derived_id=$1", [applied.derived_id])).rows[0];
  const r = await rollbackConsolidation({ rollback_id: rb.id });
  assert.ok(r.expired_derived);
  const derived = await core.getMemory(applied.derived_id);
  assert.ok(derived.valid_until);
  assert.notEqual(await core.getMemory(a.id), null);
});

test("8. original memory content integrity", async () => {
  const p = `int-${uniq()}`;
  const original = `Original immutable content ${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Immutable", content: original });
  const sid = await makeSuggestion([a.id], "duplicate", 0.99, p);
  await core.dbQuery("UPDATE consolidation_suggestion SET triage_status='ready_for_review' WHERE id=$1", [sid]);
  await applyApprovedConsolidation({ suggestion_id: sid, approved: true });
  assert.equal((await core.getMemory(a.id)).content, original);
});

test("9. idempotent triage", async () => {
  const p = `tri-${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Triage", content: `Triage test ${uniq()}.` });
  await makeSuggestion([a.id], "duplicate", 0.995, p);
  await makeSuggestion([a.id], "contradiction", 0.8, p);
  const first = await triageSuggestions({ batch: 500, project_id: p });
  const second = await triageSuggestions({ batch: 500, project_id: p });
  assert.ok(first.seen >= 2);
  assert.equal(second.seen, 0);
});

test("10. large-batch triage is bounded", async () => {
  const r = await triageSuggestions({ batch: 200 });
  assert.ok(r.seen <= 200);
});

test("quality report returns real counts", async () => {
  const r = await qualityReport({});
  assert.ok(r.memories >= 1);
  assert.ok(Array.isArray(r.suggestions));
});

test("close", async () => { await core.close(); });
