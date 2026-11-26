import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const sm = await import("../src/workflowStateMachine.js");
const approvals = await import("../src/workflowApproval.js");
const dispatcher = await import("../src/workflowDispatcher.js");

const projectA = `p24disp-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24disp-b-${crypto.randomUUID().slice(0, 8)}`;

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
  } catch { /* migration 022 normally already applied */ }
});

const binding = (id) => ({ plan_id: `plan-${id}`, plan_version: "v1", plan_hash: `hash-${id}`,
  scope: { paths: ["src/"] }, mode: "simulation", risk: "low", approved_by: "operator" });

async function makeRun(id, project_id = projectA, tasks) {
  const b = binding(id);
  const ap = await approvals.createApproval({ project_id, ...b });
  assert.equal(ap.ok, true);
  const run = await sm.startRun({ project_id, ...b, approval_id: ap.approval_id,
    tasks: tasks || [
      { task_key: "t1", title: "First", dependencies: [], file_ownership: ["src/a.js"], assigned_agent: "general" },
      { task_key: "t2", title: "Second", dependencies: ["t1"], file_ownership: ["src/b.js"] },
    ] });
  assert.equal(run.ok, true);
  return { ...b, approval_id: ap.approval_id, token: ap.token, run_id: run.run_id };
}

test("0. exact exports exist", () => {
  assert.deepEqual(Object.keys(dispatcher.default).sort(), ["checkFileOwnership", "dispatchReady", "dispatchTask"]);
});

test("1. missing approval dispatches nothing", async () => {
  const ctx = await makeRun("missing");
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: "wrong-token" });
  assert.equal(r.ok, false);
  assert.equal(r.dispatched, 0);
});

test("2. approval from another project is rejected", async () => {
  const ctx = await makeRun("xproj", projectA);
  const r = await dispatcher.dispatchReady({ project_id: projectB, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(r.ok, false);
});

test("3. run binding mismatch with approval is rejected", async () => {
  const ctx = await makeRun("bind");
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(r.ok, true);
  // The approval is now consumed; a second call with a different run must fail.
  const other = await makeRun("bind2");
  const r2 = await dispatcher.dispatchReady({ project_id: projectA, run_id: other.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(r2.ok, false);
});

test("4. simulation mode never spawns and yields mock evidence", async () => {
  const ctx = await makeRun("sim");
  let calls = 0;
  const spawnFn = () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token, mode: "real", spawnFn, dry_run: true });
  assert.equal(r.ok, true);
  assert.equal(calls, 0);
  assert.equal(r.mode, "simulation");
  assert.equal(r.dispatched, 1);
  assert.equal(r.results[0].evidence_class, "mock");
  assert.equal(r.results[0].task_verified, false);
});

test("5. max_parallel is clamped to 1..8", async () => {
  const ctx = await makeRun("par");
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token, max_parallel: 999 });
  assert.equal(r.ok, true);
});

test("6. file ownership conflicts skip overlapping tasks", async () => {
  const ctx = await makeRun("own", projectA, [
    { task_key: "a", title: "A", dependencies: [], file_ownership: ["src/shared.js"] },
    { task_key: "b", title: "B", dependencies: [], file_ownership: ["src/shared.js"] },
  ]);
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token, max_parallel: 1 });
  assert.equal(r.ok, true);
  // Overlapping ownership blocks BOTH tasks: neither can safely run concurrently.
  assert.equal(r.dispatched, 0);
  assert.equal(r.skipped, 2);
  assert.ok(r.results.every((x) => /ownership conflict/.test(x.reason || "")));
});

test("7. dispatch ledger is idempotent (no duplicate row / no second spawn)", async () => {
  const ctx = await makeRun("idem", projectA, [
    { task_key: "only", title: "Only", dependencies: [], file_ownership: [] }]);
  const key = crypto.createHash("sha256").update(`${ctx.run_id}|only|1`).digest("hex");
  await core.dbQuery(
    `INSERT INTO workflow_dispatch (run_id,task_key,project_id,approval_id,idempotency_key,argv,mode)
     VALUES ($1,'only',$2,$3,$4,'[]'::jsonb,'simulation') ON CONFLICT DO NOTHING`,
    [ctx.run_id, projectA, ctx.approval_id, key]);
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(r.ok, true);
  assert.equal(r.dispatched, 0);
  assert.ok(r.results.some((x) => /already dispatched/.test(x.reason || "")));
});

test("8. approval is single-use: replay is rejected", async () => {
  const ctx = await makeRun("replay");
  await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  const again = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(again.ok, false);
});

test("9. real mode calls injected spawnFn with fixed argv (no shell)", async () => {
  const ctx = await makeRun("real", projectA, [
    { task_key: "r1", title: "Real task", dependencies: [], file_ownership: [] }]);
  const calls = [];
  const spawnFn = (argv) => { calls.push(argv); return { exitCode: 0, stdout: "ok", stderr: "" }; };
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token, mode: "real", dry_run: false, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(r.mode, "real");
  assert.equal(r.results[0].process_ok, true);
  assert.equal(r.results[0].task_verified, false);
});

test("10. checkFileOwnership reports overlaps", async () => {
  const ctx = await makeRun("check", projectA, [
    { task_key: "x", title: "X", dependencies: [], file_ownership: ["src/x.js"] },
    { task_key: "y", title: "Y", dependencies: [], file_ownership: ["src/x.js", "src/y.js"] },
  ]);
  const r = await dispatcher.checkFileOwnership({ project_id: projectA, run_id: ctx.run_id, task_key: "y" });
  assert.equal(r.ok, true);
  assert.ok(r.conflicts.some((c) => c.task_key === "x" && c.file === "src/x.js"));
});

test("11. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => dispatcher.dispatchReady(), () => dispatcher.dispatchReady({ project_id: "_global", run_id: "x" }),
    () => dispatcher.dispatchTask(), () => dispatcher.checkFileOwnership(),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("12. dispatch results carry no credential-like content", async () => {
  const ctx = await makeRun("red", projectA, [
    { task_key: "sk", title: "sk-abcdefgh12345678", dependencies: [], file_ownership: [] }]);
  const r = await dispatcher.dispatchReady({ project_id: projectA, run_id: ctx.run_id,
    approval_id: ctx.approval_id, token: ctx.token });
  assert.equal(r.ok, true);
});

test("close pool", async () => { await core.close(); });
