// Explicit provenance classification and read-only quality reporting.
// Never guesses test data from content; unknown stays unknown.
import * as core from "./core.js";

const TEST_PREFIX = /^(test|test-|p12|p13|rel-|cap-|demo-|turn-|preserve-|idem-|stale-|short-|long-|dup-|order-|retry-|worker-|cand-|flow-|canon-|obs-|iso-|budget-|labels-|src-|empty-|rb-|app-|int-|tri-|contra-|near-|dup|explain|use-|cross-|attr-|multi-|est-|link-|fail-|reg-|conf-|small-|proj-|succ-|v-|q-|t-|s\d?-)/i;

export function classifyProvenance(record = {}) {
  const explicit = record.provenance;
  if (["production","test_fixture"].includes(explicit)) return explicit;
  const sid = String(record.source_session || "");
  if (TEST_PREFIX.test(sid)) return "test_fixture";
  return "unknown";
}

export async function provenanceReport({ project_id } = {}) {
  const rows = (await core.dbQuery(
    `SELECT id,project_id,source_session,provenance FROM memory WHERE ($1::text IS NULL OR project_id=$1)`, [project_id || null])).rows;
  const counts = { production: 0, test_fixture: 0, unknown: 0 };
  for (const r of rows) counts[classifyProvenance(r)]++;
  return { ok: true, totals: counts, classified: rows.length, note: "classification uses explicit provenance or session-id prefix only; ambiguous records stay unknown" };
}

export async function tagMemoryProvenance({ memory_id, provenance, actor = "user" } = {}) {
  if (!["production","test_fixture","unknown"].includes(provenance)) throw new Error("invalid provenance");
  const r = await core.dbQuery("UPDATE memory SET provenance=$2 WHERE id=$1 RETURNING id", [memory_id, provenance]);
  if (!r.rowCount) throw new Error("memory not found");
  await core.audit("data_quality.provenance", memory_id, { provenance, actor });
  return { ok: true, memory_id, provenance };
}

export async function dryRunQualityReport({ project_id } = {}) {
  const one = async (sql, p = []) => (await core.dbQuery(sql, p)).rows[0];
  const memory = await one(
    `SELECT count(*)::int total,
      count(*) FILTER (WHERE verified)::int verified,
      count(*) FILTER (WHERE confidence<0.5)::int low_confidence,
      count(*) FILTER (WHERE valid_until IS NOT NULL)::int outdated,
      count(*) FILTER (WHERE retrieved_count=0)::int unused,
      count(*) FILTER (WHERE provenance='test_fixture')::int test_fixture,
      count(*) FILTER (WHERE provenance='production')::int production
     FROM memory WHERE ($1::text IS NULL OR project_id=$1)`, [project_id || null]);
  const suggestions = await one(
    `SELECT count(*)::int total, count(*) FILTER (WHERE triage_status='pending')::int pending,
      count(*) FILTER (WHERE triage_status='ready_for_review')::int ready FROM consolidation_suggestion`);
  const contradictions = await one("SELECT count(*)::int total, count(*) FILTER (WHERE status='open')::int open FROM memory_contradictions");
  const retrieval = await one(
    `SELECT count(*)::int events, count(*) FILTER (WHERE signal='helpful')::int helpful,
      count(*) FILTER (WHERE signal='unhelpful')::int unhelpful,
      count(*) FILTER (WHERE signal='observed_usage')::int observed,
      count(*) FILTER (WHERE signal='error_not_recurred')::int non_recurrence
     FROM memory_retrieval_events e LEFT JOIN memory_usefulness_observations u ON u.event_id=e.id`);
  const semBreak = (await core.dbQuery("SELECT attribution,count(*)::int n FROM semantic_observation GROUP BY 1 ORDER BY n DESC")).rows;
  const fixes = (await core.dbQuery("SELECT status,count(*)::int n FROM fix_evidence GROUP BY 1 ORDER BY n DESC")).rows;
  return {
    ok: true, project_id: project_id || "_global", memory, suggestions, contradictions,
    retrieval, semantic_attribution: semBreak, fix_evidence: fixes,
    changes_applied: 0, destructive_operations: 0,
    note: "read-only dry run; every metric is an observed database count",
  };
}
