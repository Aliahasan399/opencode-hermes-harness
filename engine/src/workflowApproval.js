// Phase 24 — single-use, scope-bound execution approvals (LEVEL 1 gate).
// This module ONLY creates/verifies/consumes approval artifacts. It never spawns a
// process, never dispatches an agent, never writes source files and never performs
// destructive operations. The plaintext token is returned once at creation; only
// sha256(token) is persisted. Every capability is fail-closed (returns ok:false
// instead of throwing), every read is bounded, all strings are redacted before they
// are returned or audited, and every project-scoped call rejects `_global`.
import crypto from "node:crypto";
import * as core from "./core.js";

// Facade idiom helper (kept for symmetry with sibling Phase 22/23 modules; this
// module is self-contained and currently composes no optional siblings).
async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
void load;

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;      // 24h
const MIN_EXPIRY_MS = 1000;                          // 1s
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;     // 30 days
const MODES = new Set(["simulation", "real"]);
const RISKS = new Set(["low", "medium", "high"]);
const NOTE = "Approval artifact only: this gates a future dispatch but performs no dispatch, spawns no process and changes no source. Token is returned once; only its sha256 is stored.";
const CLAIM = "NO_RUNTIME_CLAIM";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim().length > 0 && p !== "_global";
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const hashString = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const clampLimit = (limit) => {
  const n = Number(limit);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), 200)) : 50;
};
const clampExpiry = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) ? Math.max(MIN_EXPIRY_MS, Math.min(Math.floor(n), MAX_EXPIRY_MS)) : DEFAULT_EXPIRY_MS;
};

/** Redact a single string using core.redact plus explicit Bearer/sk- coverage. */
function redactString(v) {
  let s = core.redact(String(v ?? ""));
  s = s.replace(/\bBearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED_API_KEY]");
  return s;
}

/** Recursively redact every string in a value; sort object keys for canonical form. */
function redactValue(v) {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = redactValue(v[k]);
    return out;
  }
  return v;
}

/** Canonical, redacted JSON of a scope object -> stable scope_key source. */
function canonicalScope(scope) {
  const obj = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  return JSON.stringify(redactValue(obj));
}

/** Strip token_hash and redact any residual credential-like text from a row. */
function redactApproval(row) {
  if (!row) return null;
  const { token_hash, ...rest } = row; // eslint-disable-line no-unused-vars
  return redactValue(rest);
}

/** Best-effort audit: detail is recursively redacted and never carries a token. */
async function auditSafe(action, project_id, detail = {}) {
  try { await core.audit(action, project_id, redactValue(detail)); }
  catch { /* auditing is best-effort and must never block a gate operation */ }
}

/** Shared input validation for the binding-producing capabilities. */
function validateBinding({ project_id, plan_id, plan_version, plan_hash, mode, risk, scope }) {
  if (!validProject(project_id)) return "valid project_id required";
  if (!nonEmpty(plan_id)) return "plan_id required";
  if (!nonEmpty(plan_version)) return "plan_version required";
  if (!nonEmpty(plan_hash)) return "plan_hash required";
  if (!MODES.has(mode)) return "mode must be 'simulation' or 'real'";
  if (!RISKS.has(risk)) return "risk must be 'low', 'medium' or 'high'";
  if (scope != null && (typeof scope !== "object" || Array.isArray(scope))) return "scope must be an object";
  return null;
}

/**
 * Create an approval artifact. Return the plaintext token exactly once; persist
 * only sha256(token). `request` is accepted for API symmetry but is never stored
 * or audited verbatim.
 */
export async function createApproval({
  project_id, plan_id, plan_version, plan_hash, scope,
  mode = "simulation", risk, approved_by = "", expires_in_ms, request,
} = {}) {
  const bad = validateBinding({ project_id, plan_id, plan_version, plan_hash, mode, risk, scope });
  if (bad) return { ok: false, reason: bad };
  void request; // accepted, not persisted

  const approval_id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const token_hash = hashString(token);
  const scopeJson = canonicalScope(scope ?? {});
  const scope_key = hashString(scopeJson);
  const expires_at = new Date(Date.now() + clampExpiry(expires_in_ms)).toISOString();

  try {
    await core.dbQuery(
      `INSERT INTO workflow_approval
         (id, project_id, plan_id, plan_version, plan_hash, scope_key, scope, mode, risk,
          approved_by, token_hash, status, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'active',$12,now(),now())`,
      [approval_id, project_id, String(plan_id), String(plan_version), String(plan_hash),
        scope_key, scopeJson, mode, risk, redactString(approved_by), token_hash, expires_at]);
    const row = (await core.dbQuery(
      "SELECT * FROM workflow_approval WHERE id=$1 AND project_id=$2", [approval_id, project_id])).rows[0];
    await auditSafe("p24.approval.create", project_id, {
      approval_id, plan_id: short(plan_id, 80), plan_version: short(plan_version, 80),
      mode, risk, scope_key,
    });
    return { ok: true, approval_id, token, approval: redactApproval(row), note: NOTE, claim: CLAIM };
  } catch (e) {
    return { ok: false, reason: `approval creation failed: ${short(e?.message || e, 120)}` };
  }
}

/**
 * Verify an approval against its exact bindings. No state is changed here; the
 * atomic, single-use state change lives in consumeApproval.
 */
export async function verifyApproval({
  project_id, approval_id, token, plan_id, plan_version, plan_hash, scope, mode, risk,
} = {}) {
  const bad = validateBinding({ project_id, plan_id, plan_version, plan_hash, mode, risk, scope });
  if (bad) return { ok: false, reason: bad };
  if (!nonEmpty(approval_id)) return { ok: false, reason: "approval_id required" };
  if (!nonEmpty(token)) return { ok: false, reason: "token required" };

  const token_hash = hashString(token);
  const scope_key = hashString(canonicalScope(scope ?? {}));
  try {
    const row = (await core.dbQuery(
      "SELECT * FROM workflow_approval WHERE id=$1 AND project_id=$2", [approval_id, project_id])).rows[0];
    if (!row) return { ok: false, reason: "approval not found in project scope" };
    if (row.token_hash !== token_hash) return { ok: false, reason: "token mismatch" };
    if (row.status !== "active") return { ok: false, reason: `approval is ${row.status}` };
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: "approval expired" };
    }
    if (row.plan_id !== String(plan_id)) return { ok: false, reason: "plan_id mismatch" };
    if (row.plan_version !== String(plan_version)) return { ok: false, reason: "plan_version mismatch" };
    if (row.plan_hash !== String(plan_hash)) return { ok: false, reason: "plan_hash mismatch" };
    if (row.scope_key !== scope_key) return { ok: false, reason: "scope mismatch" };
    if (row.mode !== mode) return { ok: false, reason: "mode mismatch" };
    if (row.risk !== risk) return { ok: false, reason: "risk mismatch" };
    return { ok: true, approval: redactApproval(row) };
  } catch (e) {
    return { ok: false, reason: `verification failed: ${short(e?.message || e, 120)}` };
  }
}

/**
 * Atomically consume an approval. Verifies every binding first, then flips
 * status active->consumed with a single guarded UPDATE ... RETURNING. A second
 * call cannot consume again (replay/idempotency protection).
 */
export async function consumeApproval({
  project_id, approval_id, token, plan_id, plan_version, plan_hash, scope, mode, risk,
} = {}) {
  const bad = validateBinding({ project_id, plan_id, plan_version, plan_hash, mode, risk, scope });
  if (bad) return { ok: false, consumed: false, reason: bad };
  if (!nonEmpty(approval_id)) return { ok: false, consumed: false, reason: "approval_id required" };
  if (!nonEmpty(token)) return { ok: false, consumed: false, reason: "token required" };

  const verified = await verifyApproval({
    project_id, approval_id, token, plan_id, plan_version, plan_hash, scope, mode, risk,
  });
  if (!verified.ok) return { ok: false, consumed: false, reason: verified.reason };

  const token_hash = hashString(token);
  try {
    const upd = await core.dbQuery(
      `UPDATE workflow_approval
         SET status='consumed', consumed_at=now(), updated_at=now()
       WHERE id=$1 AND project_id=$2 AND token_hash=$3 AND status='active'
         AND (expires_at IS NULL OR expires_at>now())
       RETURNING id`,
      [approval_id, project_id, token_hash]);
    if (!upd.rowCount) {
      return { ok: false, consumed: false, reason: "approval already consumed or no longer active" };
    }
    await auditSafe("p24.approval.consume", project_id, { approval_id, mode, risk });
    return { ok: true, consumed: true, approval_id, note: NOTE, claim: CLAIM };
  } catch (e) {
    return { ok: false, consumed: false, reason: `consume failed: ${short(e?.message || e, 120)}` };
  }
}

/** Bounded, redacted listing. token_hash is never selected or returned. */
export async function listApprovals({ project_id, limit = 50 } = {}) {
  if (!validProject(project_id)) return { ok: false, items: [], reason: "valid project_id required" };
  const n = clampLimit(limit);
  try {
    const r = await core.dbQuery(
      `SELECT id, project_id, plan_id, plan_version, plan_hash, scope_key, scope, mode, risk,
              approved_by, status, expires_at, consumed_at, created_at, updated_at
       FROM workflow_approval WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [project_id, n]);
    return { ok: true, items: r.rows.map(redactApproval), degraded: [] };
  } catch (e) {
    return { ok: true, items: [], degraded: [`listing failed: ${short(e?.message || e, 120)}`] };
  }
}

/** Revoke an active approval (idempotent; never revokes another project's row). */
export async function revokeApproval({ project_id, approval_id, reason = "" } = {}) {
  if (!validProject(project_id)) return { ok: false, revoked: false, reason: "valid project_id required" };
  if (!nonEmpty(approval_id)) return { ok: false, revoked: false, reason: "approval_id required" };
  try {
    const r = await core.dbQuery(
      `UPDATE workflow_approval SET status='revoked', updated_at=now()
       WHERE id=$1 AND project_id=$2 AND status='active' RETURNING id`,
      [approval_id, project_id]);
    const revoked = r.rowCount > 0;
    await auditSafe("p24.approval.revoke", project_id, { approval_id, revoked, reason: short(reason, 200) });
    return { ok: true, revoked };
  } catch (e) {
    return { ok: false, revoked: false, reason: `revoke failed: ${short(e?.message || e, 120)}` };
  }
}

export default { createApproval, verifyApproval, consumeApproval, listApprovals, revokeApproval };
