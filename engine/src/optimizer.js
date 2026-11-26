// Stage 10.5: context-aware, evidence-based strategy selection and autonomy controls.
// The engine NEVER executes code itself; it prepares, approves and records actions.
import crypto from "node:crypto";
import * as core from "./core.js";

const LEVELS = { 1: "OBSERVE", 2: "RECOMMEND", 3: "CONTROLLED_EXECUTION" };

export function currentLevel() {
  const env = core.loadEnv();
  const n = Number(process.env.OPTIMIZATION_LEVEL || env.OPTIMIZATION_LEVEL || 1);
  return { level: [1, 2, 3].includes(n) ? n : 1, name: LEVELS[n] || "OBSERVE" };
}

export async function analyzeTask({ project_id, description, task_type, language, framework, error_category, session_id } = {}) {
  if (!description) throw new Error("description required");
  const context = {
    project_id: project_id || "_global", description: String(description).slice(0, 2000),
    task_type: task_type || "general", language: language || null, framework: framework || null,
    error_category: error_category || null, session_id: session_id || null,
  };
  const relevant = await core.searchMemory({
    query: `${context.description} ${context.error_category || ""} ${context.framework || ""}`.trim(),
    project_id: context.project_id, limit: 6,
  });
  const strategies = (await core.dbQuery(
    `SELECT strategy_key, version, active, definition FROM strategy_versions WHERE active=true ORDER BY strategy_key,version DESC`)).rows;
  const audited = await core.dbQuery(
    `INSERT INTO intelligence_audit_events (track,action,resource,detail) VALUES ('optimization','task_analysis',$1,$2::jsonb) RETURNING id`,
    [session_id || null, JSON.stringify(context)]);
  return { ok: true, context, relevant_memories: relevant.map((m) => ({ id: m.id, title: m.title, score: m.score })), available_strategies: strategies, audit_id: audited.rows[0].id };
}

export async function recommendStrategy({ context, strategy_key, min_samples = 3 } = {}) {
  const lvl = currentLevel();
  if (lvl.level < 2) return { ok: false, reason: "permission level 1 (OBSERVE) — recommendations disabled", level: lvl };
  const version = (await core.dbQuery("SELECT * FROM strategy_versions WHERE strategy_key=$1 AND active=true ORDER BY version DESC LIMIT 1", [strategy_key])).rows[0];
  if (!version) return { ok: false, reason: "strategy not found or inactive" };
  const results = (await core.dbQuery(
    `SELECT outcome, measurement, metrics FROM strategy_experiment_results WHERE strategy_key=$1`, [strategy_key])).rows;
  const observed = results.filter((x) => x.measurement === "observed");
  const success = observed.filter((x) => x.outcome === "success").length;
  const confidence = observed.length >= min_samples ? Math.min(0.9, 0.4 + success / observed.length * 0.5) : 0.3;
  const projectMatch = version.definition?.project_id && version.definition.project_id !== (context?.project_id || "_global");
  const rec = {
    ok: true, strategy_key, version: version.version,
    recommendation: projectMatch ? "not recommended outside its evidence environment" : "candidate strategy — review evidence before use",
    reason: `${observed.length} observed result(s), ${success} success(es); ${observed.length < min_samples ? "below sample threshold" : "sample threshold met"}`,
    confidence: Number(confidence.toFixed(3)), sample_size: observed.length,
    evidence: observed.slice(0, 10).map((x) => ({ outcome: x.outcome, metrics: x.metrics })),
    baseline_required: true, permission_level: lvl.level, auto_execute: false,
    ai_assessment: await aiAssessment(strategy_key, rec.evidence),
  };
  await core.dbQuery(
    `INSERT INTO optimization_recommendations (session_id,project_id,task_id,task_type,category,recommendation,reason,evidence,confidence,sample_size,permission_level,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'pending')`,
    [context?.session_id || null, context?.project_id || null, context?.task_id || null,
     context?.task_type || null, "strategy", rec.recommendation, rec.reason, JSON.stringify(rec.evidence),
     rec.confidence, rec.sample_size, lvl.level],
  );
  await core.audit("optimization.recommend", strategy_key, { confidence: rec.confidence, samples: rec.sample_size });
  return rec;
}

// Optional AI assessment attached to a recommendation. It cannot change confidence,
// permission level, approval status, or trigger execution.
async function aiAssessment(strategy_key, evidence) {
  try {
    const llm = await import("./llm-provider.js");
    const r = await llm.runTask("strategy_evaluation", { strategy_key, evidence });
    return r.ok ? { candidate: r.data, usage: r.usage } : { unavailable: r.kind || "error" };
  } catch { return { unavailable: "error" }; }
}

export async function getRecommendations({ status = "pending", limit = 50 } = {}) {
  return (await core.dbQuery(
    `SELECT * FROM optimization_recommendations WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2`,
    [status || null, Math.min(limit, 200)])).rows;
}

export async function decideRecommendation({ id, decision, actor = "user", note = "" } = {}) {
  if (!["approved","rejected"].includes(decision)) throw new Error("decision must be approved|rejected");
  const lvl = currentLevel();
  if (decision === "approved" && lvl.level < 2) throw new Error("cannot approve at OBSERVE level");
  const r = await core.dbQuery(
    `UPDATE optimization_recommendations SET status=$2, decided_at=now(), decided_by=$3 WHERE id=$1 AND status='pending' RETURNING id`,
    [id, decision, actor]);
  if (!r.rowCount) throw new Error("recommendation not pending or not found");
  await core.dbQuery("INSERT INTO intelligence_audit_events (track,action,resource,detail) VALUES ('optimization',$1,$2,$3::jsonb)",
    [decision, id, JSON.stringify({ actor, note, level: lvl.level })]);
  return { ok: true, id, status: decision };
}

const LOW_RISK = new Set(["run_tests","read_file","inspect","summarize","check_status"]);

export async function prepareAction({ recommendation_id, action, result = {}, rollback_info = {} } = {}) {
  const lvl = currentLevel();
  if (lvl.level < 3) return { ok: false, reason: "CONTROLLED_EXECUTION requires level 3", level: lvl };
  if (!LOW_RISK.has(action)) throw new Error(`action '${action}' is not in the low-risk allowlist and needs explicit approval`);
  const rec = await core.dbQuery("SELECT status FROM optimization_recommendations WHERE id=$1", [recommendation_id]);
  if (!rec.rowCount || rec.rows[0].status !== "approved") throw new Error("recommendation must be approved before execution");
  const r = await core.dbQuery(
    `INSERT INTO optimization_actions (recommendation_id,action,status,result,rollback_info)
     VALUES ($1,$2,'planned',$3::jsonb,$4::jsonb) RETURNING id`,
    [recommendation_id, action, JSON.stringify(result), JSON.stringify(rollback_info)],
  );
  await core.audit("optimization.action_prepared", recommendation_id, { action });
  return { ok: true, action_id: r.rows[0].id, status: "planned", note: "engine does not execute; execution must be performed by the user or an authorized harness path" };
}

export async function recordActionResult({ action_id, status, result = {}, rollback_info = {}, executed_by = "user" } = {}) {
  if (!["executed","validated","failed","rolled_back"].includes(status)) throw new Error("invalid action status");
  await core.dbQuery(
    `UPDATE optimization_actions SET status=$2, result=$3::jsonb, rollback_info=CASE WHEN $4::jsonb='{}'::jsonb THEN rollback_info ELSE $4::jsonb END WHERE id=$1`,
    [action_id, status, JSON.stringify(result), JSON.stringify(rollback_info)],
  );
  await core.audit("optimization.action_result", action_id, { status, executed_by });
  return { ok: true, action_id, status };
}

export async function autonomyStatus() {
  const lvl = currentLevel();
  const recs = (await core.dbQuery("SELECT status, count(*)::int n FROM optimization_recommendations GROUP BY 1")).rows;
  const acts = (await core.dbQuery("SELECT status, count(*)::int n FROM optimization_actions GROUP BY 1")).rows;
  const audit = (await core.dbQuery("SELECT action, resource, detail, created_at FROM intelligence_audit_events WHERE track='optimization' ORDER BY created_at DESC LIMIT 20")).rows;
  return { ok: true, level: lvl, recommendations: recs, actions: acts, recent_audit: audit };
}

export async function evaluationReport({ baseline_key = "phase9", candidate_key = "phase10" } = {}) {
  const outcomes = (await core.dbQuery(
    `SELECT measurement, count(*)::int n FROM coding_outcomes GROUP BY 1`)).rows;
  const exps = (await core.dbQuery(
    `SELECT count(*)::int total, count(*) FILTER (WHERE measurement='observed')::int observed FROM strategy_experiment_results`)).rows[0];
  const ret = (await core.dbQuery(
    `SELECT count(*)::int events FROM memory_retrieval_events`)).rows[0];
  const useful = (await core.dbQuery(
    `SELECT signal, count(*)::int n FROM memory_usefulness_observations GROUP BY 1`)).rows;
  return {
    ok: true, baseline_key, candidate_key,
    comparison_available: exps.observed >= 5 && ret.events >= 5,
    note: exps.observed >= 5 && ret.events >= 5 ? "sufficient evidence for comparison" : "insufficient data — more observations needed",
    outcomes_by_measurement: outcomes, experiment_results: exps, retrieval_events: ret.events, usefulness: useful,
  };
}
