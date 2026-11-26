import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.js";

const uniq = () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("redaction removes credentials", () => {
  const s = c.redact("key sk-abcdefghijklmnopqrstuvwxyz and password=hunter2secret");
  assert.match(s, /REDACTED/);
  assert.doesNotMatch(s, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.equal(c.looksSensitive("plain text"), false);
});

test("save, get, search, update, delete round trip", async () => {
  const id = uniq();
  const m = await c.saveMemory({
    layer: "knowledge", project_id: id, title: `Redis lock recipe ${id}`,
    content: `Use SET NX PX for a distributed lock in project ${id}.`,
    tags: ["redis", "lock"], source_kind: "verified", confidence: 0.9, importance: 0.8,
  });
  assert.ok(m.id);
  assert.equal((await c.getMemory(m.id)).title, m.title);
  const hits = await c.searchMemory({ query: "distributed lock with redis", project_id: id, limit: 5 });
  assert.ok(hits.some((h) => h.id === m.id));
  const up = await c.updateMemory(m.id, { content: `Use Redlock instead in ${id}.`, confidence: 0.7 }, "test update");
  assert.equal(up.version, 2);
  const hist = await c.dbQuery("SELECT count(*)::int AS n FROM memory_history WHERE memory_id=$1", [m.id]);
  assert.equal(hist.rows[0].n, 1);
  await c.deleteMemory(m.id, true);
  assert.equal(await c.getMemory(m.id), null);
});

test("project isolation", async () => {
  const a = `proj-a-${uniq()}`, b = `proj-b-${uniq()}`;
  const m = await c.saveMemory({ layer: "project", project_id: a, title: `Only in A ${uniq()}`, content: `Secret detail for ${a}.` });
  const inB = await c.listMemories({ project_id: b, limit: 200 });
  assert.equal(inB.some((x) => x.id === m.id), false);
  await c.deleteMemory(m.id, true);
});

test("duplicate detection", async () => {
  const id = uniq();
  const first = await c.saveMemory({ layer: "user", project_id: id, title: `Dup ${id}`, content: `Remember that ${id} uses TypeScript strict mode.` });
  const dup = await c.findDuplicate(first.title, first.content, id);
  assert.equal(dup?.id, first.id);
  await c.deleteMemory(first.id, true);
});

test("compact context respects budget", () => {
  const text = c.compactContext([
    { layer: "user", project_id: "_global", title: "A", content: "x".repeat(100) },
    { layer: "project", project_id: "p", title: "B", content: "y".repeat(100) },
  ], { maxContextChars: 120, maxMemories: 8 });
  assert.ok(text.length <= 130);
  assert.match(text, /\[user\]/);
});

test("learning extracts user preferences", async () => {
  const { learnFromTranscript } = await import("../src/learn.js");
  const id = uniq();
  const r = await learnFromTranscript({
    session_id: id, project_id: id,
    transcript: "USER: Always use TypeScript strict mode in this project.\nASSISTANT: Understood.\nTOOL: error: build failed\nASSISTANT: fixed by adding tsconfig strict flag",
    save: true,
  });
  assert.ok(r.candidates >= 2);
  assert.ok(r.saved >= 1);
});

test("close pool", async () => { await c.close(); });
