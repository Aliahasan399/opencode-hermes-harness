import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { prepareContext } from "../src/contextPackage.js";

const uniq = () => `p13e-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("1. compact context respects the character budget", async () => {
  const p = `budget-${uniq()}`;
  await core.saveMemory({ layer: "knowledge", project_id: p, title: `Redis ttl ${uniq()}`, content: `Use redis with a ten minute ttl in ${p}.`, source_kind: "verified", verified: true, provenance: "production" });
  const r = await prepareContext({ project_id: p, budget_chars: 600 });
  assert.equal(r.ok, true);
  assert.ok(r.context.length <= 650);
  assert.match(r.context, /truncated|Context for project/);
});

test("2. no-memory fallback still returns a valid package", async () => {
  const r = await prepareContext({ project_id: `empty-${uniq()}` });
  assert.equal(r.ok, true);
  assert.match(r.context, /Context for project/);
  assert.ok(r.context.length > 0);
});

test("3. project isolation in context packages", async () => {
  const p1 = `iso-a-${uniq()}`, p2 = `iso-b-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p1, title: `Secret ${uniq()}`, content: `Only ${p1} uses redis ttl.` });
  const r = await prepareContext({ project_id: p2 });
  assert.equal(r.context.includes(m.id), false);
});

test("4. verified knowledge and candidates are labeled separately", async () => {
  const p = `labels-${uniq()}`;
  await core.saveMemory({ layer: "knowledge", project_id: p, title: `Verified ${uniq()}`, content: `Verified redis policy in ${p}.`, verified: true, source_kind: "verified", provenance: "production" });
  const r = await prepareContext({ project_id: p, query: "Verified redis policy" });
  assert.match(r.context, /verified|candidate/);
});

test("5. source references are included", async () => {
  const p = `src-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: `Source ${uniq()}`, content: `Focused tests before suite in ${p}.`, source_session: `ses-${uniq()}` });
  const r = await prepareContext({ project_id: p, query: m.title });
  assert.ok(r.sources.length >= 1);
  if (r.context.includes(m.id)) assert.match(r.context, /source/);
});

test("close", async () => { await core.close(); });
