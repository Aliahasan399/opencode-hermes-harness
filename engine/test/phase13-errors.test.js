import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import { fingerprint, recordFailure, recordFix, observeRecurrence, analyzeSessionErrors, fixEvidenceReport } from "../src/errorLearning.js";

const uniq = () => `p13b-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("1-2. error fingerprint normalization and matching", () => {
  const a = fingerprint("ERROR: failed to resolve dependency lodash at C:\\proj\\node_modules on line 42");
  const b = fingerprint("error: failed to resolve dependency lodash at D:\\other\\node_modules on line 99");
  const c = fingerprint("error: database connection timeout");
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});

test("3. successful fix verification raises confidence only to evidence level", async () => {
  const sid = `fix-${uniq()}`;
  const text = `ERROR: missing dependency lodash in ${uniq()}`;
  const f = await recordFailure({ session_id: sid, project_id: "p13b", text });
  assert.equal(f.recorded, 1);
  const r = await recordFix({ session_id: sid, project_id: "p13b", error_hash: f.error_hash,
    attempted_fix: "install lodash", verification_command: "pytest -q", verification_result: "1 test passed" });
  assert.equal(r.verification_observed, true);
  const row = (await core.dbQuery("SELECT status,confidence FROM fix_evidence WHERE error_hash=$1", [f.error_hash])).rows[0];
  assert.equal(row.status, "verified_fix");
  assert.ok(row.confidence <= 0.8);
});

test("4. non-recurrence requires the observation window to elapse", async () => {
  const sid = `non-${uniq()}`;
  const text = `ERROR: missing module alpha ${uniq()}`;
  const f = await recordFailure({ session_id: sid, project_id: "p13b", text });
  const early = await observeRecurrence({ session_id: sid, project_id: "p13b", error_hash: f.error_hash, window_days: 7 });
  assert.equal(early.outcome, "observation_window_open");
  await core.dbQuery("UPDATE fix_evidence SET created_at=now() - interval '30 days' WHERE error_hash=$1", [f.error_hash]);
  const late = await observeRecurrence({ session_id: sid, project_id: "p13b", error_hash: f.error_hash, window_days: 7 });
  assert.ok(["non_recurrence", "strongly_supported"].includes(late.outcome));
});

test("5. recurrence is detected and recorded as regression", async () => {
  const sid1 = `r1-${uniq()}`, sid2 = `r2-${uniq()}`;
  const text = `ERROR: flaky websocket disconnect ${uniq()}`;
  const f = await recordFailure({ session_id: sid1, project_id: "p13b", text });
  await core.dbQuery("UPDATE fix_evidence SET created_at=now() - interval '30 days' WHERE error_hash=$1", [f.error_hash]);
  await recordFailure({ session_id: sid2, project_id: "p13b", text });
  const r = await observeRecurrence({ session_id: sid1, project_id: "p13b", error_hash: f.error_hash });
  assert.equal(r.outcome, "regressed");
  assert.ok(r.confidence <= 0.35);
});

test("6. project isolation of errors", async () => {
  const sid = `iso-${uniq()}`;
  const f = await recordFailure({ session_id: sid, project_id: "p13b-iso-a", text: `ERROR: isolated issue ${uniq()}` });
  const r = await observeRecurrence({ session_id: sid, project_id: "p13b-iso-b", error_hash: f.error_hash });
  assert.equal(r.ok, false);
});

test("7. duplicate prevention and idempotency", async () => {
  const sid = `dup-${uniq()}`;
  const text = `ERROR: duplicate error signature ${uniq()}`;
  const a = await recordFailure({ session_id: sid, project_id: "p13b", text });
  const b = await recordFailure({ session_id: sid, project_id: "p13b", text });
  assert.equal(a.recorded, 1);
  assert.equal(b.recorded, 0);
});

test("8. missing observations are never counted as success", async () => {
  const r = await recordFix({ session_id: `miss-${uniq()}`, project_id: "p13b", error_hash: "does-not-exist", verification_result: "pass" });
  assert.equal(r.updated, 0);
  const f = await recordFailure({ session_id: `m2-${uniq()}`, project_id: "p13b", text: `ERROR: no verification ${uniq()}` });
  const noVerify = await recordFix({ session_id: `m2-${uniq()}`, project_id: "p13b", error_hash: f.error_hash });
  assert.equal(noVerify.verification_observed, false);
});

test("9. transcript-level error analysis links fix and verification", async () => {
  const sid = `trans-${uniq()}`;
  const tag = uniq();
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "TOOL", text: `ERROR: missing package beta ${tag}` });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: `installing beta to fix the missing package ${tag}` });
  transcript.appendLine({ session_id: sid, role: "TOOL", text: "pytest -q: 1 passed" });
  const r = await analyzeSessionErrors({ session_id: sid, project_id: "p13b" });
  assert.equal(r.errors, 1);
  const rep = await fixEvidenceReport({ project_id: "p13b", limit: 200 });
  assert.ok(rep.items.some((x) => x.session_id === sid));
});

test("close", async () => { await core.close(); });
