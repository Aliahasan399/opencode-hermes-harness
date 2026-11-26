import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const sm = await import("../src/workflowStateMachine.js");

const projectA = `p24sm-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24sm-b-${crypto.randomUUID().slice(0, 8)}`;

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
  } catch { /* migration 022 normally already applied */ }
});

const base = (over = {}) => ({ project_id: projectA, plan_id: "plan-1", plan_version: "v1",
  plan_hash: "abc123", approval_id: "appr-1", mode: "simulation",
  tasks: [
    { task_key: "t1", title: "First", dependencies: [], file_ownership: ["src/a.js"] },
    { task_key: "t2", title: "Second", dependencies: ["t1"], file_ownership: ["src/b.js"] },
    { task_key: "t3", title: "Third", dependencies: ["t1"], file_ownership: ["src/c.js"] },
  ], ...over });

test("0. exact exports exist", () => {
  assert.deepEqual(Object.keys(sm.default).sort(),
    ["getReadyTasks", "getRun", "listRuns", "startRun", "transitionTask"]);
});

test("1. startRun creates a run and pending tasks", async () => {
  const r = await sm.startRun(base());
  assert.equal(r.ok, true);
  assert.ok(r.run_id);
  assert.equal(r.duplicate, false);
  assert.equal(r.tasks.length, 3);
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.ok, true);
  assert.equal(got.tasks.length, 3);
  assert.ok(got.tasks.every((t) => t.status === "pending"));
  globalThis.__r1 = r.run_id;
});

test("2. idempotent startRun returns the same run without duplicating tasks", async () => {
  const r = await sm.startRun(base());
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(r.run_id, globalThis.__r1);
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.tasks.length, 3);
});

test("3. task metadata is persisted as jsonb", async () => {
  const got = await sm.getRun({ project_id: projectA, run_id: globalThis.__r1 });
  const t2 = got.tasks.find((t) => t.task_key === "t2");
  assert.deepEqual(t2.dependencies, ["t1"]);
  assert.deepEqual(t2.file_ownership, ["src/b.js"]);
});

test("4. legal transition chain pending->claimed->running->verifying->done", async () => {
  const chain = ["claimed", "running", "verifying", "done"];
  for (const to of chain) {
    const r = await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t1", to_status: to });
    assert.equal(r.ok, true, `${to} should be legal`);
    assert.equal(r.changed, true);
  }
  const got = await sm.getRun({ project_id: projectA, run_id: globalThis.__r1 });
  assert.equal(got.tasks.find((t) => t.task_key === "t1").status, "done");
  assert.equal(got.tasks.find((t) => t.task_key === "t1").attempts, 1);
});

test("5. illegal transitions are rejected without throwing", async () => {
  const bad = await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "done" });
  assert.equal(bad.ok, false);
  assert.equal(bad.changed, false);
  assert.match(bad.reason, /illegal/);
  const unknown = await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "bogus" });
  assert.equal(unknown.ok, false);
  const same = await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t1", to_status: "done" });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
});

test("6. failed->pending retry is legal", async () => {
  await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "claimed" });
  await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "running" });
  await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "failed" });
  const retry = await sm.transitionTask({ project_id: projectA, run_id: globalThis.__r1, task_key: "t2", to_status: "pending" });
  assert.equal(retry.ok, true);
});

test("7. getReadyTasks respects dependencies", async () => {
  const r = await sm.startRun(base({ plan_id: "plan-ready", plan_hash: "ready1" }));
  const ready = await sm.getReadyTasks({ project_id: projectA, run_id: r.run_id });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.items.map((t) => t.task_key), ["t1"]);
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "t1", to_status: "claimed" });
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "t1", to_status: "running" });
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "t1", to_status: "verifying" });
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "t1", to_status: "done" });
  const ready2 = await sm.getReadyTasks({ project_id: projectA, run_id: r.run_id });
  assert.deepEqual(ready2.items.map((t) => t.task_key), ["t2", "t3"]);
});

test("8. run status rolls up to done when all tasks terminal", async () => {
  const r = await sm.startRun(base({ plan_id: "plan-rollup", plan_hash: "rollup1",
    tasks: [{ task_key: "only", title: "Only", dependencies: [] }] }));
  for (const to of ["claimed", "running", "verifying", "done"]) {
    await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "only", to_status: to });
  }
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.run.status, "done");
});

test("9. project isolation: project B cannot read or mutate project A run", async () => {
  const got = await sm.getRun({ project_id: projectB, run_id: globalThis.__r1 });
  assert.equal(got.ok, false);
  const t = await sm.transitionTask({ project_id: projectB, run_id: globalThis.__r1, task_key: "t1", to_status: "claimed" });
  assert.equal(t.ok, false);
  const b = await sm.startRun(base({ project_id: projectB, plan_id: "plan-b", plan_hash: "bbb" }));
  assert.equal(b.ok, true);
  assert.notEqual(b.run_id, globalThis.__r1);
});

test("10. listRuns is filtered and bounded", async () => {
  const all = await sm.listRuns({ project_id: projectA, limit: 10 });
  assert.equal(all.ok, true);
  assert.ok(all.count <= 10);
  const done = await sm.listRuns({ project_id: projectA, status: "done", limit: 10 });
  assert.ok(done.items.every((r) => r.status === "done"));
  const clamped = await sm.listRuns({ project_id: projectA, limit: 9999 });
  assert.ok(clamped.count <= 200);
});

test("11. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => sm.startRun(), () => sm.startRun({ project_id: "_global" }),
    () => sm.startRun({ project_id: "", plan_id: "x" }),
    () => sm.getRun(), () => sm.getRun({ project_id: projectA }),
    () => sm.listRuns({ project_id: "_global" }), () => sm.getReadyTasks(),
    () => sm.transitionTask({ project_id: projectA, run_id: "x", task_key: "y", to_status: "nope" }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("12. result_ref evidence is bounded and redacted", async () => {
  const r = await sm.startRun(base({ plan_id: "plan-ev", plan_hash: "ev1",
    tasks: [{ task_key: "ev", title: "Evidence", dependencies: [] }] }));
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "ev", to_status: "claimed" });
  await sm.transitionTask({ project_id: projectA, run_id: r.run_id, task_key: "ev", to_status: "running",
    evidence: "sk-abcdefgh12345678 used" });
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  const blob = JSON.stringify(got.tasks[0].result_ref);
  assert.doesNotMatch(blob, /sk-abcdefgh12345678/);
});

test("close pool", async () => { await core.close(); });
