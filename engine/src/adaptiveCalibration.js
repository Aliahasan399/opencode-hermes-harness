// Phase 27 — bounded, explainable, advisory calibration proposals.
// Proposals require explicit operator approval. Applying a proposal records a
// proposal-state change only — NO production behavior, safety setting, approval
// gate, execution permission, project boundary, secret rule or verification gate
// is ever changed. Full audit + rollback. No self-modifying source.
import crypto from "node:crypto";
import * as core from "./core.js";

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
const SAFE_TARGETS = new Set(["recommendation_ordering", "priority_heuristics", "confidence_calibration",
  "task_category_preferences", "agent_suitability_preferences", "context_retrieval_preferences"]);
const PROTECTED = ["safety_level", "approval_gates", "execution_permissions", "project_isolation",
  "secret_handling", "verification_gates", "auto_approve", "opt_optimization_level", "harness_semantic_llm"];
const isProtected = (target) => {
  const t = String(target || "").toLowerCase().replace(/[\s_-]+/g, "_");
  return PROTECTED.some((p) => t.includes(p)) || !SAFE_TARGETS.has(t);
};

export async function proposeCalibration({ project_id, proposal_key, target_subsystem,
  current_behavior, proposed_behavior, reason, evidence, sample_size, confidence,
  expected_benefit, potential_downside, reversal } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (isProtected(target_subsystem)) {
    await audit("p27.calibration.protected", project_id, { target: short(target_subsystem, 80) });
    return { ok: false, reason: "protected_target",
      note: "This target is outside bounded advisory adaptation; no proposal was created." };
  }
  if (!proposal_key) return { ok: false, reason: "proposal_key required" };
  const ev = (Array.isArray(evidence) ? evidence : []).slice(0, 100).map((x) =>
    typeof x === "string" ? core.redact(x).slice(0, 400) : x && typeof x === "object" ? x : String(x).slice(0, 400));
  try {
    const ins = await core.dbQuery(
      `INSERT INTO ai_calibration_proposal (id,project_id,proposal_key,target_subsystem,current_behavior,
         proposed_behavior,reason,evidence,sample_size,confidence,expected_benefit,potential_downside,reversal,
         approval_required,status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,true,'proposed')
       ON CONFLICT (project_id,proposal_key) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), project_id, short(proposal_key, 200), short(target_subsystem, 120),
        JSON.stringify(current_behavior || {}), JSON.stringify(proposed_behavior || {}), short(reason || "", 2000),
        JSON.stringify(ev), clamp(sample_size, 0, 100000, 0), clamp01(confidence),
        short(expected_benefit || "", 1000), short(potential_downside || "", 1000), short(reversal || "", 1000)]);
    await audit("p27.calibration.propose", project_id, { target: target_subsystem });
    return { ok: true, proposal_id: ins.rows[0]?.id || null, duplicate: ins.rowCount === 0,
      approval_required: true, status: "proposed",
      note: "Advisory proposal only; no production behavior changed and no approval was auto-granted." };
  } catch (e) { return { ok: false, reason: `persist: ${short(e?.message || e, 140)}` }; }
}

async function getProposal(project_id, proposal_id) {
  const r = await core.dbQuery(
    "SELECT * FROM ai_calibration_proposal WHERE id=$1 AND project_id=$2 LIMIT 1",
    [String(proposal_id || ""), project_id]);
  return r.rows[0] || null;
}

export async function reviewCalibration({ project_id, proposal_id, decision, actor } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!actor) return { ok: false, reason: "actor required" };
  if (!["approve", "reject"].includes(String(decision))) return { ok: false, reason: "decision must be approve|reject" };
  try {
    const p = await getProposal(project_id, proposal_id);
    if (!p) return { ok: false, reason: "proposal not found in project scope" };
    if (p.status !== "proposed") return { ok: false, reason: "proposal is not in proposed state" };
    const status = decision === "approve" ? "approved" : "rejected";
    await core.dbQuery("UPDATE ai_calibration_proposal SET status=$1, actor=$2, updated_at=now() WHERE id=$3 AND project_id=$4",
      [status, short(actor, 120), p.id, project_id]);
    await audit("p27.calibration.review", project_id, { decision, actor: short(actor, 120) });
    return { ok: true, changed: true, status };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140) }; }
}

export async function applyCalibration({ project_id, proposal_id, actor } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!actor) return { ok: false, reason: "actor required" };
  try {
    const p = await getProposal(project_id, proposal_id);
    if (!p) return { ok: false, reason: "proposal not found in project scope" };
    if (p.status !== "approved") return { ok: false, reason: "proposal must be explicitly approved first" };
    // Store previous config for rollback; this phase does NOT alter production behavior.
    const previous = { current_behavior: p.current_behavior, status: p.status };
    await core.dbQuery(
      `UPDATE ai_calibration_proposal SET status='applied', actor=$1,
         evidence=COALESCE(evidence,'[]'::jsonb) || $2::jsonb, updated_at=now()
       WHERE id=$3 AND project_id=$4`,
      [short(actor, 120), JSON.stringify([{ kind: "previous_config", previous }]), p.id, project_id]);
    await audit("p27.calibration.apply", project_id, { proposal_id: short(proposal_id, 60), actor: short(actor, 120) });
    return { ok: true, changed: true, status: "applied", previous,
      note: "Advisory-only: a proposal-state change was recorded. NO production behavior, safety setting, approval gate, execution permission, project boundary, secret rule or verification gate was changed." };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140) }; }
}

export async function rollbackCalibration({ project_id, proposal_id, actor } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!actor) return { ok: false, reason: "actor required" };
  try {
    const p = await getProposal(project_id, proposal_id);
    if (!p) return { ok: false, reason: "proposal not found in project scope" };
    if (p.status !== "applied") return { ok: false, reason: "only an applied proposal can be rolled back" };
    await core.dbQuery("UPDATE ai_calibration_proposal SET status='rolled_back', actor=$1, updated_at=now() WHERE id=$2 AND project_id=$3",
      [short(actor, 120), p.id, project_id]);
    await audit("p27.calibration.rollback", project_id, { proposal_id: short(proposal_id, 60), actor: short(actor, 120) });
    return { ok: true, changed: true, status: "rolled_back", previous: p.current_behavior,
      note: "Previous advisory config restored; no production behavior was ever changed." };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140) }; }
}

export async function listCalibrationProposals({ project_id, status, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [] };
  const n = clamp(limit, 1, 200, 50);
  try {
    const r = await core.dbQuery(
      `SELECT * FROM ai_calibration_proposal WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
         ORDER BY created_at DESC LIMIT $3`, [project_id, status || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length };
  } catch (e) { return { ok: false, reason: short(e?.message || e, 140), items: [] }; }
}

export default { proposeCalibration, reviewCalibration, applyCalibration, rollbackCalibration, listCalibrationProposals };
