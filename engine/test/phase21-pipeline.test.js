// Phase 21 workstream D: feedback, idempotent learning pipeline, recovery.
// Isolated DB only; unique ids, no deletion of any row.
// Run: MEMORY_DB_NAME=opencode_memory_test node --test test/phase21-pipeline.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.MEMORY_DB_NAME = process.env.MEMORY_DB_NAME || "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

let core, pipe, transcript;
async function load() {
  if (!core) {
    core = await import("../src/core.js");
    pipe = await import("../src/learningPipeline.js");
    transcript = await import("../src/transcript.js");
  }
  return { core, pipe, transcript };
}
const uniq = () => `p21d-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function makeLearning({ project_id, confidence = 0.5, verification = "observed" }) {
  const { core: db } = await load();
  const id = randomUUID();
  await db.dbQuery(
    `INSERT INTO learning_record (id, project_id, session_id, signature, category, problem, approach,
       outcome, verification, confidence, evidence, status)
     VALUES ($1,$2,$3,$4,'pattern','fixture problem','fixture approach','uncertain',$5,$6,'[]'::jsonb,'active')`,
    [id, project_id, `sess-${uniq()}`, `sig-${uniq()}`, verification, confidence],
  );
  return id;
}

function passLines(marker) {
  return [
    { seq: 1, role: "USER", text: `Investigate the failing test ${marker}` },
    { seq: 2, role: "ASSISTANT", text: "I will fix the implementation and rerun the suite." },
    { seq: 3, role: "TOOL", tool: "shell", text: `node --test test/x.test.js 1 passed 0 failed ${marker}`, metadata: { exit: 0 } },
  ];
}

// ---- 1. feedback recording -------------------------------------------------
test("1. recordFeedback stores verdict, reason, evidence; confirmed requires explicit", async () => {
  const { core: db, pipe: p } = await load();
  const project = `fb-${uniq()}`;
  const lid = await makeLearning({ project_id: project });
  const bad = await p.recordFeedback({ project_id: project, learning_id: lid, verdict: "confirmed" });
  assert.equal(bad.ok, false);

  const r = await p.recordFeedback({
    project_id: project, learning_id: lid, session_id: "s1", verdict: "confirmed",
    explicit_feedback: true, reason: "verified by operator", evidence: ["ticket:1"],
  });
  assert.equal(r.ok, true, r.reason);
  const row = (await db.dbQuery("SELECT * FROM learning_feedback WHERE id=$1", [r.id])).rows[0];
  assert.equal(row.verdict, "confirmed");
  assert.equal(row.explicit_feedback, true);
  assert.equal(row.reason, "verified by operator");
  assert.deepEqual(row.evidence, ["ticket:1"]);
  assert.equal(row.applied, false);
  assert.equal((await p.recordFeedback({ project_id: "_global", verdict: "confirmed", explicit_feedback: true })).ok, false);
  assert.equal((await p.recordFeedback({ project_id: project, verdict: "bogus" })).ok, false);

  const again = await p.recordFeedback({
    project_id: project, learning_id: lid, session_id: "s1", verdict: "confirmed",
    explicit_feedback: true, reason: "verified by operator", evidence: ["ticket:1"],
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, r.id);
});

// ---- 2. explicit vs inferred distinction ----------------------------------
test("2. explicit feedback applies; inferred feedback is refused", async () => {
  const { core: db, pipe: p } = await load();
  const project = `exp-${uniq()}`;
  const lid = await makeLearning({ project_id: project, confidence: 0.5 });
  const explicit = await p.recordFeedback({ project_id: project, learning_id: lid, verdict: "confirmed", explicit_feedback: true, evidence: ["e1"] });
  const inferred = await p.recordFeedback({ project_id: project, learning_id: lid, verdict: "corrected", explicit_feedback: false, reason: "maybe" });
  assert.equal(inferred.ok, true);

  const no = await p.applyFeedback({ feedback_id: inferred.id, project_id: project });
  assert.equal(no.ok, false);
  assert.equal(no.changed, false);
  const yes = await p.applyFeedback({ feedback_id: explicit.id, project_id: project });
  assert.equal(yes.ok, true, yes.reason);
  assert.equal(yes.changed, true);
  assert.ok(yes.confidence_after > yes.confidence_before);

  const override = await p.applyFeedback({ feedback_id: inferred.id, project_id: project, explicit_override: true });
  assert.equal(override.ok, false, "override needs evidence");
  const rec = (await db.dbQuery("SELECT confidence FROM learning_record WHERE id=$1", [lid])).rows[0];
  assert.ok(rec.confidence > 0.5);
});

// ---- 3. correction lowers confidence, bounded, no promotion ---------------
test("3. explicit correction lowers confidence, appends history, never promotes", async () => {
  const { core: db, pipe: p } = await load();
  const project = `corr-${uniq()}`;
  const lid = await makeLearning({ project_id: project, confidence: 0.6, verification: "inferred" });
  const fb = await p.recordFeedback({ project_id: project, learning_id: lid, verdict: "corrected", explicit_feedback: true, evidence: ["proof:x"] });
  const r = await p.applyFeedback({ feedback_id: fb.id, project_id: project, actor: "qa" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.delta, -0.15);
  assert.ok(r.confidence_after < r.confidence_before);
  const rec = (await db.dbQuery("SELECT confidence, verification, evidence FROM learning_record WHERE id=$1", [lid])).rows[0];
  assert.equal(rec.confidence, r.confidence_after);
  assert.equal(rec.verification, "inferred", "verification must not be promoted");
  assert.ok(rec.evidence.some((e) => e.event === "learning.feedback_applied"));
  assert.equal(rec.evidence.at(-1).previous.confidence, 0.6);
  const applied = (await db.dbQuery("SELECT applied FROM learning_feedback WHERE id=$1", [fb.id])).rows[0];
  assert.equal(applied.applied, true);
});

// ---- 4. single ambiguous statement cannot permanently change important knowledge
test("4. a single non-explicit statement cannot change high-confidence knowledge", async () => {
  const { core: db, pipe: p } = await load();
  const project = `imp-${uniq()}`;
  const lid = await makeLearning({ project_id: project, confidence: 0.95, verification: "verified" });
  const fb = await p.recordFeedback({ project_id: project, learning_id: lid, verdict: "rejected", explicit_feedback: false, reason: "someone said maybe" });
  const r = await p.applyFeedback({ feedback_id: fb.id, project_id: project });
  assert.equal(r.ok, false);
  const rec = (await db.dbQuery("SELECT confidence, verification FROM learning_record WHERE id=$1", [lid])).rows[0];
  assert.equal(rec.confidence, 0.95);
  assert.equal(rec.verification, "verified");
});

// ---- 5. apply idempotent + project isolation -------------------------------
test("5. apply is idempotent and strictly project scoped", async () => {
  const { core: db, pipe: p } = await load();
  const pa = `ida-${uniq()}`;
  const pb = `idb-${uniq()}`;
  const lid = await makeLearning({ project_id: pa, confidence: 0.5 });
  const fb = await p.recordFeedback({ project_id: pa, learning_id: lid, verdict: "corrected", explicit_feedback: true, evidence: ["e"] });
  assert.equal((await p.applyFeedback({ feedback_id: fb.id, project_id: pb })).ok, false);
  const a = await p.applyFeedback({ feedback_id: fb.id, project_id: pa });
  const b = await p.applyFeedback({ feedback_id: fb.id, project_id: pa });
  assert.equal(a.changed, true);
  assert.equal(b.ok, true);
  assert.equal(b.changed, false);
  assert.equal(b.reason, "already_applied");
  const rec = (await db.dbQuery("SELECT confidence, evidence FROM learning_record WHERE id=$1", [lid])).rows[0];
  assert.equal(rec.confidence, a.confidence_after);
  assert.equal(rec.evidence.length, 1, "history must not be appended twice");
  assert.equal((await p.learningPipelineStatus({ project_id: pb })).count, 0);
});

// ---- 6. incomplete transcript refused with no ledger row -------------------
test("6. incomplete transcript is refused before any ledger claim", async () => {
  const { core: db, pipe: p, transcript: t } = await load();
  const sid = `inc-${uniq()}`;
  t.appendLine({ session_id: sid, role: "USER", text: `only a couple of durable lines ${sid}` });
  t.appendLine({ session_id: sid, role: "ASSISTANT", text: "still incomplete for this test" });
  const r = await p.runLearningPipeline({ session_id: sid, project_id: `pi-${uniq()}`, lines: passLines("x"), sequence: 5, min_sequence: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(r.expected_sequence, 9);
  const rows = (await db.dbQuery("SELECT id FROM learning_pipeline_run WHERE session_id=$1", [sid])).rows;
  assert.equal(rows.length, 0, "no ledger row may be claimed for an incomplete transcript");
});

// ---- 7. pipeline idempotency ----------------------------------------------
test("7. pipeline is idempotent for the same session + sequence", async () => {
  const { core: db, pipe: p } = await load();
  const sid = `run-${uniq()}`;
  const project = `pl-${uniq()}`;
  const a = await p.runLearningPipeline({ session_id: sid, project_id: project, lines: passLines(uniq()), sequence: 1 });
  assert.equal(a.ok, true, a.error);
  assert.ok(a.run_id);
  assert.ok(a.result.extracted >= 1, JSON.stringify(a.result));
  assert.ok(a.result.recorded >= 1);
  assert.ok(Array.isArray(a.result.degraded));
  assert.ok(a.result.analyzed_lines <= 80);
  const b = await p.runLearningPipeline({ session_id: sid, project_id: project, lines: passLines(uniq()), sequence: 1 });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.run_id, a.run_id);
  const rows = (await db.dbQuery("SELECT id FROM learning_pipeline_run WHERE session_id=$1 AND transcript_sequence=1", [sid])).rows;
  assert.equal(rows.length, 1);
});

// ---- 8. degraded when sibling missing -------------------------------------
test("8. missing siblings degrade into result.degraded without throwing", async () => {
  const { pipe: p } = await load();
  const sid = `deg-${uniq()}`;
  const project = `dg-${uniq()}`;
  const r = await p.runLearningPipeline({
    session_id: sid, project_id: project, lines: passLines(uniq()), sequence: 1,
    _load: async () => { throw new Error("module missing"); },
  });
  assert.equal(r.ok, true);
  assert.ok(r.result.degraded.length >= 2);
  assert.ok(r.result.degraded.some((d) => String(d).includes("learningExperience")));
  assert.ok(r.result.degraded.some((d) => String(d).includes("learningIntelligence")));
  assert.equal(r.result.extracted, 0);
  assert.equal(r.result.recorded, 0);
});

// ---- 9. retry safe --------------------------------------------------------
test("9. retry only pending/failed, preserves attempts and deletes nothing", async () => {
  const { core: db, pipe: p, transcript: t } = await load();
  const sid = `retry-${uniq()}`;
  const project = `rt-${uniq()}`;
  t.appendLine({ session_id: sid, role: "USER", text: `durable retry line ${sid}` });
  const ins = await db.dbQuery(
    `INSERT INTO learning_pipeline_run (project_id, session_id, transcript_sequence, status, attempts, result)
     VALUES ($1,$2,1,'failed',3,'{"prior":true}'::jsonb) RETURNING id`,
    [project, sid],
  );
  const id = ins.rows[0].id;
  const r = await p.retryLearningPipeline({ limit: 50, project_id: project, session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 1);
  assert.equal(r.retried, 1);
  const row = (await db.dbQuery("SELECT status, attempts FROM learning_pipeline_run WHERE id=$1", [id])).rows[0];
  assert.equal(row.status, "done");
  assert.ok(row.attempts >= 4, "attempts must be preserved/incremented, never reset");
  const again = await p.retryLearningPipeline({ limit: 50, project_id: project, session_id: sid });
  assert.equal(again.attempted, 0, "a done row must not be retried");
  const st = await p.learningPipelineStatus({ project_id: project });
  assert.equal(st.count, 1);
});

// ---- 10. no deletion, content-free audit, bounded results -----------------
test("10. no deletion, content-free audit, bounded status", async () => {
  const { core: db, pipe: p } = await load();
  const project = `audit-${uniq()}`;
  const sid = `aud-${uniq()}`;
  const marker = `SECRET_${uniq()}`;
  const lid = await makeLearning({ project_id: project });
  const fb = await p.recordFeedback({
    project_id: project, learning_id: lid, verdict: "corrected", explicit_feedback: true,
    reason: `reason ${marker}`, evidence: [`evidence ${marker}`],
  });
  await p.applyFeedback({ feedback_id: fb.id, project_id: project });
  await p.runLearningPipeline({ session_id: sid, project_id: project, lines: passLines(marker), sequence: 1 });

  const audits = (await db.dbQuery(
    "SELECT detail FROM audit_log WHERE resource=$1 OR resource=$2", [project, sid],
  )).rows;
  const blob = JSON.stringify(audits);
  assert.doesNotMatch(blob, new RegExp(marker), "audit must not contain reason/evidence/line content");

  const before = (await db.dbQuery("SELECT count(*)::int n FROM learning_feedback WHERE project_id=$1", [project])).rows[0].n;
  const large = await p.learningPipelineStatus({ project_id: project, limit: 100000 });
  assert.equal(large.ok, true);
  assert.ok(large.count <= 200);
  const after = (await db.dbQuery("SELECT count(*)::int n FROM learning_feedback WHERE project_id=$1", [project])).rows[0].n;
  assert.equal(after, before, "no feedback row may be deleted");
  assert.equal((await db.dbQuery("SELECT count(*)::int n FROM learning_record WHERE id=$1", [lid])).rows[0].n, 1);
  assert.equal((await db.dbQuery("SELECT count(*)::int n FROM learning_pipeline_run WHERE session_id=$1", [sid])).rows[0].n, 1);
});

test("close pool", async () => {
  const { core: db } = await load();
  await db.close();
});
