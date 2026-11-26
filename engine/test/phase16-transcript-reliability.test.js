// Phase 16: durable transcript synchronization and complete-learning reliability.
// Additive only: unique session ids, no deletion, no reclassification, no config edits.
// Runs standalone with: node --test test/phase16-transcript-reliability.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import { appendLine, readLines, lastSequence, transcriptText } from "../src/transcript.js";
import { runTurnEnd } from "../src/automation.js";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ENGINE, "src", "cli.js");
const uniq = () => `p16-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// Each append runs in its own process, exactly as the plugin's durableAppend does.
function cliAppend(session_id, text, role = "TOOL") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "transcript-append"], { cwd: ENGINE, windowsHide: true });
    let out = "", err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(0, 300)));
      try { resolve(JSON.parse(out.trim().split("\n").pop() || "{}")); }
      catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({
      session_id, role, text, kind: "technical_knowledge", language: "unknown",
    }));
  });
}

// ---- 1. concurrent durable appends ----------------------------------------
test("1. concurrent cross-process appends keep unique, ordered seq values", async () => {
  const sid = uniq();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    cliAppend(sid, `tool output line ${i} long enough to persist`, "TOOL")));
  assert.ok(results.every((r) => r.ok === true), "every append must report ok");
  const lines = readLines(sid);
  assert.equal(lines.length, 8, "no durable line may be lost");
  const seqs = lines.map((l) => l.seq);
  assert.equal(new Set(seqs).size, 8, "seq values must be unique across processes");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq must be strictly increasing");
  assert.equal(lastSequence(sid), 8);
  for (let i = 0; i < 8; i++) assert.match(transcriptText(sid), new RegExp(`tool output line ${i}`));
});

// ---- 2. independent sessions ----------------------------------------------
test("2. append seq counters are independent per session", async () => {
  const a = uniq(), b = uniq();
  appendLine({ session_id: a, role: "USER", text: "first session prompt here", kind: "user_statement" });
  appendLine({ session_id: b, role: "USER", text: "second session prompt here", kind: "user_statement" });
  appendLine({ session_id: b, role: "TOOL", text: "second session tool output here", kind: "technical_knowledge" });
  assert.equal(lastSequence(a), 1);
  assert.equal(lastSequence(b), 2);
  assert.equal(readLines(a).length, 1);
  assert.equal(readLines(b).length, 2);
});

// ---- 3. incomplete transcript is refused ----------------------------------
test("3. min_sequence guard refuses a partial transcript without claiming work", async () => {
  const sid = uniq();
  appendLine({ session_id: sid, role: "USER", text: "a prompt for the completeness guard", kind: "user_statement" });
  const before = await core.dbQuery(
    "SELECT count(*)::int AS n FROM automation_events WHERE session_id=$1", [sid]);
  const r = await runTurnEnd({
    session_id: sid,
    project_id: `p16-guard-${uniq()}`,
    transcript: transcriptText(sid),
    min_sequence: 99,
  });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(r.expected_sequence, 99);
  assert.equal(r.actual_sequence, 1);
  const after = await core.dbQuery(
    "SELECT count(*)::int AS n FROM automation_events WHERE session_id=$1", [sid]);
  assert.equal(after.rows[0].n, before.rows[0].n,
    "an incomplete transcript must never be claimed as a completed automation event");
});

// ---- 4. complete transcript still processes --------------------------------
test("4. a complete transcript with matching min_sequence processes normally", async () => {
  const sid = uniq();
  appendLine({ session_id: sid, role: "USER", text: "complete transcript prompt for learning", kind: "user_statement" });
  appendLine({ session_id: sid, role: "TOOL", text: "tool output: 1 failed, assertion error", kind: "technical_knowledge" });
  const seq = lastSequence(sid);
  const r = await runTurnEnd({
    session_id: sid,
    project_id: `p16-complete-${uniq()}`,
    transcript: transcriptText(sid),
    min_sequence: seq,
  });
  assert.equal(r.ok, true);
  assert.notEqual(r.incomplete, true);
  assert.equal(r.transcript.complete, true);
  assert.equal(r.transcript.sequence, seq);
  assert.ok(r.transcript.lines >= 2);
  assert.ok(r.stages && typeof r.stages === "object");
});

// ---- 5. write failure is observable ---------------------------------------
test("5. rejected appends are reported, not silently dropped", () => {
  const sid = uniq();
  const r = appendLine({ session_id: sid, role: "USER", text: "   ", kind: "user_statement" });
  assert.equal(r.ok, false);
  assert.match(String(r.skipped), /empty/);
  assert.equal(readLines(sid).length, 0);
});

test("close pool", async () => { await core.close(); });
