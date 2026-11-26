import * as core from "./core.js";

const MAX_ITEMS = 200;
const SAFETY = {
  auto_applied: 0,
  destructive_operations: 0,
  note: "This report never changes memory or applies or resolves suggestions.",
};

const PROJECT = "COALESCE(m.project_id, '_global')";
const PENDING_SUGGESTIONS = `
  SELECT s.id, s.kind, s.triage_status, s.confidence, s.created_at, ${PROJECT} AS project_id
  FROM consolidation_suggestion s
  LEFT JOIN memory m ON m.id = s.memory_ids[1]
  WHERE s.status = 'pending' AND ($1::text IS NULL OR ${PROJECT} = $1)`;

function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer");
  return Math.min(limit, MAX_ITEMS);
}

// Read titles, explanations, and source IDs only for the SQL-limited sample.
function sampledItems(order) {
  return `COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY ${order})
    FROM (
      SELECT q.*, s.status, s.title, s.description AS explanation, s.triage_reason, s.memory_ids
      FROM (SELECT * FROM scoped ORDER BY ${order} LIMIT $2) q
      JOIN consolidation_suggestion s ON s.id = q.id
    ) item
  ), '[]'::jsonb)`;
}

// Pending resolution includes all triage states. Each query gets one snapshot
// for totals and samples, even while other processes add or triage suggestions.
export async function backlogReport({ project_id = null, limit = 100 } = {}) {
  const sampleLimit = boundedLimit(limit);
  const { rows: [{ summary, groups, items }] } = await core.dbQuery(
    `WITH scoped AS (${PENDING_SUGGESTIONS}),
    stats AS (
      SELECT kind, triage_status, project_id, GROUPING(kind) = 1 AS is_total,
             count(*) AS count, min(created_at) AS oldest_at, max(created_at) AS newest_at,
             avg(confidence) AS average_confidence
      FROM scoped
      GROUP BY GROUPING SETS ((), (kind, triage_status, project_id))
    )
    SELECT jsonb_build_object(
             'total', totals.count, 'oldest_at', totals.oldest_at,
             'newest_at', totals.newest_at, 'average_confidence', totals.average_confidence
           ) AS summary,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(g) - 'is_total' ORDER BY g.project_id, g.kind, g.triage_status)
             FROM stats g WHERE NOT g.is_total
           ), '[]'::jsonb) AS groups,
           ${sampledItems("confidence DESC, created_at DESC, id")} AS items
    FROM stats totals WHERE totals.is_total`,
    [project_id, sampleLimit],
  );
  return { ok: true, project_id, limit: sampleLimit, ...summary, groups, items, ...SAFETY };
}

export async function staleSuggestionReport({ older_than_days = 30, project_id = null, limit = 100 } = {}) {
  if (!Number.isFinite(older_than_days) || older_than_days < 0) {
    throw new RangeError("older_than_days must be a non-negative number");
  }
  const sampleLimit = boundedLimit(limit);
  const { rows: [result] } = await core.dbQuery(
    `WITH bounds AS (
      SELECT now() - $3::double precision * interval '24 hours' AS cutoff
    ), scoped AS (${PENDING_SUGGESTIONS}
      AND s.triage_status IN ('pending', 'review_required')
      AND s.created_at < (SELECT cutoff FROM bounds)
    )
    SELECT to_jsonb(cutoff) AS cutoff,
           (SELECT count(*) FROM scoped) AS total,
           ${sampledItems("created_at, confidence DESC, id")} AS items
    FROM bounds`,
    [project_id, sampleLimit, older_than_days],
  );
  return { ok: true, project_id, older_than_days, limit: sampleLimit, ...result, total: Number(result.total), ...SAFETY };
}

export async function consolidationCoverage() {
  const { rows: [{ breakdown, table_counts }] } = await core.dbQuery(
    `SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.status, g.triage_status), '[]'::jsonb) AS breakdown,
            jsonb_build_object(
              'memory', (SELECT count(*) FROM memory),
              'memory_relationships', (SELECT count(*) FROM memory_relationships),
              'memory_contradictions', (SELECT count(*) FROM memory_contradictions),
              'memory_history', (SELECT count(*) FROM memory_history)
            ) AS table_counts
     FROM (
       SELECT status, triage_status, count(*) AS count
       FROM consolidation_suggestion
       GROUP BY status, triage_status
     ) g`,
  );
  const byStatus = new Map();
  const byTriageStatus = new Map();
  let total = 0;
  for (const { status, triage_status, count } of breakdown) {
    byStatus.set(status, (byStatus.get(status) ?? 0) + count);
    byTriageStatus.set(triage_status, (byTriageStatus.get(triage_status) ?? 0) + count);
    total += count;
  }
  // Triaged means the suggestion has left the initial pending triage state;
  // this includes resolved suggestions, independently of resolution status.
  const triaged = total - (byTriageStatus.get("pending") ?? 0);
  return {
    ok: true,
    total,
    by_status: Object.fromEntries(byStatus),
    by_triage_status: Object.fromEntries(byTriageStatus),
    breakdown,
    triaged,
    fraction_triaged: total ? triaged / total : 0,
    table_counts,
    ...SAFETY,
  };
}
