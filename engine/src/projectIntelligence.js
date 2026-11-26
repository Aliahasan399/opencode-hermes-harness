// Phase 23 facade: incremental, evidence-backed proactive project intelligence.
// ANALYSIS / RECOMMENDATION / TASK PREPARATION ONLY. No source edits, no package
// upgrades, no destructive operations, no autonomous dispatch. All capabilities
// are optional dynamic imports and degrade independently.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v ?? {})).digest("hex");

/** Incremental project analysis keyed by (project, component, content hash). */
export async function analyzeProject({ project_id, components = [], evidence = {}, force = false,
  session_id } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const scope = Array.isArray(components) && components.length ? components : ["_project"];
  const results = [];
  let skipped = 0;

  for (const component of scope.slice(0, 30)) {
    const ch = hash({ component, evidence: evidence[component] ?? evidence });
    if (!force) {
      const prior = await core.dbQuery(
        "SELECT id,status FROM project_analysis_state WHERE project_id=$1 AND component=$2 AND content_hash=$3",
        [project_id, String(component), ch]);
      if (prior.rowCount && prior.rows[0].status === "done") { skipped += 1; continue; }
    }
    const ledger = await core.dbQuery(
      `INSERT INTO project_analysis_state (project_id,component,content_hash,status,attempts)
       VALUES ($1,$2,$3,'processing',1)
       ON CONFLICT (project_id,component,content_hash) DO UPDATE SET status='processing',
         attempts=project_analysis_state.attempts+1, analyzed_at=now()
       RETURNING id`, [project_id, String(component), ch]);

    const part = { component: String(component), analyses: {} };
    const [health, debt, risk, tq, deps] = await Promise.all([
      load("projectHealth"), load("technicalDebt"), load("projectRisk"),
      load("testQuality"), load("dependencyRisk"),
    ]);
    const ev = evidence[component] ?? evidence;
    try {
      if (health?.analyzeProjectHealth) part.analyses.health = await health.analyzeProjectHealth({
        project_id, components: [component], evidence: ev, limit: 20 });
      else degraded.push("projectHealth: unavailable");
    } catch (e) { degraded.push(`health: ${short(e?.message || e, 100)}`); }
    try {
      if (debt?.detectDebt) part.analyses.debt = await debt.detectDebt({
        project_id, components: [component], evidence: ev, limit: 20 });
      else degraded.push("technicalDebt: unavailable");
    } catch (e) { degraded.push(`debt: ${short(e?.message || e, 100)}`); }
    try {
      if (risk?.predictFragility) part.analyses.risk = await risk.predictFragility({
        project_id, evidence: ev, limit: 20 });
      else degraded.push("projectRisk: unavailable");
    } catch (e) { degraded.push(`risk: ${short(e?.message || e, 100)}`); }
    try {
      if (tq?.analyzeTestQuality) part.analyses.test_quality = await tq.analyzeTestQuality({
        project_id, modules: [component], tests: ev.tests || [], history: ev.history || [],
        evidence: ev, limit: 20 });
      else degraded.push("testQuality: unavailable");
    } catch (e) { degraded.push(`test_quality: ${short(e?.message || e, 100)}`); }
    try {
      if (deps?.analyzeDependencies) part.analyses.dependencies = await deps.analyzeDependencies({
        project_id, edges: ev.edges || [], evidence: ev, limit: 20 });
      else degraded.push("dependencyRisk: unavailable");
    } catch (e) { degraded.push(`dependencies: ${short(e?.message || e, 100)}`); }

    try {
      const rec = await load("recommendationEngine");
      const findings = [
        ...(part.analyses.debt?.findings || []),
        ...(part.analyses.test_quality?.gaps || []),
        ...(part.analyses.risk?.predictions || []),
      ];
      part.recommendations = rec?.buildRecommendations
        ? await rec.buildRecommendations({ project_id, findings, limit: 10 })
        : { ok: true, recommendations: [] };
    } catch (e) { degraded.push(`recommendations: ${short(e?.message || e, 100)}`); }

    await core.dbQuery(
      `UPDATE project_analysis_state SET status='done',result=$2::jsonb,analyzed_at=now()
        WHERE id=$1`, [ledger.rows[0].id, JSON.stringify({ component: part.component,
          analyses: Object.keys(part.analyses), recommendations: part.recommendations?.recommendations?.length || 0 })]);
    results.push(part);
  }

  await core.audit("project.analysis", project_id, {
    components: results.length, skipped, degraded: degraded.slice(0, 10), session_id: session_id || null });
  return { ok: true, project_id, analyzed: results.length, skipped, results, degraded,
    note: "Analysis only. No source, dependency or architecture changes were made." };
}

/** Bounded unified report. Unknown areas are explicit, never assumed healthy. */
export async function projectReport({ project_id, report_type = "all", component, limit = 50 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const n = Math.max(1, Math.min(Number(limit) || 50, 200));
  const q = async (sql, params) => {
    try { return (await core.dbQuery(sql, params)).rows; } catch { return []; }
  };
  const filter = component ? ` AND component=$2` : "";
  const params = component ? [project_id, String(component), n] : [project_id, n];
  const [assessments, findings, predictions, recommendations] = await Promise.all([
    q(`SELECT id,component,dimensions,unknown_areas,created_at FROM project_assessment WHERE project_id=$1${filter} ORDER BY created_at DESC LIMIT $3`, params),
    q(`SELECT id,component,category,severity,status,confidence,evidence,last_observed FROM project_finding WHERE project_id=$1${filter} ORDER BY last_observed DESC LIMIT $3`, params),
    q(`SELECT id,component,risk_category,severity,confidence,status,review_status,created_at FROM project_prediction WHERE project_id=$1${filter} ORDER BY created_at DESC LIMIT $3`, params),
    q(`SELECT id,category,priority,status,confidence,description FROM engineering_recommendation WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`, [project_id, n]),
  ]);
  const report = { ok: true, project_id, component: component || null, report_type,
    assessments, findings, predictions, recommendations,
    unknown_areas: [...new Set(assessments.flatMap((a) => Array.isArray(a.unknown_areas) ? a.unknown_areas : []))],
    note: "Evidence-backed observations. Unknown means insufficient evidence, not healthy." };
  if (report_type === "roadmap" || report_type === "all") {
    const rm = await load("engineeringRoadmap");
    if (rm?.buildRoadmap) {
      try { report.roadmap = await rm.buildRoadmap({ project_id, recommendations, limit: n }); }
      catch { /* optional */ }
    }
  }
  return report;
}

/** Prepare (never dispatch) engineering tasks from an accepted recommendation via Phase 22. */
export async function prepareEngineeringTasks({ project_id, recommendation_id, request, limit = 8 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const rows = await core.dbQuery(
    "SELECT id,description,steps,status FROM engineering_recommendation WHERE id=$1 AND project_id=$2",
    [recommendation_id, project_id]);
  if (!rows.rowCount) return { ok: false, reason: "recommendation not found in project scope" };
  const rec = rows.rows[0];
  if (!["accepted", "reviewed", "proposed"].includes(rec.status)) {
    return { ok: false, reason: "recommendation is not eligible for task preparation" };
  }
  const orch = await load("agentOrchestrator");
  if (!orch?.orchestrate) return { ok: false, reason: "orchestration unavailable" };
  const prepared = await orch.orchestrate({ project_id,
    request: request || rec.description || "engineering improvement",
    context: { refs: [rec.id], steps: Array.isArray(rec.steps) ? rec.steps : [] } });
  return { ok: prepared.ok, recommendation_id: rec.id, plan_id: prepared.plan_id,
    tasks: prepared.tasks || [], note: "Plan prepared only; no agent was dispatched and no code was changed." };
}

export async function analysisStatus({ project_id, status, limit = 50 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const r = await core.dbQuery(
    `SELECT id,component,status,attempts,error,analyzed_at FROM project_analysis_state
      WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY analyzed_at DESC LIMIT $3`, [project_id, status || null, Math.min(limit, 200)]);
  return { ok: true, items: r.rows, count: r.rows.length };
}

export async function retryAnalysis({ limit = 20 } = {}) {
  const r = await core.dbQuery(
    `SELECT id,project_id,component,content_hash FROM project_analysis_state
      WHERE status IN ('pending','failed') ORDER BY analyzed_at LIMIT $1`, [Math.min(limit, 100)]);
  let retried = 0;
  for (const row of r.rows) {
    try {
      const res = await analyzeProject({ project_id: row.project_id, components: [row.component], force: true });
      if (res.ok) retried += 1;
    } catch { /* best effort */ }
  }
  return { ok: true, attempted: r.rowCount, retried };
}

export default { analyzeProject, projectReport, prepareEngineeringTasks, analysisStatus, retryAnalysis };
