// Phase 14 unified quality, lifecycle, retrieval explanation and learning evidence.
import * as core from "./core.js";
import { isGloballyEligible } from "./memoryScope.js";
import { adaptiveRetrieve } from "./adaptiveRetrieval.js";

const DAY = 86400000;

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

export async function scoreMemoryQuality({ memory_id, actor = "harness" } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const contradictions = (await core.dbQuery(
    `SELECT count(*)::int n FROM memory_contradictions WHERE status='open' AND (memory_a=$1 OR memory_b=$1)`, [memory_id])).rows[0].n;
  const dupes = (await core.dbQuery(
    `SELECT count(*)::int n FROM memory_relationships WHERE source_id=$1 AND relation IN ('duplicate','near_duplicate','semantic_equivalent')`, [memory_id])).rows[0].n;
  const signals = (await core.dbQuery(
    `SELECT signal,count(*)::int n FROM memory_usefulness_observations WHERE memory_id=$1 GROUP BY 1`, [memory_id])).rows;
  const helpful = signals.filter((s) => ["helpful","observed_usage","error_not_recurred"].includes(s.signal)).reduce((a, s) => a + s.n, 0);
  const unhelpful = signals.filter((s) => ["unhelpful","not_used"].includes(s.signal)).reduce((a, s) => a + s.n, 0);
  const ageDays = (Date.now() - new Date(m.updated_at).getTime()) / DAY;
  const parts = {
    provenance: clamp(m.provenance === "production" ? 0.9 : m.provenance === "test_fixture" ? 0.2 : 0.4),
    confidence: clamp(m.confidence),
    verification: m.verified ? 0.9 : 0.3,
    usefulness: clamp(0.5 + helpful * 0.1 - unhelpful * 0.15),
    recency: clamp(1 - Math.max(0, ageDays) / 365),
    contradiction_penalty: -Math.min(0.4, contradictions * 0.2),
    duplication_penalty: -Math.min(0.2, dupes * 0.05),
  };
  const score = clamp(Object.values(parts).reduce((a, b) => a + b, 0) / 8 + 0.25);
  const explanation = { parts, score: Number(score.toFixed(3)),
    note: "retrieval frequency and AI interpretations never establish accuracy", calculated_at: new Date().toISOString() };
  await core.dbQuery("UPDATE memory SET quality_score=$2, quality_explanation=$3::jsonb WHERE id=$1", [memory_id, score, explanation]);
  await core.audit("intelligence.quality_score", memory_id, { score, actor, parts });
  return { ok: true, memory_id, ...explanation };
}

export async function maintenanceReport({ project_id, limit = 100 } = {}) {
  const rows = (await core.dbQuery(
    `SELECT id,title,project_id,lifecycle,verified,confidence,quality_score,retrieved_count,valid_until,updated_at
     FROM memory WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY updated_at DESC LIMIT $2`, [project_id || null, Math.min(limit, 500)])).rows;
  const stale = rows.filter((m) => m.valid_until || (Date.now() - new Date(m.updated_at).getTime()) > 180 * DAY);
  const lowQuality = rows.filter((m) => Number(m.quality_score || 0) < 0.35);
  const unused = rows.filter((m) => Number(m.retrieved_count || 0) === 0);
  const rel = (await core.dbQuery(
    `SELECT source_id,target_id,relation,score,status FROM memory_relationships
     WHERE relation IN ('duplicate','near_duplicate','semantic_equivalent') LIMIT $1`, [Math.min(limit, 500)])).rows;
  const con = (await core.dbQuery("SELECT memory_a,memory_b,description,status,confidence FROM memory_contradictions LIMIT $1", [Math.min(limit, 500)])).rows;
  return { ok: true, counts: { scanned: rows.length, stale: stale.length, low_quality: lowQuality.length,
    unused: unused.length, duplicate_relations: rel.length, contradictions: con.length },
    stale: stale.slice(0, 20), low_quality: lowQuality.slice(0, 20), duplicate_relations: rel.slice(0, 20),
    contradictions: con.slice(0, 20), note: "read-only; no automatic deletion or promotion" };
}

export async function explainRetrieval({ query, project_id, limit = 8 }) {
  const r = await adaptiveRetrieve({ query, project_id, limit });
  const included = r.results.map((m) => ({ id: m.id, title: m.title, project_id: m.project_id,
    score: m.adaptive_score, components: m.ranking_components, reason: m.explanation || [],
    evidence_type: m.evidence_type, verified: m.verified, source: m.source_session }));
  return { ok: true, retrieval_event_id: r.retrieval_event_id,
    included, excluded_reason: "other-project, unauthorized global, stale, or below similarity floor",
    note: "no project isolation was relaxed for relevance" };
}

export async function learningEvidenceReport({ project_id, limit = 100 } = {}) {
  const one = async (sql, p = []) => (await core.dbQuery(sql, p)).rows[0];
  const candidates = await one(
    `SELECT count(*)::int n FROM memory WHERE source_kind='observed' AND verified=false AND ($1::text IS NULL OR project_id=$1)`, [project_id || null]);
  const observed = await one("SELECT count(*)::int n FROM coding_outcomes WHERE measurement='observed'");
  const estimated = await one("SELECT count(*)::int n FROM coding_outcomes WHERE measurement='estimated'");
  const runs = await one("SELECT count(*)::int n FROM learning_runs");
  const accepted = await one("SELECT count(*)::int n FROM memory WHERE verified=true AND ($1::text IS NULL OR project_id=$1)", [project_id || null]);
  const sessions = (await core.dbQuery(
    `SELECT resource AS session_id,action,created_at,detail FROM intelligence_audit_events
     WHERE track='learning' ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 100)])).rows;
  return { ok: true, candidates: candidates.n, observed_outcomes: observed.n, estimated_outcomes: estimated.n,
    learning_runs: runs.n, verified_memories: accepted.n, recent_activity: sessions,
    note: "candidate counts are not verified learning; outcomes are measured separately" };
}

export async function archiveMemory({ memory_id, actor = "user", note = "" } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const next = m.lifecycle === "VERIFIED" || m.lifecycle === "REJECTED" || m.lifecycle === "DISPUTED" ? "ARCHIVED" : null;
  if (!next) throw new Error(`lifecycle ${m.lifecycle} cannot be archived safely`);
  await core.dbQuery("UPDATE memory SET lifecycle=$2, valid_until=now(), metadata=metadata||$3::jsonb WHERE id=$1",
    [memory_id, next, JSON.stringify({ archived_by: actor, note, previous_lifecycle: m.lifecycle })]);
  await core.audit("intelligence.archive", memory_id, { actor, from: m.lifecycle, to: next });
  return { ok: true, memory_id, status: next, reversible: true };
}

export async function restoreMemory({ memory_id, actor = "user" } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m || m.lifecycle !== "ARCHIVED") throw new Error("memory is not archived");
  const prev = m.metadata?.previous_lifecycle || "HYPOTHESIS";
  const target = ["HYPOTHESIS","SUPPORTED","VERIFIED","OUTDATED","DISPUTED","REJECTED"].includes(prev) ? prev : "HYPOTHESIS";
  await core.dbQuery("UPDATE memory SET lifecycle=$2, valid_until=NULL, metadata=metadata||$3::jsonb WHERE id=$1",
    [memory_id, target, JSON.stringify({ restored_by: actor, previous_lifecycle: "ARCHIVED" })]);
  await core.audit("intelligence.restore", memory_id, { actor, to: target });
  return { ok: true, memory_id, status: target };
}
