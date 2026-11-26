// Phase 24 — workflow templates and closed-loop feedback. Templates PREPARE a
// plan (Phase 22), an approval and a durable run; they never dispatch. Feedback
// records outcomes into Phase 21 learning / Phase 23 intelligence via audit only;
// it never auto-applies a change, rewrites source or mutates recommendations.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v ?? {})).digest("hex");
async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

const TEMPLATES = Object.freeze([
  Object.freeze({ id: "review-only", title: "Review only", description: "Prepare a review plan; no edits, no dispatch.", default_risk: "low", default_mode: "simulation", steps_hint: ["collect context", "produce findings"] }),
  Object.freeze({ id: "analyze-and-report", title: "Analyze and report", description: "Evidence-backed analysis with a bounded report; no edits.", default_risk: "low", default_mode: "simulation", steps_hint: ["analyze", "report"] }),
  Object.freeze({ id: "test-and-verify", title: "Test and verify", description: "Run isolated tests and verify explicit post-conditions.", default_risk: "medium", default_mode: "simulation", steps_hint: ["test", "validate"] }),
  Object.freeze({ id: "fix-and-verify", title: "Fix and verify", description: "Higher-risk change plan requiring explicit approval before any dispatch.", default_risk: "high", default_mode: "simulation", steps_hint: ["change", "test", "validate"] }),
]);

export async function listTemplates() {
  return { ok: true, templates: TEMPLATES.map((t) => ({ ...t })),
    note: "All templates default to simulation mode and prepare only; no dispatch occurs here." };
}

const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;

/**
 * Prepare a workflow: plan (Phase 22) + single-use approval + durable run.
 * No process is spawned, no source is edited.
 */
export async function createWorkflow({ project_id, template, objective, scope, risk, mode,
  source_ref, created_by, plan_id, plan_version, plan_hash } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const tpl = byId(template);
  if (!tpl) return { ok: false, reason: "unknown template" };
  const effectiveMode = mode === "real" ? "real" : "simulation";
  const effectiveRisk = ["low", "medium", "high"].includes(risk) ? risk : tpl.default_risk;
  const safeScope = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  const degraded = [];

  // 1) Prepare a plan via Phase 22 (never execute it).
  const orch = await load("agentOrchestrator");
  let prepared = { ok: false };
  if (orch?.orchestrate) {
    try {
      prepared = await orch.orchestrate({ project_id,
        request: short(objective || tpl.description, 2000),
        context: { refs: source_ref ? [String(source_ref)] : [], steps: tpl.steps_hint } });
    } catch (e) { degraded.push(`orchestration: ${short(e?.message || e, 100)}`); }
  } else degraded.push("agentOrchestrator: unavailable");
  if (!prepared.ok) return { ok: false, reason: prepared.reason || "plan preparation failed", degraded };

  const finalPlanId = String(plan_id || prepared.plan_id || `plan-${crypto.randomUUID().slice(0, 8)}`);
  const finalVersion = String(plan_version || "v1");
  const finalHash = String(plan_hash || hash({ plan: finalPlanId, tasks: prepared.tasks || [] }));

  // 2) Create the single-use approval bound to this exact plan/scope/mode/risk.
  const approvals = await load("workflowApproval");
  if (!approvals?.createApproval) return { ok: false, reason: "approval engine unavailable", degraded };
  let ap;
  try {
    ap = await approvals.createApproval({ project_id, plan_id: finalPlanId, plan_version: finalVersion,
      plan_hash: finalHash, scope: safeScope, mode: effectiveMode, risk: effectiveRisk,
      approved_by: String(created_by || ""), request: short(objective || tpl.title, 200) });
  } catch (e) { return { ok: false, reason: `approval: ${short(e?.message || e, 100)}`, degraded }; }
  if (!ap.ok) return { ok: false, reason: ap.reason, degraded };

  // 3) Start the durable run with the planned tasks.
  const sm = await load("workflowStateMachine");
  if (!sm?.startRun) return { ok: false, reason: "state machine unavailable", degraded };
  let started;
  try {
    started = await sm.startRun({ project_id, plan_id: finalPlanId, plan_version: finalVersion,
      plan_hash: finalHash, approval_id: ap.approval_id, mode: effectiveMode,
      tasks: prepared.tasks || [], template, source_ref: String(source_ref || ""), created_by: String(created_by || "") });
  } catch (e) { return { ok: false, reason: `startRun: ${short(e?.message || e, 100)}`, degraded }; }
  if (!started.ok) return { ok: false, reason: started.reason, degraded };

  await audit("workflow.template.create", project_id, { template, plan_id: finalPlanId,
    run_id: started.run_id, mode: effectiveMode, risk: effectiveRisk, source_ref: source_ref || null });
  return { ok: true, template, plan_id: finalPlanId, plan_version: finalVersion, plan_hash: finalHash,
    approval_id: ap.approval_id, token: ap.token, run_id: started.run_id,
    tasks: started.tasks || [], degraded,
    note: "Plan, approval and run prepared. No agent was dispatched and no code was changed." };
}

/**
 * Record outcomes into Phase 21 learning and Phase 23 intelligence. Record only:
 * never auto-applies a recommendation, rewrites source or changes status.
 */
export async function feedbackLoop({ project_id, run_id, limit } = {}) {
  if (!validProject(project_id) || !run_id) return { ok: false, reason: "valid scope required", recorded: 0, channels: [] };
  const n = clamp(limit, 1, 100, 50);
  const degraded = [];
  const channels = [];
  try {
    const verifications = (await core.dbQuery(
      "SELECT task_key,verified,checks,claims FROM workflow_verification WHERE project_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT $3",
      [project_id, run_id, n])).rows;
    const run = (await core.dbQuery(
      "SELECT id,plan_id,template,source_ref,status,summary FROM workflow_run WHERE id=$1 AND project_id=$2",
      [run_id, project_id])).rows[0];
    if (!run) return { ok: false, reason: "run not found in project scope", recorded: 0, channels: [], degraded };
    const payload = {
      run_id, plan_id: run.plan_id || "", template: run.template || "", source_ref: run.source_ref || "",
      status: run.status || "", verified: verifications.filter((v) => v.verified).length,
      total: verifications.length,
      claims: verifications.flatMap((v) => (Array.isArray(v.claims) ? v.claims : [])).slice(0, 20),
    };
    for (const channel of ["phase21-learning", "phase23-intelligence"]) {
      try {
        await core.dbQuery(
          "INSERT INTO workflow_feedback (run_id,project_id,channel,payload,status) VALUES ($1,$2,$3,$4::jsonb,'recorded')",
          [run_id, project_id, channel, JSON.stringify(payload)]);
        channels.push(channel);
      } catch (e) { degraded.push(`${channel}: ${short(e?.message || e, 80)}`); }
    }
    // Best-effort cross-phase linkage via audit only (no mutation of either system).
    const [learning, intel] = await Promise.all([load("learningIntegration"), load("projectIntelligence")]);
    if (!learning && !intel) degraded.push("phase21/phase23 modules unavailable");
    await audit("workflow.feedback", project_id, { run_id, channels,
      verified: payload.verified, total: payload.total, source_ref: payload.source_ref });
  } catch (e) { degraded.push(`feedback: ${short(e?.message || e, 100)}`); }

  return { ok: channels.length > 0, recorded: channels.length, channels, degraded,
    note: "Record-only feedback. No recommendation status, source file or dependency was changed." };
}

export default { listTemplates, createWorkflow, feedbackLoop };
