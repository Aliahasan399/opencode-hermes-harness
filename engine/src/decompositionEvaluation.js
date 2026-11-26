// Phase 27 — adaptive decomposition (genuine gap) and agent suitability evaluation.
// REUSES Phase 22 agentWorkflowLearning.agentPerformance; no provider favoritism, no
// secrets, no dispatch. Patterns only from sufficient verified evidence; never rewrites plans.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name, _load) {
  if (_load && typeof _load[name] === "function") {
    const r = await _load[name]();
    if (r && typeof r === "object") return r;
    return { [name]: r };
  }
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
const redact = (ev) => (Array.isArray(ev) ? ev.slice(0, 100).map((x) => {
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x)) o[short(k, 80)] = typeof x[k] === "string" ? core.redact(x[k]).slice(0, 400) : x[k];
    return o;
  }
  return core.redact(String(x)).slice(0, 400);
}) : []);

export async function evaluateDecomposition({ project_id, plan_id, task_count, dependency_count,
  ownership_conflicts, review_failures, rework_count, completion_verified, evidence, min_samples, _load } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", degraded };
  if (!plan_id) return { ok: false, reason: "plan_id required", degraded };
  const min = clamp(min_samples, 1, 200, 5);

  // Read REAL outcome evidence from existing authoritative records (bounded, project-scoped).
  let verifiedCount = 0;
  let executionRows = 0;
  try {
    const v = await core.dbQuery(
      `SELECT count(*)::int AS n FROM workflow_verification WHERE project_id=$1 AND verified=true
         AND ($2::text IS NULL OR run_id=$2)`, [project_id, null]);
    verifiedCount = v.rows[0]?.n || 0;
    const e = await core.dbQuery(
      `SELECT count(*)::int AS n FROM agent_execution WHERE project_id=$1 AND ($2::text IS NULL OR plan_id=$2)`,
      [project_id, String(plan_id)]);
    executionRows = e.rows[0]?.n || 0;
  } catch (err) { degraded.push(`outcome read: ${short(err?.message || err, 100)}`); }
  const sample_size = verifiedCount + executionRows;
  const insufficient_evidence = sample_size < min;

  let evaluation = "insufficient_evidence";
  const findings = [];
  if (!insufficient_evidence) {
    if (Number(rework_count) > 0 && Number(task_count) > 0) {
      findings.push({ kind: "rework", detail: "rework observed after decomposition", sample_size });
    }
    if (Number(ownership_conflicts) > 0) {
      findings.push({ kind: "ownership_conflict", detail: "file ownership conflicts in plan", sample_size });
    }
    if (Number(review_failures) > 0) {
      findings.push({ kind: "review_failure", detail: "review failures recorded", sample_size });
    }
    evaluation = completion_verified && findings.length === 0 ? "effective" : "needs_review";
  }

  try {
    const ins = await core.dbQuery(
      `INSERT INTO ai_decomposition_evaluation (id,project_id,plan_id,task_count,dependency_count,
         ownership_conflicts,review_failures,rework_count,completion_verified,evaluation,evidence,sample_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (project_id,plan_id) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), project_id, short(plan_id, 300), clamp(task_count, 0, 10000, 0),
        clamp(dependency_count, 0, 10000, 0), clamp(ownership_conflicts, 0, 10000, 0),
        clamp(review_failures, 0, 10000, 0), clamp(rework_count, 0, 10000, 0), completion_verified === true,
        evaluation, JSON.stringify({ findings, evidence: redact(evidence) }), sample_size]);
    await audit("p27.decomposition.evaluate", project_id, { plan_id: short(plan_id, 60), evaluation });
    return { ok: true, id: ins.rows[0]?.id || null, duplicate: ins.rowCount === 0, evaluation,
      findings, sample_size, insufficient_evidence,
      note: insufficient_evidence
        ? `only ${sample_size} verified outcome record(s); no decomposition claim made`
        : "Pattern from verified evidence only; no project plan was changed.", degraded };
  } catch (e) { return { ok: false, reason: `persist: ${short(e?.message || e, 140)}`, degraded }; }
}

/** Reuses Phase 22 agentWorkflowLearning.agentPerformance; unknown when evidence is thin. */
export async function agentSuitability({ project_id, agent, task_category, min_samples, _load } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", degraded };
  if (!agent) return { ok: false, reason: "agent required", degraded };
  const min = clamp(min_samples, 1, 200, 5);
  const mod = await load("agentWorkflowLearning", _load);
  if (!mod?.agentPerformance) return { ok: false, reason: "agent performance unavailable", degraded,
    note: "No suitability claim without measured evidence." };
  let perf;
  try { perf = await mod.agentPerformance({ project_id, agent, limit: 100 }); }
  catch (e) { return { ok: false, reason: `agentPerformance: ${short(e?.message || e, 120)}`, degraded }; }
  const items = perf?.items || perf?.reviews || perf?.results || [];
  const sample_size = Array.isArray(items) ? items.length : (Number(perf?.count) || 0);
  if (sample_size < min) {
    return { ok: true, agent, task_category: task_category || "unknown", sample_size,
      suitability: "unknown", insufficient_evidence: true, degraded,
      note: "Below minimum task-specific sample threshold; existing selection behavior should be preserved." };
  }
  const accepted = items.filter((x) => ["accepted", "success", "verified"].includes(String(x?.verdict || x?.status || "").toLowerCase())).length;
  return { ok: true, agent, task_category: task_category || "unknown", sample_size,
    suitability: accepted / sample_size >= 0.6 ? "favorable" : "mixed", insufficient_evidence: false,
    evidence: { accepted, sample_size }, degraded,
    note: "Task-category evidence only; one success never proves suitability and no dispatch is performed." };
}

export async function getDecompositionEvaluation({ project_id, plan_id } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", item: null };
  try {
    const r = await core.dbQuery(
      "SELECT * FROM ai_decomposition_evaluation WHERE project_id=$1 AND plan_id=$2 LIMIT 1",
      [project_id, String(plan_id || "")]);
    return { ok: r.rowCount > 0, item: r.rows[0] || null };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), item: null }; }
}

export default { evaluateDecomposition, agentSuitability, getDecompositionEvaluation };
