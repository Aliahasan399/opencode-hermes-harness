// Phase 21 workstream C — learning consolidation + learning-aware retrieval.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network,
// unique project ids per test, no destructive SQL assertions.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase21-learning-integration.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const mod = await import("../src/learningIntegration.js");

const uniq = () => `p21-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const {
  consolidateLearning,
  learningContextItems,
  explainLearning,
  learningReport,
} = mod;

// Idempotent schema guards: no-ops when the shipped migrations are already applied.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_record (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      session_id text,
      signature text NOT NULL,
      category text NOT NULL DEFAULT 'pattern',
      problem text NOT NULL DEFAULT '',
      approach text NOT NULL DEFAULT '',
      outcome text NOT NULL DEFAULT 'uncertain',
      verification text NOT NULL DEFAULT 'observed',
      confidence real NOT NULL DEFAULT 0,
      confidence_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
      reusability text NOT NULL DEFAULT 'project',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'active',
      superseded_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, signature)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pattern (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      pattern_key text NOT NULL,
      description text NOT NULL,
      occurrences integer NOT NULL DEFAULT 1,
      sessions text[] NOT NULL DEFAULT '{}',
      projects text[] NOT NULL DEFAULT '{}',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0.5,
      verified boolean NOT NULL DEFAULT false,
      first_observed timestamptz NOT NULL DEFAULT now(),
      last_observed timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
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
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS knowledge_relationship (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      source_type text NOT NULL,
      source_id text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      relation_type text NOT NULL,
      confidence real,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, source_type, source_id, target_type, target_id, relation_type)
    )`);
});

async function insertLearning(o) {
  const id = o.id || crypto.randomUUID();
  const created = o.created_at || new Date().toISOString();
  const updated = o.updated_at || created;
  await core.dbQuery(
    `INSERT INTO learning_record
       (id, project_id, session_id, signature, category, problem, approach, outcome,
        verification, confidence, evidence, status, superseded_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
     ON CONFLICT DO NOTHING`,
    [id, o.project_id, o.session_id ?? null, o.signature ?? `sig-${crypto.randomUUID()}`,
      o.category ?? "pattern", o.problem ?? "", o.approach ?? "", o.outcome ?? "",
      o.verification ?? "observed", o.confidence ?? 0, JSON.stringify(o.evidence ?? []),
      o.status ?? "active", o.superseded_by ?? null, created, updated],
  );
  return id;
}

async function rawLearning(id) {
  return (await core.dbQuery(
    "SELECT id, project_id, signature, evidence, status, superseded_by, verification, confidence FROM learning_record WHERE id=$1 LIMIT 1",
    [id],
  )).rows[0];
}

async function insertPattern(project, key, description, verified = true) {
  const id = crypto.randomUUID();
  await core.dbQuery(
    `INSERT INTO pattern (id, kind, pattern_key, description, projects, evidence, confidence, verified)
     VALUES ($1,'project_experience',$2,$3,ARRAY[$4]::text[],$5::jsonb,$6,$7)
     ON CONFLICT DO NOTHING`,
    [id, key, description, project, JSON.stringify([`evidence-${key}`]), verified ? 0.9 : 0.5, verified],
  );
  return id;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---------------------------------------------------------------------------
// 0. exact exports
// ---------------------------------------------------------------------------
test("0. exact exports exist as functions", async () => {
  for (const name of ["consolidateLearning", "learningContextItems", "explainLearning", "learningReport"]) {
    assert.equal(typeof mod[name], "function", `${name} must be exported as a function`);
  }
  assert.equal(typeof mod.default.consolidateLearning, "function");
});

// ---------------------------------------------------------------------------
// 1. duplicate consolidation preserving evidence + provenance
// ---------------------------------------------------------------------------
test("1. consolidation merges evidence, marks superseded, preserves both rows and verification", async () => {
  const project = `p21-merge-${uniq()}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const sigA = `sig ${tag} alpha`;
  const sigB = `SIG-${tag}-ALPHA`;
  const older = daysAgo(5);
  const newer = daysAgo(4);
  const a = await insertLearning({ project_id: project, signature: sigA, created_at: older,
    verification: "observed", confidence: 0.4,
    problem: "cache ttl regression", approach: "bump ttl", outcome: "resolved",
    evidence: ["ev-A", "shared"] });
  const b = await insertLearning({ project_id: project, signature: sigB, created_at: newer,
    verification: "verified", confidence: 0.9,
    problem: "cache ttl regression", approach: "bump ttl", outcome: "resolved",
    evidence: ["ev-B", "shared"] });

  const r = await consolidateLearning({ project_id: project, dry_run: false });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.examined, 2);
  assert.equal(r.merged, 1);
  assert.equal(r.contradictions.length, 0);

  const rowA = await rawLearning(a);
  const rowB = await rawLearning(b);
  assert.ok(rowA && rowB, "neither row deleted");
  assert.equal(rowB.status, "superseded");
  assert.equal(rowB.superseded_by, a, "duplicate points at canonical");
  assert.equal(rowA.status, "active");
  assert.equal(rowA.project_id, project);
  assert.ok(rowA.evidence.includes("ev-A"));
  assert.ok(rowA.evidence.includes("ev-B"), "second evidence set merged into canonical");
  assert.equal(rowA.evidence.filter((e) => e === "shared").length, 1, "identical evidence deduped");
  assert.ok(rowA.evidence.some((e) => e && e.event === "learning.consolidated" && e.role === "canonical"));
  assert.ok(rowB.evidence.some((e) => e && e.event === "learning.consolidated" && e.role === "source"));
  assert.equal(rowA.verification, "observed", "verification preserved (not silently promoted)");
  assert.equal(Number(rowA.confidence), 0.4, "confidence preserved");

  const count = (await core.dbQuery(
    "SELECT count(*)::int AS n FROM learning_record WHERE project_id=$1", [project],
  )).rows[0].n;
  assert.equal(count, 2, "no deletion: both rows still present");
});

// ---------------------------------------------------------------------------
// 2. idempotency
// ---------------------------------------------------------------------------
test("2. second consolidation run merges nothing", async () => {
  const project = `p21-idem-${uniq()}`;
  const tag = crypto.randomUUID().slice(0, 8);
  await insertLearning({ project_id: project, signature: `sig ${tag} b`, created_at: daysAgo(3), evidence: ["b-1"] });
  await insertLearning({ project_id: project, signature: `SIG-${tag}-B`, created_at: daysAgo(2), evidence: ["b-2"] });

  const first = await consolidateLearning({ project_id: project, dry_run: false });
  assert.equal(first.merged, 1);
  const second = await consolidateLearning({ project_id: project, dry_run: false });
  assert.equal(second.ok, true);
  assert.equal(second.merged, 0, "idempotent");
});

// ---------------------------------------------------------------------------
// 3. contradiction preservation + relationship records
// ---------------------------------------------------------------------------
test("3. contradictions are preserved, not resolved, and relationships are written", async () => {
  const project = `p21-contra-${uniq()}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const a = await insertLearning({ project_id: project, signature: `sig ${tag} c`, created_at: daysAgo(6),
    outcome: "retry with exponential backoff works", evidence: ["ev-C", "status: current"] });
  const b = await insertLearning({ project_id: project, signature: `SIG-${tag}-C`, created_at: daysAgo(5),
    outcome: "do not retry; fail fast instead", evidence: ["ev-D", "contradicts: retry guidance"] });

  const r = await consolidateLearning({ project_id: project, dry_run: false });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.merged, 1);
  assert.ok(r.contradictions.length >= 1, "conflict surfaced");
  assert.ok(r.contradictions.some((c) => /outcomes differ|negation|contradict/i.test(c.reason)));

  const rowA = await rawLearning(a);
  const rowB = await rawLearning(b);
  assert.ok(rowA.evidence.includes("ev-D"), "both evidence sets kept on canonical");
  assert.ok(rowA.evidence.some((e) => e && e.event === "learning.contradiction"));
  assert.equal(rowB.status, "superseded", "conflicting row still superseded, not deleted");

  const rel = (await core.dbQuery(
    `SELECT relation_type FROM knowledge_relationship
      WHERE project_id=$1 AND source_type='learning_record' AND target_type='learning_record'`,
    [project],
  )).rows.map((x) => x.relation_type);
  assert.ok(rel.includes("derived_from"), "derived_from relationship recorded");
  assert.ok(rel.includes("contradicts"), "contradicts relationship recorded");
});

// ---------------------------------------------------------------------------
// 4. no cross-project merge
// ---------------------------------------------------------------------------
test("4. identical normalized signatures in different projects are never merged", async () => {
  const pA = `p21-isoA-${uniq()}`;
  const pB = `p21-isoB-${uniq()}`;
  const sig = "shared signature for isolation";
  const a = await insertLearning({ project_id: pA, signature: sig, created_at: daysAgo(2), evidence: ["a-1"] });
  const b = await insertLearning({ project_id: pB, signature: `  SHARED   SIGNATURE  FOR   ISOLATION `, created_at: daysAgo(1), evidence: ["b-1"] });

  const ra = await consolidateLearning({ project_id: pA, dry_run: false });
  const rb = await consolidateLearning({ project_id: pB, dry_run: false });
  assert.equal(ra.merged, 0);
  assert.equal(rb.merged, 0);
  assert.equal((await rawLearning(a)).status, "active");
  assert.equal((await rawLearning(b)).status, "active");
});

// ---------------------------------------------------------------------------
// 5. dry-run default makes no writes
// ---------------------------------------------------------------------------
test("5. dry-run is the default and performs no writes", async () => {
  const project = `p21-dry-${uniq()}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const a = await insertLearning({ project_id: project, signature: `sig ${tag} d`, evidence: ["dry-A"] });
  const b = await insertLearning({ project_id: project, signature: `SIG-${tag}-D`, evidence: ["dry-B"] });
  const beforeA = await rawLearning(a);
  const beforeB = await rawLearning(b);

  const r = await consolidateLearning({ project_id: project });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.merged, 0, "no merges in dry-run");
  assert.ok(r.proposals.length >= 1, "candidate pairs proposed");
  assert.ok(r.examined >= 2);

  const afterA = await rawLearning(a);
  const afterB = await rawLearning(b);
  assert.deepEqual(afterA.evidence, beforeA.evidence, "canonical evidence untouched");
  assert.deepEqual(afterB.evidence, beforeB.evidence, "duplicate evidence untouched");
  assert.equal(afterB.status, "active");
  assert.equal(afterB.superseded_by, null);
});

// ---------------------------------------------------------------------------
// 6. context items: project scope, bound, labels, query filter
// ---------------------------------------------------------------------------
test("6. learningContextItems is scoped, bounded, query-filtered and labelled", async () => {
  const project = `p21-ctx-${uniq()}`;
  const q = "redis cache ttl tuning";
  await insertLearning({ project_id: project, signature: `v-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning regression", approach: "set ttl", outcome: "resolved",
    verification: "verified", confidence: 0.9, evidence: ["v-ev"] });
  await insertLearning({ project_id: project, signature: `u-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning uncertain", verification: "uncertain", confidence: 0.3 });
  const contradicted = await insertLearning({ project_id: project, signature: `x-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning contradicted", verification: "contradicted" });
  const stale = await insertLearning({ project_id: project, signature: `s-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning stale", verification: "stale", updated_at: daysAgo(120) });
  const superseded = await insertLearning({ project_id: project, signature: `sup-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning superseded", status: "superseded" });
  const archived = await insertLearning({ project_id: project, signature: `arc-${crypto.randomUUID()}`,
    problem: "redis cache ttl tuning archived", status: "archived" });
  const unrelated = await insertLearning({ project_id: project, signature: `unrel-${crypto.randomUUID()}`,
    problem: "postgres vacuum policy", verification: "verified" });
  const patternId = await insertPattern(project, `pat-${crypto.randomUUID()}`, "redis cache ttl tuning pattern", true);

  const r = await learningContextItems({ project_id: project, query: q, limit: 8 });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  const ids = r.items.map((x) => x.id);
  assert.ok(ids.length <= 8);
  assert.equal(ids.includes(superseded), false, "superseded excluded");
  assert.equal(ids.includes(archived), false, "archived excluded");
  assert.equal(ids.includes(unrelated), false, "query filter excludes non-overlapping item");
  for (const item of r.items) {
    assert.equal(item.project_id, project);
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.text, "string");
    assert.equal(typeof item.score, "number");
    assert.equal(typeof item.reason, "string");
    assert.ok(["learning", "pattern"].includes(item.type));
    assert.ok(item.verification);
    assert.ok(Object.prototype.hasOwnProperty.call(item, "confidence"));
    assert.ok(Object.prototype.hasOwnProperty.call(item, "freshness_at"));
    assert.ok(Object.prototype.hasOwnProperty.call(item, "source"));
  }
  assert.ok(r.items.some((x) => x.type === "pattern" && x.id === patternId), "pattern included");
  assert.ok(r.items.some((x) => x.id === contradicted && /contradicted/.test(x.reason)), "contradicted labelled");
  assert.ok(r.items.some((x) => x.id === stale && /stale/.test(x.reason)), "stale labelled");
  assert.ok(r.items.some((x) => /uncertain/.test(x.reason)), "uncertain labelled");
  assert.ok(r.items.some((x) => /verified/.test(x.reason)), "verified labelled");

  const bounded = await learningContextItems({ project_id: project, query: q, limit: 2 });
  assert.ok(bounded.items.length <= 2, "limit honored");

  const other = await learningContextItems({ project_id: `p21-ctx-other-${uniq()}`, query: q });
  assert.equal(other.items.length, 0, "no cross-project rows");
});

// ---------------------------------------------------------------------------
// 7. explanation identifies evidence
// ---------------------------------------------------------------------------
test("7. explainLearning is project-scoped, identifies evidence and stays bounded", async () => {
  const project = `p21-explain-${uniq()}`;
  const ev1 = `alpha-evidence-${crypto.randomUUID().slice(0, 8)}`;
  const ev2 = `beta-evidence-${crypto.randomUUID().slice(0, 8)}`;
  const id = await insertLearning({ project_id: project, signature: `e-${crypto.randomUUID()}`,
    category: "debugging", problem: "exp registry mismatch", approach: "align versions",
    outcome: "resolved", verification: "observed", confidence: 0.6, evidence: [ev1] });
  await core.dbQuery(
    `INSERT INTO knowledge_quality (project_id, subject_type, subject_id, verification, confidence, evidence_sources, freshness_at)
     VALUES ($1,'learning_record',$2,'verified',0.8,$3::jsonb,now())
     ON CONFLICT (project_id, subject_type, subject_id) DO UPDATE SET
       verification=EXCLUDED.verification, confidence=EXCLUDED.confidence,
       evidence_sources=EXCLUDED.evidence_sources, freshness_at=EXCLUDED.freshness_at`,
    [project, id, JSON.stringify([ev2])],
  );

  const r = await explainLearning({ project_id: project, learning_id: id });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.ok(r.supports.includes(ev1), "learning evidence identified");
  assert.ok(r.supports.includes(ev2), "quality evidence identified");
  assert.equal(r.verification, "verified", "explicit quality overrides stored verification");
  assert.equal(r.confidence, 0.8);
  assert.equal(r.scope.project_id, project);
  assert.equal(r.scope.learning_id, id);
  assert.ok(Array.isArray(r.contradictions));
  assert.ok(r.breakdown && typeof r.breakdown === "object");
  assert.ok(r.explanation.length > 0 && r.explanation.length <= 1200);
  assert.ok(r.updated_at);
  assert.ok(r.explanation.includes(ev1.slice(0, 8)), "explanation identifies evidence");

  const cross = await explainLearning({ project_id: `p21-explain-other-${uniq()}`, learning_id: id });
  assert.equal(cross.ok, false, "not visible from another project");
});

// ---------------------------------------------------------------------------
// 8. report
// ---------------------------------------------------------------------------
test("8. learningReport aggregates project-scoped totals", async () => {
  const project = `p21-report-${uniq()}`;
  await insertLearning({ project_id: project, signature: `r1-${crypto.randomUUID()}`,
    category: "debugging", verification: "verified", status: "active" });
  await insertLearning({ project_id: project, signature: `r2-${crypto.randomUUID()}`,
    category: "pattern", verification: "observed", status: "active" });
  await insertLearning({ project_id: project, signature: `r3-${crypto.randomUUID()}`,
    category: "debugging", verification: "inferred", status: "stale" });
  await insertPattern(project, `pat-${crypto.randomUUID()}`, "report pattern", true);

  const r = await learningReport({ project_id: project });
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.equal(r.by_category.debugging, 2);
  assert.equal(r.by_category.pattern, 1);
  assert.equal(r.by_status.active, 2);
  assert.equal(r.by_status.stale, 1);
  assert.equal(r.verified_count, 1);
  assert.ok(r.pattern_count >= 1);
  assert.equal(typeof r.note, "string");

  const other = await learningReport({ project_id: `p21-report-other-${uniq()}` });
  assert.equal(other.total, 0, "report is project-scoped");
});

// ---------------------------------------------------------------------------
// 9. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("9. invalid inputs fail closed without throwing", async () => {
  assert.equal((await consolidateLearning()).ok, false);
  assert.equal((await consolidateLearning({ project_id: "" })).ok, false);
  assert.equal((await consolidateLearning({ project_id: "_global" })).ok, false);
  assert.equal((await learningContextItems({ project_id: "_global" })).ok, false);
  assert.equal((await learningContextItems({ project_id: "p", limit: -1 })).ok, true);
  assert.equal((await explainLearning({ project_id: "p" })).ok, false);
  assert.equal((await explainLearning({ project_id: "p", learning_id: "not-a-uuid" })).ok, false);
  assert.equal((await learningReport({ project_id: "" })).ok, false);
  assert.equal((await learningReport()).ok, false);
});

// ---------------------------------------------------------------------------
// 10. redaction before persistence/return
// ---------------------------------------------------------------------------
test("10. credential-like content is redacted in context items and explanations", async () => {
  const project = `p21-secret-${uniq()}`;
  const secret = `sk-${"a".repeat(32)}`;
  const id = await insertLearning({ project_id: project, signature: `sec-${crypto.randomUUID()}`,
    problem: `api_key=${secret} redis cache ttl`, verification: "verified", evidence: [`token ${secret}`] });

  const items = await learningContextItems({ project_id: project, query: "redis cache ttl" });
  assert.equal(items.ok, true);
  const item = items.items.find((x) => x.id === id);
  assert.ok(item, "item still returned");
  assert.equal(item.text.includes(secret), false, "raw secret not emitted");
  assert.ok(JSON.stringify(items.items).includes("[REDACTED"), "redaction marker present");

  const ex = await explainLearning({ project_id: project, learning_id: id });
  assert.equal(ex.ok, true);
  assert.equal(JSON.stringify(ex).includes(secret), false, "explanation never leaks the secret");
});

// ---------------------------------------------------------------------------
// close pool (exactly once, at the end)
// ---------------------------------------------------------------------------
test("close pool", async () => { await core.close(); });
