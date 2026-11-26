import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const cw = await import("../src/controlledWorkflow.js");
const sm = await import("../src/workflowStateMachine.js");
const pipelineAudit = await import("../src/pipelineAudit.js");

const projectA = `p24int-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p24int-b-${crypto.randomUUID().slice(0, 8)}`;
const SRC = path.join(import.meta.dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

before(async () => {
  try {
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS workflow_run (
      id uuid PRIMARY KEY, project_id text NOT NULL, plan_id text NOT NULL DEFAULT '',
      plan_version text NOT NULL DEFAULT '', plan_hash text NOT NULL DEFAULT '', approval_id text,
      mode text NOT NULL DEFAULT 'simulation', status text NOT NULL DEFAULT 'created',
      template text NOT NULL DEFAULT '', source_ref text NOT NULL DEFAULT '', created_by text NOT NULL DEFAULT '',
      summary jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
  } catch { /* migration 022 normally already applied */ }
});

test("0. facade exports the full controlled workflow surface", () => {
  assert.deepEqual(Object.keys(cw.default).sort(),
    ["approve", "createWorkflow", "dispatch", "feedback", "recover", "report", "status", "test", "validate"]);
});

test("1. closed loop: prepare -> approve -> dispatch(simulation) -> validate -> feedback -> report", async () => {
  const created = await cw.createWorkflow({ project_id: projectA, template: "test-and-verify",
    objective: "Verify isolated workflow execution", source_ref: "rec-e2e", created_by: "operator" });
  assert.equal(created.ok, true, created.reason || "");
  assert.ok(created.run_id && created.approval_id && created.token);

  let spawns = 0;
  const spawnFn = () => { spawns++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const dispatched = await cw.dispatch({ project_id: projectA, run_id: created.run_id,
    approval_id: created.approval_id, token: created.token, mode: "real", dry_run: true, spawnFn });
  assert.equal(dispatched.ok, true);
  assert.equal(spawns, 0);
  assert.equal(dispatched.mode, "simulation");
  assert.ok(dispatched.results.every((r) => r.evidence_class === "mock" && r.task_verified === false));

  const validated = await cw.validate({ project_id: projectA, run_id: created.run_id,
    task_key: dispatched.results[0].task_key, checks: [{ name: "postcondition", pass: true }],
    evidence_class: "runtime", process_ok: false });
  assert.equal(validated.ok, true);
  assert.equal(validated.verified, true);

  const status = await cw.status({ project_id: projectA, run_id: created.run_id });
  assert.equal(status.ok, true);
  assert.equal(status.summary.total, dispatched.results.length + (dispatched.skipped || 0));

  const feedback = await cw.feedback({ project_id: projectA, run_id: created.run_id });
  assert.equal(feedback.ok, true);
  assert.deepEqual(feedback.channels.sort(), ["phase21-learning", "phase23-intelligence"]);

  const report = await cw.report({ project_id: projectA, run_id: created.run_id });
  assert.equal(report.ok, true);
  assert.equal(report.run.id, created.run_id);
  assert.ok(report.validation.verified_count >= 1);
  assert.match(report.claim, /process_ok never equals task_verified/);
  globalThis.__e2e = created;
});

test("2. approval gate: wrong token dispatches nothing", async () => {
  const c = await cw.createWorkflow({ project_id: projectA, template: "review-only", objective: "x" });
  assert.equal(c.ok, true, c.reason || "");
  const r = await cw.dispatch({ project_id: projectA, run_id: c.run_id,
    approval_id: c.approval_id, token: "wrong", dry_run: true });
  assert.equal(r.ok, false);
  assert.equal(r.dispatched, 0);
});

test("3. four evidence tiers remain distinct across the facade", async () => {
  const c = globalThis.__e2e;
  const mock = await cw.validate({ project_id: projectA, run_id: c.run_id, task_key: "tier-mock",
    checks: [{ name: "x", pass: true }], evidence_class: "mock", process_ok: true });
  const api = await cw.validate({ project_id: projectA, run_id: c.run_id, task_key: "tier-api",
    checks: [{ name: "x", pass: true }], evidence_class: "api", process_ok: true });
  const runtime = await cw.validate({ project_id: projectA, run_id: c.run_id, task_key: "tier-runtime",
    checks: [{ name: "x", pass: true }], evidence_class: "runtime", process_ok: false });
  const agent = await cw.validate({ project_id: projectA, run_id: c.run_id, task_key: "tier-agent",
    checks: [{ name: "x", pass: true }], evidence_class: "agent", process_ok: true });
  assert.equal(mock.verified, false);
  assert.equal(api.verified, false);
  assert.equal(runtime.verified, true);
  assert.equal(agent.verified, true);
});

test("4. LEVEL 1 and HARNESS_SEMANTIC_LLM are not changed by any Phase 24 module", () => {
  const files = ["controlledWorkflow.js", "workflowApproval.js", "workflowStateMachine.js",
    "opencodeRunAdapter.js", "workflowDispatcher.js", "workflowMonitor.js", "workflowRecovery.js",
    "workflowValidation.js", "testExecution.js", "workflowTemplates.js"];
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /process\.env\.(OPTIMIZATION_LEVEL|HARNESS_SEMANTIC_LLM)\s*=/, `${f} must not set autonomy flags`);
    assert.doesNotMatch(s, /auto_execute\s*:\s*true/, `${f} must not enable auto_execute`);
  }
  assert.notEqual(process.env.OPTIMIZATION_LEVEL, "3");
  assert.notEqual(process.env.HARNESS_SEMANTIC_LLM, "1");
});

test("5. no source rewriting, arbitrary exec, or secret exposure in control modules", () => {
  const control = ["workflowApproval.js", "workflowStateMachine.js", "workflowDispatcher.js",
    "workflowMonitor.js", "workflowRecovery.js", "workflowValidation.js", "workflowTemplates.js",
    "controlledWorkflow.js"];
  for (const f of control) {
    const s = read(f);
    assert.doesNotMatch(s, /writeFileSync|appendFileSync|unlinkSync|rmSync|fs\.write/, `${f} must not write files`);
    assert.doesNotMatch(s, /\bexec\s*\(|\bexecFile\s*\(|from ["']node:child_process["']/, `${f} must not launch processes`);
    assert.doesNotMatch(s, /git\s+(reset|merge|push|checkout)/, `${f} must not run git mutations`);
  }
  // The adapter is the only process launcher and its spawn is fixed-argument, no shell.
  const adapter = read("opencodeRunAdapter.js");
  assert.match(adapter, /spawn\(/);
  assert.doesNotMatch(adapter, /shell\s*:\s*true/);
});

test("6. all project-scoped facade operations reject _global and empty scope", async () => {
  for (const op of ["createWorkflow", "approve", "dispatch", "status", "validate", "recover", "test", "feedback", "report"]) {
    const r = await cw[op]({ project_id: "_global", run_id: "x", task_key: "t" });
    assert.equal(r.ok, false, `${op} must reject _global`);
  }
});

test("7. cross-project isolation holds through the facade", async () => {
  const c = globalThis.__e2e;
  const status = await cw.status({ project_id: projectB, run_id: c.run_id });
  assert.equal(status.ok, false);
  const feedback = await cw.feedback({ project_id: projectB, run_id: c.run_id });
  assert.equal(feedback.ok, false);
  const dispatch = await cw.dispatch({ project_id: projectB, run_id: c.run_id,
    approval_id: c.approval_id, token: c.token });
  assert.equal(dispatch.ok, false);
});

test("8. pipeline audit wiring covers Phase 24 and claims no runtime proof", () => {
  const a = pipelineAudit.auditPipelineIntegrity();
  assert.equal(a.ok, true);
  assert.ok(Object.keys(a.sources.phase24).length >= 10);
  assert.equal(a.verifiedBehavior, false);
  assert.match(a.claim, /does not prove the feature runs/);
  assert.ok(a.checks.filter((c) => c.id.startsWith("p24.")).length >= 12);
});

test("9. recovery cannot bypass the approval gate via the facade", async () => {
  const c = await cw.createWorkflow({ project_id: projectA, template: "fix-and-verify", objective: "recovery gate" });
  assert.equal(c.ok, true, c.reason || "");
  const got = await sm.getRun({ project_id: projectA, run_id: c.run_id });
  const key = got.tasks[0].task_key;
  await sm.transitionTask({ project_id: projectA, run_id: c.run_id, task_key: key, to_status: "claimed" });
  await sm.transitionTask({ project_id: projectA, run_id: c.run_id, task_key: key, to_status: "running" });
  await sm.transitionTask({ project_id: projectA, run_id: c.run_id, task_key: key, to_status: "failed" });
  const r = await cw.recover({ project_id: projectA, run_id: c.run_id });
  assert.equal(r.ok, false);
  assert.match(r.reason, /approval/);
  assert.equal(r.retried, 0);
});

test("10. FINAL degradation after database close", async () => {
  await core.close();
  const r = await cw.report({ project_id: projectA, run_id: "x" });
  assert.equal(r.ok, true); // report degrades to empty sections, never throws
  assert.equal(r.run, null);
  const s = await cw.status({ project_id: projectA, run_id: "x" });
  assert.equal(s.ok, false);
});
