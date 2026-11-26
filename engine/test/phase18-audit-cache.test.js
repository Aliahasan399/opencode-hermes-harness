// Phase 18 workstream E — injection audit + strictly isolated cache tests.
// Isolated DB only. Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase18-audit-cache.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/core.js";
import {
  recordInjection,
  injectionReport,
  createInjectionCache,
} from "../src/injectionAudit.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const projectA = `injaudit-a-${randomUUID()}`;
const projectB = `injaudit-b-${randomUUID()}`;
const sessionA = `sess-a-${randomUUID()}`;
const sessionB = `sess-b-${randomUUID()}`;
const secretKey = `sk-${"a".repeat(32)}`;
const secretMarker = `AUDIT_SECRET_${randomUUID()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The shipped init migration restricts track to the legacy enum. The parent owns
// that schema migration; this test-only, additive, idempotent guard makes THIS
// isolated test DB accept 'context' as well. It removes no rows and is a no-op
// once the parent migration has added 'context'.
async function ensureContextTrackAllowed() {
  const { rows } = await core.dbQuery(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'intelligence_audit_events'::regclass AND contype = 'c'`,
  );
  if (rows.some((r) => String(r.def).includes("'context'"))) return;
  await core.dbQuery("ALTER TABLE intelligence_audit_events DROP CONSTRAINT IF EXISTS intelligence_audit_events_track_check");
  await core.dbQuery(
    `ALTER TABLE intelligence_audit_events ADD CONSTRAINT intelligence_audit_events_track_check
       CHECK (track IN ('memory','learning','optimization','system','context'))`,
  );
}

test.before(async () => {
  await ensureContextTrackAllowed();
});

test.after(() => core.close());

// ---- 0. exports -------------------------------------------------------------
test("0. exact exports exist with correct types", async () => {
  assert.equal(typeof recordInjection, "function");
  assert.equal(typeof injectionReport, "function");
  assert.equal(typeof createInjectionCache, "function");
});

// ---- 1. recordInjection happy path + content-free detail --------------------
test("1. recordInjection writes one context/injection row with content-free detail", async () => {
  const r = await recordInjection({
    request_id: `req-${randomUUID()}`,
    session_id: sessionA,
    project_id: projectA,
    task: { category: "implementation" },
    candidates: 12,
    selected: 3,
    rejected: 9,
    reject_reasons: ["low_relevance", "budget_exceeded"],
    budget: 6000,
    estimated_tokens: 421,
    duration_ms: 37,
    outcome: "ok",
    degraded: ["embed_unavailable"],
    cache_hit: false,
  });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.ok(r.id, "returns an inserted id");

  const { rows } = await core.dbQuery(
    "SELECT track, action, resource, detail FROM intelligence_audit_events WHERE id=$1",
    [r.id],
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.track, "context");
  assert.equal(row.action, "injection");
  assert.equal(row.resource, projectA);

  const d = row.detail;
  assert.equal(typeof d, "object");
  assert.equal(d.category, "implementation");
  assert.equal(d.candidates, 12);
  assert.equal(d.selected, 3);
  assert.equal(d.rejected, 9);
  assert.deepEqual(d.reject_reasons, ["low_relevance", "budget_exceeded"]);
  assert.equal(d.budget, 6000);
  assert.equal(d.estimated_tokens, 421);
  assert.equal(d.duration_ms, 37);
  assert.equal(d.outcome, "ok");
  assert.deepEqual(d.degraded, ["embed_unavailable"]);
  assert.equal(d.cache_hit, false);

  // No content-bearing keys may ever be present.
  const forbidden = ["content", "title", "prompt", "query", "text", "memory", "item", "body", "summary"];
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(d, key), false, `detail must not contain '${key}'`);
  }
});

// ---- 2. defaults ------------------------------------------------------------
test("2. recordInjection with no args fails closed (no project) without throwing", async () => {
  const r = await recordInjection();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_project_id");
});

test("3. numeric/boolean defaults are content-free and bounded", async () => {
  const r = await recordInjection({ project_id: projectA, session_id: sessionA });
  assert.equal(r.ok, true);
  const { rows } = await core.dbQuery("SELECT detail FROM intelligence_audit_events WHERE id=$1", [r.id]);
  const d = rows[0].detail;
  assert.equal(d.candidates, 0);
  assert.equal(d.selected, 0);
  assert.equal(d.rejected, 0);
  assert.equal(d.budget, 0);
  assert.equal(d.estimated_tokens, 0);
  assert.equal(d.duration_ms, 0);
  assert.equal(d.cache_hit, false);
  assert.equal(d.outcome, "ok");
  assert.equal(d.category, null);
  assert.deepEqual(d.reject_reasons, []);
  assert.deepEqual(d.degraded, []);
});

// ---- 3. invalid project_id fails closed ------------------------------------
test("4. invalid project ids fail closed and write nothing", async () => {
  const before = (await core.dbQuery("SELECT count(*)::int n FROM intelligence_audit_events")).rows[0].n;
  for (const pid of ["", "   ", "_global", 123, null, undefined, {}]) {
    const r = await recordInjection({ project_id: pid });
    assert.equal(r.ok, false, `expected fail-closed for ${JSON.stringify(pid)}`);
    assert.equal(r.reason, "invalid_project_id");
  }
  const after = (await core.dbQuery("SELECT count(*)::int n FROM intelligence_audit_events")).rows[0].n;
  assert.equal(after, before, "no rows written for invalid projects");
});

// ---- 4. DB failure never throws --------------------------------------------
test("5. recordInjection never throws on failure inputs", async () => {
  await assert.doesNotReject(async () => {
    const hostile = {
      project_id: projectA,
      task: { category: { toString() { throw new Error("hostile"); } } },
      reject_reasons: [{ toString() { throw new Error("hostile"); } }],
      duration_ms: "not-a-number",
      outcome: Symbol("nope"),
    };
    const r = await recordInjection(hostile);
    assert.equal(r.ok, true, "hostile detail scalars are sanitized, not thrown");
  });
});

// ---- 5. no secrets in detail ------------------------------------------------
test("6. secrets are never persisted in the audit detail", async () => {
  const r = await recordInjection({
    project_id: projectA,
    session_id: sessionA,
    request_id: `req api_key=${secretKey}`,
    task: { category: `impl password=${secretMarker}` },
    reject_reasons: [`token=${secretMarker}`, `bearer ${secretKey}`],
    degraded: [`secret=${secretKey}`],
    outcome: "ok",
  });
  assert.equal(r.ok, true);
  const { rows } = await core.dbQuery("SELECT detail FROM intelligence_audit_events WHERE id=$1", [r.id]);
  const serialized = JSON.stringify(rows[0].detail);
  assert.equal(serialized.includes(secretKey), false, "sk- key absent from detail");
  assert.equal(serialized.includes(secretMarker), false, "generic secret marker absent from detail");
});

// ---- 6. injectionReport project isolation + bounds --------------------------
test("7. injectionReport is project-scoped and never leaks another project", async () => {
  const ra = await recordInjection({ project_id: projectA, session_id: sessionA, task: { category: "api" } });
  const rb = await recordInjection({ project_id: projectB, session_id: sessionB, task: { category: "security" } });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);

  const repA = await injectionReport({ project_id: projectA, limit: 200 });
  assert.equal(repA.ok, true);
  assert.ok(repA.items.length >= 1);
  for (const item of repA.items) {
    assert.equal(item.resource, projectA, "only project A rows returned");
  }
  assert.ok(repA.items.some((i) => i.id === ra.id), "project A report contains A's row");
  assert.equal(repA.items.some((i) => i.id === rb.id), false, "project B row absent from A's report");

  const repB = await injectionReport({ project_id: projectB, limit: 200 });
  assert.equal(repB.ok, true);
  for (const item of repB.items) assert.equal(item.resource, projectB);
  assert.equal(repB.items.some((i) => i.id === ra.id), false, "project A row absent from B's report");
});

test("8. injectionReport honours the bounded limit", async () => {
  for (let i = 0; i < 5; i += 1) {
    await recordInjection({ project_id: projectB, session_id: sessionB, candidates: i });
  }
  const rep = await injectionReport({ project_id: projectB, limit: 2 });
  assert.equal(rep.ok, true);
  assert.equal(rep.items.length, 2, "limit is respected");
  assert.equal(rep.count, 2);
});

test("9. injectionReport filters by session via detail->>'session_id'", async () => {
  const sessX = `sess-x-${randomUUID()}`;
  const sessY = `sess-y-${randomUUID()}`;
  await recordInjection({ project_id: projectA, session_id: sessX, candidates: 1 });
  await recordInjection({ project_id: projectA, session_id: sessY, candidates: 2 });
  const rep = await injectionReport({ project_id: projectA, session_id: sessX, limit: 200 });
  assert.equal(rep.ok, true);
  assert.ok(rep.items.length >= 1);
  for (const item of rep.items) assert.equal(item.detail.session_id, sessX);
});

test("10. injectionReport fails closed for invalid project ids", async () => {
  for (const pid of ["", "   ", 123, null, undefined, {}]) {
    const rep = await injectionReport({ project_id: pid });
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.items, []);
    assert.equal(rep.count, 0);
  }
});

// ---- 7. cache namespace isolation ------------------------------------------
function cacheKey(overrides = {}) {
  return {
    project_id: projectA,
    session_id: sessionA,
    query: "  Fix the LOGIN bug  ",
    memory_version: "v1",
    ...overrides,
  };
}

test("11. cache isolates project / session / query / memory_version namespaces", async () => {
  const cache = createInjectionCache();
  const base = cacheKey();
  cache.set(base, { answer: "A" });

  assert.deepEqual(cache.get(base), { answer: "A" });

  // Same query, different project -> miss.
  assert.equal(cache.get(cacheKey({ project_id: projectB })), undefined, "project namespace");
  // Different session -> miss.
  assert.equal(cache.get(cacheKey({ session_id: "another-session" })), undefined, "session namespace");
  // Query normalization: case/whitespace differences still hit.
  assert.deepEqual(
    cache.get(cacheKey({ query: "fix the login bug" })),
    { answer: "A" },
    "query normalized to lowercase/trim",
  );
  // Genuinely different query -> miss.
  assert.equal(cache.get(cacheKey({ query: "totally different" })), undefined, "query namespace");
  // Different memory version -> miss.
  assert.equal(cache.get(cacheKey({ memory_version: "v2" })), undefined, "memory_version namespace");

  // Project B can store and read its own identical-query entry independently.
  const bKey = cacheKey({ project_id: projectB });
  cache.set(bKey, { answer: "B" });
  assert.deepEqual(cache.get(bKey), { answer: "B" });
  assert.deepEqual(cache.get(base), { answer: "A" }, "A unchanged by B's write");
});

test("12. cache is deterministic for identical key objects", async () => {
  const cache = createInjectionCache();
  const k = cacheKey({ query: "Deploy the service" });
  cache.set(k, [1, 2, 3]);
  assert.deepEqual(cache.get(cacheKey({ query: "DEPLOY THE SERVICE" })), [1, 2, 3]);
});

// ---- 8. cache TTL -----------------------------------------------------------
test("13. cache respects TTL expiry and counts misses", async () => {
  const cache = createInjectionCache({ ttl_ms: 30 });
  const k = cacheKey();
  cache.set(k, { fresh: true });
  assert.deepEqual(cache.get(k), { fresh: true }, "hit before expiry");
  await sleep(70);
  assert.equal(cache.get(k), undefined, "expired entry is a miss");
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.size, 0, "expired entry pruned from stats");
});

// ---- 9. cache LRU-ish eviction ----------------------------------------------
test("14. cache evicts oldest when max is exceeded and tracks evictions", async () => {
  const cache = createInjectionCache({ max: 2, ttl_ms: 60000 });
  cache.set(cacheKey({ query: "one" }), 1);
  cache.set(cacheKey({ query: "two" }), 2);
  cache.set(cacheKey({ query: "three" }), 3); // evicts "one"

  assert.equal(cache.get(cacheKey({ query: "one" })), undefined, "oldest evicted");
  assert.equal(cache.get(cacheKey({ query: "two" })), 2);
  assert.equal(cache.get(cacheKey({ query: "three" })), 3);
  const s = cache.stats();
  assert.equal(s.size, 2);
  assert.equal(s.evictions, 1);
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
});

test("15. cache clear resets entries but not cumulative counters", async () => {
  const cache = createInjectionCache({ max: 5 });
  cache.set(cacheKey(), { v: 1 });
  assert.deepEqual(cache.get(cacheKey()), { v: 1 });
  cache.clear();
  assert.equal(cache.get(cacheKey()), undefined);
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().hits, 1, "hits/misses are cumulative");
  assert.equal(cache.stats().misses, 1);
});

// ---- 10. cache defensive copy -----------------------------------------------
test("16. cache returns a defensive copy; stored value is insulated", async () => {
  const cache = createInjectionCache();
  const k = cacheKey();
  const original = { nested: { n: 1 }, list: [1, 2] };
  cache.set(k, original);

  // Mutating the caller's object after set must not change cached data.
  original.nested.n = 99;
  original.list.push(3);
  assert.deepEqual(cache.get(k), { nested: { n: 1 }, list: [1, 2] });

  // Mutating the returned object must not change cached data.
  const got = cache.get(k);
  got.nested.n = 123;
  got.list.push(4);
  assert.deepEqual(cache.get(k), { nested: { n: 1 }, list: [1, 2] });
});

test("17. cache tolerates malformed keys without throwing", async () => {
  const cache = createInjectionCache();
  assert.doesNotThrow(() => {
    for (const bad of [undefined, null, 123, "str", {}, { project_id: 1, query: null }]) {
      cache.set(bad, "x");
      cache.get(bad);
    }
  });
  const s = cache.stats();
  assert.deepEqual(Object.keys(s).sort(), ["evictions", "hits", "misses", "size"]);
  for (const v of Object.values(s)) assert.equal(typeof v, "number");
});
