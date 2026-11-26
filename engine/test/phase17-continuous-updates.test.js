// Phase 17 capability F: continuous project context updates from completed
// durable transcripts. Additive only: unique session/project ids, no deletion,
// no reclassification, no config edits. No new real OpenCode session is needed;
// durable fixture transcripts are built with transcript.appendLine.
//
// Runs standalone with:
//   $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase17-continuous-updates.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import {
  runContextUpdate,
  contextUpdateStatus,
  retryContextUpdates,
  extractCandidates,
} from "../src/contextUpdate.js";

const uniq = () => `p17cu-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// Build a real durable fixture transcript (4 lines) via the Phase 16 appender.
function fixture(sid, tag) {
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER",
    text: `We use React with TypeScript in src/App.tsx for ${tag}. The project uses PostgreSQL.`,
    kind: "user_statement" });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT",
    text: `We decided to switch from REST to GraphQL for the API in ${tag}.`,
    kind: "agent_reasoning" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: `FAILED test_calc.py::test_add - AssertionError: assert -1 == 5 ERROR: add returns a-b for ${tag}`,
    kind: "technical_knowledge" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: `pytest -q test_calc.py: 1 passed for ${tag}`, kind: "technical_knowledge" });
  return transcript.lastSequence(sid);
}

// ---- 1. completed transcript processing -----------------------------------
test("1. completed durable transcript produces an evidence-backed context update", async () => {
  const sid = `p17cu-c-${uniq()}`;
  const project = `p17cu-proj-${uniq()}`;
  const seq = fixture(sid, "completed");

  const r = await runContextUpdate({ session_id: sid, project_id: project, min_sequence: seq });

  assert.equal(r.ok, true);
  assert.equal(r.status, "done");
  assert.ok(r.update_id, "a ledger row id must be returned");
  assert.equal(r.result.analyzed_lines, 4);
  assert.equal(r.result.source_session, sid, "provenance must record the source session");
  assert.equal(r.result.transcript_sequence, seq);
  assert.equal(r.result.project_id, project);
  assert.ok(Array.isArray(r.result.facts));
  assert.ok(Array.isArray(r.result.decisions));
  assert.ok(Array.isArray(r.result.relationships));
  assert.ok(Array.isArray(r.result.degraded), "degraded extractors must be recorded");

  const facts = r.result.facts;
  assert.ok(facts.some((f) => f.kind === "technology"), "technology mention becomes a fact");
  assert.ok(facts.some((f) => f.kind === "file_path"), "file path mention becomes a fact");
  assert.ok(facts.some((f) => f.kind === "error"), "tool error becomes a fact");
  assert.ok(facts.some((f) => f.kind === "test_result"), "test result becomes a fact");
  assert.ok(facts.every((f) => typeof f.confidence === "number" && f.confidence > 0));
  assert.ok(facts.every((f) => f.source_session === sid));
  assert.ok(r.result.decisions.some((d) => /GraphQL/.test(d.statement)), "explicit decision is extracted");

  const rows = await core.dbQuery(
    "SELECT status,result,project_id,session_id FROM context_update WHERE id=$1", [r.update_id]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].status, "done");
  assert.equal(rows.rows[0].project_id, project);
  assert.equal(rows.rows[0].session_id, sid);
  assert.equal(rows.rows[0].result.source_session, sid);
});

// ---- 2. incomplete transcript rejection (no ledger row) -------------------
test("2. incomplete transcript is refused without creating a ledger row", async () => {
  const sid = `p17cu-i-${uniq()}`;
  const project = `p17cu-proj-${uniq()}`;
  transcript.appendLine({ session_id: sid, role: "USER",
    text: "only one durable line exists for the completeness guard", kind: "user_statement" });

  const before = await core.dbQuery(
    "SELECT count(*)::int AS n FROM context_update WHERE session_id=$1", [sid]);
  const r = await runContextUpdate({ session_id: sid, project_id: project, min_sequence: 99 });

  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(r.expected_sequence, 99);
  assert.equal(r.actual_sequence, 1);
  const after = await core.dbQuery(
    "SELECT count(*)::int AS n FROM context_update WHERE session_id=$1", [sid]);
  assert.equal(after.rows[0].n, before.rows[0].n,
    "an incomplete transcript must never create or claim a ledger row");
  assert.equal(after.rows[0].n, 0);
});

// ---- 3. duplicate prevention ----------------------------------------------
test("3. reprocessing the same transcript version is idempotent", async () => {
  const sid = `p17cu-d-${uniq()}`;
  const project = `p17cu-proj-${uniq()}`;
  const seq = fixture(sid, "duplicate");

  const a = await runContextUpdate({ session_id: sid, project_id: project, min_sequence: seq });
  const b = await runContextUpdate({ session_id: sid, project_id: project, min_sequence: seq });

  assert.equal(a.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.update_id, a.update_id);
  const rows = await core.dbQuery(
    "SELECT id FROM context_update WHERE session_id=$1 AND transcript_sequence=$2", [sid, seq]);
  assert.equal(rows.rowCount, 1, "exactly one ledger row per transcript version");
});

// ---- 4. retry behavior ----------------------------------------------------
test("4. failed updates are retryable and attempts history is preserved", async () => {
  const sid = `p17cu-r-${uniq()}`;
  const project = `p17cu-proj-${uniq()}`;
  const seq = fixture(sid, "retry");

  // Inject a failed row with the same idempotency key, as a crashed run would leave.
  await core.dbQuery(
    `INSERT INTO context_update (project_id,session_id,transcript_sequence,status,result,error,attempts)
     VALUES ($1,$2,$3,'failed','{}'::jsonb,'injected failure',1)
     ON CONFLICT (session_id,transcript_sequence) DO NOTHING`, [project, sid, seq]);

  const before = await core.dbQuery(
    "SELECT attempts,status FROM context_update WHERE session_id=$1", [sid]);
  assert.equal(before.rows[0].status, "failed");

  const r = await retryContextUpdates({ project_id: project, limit: 20 });
  assert.equal(r.ok, true);
  assert.ok(r.attempted >= 1);
  assert.ok(r.retried >= 1);

  const after = await core.dbQuery(
    "SELECT status,attempts,result,error FROM context_update WHERE session_id=$1", [sid]);
  assert.equal(after.rows[0].status, "done");
  assert.ok(after.rows[0].attempts >= 2, "attempts must increment, never reset");
  assert.equal(after.rows[0].result.source_session, sid);
  assert.equal(after.rows[0].result.analyzed_lines, 4);
  assert.equal(after.rows[0].error, null);
});

// ---- 5. project isolation and fail-closed input ---------------------------
test("5. updates are project-scoped and invalid inputs fail closed", async () => {
  const sidA = `p17cu-iso-a-${uniq()}`;
  const sidB = `p17cu-iso-b-${uniq()}`;
  const projA = `p17cu-projA-${uniq()}`;
  const projB = `p17cu-projB-${uniq()}`;
  const seqA = fixture(sidA, "iso-a");
  const seqB = fixture(sidB, "iso-b");

  await runContextUpdate({ session_id: sidA, project_id: projA, min_sequence: seqA });
  await runContextUpdate({ session_id: sidB, project_id: projB, min_sequence: seqB });

  const a = await contextUpdateStatus({ project_id: projA, limit: 50 });
  const b = await contextUpdateStatus({ project_id: projB, limit: 50 });
  assert.equal(a.ok, true);
  assert.ok(a.items.length >= 1);
  assert.ok(a.items.every((x) => x.project_id === projA));
  assert.ok(b.items.every((x) => x.project_id === projB));
  assert.ok(!a.items.some((x) => x.session_id === sidB), "project A must not see project B rows");
  assert.ok(!b.items.some((x) => x.session_id === sidA), "project B must not see project A rows");

  const badGlobal = await runContextUpdate({ session_id: sidA, project_id: "_global" });
  assert.equal(badGlobal.ok, false);
  const badNoProject = await runContextUpdate({ session_id: sidA });
  assert.equal(badNoProject.ok, false);
  const badNoSession = await runContextUpdate({ project_id: projA });
  assert.equal(badNoSession.ok, false);
});

// ---- 6. bounded analysis and pure candidate extraction --------------------
test("6. analysis is bounded to 60 lines and extractCandidates is pure", async () => {
  const sid = `p17cu-b-${uniq()}`;
  const project = `p17cu-proj-${uniq()}`;
  const lines = Array.from({ length: 130 }, (_, i) => ({
    seq: i + 1, session_id: sid, role: "USER",
    text: `We use React and PostgreSQL in src/file${i}.ts for generated line ${i}.`,
  }));

  const r = await runContextUpdate({
    session_id: sid, project_id: project, transcript_lines: lines, sequence: 130,
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.analyzed_lines, 60, "no more than 60 lines may be analyzed");

  const snapshot = JSON.stringify(lines);
  const out = extractCandidates(lines, project);
  assert.equal(JSON.stringify(lines), snapshot, "extractCandidates must not mutate its input");
  assert.ok(out.facts.length > 0);
  assert.ok(Array.isArray(out.decisions));
  assert.ok(Array.isArray(out.relationships));
  assert.ok(out.facts.every((f) => typeof f.confidence === "number"
    && f.confidence > 0 && f.confidence <= 1));
  assert.ok(out.facts.every((f) => f.source_session === sid));
  assert.deepEqual(extractCandidates(lines, project), out, "extraction must be deterministic");
});

test("close pool", async () => { await core.close(); });
