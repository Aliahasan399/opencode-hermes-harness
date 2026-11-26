// Phase 24 — dependency-aware, ownership-safe, bounded, idempotent dispatch.
// Verifies and atomically consumes a single-use approval, then dispatches only
// dependency-ready tasks through the opencode run adapter. Default/simulation
// mode never spawns. process_ok from the adapter is NOT task verification.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

/** Detect overlapping file ownership against other non-terminal tasks in a run. */
export async function checkFileOwnership({ project_id, run_id, task_key } = {}) {
  if (!validProject(project_id) || !run_id || !task_key) return { ok: false, reason: "valid scope required", conflicts: [] };
  try {
    const target = (await core.dbQuery(
      "SELECT file_ownership FROM workflow_task WHERE run_id=$1 AND project_id=$2 AND task_key=$3",
      [run_id, project_id, task_key])).rows[0];
    if (!target) return { ok: false, reason: "task not found in project scope", conflicts: [] };
    const mine = new Set((Array.isArray(target.file_ownership) ? target.file_ownership : []).map(String));
    if (!mine.size) return { ok: true, conflicts: [] };
    const others = await core.dbQuery(
      `SELECT task_key,file_ownership FROM workflow_task
         WHERE run_id=$1 AND project_id=$2 AND task_key<>$3 AND status NOT IN ('done','failed','cancelled')`,
      [run_id, project_id, task_key]);
    const conflicts = [];
    for (const o of others.rows) {
      for (const f of (Array.isArray(o.file_ownership) ? o.file_ownership : []).map(String)) {
        if (mine.has(f)) { conflicts.push({ task_key: o.task_key, file: f }); break; }
      }
    }
    return { ok: true, conflicts: conflicts.slice(0, 50) };
  } catch (e) { return { ok: false, reason: `checkFileOwnership: ${short(e?.message || e, 140)}`, conflicts: [] }; }
}

/**
 * Dispatch dependency-ready tasks. Requires a valid one-time approval whose plan
 * binding matches the run. Idempotent via workflow_dispatch's unique ledger key.
 */
export async function dispatchReady({ project_id, run_id, approval_id, token, mode,
  max_parallel, spawnFn, dry_run, only_task, timeout_ms } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required", dispatched: 0, skipped: 0, results: [] };
  const maxP = clamp(max_parallel, 1, 8, 4);
  const results = [];
  let skipped = 0;

  // 1) Load approval binding from scope, then atomically consume it.
  let approvalRow;
  try {
    approvalRow = (await core.dbQuery(
      "SELECT * FROM workflow_approval WHERE id=$1 AND project_id=$2",
      [approval_id, project_id])).rows[0];
  } catch (e) { return { ok: false, reason: `approval lookup: ${short(e?.message || e, 120)}`, dispatched: 0, skipped: 0, results }; }
  if (!approvalRow) return { ok: false, reason: "approval not found in project scope", dispatched: 0, skipped: 0, results };

  // 2) Run binding must match the approved plan binding.
  const sm = await load("workflowStateMachine");
  const approvals = await load("workflowApproval");
  let run;
  try {
    if (!sm?.getRun) return { ok: false, reason: "state machine unavailable", dispatched: 0, skipped: 0, results };
    const gr = await sm.getRun({ project_id, run_id });
    if (!gr.ok) return { ok: false, reason: gr.reason, dispatched: 0, skipped: 0, results };
    run = gr.run;
  } catch (e) { return { ok: false, reason: `run lookup: ${short(e?.message || e, 120)}`, dispatched: 0, skipped: 0, results }; }
  if (String(run.plan_id || "") !== String(approvalRow.plan_id || "") ||
      String(run.plan_version || "") !== String(approvalRow.plan_version || "") ||
      String(run.plan_hash || "") !== String(approvalRow.plan_hash || "")) {
    return { ok: false, reason: "run plan binding does not match approval", dispatched: 0, skipped: 0, results };
  }

  if (!approvals?.consumeApproval) return { ok: false, reason: "approval engine unavailable", dispatched: 0, skipped: 0, results };
  let consumed;
  try {
    consumed = await approvals.consumeApproval({
      project_id, approval_id, token,
      plan_id: approvalRow.plan_id, plan_version: approvalRow.plan_version, plan_hash: approvalRow.plan_hash,
      scope: approvalRow.scope || {}, mode: approvalRow.mode, risk: approvalRow.risk,
    });
  } catch (e) { return { ok: false, reason: `approval consume: ${short(e?.message || e, 120)}`, dispatched: 0, skipped: 0, results }; }
  if (!consumed?.ok) return { ok: false, reason: consumed?.reason || "approval rejected", dispatched: 0, skipped: 0, results };

  // 3) Select ready tasks.
  let ready;
  try { ready = await sm.getReadyTasks({ project_id, run_id, limit: 100 }); }
  catch (e) { return { ok: false, reason: `ready tasks: ${short(e?.message || e, 120)}`, dispatched: 0, skipped: 0, results }; }
  const adapter = await load("opencodeRunAdapter");
  if (!adapter?.buildRunArgs || !adapter?.executeAgentRun) {
    return { ok: false, reason: "run adapter unavailable", dispatched: 0, skipped: 0, results };
  }

  const effectiveMode = dry_run === true ? "simulation" : (mode === "real" ? "real" : "simulation");

  // 4) Bounded-concurrency worker over ready tasks.
  const queue = (ready.items || []).filter((t) => !only_task || t.task_key === only_task).slice();
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const task = queue[cursor++];
      const task_key = task.task_key;
      const ownership = await checkFileOwnership({ project_id, run_id, task_key });
      if (!ownership.ok || ownership.conflicts.length) {
        skipped += 1;
        results.push({ task_key, skipped: true, reason: ownership.conflicts.length ? "file ownership conflict" : (ownership.reason || "ownership check failed") });
        continue;
      }
      const attempts = Number(task.attempts || 0) + 1;
      const idempotency_key = crypto.createHash("sha256")
        .update(`${run_id}|${task_key}|${attempts}`).digest("hex");
      let ledger;
      try {
        ledger = await core.dbQuery(
          `INSERT INTO workflow_dispatch (run_id,task_key,project_id,approval_id,idempotency_key,argv,mode)
           VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6)
           ON CONFLICT (run_id,task_key,idempotency_key) DO NOTHING RETURNING id`,
          [run_id, task_key, project_id, approval_id, idempotency_key, effectiveMode]);
      } catch (e) {
        skipped += 1;
        results.push({ task_key, skipped: true, reason: `ledger: ${short(e?.message || e, 80)}` });
        continue;
      }
      if (!ledger.rowCount) {
        skipped += 1;
        results.push({ task_key, skipped: true, reason: "already dispatched (idempotent)" });
        continue;
      }
      try {
        await sm.transitionTask({ project_id, run_id, task_key, to_status: "claimed" });
        await sm.transitionTask({ project_id, run_id, task_key, to_status: "running" });
      } catch { /* best effort */ }
      const argvResult = adapter.buildRunArgs({
        agent: task.assigned_agent || undefined, model: task.model || undefined,
        title: task.title, prompt: task.title,
      });
      const argv = argvResult.ok ? argvResult.argv : [];
      const executed = await adapter.executeAgentRun({
        project_id, run_id, task_key, mode: effectiveMode, argv, spawnFn, timeout_ms,
      });
      try {
        await core.dbQuery(
          `UPDATE workflow_dispatch SET argv=$1::jsonb,evidence_class=$2,process_exit_code=$3,
             process_ok=$4,output_ref=$5,error=$6 WHERE id=$7`,
          [JSON.stringify(argv), executed.evidence_class || "mock",
            executed.process_exit_code ?? null, executed.process_ok === true,
            short(executed.stdout_redacted || "", 400), short(executed.error || "", 400), ledger.rows[0].id]);
      } catch { /* best effort */ }
      if (executed.ok && executed.process_ok) {
        try { await sm.transitionTask({ project_id, run_id, task_key, to_status: "verifying" }); } catch { /* best effort */ }
      } else if (!executed.ok) {
        try { await sm.transitionTask({ project_id, run_id, task_key, to_status: "failed" }); } catch { /* best effort */ }
      }
      results.push({ task_key, dispatch_id: ledger.rows[0].id, evidence_class: executed.evidence_class || "mock",
        process_ok: executed.process_ok === true, task_verified: false,
        note: "process_ok only records process outcome; task_verified requires independent validation." });
    }
  }
  await Promise.all(Array.from({ length: maxP }, () => worker()));

  await audit("workflow.dispatch", project_id, { run_id, approval_id, mode: effectiveMode,
    dispatched: results.filter((r) => r.dispatch_id).length, skipped });
  return { ok: true, run_id, mode: effectiveMode,
    dispatched: results.filter((r) => r.dispatch_id).length, skipped, results };
}

/** Single-task dispatch variant (used by recovery). Consumes one approval per call. */
export async function dispatchTask({ project_id, run_id, task_key, ...opts } = {}) {
  if (!validProject(project_id) || !run_id || !task_key) return { ok: false, reason: "valid scope required", results: [] };
  const sm = await load("workflowStateMachine");
  const gr = sm?.getRun ? await sm.getRun({ project_id, run_id }) : { ok: false };
  if (!gr.ok) return { ok: false, reason: gr.reason || "run unavailable", results: [] };
  const task = (gr.tasks || []).find((t) => t.task_key === task_key);
  if (!task) return { ok: false, reason: "task not found", results: [] };
  return dispatchReady({ project_id, run_id, only_task: task_key, ...opts });
}

export default { dispatchReady, dispatchTask, checkFileOwnership };
