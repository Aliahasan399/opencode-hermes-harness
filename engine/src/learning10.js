// Stages 10.3-10.4: evidence-driven outcome observation and strategy experimentation.
import crypto from "node:crypto";
import * as core from "./core.js";

const MEASUREMENTS = ["observed","estimated","missing"];

export async function recordTask({ session_id, project_id, description, task_type, language, framework, task_id } = {}) {
  if (!description) throw new Error("description required");
  const id = task_id || `task-${crypto.randomUUID()}`;
  await core.dbQuery(
    `INSERT INTO coding_tasks (id,session_id,project_id,description,task_type,language,framework,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'observed') ON CONFLICT (id) DO NOTHING`,
    [id, session_id || null, project_id || null, String(description).slice(0, 4000), task_type || null, language || null, framework || null],
  );
  await core.audit("learning.task", id, { project_id });
  return { ok: true, task_id: id };
}

export async function recordAttempt({ task_id, strategy_id, approach, duration_ms, retry_number = 0 } = {}) {
  const r = await core.dbQuery(
    `INSERT INTO coding_attempts (task_id,strategy_id,approach,duration_ms,retry_number,started_at,finished_at)
     VALUES ($1,$2,$3,$4,$5,now() - ($6::bigint || ' milliseconds')::interval, now()) RETURNING id`,
    [task_id, strategy_id || null, String(approach || "").slice(0, 2000),
     Number.isFinite(duration_ms) ? Math.max(0, Math.round(duration_ms)) : null, retry_number | 0,
     Number.isFinite(duration_ms) ? Math.max(0, Math.round(duration_ms)) : 0],
  );
  return { ok: true, attempt_id: r.rows[0].id };
}

// Missing metrics are recorded as missing, never inferred or invented.
export async function recordOutcome({ task_id, attempt_id, metric, value, measurement = "observed", evidence = {} } = {}) {
  if (!MEASUREMENTS.includes(measurement)) throw new Error("invalid measurement");
  await core.dbQuery(
    `INSERT INTO coding_outcomes (task_id,attempt_id,metric,value,measurement,evidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [task_id, attempt_id || null, metric, String(value ?? ""), measurement, JSON.stringify(evidence)],
  );
  await core.audit("learning.outcome", task_id, { metric, measurement });
  return { ok: true, metric, measurement };
}

export async function getOutcomes({ task_id, project_id } = {}) {
  const r = await core.dbQuery(
    `SELECT o.metric,o.value,o.measurement,o.evidence,o.recorded_at,t.project_id
     FROM coding_outcomes o JOIN coding_tasks t ON t.id=o.task_id
     WHERE ($1::text IS NULL OR o.task_id=$1) AND ($2::text IS NULL OR t.project_id=$2)
     ORDER BY o.recorded_at DESC LIMIT 200`, [task_id || null, project_id || null]);
  return { ok: true, outcomes: r.rows };
}

export async function createExperiment({ task_context, baseline, alternative, strategy_key, sample_required = 5, limitations = "" } = {}) {
  if (!baseline || !alternative) throw new Error("baseline and alternative required");
  const r = await core.dbQuery(
    `INSERT INTO strategy_experiment (project_id,previous_approach,alternative_approach,result,effort,errors,
       successful,confidence,evidence_sessions,outcome_confirmed,confirmation_count)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,false,0.3,$7::text[],false,0) RETURNING id`,
    [task_context?.project_id || "_global", String(baseline).slice(0, 2000), String(alternative).slice(0, 2000),
     "pending", "not measured", JSON.stringify([]), (task_context?.sessions || []).slice(0, 20)],
  );
  const id = r.rows[0].id;
  await core.dbQuery(
    `INSERT INTO strategy_versions (strategy_key,version,definition,change_note,active)
     VALUES ($1,1,$2::jsonb,$3,true) ON CONFLICT (strategy_key,version) DO NOTHING`,
    [strategy_key || `exp-${id}`, JSON.stringify({ baseline, alternative, sample_required }), "initial experiment"],
  );
  await core.audit("learning.experiment", id, { strategy_key, sample_required });
  return { ok: true, experiment_id: id, strategy_key: strategy_key || `exp-${id}`, sample_required };
}

export async function addExperimentResult({ experiment_id, task_id, strategy_key, strategy_version, outcome, metrics = {}, measurement = "observed", limitations = "" } = {}) {
  if (!["success","failure","inconclusive"].includes(outcome)) throw new Error("invalid outcome");
  if (!MEASUREMENTS.includes(measurement)) throw new Error("invalid measurement");
  await core.dbQuery(
    `INSERT INTO strategy_experiment_results (experiment_id,task_id,strategy_key,strategy_version,outcome,metrics,measurement,limitations)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [experiment_id, task_id || null, strategy_key || null, strategy_version || null, outcome, JSON.stringify(metrics), measurement, limitations || null],
  );
  await core.audit("learning.experiment_result", experiment_id, { outcome, measurement });
  return { ok: true };
}

export async function compareStrategies({ experiment_id, min_samples = 5 } = {}) {
  const r = await core.dbQuery(
    `SELECT outcome, count(*)::int AS n, measurement FROM strategy_experiment_results
     WHERE experiment_id=$1 GROUP BY 1,3`, [experiment_id]);
  const counts = { success: 0, failure: 0, inconclusive: 0 };
  let measured = 0;
  for (const x of r.rows) { counts[x.outcome] += x.n; if (x.measurement === "observed") measured += x.n; }
  const total = counts.success + counts.failure + counts.inconclusive;
  const reliable = total >= min_samples && measured >= min_samples;
  const successRate = total ? Number((counts.success / total).toFixed(3)) : 0;
  return {
    ok: true, experiment_id, samples: total, observed_samples: measured,
    success_rate: successRate, counts,
    claim: reliable ? (successRate > 0.6 ? "evidence-backed improvement" : "no improvement evidence") : "insufficient sample size",
    limitation: reliable ? null : `needs at least ${min_samples} observed results`,
  };
}

export async function createStrategyVersion({ strategy_key, definition, change_note = "" } = {}) {
  const cur = await core.dbQuery("SELECT max(version) AS v FROM strategy_versions WHERE strategy_key=$1", [strategy_key]);
  const version = Number(cur.rows[0].v || 0) + 1;
  await core.dbQuery(
    "INSERT INTO strategy_versions (strategy_key,version,definition,change_note,active) VALUES ($1,$2,$3::jsonb,$4,true)",
    [strategy_key, version, JSON.stringify(definition), change_note],
  );
  await core.audit("learning.strategy_version", strategy_key, { version });
  return { ok: true, strategy_key, version };
}

export async function strategyVersions({ strategy_key } = {}) {
  return (await core.dbQuery("SELECT * FROM strategy_versions WHERE ($1::text IS NULL OR strategy_key=$1) ORDER BY strategy_key,version DESC", [strategy_key || null])).rows;
}

export async function rollbackStrategy({ strategy_key, version } = {}) {
  const r = await core.dbQuery("SELECT id FROM strategy_versions WHERE strategy_key=$1 AND version=$2", [strategy_key, version]);
  if (!r.rowCount) throw new Error("version not found");
  await core.dbQuery("UPDATE strategy_versions SET active=false WHERE strategy_key=$1 AND version>$2", [strategy_key, version]);
  await core.dbQuery("UPDATE strategy_versions SET active=true WHERE strategy_key=$1 AND version=$2", [strategy_key, version]);
  await core.audit("learning.strategy_rollback", strategy_key, { version });
  return { ok: true, strategy_key, active_version: version };
}

// Optional AI interpretation of outcome evidence. The model returns a candidate only;
// deterministic measurements and missing-metric flags are never replaced by AI output.
export async function interpretOutcome({ task_id, evidence = {} } = {}) {
  try {
    const llm = await import("./llm-provider.js");
    const outcomes = (await getOutcomes({ task_id })).outcomes;
    const r = await llm.runTask("outcome_evaluation", {
      task_id, outcomes: outcomes.map((x) => ({ metric: x.metric, value: x.value, measurement: x.measurement })), evidence,
    });
    if (!r.ok) return { ok: false, kind: r.kind, candidate: null };
    return { ok: true, candidate: r.data, usage: r.usage, note: "AI candidate; deterministic measurements unchanged" };
  } catch (e) { return { ok: false, kind: "error", message: String(e?.message || e).slice(0, 200) }; }
}

// Turn-end capture: convert observed tool executions into coding outcomes.
// Only real exit codes are used; unknown results are recorded as missing, never invented.
export async function captureOutcomes({ session_id, project_id } = {}) {
  if (!session_id) throw new Error("session_id required");
  const taskId = `task-${session_id}`;
  await core.dbQuery(
    `INSERT INTO coding_tasks (id,session_id,project_id,description,status)
     VALUES ($1,$2,$3,$4,'observed') ON CONFLICT (id) DO NOTHING`,
    [taskId, session_id, project_id || "_global", `Session ${session_id}`],
  );
  const obs = (await core.dbQuery(
    "SELECT id,tool_name,duration_ms,exit_code,is_error FROM strategy_observation WHERE session_id=$1", [session_id])).rows;
  let created = 0, missing = 0;
  for (const o of obs) {
    if (o.exit_code === null || o.exit_code === undefined) { missing++; continue; }
    const metric = /test|pytest|vitest|jest|bun/.test(String(o.tool_name || "")) ? "test_pass" : "build_success";
    const value = Number(o.exit_code) === 0 ? "true" : "false";
    const exists = (await core.dbQuery(
      `SELECT 1 FROM coding_outcomes WHERE task_id=$1 AND metric=$2 AND evidence->>'observation'=$3`,
      [taskId, metric, String(o.id)])).rowCount;
    if (exists) continue;
    await core.dbQuery(
      `INSERT INTO coding_outcomes (task_id,metric,value,measurement,evidence)
       VALUES ($1,$2,$3,'observed',$4::jsonb)`,
      [taskId, metric, value, JSON.stringify({ session: session_id, observation: o.id, tool: o.tool_name, exit: o.exit_code, duration_ms: o.duration_ms })],
    );
    created++;
  }
  await core.audit("learning.outcome_capture", session_id, { created, missing, observations: obs.length });
  return { ok: true, created, missing, observations: obs.length };
}

// ---- Phase 12.3: evidence-based continuous improvement ----
export function classifyOutcome(value, measurement = "observed") {
  if (measurement !== "observed") return "not_measured";
  const v = String(value || "").toLowerCase();
  if (["true","pass","passed","success","succeeded","green","fixed","resolved"].includes(v)) return "successful";
  if (["partial","partially","mixed"].includes(v)) return "partially_successful";
  if (["false","fail","failed","red","error","crash","regression"].includes(v)) return "failed";
  return "inconclusive";
}

export async function linkOutcomesToExperiments({ project_id, limit = 200 } = {}) {
  const outcomes = (await core.dbQuery(
    `SELECT o.*, t.project_id, t.description, a.strategy_id
     FROM coding_outcomes o JOIN coding_tasks t ON t.id=o.task_id
     LEFT JOIN coding_attempts a ON a.task_id=o.task_id
     WHERE o.measurement='observed'
       AND ($1::text IS NULL OR t.project_id=$1)
     ORDER BY o.recorded_at DESC LIMIT $2`, [project_id || null, Math.min(limit, 500)])).rows;
  // source_linked column may not exist on older databases; handle gracefully below.
  let linked = 0, skipped = 0;
  for (const o of outcomes) {
    const exists = (await core.dbQuery(
      "SELECT 1 FROM strategy_experiment_results WHERE source_outcome_id=$1", [o.id])).rowCount;
    if (exists) { skipped++; continue; }
    const cls = classifyOutcome(o.value, o.measurement);
    if (cls === "not_measured" || cls === "inconclusive") { skipped++; continue; }
    const key = o.strategy_id || `observed-${o.project_id || "_global"}`;
    const v = (await core.dbQuery("SELECT max(version) v FROM strategy_versions WHERE strategy_key=$1", [key])).rows[0]?.v;
    if (!v) {
      await core.dbQuery(
        `INSERT INTO strategy_versions (strategy_key,version,definition,lifecycle_status) VALUES ($1,1,$2::jsonb,'proposed')`,
        [key, JSON.stringify({ origin: "observed_outcome", project_id: o.project_id })],
      );
    }
    let exp = (await core.dbQuery(
      "SELECT id FROM strategy_experiment WHERE project_id=$1 AND previous_approach=$2 AND alternative_approach='observed_outcome_linkage' LIMIT 1",
      [o.project_id || "_global", key])).rows[0];
    if (!exp) {
      const r = await core.dbQuery(
        `INSERT INTO strategy_experiment (project_id,previous_approach,alternative_approach,result,errors,successful,confidence,evidence_sessions)
         VALUES ($1,$2,'observed_outcome_linkage','pending',$3::jsonb,false,0.3,$4::text[]) RETURNING id`,
        [o.project_id || "_global", key, JSON.stringify([]), [o.task_id]],
      );
      exp = { id: r.rows[0].id };
    }
    await core.dbQuery(
      `INSERT INTO strategy_experiment_results (experiment_id,task_id,strategy_key,strategy_version,outcome,metrics,measurement,source_outcome_id,project_id,limitations)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'observed',$7,$8,$9)`,
      [exp.id, o.task_id, key, v || 1, cls === "successful" ? "success" : "failure",
       JSON.stringify({ metric: o.metric, value: o.value, evidence: o.evidence }), o.id,
       o.project_id || "_global", "linked from observed coding outcome; no inferred metrics"],
    );
    linked++;
  }
  await core.audit("learning.outcome_link", "all", { linked, skipped });
  return { ok: true, linked, skipped, source: "observed outcomes only" };
}

export async function strategyLifecycle({ strategy_key, min_samples = 5, approval = false } = {}) {
  if (!strategy_key) throw new Error("strategy_key required");
  const rows = (await core.dbQuery(
    `SELECT outcome, project_id, metrics, created_at FROM strategy_experiment_results
     WHERE strategy_key=$1 AND measurement='observed' ORDER BY created_at`, [strategy_key])).rows;
  const n = rows.length;
  const success = rows.filter((x) => x.outcome === "success").length;
  const projects = new Set(rows.map((x) => x.project_id).filter(Boolean));
  const rate = n ? success / n : 0;
  const recent = rows.filter((x) => Date.now() - new Date(x.created_at).getTime() < 30 * 86400000);
  const recentFailRate = recent.length ? recent.filter((x) => x.outcome === "failure").length / recent.length : 0;
  let status = "proposed";
  if (n >= min_samples && rate >= 0.6) status = "supported";
  if (n >= min_samples * 2 && rate >= 0.7 && projects.size >= 2 && approval === true) status = "confirmed";
  if (n >= min_samples && rate < 0.4) status = "rejected";
  // A previously useful strategy that recently fails repeatedly is regressed, not merely rejected.
  if ((status === "supported" || status === "confirmed") && recent.length >= min_samples && recentFailRate > 0.5) {
    status = "regressed";
  }
  const confidence = Number(Math.min(0.95, rate * (n / Math.max(1, min_samples))).toFixed(3));
  await core.dbQuery(
    `UPDATE strategy_versions SET lifecycle_status=$2, confidence=$3,
      promoted_at=CASE WHEN $2='confirmed' THEN now() ELSE promoted_at END,
      regressed_at=CASE WHEN $2='regressed' THEN now() ELSE NULL END,
      regression_reason=CASE WHEN $2='regressed' THEN $4 ELSE NULL END
     WHERE strategy_key=$1 AND version=(SELECT max(version) FROM strategy_versions WHERE strategy_key=$1)`,
    [strategy_key, status, confidence, `recent failure rate ${recentFailRate.toFixed(2)} over ${recent.length} observed results`],
  );
  await core.audit("learning.strategy_lifecycle", strategy_key, { status, samples: n, success_rate: rate, projects: projects.size, approval });
  return { ok: true, strategy_key, status, samples: n, success_rate: Number(rate.toFixed(3)),
    projects: projects.size, confidence, auto_confirmed: false };
}

export async function strategyValidationReport({ project_id } = {}) {
  const versions = (await core.dbQuery(
    `SELECT strategy_key,version,lifecycle_status,confidence,min_samples,promoted_at,regressed_at,regression_reason
     FROM strategy_versions ORDER BY strategy_key,version DESC`)).rows;
  const evidence = (await core.dbQuery(
    `SELECT strategy_key,outcome,measurement,project_id,created_at FROM strategy_experiment_results
     WHERE ($1::text IS NULL OR project_id=$1)`, [project_id || null])).rows;
  const grouped = {};
  for (const e of evidence) {
    if (!grouped[e.strategy_key]) grouped[e.strategy_key] = { observed: 0, estimated: 0, success: 0, failure: 0, projects: new Set(), last: null };
    const g = grouped[e.strategy_key];
    g[e.measurement === "observed" ? "observed" : "estimated"]++;
    if (e.measurement === "observed") {
      if (e.outcome === "success") g.success++;
      if (e.outcome === "failure") g.failure++;
      if (e.project_id) g.projects.add(e.project_id);
      if (!g.last || new Date(e.created_at) > new Date(g.last)) g.last = e.created_at;
    }
  }
  const strategies = versions.map((v) => {
    const g = grouped[v.strategy_key] || { observed: 0, estimated: 0, success: 0, failure: 0, projects: new Set(), last: null };
    return { ...v, observed_samples: g.observed, estimated_samples: g.estimated, successes: g.success,
      failures: g.failure, projects: g.projects.size, last_observed: g.last,
      claim: g.observed >= v.min_samples ? "measured evidence available" : "insufficient observed evidence" };
  });
  return { ok: true, strategies,
    summary: { effective: strategies.filter((s) => s.lifecycle_status === "supported" || s.lifecycle_status === "confirmed").length,
      regressed: strategies.filter((s) => s.lifecycle_status === "regressed").length,
      insufficient: strategies.filter((s) => s.observed_samples < s.min_samples).length,
      requiring_approval: strategies.filter((s) => s.lifecycle_status === "proposed" && s.observed_samples >= s.min_samples).length },
    note: "observed and estimated metrics are reported separately; no improvement claimed without evidence" };
}

export async function selfImprovementReport({ project_id } = {}) {
  const repeated = (await core.dbQuery(
    `SELECT o.metric,o.value,count(*)::int n FROM coding_outcomes o
     JOIN coding_tasks t ON t.id=o.task_id
     WHERE ($1::text IS NULL OR t.project_id=$1)
     AND (o.value ILIKE '%fail%' OR o.value ILIKE '%error%') GROUP BY 1,2 HAVING count(*)>1 ORDER BY n DESC LIMIT 20`,
    [project_id || null])).rows;
  const successes = (await core.dbQuery(
    `SELECT strategy_key,outcome,count(*)::int n FROM strategy_experiment_results
     WHERE measurement='observed' AND outcome='success' GROUP BY 1,2 ORDER BY n DESC LIMIT 20`)).rows;
  const strategies = (await core.dbQuery(
    `SELECT lifecycle_status,count(*)::int n FROM strategy_versions GROUP BY 1`)).rows;
  const unconfirmed = (await core.dbQuery(
    "SELECT count(*)::int n FROM strategy_experiment WHERE outcome_confirmed")).rows[0].n;
  const report = {
    ok: true, repeated_failures: repeated, successful_patterns: successes,
    strategy_lifecycle: strategies, confirmed_strategies: unconfirmed,
    claim: "report only; no improvement claimed without measured evidence",
  };
  await core.dbQuery(
    `INSERT INTO self_improvement_report (project_id,kind,summary,evidence)
     VALUES ($1,'self_improvement',$2,$3::jsonb)`,
    [project_id || null, report.claim, JSON.stringify(report)],
  );
  return report;
}

export async function learningInsights({ project_id } = {}) {
  const failures = (await core.dbQuery(
    `SELECT metric,value,count(*)::int n FROM coding_outcomes o JOIN coding_tasks t ON t.id=o.task_id
     WHERE ($1::text IS NULL OR t.project_id=$1) AND (metric='regression' OR value ILIKE '%fail%')
     GROUP BY 1,2 ORDER BY n DESC LIMIT 10`, [project_id || null])).rows;
  const successes = (await core.dbQuery(
    `SELECT metric,value,count(*)::int n FROM coding_outcomes o JOIN coding_tasks t ON t.id=o.task_id
     WHERE ($1::text IS NULL OR t.project_id=$1) AND metric IN ('task_completed','test_pass','build_success')
     GROUP BY 1,2 ORDER BY n DESC LIMIT 10`, [project_id || null])).rows;
  const missing = (await core.dbQuery("SELECT count(*)::int n FROM coding_outcomes WHERE measurement='missing'")).rows[0].n;
  const experiments = (await core.dbQuery("SELECT count(*)::int n FROM strategy_experiment_results")).rows[0].n;
  return { ok: true, repeated_failures: failures, success_evidence: successes, missing_measurements: missing, experiment_results: experiments };
}
