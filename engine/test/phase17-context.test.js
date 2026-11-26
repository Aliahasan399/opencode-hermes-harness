// Phase 17 capability A: Project Context Intelligence.
// Isolated DB, additive only: inserts/updates, unique project ids, no deletions.
// Run: cd engine; $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase17-context.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Force the isolated database BEFORE core is imported (dynamic imports are used below
// because static ESM imports are hoisted and would read the environment too early).
process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const {
  upsertProjectContext,
  getProjectContext,
  listProjectContextFacts,
  supersedeFact,
  clearContextCache,
} = await import("../src/contextIntel.js");

const uniq = () => `p17ctx-${crypto.randomUUID()}`;

// ---- 1. create -------------------------------------------------------------
test("1. upsert creates a project context and its facts", async () => {
  const pid = uniq();
  const r = await upsertProjectContext({
    project_id: pid,
    summary: "Phase 17 test project",
    source: "test-suite",
    source_session: "ses-p17-create",
    facts: [
      { key: "runtime", value: "node", source: "session-A" },
      { key: "db", value: { engine: "postgres", scoped: true }, status: "verified", confidence: 0.9 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.project_id, pid);
  assert.equal(r.created, 2, "both facts are newly created");
  assert.equal(r.updated, 0);
  assert.equal(r.skipped, 0);
  assert.equal(Array.isArray(r.facts), true);

  const ctx = await getProjectContext({ project_id: pid });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.found, true);
  assert.equal(ctx.project_id, pid);
  assert.equal(ctx.summary, "Phase 17 test project");
  assert.equal(ctx.facts.runtime, "node");
  assert.deepEqual(ctx.facts.db, { engine: "postgres", scoped: true });
  assert.ok(ctx.updated_at, "updated_at is refreshed");

  const listed = await listProjectContextFacts({ project_id: pid });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 2);
});

// ---- 2. incremental update preserves history -------------------------------
test("2. updating a fact keeps the old value in evidence history", async () => {
  const pid = uniq();
  await upsertProjectContext({
    project_id: pid,
    source: "test-suite",
    facts: [{ key: "framework", value: "v1", status: "observed", source: "session-A",
      evidence: [{ note: "initial observation" }] }],
  });

  const r2 = await upsertProjectContext({
    project_id: pid,
    facts: [{ key: "framework", value: "v2", status: "verified", source: "session-B",
      confidence: 0.8, evidence: [{ note: "re-checked" }] }],
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.updated, 1, "changed fact is an update, not a new row");
  assert.equal(r2.created, 0);

  const listed = await listProjectContextFacts({ project_id: pid });
  assert.equal(listed.count, 1, "still exactly one row for the key");
  const f = listed.items[0];
  assert.equal(f.value, "v2", "current value is the new one");
  assert.equal(f.status, "verified");
  assert.equal(f.source, "session-B");

  const history = f.evidence.filter((e) => e && e.value === "v1");
  assert.equal(history.length, 1, "old value is preserved in evidence");
  assert.equal(history[0].status, "observed");
  assert.equal(history[0].source, "session-A");
  assert.ok(history[0].changed_at, "history record is timestamped");

  // The compact map reflects only the current value.
  const ctx = await getProjectContext({ project_id: pid });
  assert.equal(ctx.facts.framework, "v2");
});

// ---- 3. duplicate prevention -----------------------------------------------
test("3. identical key+value+status is deduplicated within and across calls", async () => {
  const pid = uniq();
  const r1 = await upsertProjectContext({
    project_id: pid,
    facts: [
      { key: "lang", value: "en", status: "observed" },
      { key: "lang", value: "en", status: "observed" }, // same request duplicate
    ],
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.created, 1);
  assert.equal(r1.skipped, 1, "in-request duplicate is skipped");

  const before = await listProjectContextFacts({ project_id: pid });
  assert.equal(before.count, 1);
  const evidenceBefore = before.items[0].evidence.length;

  const r2 = await upsertProjectContext({
    project_id: pid,
    facts: [{ key: "lang", value: "en", status: "observed" }], // identical across calls
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.skipped, 1, "idempotent no-op is skipped");

  const after = await listProjectContextFacts({ project_id: pid });
  assert.equal(after.count, 1, "no duplicate row was inserted");
  assert.equal(after.items[0].evidence.length, evidenceBefore, "no spurious history appended");
});

// ---- 4. project isolation --------------------------------------------------
test("4. facts are isolated per project", async () => {
  const a = uniq(), b = uniq();
  await upsertProjectContext({ project_id: a, facts: [{ key: "marker", value: "ONLY-A" }] });
  await upsertProjectContext({ project_id: b, facts: [{ key: "other", value: "ONLY-B" }] });

  const ctxA = await getProjectContext({ project_id: a });
  const ctxB = await getProjectContext({ project_id: b });
  assert.equal(ctxA.facts.marker, "ONLY-A");
  assert.equal(ctxA.facts.other, undefined);
  assert.equal(ctxB.facts.other, "ONLY-B");
  assert.equal(ctxB.facts.marker, undefined);

  const listB = await listProjectContextFacts({ project_id: b });
  assert.equal(listB.items.some((x) => x.key === "marker"), false);
});

// ---- 5. source provenance --------------------------------------------------
test("5. fact-level source overrides top-level; source_session is retained", async () => {
  const pid = uniq();
  await upsertProjectContext({
    project_id: pid,
    source: "top-level-source",
    source_session: "ses-top",
    facts: [
      { key: "s1", value: 1, source: "fact-level-source", source_session: "ses-fact" },
      { key: "s2", value: 2 }, // falls back to top-level values
    ],
  });
  const listed = await listProjectContextFacts({ project_id: pid });
  const s1 = listed.items.find((x) => x.key === "s1");
  const s2 = listed.items.find((x) => x.key === "s2");
  assert.equal(s1.source, "fact-level-source");
  assert.equal(s1.source_session, "ses-fact");
  assert.equal(s2.source, "top-level-source");
  assert.equal(s2.source_session, "ses-top");
});

// ---- 6. invalid input / fail closed ---------------------------------------
test("6. invalid input fails closed with structured errors", async () => {
  const bad = [
    await upsertProjectContext({ project_id: "", facts: [] }),
    await upsertProjectContext({ project_id: "   ", facts: [] }),
    await upsertProjectContext({ project_id: "_global", facts: [{ key: "k", value: 1 }] }),
    await getProjectContext({ project_id: "_global" }),
    await listProjectContextFacts({ project_id: null }),
    await supersedeFact({ project_id: uniq(), fact_key: "" }),
    await upsertProjectContext({ project_id: uniq(), facts: [{ key: "k", value: 1, status: "bogus" }] }),
    await upsertProjectContext({ project_id: uniq(), facts: [{ key: "", value: 1 }] }),
    await upsertProjectContext({ project_id: uniq(), facts: "not-an-array" }),
  ];
  for (const r of bad) {
    assert.equal(r.ok, false, "invalid requests must never return ok:true");
    assert.ok(r.error && typeof r.error.code === "string", "errors are structured");
    assert.ok(typeof r.error.message === "string" && r.error.message.length > 0);
  }
  // The '_global' sentinel is a sentinel, not a writable project id.
  assert.equal(bad[2].error.code, "invalid_project_id");
});

// ---- 7. read fail-closed and not-found ------------------------------------
test("7. reads fail closed for invalid ids and report not-found cleanly", async () => {
  assert.equal((await getProjectContext({})).ok, false);
  assert.equal((await getProjectContext({ project_id: 123 })).ok, false);
  const missing = await getProjectContext({ project_id: uniq() });
  assert.equal(missing.ok, true);
  assert.equal(missing.found, false);
  assert.deepEqual(missing.facts, {});
  assert.equal(missing.summary, "");

  const emptyList = await listProjectContextFacts({ project_id: uniq() });
  assert.equal(emptyList.ok, true);
  assert.equal(emptyList.count, 0);
});

// ---- 8. confidence clamped -------------------------------------------------
test("8. confidence is clamped to [0,1] or null", async () => {
  const pid = uniq();
  await upsertProjectContext({
    project_id: pid,
    facts: [
      { key: "low", value: 1, confidence: -5 },
      { key: "high", value: 2, confidence: 7 },
      { key: "nan", value: 3, confidence: "not-a-number" },
      { key: "none", value: 4 },
    ],
  });
  const listed = await listProjectContextFacts({ project_id: pid });
  const get = (k) => listed.items.find((x) => x.key === k).confidence;
  assert.equal(get("low"), 0);
  assert.equal(get("high"), 1);
  assert.equal(get("nan"), null);
  assert.equal(get("none"), null);
});

// ---- 9. supersede fact -----------------------------------------------------
test("9. supersedeFact marks status without deleting and records the reason", async () => {
  const pid = uniq();
  await upsertProjectContext({
    project_id: pid,
    facts: [{ key: "decision", value: "use X", status: "verified", source: "session-A" }],
  });
  const r = await supersedeFact({
    project_id: pid,
    fact_key: "decision",
    reason: "replaced by a newer decision",
    evidence: [{ note: "review" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.superseded, true);

  const listed = await listProjectContextFacts({ project_id: pid });
  assert.equal(listed.count, 1, "row still exists after supersede");
  assert.equal(listed.items[0].status, "superseded");
  assert.equal(listed.items[0].value, "use X", "value is intact");
  const ev = listed.items[0].evidence.find((e) => e && e.event === "superseded");
  assert.ok(ev, "supersede event is in evidence");
  assert.equal(ev.reason, "replaced by a newer decision");

  const supersededOnly = await listProjectContextFacts({ project_id: pid, status: "superseded" });
  assert.equal(supersededOnly.count, 1);
  const observedOnly = await listProjectContextFacts({ project_id: pid, status: "observed" });
  assert.equal(observedOnly.count, 0);
});

// ---- 10. bounded list + cache clear ---------------------------------------
test("10. list is bounded by limit and cache clear is harmless", async () => {
  const pid = uniq();
  const facts = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: i }));
  const r = await upsertProjectContext({ project_id: pid, facts });
  assert.equal(r.created, 6);

  const limited = await listProjectContextFacts({ project_id: pid, limit: 3 });
  assert.equal(limited.items.length, 3);
  assert.equal(limited.count, 3);

  clearContextCache();
  const ctx = await getProjectContext({ project_id: pid, limit: 2 });
  assert.equal(Object.keys(ctx.facts).length, 2);
});

test("close pool", async () => { await core.close(); });
