// Phase 26 — recovery assessment and preparation for interrupted work.
//
// This module is EVIDENCE / PREPARATION ONLY. assessRecovery() is a bounded,
// read-only analysis of task state, execution evidence, source freshness (Phase 25),
// confirmed dependencies, goal liveness and approval validity (Phase 24). It NEVER
// auto-resumes real execution. prepareRecovery() may invoke Phase 24 recovery ONLY
// in dry_run (preparation) mode with an explicit, valid, single-use approval — it
// never forwards a spawn function and never starts a process or dispatches an agent.
// Project-scoped, fail-closed, bounded, redacted and best-effort audited. LEVEL 1
// and HARNESS_SEMANTIC_LLM=0 are unchanged.
import * as core from "./core.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MAX_REASON = 30;
const MAX_EVIDENCE_FILES = 20;

const NOTE = "Recovery is a read-only assessment plus an optional dry-run preparation. " +
  "It never auto-resumes execution and never proves a task succeeded.";
const CLAIM = "NO_RUNTIME_CLAIM";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const validProject = (p) => nonEmpty(p) && p.trim() !== "_global";
const maxLimit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), MAX_LIMIT)) : DEFAULT_LIMIT;
};

async function defaultLoad(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
async function getModule(name, override) {
  if (typeof override === "function") {
    try { const m = await override(name); if (m) return m; } catch { /* fall back */ }
  }
  return defaultLoad(name);
}

function redactString(v) {
  let s = core.redact(String(v ?? ""));
  s = s.replace(/\bBearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_API_KEY]");
  return s;
}

async function audit(action, project_id, detail = {}) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

/** Pull the optional Phase 24 approval binding fields out of a flat args object. */
function approvalFrom(args) {
  const a = args && typeof args === "object" ? args : {};
  return {
    approval_id: a.approval_id, token: a.token,
    plan_id: a.plan_id, plan_version: a.plan_version, plan_hash: a.plan_hash,
    scope: a.scope, mode: a.mode, risk: a.risk,
  };
}
function hasApprovalFields(ap) {
  return nonEmpty(ap.approval_id) && nonEmpty(ap.token);
}

function reason(list, text) {
  if (list.length < MAX_REASON) list.push(redactString(text).slice(0, 240));
}

/**
 * Read-only recovery assessment. can_resume becomes true only when the task is in
 * a resumable state, all CONFIRMED dependencies are satisfied, the goal is still
 * active (or unlinked), and a valid, unexpired, unconsumed approval was supplied.
 * Source changes and inferred dependencies add cautions but are never treated as
 * authoritative execution constraints.
 */
export async function assessRecovery({
  project_id, task_id, run_id, limit, root, change, load, ...approvalRest
} = {}) {
  if (!validProject(project_id)) {
    return { ok: false, can_resume: false, reasons: ["valid project_id required"],
      required_approval: true, recommendation: "Provide a valid project_id and re-assess.",
      evidence: {}, never_auto_resume: true, degraded: [], note: NOTE, claim: CLAIM };
  }
  if (!nonEmpty(task_id)) {
    return { ok: false, can_resume: false, reasons: ["task_id required"],
      required_approval: true, recommendation: "Provide a task_id and re-assess.",
      evidence: {}, never_auto_resume: true, degraded: [], note: NOTE, claim: CLAIM };
  }

  const pid = short(project_id, 200).trim();
  const tid = short(task_id, 512).trim();
  const n = maxLimit(limit);
  const approval = approvalFrom(approvalRest);
  const degraded = [];

  // Fail closed when the backing store is unavailable: a degraded assessment must
  // never be mistaken for a healthy, resumable one.
  try { await core.dbQuery("SELECT 1"); }
  catch (e) {
    return { ok: false, can_resume: false, reasons: ["database unavailable"],
      required_approval: true, recommendation: "Store unavailable; re-assess after recovery. No execution was resumed.",
      evidence: {}, never_auto_resume: true, degraded: [`database unavailable: ${short(e?.message || e, 100)}`],
      note: NOTE, claim: CLAIM };
  }

  const reasons = [];
  const evidence = { task: null, execution: {}, source: null, dependencies: {}, goal: null, approval: null };

  // (1) Task state from dev_task (project-scoped).
  let task = null;
  try {
    const r = await core.dbQuery(
      "SELECT id, task_key, title, status, goal_id, dependencies, evidence, updated_at FROM dev_task WHERE id=$1 AND project_id=$2 LIMIT 1",
      [tid, pid]);
    if (r.rowCount) task = r.rows[0];
    else degraded.push("task not found in dev_task (state unknown)");
  } catch (e) { degraded.push(`task state: ${short(e?.message || e, 100)}`); }

  if (task) {
    const taskEvidence = Array.isArray(task.evidence) ? task.evidence : [];
    evidence.task = {
      id: task.id, task_key: task.task_key ?? null, status: task.status ?? "unknown",
      goal_id: task.goal_id ?? null, evidence_count: taskEvidence.length,
      evidence_has_verification: taskEvidence.some((x) => x && typeof x === "object" &&
        /test_pass|verification_result|tool_result|test_result/i.test(Object.keys(x).join(","))),
    };
  }

  // (2) Workflow task / execution evidence when a run_id is supplied.
  if (nonEmpty(run_id)) {
    evidence.run_id = short(run_id, 200);
    const sm = await getModule("workflowStateMachine", load);
    if (sm?.getRun) {
      try {
        const got = await sm.getRun({ project_id: pid, run_id: short(run_id, 200), limit: n });
        if (got?.ok) {
          evidence.execution.run_status = got.run?.status ?? "unknown";
          const wt = (got.tasks || []).find((t) =>
            String(t.task_key) === tid || String(t.id) === tid || String(t.task_key) === task?.task_key);
          if (wt) evidence.execution.workflow_task = { status: wt.status, attempts: wt.attempts,
            task_verified: wt.result_ref?.task_verified === true };
        } else degraded.push(`workflow run: ${short(got?.reason, 100)}`);
      } catch (e) { degraded.push(`workflow run: ${short(e?.message || e, 100)}`); }
    } else degraded.push("workflowStateMachine unavailable");

    // Dispatch / verification ledger (read-only).
    try {
      const disp = await core.dbQuery(
        `SELECT count(*)::int AS total,
                COALESCE(sum(CASE WHEN process_ok THEN 1 ELSE 0 END),0)::int AS process_ok,
                COALESCE(sum(CASE WHEN task_verified THEN 1 ELSE 0 END),0)::int AS verified
         FROM workflow_dispatch WHERE project_id=$1 AND run_id=$2`, [pid, short(run_id, 200)]);
      evidence.execution.dispatch = disp.rows[0] || {};
    } catch (e) { degraded.push(`dispatch ledger: ${short(e?.message || e, 100)}`); }
    try {
      const ver = await core.dbQuery(
        `SELECT count(*)::int AS total, COALESCE(sum(CASE WHEN verified THEN 1 ELSE 0 END),0)::int AS verified
         FROM workflow_verification WHERE project_id=$1 AND run_id=$2`, [pid, short(run_id, 200)]);
      evidence.execution.verification = ver.rows[0] || {};
    } catch (e) { degraded.push(`verification ledger: ${short(e?.message || e, 100)}`); }
    if (evidence.execution.dispatch?.process_ok > 0 && !evidence.execution.verification?.verified) {
      reason(reasons, "process success recorded without independent verification (caution)");
    }
  }

  // (3) Source freshness via Phase 25 (best-effort). Changed source is a caution.
  const ci = await getModule("changeImpact", load);
  if (ci?.compareIndexFreshness) {
    try {
      const fresh = await ci.compareIndexFreshness({ project_id: pid, root: root || undefined });
      const changed = Array.isArray(fresh?.changed_files) ? fresh.changed_files : [];
      evidence.source = {
        stale: fresh?.stale === true,
        changed_count: changed.length,
        changed_paths: changed.slice(0, MAX_EVIDENCE_FILES).map((f) => redactString(f?.path).slice(0, 200)),
      };
      if (fresh?.stale === true && changed.length > 0) {
        reason(reasons, `source changed since last index (${changed.length} files) — caution, re-verify before resuming`);
      } else if (fresh?.stale === true) {
        reason(reasons, "source freshness unverified (stale index) — caution");
      }
      for (const d of (fresh?.degraded || []).slice(0, 5)) degraded.push(`freshness: ${short(d, 100)}`);
    } catch (e) { degraded.push(`freshness: ${short(e?.message || e, 100)}`); }
  } else degraded.push("changeImpact unavailable (source freshness unknown)");
  void change; // accepted for API symmetry; raw change content is never trusted/returned.

  // (4) Dependencies — only 'confirmed' are authoritative constraints.
  let confirmed = [];
  let inferred = [];
  try {
    const depRows = (await core.dbQuery(
      `SELECT to_id, to_type, dependency_type, confidence FROM pm_dependency
       WHERE project_id=$1 AND from_type='task' AND from_id=$2 LIMIT $3`,
      [pid, tid, n])).rows;
    for (const d of depRows) {
      if (d.dependency_type === "confirmed") confirmed.push(String(d.to_id));
      else inferred.push({ to_id: String(d.to_id ?? ""), type: d.dependency_type });
    }
  } catch (e) { degraded.push(`dependencies: ${short(e?.message || e, 100)}`); }
  // dev_task.dependencies are project-internal task links (confirmed by their existence).
  const declared = Array.isArray(task?.dependencies) ? task.dependencies.map(String) : [];
  const confirmedAll = [...new Set([...confirmed, ...declared])].slice(0, n);
  evidence.dependencies = { confirmed: confirmedAll, inferred: inferred.slice(0, n),
    inferred_authoritative: false };

  let blockingDeps = false;
  if (confirmedAll.length) {
    try {
      const q = await core.dbQuery(
        `SELECT id, status FROM dev_task WHERE project_id=$1 AND id = ANY($2::text[])`,
        [pid, confirmedAll]);
      const statusById = new Map(q.rows.map((r) => [r.id, r.status]));
      const unmet = confirmedAll.filter((id) => statusById.get(id) !== "completed");
      evidence.dependencies.unmet = unmet;
      if (unmet.length) {
        blockingDeps = true;
        reason(reasons, `confirmed dependency not completed (${unmet.length})`);
      }
    } catch (e) { degraded.push(`dependency status: ${short(e?.message || e, 100)}`); }
  }
  if (inferred.length) reason(reasons, "inferred dependency present (non-authoritative)");

  // (5) Goal liveness. A goal that is not active (or unknown) is a hard blocker:
  // work for a completed/blocked/superseded goal must not be resumed.
  let goalBlocking = false;
  const goalId = task?.goal_id;
  if (nonEmpty(goalId)) {
    try {
      const g = await core.dbQuery(
        "SELECT id, status FROM dev_goal WHERE id=$1 AND project_id=$2 LIMIT 1",
        [short(goalId, 512), pid]);
      if (g.rowCount) {
        const gs = String(g.rows[0].status || "unknown");
        evidence.goal = { id: g.rows[0].id, status: gs };
        if (gs !== "active") {
          goalBlocking = true;
          reason(reasons, `goal not active (${gs})`);
        }
      } else {
        goalBlocking = true;
        evidence.goal = { id: short(goalId, 512), status: "unknown" };
        reason(reasons, "linked goal not found in project (unknown liveness)");
      }
    } catch (e) {
      goalBlocking = true;
      degraded.push(`goal: ${short(e?.message || e, 100)}`);
    }
  } else {
    goalBlocking = true;
    reason(reasons, "no linked goal (liveness unknown)");
  }

  // (6) Approval validity — Phase 24 verifyApproval (read-only). Expired/consumed
  // approvals are rejected by verifyApproval and can never authorize a resume.
  let approved = false;
  let requiredApproval = true;
  if (hasApprovalFields(approval)) {
    const ap = await getModule("workflowApproval", load);
    if (ap?.verifyApproval) {
      try {
        const v = await ap.verifyApproval({ project_id: pid, ...approval });
        approved = v.ok === true;
        requiredApproval = !approved;
        evidence.approval = { approval_id: short(approval.approval_id, 120), verified: approved };
        if (!approved) reason(reasons, `approval invalid: ${short(v?.reason || "rejected", 120)}`);
      } catch (e) {
        reason(reasons, `approval verification failed: ${short(e?.message || e, 100)}`);
      }
    } else {
      degraded.push("workflowApproval unavailable");
      reason(reasons, "approval verification unavailable (required)");
    }
  } else {
    reason(reasons, "approval required (no valid single-use approval supplied)");
  }

  // Resumable task-state check.
  const RESUMABLE = new Set(["failed", "blocked", "not_started", "pending", "in_progress", "exhausted"]);
  if (task) {
    if (task.status === "completed" || task.status === "verified" || task.status === "done") {
      reason(reasons, "task already completed (no resume needed)");
    } else if (!RESUMABLE.has(String(task.status))) {
      reason(reasons, `task state '${task.status}' is not resumable (unknown)`);
    }
  } else {
    reason(reasons, "task state unknown (cannot establish resumability)");
  }

  const blocking = !approved || blockingDeps || goalBlocking ||
    (task && !RESUMABLE.has(String(task.status))) || !task;
  const can_resume = !blocking;

  const recommendation = can_resume
    ? "Assessment only: a valid approval and satisfied preconditions exist. No execution was resumed; " +
      "any preparation must run in dry_run mode with fresh verification. Never auto-resume."
    : "Do not resume. Resolve the blocking reasons above (valid single-use approval, confirmed " +
      "dependencies, active goal, known task state), re-verify fresh source evidence, then re-assess. " +
      "This module never resumes execution automatically.";

  await audit("p26.recovery.assess", pid, { task_id: tid, run_id: nonEmpty(run_id) ? short(run_id, 120) : null,
    can_resume, required_approval: requiredApproval, reason_count: reasons.length });

  return {
    ok: true, project_id: pid, task_id: tid,
    can_resume, reasons, required_approval: requiredApproval,
    recommendation, evidence, never_auto_resume: true, degraded,
    note: NOTE, claim: CLAIM,
  };
}

/**
 * Prepare recovery in dry_run mode only. Requires a valid, unexpired, unconsumed
 * Phase 24 approval; verifies it first (read-only) and then calls workflowRecovery
 * with dry_run:true. No spawnFn is ever forwarded and no real process is started.
 */
export async function prepareRecovery({
  project_id, task_id, run_id, load, spawnFn, ...approvalRest
} = {}) {
  if (!validProject(project_id)) {
    return { ok: false, reason: "valid project_id required", required_approval: true,
      never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }
  const pid = short(project_id, 200).trim();
  const approval = approvalFrom(approvalRest);
  void spawnFn; // deliberately ignored: preparation can never spawn a process.

  if (!hasApprovalFields(approval)) {
    return { ok: false, reason: "explicit single-use approval required", required_approval: true,
      never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }

  // Verify first; expired/consumed/mismatched approvals are always rejected.
  const ap = await getModule("workflowApproval", load);
  if (!ap?.verifyApproval) {
    return { ok: false, reason: "workflowApproval unavailable", required_approval: true,
      never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }
  let verified;
  try { verified = await ap.verifyApproval({ project_id: pid, ...approval }); }
  catch (e) { return { ok: false, reason: `approval verification failed: ${short(e?.message || e, 100)}`,
    required_approval: true, never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM }; }
  if (!verified?.ok) {
    return { ok: false, reason: `invalid approval: ${short(verified?.reason || "rejected", 120)}`,
      required_approval: true, never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }

  const recovery = await getModule("workflowRecovery", load);
  if (!recovery?.recoverRun) {
    return { ok: false, reason: "workflowRecovery unavailable", required_approval: false,
      never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }

  let result;
  try {
    result = await recovery.recoverRun({
      project_id: pid,
      run_id: nonEmpty(run_id) ? short(run_id, 200) : undefined,
      approvals: [{ approval_id: approval.approval_id, token: approval.token }],
      dry_run: true, mode: "simulation", max_attempts: 1,
      // spawnFn is intentionally NOT passed: preparation can never spawn a process.
    });
  } catch (e) {
    return { ok: false, reason: `recovery preparation failed: ${short(e?.message || e, 120)}`,
      required_approval: false, never_auto_resume: true, no_spawn: true, note: NOTE, claim: CLAIM };
  }

  await audit("p26.recovery.prepare", pid, { task_id: nonEmpty(task_id) ? short(task_id, 120) : null,
    run_id: nonEmpty(run_id) ? short(run_id, 120) : null, ok: !!result?.ok, dry_run: true });

  return {
    ok: result?.ok !== false,
    project_id: pid,
    run_id: nonEmpty(run_id) ? short(run_id, 200) : null,
    task_id: nonEmpty(task_id) ? short(task_id, 512) : null,
    mode: "preparation", dry_run: true, no_spawn: true,
    retried: result?.retried ?? 0,
    results: Array.isArray(result?.results) ? result.results.slice(0, 20) : [],
    degraded: Array.isArray(result?.degraded) ? result.degraded.slice(0, 10) : [],
    never_auto_resume: true,
    note: NOTE, claim: CLAIM,
  };
}

export default { assessRecovery, prepareRecovery };
