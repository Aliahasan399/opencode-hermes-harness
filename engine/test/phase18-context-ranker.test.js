// Phase 18 workstream C — knowledge-quality-aware relevance ranking and safe
// filtering for injected context.
// Pure module tests: no DB writes, no network, no LLM. Run with:
//   cd E:\OpenCodeData\memory\engine
//   node --test test/phase18-context-ranker.test.js
import test from "node:test";
import assert from "node:assert/strict";

// Set the isolated DB name defensively; this suite never touches the DB.
process.env.MEMORY_DB_NAME = "opencode_memory_test";

const {
  SCORING_RULES, defaultWeights, rankAndFilter, conflictWarnings, normalizeItem,
} = await import("../src/contextRanker.js");
const { CORE_CLOSE_AVAILABLE, close } = await import("../src/core.js").then(
  (m) => ({ CORE_CLOSE_AVAILABLE: typeof m.close === "function", close: m.close }),
);

const PID = "proj-alpha";
const OTHER = "proj-beta";
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const DAY = 86400000;
const fresh = new Date(NOW - 2 * DAY).toISOString();
const old = new Date(NOW - 200 * DAY).toISOString();

function item(overrides = {}) {
  return {
    type: "memory",
    id: "m-1",
    text: "deployment timeout fix",
    project_id: PID,
    verification: "observed",
    freshness_at: fresh,
    ...overrides,
  };
}

function run(items, extra = {}) {
  return rankAndFilter({ items, project_id: PID, now: NOW, ...extra });
}

function ruleKeys() {
  return Object.keys(SCORING_RULES);
}

// ---- 0. exports / documented rules ----------------------------------------
test("0. SCORING_RULES is frozen and documents every rule and contribution", () => {
  assert.ok(Object.isFrozen(SCORING_RULES), "SCORING_RULES frozen");
  assert.deepEqual(ruleKeys().sort(), [
    "verification", "projectMatch", "taskKeyword",
    "freshnessWithin30d", "relationship", "verifiedFix",
  ].sort());
  for (const key of ruleKeys()) {
    assert.equal(typeof SCORING_RULES[key].description, "string", `${key} has description`);
    assert.ok(SCORING_RULES[key].description.length > 10, `${key} documented`);
  }
  const vw = SCORING_RULES.verification.weights;
  assert.ok(Object.isFrozen(vw));
  assert.equal(vw.verified, 3);
  assert.equal(vw.observed, 2);
  assert.equal(vw.inferred, 1);
  assert.equal(vw.uncertain, 0);
  assert.equal(vw.contradicted, -2);
  assert.equal(vw.stale, -1);
  assert.equal(vw.superseded, -3);
  assert.equal(SCORING_RULES.projectMatch.weight, 2);
  assert.equal(SCORING_RULES.taskKeyword.weight, 2);
  assert.equal(SCORING_RULES.freshnessWithin30d.weight, 1);
  assert.equal(SCORING_RULES.relationship.weight, 1);
  assert.equal(SCORING_RULES.verifiedFix.weight, 2);

  const w = defaultWeights();
  w.projectMatch = 999; // must not corrupt the frozen source of truth
  assert.equal(SCORING_RULES.projectMatch.weight, 2);
});

// ---- 1. verified preference / inferred never scored as verified -----------
test("1. verified outranks inferred with identical inputs", () => {
  const r = run([
    item({ id: "inferred", text: "same text", verification: "inferred" }),
    item({ id: "verified", text: "same text2", verification: "verified" }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.selected.length, 2);
  assert.equal(r.selected[0].id, "verified");
  assert.ok(r.selected[0].score > r.selected[1].score);
  assert.equal(r.selected[0].score_breakdown.verification, 3);
  assert.equal(r.selected[1].score_breakdown.verification, 1);
});

test("2. inferred is never promoted by high confidence or a 'confirmed' alias", () => {
  const r = run([
    item({ id: "i", text: "inferred claim text", verification: "inferred", confidence: 0.9999 }),
    item({ id: "v", text: "verified claim text", verification: "verified", confidence: 0.1 }),
  ]);
  const inferred = r.selected.find((x) => x.id === "i");
  const verified = r.selected.find((x) => x.id === "v");
  assert.equal(inferred.verification, "inferred");
  assert.equal(inferred.score_breakdown.verification, 1);
  assert.equal(verified.verification, "verified");
  assert.equal(verified.score_breakdown.verification, 3);
  assert.ok(verified.score > inferred.score, "confidence never makes inferred outrank verified");

  const alias = run([item({ id: "a", text: "candidate alias text", status: "candidate", verification: undefined })]);
  assert.equal(alias.selected[0].verification, "inferred");
  assert.equal(alias.selected[0].score_breakdown.verification, 1);
});

// ---- 3. contradiction handling --------------------------------------------
test("3. contradicted items are rejected and produce a concise warning", () => {
  const r = run([
    item({ id: "bad", verification: "contradicted", text: "the build always fails" }),
    item({ id: "good", verification: "verified", text: "the build passes" }),
  ]);
  assert.ok(r.selected.some((x) => x.id === "good"));
  assert.ok(!r.selected.some((x) => x.id === "bad"));
  assert.ok(r.rejected.some((x) => x.id === "bad" && x.reason === "contradicted"));
  assert.ok(r.warnings.some((w) => w.includes("Contradicted claim") && w.includes("bad")),
    `expected contradiction warning, got ${JSON.stringify(r.warnings)}`);
});

test("4. explicit conflict names both sides and does not auto-pick one", () => {
  const items = [
    item({ id: "A", verification: "contradicted", text: "cache is disabled", conflicts_with: ["B"] }),
    item({ id: "B", verification: "verified", text: "cache is enabled" }),
  ];
  const r = run(items);
  const warning = r.warnings.find((w) => w.includes("A") && w.includes("B"));
  assert.ok(warning, `expected cross-named conflict warning, got ${JSON.stringify(r.warnings)}`);
  assert.ok(warning.includes("neither side auto-selected"));
  assert.ok(!r.selected.some((x) => x.id === "A"), "contradicted side is not selected as truth");

  const warnings = conflictWarnings(items);
  assert.ok(warnings.some((w) => w.includes("A") && w.includes("B")));
  assert.ok(warnings.every((w) => w.length <= 220));
  // Non-conflicting items produce no warnings.
  assert.deepEqual(conflictWarnings([item({ id: "clean" })]), []);
});

// ---- 4. superseded decisions ----------------------------------------------
test("5. superseded decisions are excluded, kept as history only on request", () => {
  const dec = item({ type: "decision", id: "dec-old", verification: "superseded", text: "old DB choice" });
  const plain = run([dec]);
  assert.equal(plain.selected.length, 0);
  assert.ok(plain.rejected.some((x) => x.id === "dec-old" && x.reason === "superseded"));
  assert.equal(plain.warnings.length, 0, "no history warning without a documentation/decision task");

  const doc = run([dec], { task: { category: "documentation" } });
  assert.ok(doc.warnings.some((w) => w.includes("dec-old") && w.includes("history")));

  const flagged = run([dec], { task: { category: "refactoring", retrieve: { decisions: true } } });
  assert.ok(flagged.warnings.some((w) => w.includes("history")));
});

// ---- 5. cross-project rejection -------------------------------------------
test("6. items from a different project are dropped without disclosure", () => {
  const r = run([
    item({ id: "mine", text: "own note" }),
    item({ id: "foreign", text: "secret foreign note", project_id: OTHER }),
  ]);
  assert.ok(r.selected.some((x) => x.id === "mine"));
  assert.ok(!r.selected.some((x) => x.id === "foreign"));
  assert.ok(r.rejected.some((x) => x.id === "foreign" && x.reason === "cross-project"));
  const joined = r.warnings.join(" ");
  assert.equal(joined.includes(OTHER), false, "foreign project id not leaked");
  assert.equal(joined.includes("secret foreign note"), false, "foreign content not leaked");
});

// ---- 6. global eligibility -------------------------------------------------
test("7. only explicitly globally eligible global rows pass", () => {
  const r = run([
    item({ id: "glob-ok", text: "shared", project_id: "_global", global_eligible: true }),
    item({ id: "glob-no", text: "shared but private", project_id: "_global" }),
    item({ id: "mine", text: "local" }),
  ]);
  const ids = r.selected.map((x) => x.id);
  assert.ok(ids.includes("glob-ok"));
  assert.ok(ids.includes("mine"));
  assert.ok(!ids.includes("glob-no"));
  assert.ok(r.rejected.some((x) => x.id === "glob-no" && x.reason === "cross-project"));
  const ok = r.selected.find((x) => x.id === "glob-ok");
  assert.equal(ok.score_breakdown.projectMatch, 0, "global row gets no project-match bonus");
});

test("8. metadata-based global approval is respected via memoryScope rules", () => {
  const r = run([
    item({
      id: "approved", text: "approved shared fact", project_id: "_global",
      source_kind: "user", layer: "user", verified: true,
      metadata: { global_approval: true },
    }),
    item({
      id: "not-approved", text: "unapproved shared fact", project_id: "_global",
      source_kind: "user", layer: "user", verified: true,
      metadata: { global_approval: false },
    }),
  ]);
  const ids = r.selected.map((x) => x.id);
  assert.ok(ids.includes("approved"));
  assert.ok(!ids.includes("not-approved"));
});

// ---- 7. keyword / task relevance ------------------------------------------
test("9. task keywords boost matching items (query, signals and explicit keywords)", () => {
  const r = run([
    item({ id: "match", text: "postgres connection timeout" }),
    item({ id: "miss", text: "cooking recipe for bread" }),
  ], { task: { query: "postgres timeout migration" } });
  const match = r.selected.find((x) => x.id === "match");
  const miss = r.selected.find((x) => x.id === "miss");
  assert.equal(match.score_breakdown.taskKeyword, 2);
  assert.ok(match.matched_keywords.includes("postgres"));
  assert.equal(miss.score_breakdown.taskKeyword, 0);
  assert.ok(match.score > miss.score);

  const bySignals = run([
    item({ id: "redis", text: "redis cache" }),
    item({ id: "other", text: "unrelated content" }),
  ], { task: { signals: ["redis"] } });
  assert.equal(bySignals.selected.find((x) => x.id === "redis").score_breakdown.taskKeyword, 2);

  const byKeywords = run([item({ id: "kw", text: "kubernetes deployment" })],
    { task: { keywords: ["kubernetes"] } });
  assert.equal(byKeywords.selected[0].score_breakdown.taskKeyword, 2);
});

// ---- 8. dedupe -------------------------------------------------------------
test("10. dedupe by (type,id) and by near-identical normalized text", () => {
  const r = run([
    item({ id: "dup", text: "alpha beta gamma" }),
    item({ id: "dup", text: "alpha beta gamma" }),
    item({ id: "other-id", text: "Alpha   beta, gamma!" }),
  ]);
  assert.equal(r.selected.length, 1);
  assert.equal(r.stats.deduped, 2);
  assert.ok(r.rejected.filter((x) => x.reason === "duplicate").length === 2);
});

// ---- 9. freshness ----------------------------------------------------------
test("11. fresh items earn the freshness bonus; stale ones do not", () => {
  const r = run([
    item({ id: "fresh", text: "fresh note", freshness_at: fresh }),
    item({ id: "old", text: "old note", freshness_at: old }),
  ]);
  const f = r.selected.find((x) => x.id === "fresh");
  const o = r.selected.find((x) => x.id === "old");
  assert.equal(f.score_breakdown.freshnessWithin30d, 1);
  assert.equal(o.score_breakdown.freshnessWithin30d, 0);
  assert.ok(f.score > o.score);
});

// ---- 10. limits ------------------------------------------------------------
test("12. maxItems and minScore are respected", () => {
  const four = [
    item({ id: "a", text: "a", verification: "verified" }),
    item({ id: "b", text: "b", verification: "verified" }),
    item({ id: "c", text: "c", verification: "verified" }),
    item({ id: "d", text: "d", verification: "verified" }),
  ];
  const r = run(four, { limits: { maxItems: 2 } });
  assert.equal(r.selected.length, 2);
  assert.equal(r.rejected.filter((x) => x.reason === "over-limit").length, 2);

  const min = run([
    item({ id: "strong", verification: "verified", text: "strong" }),
    item({ id: "weak", verification: "uncertain", text: "weak", freshness_at: null }),
  ], { limits: { minScore: 5 } });
  assert.deepEqual(min.selected.map((x) => x.id), ["strong"]);
  assert.ok(min.rejected.some((x) => x.id === "weak" && x.reason === "below-min-score"));
});

// ---- 11. malformed input never throws -------------------------------------
test("13. malformed items are rejected with a reason, never thrown", () => {
  const hostile = { toString() { throw new Error("hostile"); } };
  const items = [
    null, undefined, "bare string", 123, [], hostile,
    { type: "memory" }, // no id, no text
    item({ id: "ok", text: "valid" }),
  ];
  let r;
  assert.doesNotThrow(() => { r = run(items); });
  assert.equal(r.ok, true);
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0].id, "ok");
  assert.ok(r.rejected.filter((x) => x.reason === "malformed").length >= 6);
  assert.ok(r.rejected.every((x) => typeof x.id === "string" && typeof x.reason === "string"));

  for (const bad of [null, undefined, 42, "string"]) {
    let empty;
    assert.doesNotThrow(() => { empty = rankAndFilter(bad); });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.selected, []);
    assert.equal(empty.stats.input, 0);
  }
});

// ---- 12. configurable weights ---------------------------------------------
test("14. weights are configurable and reflected in breakdowns and ranking", () => {
  const items = [
    item({ id: "kw", text: "postgres timeout", verification: "observed" }),
    item({ id: "ver", text: "unrelated text", verification: "verified" }),
  ];
  const r = run(items, {
    task: { query: "postgres" },
    weights: { taskKeyword: 10, verification: { verified: 1 } },
  });
  const kw = r.selected.find((x) => x.id === "kw");
  const ver = r.selected.find((x) => x.id === "ver");
  assert.equal(kw.score_breakdown.taskKeyword, 10);
  assert.equal(ver.score_breakdown.verification, 1);
  assert.equal(r.selected[0].id, "kw", "heavy keyword weight changes the winner");
});

// ---- 13. explainable breakdowns / provenance ------------------------------
test("15. selected items carry score, complete breakdown, verification and provenance", () => {
  const r = run([
    item({
      id: "x", type: "fix", verification: "verified", text: "postgres fix",
      source: "session-notes", session: "ses-42",
    }),
    item({ id: "rel", type: "relationship", text: "depends on cache" }),
  ], { task: { query: "postgres" } });
  for (const x of r.selected) {
    assert.ok(Number.isFinite(x.score));
    assert.deepEqual(Object.keys(x.score_breakdown).sort(), [...ruleKeys()].sort());
    assert.equal(Object.values(x.score_breakdown).reduce((a, b) => a + b, 0), x.score);
    assert.equal(typeof x.verification, "string");
    assert.ok(x.provenance && "source" in x.provenance && "session" in x.provenance);
  }
  const fix = r.selected.find((x) => x.id === "x");
  assert.equal(fix.score_breakdown.verifiedFix, 2);
  assert.deepEqual(fix.provenance, { source: "session-notes", session: "ses-42" });
  assert.equal(r.selected.find((x) => x.id === "rel").score_breakdown.relationship, 1);
});

// ---- 14. normalizeItem -----------------------------------------------------
test("16. normalizeItem is safe, bounded and redacts secrets", () => {
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem("string"), null);
  assert.equal(normalizeItem({}), null, "no id and no text -> null");
  const n = normalizeItem({
    id: "n1", text: "api_key=sk-abcdefghijklmnopqrstuvwxyz password=hunter2",
    status: "confirmed", project_id: PID, source_session: "ses-1",
  }, PID);
  assert.ok(n);
  assert.equal(n.id, "n1");
  assert.equal(n.verification, "verified");
  assert.equal(n.session, "ses-1");
  assert.equal(n.project_id, PID);
  assert.equal(n.project_explicit, true);
  assert.ok(!n.text.includes("sk-abcdefghijklmnopqrstuvwxyz"), "secret redacted");
  assert.ok(!n.text.includes("hunter2"), "password redacted");
});

// ---- 15. stats accounting --------------------------------------------------
test("17. stats accounting is consistent (input = kept + rejected)", () => {
  const r = run([
    item({ id: "keep", text: "unique one", verification: "verified" }),
    null,
    item({ id: "foreign", text: "foreign", project_id: OTHER }),
    item({ id: "keep", text: "unique one", verification: "verified" }),
    item({ type: "decision", id: "old", text: "old", verification: "superseded" }),
    item({ id: "bad", text: "bad", verification: "contradicted" }),
    item({ id: "weak", text: "weak", verification: "uncertain", freshness_at: null }),
    item({ id: "extra1", text: "extra one", verification: "verified" }),
    item({ id: "extra2", text: "extra two", verification: "verified" }),
  ], { limits: { minScore: 5, maxItems: 1 } });
  assert.equal(r.stats.input, 9);
  assert.equal(r.stats.kept, r.selected.length);
  assert.equal(r.stats.rejected, r.rejected.length);
  assert.equal(r.stats.deduped, 1);
  assert.equal(r.stats.input, r.stats.kept + r.stats.rejected);
});

test("close", async () => {
  if (CORE_CLOSE_AVAILABLE) await close();
});
