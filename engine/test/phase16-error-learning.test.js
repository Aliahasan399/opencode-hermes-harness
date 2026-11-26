// Phase 16.4: actual tool-output errors must reach error learning and be linked
// to a verified fix. Additive only; unique ids, no deletion, no reclassification.
// Runs standalone with: node --test test/phase16-error-learning.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import { runTurnEnd } from "../src/automation.js";
import { fixEvidenceReport } from "../src/errorLearning.js";

const uniq = () => `p16e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

function scenario(tag) {
  const sid = `p16-session-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER",
    text: `Fix the add helper for ${tag}: the focused test must pass.`, kind: "user_statement" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: `FAILED test_calc.py::test_add - assert -1 == 5  ERROR: add returns a-b for ${tag}`,
    kind: "technical_knowledge" });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT",
    text: `The subtraction is wrong; changing the operator to a + b to fix it for ${tag}.`,
    kind: "agent_reasoning" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: `pytest -q test_calc.py: 1 passed in 0.13s for ${tag}`, kind: "technical_knowledge" });
  return { sid, seq: transcript.lastSequence(sid), tag };
}

// ---- 1. real tool output produces a verified fix record --------------------
test("1. tool-output failure is linked to a verified fix from the same snapshot", async () => {
  const { sid, seq, tag } = scenario(uniq());
  const project = `p16-project-${uniq()}`;
  const r = await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: seq });

  assert.equal(r.ok, true);
  assert.equal(r.transcript.complete, true);
  assert.ok(r.transcript.lines >= 4, "the complete tool trajectory must be analyzed");
  const el = r.stages.error_learning;
  assert.equal(el.ok, true);
  assert.ok(el.lines >= 4, "error learning must receive the same durable snapshot");
  assert.ok(el.errors >= 1, `a real tool error must be detected, got ${el.errors}`);
  assert.equal(el.fix_linked, true, "a failure + pass line must be linked to a fix");
  assert.equal(el.verified, true, "the fix must be recognized as verified");
  assert.match(String(el.verification_command), /shell/, "verification command comes from the pass line");

  const rep = await fixEvidenceReport({ project_id: project, limit: 200 });
  const row = rep.items.find((x) => x.session_id === sid);
  assert.ok(row, "a fix_evidence row must persist");
  assert.equal(row.status, "verified_fix");
  assert.ok(row.verification_result && String(row.verification_result).includes("1 passed"));
});

// ---- 2. tool output becomes retrievable knowledge --------------------------
test("2. tool output is saved as technical_knowledge under the correct project", async () => {
  const { sid, seq, tag } = scenario(uniq());
  const project = `p16-project-${uniq()}`;
  await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: seq });

  const { rows } = await core.dbQuery(
    `SELECT id, project_id, category FROM memory
      WHERE source_session=$1 AND category='technical_knowledge' ORDER BY created_at`, [sid]);
  assert.ok(rows.length >= 1, "at least one tool-output memory must be saved");
  assert.ok(rows.some((m) => m.project_id === project), "memory must stay in its own project");
  const results = await core.searchMemory({ query: `add helper ${tag}`, project_id: project, limit: 5 });
  assert.ok(Array.isArray(results));
});

// ---- 3. replay does not duplicate learning ---------------------------------
test("3. replaying the same event is a duplicate with no extra fix evidence", async () => {
  const { sid, seq } = scenario(uniq());
  const project = `p16-project-${uniq()}`;
  const opts = { session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: seq,
    event_id: `p16evt-${uniq()}` };
  const first = await runTurnEnd(opts);
  assert.equal(first.ok, true);
  const before = (await fixEvidenceReport({ project_id: project, limit: 200 })).items
    .filter((x) => x.session_id === sid).length;
  const second = await runTurnEnd(opts);
  assert.equal(second.duplicate, true, "a replayed event must be deduped");
  const after = (await fixEvidenceReport({ project_id: project, limit: 200 })).items
    .filter((x) => x.session_id === sid).length;
  assert.equal(after, before, "replay must not create a second fix record");
});

// ---- 4. project isolation of fix evidence ----------------------------------
test("4. fix evidence is scoped to its project", async () => {
  const { sid, seq } = scenario(uniq());
  const a = `p16-projA-${uniq()}`, b = `p16-projB-${uniq()}`;
  await runTurnEnd({ session_id: sid, project_id: a,
    transcript: transcript.transcriptText(sid), min_sequence: seq });
  const inA = await fixEvidenceReport({ project_id: a, limit: 200 });
  const inB = await fixEvidenceReport({ project_id: b, limit: 200 });
  assert.ok(inA.items.some((x) => x.session_id === sid));
  assert.ok(!inB.items.some((x) => x.session_id === sid), "other projects must not see the fix");
});

// ---- 5. realistic pytest failure text is recognized ------------------------
test("5. pytest-style FAILED/AssertionError output is detected and linked", async () => {
  const sid = `p16-pytest-${uniq()}`;
  const project = `p16-project-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: "F                                                             [100%]\nFAILED test_calc.py::test_add - AssertionError: assert -1 == 5\n1 failed in 0.12s" });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: "changing the operator to a + b as the fix" });
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell", text: "1 passed in 0.13s" });
  const seq = transcript.lastSequence(sid);
  const r = await runTurnEnd({ session_id: sid, project_id: project,
    transcript: transcript.transcriptText(sid), min_sequence: seq });
  assert.equal(r.ok, true);
  const el = r.stages.error_learning;
  assert.ok(el.errors >= 1, "a real pytest failure line must be detected");
  assert.equal(el.fix_linked, true);
  assert.equal(el.verified, true);
  assert.match(String(el.verification_command), /shell/);
});

// ---- 6. late durable verification line is still linked --------------------
test("6. verification landing only in the durable transcript is still linked", async () => {
  const sid = `p16-late-${uniq()}`;
  const project = `p16-project-${uniq()}`;
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell",
    text: "FAILED test_late.py::test_add - AssertionError: assert -1 == 5" });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: "changing to a + b as the fix" });
  // Durable-only pass line; the supplied snapshot does not contain it.
  transcript.appendLine({ session_id: sid, role: "TOOL", tool: "shell", text: "1 passed in 0.13s" });
  const supplied = [
    { seq: 1, role: "TOOL", text: "FAILED test_late.py::test_add - AssertionError: assert -1 == 5" },
    { seq: 2, role: "ASSISTANT", text: "changing to a + b as the fix" },
  ];
  const r = await runTurnEnd({ session_id: sid, project_id: project,
    transcript: supplied.map((l) => `${l.role}: ${l.text}`).join("\n"), lines: supplied });
  assert.equal(r.ok, true);
  const el = r.stages.error_learning;
  assert.ok(el.errors >= 1);
  assert.equal(el.fix_linked, true, "a late durable pass line must still be linked");
  assert.equal(el.verified, true);
});

test("close pool", async () => { await core.close(); });
