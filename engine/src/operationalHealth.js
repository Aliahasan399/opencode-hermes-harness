// Phase 28 — unified operational health report. Composes EXISTING systems; no new
// monitoring framework, no runtime claim from presence. Fully redacted and bounded.
// LEVEL 1 / HARNESS_SEMANTIC_LLM unchanged; no source writes, no spawn, no dispatch.
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const VERDICT = { HEALTHY: "healthy", DEGRADED: "degraded", FAILED: "failed", UNKNOWN: "unknown",
  INSUFFICIENT: "insufficient_evidence" };
async function audit(action, detail) {
  try { await core.audit(action, "_global", detail); } catch { /* best effort */ }
}

/** Bounded backup/checkpoint inventory (names only; never contents). */
function inventory() {
  const root = core.MEMORY_ROOT;
  const out = { backups: 0, checkpoints: 0, latest_backup: null, latest_checkpoint: null };
  try {
    const b = fs.readdirSync(path.join(root, "backups"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort();
    out.backups = b.length;
    out.latest_backup = b[b.length - 1] || null;
  } catch { /* unreadable -> unknown */ }
  try {
    const c = fs.readdirSync(path.join(root, "checkpoints"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    out.checkpoints = c.length;
    out.latest_checkpoint = c[c.length - 1] || null;
  } catch { /* unreadable -> unknown */ }
  return out;
}

/**
 * Unified health snapshot. All checks are read-only; presence checks explicitly
 * do not establish runtime behavior.
 */
export async function operationalHealth({ project_id, limit } = {}) {
  const degraded = [];
  const components = {};
  const n = clamp(limit, 1, 50, 20);

  // 1) Database connectivity (real runtime signal, not presence).
  let dbVerdict = VERDICT.UNKNOWN;
  try {
    const h = await core.health();
    dbVerdict = h?.ok === false ? VERDICT.FAILED : VERDICT.HEALTHY;
    components.database = { verdict: dbVerdict, evidence_source: "core.health()", runtime_check: true,
      detail: { ok: h?.ok ?? null } };
  } catch (e) {
    components.database = { verdict: VERDICT.FAILED, evidence_source: "core.health()", runtime_check: true,
      detail: { error: short(e?.message || e, 120) } };
    degraded.push(`database: ${short(e?.message || e, 100)}`);
  }

  // 2) Pipeline wiring presence (NOT runtime proof).
  try {
    const pa = await load("pipelineAudit");
    const a = pa?.auditPipelineIntegrity?.();
    const total = a?.summary?.total ?? null;
    const missing = a?.summary?.missing ?? null;
    components.pipeline_wiring = {
      verdict: a ? (missing === 0 ? VERDICT.HEALTHY : VERDICT.DEGRADED) : VERDICT.UNKNOWN,
      evidence_source: "pipelineAudit.auditPipelineIntegrity", runtime_check: false,
      detail: { total, present: a?.summary?.present ?? null, missing, claim: a?.claim || null },
    };
  } catch (e) { components.pipeline_wiring = { verdict: VERDICT.UNKNOWN, runtime_check: false,
    detail: { error: short(e?.message || e, 120) } }; degraded.push(`pipeline: ${short(e?.message || e, 100)}`); }

  // 3) Workflow runtime state (project-scoped when a project is supplied).
  if (project_id && project_id !== "_global") {
    try {
      const wm = await load("workflowMonitor");
      if (wm?.workflowHealth) {
        const w = await wm.workflowHealth({ project_id });
        components.workflow = { verdict: w?.ok ? VERDICT.HEALTHY : VERDICT.DEGRADED,
          evidence_source: "workflowMonitor.workflowHealth", runtime_check: true,
          detail: { stale_count: w?.stale_count ?? null, tasks: w?.tasks || null } };
      } else { components.workflow = { verdict: VERDICT.UNKNOWN, runtime_check: true, detail: null }; }
    } catch (e) { components.workflow = { verdict: VERDICT.UNKNOWN, runtime_check: true,
      detail: { error: short(e?.message || e, 120) } }; }
  } else {
    components.workflow = { verdict: VERDICT.INSUFFICIENT, runtime_check: true,
      detail: { reason: "no valid project scope" } };
  }

  // 4) Project-management & adaptive-evaluation availability (delegated reports).
  for (const [key, mod, fn] of [
    ["project_intelligence", "projectManagement", "report"],
    ["adaptive_intelligence", "adaptiveIntelligence", "report"],
  ]) {
    try {
      const m = await load(mod);
      if (!m?.[fn] || !project_id || project_id === "_global") {
        components[key] = { verdict: VERDICT.INSUFFICIENT, runtime_check: false,
          detail: { reason: "module or project scope unavailable" } };
      } else {
        const r = await m[fn]({ project_id, limit: n });
        components[key] = { verdict: r?.ok ? VERDICT.HEALTHY : VERDICT.DEGRADED,
          evidence_source: `${mod}.${fn}`, runtime_check: false,
          detail: { ok: !!r?.ok, degraded: (r?.degraded || []).length } };
      }
    } catch (e) { components[key] = { verdict: VERDICT.DEGRADED, runtime_check: false,
      detail: { error: short(e?.message || e, 120) } }; }
  }

  // 5) Backup/checkpoint inventory (names only).
  const inv = inventory();
  components.backup_inventory = { verdict: inv.backups > 0 ? VERDICT.HEALTHY : VERDICT.UNKNOWN,
    evidence_source: "filesystem inventory (names only)", runtime_check: false,
    detail: { backups: inv.backups, checkpoints: inv.checkpoints,
      latest_backup: inv.latest_backup ? short(inv.latest_backup, 120) : null,
      latest_checkpoint: inv.latest_checkpoint ? short(inv.latest_checkpoint, 120) : null } };

  const verdicts = Object.values(components).map((c) => c.verdict);
  let overall = VERDICT.HEALTHY;
  if (verdicts.includes(VERDICT.FAILED)) overall = VERDICT.FAILED;
  else if (verdicts.includes(VERDICT.DEGRADED)) overall = VERDICT.DEGRADED;
  else if (verdicts.includes(VERDICT.UNKNOWN)) overall = VERDICT.UNKNOWN;
  else if (verdicts.includes(VERDICT.INSUFFICIENT)) overall = VERDICT.INSUFFICIENT;

  await audit("p28.operational_health", { overall, components: Object.keys(components) });
  return { ok: overall !== VERDICT.FAILED, overall, project_id: project_id || null, components, degraded,
    claim: "Presence checks are not runtime proof. Verified outcomes require explicit evidence; a process exit is not task verification.",
    note: "Healthy means the specific check succeeded, not that the whole system is verified. Unknown/insufficient evidence is reported explicitly." };
}

export default { operationalHealth };
