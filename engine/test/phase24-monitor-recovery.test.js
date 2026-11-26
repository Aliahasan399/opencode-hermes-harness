import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const sm = await import("../src/workflowStateMachine.js");
const approvals = await import("../src/workflowApproval.js");
const monitor = await import("../src/workflowMonitor.js");
const recovery = await import("../src/workflowRecovery.js");

const projectA = `p24mon-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24mon-b-${crypto.randomUUID().slice(0, 8)}`;

before(async () => {
  try {
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_run (
      id uuid PRIMARY KEY, project_id text NOT NULL, plan_id text NOT NULL DEFAULT '',
      plan_version text NOT NULL DEFAULT '', plan_hash text NOT NULL DEFAULT '', approval_id text,
      mode text NOT NULL DEFAULT 'simulation', status text NOT NULL DEFAULT 'created',
      template text NOT NULL DEFAULT '', source_ref text NOT NULL DEFAULT '', created_by text NOT NULL DEFAULT '',
      summary jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_task (
      id uuid PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, task_key text NOT NULL,
      title text NOT NULL DEFAULT '', dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
      file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb, assigned_agent text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '', risk text NOT NULL DEFAULT 'low', status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0, result_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, task_key))`);
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_dispatch (
      id bigserial PRIMARY KEY, run_id text NOT NULL, task_id text NOT NULL DEFAULT '', task_key text NOT NULL DEFAULT '',
      project_id text NOT NULL, approval_id text NOT NULL DEFAULT '', idempotency_key text NOT NULL,
      argv jsonb NOT NULL DEFAULT '[]'::jsonb, mode text NOT NULL DEFAULT 'simulation',
      evidence_class text NOT NULL DEFAULT 'mock', process_exit_code integer, process_ok boolean NOT NULL DEFAULT false,
      task_verified boolean NOT NULL DEFAULT false, session_id text, output_ref text NOT NULL DEFAULT '',
      error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id,task_key,idempotency_key))`);
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_verification (
      id bigserial PRIMARY KEY, run_id text NOT NULL, task_id text NOT NULL DEFAULT '', task_key text NOT NULL DEFAULT '',
      project_id text NOT NULL, checks jsonb NOT NULL DEFAULT '[]'::jsonb, verified boolean NOT NULL DEFAULT false,
      claims jsonb NOT NULL DEFAULT '[]'::jsonb, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
  } catch { /* migration 022 normally already applied */ }
});

const binding = (id) => ({ plan_id: `plan-${id}`, plan_version: "v1", plan_hash: `hash-${id}`,
  scope: {}, mode: "simulation", risk: "low", approved_by: "operator" });

async function makeRun(id, project_id = projectA, withFailed = true) {
  const b = binding(id);
  const run = await sm.startRun({ project_id, ...b, approval_id: `appr-${id}`,
    tasks: [{ task_key: "t1", title: "Task 1", dependencies: [], file_ownership: [] },
            { task_key: "t2", title: "Task 2", dependencies: [], file_ownership: [] }] });
  assert.equal(run.ok, true);
  if (withFailed) {
    await sm.transitionTask({ project_id, run_id: run.run_id, task_key: "t1", to_status: "claimed" });
    await sm.transitionTask({ project_id, run_id: run.run_id, task_key: "t1", to_status: "running" });
    await sm.transitionTask({ project_id, run_id: run.run_id, task_key: "t1", to_status: "failed" });
  }
  return { ...b, run_id: run.run_id };
}
async function makeApproval(ctx, project_id = projectA) {
  const ap = await approvals.createApproval({ project_id, ...ctx });
  assert.equal(ap.ok, true);
  return { approval_id: ap.approval_id, token: ap.token };
}

test("0. exact exports exist", () => {
  assert.deepEqual(Object.keys(monitor.default).sort(), ["listStale", "monitorRun", "workflowHealth"]);
  assert.deepEqual(Object.keys(recovery.default).sort(), ["recoverRun", "retryTask"]);
});

test("1. monitorRun summarizes statuses", async () => {
  const ctx = await makeRun("mon1");
  const r = await monitor.monitorRun({ project_id: projectA, run_id: ctx.run_id });
  assert.equal(r.ok, true);
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.pending, 1);
  assert.match(r.note, /Never implies/);
});

test("2. stale detection flags old active tasks", async () => {
  const ctx = await makeRun("stale", projectA, false);
  await sm.transitionTask({ project_id: projectA, run_id: ctx.run_id, task_key: "t1", to_status: "claimed" });
  await core.dbQuery("UPDATE workflow_task SET updated_at=now() - interval '1 hour' WHERE run_id=$1 AND task_key='t1'",
    [ctx.run_id]);
  const r = await monitor.monitorRun({ project_id: projectA, run_id: ctx.run_id, stale_after_ms: 60000 });
  assert.equal(r.ok, true);
  assert.ok(r.stale.some((s) => s.task_key === "t1"));
  const ls = await monitor.listStale({ project_id: projectA, stale_after_ms: 60000, limit: 10 });
  assert.equal(ls.ok, true);
  assert.ok(ls.items.some((x) => x.task_key === "t1"));
});

test("3. listStale is bounded and project-scoped", async () => {
  const r = await monitor.listStale({ project_id: projectA, limit: 9999 });
  assert.equal(r.ok, true);
  assert.ok(r.count <= 200);
  const b = await monitor.listStale({ project_id: projectB, limit: 10 });
  assert.equal(b.ok, true);
  assert.ok(b.items.every((x) => true));
});

test("4. workflowHealth aggregates run/task/verification counts", async () => {
  const r = await monitor.workflowHealth({ project_id: projectA });
  assert.equal(r.ok, true);
  assert.equal(typeof r.runs, "object");
  assert.equal(typeof r.tasks, "object");
  assert.equal(typeof r.stale_count, "number");
  assert.match(r.note, /not task_verified/);
});

test("5. recovery without approval is rejected (no gate bypass)", async () => {
  const ctx = await makeRun("noappr");
  const r = await recovery.recoverRun({ project_id: projectA, run_id: ctx.run_id });
  assert.equal(r.ok, false);
  assert.match(r.reason, /approval/);
  assert.equal(r.retried, 0);
});

test("6. recovery with approval retries a failed task in simulation", async () => {
  const ctx = await makeRun("rec1");
  const ap = await makeApproval(ctx);
  let calls = 0;
  const spawnFn = () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const r = await recovery.recoverRun({ project_id: projectA, run_id: ctx.run_id,
    approvals: [ap], dry_run: true, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.retried, 1);
  assert.equal(calls, 0);
  assert.equal(r.results[0].evidence_class, "mock");
  assert.equal(r.results[0].task_verified, false);
});

test("7. retry budget respects attempts < max_attempts", async () => {
  const ctx = await makeRun("budget");
  // Drive t1 to 2 attempts then fail it.
  for (let i = 0; i < 2; i++) {
    await sm.transitionTask({ project_id: projectA, run_id: ctx.run_id, task_key: "t1", to_status: "pending" });
    await sm.transitionTask({ project_id: projectA, run_id: ctx.run_id, task_key: "t1", to_status: "claimed" });
    await sm.transitionTask({ project_id: projectA, run_id: ctx.run_id, task_key: "t1", to_status: "running" });
    await sm.transitionTask({ project_id: projectA, run_id: ctx.run_id, task_key: "t1", to_status: "failed" });
  }
  const ap = await makeApproval({ ...ctx, plan_id: ctx.plan_id + "-x", plan_hash: ctx.plan_hash + "x" });
  const r = await recovery.recoverRun({ project_id: projectA, run_id: ctx.run_id,
    approvals: [ap], max_attempts: 2, dry_run: true });
  // t1 has 2 attempts so it is excluded by the budget; only t2 (pending) is not a candidate.
  assert.equal(r.ok, true);
  assert.equal(r.retried, 0);
});

test("8. cross-project isolation", async () => {
  const ctx = await makeRun("iso", projectA);
  const ap = await makeApproval(ctx, projectB);
  const r = await recovery.recoverRun({ project_id: projectB, run_id: ctx.run_id, approvals: [ap] });
  assert.equal(r.ok, false); // run not in project B
  const m = await monitor.monitorRun({ project_id: projectB, run_id: ctx.run_id });
  assert.equal(m.ok, false);
});

test("9. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => monitor.monitorRun(), () => monitor.listStale({ project_id: "_global" }),
    () => monitor.workflowHealth(), () => recovery.recoverRun(), () => recovery.retryTask(),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("10. FINAL degradation after database close", async () => {
  await core.close();
  const m = await monitor.workflowHealth({ project_id: projectA });
  assert.equal(m.ok, false);
  assert.match(m.reason, /workflowHealth/);
  const r = await recovery.recoverRun({ project_id: projectA, run_id: "x", approvals: [] });
  assert.equal(r.ok, false);
  assert.equal(r.retried, 0);
});
