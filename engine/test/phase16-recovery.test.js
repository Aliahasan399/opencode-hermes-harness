// Phase 16.5: interruption, recovery and duplicate-delivery guarantees.
// Additive only; unique ids, no deletion, no reclassification.
// Runs standalone with: node --test test/phase16-recovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import { runTurnEnd, recoverEvents } from "../src/automation.js";

const uniq = () => `p16r-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// ---- 1. incomplete transcript is deferred, then recovered on completion ----
test("1. an incomplete run creates no event; completion is learned exactly once", async () => {
  const sid = `p16r-defer-${uniq()}`;
  const project = `p16r-project-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER",
    text: "recover this deferred turn-end scenario", kind: "user_statement" });

  const first = await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: 50 });
  assert.equal(first.ok, false);
  assert.equal(first.incomplete, true);
  let rows = await core.dbQuery("SELECT event_id FROM automation_events WHERE session_id=$1", [sid]);
  assert.equal(rows.rowCount, 0, "no event may be claimed for an incomplete transcript");

  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: "FAILED test_recover.py - AssertionError: assert -1 == 5" });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: "changing to a + b to fix" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell", text: "1 passed in 0.01s" });
  const seq = transcript.lastSequence(sid);
  const second = await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: seq });
  assert.equal(second.ok, true);
  assert.equal(second.incomplete, undefined);

  rows = await core.dbQuery("SELECT event_id FROM automation_events WHERE session_id=$1", [sid]);
  assert.equal(rows.rowCount, 1, "exactly one event after completion");
  assert.equal(second.stages.error_learning.verified, true);
});

// ---- 2. duplicate event delivery is idempotent ----------------------------
test("2. duplicate delivery of the same event does not create a second run", async () => {
  const sid = `p16r-dup-${uniq()}`;
  const project = `p16r-project-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER", text: "duplicate delivery scenario prompt", kind: "user_statement" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell", text: "1 passed in 0.01s" });
  const event_id = `evt-${uniq()}`;
  const opts = { session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: transcript.lastSequence(sid), event_id };
  const a = await runTurnEnd(opts);
  const b = await runTurnEnd(opts);
  assert.equal(a.ok, true);
  assert.equal(b.duplicate, true);
  const rows = await core.dbQuery("SELECT event_id FROM automation_events WHERE session_id=$1", [sid]);
  assert.equal(rows.rowCount, 1);
  const runs = await core.dbQuery("SELECT count(*)::int n FROM learning_runs WHERE session_id=$1", [sid]);
  assert.equal(runs.rows[0].n, 1, "duplicate delivery must not duplicate learning");
});

// ---- 3. event recovery is idempotent and never invents success ------------
test("3. recoverEvents is safe to repeat and leaves no incomplete success", async () => {
  const sid = `p16r-recover-${uniq()}`;
  const project = `p16r-project-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER", text: "event recovery safety prompt", kind: "user_statement" });
  await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: transcript.lastSequence(sid) });
  const one = await recoverEvents({ limit: 100 });
  const two = await recoverEvents({ limit: 100 });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  const rows = await core.dbQuery(
    "SELECT status FROM automation_events WHERE session_id=$1", [sid]);
  assert.ok(rows.rows.every((r) => r.status === "done" || r.status === "superseded"));
});

test("close pool", async () => { await core.close(); });
