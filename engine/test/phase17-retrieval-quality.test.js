// Phase 17 D+E — knowledge quality and context-aware retrieval.
// Run with: MEMORY_DB_NAME=opencode_memory_test node --test test/phase17-retrieval-quality.test.js
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import {
  VERIFICATION, VERIFIED, OBSERVED, INFERRED, UNCERTAIN, CONTRADICTED,
  STALE, SUPERSEDED, qualityRank, recordQuality, getQuality, detectConflict,
  freshnessReport,
} from "../src/knowledgeQuality.js";
import {
  retrieveTaskContext, retrieveContext, explainSelection,
} from "../src/contextRetrieval.js";

const uniq = () => `p17r${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 10)}`;
const loader = (exportsObj) => async () => exportsObj;
const failingLoader = (msg) => async () => { throw new Error(msg); };
const noopQuality = () => loader({
  getQuality: async () => ({ ok: true, default: true, quality: { verification: "observed" } }),
});

function defaultLoaders(overrides = {}) {
  return {
    contextIntel: loader({ getProjectContext: async () => ({ items: [] }) }),
    decisionIntel: loader({ listDecisions: async () => ({ decisions: [] }) }),
    relationshipIntel: loader({ getRelationships: async () => ({ relationships: [] }) }),
    knowledgeQuality: noopQuality(),
    ...overrides,
  };
}

const fakeAdaptive = (results) => async () => ({ ok: true, results, retrieval_event_id: "fake" });

// Migration 015 supplies knowledge_quality in prod/test. This idempotent bootstrap
// only materializes it when the local test database has not yet had that portion
// applied; it is a NO-OP (IF NOT EXISTS) in a correctly migrated environment and
// the production modules never issue DDL.
test("0. ensure Phase 17 quality table is present (idempotent)", async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS knowledge_quality (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      verification text NOT NULL DEFAULT 'observed',
      confidence real,
      evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      freshness_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, subject_type, subject_id)
    )`);
  await core.dbQuery(
    "CREATE INDEX IF NOT EXISTS kq_project_idx ON knowledge_quality (project_id, verification)",
  );
});

// ---------------------------------------------------------------- knowledge quality

test("1. verification constants and qualityRank ordering are explicit", () => {
  assert.equal(VERIFIED, "verified");
  assert.equal(OBSERVED, "observed");
  assert.equal(INFERRED, "inferred");
  assert.equal(UNCERTAIN, "uncertain");
  assert.equal(CONTRADICTED, "contradicted");
  assert.equal(STALE, "stale");
  assert.equal(SUPERSEDED, "superseded");
  const order = [VERIFIED, OBSERVED, INFERRED, UNCERTAIN, STALE, CONTRADICTED, SUPERSEDED];
  for (let i = 1; i < order.length; i++) {
    assert.ok(qualityRank(order[i - 1]) > qualityRank(order[i]), `${order[i - 1]} > ${order[i]}`);
  }
  assert.equal(qualityRank(undefined), qualityRank(OBSERVED));
  assert.ok(qualityRank(VERIFICATION.VERIFIED) > 0);
});

test("2. recordQuality/getQuality store verification and confidence separately", async () => {
  const p = uniq();
  const s = `fact-${uniq()}`;
  const r = await recordQuality({
    project_id: p, subject_type: "memory", subject_id: s,
    verification: VERIFIED, confidence: 0.93, evidence_sources: ["test-suite:unit"],
    freshness_at: new Date().toISOString(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.quality.verification, VERIFIED);
  assert.equal(r.quality.confidence, 0.93);
  const g = await getQuality({ project_id: p, subject_type: "memory", subject_id: s });
  assert.equal(g.quality.verification, VERIFIED);
  assert.equal(g.quality.confidence, 0.93);
  assert.equal(g.default, false);

  const missing = await getQuality({ project_id: p, subject_type: "memory", subject_id: "never" });
  assert.equal(missing.quality.verification, OBSERVED);
  assert.equal(missing.default, true);
});

test("3. confidence never auto-promotes INFERRED/UNCERTAIN to VERIFIED", async () => {
  const p = uniq();
  const s = `claim-${uniq()}`;
  const first = await recordQuality({
    project_id: p, subject_type: "claim", subject_id: s,
    verification: INFERRED, confidence: 0.55, evidence_sources: ["reasoning:a"],
  });
  assert.equal(first.quality.verification, INFERRED);
  const second = await recordQuality({
    project_id: p, subject_type: "claim", subject_id: s,
    verification: VERIFIED, confidence: 0.999,
  });
  assert.equal(second.promoted, false);
  assert.equal(second.quality.verification, INFERRED, "must not become VERIFIED");
  // confidence is still recorded independently
  assert.equal(second.quality.confidence, 0.999);

  const u = `u-${uniq()}`;
  await recordQuality({ project_id: p, subject_type: "claim", subject_id: u, verification: UNCERTAIN });
  const up = await recordQuality({ project_id: p, subject_type: "claim", subject_id: u, verification: VERIFIED });
  assert.equal(up.quality.verification, UNCERTAIN);
  // OBSERVED -> VERIFIED is a legitimate explicit promotion
  const o = `o-${uniq()}`;
  await recordQuality({ project_id: p, subject_type: "claim", subject_id: o, verification: OBSERVED });
  const op = await recordQuality({ project_id: p, subject_type: "claim", subject_id: o, verification: VERIFIED });
  assert.equal(op.promoted, true);
  assert.equal(op.quality.verification, VERIFIED);
});

test("4. evidence history is deduplicated and append-only", async () => {
  const p = uniq();
  const s = `hist-${uniq()}`;
  await recordQuality({
    project_id: p, subject_type: "memory", subject_id: s,
    verification: OBSERVED, evidence_sources: ["src:a", "src:b", "src:a"],
  });
  const second = await recordQuality({
    project_id: p, subject_type: "memory", subject_id: s,
    verification: OBSERVED, evidence_sources: ["src:b", "src:c", "src:c"],
  });
  assert.deepEqual(second.quality.evidence_sources, ["src:a", "src:b", "src:c"]);
  assert.equal(second.changed, true);
  const third = await recordQuality({
    project_id: p, subject_type: "memory", subject_id: s,
    evidence_sources: ["src:a", "src:b", "src:c"],
  });
  assert.equal(third.changed, false, "re-recording identical evidence is not a change");
  const g = await getQuality({ project_id: p, subject_type: "memory", subject_id: s });
  assert.equal(g.quality.evidence_sources.length, 3);
});

test("5. detectConflict flags only explicit negation and preserves history", async () => {
  const p = uniq();
  const s = `conflict-${uniq()}`;
  await recordQuality({
    project_id: p, subject_type: "claim", subject_id: s,
    verification: VERIFIED, confidence: 0.9, evidence_sources: ["test:original"],
  });

  const overlap = await detectConflict({
    project_id: p, subject_type: "claim", subject_id: s,
    new_evidence: ["deployment procedure is slow"], new_claim: "deployment procedure",
  });
  assert.equal(overlap.conflict, false, "keyword overlap is not a contradiction");

  const explicit = await detectConflict({
    project_id: p, subject_type: "claim", subject_id: s,
    new_evidence: ["contradicts: the deployment procedure is deprecated"],
    new_claim: "deployment procedure is current",
  });
  assert.equal(explicit.conflict, true);
  assert.equal(explicit.verification, CONTRADICTED);
  assert.ok(explicit.reason.includes("explicitly negates"));
  const after = await getQuality({ project_id: p, subject_type: "claim", subject_id: s });
  assert.equal(after.quality.verification, CONTRADICTED);
  assert.ok(after.quality.evidence_sources.includes("test:original"), "history preserved");
  assert.ok(after.quality.evidence_sources.some((e) => e.startsWith("contradicts:")));

  const s2 = `stale-${uniq()}`;
  await recordQuality({ project_id: p, subject_type: "claim", subject_id: s2, verification: OBSERVED });
  const stale = await detectConflict({
    project_id: p, subject_type: "claim", subject_id: s2,
    new_evidence: [{ marker: "status:stale", detail: "superseded by newer run" }],
  });
  assert.equal(stale.conflict, true, "object evidence with status:stale counts");
});

test("6. freshnessReport is bounded, project-scoped and uses freshness_at", async () => {
  const p = uniq();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const fresh = new Date().toISOString();
  await core.dbQuery(
    `INSERT INTO knowledge_quality (project_id,subject_type,subject_id,verification,freshness_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz)`,
    [p, "memory", `old-${uniq()}`, OBSERVED, old],
  );
  await core.dbQuery(
    `INSERT INTO knowledge_quality (project_id,subject_type,subject_id,verification,freshness_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz)`,
    [p, "memory", `fresh-${uniq()}`, OBSERVED, fresh],
  );
  await core.dbQuery(
    `INSERT INTO knowledge_quality (project_id,subject_type,subject_id,verification,freshness_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz)`,
    [uniq(), "memory", `other-${uniq()}`, OBSERVED, old],
  );
  const report = await freshnessReport({ project_id: p, older_than_days: 30, limit: 50 });
  assert.equal(report.ok, true);
  assert.ok(report.items.length >= 1);
  assert.ok(report.items.every((x) => x.project_id === p));
  assert.ok(report.items.every((x) => new Date(x.freshness_at) < new Date(Date.now() - 30 * 86400000)));
  assert.ok(!report.items.some((x) => x.subject_id.startsWith("fresh-")));
  assert.equal(report.count, report.items.length);
  const bounded = await freshnessReport({ project_id: p, older_than_days: 30, limit: 1 });
  assert.ok(bounded.items.length <= 1);
});

// ----------------------------------------------------------- context-aware retrieval

test("7. retrieveTaskContext keeps the core path with every optional module absent", async () => {
  const p = uniq();
  const results = [{
    id: "11111111-1111-4111-8111-111111111111",
    type: "memory", title: "Hybrid hit", content: "verified deployment procedure",
    verified: true, score: 0.2, adaptive_score: 0.2, project_id: p,
    retrieval_reason: "project:+0.080 verified:+0.100",
  }];
  const r = await retrieveTaskContext({
    project_id: p, query: "deployment", session_id: "ses-1", limit: 8,
    deps: {
      adaptiveRetrieve: fakeAdaptive(results),
      loaders: {
        contextIntel: failingLoader("module not found"),
        decisionIntel: failingLoader("module not found"),
        relationshipIntel: failingLoader("module not found"),
        knowledgeQuality: failingLoader("module not found"),
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, "memory");
  assert.equal(r.items[0].verification, "verified");
  assert.ok(r.items[0].reason.includes("project:"));
  assert.equal(r.degraded.length, 4);
  assert.ok(r.degraded.some((d) => d.includes("contextIntel")));
  assert.ok(r.explanation.startsWith("Selected"));
  assert.ok(r.explanation.includes("Degraded capabilities"));
  assert.equal(r.budget_used, r.context.length);
  assert.equal(typeof retrieveContext, "function");
});

test("8. project-, decision- and relationship-aware retrieval deduplicates items", async () => {
  const p = uniq();
  const memoryId = "22222222-2222-4222-8222-222222222222";
  const r = await retrieveTaskContext({
    project_id: p, query: "deploy", limit: 12,
    deps: {
      adaptiveRetrieve: fakeAdaptive([
        { id: memoryId, title: "Deploy memory", content: "deployment notes", score: 0.3 },
      ]),
      loaders: defaultLoaders({
        contextIntel: loader({
          getProjectContext: async () => ({
            items: [
              { id: "fact-1", fact_key: "runtime", value: "node 20", status: "active", project_id: p },
              { id: "fact-1", fact_key: "runtime", value: "node 20", project_id: p },
            ],
          }),
        }),
        decisionIntel: loader({
          listDecisions: async () => ({
            decisions: [{ id: "dec-1", title: "Use Postgres", status: "confirmed", project_id: p, confidence: 0.9 }],
          }),
        }),
        relationshipIntel: loader({
          getRelationships: async () => ({
            relationships: [{ id: "rel-1", title: "supports", description: "dec supports fact", project_id: p }],
          }),
        }),
      }),
    },
  });
  assert.equal(r.ok, true);
  const types = r.items.map((x) => x.type);
  assert.ok(types.includes("memory"));
  assert.ok(types.includes("project_context"));
  assert.ok(types.includes("decision"));
  assert.ok(types.includes("relationship"));
  const keys = r.items.map((x) => `${x.type}:${x.id}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate (type,id)");
  assert.ok(r.items.every((x) => x.reason && typeof x.reason === "string"));
  assert.equal(r.degraded.length, 0);
  const dec = r.items.find((x) => x.type === "decision");
  assert.equal(dec.verification, "verified", "confirmed decision maps to verified");
});

test("9. verified+fresh is preferred; contradicted/stale are downweighted", async () => {
  const p = uniq();
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 300 * 86400000).toISOString();
  const id = (n) => `${n.padStart(8, "0")}-2222-4222-8222-222222222222`;
  const r = await retrieveTaskContext({
    project_id: p, limit: 8,
    deps: {
      adaptiveRetrieve: fakeAdaptive([
        { id: id("3"), title: "Contradicted", content: "bad", score: 0.9, verified: false,
          status: "contradicted", freshness_at: fresh, project_id: p },
        { id: id("2"), title: "Stale", content: "old", score: 0.8, status: "stale",
          freshness_at: old, project_id: p },
        { id: id("1"), title: "Verified fresh", content: "good", score: 0.1,
          verified: true, freshness_at: fresh, project_id: p },
      ]),
      loaders: defaultLoaders(),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].title, "Verified fresh");
  assert.ok(r.items[0].final_score > r.items[r.items.length - 1].final_score);
});

test("10. cross-project rows never enter the result", async () => {
  const p = uniq();
  const other = uniq();
  const r = await retrieveTaskContext({
    project_id: p, limit: 12,
    deps: {
      adaptiveRetrieve: fakeAdaptive([
        { id: "aaaaaaaa-3333-4333-8333-333333333333", title: "Own", content: "mine", project_id: p },
        { id: "bbbbbbbb-3333-4333-8333-333333333333", title: "Foreign", content: "theirs", project_id: other },
      ]),
      loaders: defaultLoaders({
        decisionIntel: loader({
          listDecisions: async () => ({
            decisions: [
              { id: "own-dec", title: "Own decision", status: "active", project_id: p },
              { id: "foreign-dec", title: "Foreign decision", status: "active", project_id: other },
            ],
          }),
        }),
      }),
    },
  });
  assert.ok(r.items.some((x) => x.title === "Own"));
  assert.ok(!r.items.some((x) => x.title === "Foreign"));
  assert.ok(!r.items.some((x) => x.title === "Foreign decision"));
  assert.ok(r.items.some((x) => x.title === "Own decision"));
});

test("11. budget_chars caps context and reports usage", async () => {
  const p = uniq();
  const results = Array.from({ length: 20 }, (_, i) => ({
    id: `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444`,
    title: `Item ${i}`, content: "a fairly long piece of content used to fill the budget quickly",
    score: 0.1, project_id: p,
  }));
  const r = await retrieveTaskContext({
    project_id: p, limit: 20, budget_chars: 240,
    deps: { adaptiveRetrieve: fakeAdaptive(results), loaders: defaultLoaders() },
  });
  assert.equal(r.ok, true);
  assert.ok(r.context.length <= 240, `context length ${r.context.length}`);
  assert.equal(r.budget_used, r.context.length);
  assert.ok(r.items.length < results.length, "truncation occurred");
  assert.ok(r.context.includes("truncated"));
});

test("12. explainSelection produces a short, redacted explanation", async () => {
  const p = uniq();
  const s = explainSelection({
    item: {
      type: "memory", id: "abc", verification: "verified", final_score: 0.42,
      freshness_at: new Date().toISOString(), reason: "project:+0.08 verified:+0.10 api_key=sk-abcdefghijklmnopqrstuvwxyz",
    },
    project_id: p,
  });
  assert.equal(typeof s, "string");
  assert.ok(s.length < 400);
  assert.ok(s.includes("verification verified"));
  assert.ok(!s.includes("sk-abcdefghijklmnopqrstuvwxyz"), "secrets are redacted");
  assert.ok(s.includes(p));
});

test("13. one unavailable capability degrades gracefully without losing others", async () => {
  const p = uniq();
  const r = await retrieveTaskContext({
    project_id: p, limit: 8,
    deps: {
      adaptiveRetrieve: fakeAdaptive([
        { id: "cccccccc-5555-4555-8555-555555555555", title: "Core result", content: "still here", project_id: p },
      ]),
      loaders: defaultLoaders({
        decisionIntel: failingLoader("decision module missing"),
        relationshipIntel: loader({
          getRelationships: async () => ({ relationships: [{ id: "rel-x", title: "linked", project_id: p }] }),
        }),
      }),
    },
  });
  assert.equal(r.ok, true);
  assert.ok(r.items.some((x) => x.title === "Core result"));
  assert.ok(r.items.some((x) => x.title === "linked"));
  assert.ok(!r.items.some((x) => x.type === "decision"));
  assert.equal(r.degraded.length, 1);
  assert.ok(r.degraded[0].includes("decisionIntel"));
});

test("14. real hybrid retrieval still feeds the context block", async () => {
  const p = uniq();
  const m = await core.saveMemory({
    layer: "knowledge", project_id: p, title: `Deployment procedure ${uniq()}`,
    content: "the deployment procedure requires a migration step before release",
    noEmbed: true, provenance: "test_fixture",
  });
  const r = await retrieveTaskContext({ project_id: p, query: "deployment procedure", limit: 8 });
  assert.equal(r.ok, true);
  assert.ok(r.items.some((x) => x.type === "memory" && x.id === m.id), "hybrid hit present");
  const hit = r.items.find((x) => x.id === m.id);
  assert.ok(hit.reason && hit.reason.length > 0);
  assert.ok(r.context.includes("Deployment procedure"));
});

test("close", async () => { await core.close(); });
