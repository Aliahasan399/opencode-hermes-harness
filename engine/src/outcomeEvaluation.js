// Phase 27 — verified outcome ingestion. REUSES Phase 21 learningIntelligence.analyzeOutcome
// for verification classification; never reimplements verification. An agent claim, a process
// exit code or model confidence never establishes a verified outcome. Project-scoped, bounded,
// fail-closed, idempotent, audited. No source write, no dispatch, no auto-approval.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name, _load) {
  if (_load && typeof _load[name] === "function") return { [name]: _load[name] };
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
};
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

/**
 * Ingest a structured outcome from an existing subsystem (Phase 23/24/25/26).
 * Verification is delegated to Phase 21's analyzeOutcome with explicit evidence.
 */
export async function ingestOutcome({ project_id, source_type, source_id, subsystem, observation,
  expected_outcome, actual_outcome, evidence, actor, _load } = {}) {
  const degraded = [];
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", degraded };
  if (!source_type) return { ok: false, reason: "source_type required", degraded };
  const ev = Array.isArray(evidence) ? evidence.slice(0, 100).map((x) => {
    if (x && typeof x === "object") {
      const out = {};
      for (const k of Object.keys(x)) out[short(k, 80)] = typeof x[k] === "string" ? core.redact(x[k]).slice(0, 400) : x[k];
      return out;
    }
    return core.redact(String(x)).slice(0, 400);
  }) : [];
  const li = await load("learningIntelligence", _load);
  if (!li?.analyzeOutcome) return { ok: false, reason: "Phase 21 verification unavailable", degraded };
  let verdict;
  try {
    verdict = li.analyzeOutcome({ experience: { evidence: ev, outcome: actual_outcome?.outcome || observation },
      evidence: ev });
  } catch (e) { return { ok: false, reason: `analyzeOutcome: ${short(e?.message || e, 120)}`, degraded }; }

  const verification_state = verdict.verified ? "independently_verified"
    : /contradic/i.test(verdict.reason || "") ? "contradicted"
      : /declared/i.test(verdict.reason || "") ? "unresolved" : "observed";
  const confidence = clamp01(verdict.verified ? 0.85 : 0.4);
  const sid = short(source_id || `${source_type}-${crypto.randomUUID().slice(0, 8)}`, 300);

  try {
    const ins = await core.dbQuery(
      `INSERT INTO ai_outcome_evaluation (id,project_id,source_type,source_id,subsystem,observation,
         expected_outcome,actual_outcome,verification_state,evidence,confidence,verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12)
       ON CONFLICT (project_id,source_type,source_id) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), project_id, short(source_type, 120), sid, short(subsystem || "", 120),
        short(observation || "", 2000), JSON.stringify(expected_outcome || {}), JSON.stringify(actual_outcome || {}),
        verification_state, JSON.stringify(ev), confidence, verdict.verified ? new Date().toISOString() : null]);
    await audit("p27.outcome.ingest", project_id, { source_type, verified: !!verdict.verified });
    return { ok: true, id: ins.rows[0]?.id || null, duplicate: ins.rowCount === 0,
      verification_state, confidence, verified: !!verdict.verified, reason: verdict.reason,
      note: "Verification classified from explicit evidence via Phase 21; a claim, exit code or model confidence never verifies.", degraded };
  } catch (e) { return { ok: false, reason: `persist: ${short(e?.message || e, 140)}`, degraded }; }
}

export async function getOutcome({ project_id, source_type, source_id } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", item: null };
  try {
    const r = await core.dbQuery(
      "SELECT * FROM ai_outcome_evaluation WHERE project_id=$1 AND source_type=$2 AND source_id=$3 LIMIT 1",
      [project_id, String(source_type || ""), String(source_id || "")]);
    return { ok: r.rowCount > 0, item: r.rows[0] || null };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), item: null }; }
}

export async function listOutcomes({ project_id, verification_state, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [] };
  const n = clamp(limit, 1, 200, 50);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM ai_outcome_evaluation WHERE project_id=$1
         AND ($2::text IS NULL OR verification_state=$2)
         ORDER BY created_at DESC LIMIT $3`, [project_id, verification_state || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), items: [] }; }
}

export default { ingestOutcome, getOutcome, listOutcomes };
