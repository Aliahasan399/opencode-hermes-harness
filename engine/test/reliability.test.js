import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import { runTurnEnd, recoverAutomation, recoverIfDue, automationStatus } from "../src/automation.js";

const uniq = () => `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const SQLITE = "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";

function originalDigest() {
  const rows = execFileSync(SQLITE, ["-readonly", DB, "SELECT seq||'|'||coalesce(json_extract(data,'$.text'),'') FROM session_message ORDER BY seq LIMIT 400;"], { encoding: "utf8" });
  return crypto.createHash("sha256").update(rows).digest("hex");
}

test("1-2. startup recovery resets stale processing and records audit", async () => {
  const sid = `stale-${uniq()}`;
  const eid = `evt-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO automation_events (session_id,event_id,payload,status,attempts,created_at,updated_at)
     VALUES ($1,$2,'{"transcript":"USER: recover this session"}'::jsonb,'processing',1,now(),now() - interval '1 hour')`,
    [sid, eid],
  );
  const r = await recoverAutomation({ limit: 5, scan_transcripts: false });
  assert.ok(r.stale_reset >= 1);
  const row = (await core.dbQuery("SELECT status FROM automation_events WHERE session_id=$1 AND event_id=$2", [sid, eid])).rows[0];
  assert.ok(["done", "pending", "processing", "failed"].includes(row.status));
  const audits = (await core.dbQuery(
    "SELECT count(*)::int n FROM intelligence_audit_events WHERE action LIKE '%recovery%' OR action LIKE '%stale%'")).rows[0].n;
  assert.ok(audits >= 1);
});

test("3. restart during active session: durable transcript recovers into pipeline", async () => {
  const sid = `restarted-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER", text: `prefer sqlite for local tests in ${sid}` });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: `acknowledged before restart in ${sid}` });
  // Simulate a fresh process: clear in-memory sequence cache and run recovery.
  transcript.resetSequenceCache();
  const r = await recoverAutomation({ limit: 5, scan_transcripts: true, session_ids: [sid] });
  assert.ok(r.sessions_discovered >= 1);
  const ev = (await core.dbQuery("SELECT status,sequence FROM automation_events WHERE session_id=$1", [sid])).rows[0];
  assert.ok(ev);
  assert.equal(ev.status, "done");
  assert.ok(ev.sequence >= 2);
});

test("4. short session (one line) is processed", async () => {
  const sid = `short-${uniq()}`;
  const r = await runTurnEnd({ session_id: sid, transcript: `USER: keep logs short in ${sid}`, sequence: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  const ev = (await core.dbQuery("SELECT status FROM automation_events WHERE session_id=$1", [sid])).rows[0];
  assert.equal(ev.status, "done");
});

test("5. long-session transcript is preserved, not silently truncated", async () => {
  const sid = `long-${uniq()}`;
  transcript.resetSequenceCache();
  for (let i = 0; i < 60; i++) transcript.appendLine({ session_id: sid, role: i % 2 ? "ASSISTANT" : "USER", text: `line ${i} note ${sid} with enough characters` });
  const lines = transcript.readLines(sid);
  assert.equal(lines.length, 60);
  assert.equal(transcript.lastSequence(sid), 60);
  assert.match(transcript.transcriptText(sid), /line 59 note/);
});

test("6. duplicate event rejection", async () => {
  const sid = `dup-${uniq()}`;
  const text = `USER: duplicate check ${sid}`;
  const a = await runTurnEnd({ session_id: sid, transcript: text, event_id: "fixed-evt", sequence: 5 });
  const b = await runTurnEnd({ session_id: sid, transcript: text, event_id: "fixed-evt", sequence: 5 });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
});

test("7. out-of-order event rejection", async () => {
  const sid = `order-${uniq()}`;
  const newer = await runTurnEnd({ session_id: sid, transcript: `USER: newer note ${sid}`, sequence: 10 });
  const older = await runTurnEnd({ session_id: sid, transcript: `USER: older note ${sid}`, sequence: 4 });
  assert.equal(newer.duplicate, false);
  assert.equal(older.duplicate, true);
  assert.equal(older.reason, "out_of_order");
  const count = (await core.dbQuery("SELECT count(*)::int n FROM automation_events WHERE session_id=$1", [sid])).rows[0].n;
  assert.equal(count, 1);
});

test("8. restart-safe idempotency: completed events are not reprocessed", async () => {
  const sid = `idem-${uniq()}`;
  const text = `USER: idempotent after restart ${sid}`;
  await runTurnEnd({ session_id: sid, transcript: text, sequence: 7 });
  await core.dbQuery("UPDATE harness_state SET key=key WHERE key='last_automation_recovery'");
  const again = await runTurnEnd({ session_id: sid, transcript: text, sequence: 7 });
  assert.equal(again.duplicate, true);
  const r = await recoverAutomation({ limit: 5, scan_transcripts: false });
  assert.equal(r.sessions_recovered, 0);
});

test("9. original OpenCode session data preserved", () => {
  const before = originalDigest();
  const sid = `preserve-${uniq()}`;
  transcript.appendLine({ session_id: sid, role: "USER", text: `original preservation check ${sid}` });
  assert.equal(originalDigest(), before);
});

test("recoverIfDue is rate-limited", async () => {
  // Pin the state row explicitly: parallel test files share harness_state.
  await core.dbQuery(
    `INSERT INTO harness_state (key,value,updated_at) VALUES ('last_automation_recovery','{}'::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET updated_at=now()`);
  const b = await recoverIfDue({ min_interval_ms: 60000 });
  assert.equal(b.ok, true);
  assert.equal(b.skipped, "recent");
});

test("close", async () => { await core.close(); });
