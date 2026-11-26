import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as intel from "../src/intelligence.js";
import * as feedback from "../src/retrievalFeedback.js";
import * as transcript from "../src/transcript.js";

const uniq = () => `p12a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("1-2. retrieval event records session and canonical project attribution", async () => {
  const p = `attr-${uniq()}`, sid = `sess-${uniq()}`;
  await core.saveMemory({ layer: "knowledge", project_id: p, title: "Attribution test", content: `Redis cache ttl policy in ${p}.` });
  const r = await intel.contextRetrieve({ query: "redis cache ttl", project_id: p, session_id: sid });
  const ev = (await core.dbQuery("SELECT session_id,project_id,session_project_id,ranking_source FROM memory_retrieval_events WHERE id=$1", [r.event_id])).rows[0];
  assert.equal(ev.session_id, sid);
  assert.equal(ev.project_id, p);
  assert.equal(ev.session_project_id, p);
  assert.equal(ev.ranking_source, "hybrid+rerank");
});

test("3. multiple retrievals in one session are recorded separately", async () => {
  const p = `multi-${uniq()}`, sid = `sess-${uniq()}`;
  const a = await intel.contextRetrieve({ query: "redis ttl", project_id: p, session_id: sid });
  const b = await intel.contextRetrieve({ query: "focused tests", project_id: p, session_id: sid });
  const n = (await core.dbQuery("SELECT count(*)::int n FROM memory_retrieval_events WHERE session_id=$1", [sid])).rows[0].n;
  assert.ok(n >= 2);
  assert.notEqual(a.event_id, b.event_id);
});

test("4. explicit helpful and unhelpful feedback", async () => {
  const p = `exp-${uniq()}`, sid = `sess-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: `Explicit ${uniq()}`, content: `Use redis with ttl in ${p}.` });
  const r = await intel.contextRetrieve({ query: "redis ttl", project_id: p, session_id: sid });
  await feedback.explicitFeedback({ event_id: r.event_id, memory_id: m.id, verdict: "helpful", reason: "matched" });
  const row = (await core.dbQuery("SELECT signal,source FROM memory_usefulness_observations WHERE event_id=$1 AND memory_id=$2 ORDER BY id DESC LIMIT 1", [r.event_id, m.id])).rows[0];
  assert.equal(row.signal, "helpful");
  assert.equal(row.source, "user");
});

test("5. observed usage requires a later verbatim reference, never claims helpful", async () => {
  const p = `obs-${uniq()}`, sid = `sess-${uniq()}`;
  const title = `Distinctive redis ttl policy ${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title, content: `Redis cache ttl policy details for ${p}.` });
  const r = await intel.contextRetrieve({ query: title, project_id: p, session_id: sid });
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: `Applying ${title} now.` });
  const o = await feedback.observeUsage({ event_id: r.event_id, session_id: sid });
  assert.ok(o.observed >= 1);
  const row = (await core.dbQuery("SELECT signal,source FROM memory_usefulness_observations WHERE event_id=$1 AND memory_id=$2 AND signal='observed_usage'", [r.event_id, m.id])).rows[0];
  assert.equal(row.source, "deterministic");
  const helpful = (await core.dbQuery("SELECT count(*)::int n FROM memory_usefulness_observations WHERE event_id=$1 AND memory_id=$2 AND signal='helpful'", [r.event_id, m.id])).rows[0].n;
  assert.equal(helpful, 0);
});

test("6. ranking uses evidence and explains adjustments", async () => {
  const p = `rank-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: `Ranked ${uniq()}`, content: `Focused tests before full suite in ${p}.` });
  const before = await intel.contextRetrieve({ query: "focused tests before full suite", project_id: p });
  const hitBefore = before.results.find((x) => x.id === m.id);
  assert.ok(hitBefore);
  assert.ok(Array.isArray(hitBefore.ranking_explanation));
  await core.dbQuery("UPDATE memory SET useful_count=useful_count+3 WHERE id=$1", [m.id]);
  const after = await intel.contextRetrieve({ query: "focused tests before full suite", project_id: p });
  const hitAfter = after.results.find((x) => x.id === m.id);
  assert.ok(hitAfter.rerank_score >= hitBefore.rerank_score);
  assert.ok(hitAfter.ranking_explanation.some((x) => x.startsWith("usefulness:")));
});

test("7. no fabricated usefulness when no later evidence exists", async () => {
  const p = `none-${uniq()}`, sid = `sess-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: `No evidence ${uniq()}`, content: `Unused fact about ${p}.` });
  const r = await intel.contextRetrieve({ query: "unused fact", project_id: p, session_id: sid });
  const o = await feedback.observeUsage({ event_id: r.event_id, session_id: sid });
  assert.equal(o.observed, 0);
  const n = (await core.dbQuery("SELECT count(*)::int n FROM memory_usefulness_observations WHERE event_id=$1 AND memory_id=$2", [r.event_id, m.id])).rows[0].n;
  assert.equal(n, 0);
});

test("8. cross-session retrieval with attribution", async () => {
  const p = `cross-${uniq()}`, a = `sessA-${uniq()}`, b = `sessB-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p, title: `Decision ${uniq()}`, content: `Decided to use postgres for ${p}.`, source_kind: "verified" });
  await intel.contextRetrieve({ query: "postgres decision", project_id: p, session_id: a });
  const r = await intel.contextRetrieve({ query: "postgres decision", project_id: p, session_id: b });
  assert.ok(r.results.some((x) => x.id === m.id));
  const ev = (await core.dbQuery("SELECT session_id FROM memory_retrieval_events WHERE id=$1", [r.event_id])).rows[0];
  assert.equal(ev.session_id, b);
});

test("9. no cross-project leakage", async () => {
  const p1 = `iso1-${uniq()}`, p2 = `iso2-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p1, title: `Secret ${uniq()}`, content: `Only in ${p1} use redis ttl.` });
  const r = await intel.contextRetrieve({ query: "redis ttl", project_id: p2, limit: 20 });
  assert.equal(r.results.some((x) => x.id === m.id), false);
});

test("usefulness summary distinguishes categories", async () => {
  const s = await feedback.usefulnessSummary({});
  assert.equal(s.ok, true);
  assert.ok("not_enough_evidence" in s.buckets);
});

test("close", async () => { await core.close(); });
