import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const validation = await import("../src/workflowValidation.js");
const te = await import("../src/testExecution.js");

const projectA = `p24val-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24val-b-${crypto.randomUUID().slice(0, 8)}`;
const run_id = `run-${crypto.randomUUID().slice(0, 8)}`;

before(async () => {
  try {
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_verification (
      id bigserial PRIMARY KEY, run_id text NOT NULL, task_id text NOT NULL DEFAULT '', task_key text NOT NULL DEFAULT '',
      project_id text NOT NULL, checks jsonb NOT NULL DEFAULT '[]'::jsonb, verified boolean NOT NULL DEFAULT false,
      claims jsonb NOT NULL DEFAULT '[]'::jsonb, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
  } catch { /* migration 022 normally already applied */ }
});

const okChecks = [{ name: "file exists", pass: true }, { name: "test passes", pass: true }];

test("0. exact exports exist", () => {
  assert.deepEqual(Object.keys(validation.default).sort(), ["assertNoOverclaim", "validateRun", "validateTask"]);
  assert.deepEqual(Object.keys(te.default).sort(), ["runTests", "testExecutionStatus"]);
});

test("1. verified true only with passing checks AND eligible evidence", async () => {
  const r = await validation.validateTask({ project_id: projectA, run_id, task_key: "t1",
    checks: okChecks, evidence_class: "runtime", process_ok: true });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.reason, "postconditions_passed_with_eligible_evidence");
});

test("2. process_ok alone never verifies", async () => {
  const r = await validation.validateTask({ project_id: projectA, run_id, task_key: "t2",
    checks: okChecks, evidence_class: "api", process_ok: true });
  assert.equal(r.verified, false);
  assert.equal(r.reason, "evidence_class_not_eligible");
});

test("3. mock evidence never verifies", async () => {
  const r = await validation.validateTask({ project_id: projectA, run_id, task_key: "t3",
    checks: okChecks, evidence_class: "mock" });
  assert.equal(r.verified, false);
});

test("4. failing or empty checks do not verify", async () => {
  const fail = await validation.validateTask({ project_id: projectA, run_id, task_key: "t4",
    checks: [{ name: "x", pass: false }], evidence_class: "agent" });
  assert.equal(fail.verified, false);
  assert.equal(fail.reason, "checks_missing_or_failing");
  const empty = await validation.validateTask({ project_id: projectA, run_id, task_key: "t5",
    checks: [], evidence_class: "agent" });
  assert.equal(empty.verified, false);
});

test("5. agent evidence with passes verifies", async () => {
  const r = await validation.validateTask({ project_id: projectA, run_id, task_key: "t6",
    checks: okChecks, evidence_class: "agent" });
  assert.equal(r.verified, true);
});

test("6. overclaim language is flagged and stripped", () => {
  const r = validation.assertNoOverclaim({ text: "This is 100% guaranteed and fixes CVE-2024-1234 always." });
  assert.equal(r.ok, false);
  assert.ok(r.flagged.length >= 3);
  assert.doesNotMatch(r.cleaned, /100%|guaranteed|CVE-2024-1234|always/);
});

test("7. validateRun aggregates persisted verifications", async () => {
  const r = await validation.validateRun({ project_id: projectA, run_id, limit: 50 });
  assert.equal(r.ok, true);
  assert.ok(r.total >= 5);
  assert.ok(r.verified_count >= 2);
  assert.match(r.note, /insufficient evidence/);
});

test("8. validateRun is project-scoped", async () => {
  const r = await validation.validateRun({ project_id: projectB, run_id });
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
});

test("9. runTests refuses a non-isolated database", async () => {
  const r = await te.runTests({ project_id: projectA, run_id, task_key: "t1",
    mode: "real", dry_run: false, db_name: "opencode_memory", test_command: "node --test" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-isolated/);
});

test("10. simulation never spawns and yields mock evidence", async () => {
  let calls = 0;
  const spawnFn = () => { calls++; return { stdout: "", stderr: "", on() {} }; };
  const r = await te.runTests({ project_id: projectA, run_id, task_key: "t1",
    mode: "real", dry_run: true, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(calls, 0);
  assert.equal(r.evidence_class, "mock");
  assert.equal(r.task_verified, false);
});

test("11. real mode on isolated DB parses counts deterministically", async () => {
  const spawnFn = (_bin, _args, opts) => ({
    stdout: { on(ev, cb) { if (ev === "data") cb("ℹ tests 42\nℹ pass 41\nℹ fail 1\n"); } },
    stderr: { on() {} },
    on(ev, cb) { if (ev === "close") setImmediate(() => cb(1)); },
  });
  const r = await te.runTests({ project_id: projectA, run_id, task_key: "t1",
    mode: "real", dry_run: false, db_name: "opencode_memory_test",
    test_command: "node --test test/foo.test.js", spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.evidence_class, "runtime");
  assert.equal(r.total, 42);
  assert.equal(r.pass, 41);
  assert.equal(r.fail, 1);
  assert.equal(r.process_ok, false);
  assert.equal(r.task_verified, false);
});

test("12. test command rejects shell metacharacters", async () => {
  const r = await te.runTests({ project_id: projectA, run_id, task_key: "t1",
    mode: "real", dry_run: false, test_command: "node --test; rm -rf /", spawnFn: () => ({ on() {} }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /shell metacharacters/);
});

test("13. test output credentials are redacted", async () => {
  const spawnFn = () => ({
    stdout: { on(ev, cb) { if (ev === "data") cb("tests 1\npass 1\ntoken sk-abcdefgh12345678\n"); } },
    stderr: { on() {} },
    on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); },
  });
  const r = await te.runTests({ project_id: projectA, run_id, task_key: "t1",
    mode: "real", dry_run: false, test_command: "node --test", spawnFn });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.output_redacted, /sk-abcdefgh12345678/);
});

test("14. testExecutionStatus is bounded and project-scoped", async () => {
  const r = await te.testExecutionStatus({ project_id: projectA, limit: 9999 });
  assert.equal(r.ok, true);
  assert.ok(r.items.length <= 100);
  const b = await te.testExecutionStatus({ project_id: "_global" });
  assert.equal(b.ok, false);
});

test("15. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => validation.validateTask(), () => validation.validateTask({ project_id: "_global", run_id, task_key: "x" }),
    () => validation.validateRun(), () => te.runTests(), () => te.runTests({ project_id: "_global" }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("16. validation evidence refs are redacted", async () => {
  const r = await validation.validateTask({ project_id: projectA, run_id, task_key: "t7",
    checks: okChecks, evidence_class: "runtime", evidence_refs: ["sk-abcdefgh12345678"] });
  assert.equal(r.ok, true);
  const blob = JSON.stringify(r);
  assert.doesNotMatch(blob, /sk-abcdefgh12345678/);
});

test("close pool", async () => { await core.close(); });
