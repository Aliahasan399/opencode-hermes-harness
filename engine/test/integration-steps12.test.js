import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as identity from "../src/projectIdentity.js";
import { learnFromTranscript } from "../src/learn.js";

const uniq = () => `s12-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("Step 1: directory resolves to the existing OpenCode project id", async () => {
  const a = await identity.resolveProjectId("E:\\New  Project");
  const b = await identity.resolveProjectId("E:/New  Project/");
  assert.equal(a, b);
  assert.equal(a, "13044f2ae5cff09764b32f1ba690d7d4343cae52");
  const c = await identity.resolveProjectId("E:\\Brand New Folder");
  assert.match(c, /^dir-[a-f0-9]{12}$/);
  assert.equal(await identity.resolveProjectId("E:\\Brand New Folder"), c);
});

test("Step 1: no duplicate namespaces for the same normalized path", async () => {
  const one = await identity.resolveProjectId("E:/OpenCodeData/memory/engine");
  const two = await identity.resolveProjectId("E:\\OpenCodeData\\memory\\engine\\");
  assert.equal(one, two);
});

test("Step 2: assistant 'fixed' is a candidate, never verified", async () => {
  const sid = `learn-${uniq()}`;
  const r = await learnFromTranscript({ session_id: sid, project_id: "safeproj", transcript:
    `USER: Always use TypeScript strict mode here (${sid}).\nASSISTANT: fixed it by clearing the cache (${sid}).\nTOOL: error: build failed (${sid})` });
  assert.equal(r.idempotent, false);
  assert.ok(r.candidates >= 2);
  for (const m of r.memories) assert.equal(m.verified, false);
  const rows = (await core.dbQuery("SELECT content, verified, source_kind FROM memory WHERE source_session=$1", [sid])).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.verified === false));
});

test("Step 2: idempotent extraction does not create duplicate memories", async () => {
  const sid = `idem-${uniq()}`;
  const text = `USER: Always use pnpm in this project (${sid}).\nTOOL: error: dependency conflict (${sid})`;
  const first = await learnFromTranscript({ session_id: sid, project_id: "idemproj", transcript: text });
  const second = await learnFromTranscript({ session_id: sid, project_id: "idemproj", transcript: text });
  assert.equal(second.idempotent, true);
  assert.equal(second.saved, 0);
  const count = (await core.dbQuery("SELECT count(*)::int n FROM memory WHERE source_session=$1", [sid])).rows[0].n;
  assert.equal(count, first.saved);
});

test("Step 2: original imported summary is never overwritten", async () => {
  const sid = `preserve-${uniq()}`;
  const original = "ORIGINAL IMPORTED SUMMARY — must not change";
  await core.dbQuery(
    `INSERT INTO session_index (id,project_id,directory,title,summary,message_count,time_updated)
     VALUES ($1,'preserveproj','E:/x','orig',$2,1,now())`, [sid, original]);
  await learnFromTranscript({ session_id: sid, project_id: "preserveproj", transcript: "USER: prefer concise answers.\nASSISTANT: fixed the bug." });
  const row = (await core.dbQuery("SELECT summary,summary_roles FROM session_index WHERE id=$1", [sid])).rows[0];
  assert.equal(row.summary, original);
  assert.ok(row.summary_roles && row.summary_roles.includes("USER"));
});

test("Step 2: project isolation of extracted candidates", async () => {
  const a = `iso-a-${uniq()}`, b = `iso-b-${uniq()}`;
  const sa = `isa-${uniq()}`;
  await learnFromTranscript({ session_id: sa, project_id: a, transcript: "USER: prefer redis cache with ttl here." });
  const hits = await core.searchMemory({ query: "redis cache ttl", project_id: b, limit: 10 });
  assert.equal(hits.some((h) => h.source_session === sa), false);
});

test("close", async () => { await core.close(); });
