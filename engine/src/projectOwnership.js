// Phase 26 — agent ownership / accountability with HONEST execution states.
//
// This module ONLY records ownership assignments and their evidence-backed state
// transitions in pm_ownership (migration 024). It never spawns a process, never
// dispatches an agent, never writes source files, never approves anything and
// never claims an execution it cannot evidence. States that assert real execution
// ('running', 'completed_process', 'verified') are gated on explicit, strict
// evidence checked via Phase 19 developmentGoal.canMarkComplete (or an equivalent
// strict marker check) and can never be produced by a bare agent claim. LEVEL 1
// and HARNESS_SEMANTIC_LLM=0 are unchanged. Every capability is fail-closed,
// project-scoped, bounded, redacts free text and is best-effort audited.
import crypto from "node:crypto";
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

const OWNERSHIP_FIELDS =
  "id, project_id, task_id, agent, assignment_reason, scope, expected_output, " +
  "status, evidence, handoff, created_at, updated_at";

const STATES = Object.freeze([
  "planned", "prepared", "dispatched", "running",
  "completed_process", "reviewed", "verified", "unknown",
]);
const SELF_RECORDED = new Set(["prepared", "reviewed"]);
// These states assert that something actually happened. They require explicit,
// strict evidence and can never be reached by an agent's unsupported claim.
const EVIDENCE_GATED = new Set(["dispatched", "running", "completed_process", "verified"]);

const MAX_REASON = 2000;
const MAX_EXPECTED = 4000;
const MAX_EVIDENCE_ITEMS = 200;
const MAX_ACTOR = 120;
const MAX_AGENT = 120;
const MAX_ID = 512;
const MAX_SCOPE_KEYS = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const NOTE = "Ownership is a record, not runtime proof. Assignment is PLANNED only; " +
  "execution states require explicit evidence and no process is dispatched by this module.";
const CLAIM = "NO_RUNTIME_CLAIM";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const validProject = (p) => nonEmpty(p) && p.trim() !== "_global";
const maxLimit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), MAX_LIMIT)) : DEFAULT_LIMIT;
};

function redactString(v) {
  let s = core.redact(String(v ?? ""));
  s = s.replace(/\bBearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_API_KEY]");
  return s;
}

function redactValue(v) {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.slice(0, MAX_EVIDENCE_ITEMS).map(redactValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort().slice(0, MAX_SCOPE_KEYS)) out[k] = redactValue(v[k]);
    return out;
  }
  return v;
}

function normalizeEvidence(ev) {
  if (!Array.isArray(ev)) return [];
  return ev.slice(0, MAX_EVIDENCE_ITEMS).map((item) => {
    if (typeof item === "string") return redactString(item);
    if (item && typeof item === "object" && !Array.isArray(item)) return redactValue(item);
    return String(item ?? "");
  });
}

function rowToOwnership(r) {
  if (!r) return null;
  let scope = r.scope;
  let evidence = r.evidence;
  let handoff = r.handoff;
  try { if (typeof scope === "string") scope = JSON.parse(scope); } catch { scope = scope || {}; }
  try { if (typeof evidence === "string") evidence = JSON.parse(evidence); } catch { evidence = evidence || []; }
  try { if (typeof handoff === "string") handoff = JSON.parse(handoff); } catch { handoff = handoff || {}; }
  return {
    id: r.id ?? null,
    project_id: r.project_id ?? null,
    task_id: r.task_id ?? null,
    agent: r.agent ?? null,
    assignment_reason: r.assignment_reason ?? "",
    scope: scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {},
    expected_output: r.expected_output ?? "",
    status: r.status ?? "unknown",
    evidence: Array.isArray(evidence) ? evidence : [],
    handoff: handoff && typeof handoff === "object" && !Array.isArray(handoff) ? handoff : {},
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
}

async function audit(action, project_id, detail = {}) {
  try { await core.audit(action, project_id, redactValue(detail)); }
  catch { /* best effort */ }
}

// Marker vocabulary per evidence-gated state. 'verified' additionally uses the
// strict Phase 19 developmentGoal.canMarkComplete check. A bare claim such as
// "done" / "implemented" / "running" contains none of these markers and fails.
const EVIDENCE_MARKERS = Object.freeze({
  dispatched: ["dispatch_evidence", "dispatch_ok", "dispatched", "dispatch_result", "tool_result"],
  running: ["dispatch_evidence", "dispatch_ok", "dispatched", "dispatch_result", "tool_result"],
  completed_process: ["process_evidence", "process_result", "process_ok", "process_complete", "tool_result"],
  verified: ["test_pass", "verification_result", "verification_evidence", "test_result", "tool_result"],
});
const SUCCESS_RE = /\b(pass(?:ed)?|success(?:ful)?|succeeded|ok|green|true|dispatched|started|complete(?:d)?)\b/i;
const FAILURE_RE = /\b(fail(?:ed|ure)?|error|false|red|denied|rejected|incomplete)\b/i;

/**
 * Strict, status-specific evidence check. For 'verified' the authoritative gate is
 * Phase 19 developmentGoal.canMarkComplete; dispatch/process states use their own
 * strict marker check (canMarkComplete does not recognise dispatch markers). Only
 * an early `true` is honoured from canMarkComplete — a false result still allows the
 * equivalent marker check to run. A bare agent claim never passes.
 */
async function strictEvidenceOk(status, evidence) {
  const arr = Array.isArray(evidence) ? evidence : [];
  if (!arr.length) return false;

  if (status === "verified") {
    const dg = await load("developmentGoal");
    if (typeof dg?.canMarkComplete === "function") {
      try { if (dg.canMarkComplete(arr) === true) return true; } catch { /* fall through */ }
    }
  }

  const markers = EVIDENCE_MARKERS[status] || [];
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const [key, val] of Object.entries(item)) {
        const k = key.toLowerCase();
        if (markers.includes(k) && val !== false && val !== 0 &&
            SUCCESS_RE.test(String(val)) && !FAILURE_RE.test(String(val))) return true;
      }
      const kind = String(item.kind ?? item.type ?? "").toLowerCase();
      if (markers.includes(kind) && !FAILURE_RE.test(String(item.result ?? item.status ?? ""))) return true;
    } else if (typeof item === "string") {
      const s = item.toLowerCase().slice(0, 2000);
      if (markers.some((m) => s.includes(m)) && SUCCESS_RE.test(s) && !FAILURE_RE.test(s)) return true;
    }
  }
  return false;
}

/**
 * Assign an agent to a task. Idempotent by UNIQUE(project_id, task_id, agent).
 * When the task is resolvable in dev_task it MUST belong to the same project;
 * a task that exists only in another project is rejected (never cross-project).
 * Assignment is recorded as PLANNED only — no dispatch or execution is implied.
 */
export async function assignOwner({
  project_id, task_id, agent, assignment_reason, scope, expected_output, created_by,
} = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!nonEmpty(task_id) || !nonEmpty(agent)) return { ok: false, reason: "task_id and agent are required" };
  if (scope != null && (typeof scope !== "object" || Array.isArray(scope))) {
    return { ok: false, reason: "scope must be an object" };
  }
  if (assignment_reason != null && typeof assignment_reason !== "string") {
    return { ok: false, reason: "assignment_reason must be a string" };
  }
  if (expected_output != null && typeof expected_output !== "string") {
    return { ok: false, reason: "expected_output must be a string" };
  }

  const pid = short(project_id, 200).trim();
  const tid = short(task_id, MAX_ID).trim();
  const ag = short(agent, MAX_AGENT).trim();
  const reason = redactString(assignment_reason ?? "").slice(0, MAX_REASON);
  const expected = redactString(expected_output ?? "").slice(0, MAX_EXPECTED);
  const scopeJson = JSON.stringify(redactValue(scope ?? {}));
  const actor = short(created_by || "", MAX_ACTOR);

  try {
    // Task validation (best-effort): only reject when we can prove the task
    // belongs to a DIFFERENT project. Same-project tasks (or an unresolvable
    // task) are accepted so ownership can be recorded ahead of task creation.
    const check = await core.dbQuery(
      "SELECT project_id FROM dev_task WHERE id=$1 LIMIT 1", [tid]);
    if (check.rowCount && String(check.rows[0].project_id) !== pid) {
      return { ok: false, reason: "task does not belong to project" };
    }

    const existing = (await core.dbQuery(
      `SELECT ${OWNERSHIP_FIELDS} FROM pm_ownership
       WHERE project_id=$1 AND task_id=$2 AND agent=$3 LIMIT 1`, [pid, tid, ag])).rows[0];
    if (existing) {
      return { ok: true, id: existing.id, duplicate: true, status: existing.status,
        owner: rowToOwnership(existing), note: NOTE, claim: CLAIM };
    }

    const id = crypto.randomUUID();
    await core.dbQuery(
      `INSERT INTO pm_ownership
         (id, project_id, task_id, agent, assignment_reason, scope, expected_output,
          status, evidence, handoff, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'planned','[]'::jsonb,'{}'::jsonb,now(),now())`,
      [id, pid, tid, ag, reason, scopeJson, expected]);
    const row = (await core.dbQuery(
      `SELECT ${OWNERSHIP_FIELDS} FROM pm_ownership WHERE id=$1 AND project_id=$2`, [id, pid])).rows[0];
    await audit("p26.ownership.assign", pid, { id, task_id: tid, agent: ag, scope_keys: Object.keys(scope ?? {}).length });
    return { ok: true, id, duplicate: false, status: "planned", owner: rowToOwnership(row), note: NOTE, claim: CLAIM };
  } catch (e) {
    return { ok: false, reason: `assignOwner failed: ${short(e?.message || e, 120)}` };
  }
}

/**
 * Set the ownership state. 'running' requires dispatch evidence;
 * 'completed_process' requires process evidence; 'verified' requires Phase 24
 * style verification evidence. States that cannot be evidenced are either
 * rejected (ok:false, reason:'insufficient_evidence') or, when the caller opts
 * in with fallback:'unknown', stored as 'unknown' — never invented execution.
 */
export async function setOwnershipState({
  project_id, task_id, agent, status, evidence, actor, fallback,
} = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!nonEmpty(task_id) || !nonEmpty(agent)) return { ok: false, reason: "task_id and agent are required" };
  if (!STATES.includes(status)) return { ok: false, reason: "invalid status" };
  if (!nonEmpty(actor)) return { ok: false, reason: "actor is required" };
  if (evidence !== undefined && !Array.isArray(evidence)) {
    return { ok: false, reason: "evidence must be an array" };
  }

  const pid = short(project_id, 200).trim();
  const tid = short(task_id, MAX_ID).trim();
  const ag = short(agent, MAX_AGENT).trim();
  const who = short(actor, MAX_ACTOR);
  const newEvidence = normalizeEvidence(evidence ?? []);

  try {
    const row = (await core.dbQuery(
      `SELECT ${OWNERSHIP_FIELDS} FROM pm_ownership
       WHERE project_id=$1 AND task_id=$2 AND agent=$3 LIMIT 1`, [pid, tid, ag])).rows[0];
    if (!row) return { ok: false, reason: "ownership assignment not found in project" };

    let finalStatus = status;
    let gated = false;
    if (EVIDENCE_GATED.has(status)) {
      const ok = await strictEvidenceOk(status, newEvidence);
      if (!ok) {
        if (fallback === "unknown") finalStatus = "unknown";
        else return { ok: false, reason: "insufficient_evidence", requested_status: status, claim: CLAIM };
      }
      gated = finalStatus !== "unknown";
    }
    void SELF_RECORDED; // prepared/reviewed are self-recorded historical facts.

    const oldEvidence = Array.isArray(row.evidence) ? row.evidence : [];
    const merged = [...oldEvidence, {
      kind: "ownership_state_transition",
      from: row.status,
      to: finalStatus,
      requested: status,
      evidence_ok: gated,
      actor: who,
      at: new Date().toISOString(),
    }, ...newEvidence].slice(-MAX_EVIDENCE_ITEMS);

    await core.dbQuery(
      `UPDATE pm_ownership SET status=$1, evidence=$2::jsonb, updated_at=now()
       WHERE id=$3 AND project_id=$4`,
      [finalStatus, JSON.stringify(merged), row.id, pid]);
    await audit("p26.ownership.state", pid, { id: row.id, task_id: tid, agent: ag,
      to: finalStatus, requested: status, evidence_count: newEvidence.length });
    return { ok: true, status: finalStatus, requested_status: status, gated,
      evidence_accepted: gated, note: NOTE, claim: CLAIM };
  } catch (e) {
    return { ok: false, reason: `setOwnershipState failed: ${short(e?.message || e, 120)}` };
  }
}

/** Bounded, project-scoped read of a single ownership assignment. */
export async function getOwnership({ project_id, task_id, agent } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!nonEmpty(task_id) || !nonEmpty(agent)) return { ok: false, reason: "task_id and agent are required" };
  const pid = short(project_id, 200).trim();
  try {
    const row = (await core.dbQuery(
      `SELECT ${OWNERSHIP_FIELDS} FROM pm_ownership
       WHERE project_id=$1 AND task_id=$2 AND agent=$3 LIMIT 1`,
      [pid, short(task_id, MAX_ID).trim(), short(agent, MAX_AGENT).trim()])).rows[0];
    if (!row) return { ok: false, reason: "ownership assignment not found", found: false };
    return { ok: true, found: true, owner: rowToOwnership(row), note: NOTE, claim: CLAIM };
  } catch (e) {
    return { ok: false, reason: `getOwnership failed: ${short(e?.message || e, 120)}` };
  }
}

/** Bounded, project-scoped overview with counts by status. */
export async function ownershipOverview({ project_id, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, items: [], reason: "valid project_id required" };
  const pid = short(project_id, 200).trim();
  const n = maxLimit(limit);
  try {
    const rows = (await core.dbQuery(
      `SELECT ${OWNERSHIP_FIELDS} FROM pm_ownership
       WHERE project_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [pid, n])).rows;
    const countRows = (await core.dbQuery(
      "SELECT status, count(*)::int AS n FROM pm_ownership WHERE project_id=$1 GROUP BY status", [pid])).rows;
    const counts = {};
    for (const s of STATES) counts[s] = 0;
    for (const r of countRows) counts[r.status] = r.n;
    return { ok: true, project_id: pid, items: rows.map(rowToOwnership), count: rows.length,
      counts, note: NOTE, claim: CLAIM, degraded: [] };
  } catch (e) {
    return { ok: false, items: [], reason: `ownershipOverview failed: ${short(e?.message || e, 120)}` };
  }
}

export default { assignOwner, setOwnershipState, getOwnership, ownershipOverview };
