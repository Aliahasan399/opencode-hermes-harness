// Phase 26 §2.4: long-term continuity briefings. Assembles an honest, bounded
// briefing ONLY from existing authoritative records via references (ids/keys/
// hashes/status). It never copies session transcripts, never executes a workflow,
// never dispatches, never auto-approves and never rewrites source. LEVEL 1 and
// HARNESS_SEMANTIC_LLM=0 unchanged.
//
// Every section is a 4-class map: confirmed | inferred | recommendation | unknown.
// Optional sibling capabilities (developmentGoal, Phase 24 controlled workflow /
// approvals, Phase 18 context, Phase 23 report, Phase 25 code intelligence) are
// reached with dynamic imports; unavailable capabilities become `degraded` entries
// and `unknown` entries rather than fabricated claims.
import crypto from "node:crypto";
import * as core from "./core.js";

export const SECTIONS = Object.freeze([
  "project_overview", "verified_progress", "current_work", "blockers_risks",
  "project_drift", "recovery", "recommended_actions", "evidence_confidence",
]);
export const EVIDENCE_CLASSES = Object.freeze(["confirmed", "inferred", "recommendation", "unknown"]);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_APPROVAL = new Set(["active", "pending", "valid"]);
const OPEN_BLOCKER = new Set(["identified", "open", "active", "in_progress", "unresolved"]);
const OPEN_DRIFT = new Set(["open", "identified", "active"]);

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const validProject = (p) => nonEmpty(p) && p !== "_global";
const short = (v, n = 220) => core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n);
const clipId = (v, n = 512) => String(v ?? "").slice(0, n);
const clampLimit = (limit, fallback = DEFAULT_LIMIT, cap = MAX_LIMIT) =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;

/** Redact credentials from any string and clamp structure. */
function redactString(v) {
  let s = core.redact(String(v ?? ""));
  s = s.replace(/\bBearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_API_KEY]");
  return s.slice(0, 2000);
}
function redactValue(v, depth = 0) {
  if (typeof v === "string") return redactString(v);
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort().slice(0, 30)) out[k.slice(0, 60)] = redactValue(v[k], depth + 1);
    return out;
  }
  return v;
}
/** Bound arbitrary caller input to a redacted JSON-safe object. */
function boundedObject(value, maxChars = 80000) {
  const out = redactValue(value && typeof value === "object" && !Array.isArray(value) ? value : { value });
  try {
    if (JSON.stringify(out).length > maxChars) return { truncated: true, preview: JSON.stringify(out).slice(0, 1000) };
  } catch { return { truncated: true }; }
  return out;
}
function section() {
  return { confirmed: [], inferred: [], recommendation: [], unknown: [] };
}
/** A reference carries identifiers/status only -- never transcript text. */
function ref(kind, row, extra = {}) {
  const r = { kind };
  if (row && typeof row === "object") {
    for (const k of ["id", "key", "task_key", "run_id", "plan_id", "goal_id", "milestone_id", "source_session"]) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== "") r[k] = clipId(row[k]);
    }
    for (const k of ["status", "severity", "category", "goal_type", "provenance", "expires_at", "updated_at", "created_at"]) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== "") r[k] = short(row[k], 120);
    }
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) r[k] = redactValue(v);
  return r;
}
const recommendation = (text, refObj) => ({ kind: "recommendation", text: short(text, 300), ...(refObj ? { ref: refObj } : {}) });
const unknownArea = (area, reason) => ({ kind: "unknown", area, reason: short(reason, 220) });

async function audit(action, project_id, detail) {
  try {
    await core.audit(action, project_id, {
      action, section_count: detail?.section_count ?? 0, evidence_count: detail?.evidence_count ?? 0,
      degraded_count: Array.isArray(detail?.degraded) ? detail.degraded.length : 0,
    });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// 1. Briefing assembly
// ---------------------------------------------------------------------------

/**
 * Build a reference-only continuity briefing. `sections` is validated and
 * clamped; all eight section keys are always present so downstream consumers
 * can rely on a stable shape.
 */
export async function buildBriefing({ project_id, session_id, limit, sections } = {}) {
  const degraded = [];
  const fail = (reason) => ({
    ok: false, briefing: null, freshness: null, degraded,
    note: "Reference-only briefing. No transcript content, execution, dispatch or approval is performed.", reason,
  });
  if (!validProject(project_id)) return fail("valid project_id required");

  const n = clampLimit(limit);
  if (Array.isArray(sections) && sections.length) {
    const recognized = SECTIONS.filter((s) => sections.map(String).includes(s)).slice(0, SECTIONS.length);
    if (!recognized.length) degraded.push("sections: none recognized; using all default sections");
  }

  const briefing = {};
  for (const key of SECTIONS) briefing[key] = section();

  // --- authoritative development goals / unfinished tasks (Phase 19) --------
  let goals = [];
  let unfinished = [];
  const dg = await load("developmentGoal");
  if (dg?.getGoalContinuity) {
    try {
      const r = await dg.getGoalContinuity({ project_id, limit: n });
      if (r?.ok) goals = Array.isArray(r.goals) ? r.goals : [];
      else degraded.push(`goals: ${r?.reason || "getGoalContinuity failed"}`);
    } catch (e) { degraded.push(`goals: ${short(e?.message || e, 120)}`); }
  } else {
    degraded.push("goals: developmentGoal.getGoalContinuity unavailable");
  }
  if (dg?.getUnfinishedTasks) {
    try {
      const r = await dg.getUnfinishedTasks({ project_id, limit: n });
      if (r?.ok) unfinished = Array.isArray(r.tasks) ? r.tasks : [];
      else degraded.push(`unfinished_tasks: ${r?.reason || "getUnfinishedTasks failed"}`);
    } catch (e) { degraded.push(`unfinished_tasks: ${short(e?.message || e, 120)}`); }
  } else {
    degraded.push("unfinished_tasks: developmentGoal.getUnfinishedTasks unavailable");
  }
  // Direct authoritative fallback when the sibling capability is unavailable.
  if (!unfinished.length && !dg?.getUnfinishedTasks) {
    try {
      const r = await core.dbQuery(
        `SELECT id, goal_id, task_key, status, updated_at FROM dev_task
          WHERE project_id=$1 AND status = ANY($2::text[])
          ORDER BY updated_at DESC, id DESC LIMIT $3`,
        [project_id, ["not_started", "in_progress", "blocked", "failed"], n],
      );
      unfinished = r.rows;
    } catch (e) { degraded.push(`dev_task fallback: ${short(e?.message || e, 120)}`); }
  }

  // Provenance of goals comes from the extended dev_goal record (migration 024).
  let goalProvenance = new Map();
  try {
    const r = await core.dbQuery(
      `SELECT id, provenance, goal_type, status, source_session FROM dev_goal
        WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [project_id, n]);
    goalProvenance = new Map(r.rows.map((g) => [clipId(g.id), g]));
  } catch (e) { degraded.push(`dev_goal: ${short(e?.message || e, 120)}`); }

  // --- authoritative pm_* records (migration 024) ---------------------------
  const readRows = async (label, sql, params) => {
    try { return (await core.dbQuery(sql, params)).rows; }
    catch (e) { degraded.push(`${label}: ${short(e?.message || e, 120)}`); return []; }
  };
  const milestones = await readRows(
    "pm_milestone",
    `SELECT id, milestone_key, goal_id, status, priority, target_date, updated_at
       FROM pm_milestone WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [project_id, n]);
  const blockers = await readRows(
    "pm_blocker",
    `SELECT id, blocker_key, severity, category, status, affected_goals, affected_milestones,
            affected_tasks, updated_at
       FROM pm_blocker WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [project_id, n]);
  const driftFindings = await readRows(
    "pm_drift_finding",
    `SELECT id, finding_key, category, severity, confidence, status, affected_goals,
            affected_milestones, updated_at
       FROM pm_drift_finding WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [project_id, n]);
  const snapshots = await readRows(
    "pm_progress_snapshot",
    `SELECT id, snapshot_key, goal_id, milestone_id, task_id, status, evidence, created_at
       FROM pm_progress_snapshot WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`, [project_id, n]);

  // --- verification gate (developmentGoal.canMarkComplete) ------------------
  let can = null;
  if (typeof dg?.canMarkComplete === "function") can = dg.canMarkComplete;
  else degraded.push("verification_gate: developmentGoal.canMarkComplete unavailable");
  const verified = (row) => typeof can === "function" && can(Array.isArray(row?.evidence) ? row.evidence : []);

  // --- Phase 24: approvals, workflow state, interrupted work -----------------
  const outstandingApprovals = [];
  const approvalMod = await load("workflowApproval");
  if (approvalMod?.listApprovals) {
    try {
      const r = await approvalMod.listApprovals({ project_id, limit: n });
      if (r?.ok) {
        for (const a of (Array.isArray(r.items) ? r.items : [])) {
          if (ACTIVE_APPROVAL.has(String(a.status || "").toLowerCase())) {
            outstandingApprovals.push(ref("approval", a));
            if (outstandingApprovals.length >= n) break;
          }
        }
      } else degraded.push(`phase24.approvals: ${r?.reason || "listApprovals failed"}`);
    } catch (e) { degraded.push(`phase24.approvals: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase24.approvals: workflowApproval.listApprovals unavailable");

  let interrupted = [];
  const monitor = await load("workflowMonitor");
  if (monitor?.listStale) {
    try {
      const r = await monitor.listStale({ project_id, limit: n });
      if (r?.ok) interrupted = (Array.isArray(r.items) ? r.items : []).slice(0, n).map((t) => ref("interrupted_workflow", t));
      else degraded.push(`phase24.workflow.stale: ${r?.reason || "listStale failed"}`);
    } catch (e) { degraded.push(`phase24.workflow.stale: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase24.workflow.stale: workflowMonitor.listStale unavailable");

  const cw = await load("controlledWorkflow");
  let workflowSummary = null;
  if (cw?.status) {
    try {
      const r = await cw.status({ project_id, limit: n });
      if (r?.ok) workflowSummary = ref("workflow_status", { ...(r.summary || {}), status: "recorded" },
        { source: "controlledWorkflow.status", task_count: Array.isArray(r.tasks) ? r.tasks.length : 0 });
      else degraded.push(`phase24.workflow.status: ${r?.reason || "status failed"}`);
    } catch (e) { degraded.push(`phase24.workflow.status: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase24.workflow.status: controlledWorkflow.status unavailable");
  // controlledWorkflow.recover is deliberately NOT invoked: it is a gated action
  // that can dispatch. Recovery is represented as a recommendation only.

  // --- Phase 18 context / Phase 23 report / Phase 25 code intelligence ------
  let contextRefs = [];
  const ctx = await load("contextRetrieval");
  if (ctx?.retrieveContext) {
    try {
      const r = await ctx.retrieveContext({ project_id, session_id: session_id || undefined, query: "", limit: n, budget_chars: 2000 });
      const rows = Array.isArray(r?.items) ? r.items : (Array.isArray(r?.results) ? r.results : []);
      contextRefs = rows.slice(0, Math.min(n, 10)).map((x) => ref("context", x, { source: "phase18.context" }));
      if (Array.isArray(r?.degraded) && r.degraded.length) degraded.push(`phase18.context: ${short(r.degraded[0], 120)}`);
    } catch (e) { degraded.push(`phase18.context: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase18.context: contextRetrieval.retrieveContext unavailable");

  let riskRefs = [];
  const pi = await load("projectIntelligence");
  if (pi?.projectReport) {
    try {
      const r = await pi.projectReport({ project_id, report_type: "all", limit: n });
      const rows = [];
      for (const k of ["findings", "predictions", "assessments"]) {
        if (Array.isArray(r?.[k])) for (const x of r[k].slice(0, Math.min(n, 10))) rows.push(ref(`phase23.${k}`, x));
      }
      riskRefs = rows.slice(0, n);
    } catch (e) { degraded.push(`phase23.report: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase23.report: projectIntelligence.projectReport unavailable");

  let codeRefs = [];
  const ci = await load("codeIntelligence");
  if (ci?.report) {
    try {
      const r = await ci.report({ project_id, limit: n });
      const rows = Array.isArray(r?.findings) ? r.findings : (Array.isArray(r?.evidence) ? r.evidence : []);
      codeRefs = rows.slice(0, Math.min(n, 10)).map((x) => ref("phase25.code", x));
    } catch (e) { degraded.push(`phase25.code: ${short(e?.message || e, 120)}`); }
  } else degraded.push("phase25.code: codeIntelligence.report unavailable");

  // --- assemble the eight sections ------------------------------------------
  // project_overview
  for (const g of goals.slice(0, n)) {
    const p = goalProvenance.get(clipId(g.id));
    const provenance = String(p?.provenance || "");
    const entry = ref("goal", g, { provenance: provenance || "unrecorded" });
    if (["verified_outcome", "user_approved"].includes(provenance)) briefing.project_overview.confirmed.push(entry);
    else if (["inferred", "ai_recommendation"].includes(provenance)) briefing.project_overview.inferred.push(entry);
    else briefing.project_overview.unknown.push(entry);
  }
  for (const m of milestones.slice(0, n)) briefing.project_overview.confirmed.push(ref("milestone", m));
  briefing.project_overview.inferred.push(...contextRefs);
  if (!goals.length && !milestones.length) {
    briefing.project_overview.unknown.push(unknownArea("goals_and_milestones", "No authoritative goal or milestone records in scope."));
  }

  // verified_progress
  for (const t of unfinished.filter(verified).slice(0, n)) {
    briefing.verified_progress.confirmed.push(ref("verified_task", t, { verification: "explicit_evidence" }));
  }
  for (const s of snapshots.filter(verified).slice(0, n)) {
    briefing.verified_progress.confirmed.push(ref("verified_snapshot", s, { verification: "explicit_evidence" }));
  }
  for (const t of unfinished.filter((t) => String(t.status) === "completed" && !verified(t)).slice(0, n)) {
    briefing.verified_progress.inferred.push(ref("unverified_claim", t, { evidence_class: "unverified_claim" }));
  }
  for (const s of snapshots.filter((s) => ["complete", "verified"].includes(String(s.status)) && !verified(s)).slice(0, n)) {
    briefing.verified_progress.inferred.push(ref("unverified_snapshot_claim", s, { evidence_class: "unverified_claim" }));
  }
  if (typeof can !== "function") {
    briefing.verified_progress.unknown.push(unknownArea("verification_gate", "Verification evidence could not be evaluated."));
  }
  briefing.verified_progress.recommendation.push(
    recommendation("Treat only explicitly verified evidence as progress; collect verification before claiming completion."));

  // current_work
  for (const t of unfinished.slice(0, n)) briefing.current_work.confirmed.push(ref("unfinished_task", t));
  for (const m of milestones.filter((m) => ["active", "in_progress", "planned"].includes(String(m.status))).slice(0, n)) {
    briefing.current_work.confirmed.push(ref("active_milestone", m));
  }
  if (workflowSummary) briefing.current_work.inferred.push(workflowSummary);
  if (!unfinished.length) {
    briefing.current_work.unknown.push(unknownArea("unfinished_tasks", "No unfinished task records in scope."));
  }

  // blockers_risks
  for (const b of blockers.filter((b) => OPEN_BLOCKER.has(String(b.status || "").toLowerCase())).slice(0, n)) {
    briefing.blockers_risks.confirmed.push(ref("blocker", b));
  }
  for (const d of driftFindings.filter((d) => ["high", "critical"].includes(String(d.severity))).slice(0, n)) {
    briefing.blockers_risks.confirmed.push(ref("drift_risk", d));
  }
  briefing.blockers_risks.inferred.push(...riskRefs);
  if (!blockers.length && !driftFindings.length) {
    briefing.blockers_risks.unknown.push(unknownArea("blockers_and_drift", "No blocker or drift records; absence of records is not proof of absence of risk."));
  }
  briefing.blockers_risks.recommendation.push(
    recommendation("Review open blockers and high-severity drift before starting new work."));

  // project_drift
  for (const d of driftFindings.filter((d) => OPEN_DRIFT.has(String(d.status || "").toLowerCase())).slice(0, n)) {
    briefing.project_drift.confirmed.push(ref("drift_finding", d));
  }
  const goalIdsWithTasks = new Set(goals.flatMap((g) => (Array.isArray(g.tasks) ? g.tasks : [])).map((t) => clipId(t.goal_id)));
  for (const g of goals.filter((g) => !goalIdsWithTasks.has(clipId(g.id))).slice(0, n)) {
    briefing.project_drift.inferred.push(ref("goal_without_work", g));
  }
  if (!driftFindings.length) {
    briefing.project_drift.unknown.push(unknownArea("drift_findings", "No drift analysis records in scope."));
  }
  briefing.project_drift.recommendation.push(
    recommendation("Review drift findings; no goal, task, milestone or source was rewritten by this briefing."));

  // recovery
  for (const a of outstandingApprovals) briefing.recovery.confirmed.push(a);
  for (const t of interrupted) briefing.recovery.confirmed.push(t);
  if (workflowSummary) briefing.recovery.confirmed.push(workflowSummary);
  if (!outstandingApprovals.length && !interrupted.length && !workflowSummary) {
    briefing.recovery.unknown.push(unknownArea("workflow_state", "No outstanding approvals or interrupted workflows could be confirmed."));
  }
  briefing.recovery.recommendation.push(
    recommendation("Recover interrupted work only through controlledWorkflow.recover with explicit operator approval; this briefing never dispatches."));

  // recommended_actions
  for (const b of blockers.filter((b) => OPEN_BLOCKER.has(String(b.status || "").toLowerCase())).slice(0, 5)) {
    briefing.recommended_actions.recommendation.push(
      recommendation("Triage the open blocker before depending on affected work.", ref("blocker", b)));
  }
  for (const t of interrupted.slice(0, 5)) {
    briefing.recommended_actions.recommendation.push(
      recommendation("Obtain approval, then consider a controlled recovery of the interrupted task.", t));
  }
  for (const t of unfinished.filter((t) => String(t.status) === "completed" && !verified(t)).slice(0, 5)) {
    briefing.recommended_actions.recommendation.push(
      recommendation("Collect explicit verification evidence for the unverified completion claim.", ref("unverified_task", t)));
  }
  for (const d of driftFindings.filter((d) => OPEN_DRIFT.has(String(d.status || "").toLowerCase())).slice(0, 5)) {
    briefing.recommended_actions.recommendation.push(
      recommendation("Review the drift finding and decide whether to act; no automatic rewrite is performed.", ref("drift_finding", d)));
  }
  if (!briefing.recommended_actions.recommendation.length) {
    briefing.recommended_actions.recommendation.push(
      recommendation("Confirm the current objective and the next review point with the operator."));
    briefing.recommended_actions.unknown.push(unknownArea("next_actions", "No deterministic action could be derived from authoritative records."));
  }

  // evidence_confidence
  const sourceCounts = [
    ["dev_goal", goals.length], ["dev_task", unfinished.length], ["pm_milestone", milestones.length],
    ["pm_blocker", blockers.length], ["pm_drift_finding", driftFindings.length],
    ["pm_progress_snapshot", snapshots.length], ["phase24.approval", outstandingApprovals.length],
    ["phase24.workflow", interrupted.length],
  ];
  for (const [name, count] of sourceCounts) {
    briefing.evidence_confidence.confirmed.push({ kind: "authoritative_source", name, count });
  }
  briefing.evidence_confidence.inferred.push(...codeRefs, ...contextRefs);
  for (const d of degraded) briefing.evidence_confidence.unknown.push({ kind: "degraded", detail: short(d, 220) });
  briefing.evidence_confidence.recommendation.push(
    recommendation("Unknown means insufficient evidence, not health. No completion percentage is inferred from record counts."));

  // --- freshness (derived from authoritative timestamps only) ----------------
  const stamps = [...goals, ...unfinished, ...milestones, ...blockers, ...driftFindings, ...snapshots]
    .map((r) => r?.updated_at || r?.created_at)
    .filter(nonEmpty)
    .map((t) => Date.parse(String(t)))
    .filter((t) => Number.isFinite(t));
  const asOf = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
  const freshness = {
    as_of: asOf,
    stale: asOf ? (Date.now() - Date.parse(asOf) > STALE_MS) : true,
    window_ms: STALE_MS,
    sources: Object.fromEntries(sourceCounts),
    degraded: [...degraded],
    note: asOf ? "Derived from the newest authoritative record timestamp; not runtime proof."
      : "No authoritative timestamps were available; freshness is unknown.",
  };

  await audit("p26.briefing.build", project_id, { section_count: SECTIONS.length, degraded });
  return {
    ok: true,
    briefing,
    freshness,
    degraded,
    note: "Reference-only briefing assembled from authoritative records. No session transcripts were copied; " +
      "no execution, dispatch, approval or source write was performed. Sections carry confirmed | inferred | " +
      "recommendation | unknown classes. controlledWorkflow.recover is not invoked (gated action). " +
      "Unknown means insufficient evidence; no completion percentage is emitted.",
  };
}

// ---------------------------------------------------------------------------
// 2. Persistence (bounded, project-scoped)
// ---------------------------------------------------------------------------

/** Persist a briefing as an append-only snapshot (never updates an older row). */
export async function saveBriefing({ project_id, briefing, freshness, evidence_refs = [] } = {}) {
  const fail = (reason) => ({ ok: false, id: null, created: false, reason });
  if (!validProject(project_id)) return fail("valid project_id required");
  if (!briefing || typeof briefing !== "object" || Array.isArray(briefing)) return fail("briefing object required");
  const id = crypto.randomUUID();
  try {
    await core.withDb(async (client) => {
      await client.query(
        `INSERT INTO pm_continuity_snapshot (id, project_id, briefing, freshness, evidence_refs)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
        [id, project_id,
          JSON.stringify(boundedObject(briefing)),
          JSON.stringify(boundedObject(freshness || {}, 20000)),
          JSON.stringify(Array.isArray(evidence_refs) ? redactValue(evidence_refs.slice(0, 200)) : [])],
      );
    });
    await audit("p26.briefing.save", project_id, { section_count: Object.keys(briefing).length });
    return { ok: true, id, created: true };
  } catch (e) {
    return fail(`briefing persistence failed: ${short(e?.message || e, 120)}`);
  }
}

/** Bounded lookup of the most recent briefing snapshot(s) for a project. */
export async function getLatestBriefing({ project_id, limit } = {}) {
  const n = clampLimit(limit, 1, 10);
  const empty = { ok: false, briefing: null, items: [], count: 0, reason: "valid project_id required" };
  if (!validProject(project_id)) return empty;
  try {
    const r = await core.dbQuery(
      `SELECT id, briefing, freshness, evidence_refs, created_at
         FROM pm_continuity_snapshot
        WHERE project_id=$1
        ORDER BY created_at DESC, id DESC LIMIT $2`, [project_id, n],
    );
    const items = r.rows;
    return {
      ok: true,
      id: items[0]?.id ?? null,
      briefing: items[0]?.briefing ?? null,
      freshness: items[0]?.freshness ?? null,
      evidence_refs: items[0]?.evidence_refs ?? [],
      created_at: items[0]?.created_at ?? null,
      items, count: items.length,
      reason: items.length ? undefined : "no briefing snapshot recorded",
    };
  } catch (e) {
    return { ...empty, reason: `briefing lookup failed: ${short(e?.message || e, 120)}` };
  }
}

export default { SECTIONS, EVIDENCE_CLASSES, buildBriefing, saveBriefing, getLatestBriefing };
