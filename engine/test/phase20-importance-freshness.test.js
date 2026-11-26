// Phase 20 workstream B — explainable importance + advisory freshness tests.
// Isolated DB only. Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase20-importance-freshness.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/core.js";
import {
  IMPORTANCE_SIGNALS,
  IMPORTANCE_TIERS,
  FRESHNESS_VERDICTS,
  recordSignal,
  explainImportance,
  classifyImportance,
  freshnessPolicy,
  reviewFreshness,
  recordFreshnessReview,
  getFreshnessReviews,
  getSignals,
} from "../src/memoryImportance.js";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const DAY = 86400000;
const projectA = `impfrsh-a-${randomUUID()}`;
const projectB = `impfrsh-b-${randomUUID()}`;

const ids = {};
const baseline = new Map();

async function ensureTables() {
  // Additive, idempotent guard. Migration 018 already creates these in the test
  // DB; this is a no-op there and only makes THIS test self-sufficient.
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS memory_importance_signal (
      id bigserial PRIMARY KEY,
      memory_id uuid NOT NULL,
      project_id text NOT NULL,
      signal_type text NOT NULL,
      weight real NOT NULL DEFAULT 0,
      reason text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (memory_id, signal_type)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS memory_freshness_review (
      id bigserial PRIMARY KEY,
      memory_id uuid NOT NULL,
      project_id text NOT NULL,
      verdict text NOT NULL,
      reason text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      suggested_action text NOT NULL DEFAULT 'none',
      reviewed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function fixture(opts) {
  return core.saveMemory({
    layer: "knowledge",
    project_id: projectA,
    title: `phase20-${randomUUID()}`,
    content: "phase 20 importance/freshness fixture (test data)",
    noEmbed: true,
    source_kind: "observed",
    category: "knowledge",
    verified: false,
    confidence: 0.6,
    importance: 0.5,
    ...opts,
  });
}

test.before(async () => {
  await ensureTables();
  ids.main = await fixture({ category: "knowledge" });
  ids.crit = await fixture({ category: "decision", importance: 0.9, verified: true });
  ids.freq = await fixture({ category: "knowledge", importance: 0.7 });
  ids.constraint = await fixture({ category: "constraint", verified: true });
  ids.old = await fixture({ category: "decision" });
  ids.evidence = await fixture({ category: "config" });
  ids.expiry = await fixture({ category: "knowledge" });
  ids.other = await core.saveMemory({
    layer: "knowledge",
    project_id: projectB,
    title: `phase20-other-${randomUUID()}`,
    content: "phase 20 other-project fixture (test data)",
    noEmbed: true,
    category: "knowledge",
  });

  const all = Object.values(ids).map((m) => m.id);
  const { rows } = await core.dbQuery(
    "SELECT id, verified, confidence, importance FROM memory WHERE id = ANY($1::uuid[])",
    [all],
  );
  for (const r of rows) {
    baseline.set(r.id, {
      verified: !!r.verified,
      confidence: Number(r.confidence),
      importance: Number(r.importance),
    });
  }
});

test.after(() => core.close());

// ---- 0. exact exports -------------------------------------------------------
test("0. exact exports and frozen constants exist", () => {
  for (const fn of [recordSignal, explainImportance, classifyImportance, freshnessPolicy,
    reviewFreshness, recordFreshnessReview, getFreshnessReviews, getSignals]) {
    assert.equal(typeof fn, "function");
  }
  assert.equal(Object.isFrozen(IMPORTANCE_SIGNALS), true);
  assert.equal(Object.isFrozen(IMPORTANCE_TIERS), true);
  assert.equal(Object.isFrozen(FRESHNESS_VERDICTS), true);
  assert.deepEqual(Object.values(IMPORTANCE_SIGNALS).sort(), [
    "active_constraint", "critical_decision", "frequent_reuse", "redundant",
    "relationship_reference", "task_specific", "user_explicit", "verified_evidence",
  ]);
  assert.deepEqual(Object.values(IMPORTANCE_TIERS), ["critical", "important", "reusable", "temporary", "low"]);
});

// ---- 1. recordSignal happy path + one row + no verification changes ----------
test("1. recordSignal writes one signal and leaves verified/confidence/importance untouched", async () => {
  const before = baseline.get(ids.main.id);
  const r = await recordSignal({
    memory_id: ids.main.id,
    project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.USER_EXPLICIT,
    weight: 0.8,
    reason: "user called this out explicitly",
    evidence: ["user-message"],
  });
  assert.equal(r.ok, true);
  assert.ok(r.id);
  assert.equal(r.duplicate, false);

  const list = await getSignals({ project_id: projectA, memory_id: ids.main.id });
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  const row = list.items[0];
  assert.equal(row.signal_type, "user_explicit");
  assert.equal(Number(row.weight), 0.8);
  assert.equal(row.reason, "user called this out explicitly");
  assert.deepEqual(row.evidence, { current: ["user-message"], history: [] });

  const mem = await core.getMemory(ids.main.id);
  assert.equal(!!mem.verified, before.verified);
  assert.equal(Number(mem.confidence), before.confidence);
  assert.equal(Number(mem.importance), before.importance);
});

// ---- 2. weight clamping ------------------------------------------------------
test("2. recordSignal clamps weight into [0,1]", async () => {
  const hi = await recordSignal({
    memory_id: ids.main.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.VERIFIED_EVIDENCE, weight: 5,
  });
  const lo = await recordSignal({
    memory_id: ids.main.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.RELATIONSHIP_REFERENCE, weight: -3,
  });
  assert.equal(hi.ok, true);
  assert.equal(lo.ok, true);
  const list = await getSignals({ project_id: projectA, memory_id: ids.main.id, limit: 50 });
  const byType = Object.fromEntries(list.items.map((s) => [s.signal_type, Number(s.weight)]));
  assert.equal(byType.verified_evidence, 1);
  assert.equal(byType.relationship_reference, 0);
});

// ---- 3. signal dedupe + append-only history ----------------------------------
test("3. duplicate signal upserts without deleting and preserves evidence history/reasons", async () => {
  const first = await recordSignal({
    memory_id: ids.freq.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE,
    weight: 0.4, reason: "first observation", evidence: [{ k: 1 }, "e1"],
  });
  const second = await recordSignal({
    memory_id: ids.freq.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE,
    weight: 0.9, reason: "second observation", evidence: ["e2"],
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id, "same row is updated, not replaced");

  const list = await getSignals({ project_id: projectA, memory_id: ids.freq.id });
  assert.equal(list.count, 1, "UNIQUE(memory_id,signal_type) holds");
  const row = list.items[0];
  assert.equal(Number(row.weight), 0.9);
  assert.match(row.reason, /first observation/);
  assert.match(row.reason, /second observation/);
  assert.deepEqual(row.evidence.current, ["e2"]);
  assert.deepEqual(row.evidence.history, [{ k: 1 }, "e1"]);

  // A third upsert moves the prior current into history (append-only).
  const third = await recordSignal({
    memory_id: ids.freq.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE,
    weight: 0.7, reason: "second observation", evidence: ["e3"],
  });
  assert.equal(third.ok, true);
  const after = (await getSignals({ project_id: projectA, memory_id: ids.freq.id })).items[0];
  assert.deepEqual(after.evidence.current, ["e3"]);
  assert.deepEqual(after.evidence.history, [{ k: 1 }, "e1", "e2"]);
  assert.match(after.reason, /first observation/);
  assert.match(after.reason, /second observation/);
  assert.equal((after.reason.match(/second observation/g) || []).length, 1, "reasons are deduped");
});

// ---- 4. critical but rarely accessed is NOT demoted --------------------------
test("4. a critical, rarely-accessed decision stays critical", async () => {
  await core.dbQuery("UPDATE memory SET retrieved_count=0 WHERE id=$1", [ids.crit.id]);
  await recordSignal({ memory_id: ids.crit.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.CRITICAL_DECISION, weight: 0.9, reason: "architecture decision" });
  // Attempt to "demote" with low-value signals.
  await recordSignal({ memory_id: ids.crit.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE, weight: 0.1 });
  await recordSignal({ memory_id: ids.crit.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.REDUNDANT, weight: 0.9 });

  const exp = await explainImportance({ memory_id: ids.crit.id, project_id: projectA });
  assert.equal(exp.ok, true);
  assert.equal(exp.tier, IMPORTANCE_TIERS.CRITICAL);
  assert.equal(exp.retrieved_count, 0);
  assert.match(exp.explanation, /never demoted/i);
  assert.equal(typeof exp.importance, "number");
  assert.ok(Array.isArray(exp.signals) && exp.signals.length >= 3);
});

// ---- 5. frequently accessed but unverified is NEVER treated as verified ------
test("5. frequent retrieval alone never implies correctness/verification", async () => {
  await core.dbQuery("UPDATE memory SET retrieved_count=500, verified=false WHERE id=$1", [ids.freq.id]);
  const exp = await explainImportance({ memory_id: ids.freq.id, project_id: projectA });
  assert.equal(exp.ok, true);
  assert.equal(exp.verified, false);
  assert.equal(exp.tier, IMPORTANCE_TIERS.REUSABLE, "frequency caps at reusable, not important/critical");
  assert.match(exp.explanation, /frequency/i);
  assert.match(exp.note, /never establishes correctness/i);
  const mem = await core.getMemory(ids.freq.id);
  assert.equal(!!mem.verified, false, "still unverified after heavy retrieval");
});

// ---- 6. explicit constraint preserved ---------------------------------------
test("6. an explicit active constraint outranks a redundant signal and is preserved", async () => {
  await recordSignal({ memory_id: ids.constraint.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.ACTIVE_CONSTRAINT, weight: 0.8, reason: "must remain true" });
  await recordSignal({ memory_id: ids.constraint.id, project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.REDUNDANT, weight: 0.9, reason: "looks duplicated" });

  const exp = await explainImportance({ memory_id: ids.constraint.id, project_id: projectA });
  assert.equal(exp.ok, true);
  assert.equal(exp.tier, IMPORTANCE_TIERS.IMPORTANT);
  const types = exp.signals.map((s) => s.signal_type).sort();
  assert.deepEqual(types, ["active_constraint", "redundant"], "both signals retained; constraint not deleted");
});

// ---- 7. classifyImportance is pure and deterministic -------------------------
test("7. classifyImportance is pure (no writes) and deterministic", async () => {
  const before = (await getSignals({ project_id: projectA })).count;
  const critical = classifyImportance({ memory_id: ids.main.id, project_id: projectA,
    signals: [
      { signal_type: IMPORTANCE_SIGNALS.CRITICAL_DECISION, weight: 0.9 },
      { signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE, weight: 0.9 },
    ] });
  const freqOnly = classifyImportance({ signals: [{ signal_type: IMPORTANCE_SIGNALS.FREQUENT_REUSE }] });
  const none = classifyImportance({ signals: [] });
  assert.equal(critical.ok, true);
  assert.equal(critical.tier, IMPORTANCE_TIERS.CRITICAL);
  assert.equal(freqOnly.tier, IMPORTANCE_TIERS.REUSABLE);
  assert.equal(none.tier, IMPORTANCE_TIERS.LOW);
  assert.equal(typeof critical.explanation, "string");
  assert.ok(critical.explanation.length > 20);
  const after = (await getSignals({ project_id: projectA })).count;
  assert.equal(after, before, "classifyImportance performs no writes");
});

// ---- 8. freshnessPolicy deterministic config --------------------------------
test("8. freshnessPolicy is deterministic: decisions/constraints long, config/dependency short", () => {
  const decision = freshnessPolicy({ category: "decision" });
  const constraint = freshnessPolicy({ category: "constraint" });
  const config = freshnessPolicy({ category: "config" });
  const dependency = freshnessPolicy({ category: "dependency" });
  const knowledge = freshnessPolicy();
  assert.ok(decision.max_age_days > config.max_age_days);
  assert.ok(constraint.max_age_days > dependency.max_age_days);
  assert.ok(decision.max_age_days >= 180);
  assert.ok(config.max_age_days <= 60);
  assert.equal(knowledge.category, "knowledge");
  assert.ok(typeof knowledge.note === "string" && knowledge.note.length > 0);
  assert.deepEqual(freshnessPolicy({ category: "decision" }), decision, "deterministic");
});

// ---- 9. old-but-valid knowledge stays current under policy -------------------
test("9. old-but-valid knowledge stays current; age alone never marks stale", async () => {
  const before = (await getFreshnessReviews({ project_id: projectA })).count;
  const future = new Date(Date.now() + 500 * DAY); // 500 days old relative to `now`
  const r = await reviewFreshness({
    memory_id: ids.old.id, project_id: projectA, now: future, evidence: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, FRESHNESS_VERDICTS.CURRENT);
  assert.ok(r.age_days >= 500);
  assert.match(r.reason, /age alone never/i);
  assert.match(r.note, /Advisory only/i);
  assert.equal(r.suggested_action, "optional_recheck", "recheck is optional, not a verdict change");
  const after = (await getFreshnessReviews({ project_id: projectA })).count;
  assert.equal(after, before, "reviewFreshness never writes");
});

// ---- 10. explicit new evidence triggers stale / needs_review -----------------
test("10. explicit evidence markers produce stale / needs_review (no writes)", async () => {
  const before = (await getFreshnessReviews({ project_id: projectA })).count;
  const stale = await reviewFreshness({ memory_id: ids.evidence.id, project_id: projectA,
    evidence: [{ marker: "status:stale", note: "values changed" }] });
  assert.equal(stale.verdict, FRESHNESS_VERDICTS.STALE);
  assert.match(stale.reason, /staleness/i);
  assert.equal(stale.suggested_action, "verify_and_update");

  const review = await reviewFreshness({ memory_id: ids.evidence.id, project_id: projectA,
    evidence: ["needs_review"] });
  assert.equal(review.verdict, FRESHNESS_VERDICTS.NEEDS_REVIEW);
  assert.equal(review.suggested_action, "human_review");

  const replaced = await reviewFreshness({ memory_id: ids.evidence.id, project_id: projectA,
    evidence: ["replaced by a newer config value"] });
  assert.equal(replaced.verdict, FRESHNESS_VERDICTS.STALE);

  const after = (await getFreshnessReviews({ project_id: projectA })).count;
  assert.equal(after, before, "reviewFreshness remains read-only");
});

// ---- 11. explicit valid_until in the past => stale --------------------------
test("11. an explicit passed valid_until yields stale", async () => {
  await core.dbQuery("UPDATE memory SET valid_until = now() - interval '2 days' WHERE id=$1", [ids.expiry.id]);
  const r = await reviewFreshness({ memory_id: ids.expiry.id, project_id: projectA });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, FRESHNESS_VERDICTS.STALE);
  assert.match(r.reason, /valid_until/i);
  assert.match(r.reason, /expiry/i);
});

// ---- 12. freshness explanation is present and explicit ----------------------
test("12. freshness review carries an explanation and advisory note", () => {
  // Already exercised via DB-backed tests; verify the pure policy note too.
  const p = freshnessPolicy({ category: "config" });
  assert.ok(typeof p.note === "string" && p.note.length > 0);
});

// ---- 13. recordFreshnessReview persists; verdict validation -----------------
test("13. recordFreshnessReview persists a bounded, project-scoped review", async () => {
  const before = (await getFreshnessReviews({ project_id: projectA })).count;
  const r = await recordFreshnessReview({
    memory_id: ids.main.id, project_id: projectA,
    verdict: FRESHNESS_VERDICTS.CURRENT,
    reason: "check passed", evidence: ["check-1"], suggested_action: "none",
  });
  assert.equal(r.ok, true);
  assert.ok(r.id);
  const after = (await getFreshnessReviews({ project_id: projectA })).count;
  assert.equal(after, before + 1);

  const list = await getFreshnessReviews({ project_id: projectA, memory_id: ids.main.id });
  const found = list.items.find((x) => x.id === r.id);
  assert.ok(found);
  assert.equal(found.verdict, "current");
  assert.equal(found.reason, "check passed");
  assert.deepEqual(found.evidence, ["check-1"]);
  assert.equal(found.suggested_action, "none");

  const bad = await recordFreshnessReview({ memory_id: ids.main.id, project_id: projectA, verdict: "bogus" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid_verdict");
});

// ---- 14. freshness reviews: project isolation + bounded limit ----------------
test("14. getFreshnessReviews is project-scoped and bounded", async () => {
  await recordFreshnessReview({ memory_id: ids.other.id, project_id: projectB,
    verdict: FRESHNESS_VERDICTS.NEEDS_REVIEW, reason: "other project" });
  for (let i = 0; i < 5; i += 1) {
    await recordFreshnessReview({ memory_id: ids.main.id, project_id: projectA,
      verdict: FRESHNESS_VERDICTS.CURRENT, reason: `bulk-${i}` });
  }

  const repA = await getFreshnessReviews({ project_id: projectA, limit: 200 });
  assert.equal(repA.ok, true);
  assert.ok(repA.items.length >= 6);
  for (const item of repA.items) assert.equal(item.project_id, projectA);
  assert.equal(repA.items.some((x) => x.memory_id === ids.other.id), false, "no cross-project leak");

  const repB = await getFreshnessReviews({ project_id: projectB, limit: 200 });
  assert.ok(repB.items.length >= 1);
  for (const item of repB.items) assert.equal(item.project_id, projectB);
  assert.equal(repB.items.some((x) => x.memory_id === ids.main.id), false);

  const bounded = await getFreshnessReviews({ project_id: projectA, limit: 2 });
  assert.equal(bounded.limit, 2);
  assert.equal(bounded.items.length, 2);
  const clamped = await getFreshnessReviews({ project_id: projectA, limit: 99999 });
  assert.equal(clamped.limit, 200, "limit clamped to 200");
});

// ---- 15. signals: project isolation + bounded limit --------------------------
test("15. getSignals is project-scoped and bounded", async () => {
  await recordSignal({ memory_id: ids.other.id, project_id: projectB,
    signal_type: IMPORTANCE_SIGNALS.TASK_SPECIFIC, reason: "other project signal" });
  const sigA = await getSignals({ project_id: projectA, limit: 200 });
  assert.equal(sigA.ok, true);
  for (const item of sigA.items) assert.equal(item.project_id, projectA);
  assert.equal(sigA.items.some((x) => x.memory_id === ids.other.id), false);

  const sigB = await getSignals({ project_id: projectB, limit: 200 });
  assert.ok(sigB.items.some((x) => x.memory_id === ids.other.id));
  assert.equal(sigB.items.some((x) => x.project_id === projectA), false);

  const bounded = await getSignals({ project_id: projectA, limit: 3 });
  assert.equal(bounded.limit, 3);
  assert.equal(bounded.items.length, 3);
  const clamped = await getSignals({ project_id: projectA, limit: 100000 });
  assert.equal(clamped.limit, 200);
});

// ---- 16. invalid inputs fail closed (no writes) ------------------------------
test("16. invalid/global inputs fail closed across all functions", async () => {
  const sigBefore = (await getSignals({ project_id: projectA })).count;
  const revBefore = (await getFreshnessReviews({ project_id: projectA })).count;

  const badSignal = await recordSignal({ memory_id: ids.main.id, project_id: projectA, signal_type: "not_a_signal" });
  assert.equal(badSignal.ok, false);
  assert.equal(badSignal.reason, "invalid_signal_type");

  const badId = await recordSignal({ memory_id: "not-a-uuid", project_id: projectA,
    signal_type: IMPORTANCE_SIGNALS.USER_EXPLICIT });
  assert.equal(badId.ok, false);
  assert.equal(badId.reason, "invalid_memory_id");

  const globalWrite = await recordSignal({ memory_id: ids.main.id, project_id: "_global",
    signal_type: IMPORTANCE_SIGNALS.USER_EXPLICIT });
  assert.equal(globalWrite.ok, false);
  assert.equal(globalWrite.reason, "invalid_project_id");

  const globalReview = await recordFreshnessReview({ memory_id: ids.main.id, project_id: "_global",
    verdict: FRESHNESS_VERDICTS.CURRENT });
  assert.equal(globalReview.ok, false);
  assert.equal(globalReview.reason, "invalid_project_id");

  for (const pid of ["", "   ", "_global", 123, null, undefined, {}]) {
    const r = await recordSignal({ memory_id: ids.main.id, project_id: pid,
      signal_type: IMPORTANCE_SIGNALS.USER_EXPLICIT });
    assert.equal(r.ok, false, `expected fail-closed for ${JSON.stringify(pid)}`);
    const g = await getSignals({ project_id: pid });
    assert.equal(g.ok, false);
    assert.deepEqual(g.items, []);
    const fr = await getFreshnessReviews({ project_id: pid });
    assert.equal(fr.ok, false);
    const exp = await explainImportance({ memory_id: ids.main.id, project_id: pid });
    assert.equal(exp.ok, false);
    const rv = await reviewFreshness({ memory_id: ids.main.id, project_id: pid });
    assert.equal(rv.ok, false);
  }

  const badNow = await reviewFreshness({ memory_id: ids.main.id, project_id: projectA, now: "not-a-date" });
  assert.equal(badNow.ok, false);
  assert.equal(badNow.reason, "invalid_now");

  const badLimit = await getSignals({ project_id: projectA, limit: -5 });
  assert.equal(badLimit.limit, 50, "invalid limit falls back to 50");

  const sigAfter = (await getSignals({ project_id: projectA })).count;
  const revAfter = (await getFreshnessReviews({ project_id: projectA })).count;
  assert.equal(sigAfter, sigBefore, "invalid inputs wrote no signals");
  assert.equal(revAfter, revBefore, "invalid inputs wrote no reviews");
});

// ---- 17. recordSignal wrong project fails closed -----------------------------
test("17. recordSignal / recordFreshnessReview reject a memory from another project", async () => {
  const sigBefore = (await getSignals({ project_id: projectB })).count;
  const r = await recordSignal({ memory_id: ids.main.id, project_id: projectB,
    signal_type: IMPORTANCE_SIGNALS.USER_EXPLICIT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "memory_not_found_in_project");

  const fr = await recordFreshnessReview({ memory_id: ids.main.id, project_id: projectB,
    verdict: FRESHNESS_VERDICTS.CURRENT });
  assert.equal(fr.ok, false);
  assert.equal(fr.reason, "memory_not_found_in_project");

  assert.equal((await getSignals({ project_id: projectB })).count, sigBefore);
});

// ---- 18. verification fields unchanged across the whole suite ----------------
test("18. no verification/confidence/importance value changed anywhere in the suite", async () => {
  const all = Object.keys(ids).map((k) => ids[k].id);
  const { rows } = await core.dbQuery(
    "SELECT id, verified, confidence, importance FROM memory WHERE id = ANY($1::uuid[])",
    [all],
  );
  assert.equal(rows.length, all.length);
  for (const r of rows) {
    const b = baseline.get(r.id);
    assert.ok(b, `missing baseline for ${r.id}`);
    assert.equal(!!r.verified, b.verified, `verified changed for ${r.id}`);
    assert.equal(Number(r.confidence), b.confidence, `confidence changed for ${r.id}`);
    assert.equal(Number(r.importance), b.importance, `importance changed for ${r.id}`);
  }
});
