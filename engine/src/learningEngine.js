// Phase 21 facade: a single, project-scoped entry point for the learning system.
// Every capability is optional and dynamically loaded; a failure never breaks
// existing memory, session or retrieval behavior.
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

/** Bounded read-only overview of a project's learning state. */
export async function learningStatus({ project_id, limit = 50 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const n = Number.isInteger(Number(limit)) && limit > 0 ? Math.min(limit, 200) : 50;
  const q = async (sql, params) => {
    try { return (await core.dbQuery(sql, params)).rows; }
    catch { return []; }
  };
  const [records, patterns, feedback, runs] = await Promise.all([
    q("SELECT status, count(*)::int n FROM learning_record WHERE project_id=$1 GROUP BY 1", [project_id]),
    q("SELECT status, count(*)::int n FROM pattern WHERE projects @> ARRAY[$1]::text[] GROUP BY 1", [project_id]),
    q("SELECT verdict, count(*)::int n FROM learning_feedback WHERE project_id=$1 GROUP BY 1", [project_id]),
    q("SELECT status, count(*)::int n FROM learning_pipeline_run WHERE project_id=$1 GROUP BY 1", [project_id]),
  ]);
  return { ok: true, project_id,
    records: records.reduce((a, r) => (a[r.status] = r.n, a), {}),
    patterns: patterns.reduce((a, r) => (a[r.status] = r.n, a), {}),
    feedback: feedback.reduce((a, r) => (a[r.verdict] = r.n, a), {}),
    pipeline_runs: runs.reduce((a, r) => (a[r.status] = r.n, a), {}),
    note: "Confidence is evidence-based and separate from verification; no automatic promotion." };
}

/** Delegate a learning pass to the idempotent pipeline. */
export async function runLearningNow({ session_id, project_id, lines, sequence, min_sequence } = {}) {
  const p = await load("learningPipeline");
  if (!p?.runLearningPipeline) return { ok: false, reason: "learning pipeline unavailable" };
  return p.runLearningPipeline({ session_id, project_id, lines, sequence, min_sequence });
}

/** Explain a learning record / pattern with its supporting evidence. */
export async function learningExplain({ project_id, learning_id, pattern_id } = {}) {
  const m = await load("learningIntegration");
  if (!m?.explainLearning) return { ok: false, reason: "learning explanation unavailable" };
  return m.explainLearning({ project_id, learning_id, pattern_id });
}

/** Bounded, project-scoped learning items suitable for the existing ranker. */
export async function learningAdvice({ project_id, query = "", limit = 8 } = {}) {
  const m = await load("learningIntegration");
  if (!m?.learningContextItems) return { ok: true, items: [], degraded: ["learningIntegration unavailable"] };
  return m.learningContextItems({ project_id, query, limit });
}

/** Advisory consolidation preview/apply through the existing lifecycle safeguards. */
export async function learningMaintenance({ project_id, apply = false, limit = 50 } = {}) {
  const m = await load("learningIntegration");
  if (!m?.consolidateLearning) return { ok: false, reason: "learning consolidation unavailable" };
  return m.consolidateLearning({ project_id, limit, dry_run: !apply });
}

export default { learningStatus, runLearningNow, learningExplain, learningAdvice, learningMaintenance };
