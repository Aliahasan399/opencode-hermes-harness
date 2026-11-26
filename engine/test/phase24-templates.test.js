import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const templates = await import("../src/workflowTemplates.js");
const sm = await import("../src/workflowStateMachine.js");
const validation = await import("../src/workflowValidation.js");

const projectA = `p24tpl-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24tpl-b-${crypto.randomUUID().slice(0, 8)}`;

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
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_feedback (
      id bigserial PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, channel text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'recorded',
      created_at timestamptz NOT NULL DEFAULT now())`);
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_verification (
      id bigserial PRIMARY KEY, run_id text NOT NULL, task_id text NOT NULL DEFAULT '', task_key text NOT NULL DEFAULT '',
      project_id text NOT NULL, checks jsonb NOT NULL DEFAULT '[]'::jsonb, verified boolean NOT NULL DEFAULT false,
      claims jsonb NOT NULL DEFAULT '[]'::jsonb, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
  } catch { /* migration 022 normally already applied */ }
});

test("0. exact exports exist", () => {
  assert.deepEqual(Object.keys(templates.default).sort(), ["createWorkflow", "feedbackLoop", "listTemplates"]);
});

test("1. template catalog has four simulation-default templates", async () => {
  const r = await templates.listTemplates();
  assert.equal(r.ok, true);
  assert.equal(r.templates.length, 4);
  assert.ok(r.templates.every((t) => t.default_mode === "simulation"));
  assert.deepEqual(r.templates.map((t) => t.id).sort(),
    ["analyze-and-report", "fix-and-verify", "review-only", "test-and-verify"]);
  assert.match(r.note, /no dispatch/);
});

test("2. unknown template is rejected", async () => {
  const r = await templates.createWorkflow({ project_id: projectA, template: "nope", objective: "x" });
  assert.equal(r.ok, false);
});

test("3. createWorkflow prepares plan, approval and run with no dispatch", async () => {
  const r = await templates.createWorkflow({ project_id: projectA, template: "review-only",
    objective: "Review the authentication module", source_ref: "rec-123", created_by: "operator" });
  assert.equal(r.ok, true, r.reason || "");
  assert.ok(r.plan_id);
  assert.ok(r.approval_id);
  assert.ok(r.token);
  assert.ok(r.run_id);
  assert.equal(r.mode || "simulation", "simulation");
  assert.match(r.note, /No agent was dispatched/);
  globalThis.__wf = r;
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.ok, true);
  assert.ok(got.tasks.every((t) => t.status === "pending"));
});

test("4. binding fields are consistent across plan, approval and run", async () => {
  const r = globalThis.__wf;
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.run.plan_id, r.plan_id);
  assert.equal(got.run.plan_version, r.plan_version);
  assert.equal(got.run.plan_hash, r.plan_hash);
  assert.equal(got.run.approval_id, r.approval_id);
  assert.equal(got.run.source_ref, "rec-123");
  assert.equal(got.run.mode, "simulation");
});

test("5. source_ref linkage is auditable", async () => {
  const r = globalThis.__wf;
  const got = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(got.run.source_ref, "rec-123");
});

test("6. createWorkflow is project-scoped", async () => {
  const r = await templates.createWorkflow({ project_id: projectB, template: "review-only", objective: "x" });
  assert.equal(r.ok, true, r.reason || "");
  const cross = await sm.getRun({ project_id: projectA, run_id: r.run_id });
  assert.equal(cross.ok, false);
});

test("7. invalid mode is rejected / defaulted to simulation", async () => {
  const r = await templates.createWorkflow({ project_id: projectA, template: "test-and-verify",
    objective: "x", mode: "bogus" });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.mode || "simulation", "simulation");
});

test("8. feedbackLoop records both channels", async () => {
  const r = globalThis.__wf;
  await validation.validateTask({ project_id: projectA, run_id: r.run_id, task_key: "t1",
    checks: [{ name: "postcondition", pass: true }], evidence_class: "runtime" });
  const fb = await templates.feedbackLoop({ project_id: projectA, run_id: r.run_id });
  assert.equal(fb.ok, true);
  assert.deepEqual(fb.channels.sort(), ["phase21-learning", "phase23-intelligence"]);
  assert.equal(fb.recorded, 2);
  assert.match(fb.note, /Record-only/);
  const rows = (await core.dbQuery(
    "SELECT channel,payload FROM workflow_feedback WHERE project_id=$1 AND run_id=$2",
    [projectA, r.run_id])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.some((x) => x.payload && x.payload.total >= 1));
});

test("9. feedback does not mutate source or recommendation status", async () => {
  const before = fs.readFileSync(new URL("../src/workflowTemplates.js", import.meta.url), "utf8");
  const r = globalThis.__wf;
  await templates.feedbackLoop({ project_id: projectA, run_id: r.run_id });
  const after = fs.readFileSync(new URL("../src/workflowTemplates.js", import.meta.url), "utf8");
  assert.equal(before, after);
  const rec = (await core.dbQuery(
    "SELECT status FROM workflow_feedback WHERE project_id=$1 AND run_id=$2 LIMIT 1",
    [projectA, r.run_id])).rows[0];
  assert.equal(rec.status, "recorded");
});

test("10. feedbackLoop is project-scoped", async () => {
  const r = globalThis.__wf;
  const fb = await templates.feedbackLoop({ project_id: projectB, run_id: r.run_id });
  assert.equal(fb.ok, false);
});

test("11. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => templates.createWorkflow(), () => templates.createWorkflow({ project_id: "_global", template: "review-only" }),
    () => templates.feedbackLoop(), () => templates.feedbackLoop({ project_id: projectA }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

test("12. prepared task count is bounded", async () => {
  const r = await templates.createWorkflow({ project_id: projectA, template: "test-and-verify", objective: "x" });
  assert.equal(r.ok, true, r.reason || "");
  assert.ok(r.tasks.length <= 30);
});

test("close pool", async () => { await core.close(); });
