// Phase 24 facade: controlled, approval-gated workflow execution and closed-loop
// engineering. Composes Phase 22 planning and Phase 23 intelligence with an
// execution adapter; it does NOT add a persistent agent runtime. LEVEL 1 is
// preserved: the default mode is 'simulation' and no process is ever spawned
// without an explicit, single-use, scope-bound approval. All capabilities are
// optional dynamic imports and degrade independently.
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);

/**
 * Prepare a workflow: plan (Phase 22) + approval artifact + durable run. No dispatch.
 */
export async function createWorkflow({ project_id, template, objective, scope, risk, mode,
  source_ref, created_by, plan_id, plan_version, plan_hash } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const templates = await load("workflowTemplates");
  if (!templates?.createWorkflow) return { ok: false, reason: "workflowTemplates unavailable", degraded };
  try {
    const r = await templates.createWorkflow({ project_id, template, objective, scope, risk, mode,
      source_ref, created_by, plan_id, plan_version, plan_hash });
    if (Array.isArray(r?.degraded)) degraded.push(...r.degraded);
    try {
      await core.audit("workflow.create", project_id, { template: template || null,
        mode: mode || "simulation", risk: risk || null, source_ref: source_ref || null,
        ok: !!r?.ok, plan_id: r?.plan_id || null, run_id: r?.run_id || null });
    } catch { /* best effort */ }
    return { ...r, degraded };
  } catch (e) { return { ok: false, reason: `createWorkflow: ${short(e?.message || e, 120)}`, degraded }; }
}

/** Create an approval for an existing plan (explicit operator action). */
export async function approve({ project_id, plan_id, plan_version, plan_hash, scope, mode, risk,
  approved_by, expires_in_ms, request } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const approval = await load("workflowApproval");
  if (!approval?.createApproval) return { ok: false, reason: "workflowApproval unavailable" };
  const r = await approval.createApproval({ project_id, plan_id, plan_version, plan_hash, scope, mode, risk,
    approved_by, expires_in_ms, request });
  try { await core.audit("workflow.approve.create", project_id, { plan_id: plan_id || null,
    mode: mode || "simulation", risk: risk || null, ok: !!r?.ok }); } catch { /* best effort */ }
  return r;
}

/**
 * Dispatch dependency-ready, ownership-safe tasks. Requires the one-time token.
 * No process is spawned in simulation mode (the default).
 */
export async function dispatch({ project_id, run_id, approval_id, token, mode, max_parallel,
  dry_run, spawnFn, timeout_ms } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const dispatcher = await load("workflowDispatcher");
  if (!dispatcher?.dispatchReady) return { ok: false, reason: "workflowDispatcher unavailable" };
  const r = await dispatcher.dispatchReady({ project_id, run_id, approval_id, token, mode,
    max_parallel, dry_run, spawnFn, timeout_ms });
  try { await core.audit("workflow.dispatch", project_id, { run_id: run_id || null,
    mode: mode || "simulation", dry_run: dry_run !== false, ok: !!r?.ok,
    dispatched: r?.dispatched || 0, skipped: r?.skipped || 0 }); } catch { /* best effort */ }
  return r;
}

/** Bounded monitoring of a run (read-only). */
export async function status({ project_id, run_id, limit } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const monitor = await load("workflowMonitor");
  if (!monitor?.monitorRun) return { ok: false, reason: "workflowMonitor unavailable" };
  return monitor.monitorRun({ project_id, run_id, limit });
}

/** Evidence-based validation. process_ok alone can never set task_verified. */
export async function validate({ project_id, run_id, task_key, checks, evidence_class,
  process_ok, evidence_refs } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const validation = await load("workflowValidation");
  if (!validation?.validateTask) return { ok: false, reason: "workflowValidation unavailable" };
  const r = await validation.validateTask({ project_id, run_id, task_key, checks, evidence_class,
    process_ok, evidence_refs });
  try { await core.audit("workflow.validate", project_id, { run_id: run_id || null,
    task_key: task_key || null, verified: !!r?.verified }); } catch { /* best effort */ }
  return r;
}

/** Controlled, bounded retry/recovery. Requires an approval; never bypasses the gate. */
export async function recover({ project_id, run_id, approval_id, token, max_attempts,
  dry_run, spawnFn } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const recovery = await load("workflowRecovery");
  if (!recovery?.recoverRun) return { ok: false, reason: "workflowRecovery unavailable" };
  const r = await recovery.recoverRun({ project_id, run_id, approval_id, token, max_attempts, dry_run, spawnFn });
  try { await core.audit("workflow.recover", project_id, { run_id: run_id || null,
    ok: !!r?.ok, retried: r?.retried || 0 }); } catch { /* best effort */ }
  return r;
}

/** Run bounded tests against an isolated DB (evidence, not post-condition validation). */
export async function test({ project_id, run_id, task_key, mode, test_command, dry_run,
  db_name, spawnFn } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const te = await load("testExecution");
  if (!te?.runTests) return { ok: false, reason: "testExecution unavailable" };
  return te.runTests({ project_id, run_id, task_key, mode, test_command, dry_run, db_name, spawnFn });
}

/** Closed-loop feedback into Phase 21 learning / Phase 23 intelligence (record only). */
export async function feedback({ project_id, run_id } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const templates = await load("workflowTemplates");
  if (!templates?.feedbackLoop) return { ok: false, reason: "workflowTemplates unavailable" };
  return templates.feedbackLoop({ project_id, run_id });
}

/** Bounded unified report. Explicitly states wiring != runtime proof. */
export async function report({ project_id, run_id, limit } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const [statusMod, valMod, monitorMod] = await Promise.all([
    load("workflowStateMachine"), load("workflowValidation"), load("workflowMonitor")]);
  let run = null;
  try { if (statusMod?.getRun) run = await statusMod.getRun({ project_id, run_id }); }
  catch (e) { degraded.push(`run: ${short(e?.message || e, 80)}`); }
  let validation = null;
  try { if (valMod?.validateRun) validation = await valMod.validateRun({ project_id, run_id }); }
  catch (e) { degraded.push(`validation: ${short(e?.message || e, 80)}`); }
  let health = null;
  try { if (monitorMod?.workflowHealth) health = await monitorMod.workflowHealth({ project_id }); }
  catch (e) { degraded.push(`health: ${short(e?.message || e, 80)}`); }
  return { ok: true, project_id, run_id: run_id || null,
    run: run?.run || null, tasks: run?.tasks || [], validation, health, degraded,
    claim: "Evidence-tiered: wiring/report presence is not runtime proof. process_ok never equals task_verified.",
    note: "LEVEL 1: simulation by default; real dispatch requires explicit single-use approval." };
}

export default { createWorkflow, approve, dispatch, status, validate, recover, test, feedback, report };
