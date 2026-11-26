import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { rankMemories, adaptiveRetrieve } from "../src/adaptiveRetrieval.js";

const uniq = () => `p13c-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

async function mem(project, title, content, extra = {}) {
  return core.saveMemory({ layer: "knowledge", project_id: project, title, content, ...extra });
}

test("1. verified production memory outranks test fixture on equal base score", async () => {
  const p = `rank-${uniq()}`;
  const a = await mem(p, `Prod ${uniq()}`, `redis ttl policy in ${p}`, { verified: true, source_kind: "verified", provenance: "production", confidence: 0.8 });
  const b = await mem(p, `Fixture ${uniq()}`, `redis ttl fixture note in ${p}`, { provenance: "test_fixture", confidence: 0.8 });
  const r = await rankMemories({ project_id: p, limit: 5, results: [
    { id: a.id, memory_id: a.id, rerank_score: 0.5, verified: true, source_kind: "verified", provenance: "production", lifecycle: "HYPOTHESIS", metadata: {}, confidence: 0.8, content: a.content, title: a.title },
    { id: b.id, memory_id: b.id, rerank_score: 0.5, verified: false, source_kind: "observed", provenance: "test_fixture", lifecycle: "HYPOTHESIS", metadata: {}, confidence: 0.8, content: b.content, title: b.title },
  ] });
  assert.equal(r.results[0].id, a.id);
  assert.ok(r.results[1].ranking_components.provenance < 0);
});

test("2. irrelevant memories are not boosted into the result set", async () => {
  const p = `irr-${uniq()}`;
  const m = await mem(p, `Irrelevant ${uniq()}`, `unrelated造船 recipe for ${p}`);
  const r = await adaptiveRetrieve({ query: "redis cache ttl", project_id: p, limit: 5 });
  assert.equal(r.results.some((x) => x.id === m.id), false);
});

test("3. cross-project leakage is prevented", async () => {
  const p1 = `iso-a-${uniq()}`, p2 = `iso-b-${uniq()}`;
  const m = await mem(p1, `Private ${uniq()}`, `Only in ${p1} use redis ttl.`);
  const r = await adaptiveRetrieve({ query: "redis ttl", project_id: p2, limit: 10 });
  assert.equal(r.results.some((x) => x.id === m.id), false);
});

test("4. every result exposes explainable ranking fields", async () => {
  const p = `explain-${uniq()}`;
  await mem(p, `Explain ${uniq()}`, `Use redis with ttl in ${p}`);
  const r = await adaptiveRetrieve({ query: "redis ttl", project_id: p, limit: 3 });
  for (const x of r.results) {
    assert.ok(x.ranking_components && typeof x.ranking_components === "object");
    assert.ok(typeof x.retrieval_reason === "string");
    assert.ok(x.evidence_type);
    assert.ok(x.source_session !== undefined);
  }
});

test("5. retrieval frequency is not a trust boost", async () => {
  const p = `freq-${uniq()}`;
  const a = await mem(p, `Freq ${uniq()}`, `redis ttl fact ${p}`, { verified: true });
  const r1 = await rankMemories({ project_id: p, results: [{ id: a.id, rerank_score: 0.5, verified: true, provenance: "production", source_kind: "verified", lifecycle: "HYPOTHESIS", metadata: {}, confidence: 0.8 }] });
  await core.dbQuery("UPDATE memory SET retrieved_count=1000 WHERE id=$1", [a.id]);
  const r2 = await rankMemories({ project_id: p, results: [{ id: a.id, rerank_score: 0.5, verified: true, provenance: "production", source_kind: "verified", lifecycle: "HYPOTHESIS", metadata: {}, confidence: 0.8 }] });
  assert.equal(r1.results[0].adaptive_score, r2.results[0].adaptive_score);
});

test("6. explicit and inferred usefulness stay separate", async () => {
  const p = `sig-${uniq()}`;
  const m = await mem(p, `Signal ${uniq()}`, `focused tests before full suite in ${p}`);
  const base = (await adaptiveRetrieve({ query: "focused tests", project_id: p, limit: 5 })).results.find((x) => x.id === m.id);
  assert.ok(base);
  assert.equal(base.explicit_helpful, 0);
  assert.equal(base.observed_usage, 0);
});

test("close", async () => { await core.close(); });
