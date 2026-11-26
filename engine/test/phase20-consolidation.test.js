import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as rel from "../src/relationshipIntel.js";
import {
  findCandidates, proposeConsolidation, consolidateApproved,
  reviewContradictions, recordContradiction, findSimilarButUnrelated,
} from "../src/memoryConsolidation.js";

const uniq = () => `p20c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function save(overrides = {}) {
  return core.saveMemory({
    layer: "knowledge",
    category: "fact",
    noEmbed: true,
    provenance: "test_fixture",
    ...overrides,
  });
}

test("1. exact duplicates are detected as kind=duplicate", async () => {
  const p = `exact-${uniq()}`;
  const text = `Redis cache ttl is ten minutes for the ${uniq()} session store.`;
  const a = await save({ project_id: p, title: "Cache TTL fact", content: text });
  const b = await save({ project_id: p, title: "Cache TTL fact", content: text });
  const r = await findCandidates({ project_id: p });
  assert.equal(r.ok, true);
  const c = r.candidates.find((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(c, "expected a duplicate candidate for the identical pair");
  assert.equal(c.kind, "duplicate");
  assert.ok(c.confidence >= 0.82);
});

test("2. near duplicates are detected as kind=near_duplicate", async () => {
  const p = `near-${uniq()}`;
  const a = await save({
    project_id: p, title: "Cache TTL policy",
    content: "The redis cache ttl is set to ten minutes for session storage.",
  });
  const b = await save({
    project_id: p, title: "Cache expiry policy",
    content: "The redis cache ttl is set to ten minutes for session storage and token caching.",
  });
  const r = await findCandidates({ project_id: p });
  const c = r.candidates.find((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(c, "expected a candidate for the near-duplicate pair");
  assert.equal(c.kind, "near_duplicate");
});

test("3. similar-but-unrelated (different category) is flagged, never merged", async () => {
  const p = `unrel-${uniq()}`;
  const text = `Shared body of text about redis ${uniq()} cache handling for sessions.`;
  const a = await save({ project_id: p, title: "Fact note", content: text, category: "fact" });
  const b = await save({ project_id: p, title: "Decision note", content: text, category: "decision" });

  const cand = await findCandidates({ project_id: p });
  assert.equal(cand.candidates.some((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id)), false,
  "cross-category pair must not be a consolidation candidate");

  const flagged = await findSimilarButUnrelated({ project_id: p, text: a.id });
  assert.equal(flagged.ok, true);
  const item = flagged.items.find((x) => x.memory_ids.includes(b.id));
  assert.ok(item, "expected a review flag for the similar-but-unrelated memory");
  assert.equal(item.flag, "review_not_merge");
  assert.notEqual(item.category, a.category);
});

test("4. complementary memories are detected (same class, distinct content)", async () => {
  const p = `comp-${uniq()}`;
  const a = await save({
    project_id: p, title: "Redis cache configuration",
    content: "Redis cache uses a ten minute ttl and a max memory limit for the cache.",
  });
  const b = await save({
    project_id: p, title: "Redis cache monitoring",
    content: "Redis cache hit rate and memory usage are exported to the monitoring dashboard.",
  });
  const r = await findCandidates({ project_id: p });
  const c = r.candidates.find((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(c, "expected a complementary candidate");
  assert.equal(c.kind, "complementary");
});

test("5. contradictions are preserved with evidence and no winner chosen", async () => {
  const p = `con-${uniq()}`;
  const a = await save({
    project_id: p, title: "Always redis", layer: "project", category: "rule",
    content: `Always use redis for caching in ${p}.`,
  });
  const b = await save({
    project_id: p, title: "Never redis", layer: "project", category: "rule",
    content: `Never use redis for caching in ${p}; remove it.`,
  });
  const evidence = [{ source: "code-review", note: "two opposing rules observed" }];
  const r = await recordContradiction({
    project_id: p, memory_a: b.id, memory_b: a.id,
    description: "Opposing cache guidance", evidence, confidence: 0.77,
  });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.auto_resolved, false);

  const review = await reviewContradictions({ project_id: p });
  const item = review.items.find((x) => x.id === r.id);
  assert.ok(item);
  assert.equal(item.status, "open");
  assert.equal(item.resolution_note, null);
  assert.deepEqual(item.evidence, evidence);
  assert.ok(Array.isArray(item.evidence));

  // Both source records survive untouched.
  assert.notEqual(await core.getMemory(a.id), null);
  assert.notEqual(await core.getMemory(b.id), null);

  if (r.relationship_id) {
    const links = await rel.getRelationships({
      project_id: p, subject_type: "memory", subject_id: a.id, relation_type: "contradicts",
    });
    assert.ok(links.ok);
  }
});

test("6. cross-project isolation, including global eligibility", async () => {
  const pA = `xa-${uniq()}`, pB = `xb-${uniq()}`;
  const shared = `Identical cross-project token body ${uniq()} for the isolation check.`;
  const a = await save({ project_id: pA, title: "Same", content: shared });
  const a2 = await save({ project_id: pA, title: "Same too", content: shared });
  const b = await save({ project_id: pB, title: "Same", content: shared });
  const b2 = await save({ project_id: pB, title: "Same too", content: shared });

  const ra = await findCandidates({ project_id: pA });
  const rb = await findCandidates({ project_id: pB });
  const aIds = [a.id, a2.id];
  const bIds = [b.id, b2.id];
  for (const c of [...ra.candidates, ...rb.candidates]) {
    const hasA = c.memory_ids.some((id) => aIds.includes(id));
    const hasB = c.memory_ids.some((id) => bIds.includes(id));
    assert.ok(!(hasA && hasB), "never pair memories from different projects");
  }
  assert.equal(ra.candidates.some((c) => c.memory_ids.every((id) => aIds.includes(id))), true);
  assert.equal(rb.candidates.some((c) => c.memory_ids.every((id) => bIds.includes(id))), true);

  // _global rows: only globally-eligible rows may participate, and never with a real project.
  const gText = `Global only token body ${uniq()} for the eligibility check.`;
  const g1 = await save({ project_id: "_global", title: "Global eligible A", content: gText });
  const g2 = await save({ project_id: "_global", title: "Global eligible B", content: gText });
  const g3 = await save({ project_id: "_global", title: "Global ineligible", content: gText });
  await core.dbQuery("UPDATE memory SET global_eligible=true WHERE id = ANY($1::uuid[])", [[g1.id, g2.id]]);

  const rg = await findCandidates({ project_id: "_global" });
  const pair = rg.candidates.find((c) => c.memory_ids.includes(g1.id) && c.memory_ids.includes(g2.id));
  assert.ok(pair, "expected a candidate among the two globally-eligible rows");
  assert.equal(rg.candidates.some((c) => c.memory_ids.includes(g3.id)), false,
    "ineligible global row must not appear");

  const mixed = await findCandidates({ project_id: pA });
  assert.equal(mixed.candidates.some((c) => c.memory_ids.some((id) => [g1.id, g2.id, g3.id].includes(id))), false,
    "global rows must never leak into a project scan");
});

test("7. provenance preserved through propose/approve; sources never deleted", async () => {
  const p = `prov-${uniq()}`;
  const text = `Provenance tracking body ${uniq()} identical in both sources.`;
  const a = await save({ project_id: p, title: "Src A", content: text, provenance: "test_fixture" });
  const b = await save({ project_id: p, title: "Src B", content: text, provenance: "test_fixture" });
  const cand = (await findCandidates({ project_id: p })).candidates.find((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(cand);

  const proposal = await proposeConsolidation({ candidate: cand, project_id: p, actor: "unit-test", evidence: [{ k: "v" }] });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.duplicate, false);

  const sug = (await core.dbQuery("SELECT * FROM consolidation_suggestion WHERE id=$1", [proposal.suggestion_id])).rows[0];
  assert.equal(sug.status, "pending");
  assert.equal(sug.triage_status, "ready_for_review");
  assert.equal(sug.triage_reason, cand.kind, "exact candidate kind preserved");
  assert.match(sug.description, new RegExp(`Candidate kind: ${cand.kind}`));
  assert.match(sug.description, /test_fixture/);
  assert.match(sug.description, /evidence/i);
  assert.deepEqual(new Set(sug.memory_ids), new Set([a.id, b.id]));

  const applied = await consolidateApproved({
    suggestion_id: proposal.suggestion_id, project_id: p, approved: true, actor: "unit-test", note: "ok to merge",
  });
  assert.equal(applied.ok, true);
  assert.ok(applied.derived_id);
  assert.ok(applied.rollback_id);

  const derived = await core.getMemory(applied.derived_id);
  assert.ok(derived);
  assert.deepEqual(new Set(derived.metadata.derived_from), new Set([a.id, b.id]));
  assert.match(derived.metadata.note, /provenance=test_fixture/);
  assert.equal(derived.verified, false);

  // Sources remain, with original provenance intact.
  assert.equal((await core.getMemory(a.id)).provenance, "test_fixture");
  assert.equal((await core.getMemory(b.id)).provenance, "test_fixture");
});

test("8. repeated proposal and repeated approval are idempotent", async () => {
  const p = `idem-${uniq()}`;
  const text = `Idempotent body ${uniq()} identical in both sources.`;
  const a = await save({ project_id: p, title: "I A", content: text });
  const b = await save({ project_id: p, title: "I B", content: text });
  const cand = (await findCandidates({ project_id: p })).candidates.find((x) =>
    x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(cand);

  const first = await proposeConsolidation({ candidate: cand, project_id: p });
  const second = await proposeConsolidation({
    candidate: { ...cand, memory_ids: [b.id, a.id] }, project_id: p,
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.suggestion_id, first.suggestion_id);

  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM consolidation_suggestion WHERE id = ANY($1::uuid[])", [[first.suggestion_id]],
  )).rows[0].n;
  assert.equal(count, 1);

  const applied1 = await consolidateApproved({ suggestion_id: first.suggestion_id, project_id: p, approved: true });
  const applied2 = await consolidateApproved({ suggestion_id: first.suggestion_id, project_id: p, approved: true });
  assert.equal(applied2.duplicate, true);
  assert.equal(applied2.derived_id, applied1.derived_id);
});

test("9. discovery and proposal never auto-merge", async () => {
  const p = `nomerge-${uniq()}`;
  const text = `No auto merge body ${uniq()} identical in both sources.`;
  const a = await save({ project_id: p, title: "N A", content: text });
  const b = await save({ project_id: p, title: "N B", content: text });
  await findCandidates({ project_id: p });
  assert.equal((await core.getMemory(a.id)).version, 1);
  assert.equal((await core.getMemory(b.id)).version, 1);

  const derivedBefore = (await core.dbQuery(
    "SELECT count(*)::int n FROM memory WHERE title LIKE 'Consolidated:%' AND project_id=$1", [p],
  )).rows[0].n;
  await proposeConsolidation({
    candidate: { kind: "duplicate", memory_ids: [a.id, b.id], confidence: 0.9, reason: "test" },
    project_id: p,
  });
  const derivedAfter = (await core.dbQuery(
    "SELECT count(*)::int n FROM memory WHERE title LIKE 'Consolidated:%' AND project_id=$1", [p],
  )).rows[0].n;
  assert.equal(derivedAfter, derivedBefore, "proposal alone must not create a derived memory");
  assert.notEqual(await core.getMemory(a.id), null);
  assert.notEqual(await core.getMemory(b.id), null);
});

test("10. project validation on every write path", async () => {
  const pA = `vpa-${uniq()}`, pB = `vpb-${uniq()}`;
  const a = await save({ project_id: pA, title: "VA", content: `body ${uniq()} in A.` });
  const b = await save({ project_id: pB, title: "VB", content: `body ${uniq()} in B.` });

  const proposal = await proposeConsolidation({
    candidate: { kind: "duplicate", memory_ids: [a.id, b.id], confidence: 0.9, reason: "x" },
    project_id: pA,
  });
  assert.equal(proposal.ok, false);

  const contradiction = await recordContradiction({
    project_id: pA, memory_a: a.id, memory_b: b.id, description: "cross project",
  });
  assert.equal(contradiction.ok, false);

  const sug = (await core.dbQuery(
    `INSERT INTO consolidation_suggestion (kind,memory_ids,title,description,confidence,triage_status)
     VALUES ('duplicate',$1::uuid[],'x','x',0.9,'ready_for_review') RETURNING id`, [[a.id, b.id]],
  )).rows[0].id;
  await assert.rejects(() =>
    consolidateApproved({ suggestion_id: sug, project_id: pA, approved: true }),
  /cross-project/);
});

test("11. invalid inputs are rejected safely", async () => {
  const p = `inv-${uniq()}`;
  assert.equal((await findCandidates({ project_id: null })).ok, false);
  assert.equal((await reviewContradictions({})).ok, false);
  assert.equal((await findSimilarButUnrelated({ project_id: p, text: "" })).ok, false);
  assert.equal((await proposeConsolidation({
    candidate: { kind: "bogus", memory_ids: [], confidence: 0.5 }, project_id: p,
  })).ok, false);
  assert.equal((await proposeConsolidation({ candidate: null, project_id: p })).ok, false);
  assert.equal((await recordContradiction({
    project_id: p, memory_a: "x", memory_b: "x", description: "self",
  })).ok, false);
  assert.equal((await recordContradiction({ project_id: p, memory_a: "x", memory_b: "y" })).ok, false);
  await assert.rejects(() =>
    consolidateApproved({ suggestion_id: "00000000-0000-0000-0000-000000000000", project_id: p, approved: false }),
  /explicit approval/);
});

test("12. results are bounded by the requested limit", async () => {
  const p = `bound-${uniq()}`;
  const tag = uniq();
  for (let i = 0; i < 6; i++) {
    await save({ project_id: p, title: `Bound ${i}`, content: `Bound body ${tag} item ${i} repeated repeated repeated.` });
  }
  for (let i = 0; i < 6; i++) {
    await save({
      project_id: p, title: `Rule ${i}`, layer: "project", category: "rule",
      content: `Rule body ${tag} item ${i} must never maybe always?`,
    });
  }
  const cand = await findCandidates({ project_id: p, limit: 1 });
  assert.ok(cand.candidates.length <= 1);

  const a = (await core.listMemories({ project_id: p, limit: 1 }))[0];
  const sim = await findSimilarButUnrelated({ project_id: p, text: a.id, limit: 1 });
  assert.ok(sim.items.length <= 1);

  const review = await reviewContradictions({ project_id: p, limit: 1 });
  assert.ok(review.items.length <= 1);
});

test("close", async () => { await core.close(); });
