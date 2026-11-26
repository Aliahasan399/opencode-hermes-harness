// Phase 26 — Project drift detection (facade over Phase 18-25 authoritative records).
//
// Invariants (same posture as the Phase 23-25 facades):
//   - Every read is project-scoped and bounded; invalid/_global projects fail closed.
//   - Drift findings are REVIEW RECOMMENDATIONS only. No goal, task, milestone,
//     decision, workflow or source record is ever auto-rewritten, removed, approved
//     or dispatched. An operator must act on each finding explicitly.
//   - Free text is redacted with core.redact; audit is content-free and best effort.
//   - Best-effort sibling loads degrade independently; a DB failure fails closed into
//     { ok:false, findings:[], degraded:[...] } and never throws.
//   - Persistence is idempotent: UNIQUE(project_id, finding_key) + ON CONFLICT DO NOTHING.
import crypto from "node:crypto";
import * as core from "./core.js";

export const DRIFT_CATEGORIES = Object.freeze([
  "orphan_work", "goal_without_work", "decision_conflict", "scope_growth",
  "repeated_deferral", "stale_milestone", "missing_success_criteria", "architecture_effect",
]);
export const DRIFT_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);
export const DRIFT_STATUSES = Object.freeze(["open", "acknowledged", "dismissed", "resolved"]);

export const DRIFT_RULES = Object.freeze({
  version: "1.0.0",
  bounds: Object.freeze({
    defaultLimit: 50, maxLimit: 200, maxGoals: 200, maxTasks: 300,
    maxMilestones: 200, maxSnapshots: 300, maxImpact: 100, maxFindings: 100,
    maxEvidence: 6, excerptChars: 220, recommendationChars: 400,
  }),
  activeGoalStatuses: Object.freeze(["active", "at_risk"]),
  terminalMilestoneStatuses: Object.freeze(["achieved", "completed", "cancelled", "superseded"]),
  riskyMilestoneStatuses: Object.freeze(["at_risk", "blocked"]),
  unfinishedTaskStatuses: Object.freeze(["not_started", "in_progress", "blocked", "failed"]),
  thresholds: Object.freeze({ scopeGrowthRatio: 0.5, scopeGrowthMinTasks: 3, deferredEvidenceCount: 2 }),
  severity: Object.freeze({
    orphan_work: "medium", goal_without_work: "medium", decision_conflict: "high",
    scope_growth: "medium", repeated_deferral: "medium", stale_milestone: "high",
    missing_success_criteria: "medium", architecture_effect: "medium",
  }),
  confidence: Object.freeze({
    orphan_work: 0.85, goal_without_work: 0.85, decision_conflict: 0.6,
    scope_growth: 0.65, repeated_deferral: 0.7, stale_milestone: 0.9,
    missing_success_criteria: 0.9, architecture_effect: 0.55,
  }),
  note: "Findings are deterministic, record-based review recommendations, never auto-applied changes.",
});

export const SAFETY_NOTE =
  "Drift findings are REVIEW RECOMMENDATIONS only. No goal, task, milestone, decision, workflow " +
  "or source record was rewritten, removed, approved or dispatched. An operator must explicitly " +
  "review and act; analysis is bounded, project-scoped and never auto-rewrites work.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmptyString(p) && p.trim() !== "_global"; }
function short(e) { return String(e?.message || e).replace(/\s+/g, " ").slice(0, 160); }
function clip(v, n = 220) { return core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n); }
function clampLimit(limit, fallback = 50, cap = 200) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
}
function boundConfidence(v, fallback) {
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
function hasSuccessCriteria(v) {
  if (Array.isArray(v)) return v.some((x) => x !== null && x !== undefined && String(x).trim() !== "");
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return nonEmptyString(v) && v !== "[]" && v !== "{}";
}
function evidenceFor(row, source, excerpt) {
  const out = [{ source: String(source).slice(0, 40), excerpt: clip(excerpt, DRIFT_RULES.bounds.excerptChars) }];
  const arr = Array.isArray(row?.evidence) ? row.evidence : [];
  if (arr.length) {
    out.push({ source: `${source}.evidence`, excerpt: clip(JSON.stringify(arr[0]), DRIFT_RULES.bounds.excerptChars) });
  }
  return out;
}
function makeFinding(category, targetId, evidence, affectedGoals, affectedMilestones, recommendation, overrides = {}) {
  const dedupe = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(nonEmptyString).map(String))].slice(0, 20);
  return {
    finding_key: `${category}:${String(targetId ?? "summary").slice(0, 200)}`,
    project_id: overrides.project_id ?? null,
    category,
    severity: overrides.severity ?? DRIFT_RULES.severity[category] ?? "low",
    confidence: boundConfidence(overrides.confidence, DRIFT_RULES.confidence[category] ?? 0.5),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(0, DRIFT_RULES.bounds.maxEvidence),
    affected_goals: dedupe(affectedGoals),
    affected_milestones: dedupe(affectedMilestones),
    recommendation: clip(recommendation, DRIFT_RULES.bounds.recommendationChars),
    status: "open",
  };
}

// ---------------------------------------------------------------------------
// analyzeDrift
// ---------------------------------------------------------------------------

export async function analyzeDrift({ project_id, limit, _load } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, project_id: project_id ?? null, findings: [], count: 0, persisted: 0,
      degraded: ["valid project_id required"], note: SAFETY_NOTE };
  }
  const pid = project_id.trim();
  const n = clampLimit(limit, DRIFT_RULES.bounds.defaultLimit, DRIFT_RULES.bounds.maxLimit);
  const b = DRIFT_RULES.bounds;
  const degraded = [];

  // --- authoritative, project-scoped, bounded reads ------------------------
  const [goalRes, taskRes, milestoneRes, snapshotRes, impactRes] = await Promise.all([
    safeQuery(
      `SELECT id, title, status, goal_type, priority, success_criteria, target_date, updated_at
         FROM dev_goal WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxGoals], "dev_goal", degraded),
    safeQuery(
      `SELECT id, goal_id, task_key, title, status, evidence, dependencies, attempts, result_ref, updated_at
         FROM dev_task WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxTasks], "dev_task", degraded),
    safeQuery(
      `SELECT id, milestone_key, goal_id, title, status, success_criteria, target_date, priority, evidence, updated_at
         FROM pm_milestone WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [pid, b.maxMilestones], "pm_milestone", degraded),
    safeQuery(
      `SELECT id, goal_id, milestone_id, task_id, status, summary, created_at
         FROM pm_progress_snapshot WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [pid, b.maxSnapshots], "pm_progress_snapshot", degraded),
    safeQuery(
      `SELECT id, analysis_type, version_hash, confidence, status, result, created_at
         FROM code_analysis WHERE project_id=$1 AND analysis_type='impact'
         ORDER BY created_at DESC, id DESC LIMIT $2`,
      [pid, b.maxImpact], "code_analysis.impact", degraded),
  ]);

  // Fail closed when the authoritative sources cannot be read (e.g. DB down).
  const criticalOk = !goalRes.error && !taskRes.error && !milestoneRes.error;
  if (!criticalOk) {
    return { ok: false, project_id: pid, findings: [], count: 0, persisted: 0,
      degraded, note: SAFETY_NOTE };
  }

  const goals = goalRes.rows;
  const tasks = taskRes.rows;
  const milestones = milestoneRes.rows;
  const snapshots = snapshotRes.rows;
  const goalById = new Map(goals.map((g) => [String(g.id), g]));
  const activeStatuses = DRIFT_RULES.activeGoalStatuses;
  const unfinishedStatuses = DRIFT_RULES.unfinishedTaskStatuses;
  const isActiveGoal = (g) => Boolean(g) && activeStatuses.includes(String(g.status));
  const unfinishedTasks = tasks.filter((t) => unfinishedStatuses.includes(String(t.status)));

  const latestSnapByTask = new Map();
  const latestSnapByMilestone = new Map();
  for (const s of snapshots) {
    if (nonEmptyString(s.task_id) && !latestSnapByTask.has(String(s.task_id))) latestSnapByTask.set(String(s.task_id), s);
    if (nonEmptyString(s.milestone_id) && !latestSnapByMilestone.has(String(s.milestone_id))) latestSnapByMilestone.set(String(s.milestone_id), s);
  }

  const findings = [];
  const push = (f) => { if (findings.length < b.maxFindings) findings.push({ ...f, project_id: pid }); };

  // --- best-effort sibling loads (never required) --------------------------
  let activeDecisions = [];
  try {
    const di = await loadWith("decisionIntel", _load);
    if (di?.getDecisions) {
      const dr = await di.getDecisions({ project_id: pid, status: "active", limit: 10 });
      if (dr?.ok && Array.isArray(dr.decisions)) activeDecisions = dr.decisions;
    } else degraded.push("decisionIntel: unavailable");
  } catch (e) { degraded.push(`decisionIntel: ${short(e)}`); }

  let phase23ArchitectureFindings = [];
  try {
    const pi = await loadWith("projectIntelligence", _load);
    if (pi?.projectReport) {
      const pr = await pi.projectReport({ project_id: pid, report_type: "all", limit: 20 });
      if (pr?.ok && Array.isArray(pr.findings)) {
        phase23ArchitectureFindings = pr.findings
          .filter((f) => /architect|decision|fragile|outdated/i.test(String(f?.category ?? "")))
          .slice(0, 10);
      }
    } else degraded.push("projectIntelligence: unavailable");
  } catch (e) { degraded.push(`projectIntelligence: ${short(e)}`); }

  // Phase 25 changeImpact evidence is produced into code_analysis. Load the
  // module best-effort (availability only); the impact rows above are the evidence.
  const ci = await loadWith("changeImpact", _load);
  if (!ci) degraded.push("changeImpact: unavailable");

  // --- 1. orphan_work + 6. scope_growth ------------------------------------
  const orphanTasks = [];
  for (const t of unfinishedTasks) {
    const gid = nonEmptyString(t.goal_id) ? String(t.goal_id) : "";
    const goal = gid ? goalById.get(gid) : null;
    if (isActiveGoal(goal)) continue;
    orphanTasks.push(t);
    const ev = evidenceFor(t, "dev_task",
      `task ${t.task_key} status=${t.status} goal_id=${gid || "(none)"} ` +
      `${goal ? `goal_status=${goal.status}` : "goal not found in project"}`);
    const snap = latestSnapByTask.get(String(t.id));
    if (snap) ev.push({ source: "pm_progress_snapshot", excerpt: clip(`latest snapshot status=${snap.status}`, b.excerptChars) });
    push(makeFinding("orphan_work", t.id, ev, gid ? [gid] : [], [],
      "Review this unfinished task: link it to an active goal or record why it is intentionally standalone.",
      { severity: DRIFT_RULES.severity.orphan_work }));
  }
  if (unfinishedTasks.length >= DRIFT_RULES.thresholds.scopeGrowthMinTasks) {
    const ratio = unfinishedTasks.length ? orphanTasks.length / unfinishedTasks.length : 0;
    if (ratio >= DRIFT_RULES.thresholds.scopeGrowthRatio && orphanTasks.length >= DRIFT_RULES.thresholds.scopeGrowthMinTasks) {
      push(makeFinding("scope_growth", "summary", [{
        source: "dev_task", excerpt: clip(`${orphanTasks.length}/${unfinishedTasks.length} unfinished tasks have no active goal`, b.excerptChars),
      }], [], [], "Review scope: most unfinished work sits outside active goals; confirm intent or re-scope deliberately."));
    }
  }

  // --- 2. goal_without_work + 7. missing_success_criteria (goals) -----------
  const activeGoals = goals.filter(isActiveGoal);
  for (const g of activeGoals) {
    const linked = unfinishedTasks.filter((t) => String(t.goal_id ?? "") === String(g.id));
    if (linked.length === 0) {
      push(makeFinding("goal_without_work", g.id,
        evidenceFor(g, "dev_goal", `active goal ${g.title} has no unfinished tasks`),
        [String(g.id)], [],
        "Review this active goal: prepare concrete tasks or pause/close it explicitly; no work was created automatically."));
    }
    if (!hasSuccessCriteria(g.success_criteria)) {
      push(makeFinding("missing_success_criteria", `goal:${g.id}`,
        evidenceFor(g, "dev_goal", `active goal ${g.title} has no success_criteria`),
        [String(g.id)], [],
        "Define explicit, verifiable success criteria for this active goal before relying on progress claims."));
    }
  }

  // --- 5. repeated_deferral --------------------------------------------------
  const deferralRe = /defer|postpon|reschedul|push(?:ed)?\s+back|not\s+yet|later/i;
  for (const t of unfinishedTasks) {
    const arr = Array.isArray(t.evidence) ? t.evidence : [];
    let count = 0;
    for (const item of arr) {
      if (deferralRe.test(typeof item === "string" ? item : JSON.stringify(item ?? {}))) count += 1;
    }
    if (count >= DRIFT_RULES.thresholds.deferredEvidenceCount) {
      push(makeFinding("repeated_deferral", t.id, evidenceFor(t, "dev_task",
        `task ${t.task_key} recorded ${count} deferral markers`), [], [],
        `Review repeated deferral of task ${t.task_key}: decide to proceed, re-scope or cancel; nothing was changed automatically.`));
    }
  }

  // --- 3. decision_conflict --------------------------------------------------
  if (activeDecisions.length) {
    const conflictRe = /conflict|violat|outdated_decision|contradict/i;
    for (const t of unfinishedTasks) {
      const text = `${String(t.title ?? "")} ${JSON.stringify(Array.isArray(t.evidence) ? t.evidence : [])}`;
      let matched = null;
      for (const d of activeDecisions) {
        const idRef = nonEmptyString(d.id) && text.includes(String(d.id));
        const titleRef = nonEmptyString(d.title) && text.toLowerCase().includes(String(d.title).toLowerCase());
        if ((idRef || titleRef) && conflictRe.test(text)) { matched = d; break; }
      }
      if (matched) {
        push(makeFinding("decision_conflict", t.id, [
          { source: "dev_task", excerpt: clip(`task ${t.task_key} references active decision ${matched.title}`, b.excerptChars) },
          { source: "technical_decision", excerpt: clip(`decision ${matched.id} status=active`, b.excerptChars) },
        ], [], [], "Review the apparent conflict with an active decision; do not silently supersede the decision."));
      }
    }
  }

  // --- 4/7. stale_milestone + milestone success criteria --------------------
  const now = Date.now();
  for (const m of milestones) {
    const status = String(m.status ?? "planned");
    const terminal = DRIFT_RULES.terminalMilestoneStatuses.includes(status);
    const risky = DRIFT_RULES.riskyMilestoneStatuses.includes(status);
    const target = m.target_date ? new Date(m.target_date) : null;
    const passed = Boolean(target && !Number.isNaN(target.getTime()) && target.getTime() < now);
    if (!terminal && (risky || passed)) {
      const ev = evidenceFor(m, "pm_milestone",
        `milestone ${m.milestone_key} status=${status} target_date=${m.target_date ?? "(none)"}${passed ? " (past)" : ""}`);
      const snap = latestSnapByMilestone.get(String(m.id));
      if (snap) ev.push({ source: "pm_progress_snapshot", excerpt: clip(`latest snapshot status=${snap.status}`, b.excerptChars) });
      push(makeFinding("stale_milestone", m.id, ev, nonEmptyString(m.goal_id) ? [String(m.goal_id)] : [], [String(m.id)],
        "Review this milestone: refresh target/status with evidence or re-plan; no status was changed automatically.",
        { severity: passed ? "high" : DRIFT_RULES.severity.stale_milestone }));
    }
    if (!terminal && !hasSuccessCriteria(m.success_criteria)) {
      push(makeFinding("missing_success_criteria", `milestone:${m.id}`,
        evidenceFor(m, "pm_milestone", `milestone ${m.milestone_key} has no success_criteria`),
        nonEmptyString(m.goal_id) ? [String(m.goal_id)] : [], [String(m.id)],
        "Define explicit, verifiable success criteria for this milestone before claiming completion."));
    }
  }

  // --- 8. architecture_effect (Phase 25 impact + Phase 23 findings) ---------
  const staleImpacts = impactRes.rows.filter((r) => {
    let result = r.result;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { result = {}; } }
    const isStale = result && (result.stale === true || String(result.stale) === "true");
    const lowConfidence = Number(r.confidence) < 0.6;
    return isStale || lowConfidence;
  });
  if (staleImpacts.length || phase23ArchitectureFindings.length) {
    const ev = [
      { source: "code_analysis.impact", excerpt: clip(`${staleImpacts.length} stale/low-confidence impact analyses`, b.excerptChars) },
      { source: "project_finding", excerpt: clip(`${phase23ArchitectureFindings.length} architecture-related Phase 23 findings`, b.excerptChars) },
    ];
    for (const r of staleImpacts.slice(0, 2)) {
      ev.push({ source: "code_analysis.impact", excerpt: clip(`analysis ${r.id} version=${r.version_hash ?? "none"} confidence=${r.confidence}`, b.excerptChars) });
    }
    push(makeFinding("architecture_effect", "summary", ev, [], [],
      "Review architecture evidence: stale or weak impact analysis may affect current plans; re-index/re-analyze before relying on it."));
  }

  // --- idempotent persistence (no auto-rewrite of source records) -----------
  let persisted = 0;
  for (const f of findings) {
    try {
      const r = await core.dbQuery(
        `INSERT INTO pm_drift_finding
           (id, project_id, finding_key, category, severity, confidence, status,
            evidence, affected_goals, affected_milestones, recommendation)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7::jsonb,$8::jsonb,$9::jsonb,$10)
         ON CONFLICT (project_id, finding_key) DO NOTHING`,
        [crypto.randomUUID(), pid, f.finding_key, f.category, f.severity, f.confidence,
          JSON.stringify(f.evidence), JSON.stringify(f.affected_goals),
          JSON.stringify(f.affected_milestones), f.recommendation],
      );
      if (r.rowCount) persisted += 1;
    } catch (e) { degraded.push(`persist: ${short(e)}`); }
  }

  await audit("p26.drift.analyze", pid, {
    findings: findings.length, persisted, degraded: degraded.slice(0, 10),
  });

  return {
    ok: true, project_id: pid, findings: findings.slice(0, n), count: findings.length,
    persisted, degraded, note: SAFETY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// listDrift / setDriftStatus
// ---------------------------------------------------------------------------

export async function listDrift({ project_id, status, category, limit } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, items: [], findings: [], count: 0, degraded: ["valid project_id required"], note: SAFETY_NOTE };
  }
  const pid = project_id.trim();
  const n = clampLimit(limit, DRIFT_RULES.bounds.defaultLimit, DRIFT_RULES.bounds.maxLimit);
  const degraded = [];
  const r = await safeQuery(
    `SELECT id, finding_key, category, severity, confidence, status, evidence,
            affected_goals, affected_milestones, recommendation, created_at, updated_at
       FROM pm_drift_finding
      WHERE project_id=$1
        AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR category=$3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [pid, nonEmptyString(status) ? String(status).slice(0, 40) : null,
      nonEmptyString(category) ? String(category).slice(0, 60) : null, n],
    "pm_drift_finding", degraded,
  );
  const items = r.rows;
  await audit("p26.drift.list", pid, { count: items.length, status: status ?? null, category: category ?? null });
  return { ok: !r.error, project_id: pid, items, findings: items, count: items.length, degraded, note: SAFETY_NOTE };
}

export async function setDriftStatus({ project_id, finding_key, status, actor } = {}) {
  if (!validProject(project_id) || !nonEmptyString(finding_key) || !DRIFT_STATUSES.includes(status) || !nonEmptyString(actor)) {
    return { ok: false, changed: false, reason: "valid project_id, finding_key, status and actor are required",
      note: SAFETY_NOTE };
  }
  const pid = project_id.trim();
  const degraded = [];
  try {
    const r = await core.dbQuery(
      `UPDATE pm_drift_finding SET status=$3, updated_at=now()
        WHERE project_id=$1 AND finding_key=$2`,
      [pid, String(finding_key).slice(0, 260), String(status)],
    );
    await audit("p26.drift.status", pid, { finding_key: String(finding_key).slice(0, 260), status,
      actor: String(actor).slice(0, 120) });
    return { ok: true, changed: r.rowCount > 0, project_id: pid,
      finding_key: String(finding_key).slice(0, 260), status, actor: String(actor).slice(0, 120),
      degraded, note: SAFETY_NOTE };
  } catch (e) {
    degraded.push(`setDriftStatus: ${short(e)}`);
    return { ok: false, changed: false, project_id: pid, finding_key, status,
      actor: String(actor).slice(0, 120), degraded, note: SAFETY_NOTE };
  }
}

export default {
  DRIFT_CATEGORIES, DRIFT_SEVERITIES, DRIFT_STATUSES, DRIFT_RULES, SAFETY_NOTE,
  analyzeDrift, listDrift, setDriftStatus,
};
