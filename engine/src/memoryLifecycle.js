// Phase 20 orchestrator: bounded, advisory memory lifecycle maintenance.
// LEVEL 1: proposes and records; never auto-merges, auto-archives, or deletes.
// All sibling modules are optional and dynamically imported with isolated try/catch.
import * as core from "./core.js";

const short = (v, n = 200) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const errText = (e) => short(e?.message || e || "unknown error", 160);

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function ownedMemory(memory_id, project_id) {
  // Validate before the DB call: a malformed id must fail closed, not surface a
  // raw 22P02 uuid cast error to the caller.
  if (!memory_id || !UUID_RE.test(String(memory_id)) || !project_id || project_id === "_global") return null;
  const r = await core.dbQuery(
    "SELECT id,project_id,lifecycle,importance,verified,category,updated_at,valid_until FROM memory WHERE id=$1 AND project_id=$2 LIMIT 1",
    [memory_id, project_id]);
  return r.rows[0] || null;
}

/** Read-only, project-scoped view of a memory's lifecycle, importance and freshness. */
export async function getLifecycleStatus({ project_id, memory_id } = {}) {
  const m = await ownedMemory(memory_id, project_id);
  if (!m) return { ok: false, reason: "memory not found in project scope" };
  const events = await core.dbQuery(
    "SELECT from_state,to_state,reason,actor,created_at FROM memory_lifecycle_event WHERE memory_id=$1 ORDER BY created_at DESC LIMIT 20",
    [memory_id]);
  const reviews = await core.dbQuery(
    "SELECT verdict,reason,suggested_action,reviewed_at FROM memory_freshness_review WHERE memory_id=$1 ORDER BY reviewed_at DESC LIMIT 10",
    [memory_id]);
  const signals = await core.dbQuery(
    "SELECT signal_type,weight,reason FROM memory_importance_signal WHERE memory_id=$1 ORDER BY weight DESC LIMIT 20",
    [memory_id]);
  return { ok: true, memory_id, project_id,
    lifecycle: m.lifecycle || "HYPOTHESIS", importance: m.importance, verified: m.verified,
    category: m.category, updated_at: m.updated_at, valid_until: m.valid_until,
    events: events.rows, freshness: reviews.rows, importance_signals: signals.rows,
    note: "Lifecycle state is DB-enforced (migration 014); importance/freshness are advisory and separate from verification." };
}

/**
 * Bounded maintenance pass. Produces proposals/observations only.
 * dry_run defaults to true; with dry_run:false it still performs no destructive
 * operation — it only persists advisory signals/reviews and consolidation proposals.
 */
export async function runLifecycleMaintenance({ project_id, limit = 50, dry_run = true, actor = "system" } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
  const degraded = [];
  const result = { ok: true, project_id, dry_run: dry_run !== false, examined: 0,
    importance: 0, freshness: 0, consolidation_candidates: 0, contradictions: 0, degraded };

  const rows = await core.dbQuery(
    `SELECT id,title,category,importance,verified,lifecycle,updated_at,valid_until
       FROM memory WHERE project_id=$1 AND (lifecycle IS NULL OR lifecycle NOT IN ('ARCHIVED','REJECTED'))
      ORDER BY updated_at DESC LIMIT $2`, [project_id, n]);
  result.examined = rows.rowCount;

  const imp = await load("memoryImportance");
  const con = await load("memoryConsolidation");
  if (!imp) degraded.push("memoryImportance: unavailable");
  if (!con) degraded.push("memoryConsolidation: unavailable");

  for (const m of rows.rows) {
    if (imp?.reviewFreshness) {
      try {
        const f = await imp.reviewFreshness({ memory_id: m.id, project_id, now: new Date().toISOString() });
        if (f?.verdict && f.verdict !== "current") {
          result.freshness += 1;
          if (result.dry_run === false && imp.recordFreshnessReview) {
            await imp.recordFreshnessReview({ memory_id: m.id, project_id,
              verdict: f.verdict, reason: f.reason, suggested_action: f.suggested_action || "none" });
          }
        }
      } catch (e) { degraded.push(`freshness:${m.id}: ${errText(e)}`); }
    }
    if (imp?.classifyImportance && imp?.recordSignal) {
      try {
        const c = await imp.classifyImportance({ memory_id: m.id, project_id });
        if (c?.tier === "critical" || c?.tier === "important") {
          result.importance += 1;
          if (result.dry_run === false) {
            await imp.recordSignal({ memory_id: m.id, project_id,
              signal_type: "critical_decision", weight: c.tier === "critical" ? 0.9 : 0.7,
              reason: short(c.explanation, 300) });
          }
        }
      } catch (e) { degraded.push(`importance:${m.id}: ${errText(e)}`); }
    }
  }

  if (con?.findCandidates) {
    try {
      const c = await con.findCandidates({ project_id, limit: n });
      result.consolidation_candidates = Array.isArray(c?.candidates) ? c.candidates.length : 0;
      if (result.dry_run === false && con.proposeConsolidation) {
        for (const cand of (c?.candidates || []).slice(0, 5)) {
          await con.proposeConsolidation({ candidate: cand, project_id, actor,
            evidence: [`maintenance:${new Date().toISOString()}`] });
        }
      }
    } catch (e) { degraded.push(`consolidation: ${errText(e)}`); }
  }
  if (con?.reviewContradictions) {
    try {
      const c = await con.reviewContradictions({ project_id, limit: n });
      result.contradictions = Array.isArray(c?.items) ? c.items.length : 0;
    } catch (e) { degraded.push(`contradictions: ${errText(e)}`); }
  }

  try {
    await core.audit("memory.lifecycle_maintenance", project_id, {
      examined: result.examined, importance: result.importance, freshness: result.freshness,
      consolidation_candidates: result.consolidation_candidates, contradictions: result.contradictions,
      dry_run: result.dry_run, degraded,
    });
  } catch { /* best effort */ }
  return result;
}

export async function lifecycleMaintenanceStatus({ project_id, limit = 50 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
  const r = await core.dbQuery(
    `SELECT to_state, count(*)::int AS n FROM memory_lifecycle_event
      WHERE project_id=$1 GROUP BY to_state ORDER BY n DESC LIMIT $2`, [project_id, n]);
  const by_lifecycle = await core.dbQuery(
    `SELECT coalesce(lifecycle,'HYPOTHESIS') AS lifecycle, count(*)::int AS n
       FROM memory WHERE project_id=$1 GROUP BY 1 ORDER BY n DESC`, [project_id]);
  return { ok: true, project_id, events_by_state: r.rows, by_lifecycle: by_lifecycle.rows };
}

export default { getLifecycleStatus, runLifecycleMaintenance, lifecycleMaintenanceStatus };
