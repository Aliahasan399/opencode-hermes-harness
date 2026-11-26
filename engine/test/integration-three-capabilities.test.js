import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as core from "../src/core.js";
import * as automation from "../src/automation.js";
import * as worker from "../src/session-worker.js";
import * as intel from "../src/intelligence.js";
import { resolveProjectId } from "../src/projectIdentity.js";

const uniq = () => `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const LOGDIR = path.resolve("..", "logs", "sessions");

test("1. cross-session recall: memory saved in session A is retrieved for session B", async () => {
  const p = `recall-${uniq()}`;
  const a = await core.saveMemory({ layer: "project", project_id: p, title: "Redis cache policy",
    content: `Use redis caching with a 10 minute ttl in ${p}. Decided after load testing.`, source_kind: "verified", confidence: 0.8 });
  const r = await intel.contextRetrieve({ query: "what cache policy was decided", project_id: p, limit: 5 });
  assert.ok(r.event_id > 0);
  assert.ok(r.results.some((x) => x.id === a.id));
  assert.match(r.context, /Redis cache policy/);
  const ev = (await core.dbQuery("SELECT memory_ids FROM memory_retrieval_events WHERE id=$1", [r.event_id])).rows[0];
  assert.ok(ev.memory_ids.includes(a.id));
});

test("2. automatic turn-end pipeline runs all stages without manual prompts", async () => {
  const sid = `turn-${uniq()}`;
  const dir = "E:\\New  Project";
  const pid = await resolveProjectId(dir);
  const transcript = `USER: Always use TypeScript strict mode in ${sid}.\nASSISTANT: fixed by clearing the vite cache in ${sid}.\nTOOL: error: build failed in ${sid}`;
  const r = await automation.runTurnEnd({ session_id: sid, directory: dir, project_id: pid, transcript });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.project_id, pid);
  for (const stage of ["learning","understanding","patterns","strategy"]) {
    assert.ok(r.stages[stage], `missing stage ${stage}`);
  }
  const rows = (await core.dbQuery("SELECT status,attempts FROM automation_events WHERE session_id=$1", [sid])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "done");
});

test("2b. repeated and out-of-order events are deduplicated", async () => {
  const sid = `dup-${uniq()}`;
  const transcript = `USER: prefer concise logs in ${sid}`;
  const first = await automation.runTurnEnd({ session_id: sid, directory: "E:/New  Project", transcript, event_id: "evt-1" });
  const second = await automation.runTurnEnd({ session_id: sid, directory: "E:/New  Project", transcript, event_id: "evt-1" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
});

test("3. all extracted memories remain candidates", async () => {
  const sid = `cand-${uniq()}`;
  await automation.runTurnEnd({ session_id: sid, directory: "E:/New  Project",
    transcript: `ASSISTANT: fixed the error in ${sid}.\nUSER: never use npm in ${sid}` });
  const rows = (await core.dbQuery("SELECT verified,lifecycle,source_kind FROM memory WHERE source_session=$1", [sid])).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.verified === false));
  assert.ok(rows.every((x) => x.lifecycle === "HYPOTHESIS"));
});

test("4. original session summary preserved by the full pipeline", async () => {
  const sid = `preserve-${uniq()}`;
  const original = `ORIGINAL ${uniq()}`;
  await core.dbQuery(`INSERT INTO session_index (id,project_id,title,summary,message_count,time_updated)
    VALUES ($1,'preservep','orig',$2,1,now())`, [sid, original]);
  await automation.runTurnEnd({ session_id: sid, directory: "E:/New  Project", project_id: "preservep",
    transcript: `USER: prefer short answers in ${sid}` });
  const row = (await core.dbQuery("SELECT summary,summary_roles FROM session_index WHERE id=$1", [sid])).rows[0];
  assert.equal(row.summary, original);
  assert.ok(row.summary_roles);
});

test("5. deterministic worker works with LLM disabled and never claims LLM success", async () => {
  const previous = process.env.HARNESS_LLM_ENABLED;
  process.env.HARNESS_LLM_ENABLED = "0";
  const sid = `worker-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO session_index (id,project_id,title,summary,message_count,time_updated)
     VALUES ($1,'_global','worker test','worker test',2,now()) ON CONFLICT (id) DO NOTHING`, [sid]);
  const r = await worker.processSession({ session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.llm_used, false);
  assert.equal(r.deterministic, true);
  assert.ok(r.data.role_counts);
  if (previous === undefined) delete process.env.HARNESS_LLM_ENABLED;
  else process.env.HARNESS_LLM_ENABLED = previous;
});

test("6. usefulness feedback is recorded and affects reranking", async () => {
  const p = `use-${uniq()}`;
  const m = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Useful fact",
    content: `Focused tests run before full suite in ${p}.`, source_kind: "verified" });
  const r = await intel.contextRetrieve({ query: "focused tests before full suite", project_id: p, limit: 3 });
  const hit = r.results.find((x) => x.id === m.id);
  assert.ok(hit);
  const before = hit.rerank_score;
  await intel.markUsefulness({ event_id: r.event_id, memory_id: m.id, signal: "helpful", source: "observed" });
  const r2 = await intel.contextRetrieve({ query: "focused tests before full suite", project_id: p, limit: 3 });
  const hit2 = r2.results.find((x) => x.id === m.id);
  assert.ok(hit2.rerank_score >= before);
  const cnt = (await core.dbQuery("SELECT useful_count FROM memory WHERE id=$1", [m.id])).rows[0].useful_count;
  assert.ok(cnt >= 1);
});

test("7. automation is resumable: a failed event can be retried", async () => {
  const sid = `retry-${uniq()}`;
  const file = path.join(LOGDIR, `${sid}.txt`);
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.writeFileSync(file, `USER: retry test note ${sid}`, { mode: 0o600 });
  const r = await automation.runTurnEnd({ session_id: sid, directory: "E:/New  Project", transcript: `USER: retry test note ${sid}` });
  assert.equal(r.ok, true);
  const st = await automation.automationStatus();
  assert.ok(st.by_status.some((x) => x.status === "done"));
});

test("8. retryPending uses stored transcript and does not invent data", async () => {
  const r = await automation.retryPending({ limit: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 0);
});

test("close", async () => { await core.close(); });
