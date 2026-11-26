import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { scoreMemoryQuality, maintenanceReport, explainRetrieval, learningEvidenceReport, archiveMemory, restoreMemory } from "../src/memoryIntelligence.js";

const uniq = () => `p14i-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("1. quality score is explainable and does not invent accuracy", async () => {
  const m = await core.saveMemory({ layer: "knowledge", project_id: "p14i", title: `Quality ${uniq()}`, content: `Redis ttl policy ${uniq()}`, provenance: "production", confidence: 0.8 });
  const r = await scoreMemoryQuality({ memory_id: m.id });
  assert.ok(r.parts && r.score >= 0 && r.score <= 1);
  assert.match(r.note, /never establish accuracy/);
  const stored = await core.getMemory(m.id);
  assert.ok(stored.quality_explanation.parts);
});

test("2. maintenance report is read-only and bounded", async () => {
  const before = (await core.dbQuery("SELECT count(*)::int n FROM memory")).rows[0].n;
  const r = await maintenanceReport({ limit: 20 });
  const after = (await core.dbQuery("SELECT count(*)::int n FROM memory")).rows[0].n;
  assert.equal(after, before);
  assert.ok(r.counts.scanned <= 20);
});

test("3. retrieval explanation includes project attribution and exclusion reason", async () => {
  const p = `explain-${uniq()}`;
  await core.saveMemory({ layer: "knowledge", project_id: p, title: `Redis ${uniq()}`, content: `Use redis ttl in ${p}.`, provenance: "production" });
  const r = await explainRetrieval({ query: "redis ttl", project_id: p, limit: 3 });
  assert.ok(r.retrieval_event_id > 0);
  assert.match(r.excluded_reason, /other-project|project isolation/);
});

test("4. learning evidence report separates observed from estimated", async () => {
  const r = await learningEvidenceReport({});
  assert.ok(Number.isInteger(r.observed_outcomes));
  assert.ok(Number.isInteger(r.estimated_outcomes));
  assert.match(r.note, /not verified learning/);
});

test("5. archive and restore are reversible and preserve source", async () => {
  const m = await core.saveMemory({ layer: "user", project_id: "p14i", title: `Archive ${uniq()}`, content: "archive me" });
  await core.dbQuery("UPDATE memory SET lifecycle='REJECTED' WHERE id=$1", [m.id]);
  const a = await archiveMemory({ memory_id: m.id });
  assert.equal(a.status, "ARCHIVED");
  const r = await restoreMemory({ memory_id: m.id });
  assert.equal(r.status, "REJECTED");
  const after = await core.getMemory(m.id);
  assert.equal(after.content, "archive me");
  assert.equal(after.valid_until, null);
});

test("close", async () => { await core.close(); });
