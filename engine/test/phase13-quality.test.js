import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { classifyProvenance, provenanceReport, tagMemoryProvenance, dryRunQualityReport } from "../src/dataQuality.js";

const uniq = () => `p13f-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("1. provenance is explicit or unknown, never guessed from content", () => {
  assert.equal(classifyProvenance({ provenance: "production" }), "production");
  assert.equal(classifyProvenance({ provenance: "test_fixture" }), "test_fixture");
  assert.equal(classifyProvenance({ source_session: "p12-unit-test-1" }), "test_fixture");
  assert.equal(classifyProvenance({ content: "weird unusual data", source_session: "ses_real" }), "unknown");
});

test("2. provenance report counts only real records", async () => {
  const p = `prov-${uniq()}`;
  await core.saveMemory({ layer: "knowledge", project_id: p, title: `Prod ${uniq()}`, content: "production fact", provenance: "production" });
  await core.saveMemory({ layer: "knowledge", project_id: p, title: `Test ${uniq()}`, content: "test fact", provenance: "test_fixture" });
  const r = await provenanceReport({ project_id: p });
  assert.ok(r.totals.production >= 1);
  assert.ok(r.totals.test_fixture >= 1);
});

test("3. explicit tagging requires a valid value", async () => {
  const m = await core.saveMemory({ layer: "knowledge", project_id: "q", title: `Tag ${uniq()}`, content: "tag me" });
  await assert.rejects(() => tagMemoryProvenance({ memory_id: m.id, provenance: "definitely-real" }));
  const r = await tagMemoryProvenance({ memory_id: m.id, provenance: "test_fixture" });
  assert.equal(r.provenance, "test_fixture");
});

test("4. dry-run report is read-only and bounded", async () => {
  // Scope to this test's own project: parallel test files insert into other projects.
  const p = `readonly-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Readonly", content: "unchanged content" });
  const before = await core.dbQuery("SELECT content FROM memory WHERE id=$1", [m.id]);
  const r = await dryRunQualityReport({ project_id: p });
  const after = await core.dbQuery("SELECT content FROM memory WHERE id=$1", [m.id]);
  assert.equal(after.rows[0].content, before.rows[0].content);
  assert.equal(after.rowCount, before.rowCount);
  assert.equal(r.changes_applied, 0);
  assert.ok(r.memory.total >= 1);
  assert.ok(Array.isArray(r.semantic_attribution));
});

test("5. project-scoped data quality report", async () => {
  const p = `iso-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p, title: `Isolated ${uniq()}`, content: "isolated fact", provenance: "production" });
  const r = await dryRunQualityReport({ project_id: p });
  assert.ok(r.memory.total >= 1);
  const other = `other-${uniq()}`;
  const rep = await provenanceReport({ project_id: other });
  const otherMem = await core.dbQuery("SELECT count(*)::int n FROM memory WHERE project_id=$1", [other]);
  assert.equal(rep.classified, otherMem.rows[0].n);
  assert.notEqual(await core.getMemory(m.id), null);
});

test("close", async () => { await core.close(); });
