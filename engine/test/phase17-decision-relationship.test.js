// Phase 17 capabilities B + C: Technical Decision Intelligence and Relationship Intelligence.
// Additive-only; unique ids per test; no deletion, no LLM calls, no cross-project reads.
// Standalone: $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase17-decision-relationship.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const decisionIntel = await import("../src/decisionIntel.js");
const relationshipIntel = await import("../src/relationshipIntel.js");

const uniq = () => `p17-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// The migration is additive (CREATE TABLE IF NOT EXISTS). This idempotent setup is a
// no-op once migration 015 has been applied, and keeps this standalone test runnable
// even against a database where the parent migration has not landed yet.
before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS technical_decision (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      reasoning text NOT NULL DEFAULT '',
      alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
      consequences jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'active',
      confidence real,
      superseded_by text,
      source_session text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, title)
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
  await core.dbQuery("CREATE INDEX IF NOT EXISTS td_project_idx ON technical_decision (project_id, created_at DESC)");
  await core.dbQuery("CREATE INDEX IF NOT EXISTS kr_source_idx ON knowledge_relationship (project_id, source_type, source_id)");
  await core.dbQuery("CREATE INDEX IF NOT EXISTS kr_target_idx ON knowledge_relationship (project_id, target_type, target_id)");
});

// ---------------- Relationship Intelligence ----------------

test("1. createRelationship stores an evidence-backed link with bounded confidence", async () => {
  const project = `rel-create-${uniq()}`;
  const source = `mem-${uniq()}`;
  const target = `mem-${uniq()}`;
  const evidence = [{ kind: "test", ref: uniq() }];
  const r = await relationshipIntel.createRelationship({
    project_id: project,
    source_type: "memory", source_id: source,
    target_type: "memory", target_id: target,
    relation_type: "supports", confidence: 5, evidence,
  });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.ok(r.id);
  const row = (await core.dbQuery(
    "SELECT * FROM knowledge_relationship WHERE id=$1", [r.id],
  )).rows[0];
  assert.equal(row.project_id, project);
  assert.equal(row.confidence, 1, "confidence must be clamped to [0,1]");
  assert.equal(row.evidence.length, 1);
});

test("2. duplicate relationship is a no-op, not an overwrite", async () => {
  const project = `rel-dup-${uniq()}`;
  const source = `mem-${uniq()}`;
  const target = `mem-${uniq()}`;
  const input = {
    project_id: project,
    source_type: "memory", source_id: source,
    target_type: "memory", target_id: target,
    relation_type: "relates_to", evidence: [{ kind: "test" }],
  };
  const first = await relationshipIntel.createRelationship(input);
  const second = await relationshipIntel.createRelationship(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, "same tuple must be reported as duplicate");
  assert.equal(String(second.id), String(first.id));
  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM knowledge_relationship WHERE project_id=$1", [project],
  )).rows[0].n;
  assert.equal(count, 1);
});

test("3. traversal works in source, target and both directions", async () => {
  const project = `rel-traverse-${uniq()}`;
  const hub = `hub-${uniq()}`;
  const a = `a-${uniq()}`;
  const b = `b-${uniq()}`;
  await relationshipIntel.createRelationship({
    project_id: project, source_type: "memory", source_id: hub,
    target_type: "memory", target_id: a, relation_type: "supports",
    confidence: 0.9, evidence: [{ kind: "test" }],
  });
  await relationshipIntel.createRelationship({
    project_id: project, source_type: "memory", source_id: b,
    target_type: "memory", target_id: hub, relation_type: "contradicts",
    confidence: 0.4, evidence: [{ kind: "test" }],
  });
  const out = await relationshipIntel.getRelationships({
    project_id: project, subject_type: "memory", subject_id: hub, direction: "source",
  });
  const inbound = await relationshipIntel.getRelationships({
    project_id: project, subject_type: "memory", subject_id: hub, direction: "target",
  });
  const both = await relationshipIntel.getRelationships({
    project_id: project, subject_type: "memory", subject_id: hub, direction: "both",
  });
  assert.equal(out.ok, true);
  assert.equal(out.relationships.length, 1);
  assert.equal(out.relationships[0].target_id, a);
  assert.equal(inbound.relationships.length, 1);
  assert.equal(inbound.relationships[0].source_id, b);
  assert.equal(both.relationships.length, 2);
});

test("4. traversal is bounded at 100 even when asked for more", async () => {
  const project = `rel-limit-${uniq()}`;
  const hub = `hub-${uniq()}`;
  const total = 105;
  for (let i = 0; i < total; i++) {
    await relationshipIntel.createRelationship({
      project_id: project, source_type: "memory", source_id: hub,
      target_type: "memory", target_id: `n-${i}-${uniq()}`,
      relation_type: "supports", evidence: [{ kind: "test", i }],
    });
  }
  const r = await relationshipIntel.getRelationships({
    project_id: project, subject_type: "memory", subject_id: hub, direction: "source", limit: 500,
  });
  assert.equal(r.ok, true);
  assert.equal(r.relationships.length, 100, "limit must be capped at 100");
  const exact = await relationshipIntel.getRelationships({
    project_id: project, subject_type: "memory", subject_id: hub, direction: "source", limit: 3,
  });
  assert.equal(exact.relationships.length, 3);
});

test("5. invalid relationships are rejected by the pure validator and the writer", async () => {
  const project = `rel-invalid-${uniq()}`;
  const id = uniq();
  const base = {
    project_id: project, source_type: "memory", source_id: id,
    target_type: "memory", target_id: `other-${id}`,
    relation_type: "supports", evidence: [{ kind: "test" }],
  };
  assert.equal(relationshipIntel.validateRelationship(base).ok, true);
  assert.match(relationshipIntel.validateRelationship({ ...base, source_id: "" }).reason, /source_id/);
  assert.match(relationshipIntel.validateRelationship({ ...base, relation_type: "" }).reason, /relation_type/);
  assert.match(relationshipIntel.validateRelationship({ ...base, evidence: [] }).reason, /evidence/);
  assert.match(relationshipIntel.validateRelationship({ ...base, target_id: id }).reason, /must differ/);

  const rejected = await relationshipIntel.createRelationship({ ...base, evidence: [] });
  assert.equal(rejected.ok, false, "empty evidence must be refused (no keyword-only links)");
  assert.equal(rejected.duplicate, false);
  const self = await relationshipIntel.createRelationship({ ...base, target_id: id });
  assert.equal(self.ok, false);
  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM knowledge_relationship WHERE project_id=$1", [project],
  )).rows[0].n;
  assert.equal(count, 0, "no invalid row may be written");
});

test("6. relationships are project-isolated", async () => {
  const a = `rel-iso-A-${uniq()}`;
  const b = `rel-iso-B-${uniq()}`;
  const hub = `hub-${uniq()}`;
  await relationshipIntel.createRelationship({
    project_id: a, source_type: "memory", source_id: hub,
    target_type: "memory", target_id: `x-${uniq()}`,
    relation_type: "supports", evidence: [{ kind: "test" }],
  });
  const inA = await relationshipIntel.getRelationships({
    project_id: a, subject_type: "memory", subject_id: hub,
  });
  const inB = await relationshipIntel.getRelationships({
    project_id: b, subject_type: "memory", subject_id: hub,
  });
  assert.equal(inA.relationships.length, 1);
  assert.equal(inB.relationships.length, 0, "another project must see nothing");
});

test("7. relatedContext groups the other side with relation_type and confidence", async () => {
  const project = `rel-context-${uniq()}`;
  const hub = `hub-${uniq()}`;
  const other = `other-${uniq()}`;
  await relationshipIntel.createRelationship({
    project_id: project, source_type: "memory", source_id: hub,
    target_type: "memory", target_id: other, relation_type: "supports",
    confidence: 0.7, evidence: [{ kind: "test" }],
  });
  await relationshipIntel.createRelationship({
    project_id: project, source_type: "memory", source_id: hub,
    target_type: "memory", target_id: other, relation_type: "elaborates",
    confidence: 0.9, evidence: [{ kind: "test" }],
  });
  const r = await relationshipIntel.relatedContext({
    project_id: project, subject_type: "memory", subject_id: hub,
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1, "both links must collapse to one related record");
  assert.equal(r.items[0].id, other);
  assert.equal(r.items[0].confidence, 0.9);
  assert.deepEqual(r.items[0].relation_types.sort(), ["elaborates", "supports"]);
});

// ---------------- Technical Decision Intelligence ----------------

test("8. recordDecision creates a scoped decision with clamped confidence and evidence", async () => {
  const project = `dec-create-${uniq()}`;
  const title = `Use ${uniq()} for caching`;
  const evidence = [{ kind: "benchmark", ref: uniq() }];
  const r = await decisionIntel.recordDecision({
    project_id: project, title,
    description: "cache layer choice", reasoning: `needle-${uniq()}`,
    alternatives: ["redis", "memory"], consequences: ["ttl policy"],
    evidence, confidence: 3, source_session: `session-${uniq()}`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.ok(r.id);
  assert.deepEqual(r.superseded, []);
  const got = await decisionIntel.getDecisionById({ id: r.id, project_id: project });
  assert.equal(got.decision.title, title);
  assert.equal(got.decision.confidence, 1);
  assert.equal(got.decision.evidence.length, 1);
  assert.equal(got.decision.status, "active");
  assert.deepEqual(got.decision.alternatives, ["redis", "memory"]);
});

test("9. same-title active decision is a duplicate and history is preserved", async () => {
  const project = `dec-dup-${uniq()}`;
  const title = `Decision ${uniq()}`;
  const first = await decisionIntel.recordDecision({
    project_id: project, title, reasoning: "original reasoning",
    evidence: [{ kind: "test" }],
  });
  const second = await decisionIntel.recordDecision({
    project_id: project, title, reasoning: "overwrite attempt",
    evidence: [{ kind: "test" }],
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  const got = await decisionIntel.getDecisionById({ id: first.id, project_id: project });
  assert.equal(got.decision.reasoning, "original reasoning", "the active decision must not be overwritten");
  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM technical_decision WHERE project_id=$1 AND title=$2", [project, title],
  )).rows[0].n;
  assert.equal(count, 1);
});

test("10. supersedes replaces a decision while preserving the old row and evidence link", async () => {
  const project = `dec-sup-${uniq()}`;
  const title = `Replace ${uniq()}`;
  const old = await decisionIntel.recordDecision({
    project_id: project, title, reasoning: "old reasoning",
    evidence: [{ kind: "test" }],
  });
  const evidence = [{ kind: "test", ref: uniq() }];
  const next = await decisionIntel.recordDecision({
    project_id: project, title, reasoning: "new reasoning",
    evidence, supersedes: old.id,
  });
  assert.equal(next.ok, true);
  assert.deepEqual(next.superseded, [old.id]);

  const oldRow = await decisionIntel.getDecisionById({ id: old.id, project_id: project });
  assert.equal(oldRow.decision.status, "superseded", "history is kept, not deleted");
  assert.equal(oldRow.decision.superseded_by, next.id);
  assert.equal(oldRow.decision.reasoning, "old reasoning");
  assert.notEqual(oldRow.decision.title, title, "old title archived to free the unique key");

  const newRow = await decisionIntel.getDecisionById({ id: next.id, project_id: project });
  assert.equal(newRow.decision.status, "active");
  assert.equal(newRow.decision.title, title);
  assert.equal(newRow.decision.evidence.length, 1, "evidence link is stored on the replacement");

  const audit = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='decision.record' AND detail->>'id'=$1", [next.id],
  )).rows[0].n;
  assert.ok(audit >= 1, "supersession must be audited");
});

test("11. supersedeDecision updates in place, audits, and refuses empty evidence", async () => {
  const project = `dec-explicit-${uniq()}`;
  const first = await decisionIntel.recordDecision({
    project_id: project, title: `A ${uniq()}`, evidence: [{ kind: "test" }],
  });
  const replacement = await decisionIntel.recordDecision({
    project_id: project, title: `B ${uniq()}`, evidence: [{ kind: "test" }],
  });
  const bad = await decisionIntel.supersedeDecision({ id: first.id, by_id: replacement.id, evidence: [] });
  assert.equal(bad.ok, false, "empty evidence must be refused");

  const r = await decisionIntel.supersedeDecision({
    id: first.id, by_id: replacement.id, reason: "replaced by B",
    evidence: [{ kind: "test", ref: uniq() }], actor: "test-runner",
  });
  assert.equal(r.ok, true);
  assert.equal(r.superseded.id, first.id);
  assert.equal(r.superseded.by_id, replacement.id);
  const row = await decisionIntel.getDecisionById({ id: first.id, project_id: project });
  assert.equal(row.decision.status, "superseded");
  assert.equal(row.decision.superseded_by, replacement.id, "row exists and points at replacement (no delete)");
  const audit = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='decision.supersede' AND detail->>'id'=$1", [first.id],
  )).rows[0].n;
  assert.ok(audit >= 1);
});

test("12. getDecisions filters by query/status and stays bounded; decisionsForTask is retrieval-only", async () => {
  const project = `dec-query-${uniq()}`;
  const needle = `needle-${uniq()}`;
  await decisionIntel.recordDecision({
    project_id: project, title: `Searchable ${uniq()}`, reasoning: needle,
    evidence: [{ kind: "test" }],
  });
  await decisionIntel.recordDecision({
    project_id: project, title: `Other ${uniq()}`, reasoning: "unrelated reasoning",
    evidence: [{ kind: "test" }],
  });
  const hits = await decisionIntel.getDecisions({ project_id: project, query: needle });
  assert.equal(hits.ok, true);
  assert.equal(hits.decisions.length, 1);
  assert.match(hits.decisions[0].reasoning, new RegExp(needle));

  const active = await decisionIntel.getDecisions({ project_id: project, status: "active", limit: 1 });
  assert.equal(active.decisions.length, 1, "limit must be honored");
  const huge = await decisionIntel.getDecisions({ project_id: project, limit: 999 });
  assert.ok(huge.decisions.length <= 200, "limit must be capped");

  const task = await decisionIntel.decisionsForTask({ project_id: project, query: needle });
  assert.equal(task.ok, true);
  assert.equal(task.decisions.length, 1);
  assert.equal(task.decisions[0].status, "active");
});

test("13. decisions are project-isolated on read", async () => {
  const a = `dec-iso-A-${uniq()}`;
  const b = `dec-iso-B-${uniq()}`;
  const made = await decisionIntel.recordDecision({
    project_id: a, title: `Secret ${uniq()}`, evidence: [{ kind: "test" }],
  });
  const inB = await decisionIntel.getDecisionById({ id: made.id, project_id: b });
  assert.equal(inB.decision, null, "another project must not read this decision");
  const listB = await decisionIntel.getDecisions({ project_id: b });
  assert.ok(!listB.decisions.some((d) => d.id === made.id));
  const listA = await decisionIntel.getDecisions({ project_id: a });
  assert.ok(listA.decisions.some((d) => d.id === made.id));
});

test("close pool", async () => { await core.close(); });
