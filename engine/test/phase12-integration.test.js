import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { runTurnEnd } from "../src/automation.js";
import * as intel from "../src/intelligence.js";
import * as transcript from "../src/transcript.js";
import { qualityReport } from "../src/consolidation.js";
import { usefulnessSummary } from "../src/retrievalFeedback.js";

const uniq = () => `p12d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("unified turn-end pipeline includes all Phase 12 stages", async () => {
  const sid = `flow-${uniq()}`;
  const r = await runTurnEnd({ session_id: sid, directory: "E:\\New  Project",
    transcript: `USER: Always run focused tests before full suite in ${sid}.\nASSISTANT: fixed by clearing cache in ${sid}` });
  assert.equal(r.ok, true);
  for (const stage of ["learning","understanding","patterns","strategy","retrieval_feedback","consolidation_triage","outcome_link"]) {
    assert.ok(r.stages[stage], `missing ${stage}`);
  }
});

test("canonical project identity is shared by retrieval and learning", async () => {
  const sid = `canon-${uniq()}`;
  const dir = "E:\\New  Project";
  const r = await runTurnEnd({ session_id: sid, directory: dir, transcript: `USER: prefer sqlite locally in ${sid}` });
  const pid = r.project_id;
  const retrieval = await intel.contextRetrieve({ query: "sqlite locally", project_id: pid, session_id: sid });
  const ev = (await core.dbQuery("SELECT project_id,session_project_id FROM memory_retrieval_events WHERE id=$1", [retrieval.event_id])).rows[0];
  assert.equal(ev.project_id, pid);
  assert.equal(ev.session_project_id, pid);
});

test("retrieval attribution survives repeated sessions without cross-project leakage", async () => {
  const p1 = `i1-${uniq()}`, p2 = `i2-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: p1, title: `Secret ${uniq()}`, content: `Only ${p1} uses redis ttl.` });
  const r = await intel.contextRetrieve({ query: "redis ttl", project_id: p2, session_id: `s-${uniq()}` });
  assert.equal(r.results.some((x) => x.id === m.id), false);
});

test("consolidation and usefulness reports use real records", async () => {
  const q = await qualityReport({});
  assert.ok(q.memories >= 1);
  const u = await usefulnessSummary({});
  assert.equal(u.ok, true);
  assert.ok("not_enough_evidence" in u.buckets);
});

test("durable transcript is preserved by the unified pipeline", async () => {
  const sid = `dur-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER", text: `durable note ${sid}` });
  const before = transcript.readLines(sid).length;
  await runTurnEnd({ session_id: sid, directory: "E:/New  Project", transcript: transcript.transcriptText(sid) });
  assert.equal(transcript.readLines(sid).length, before);
});

test("close", async () => { await core.close(); });
