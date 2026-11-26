// Phase 26 — Deterministic, explainable next-best-action ranking.
//
// Invariants:
//   - RECOMMENDATION ONLY. Nothing is executed, dispatched, approved, gate-opened
//     or source-rewritten. Execution-kind recommendations always require explicit
//     operator approval and never bypass Phase 24 approval checks.
//   - FROZEN rule ordering (RULES). Ranking is pure and reproducible; equal-priority
//     candidates are returned as ties instead of claiming one optimal action.
//   - Only CONFIRMED dependencies constrain a ready task. Inferred/proposed deps
//     are surfaced as information but never treated as execution constraints.
//   - Every read is project-scoped and bounded; invalid/_global projects fail closed.
//   - Best-effort sibling loads degrade independently; DB failure fails closed into
//     { ok:false, recommendations:[], degraded:[...] } and never throws.
import * as core from "./core.js";

export const ACTION_KINDS = Object.freeze(["preparation", "execution"]);

export const RULES = Object.freeze({
  version: "1.0.0",
  order: Object.freeze([
    "blocker", "at_risk_milestone", "recovery", "ready_task", "drift_finding", "goal_without_work",
  ]),
  priority: Object.freeze({
    blocker: 100, at_risk_milestone: 90, recovery: 80,
    ready_task: 70, drift_finding: 60, goal_without_work: 50,
  }),
  action_kind: Object.freeze({
    blocker: "preparation", at_risk_milestone: "preparation", recovery: "preparation",
    ready_task: "execution", drift_finding: "preparation", goal_without_work: "preparation",
  }),
  severityBump: Object.freeze({ critical: 3, high: 2, medium: 1, low: 0 }),
  bounds: Object.freeze({
    defaultLimit: 10, maxLimit: 50, maxGoals: 200, maxTasks: 300, maxBlockers: 200,
    maxMilestones: 200, maxFindings: 200, maxDeps: 500, maxEvidence: 6, excerptChars: 220,
  }),
  activeGoalStatuses: Object.freeze(["active", "at_risk"]),
  terminalMilestoneStatuses: Object.freeze(["achieved", "completed", "cancelled", "superseded"]),
  riskyMilestoneStatuses: Object.freeze(["at_risk", "blocked"]),
  activeBlockerStatuses: Object.freeze(["identified", "open", "active", "in_progress"]),
  activeDriftStatuses: Object.freeze(["open", "acknowledged"]),
  recoveryEvidenceRe: "interrupted|interruption|recovery_required|crash|resume|partial_result|process_failure",
  note: "Frozen deterministic ordering; ties are reported as multiple candidates. Never executes.",
});

export const SAFETY_NOTE =
  "Recommendations are explainable, read-only and NEVER executed. They never override the operator " +
  "and never bypass Phase 24 approval. action_kind 'preparation' proposes analysis/review; " +
  "action_kind 'execution' requires explicit operator approval before any work starts.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmptyString(p) && p.trim() !== "_global"; }
function short(e) { return String(e?.message || e).replace(/\s+/g, " ").slice(0, 160); }
function clip(v, n = 220) { return core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n); }
function clampLimit(limit, fallback = 10, cap = 50) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
}
function boundConfidence(v, fallback = 0.5) {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000 : fallback;
}
function defaultLoad(name) {
  return import(`./${name}.js`).catch(() => null);
}
async function loadWith(name, override) {
  if (typeof override === "function") {
    try { return await override(name); } catch { return null; }
  }
  return defaultLoad(name);
}
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}
async function safeQuery(sql, params, label, degraded) {
  try {
    const r = await core.dbQuery(sql, params);
    return { rows: Array.isArray(r?.rows) ? r.rows : [], error: null };
  } catch (e) {
    degraded.push(`${label}: ${short(e)}`);
    return { rows: [], error: short(e) };
  }
}
function ev(source, excerpt) {
  return { source: String(source).slice(0, 40), excerpt: clip(excerpt, RULES.bounds.excerptChars) };
}
function firstId(value) {
  if (Array.isArray(value)) return nonEmptyString(value[0]) ? String(value[0]) : null;
  return nonEmptyString(value) ? String(value) : null;
}

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

export async function recommend({ project_id, limit, context, _load } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, project_id: project_id ?? null, recommendations: [], candidates_tied: [],
      tie_detected: false, degraded: ["valid project_id required"], note: SAFETY_NOTE };
  }
  const pid = project_id.trim();
  const n = clampLimit(limit, RULES.bounds.defaultLimit, RULES.bounds.maxLimit);
  const b = RULES.bounds;
  const degraded = [];
  const ctx = context && typeof context === "object" && !Array.isArray(context) ? context : {};

  // --- authoritative, project-scoped, bounded reads ------------------------
  const [goalRes, taskRes, blockerRes, milestoneRes, driftRes, depRes] = await Promise.all([
    safeQuery(
      `SELECT id, title, status, priority, success_criteria, target_date
         FROM dev_goal WHERE project_id=$1 ORDER BY priority DESC, updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxGoals], "dev_goal", degraded),
    safeQuery(
      `SELECT id, goal_id, task_key, title, status, evidence, dependencies, attempts, result_ref, priority, updated_at
         FROM dev_task WHERE project_id=$1 ORDER BY priority DESC, updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxTasks], "dev_task", degraded),
    safeQuery(
      `SELECT id, blocker_key, title, severity, category, status, affected_goals, affected_milestones, affected_tasks, evidence
         FROM pm_blocker WHERE project_id=$1 AND status = ANY($2)
         ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [pid, RULES.activeBlockerStatuses, b.maxBlockers], "pm_blocker", degraded),
    safeQuery(
      `SELECT id, milestone_key, goal_id, title, status, priority, success_criteria, target_date, evidence
         FROM pm_milestone WHERE project_id=$1 ORDER BY priority DESC, updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxMilestones], "pm_milestone", degraded),
    safeQuery(
      `SELECT id, finding_key, category, severity, confidence, status, evidence, affected_goals, affected_milestones, recommendation
         FROM pm_drift_finding WHERE project_id=$1 AND status = ANY($2)
         ORDER BY created_at DESC, id DESC LIMIT $3`,
      [pid, RULES.activeDriftStatuses, b.maxFindings], "pm_drift_finding", degraded),
    safeQuery(
      `SELECT id, from_type, from_id, to_type, to_id, dependency_type, confidence, evidence
         FROM pm_dependency WHERE project_id=$1 ORDER BY id DESC LIMIT $2`,
      [pid, b.maxDeps], "pm_dependency", degraded),
  ]);

  // Fail closed when authoritative sources cannot be read (e.g. DB down).
  const criticalOk = !goalRes.error && !taskRes.error;
  if (!criticalOk) {
    return { ok: false, project_id: pid, recommendations: [], candidates_tied: [], tie_detected: false,
      degraded, note: SAFETY_NOTE };
  }

  const goals = goalRes.rows;
  const tasks = taskRes.rows;
  const blockers = blockerRes.rows;
  const milestones = milestoneRes.rows;
  const drifts = driftRes.rows;
  const deps = depRes.rows;
  const goalById = new Map(goals.map((g) => [String(g.id), g]));
  const activeStatuses = RULES.activeGoalStatuses;
  const isActiveGoal = (g) => Boolean(g) && activeStatuses.includes(String(g.status));
  const unfinished = tasks.filter((t) => ["not_started", "in_progress", "blocked", "failed"].includes(String(t.status)));

  // --- best-effort Phase 24 / Phase 23 loads (read-only introspection only) --
  let phase24Available = false;
  try {
    const ap = await loadWith("workflowApproval", _load);
    phase24Available = Boolean(ap && (ap.verifyApproval || ap.getApproval || ap.approvalStatus || ap.listApprovals));
    if (!phase24Available) degraded.push("workflowApproval: unavailable");
  } catch (e) { degraded.push(`workflowApproval: ${short(e)}`); }
  let phase23FindingCount = 0;
  try {
    const pi = await loadWith("projectIntelligence", _load);
    if (pi?.projectReport) {
      const pr = await pi.projectReport({ project_id: pid, report_type: "all", limit: 10 });
      if (pr?.ok && Array.isArray(pr.findings)) phase23FindingCount = pr.findings.length;
    } else degraded.push("projectIntelligence: unavailable");
  } catch (e) { degraded.push(`projectIntelligence: ${short(e)}`); }

  // --- candidate assembly ---------------------------------------------------
  const candidates = [];
  const push = (rule, opts) => {
    const action_kind = RULES.action_kind[rule];
    const p = Math.round((opts.priority ?? RULES.priority[rule]) * 100) / 100;
    candidates.push({
      candidate_key: `${rule}:${String(opts.key ?? "summary").slice(0, 160)}`,
      rule,
      action: clip(opts.action, 300),
      reason: clip(opts.reason, 400),
      expected_outcome: clip(opts.expected_outcome, 300),
      goal_id: nonEmptyString(opts.goal_id) ? String(opts.goal_id) : null,
      milestone_id: nonEmptyString(opts.milestone_id) ? String(opts.milestone_id) : null,
      task_id: nonEmptyString(opts.task_id) ? String(opts.task_id) : null,
      dependencies: Array.isArray(opts.dependencies) ? opts.dependencies.slice(0, 20) : [],
      blockers: Array.isArray(opts.blockers) ? opts.blockers.slice(0, 20) : [],
      evidence: (Array.isArray(opts.evidence) ? opts.evidence : []).slice(0, b.maxEvidence)
        .map((e) => (e && typeof e === "object" ? ev(e.source ?? "record", e.excerpt ?? JSON.stringify(e)) : ev("record", e))),
      confidence: boundConfidence(opts.confidence, 0.5),
      priority: p,
      approval_required: action_kind === "execution" ? true : false,
      action_kind,
    });
  };
  const bump = (severity) => RULES.severityBump[String(severity ?? "medium")] ?? 0;

  // 1. blockers (preparation)
  for (const bl of blockers) {
    push("blocker", {
      key: bl.blocker_key ?? bl.id,
      priority: RULES.priority.blocker + bump(bl.severity),
      goal_id: firstId(bl.affected_goals), milestone_id: firstId(bl.affected_milestones),
      blockers: [String(bl.blocker_key ?? bl.id)],
      confidence: 0.75,
      evidence: [ev("pm_blocker", `blocker ${bl.blocker_key} severity=${bl.severity} status=${bl.status} category=${bl.category}`)],
      action: `Investigate and prepare a resolution for blocker ${bl.blocker_key}.`,
      reason: `Active blocker ${bl.blocker_key} (${bl.severity}) can stall dependent work.`,
      expected_outcome: "A reviewed, evidence-backed unblocking plan; no state change was made.",
    });
  }

  // 2. at-risk / overdue milestones (preparation)
  const now = Date.now();
  for (const m of milestones) {
    const status = String(m.status ?? "planned");
    if (RULES.terminalMilestoneStatuses.includes(status)) continue;
    const target = m.target_date ? new Date(m.target_date) : null;
    const passed = Boolean(target && !Number.isNaN(target.getTime()) && target.getTime() < now);
    const risky = RULES.riskyMilestoneStatuses.includes(status);
    if (!risky && !passed) continue;
    push("at_risk_milestone", {
      key: m.milestone_key ?? m.id,
      priority: RULES.priority.at_risk_milestone + Math.min(5, Math.max(0, Number(m.priority) || 0)),
      goal_id: nonEmptyString(m.goal_id) ? String(m.goal_id) : null,
      milestone_id: String(m.milestone_key ?? m.id),
      confidence: 0.8,
      evidence: [ev("pm_milestone", `milestone ${m.milestone_key} status=${status} target_date=${m.target_date ?? "(none)"}${passed ? " (past)" : ""}`)],
      action: `Review and re-plan at-risk milestone ${m.milestone_key}.`,
      reason: `Milestone ${m.milestone_key} is ${risky ? status : "past its target date"}; progress claims need evidence review.`,
      expected_outcome: "A refreshed, evidence-backed milestone plan; no status was changed automatically.",
    });
  }

  // 3. interrupted work / recovery with valid evidence (preparation)
  const recoveryRe = new RegExp(RULES.recoveryEvidenceRe, "i");
  for (const t of unfinished) {
    if (!["in_progress", "blocked", "failed"].includes(String(t.status))) continue;
    const arr = Array.isArray(t.evidence) ? t.evidence : [];
    const marker = arr.find((item) => recoveryRe.test(typeof item === "string" ? item : JSON.stringify(item ?? {})));
    if (!marker) continue;
    const hasResultRef = t.result_ref && typeof t.result_ref === "object" && Object.keys(t.result_ref).length > 0;
    const hasAttempts = Number(t.attempts) > 0;
    if (!hasResultRef && !hasAttempts) continue; // "valid evidence" gate
    const goal = goalById.get(String(t.goal_id ?? ""));
    if (!isActiveGoal(goal)) continue;
    push("recovery", {
      key: t.task_key ?? t.id,
      priority: RULES.priority.recovery,
      goal_id: String(t.goal_id),
      task_id: String(t.id),
      confidence: 0.7,
      evidence: [ev("dev_task", `task ${t.task_key} status=${t.status} has interruption evidence; attempts=${t.attempts ?? 0}`),
        ev("phase24", `approval state available=${phase24Available}`)],
      action: `Prepare a recovery plan for interrupted task ${t.task_key} (never auto-resume).`,
      reason: `Task ${t.task_key} was interrupted with recorded evidence; recovery must be prepared and approved by an operator.`,
      expected_outcome: "A Phase 24 recovery preparation that still requires explicit approval; nothing was resumed.",
    });
  }

  // 4. ready tasks using CONFIRMED dependencies only (execution -> approval)
  const completedIds = new Set(tasks.filter((t) => String(t.status) === "completed").map((t) => String(t.id)));
  const confirmedByTask = new Map();
  const unconfirmedByTask = new Map();
  for (const d of deps) {
    if (String(d.from_type ?? "") !== "task") continue;
    const key = String(d.from_id);
    if (String(d.dependency_type) === "confirmed") {
      if (!confirmedByTask.has(key)) confirmedByTask.set(key, []);
      confirmedByTask.get(key).push(d);
    } else {
      if (!unconfirmedByTask.has(key)) unconfirmedByTask.set(key, []);
      unconfirmedByTask.get(key).push(d);
    }
  }
  for (const t of unfinished) {
    if (String(t.status) !== "not_started") continue;
    const goal = goalById.get(String(t.goal_id ?? ""));
    if (!isActiveGoal(goal)) continue;
    const confirmed = confirmedByTask.get(String(t.id)) || [];
    const unsatisfied = confirmed.filter((d) =>
      String(d.to_type ?? "") === "task" && !completedIds.has(String(d.to_id)));
    if (unsatisfied.length) continue; // confirmed dependency not satisfied -> not ready
    const unconfirmed = unconfirmedByTask.get(String(t.id)) || [];
    const declared = Array.isArray(t.dependencies) ? t.dependencies : [];
    const dependencyList = confirmed.map((d) => ({
      from_id: String(d.from_id), to_type: String(d.to_type ?? ""), to_id: String(d.to_id),
      dependency_type: "confirmed", status: completedIds.has(String(d.to_id)) ? "satisfied" : "unknown",
    }));
    const evidence = [ev("dev_task", `task ${t.task_key} status=not_started goal=${goal.title}`)];
    if (unconfirmed.length || declared.length) {
      evidence.push(ev("pm_dependency",
        `ignored ${unconfirmed.length} unconfirmed dependency row(s) and ${declared.length} declared dep(s) as execution constraints`));
    }
    push("ready_task", {
      key: t.task_key ?? t.id,
      priority: RULES.priority.ready_task + Math.min(5, Math.max(0, Number(t.priority) || 0)),
      goal_id: String(t.goal_id),
      task_id: String(t.id),
      confidence: 0.8,
      dependencies: dependencyList,
      evidence,
      action: `Prepare to start ready task ${t.task_key} (requires explicit operator approval).`,
      reason: `Task ${t.task_key} is not_started under an active goal and all CONFIRMED dependencies are satisfied.`,
      expected_outcome: "With approval, work may begin; this recommendation itself starts nothing.",
    });
  }

  // 5. open drift findings (preparation)
  for (const d of drifts) {
    push("drift_finding", {
      key: d.finding_key ?? d.id,
      priority: RULES.priority.drift_finding + bump(d.severity),
      goal_id: firstId(d.affected_goals), milestone_id: firstId(d.affected_milestones),
      confidence: boundConfidence(d.confidence, 0.6),
      evidence: [ev("pm_drift_finding", `finding ${d.finding_key} category=${d.category} severity=${d.severity} status=${d.status}`)],
      action: `Review open drift finding ${d.finding_key}.`,
      reason: `Drift finding ${d.category} awaits operator review; no automatic rewrite is proposed.`,
      expected_outcome: "An operator decision to acknowledge, dismiss or resolve the finding; nothing changed automatically.",
    });
  }

  // 6. active goals without work (preparation)
  for (const g of goals) {
    if (!isActiveGoal(g)) continue;
    const linked = unfinished.filter((t) => String(t.goal_id ?? "") === String(g.id));
    if (linked.length) continue;
    push("goal_without_work", {
      key: String(g.id),
      priority: RULES.priority.goal_without_work + Math.min(5, Math.max(0, Number(g.priority) || 0)),
      goal_id: String(g.id),
      confidence: 0.75,
      evidence: [ev("dev_goal", `active goal ${g.title} has no unfinished tasks`)],
      action: `Plan concrete next work for active goal ${g.title}.`,
      reason: `Goal ${g.title} is active but has no unfinished tasks; prepare work for operator review.`,
      expected_outcome: "A proposed task plan; no task was created or dispatched automatically.",
    });
  }

  // --- deterministic ranking + explicit ties -------------------------------
  const orderIndex = new Map(RULES.order.map((r, i) => [r, i]));
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const oi = (orderIndex.get(a.rule) ?? 99) - (orderIndex.get(b.rule) ?? 99);
    if (oi !== 0) return oi;
    return a.candidate_key < b.candidate_key ? -1 : a.candidate_key > b.candidate_key ? 1 : 0;
  });

  const topPriority = candidates.length ? candidates[0].priority : null;
  const tied = topPriority === null ? [] : candidates.filter((c) => c.priority === topPriority);
  const candidates_tied = tied.length > 1 ? tied : [];
  const tie_detected = candidates_tied.length > 1;

  // context is a read-only hint: restrict to one rule when explicitly requested.
  let final = candidates;
  if (nonEmptyString(ctx.rule) && RULES.order.includes(String(ctx.rule))) {
    final = candidates.filter((c) => c.rule === ctx.rule);
  }
  const recommendations = final.slice(0, n);

  await audit("p26.next_actions", pid, {
    count: recommendations.length, tie_detected, degraded: degraded.slice(0, 10),
  });

  return {
    ok: true, project_id: pid, recommendations, candidates_tied, tie_detected,
    top_priority: topPriority, phase23_finding_count: phase23FindingCount,
    phase24_approval_state_available: phase24Available,
    degraded, note: SAFETY_NOTE,
  };
}

export default {
  RULES, ACTION_KINDS, SAFETY_NOTE, recommend,
};
