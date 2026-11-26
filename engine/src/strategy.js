// Phase 9: strategy evaluation based only on measured observations.
import * as core from "./core.js";

export async function recordObservation({ session_id, project_id, tool_name, duration_ms, exit_code, is_error, retry_of }) {
  await core.dbQuery(
    `INSERT INTO strategy_observation (session_id,project_id,tool_name,duration_ms,exit_code,is_error,retry_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [session_id, project_id || null, tool_name || null,
     Number.isFinite(duration_ms) ? Math.max(0, Math.round(duration_ms)) : null,
     Number.isInteger(exit_code) ? exit_code : null, !!is_error, retry_of || null],
  );
  await core.audit("strategy.observation", session_id, { tool_name, is_error: !!is_error });
  return { ok: true };
}

export async function observationStats({ project_id, session_id } = {}) {
  const r = await core.dbQuery(
    `SELECT count(*)::int AS observations,
            count(*) FILTER (WHERE is_error)::int AS errors,
            count(*) FILTER (WHERE retry_of IS NOT NULL)::int AS retries,
            round(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::bigint AS avg_ms
     FROM strategy_observation
     WHERE ($1::text IS NULL OR project_id=$1) AND ($2::text IS NULL OR session_id=$2)`,
    [project_id || null, session_id || null],
  );
  return { ok: true, ...r.rows[0] };
}

// A strategy is "confirmed" only when the same success pattern appears in >=2 distinct
// sessions AND at least 2 later sessions no longer show the matching failure pattern.
// No measurement => no confirmation.
export async function evaluateStrategies({ project_id } = {}) {
  const successes = (await core.dbQuery(
    `SELECT pattern_key, sessions, projects, description FROM pattern
     WHERE kind='successful_solution' AND ($1::text IS NULL OR $1 = ANY(projects))`,
    [project_id || null],
  )).rows;
  const failures = (await core.dbQuery(
    `SELECT pattern_key, sessions FROM pattern WHERE kind='repeated_failure'`,
  )).rows;
  const failKeys = new Set(failures.flatMap((f) => (f.pattern_key || "").split(":").slice(1)));
  let evaluated = 0, confirmed = 0;

  for (const s of successes) {
    const sess = s.sessions || [];
    if (sess.length < 2) continue;
    const successTokens = new Set((s.pattern_key || "").split(":").slice(1));
    const relatedFailures = failures.filter((f) => {
      const ft = (f.pattern_key || "").split(":").slice(1);
      return ft.some((t) => successTokens.has(t)) || failKeys.has([...successTokens][0]);
    });
    const failSessions = new Set(relatedFailures.flatMap((f) => f.sessions || []));
    const laterClean = sess.filter((x) => !failSessions.has(x));
    const confirmedNow = laterClean.length >= 2 && relatedFailures.length >= 1;

    const ex = await core.dbQuery(
      `SELECT id FROM strategy_experiment WHERE previous_approach=$1 AND alternative_approach=$2 LIMIT 1`,
      [s.description, s.description],
    );
    if (!ex.rowCount) {
      await core.dbQuery(
        `INSERT INTO strategy_experiment (project_id, previous_approach, alternative_approach, result, effort, errors,
           successful, confidence, evidence_sessions, outcome_confirmed, confirmation_count)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
        [s.projects?.[0] || "_global", "Repeated failure", s.description,
         confirmedNow ? "Failure absent in later sessions" : "Insufficient evidence",
         "duration not measured", JSON.stringify([]), confirmedNow, confirmedNow ? 0.75 : 0.45,
         sess, confirmedNow, laterClean.length],
      );
    } else if (confirmedNow) {
      await core.dbQuery(
        `UPDATE strategy_experiment SET outcome_confirmed=true, confirmation_count=$2, successful=true, confidence=0.8
         WHERE id=$1`, [ex.rows[0].id, laterClean.length],
      );
    }
    if (confirmedNow) confirmed++;
    evaluated++;
  }
  await core.audit("strategy.evaluation", "all", { evaluated, confirmed });
  return { ok: true, evaluated, confirmed, claim: confirmed > 0 ? "evidence-backed" : "no confirmed improvement" };
}

export async function strategyList({ project_id } = {}) {
  return (await core.dbQuery(
    `SELECT id, project_id, previous_approach, alternative_approach, result, effort,
            (successful AND outcome_confirmed) AS successful,
            outcome_confirmed, confirmation_count, measured_ms, retries, error_count, confidence, created_at
     FROM strategy_experiment WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY created_at DESC LIMIT 50`, [project_id || null],
  )).rows;
}
