// Unified memory authorization layer (Phase 14).
//
// Covers BOTH direct access (a caller names a memory id) and indirect access
// (relationship traversal, version history, session detail, consolidation
// suggestions). Every path is resolved against the same project-isolation rule:
//   - a row belonging to the requested project is visible;
//   - a `_global` row is visible only when it is globally eligible
//     (reuses memoryScope.isGloballyEligible -- no reclassification, no mutation);
//   - anything else is another project's private memory and is denied.
//
// Autonomy Level 1: there is NO implicit admin. `admin` must be the literal
// boolean true; any other value (including truthy strings/1) is treated as a
// non-admin request. Retrieval without an explicit project scope fails closed.
//
// Audit events use track='memory', action='access_decision'. They record ONLY
// ids, actions, scope and a short reason -- never memory content, titles or
// any other payload data.

import * as core from "./core.js";
import { isGloballyEligible, GLOBAL_PROJECT_ID } from "./memoryScope.js";

const AUDIT_TRACK = "memory";
const AUDIT_ACTION = "access_decision";

function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length ? s.slice(0, 512) : null;
}

function requestedProject(project_id) {
  if (typeof project_id !== "string" || project_id.length === 0) return null;
  return project_id === GLOBAL_PROJECT_ID ? null : project_id;
}

function isAdmin(admin) {
  return admin === true;
}

// Client-supplied ids must be validated before they reach a uuid-typed column.
// Without this, PostgreSQL raises 22P02 and the caller escapes withAudit(), so
// the request is neither fail-closed nor audited. Keeping the check here makes
// every id-backed path fail closed with a normal access_decision audit event.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// The same visibility rule used by every memory-id-backed path.
function isVisibleTo(row, requested) {
  if (!row || typeof row !== "object") return false;
  if (requested && row.project_id === requested) return true;
  if (row.project_id === GLOBAL_PROJECT_ID && isGloballyEligible(row)) return true;
  return false;
}

async function fetchMemory(memory_id) {
  if (!memory_id || !isUuid(memory_id)) return null;
  const { rows } = await core.dbQuery(
    `SELECT id, project_id, global_eligible, source_kind, layer, verified, metadata
       FROM memory WHERE id = $1 LIMIT 1`,
    [memory_id],
  );
  return rows[0] || null;
}

/**
 * Write a single access-decision audit event. Only ids/actions/scope/reason are
 * stored; content is never read or written here.
 */
export async function auditAccessDecision(decision = {}, { tool, memory_id, project_id } = {}) {
  const d = decision && typeof decision === "object" ? decision : {};
  const detail = {
    tool: textOrNull(tool ?? d.tool),
    action: textOrNull(d.action || "read"),
    memory_id: textOrNull(memory_id ?? d.memory_id),
    project_id: textOrNull(project_id ?? d.project_id),
    allowed: d.allowed === true,
    scope: textOrNull(d.scope),
    reason: textOrNull(d.reason),
  };
  const resource = textOrNull(memory_id ?? d.memory_id ?? project_id ?? d.project_id ?? tool)
    || "memory_access";
  const { rows } = await core.dbQuery(
    `INSERT INTO intelligence_audit_events (track, action, resource, detail)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [AUDIT_TRACK, AUDIT_ACTION, resource, JSON.stringify(detail)],
  );
  return { ok: true, id: rows[0]?.id ?? null, detail };
}

// Attach an audit descriptor to a decision and persist the event. Centralized
// so no path can accidentally skip logging or start logging content.
async function withAudit(decision, ctx = {}) {
  const out = { ...decision };
  out.action = ctx.action ?? out.action ?? "read";
  out.tool = ctx.tool ?? out.tool ?? null;
  out.memory_id = ctx.memory_id ?? out.memory_id ?? null;
  out.project_id = ctx.project_id ?? out.project_id ?? null;
  const written = await auditAccessDecision(out, ctx);
  out.audit = {
    required: true,
    logged: written.ok,
    id: written.id,
    track: AUDIT_TRACK,
    action: AUDIT_ACTION,
  };
  return out;
}

function baseDecision(allowed, reason, scope) {
  return { allowed: allowed === true, reason, scope };
}

/**
 * Authorize a direct (or general) memory access.
 * Returns { allowed, reason, scope, audit, ... } and always logs the decision.
 */
export async function authorizeMemoryAccess({
  tool,
  project_id,
  memory_id,
  admin = false,
  action = "read",
} = {}) {
  const ctx = { tool, project_id, memory_id, action };
  const requested = requestedProject(project_id);
  const explicitGlobal = project_id === GLOBAL_PROJECT_ID;

  // Explicit admin is the only bypass, and it is audited.
  if (isAdmin(admin)) {
    return withAudit({
      ...baseDecision(true, "explicit admin override; decision audited", "admin"),
      memory_id, project_id, action, tool,
    }, ctx);
  }

  // Retrieval requires an explicit project scope. 'none' fails closed.
  if (!requested && !explicitGlobal) {
    return withAudit({
      ...baseDecision(false, "access requires an explicit project scope; pass project_id", "none"),
      memory_id, project_id, action, tool,
    }, ctx);
  }

  if (!memory_id) {
    // No specific row named: a real project scope may read its own results;
    // an explicit global scope is limited to globally-eligible rows only.
    return withAudit({
      ...baseDecision(true,
        requested ? `project-scoped access for '${requested}'` : "global scope; eligible globals only",
        requested ? "project" : "global-eligible-only"),
      project_id, action, tool,
    }, ctx);
  }

  const row = await fetchMemory(memory_id);
  if (!row) {
    return withAudit({
      ...baseDecision(false, "memory_id not found; failing closed", "none"),
      memory_id, project_id, action, tool,
    }, ctx);
  }

  if (requested && row.project_id === requested) {
    return withAudit({
      ...baseDecision(true, `memory belongs to requested project '${requested}'`, "project"),
      memory_id, project_id, action, tool,
    }, ctx);
  }

  if (isVisibleTo(row, requested)) {
    // Reaches here only for a globally-eligible `_global` row.
    return withAudit({
      ...baseDecision(true, "globally eligible memory is visible to all project scopes", "global-eligible"),
      memory_id, project_id, action, tool,
    }, ctx);
  }

  return withAudit({
    ...baseDecision(false, "memory belongs to a different project and is not globally eligible", "denied"),
    memory_id, project_id, action, tool,
  }, ctx);
}

/**
 * Indirect path: relationship traversal. Denies when ANY related target is
 * another project's private memory, and returns only the visible relations.
 */
export async function authorizeRelationshipTraversal({ project_id, memory_id } = {}) {
  const ctx = { tool: "memory_get_relationships", project_id, memory_id, action: "traverse" };
  const requested = requestedProject(project_id);

  if (!requested && project_id !== GLOBAL_PROJECT_ID) {
    return withAudit({
      ...baseDecision(false, "traversal requires an explicit project scope; pass project_id", "none"),
      relations: [], blocked_count: 0, memory_id, project_id,
    }, ctx);
  }

  const source = await fetchMemory(memory_id);
  if (!source || !isVisibleTo(source, requested)) {
    return withAudit({
      ...baseDecision(false, "source memory is not visible in this project scope", "denied"),
      relations: [], blocked_count: 0, memory_id, project_id,
    }, ctx);
  }

  const { rows } = await core.dbQuery(
    `SELECT r.id AS rel_id, r.source_id, r.target_id, r.relation,
            other.id AS other_id, other.project_id AS other_project_id,
            other.global_eligible, other.source_kind, other.layer,
            other.verified, other.metadata
       FROM memory_relationships r
       JOIN memory other
         ON other.id = CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END
      WHERE r.source_id = $1 OR r.target_id = $1
      ORDER BY r.id`,
    [memory_id],
  );

  const relations = [];
  let blockedCount = 0;
  for (const r of rows) {
    const other = {
      id: r.other_id,
      project_id: r.other_project_id,
      global_eligible: r.global_eligible,
      source_kind: r.source_kind,
      layer: r.layer,
      verified: r.verified,
      metadata: r.metadata,
    };
    if (isVisibleTo(other, requested)) {
      relations.push({
        id: r.rel_id,
        source_id: r.source_id,
        target_id: r.target_id,
        relation: r.relation,
        visible_memory_id: r.other_id,
      });
    } else {
      // Count only; never expose the private target's id or data to the caller.
      blockedCount += 1;
    }
  }

  return withAudit({
    ...baseDecision(blockedCount === 0,
      blockedCount === 0
        ? "all related memories are visible in this project scope"
        : "traversal denied: at least one related target is another project's private memory",
      blockedCount === 0 ? "project" : "denied"),
    relations,
    blocked_count: blockedCount,
    memory_id,
    project_id,
  }, ctx);
}

/** Indirect path: version history of a memory. */
export async function authorizeVersionHistory({ project_id, memory_id } = {}) {
  const ctx = { tool: "memory_versions", project_id, memory_id, action: "history" };
  const requested = requestedProject(project_id);

  if (!requested && project_id !== GLOBAL_PROJECT_ID) {
    return withAudit({
      ...baseDecision(false, "version history requires an explicit project scope; pass project_id", "none"),
      versions: [], version_count: 0, memory_id, project_id,
    }, ctx);
  }

  const row = await fetchMemory(memory_id);
  if (!row || !isVisibleTo(row, requested)) {
    return withAudit({
      ...baseDecision(false, "memory is not visible in this project scope", "denied"),
      versions: [], version_count: 0, memory_id, project_id,
    }, ctx);
  }

  // Return version metadata only -- never the stored content.
  const { rows } = await core.dbQuery(
    `SELECT version, changed_at FROM memory_history WHERE memory_id = $1 ORDER BY version DESC`,
    [memory_id],
  );
  return withAudit({
    ...baseDecision(true, "version history visible for an in-scope memory", "project"),
    versions: rows.map((r) => ({ version: r.version, changed_at: r.changed_at })),
    version_count: rows.length,
    memory_id,
    project_id,
  }, ctx);
}

/** Indirect path: session detail. session_index has no global-eligibility notion. */
export async function authorizeSessionDetail({ project_id, session_id } = {}) {
  const ctx = { tool: "memory_session_detail", project_id, memory_id: session_id, action: "read" };
  const requested = requestedProject(project_id);

  if (!requested) {
    return withAudit({
      ...baseDecision(false, "session detail requires an explicit project scope; pass project_id", "none"),
      session_id: textOrNull(session_id), project_id,
    }, ctx);
  }

  if (!session_id) {
    return withAudit({
      ...baseDecision(false, "session_id is required; failing closed", "none"),
      session_id: null, project_id,
    }, ctx);
  }

  const { rows } = await core.dbQuery(
    "SELECT project_id FROM session_index WHERE id = $1 LIMIT 1",
    [session_id],
  );
  const row = rows[0];
  if (!row || row.project_id !== requested) {
    return withAudit({
      ...baseDecision(false, "session does not belong to the requested project", "denied"),
      session_id, project_id,
    }, ctx);
  }

  return withAudit({
    ...baseDecision(true, `session belongs to requested project '${requested}'`, "project"),
    session_id, project_id,
  }, ctx);
}

/** Indirect path: consolidation suggestion (checks every referenced memory). */
export async function authorizeSuggestionAccess({ project_id, suggestion_id } = {}) {
  const ctx = { tool: "memory_suggestion_get", project_id, memory_id: suggestion_id, action: "read" };
  const requested = requestedProject(project_id);

  if (!requested && project_id !== GLOBAL_PROJECT_ID) {
    return withAudit({
      ...baseDecision(false, "suggestion access requires an explicit project scope; pass project_id", "none"),
      suggestion_id: textOrNull(suggestion_id), project_id,
    }, ctx);
  }

  if (!suggestion_id || !isUuid(suggestion_id)) {
    return withAudit({
      ...baseDecision(false, "suggestion_id is invalid or missing; failing closed", "none"),
      suggestion_id: textOrNull(suggestion_id), project_id,
    }, ctx);
  }

  const { rows } = await core.dbQuery(
    "SELECT id, memory_ids FROM consolidation_suggestion WHERE id = $1 LIMIT 1",
    [suggestion_id],
  );
  const suggestion = rows[0];
  if (!suggestion) {
    return withAudit({
      ...baseDecision(false, "suggestion not found; failing closed", "none"),
      suggestion_id, project_id,
    }, ctx);
  }

  const memoryIds = Array.isArray(suggestion.memory_ids) ? suggestion.memory_ids : [];
  let blockedCount = 0;
  for (const mid of memoryIds) {
    const ref = await fetchMemory(mid);
    if (!ref || !isVisibleTo(ref, requested)) blockedCount += 1;
  }

  return withAudit({
    ...baseDecision(blockedCount === 0,
      blockedCount === 0
        ? "all referenced memories are visible in this project scope"
        : "suggestion denied: references a private memory from another project",
      blockedCount === 0 ? "project" : "denied"),
    suggestion_id,
    memory_count: memoryIds.length,
    blocked_count: blockedCount,
    project_id,
  }, ctx);
}

/**
 * READ-ONLY count summary of recorded access decisions. No inserts, updates or
 * deletes; only SELECT statements are issued.
 */
export async function securityAuditReport({ project_id, limit = 100 } = {}) {
  const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 500) : 100;
  const requested = requestedProject(project_id);

  const totals = await core.dbQuery(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE detail->>'allowed' = 'true')::int AS allowed,
            count(*) FILTER (WHERE detail->>'allowed' = 'false')::int AS denied
       FROM intelligence_audit_events
      WHERE track = $1 AND action = $2
        AND ($3::text IS NULL OR detail->>'project_id' = $3)`,
    [AUDIT_TRACK, AUDIT_ACTION, requested],
  );

  const grouped = await core.dbQuery(
    `SELECT coalesce(detail->>'action','') AS action,
            coalesce(detail->>'scope','') AS scope,
            count(*)::int AS n,
            count(*) FILTER (WHERE detail->>'allowed' = 'true')::int AS allowed,
            count(*) FILTER (WHERE detail->>'allowed' = 'false')::int AS denied
       FROM intelligence_audit_events
      WHERE track = $1 AND action = $2
        AND ($3::text IS NULL OR detail->>'project_id' = $3)
      GROUP BY 1, 2 ORDER BY n DESC`,
    [AUDIT_TRACK, AUDIT_ACTION, requested],
  );

  const recent = await core.dbQuery(
    `SELECT id, action, resource, detail->>'memory_id' AS memory_id,
            detail->>'project_id' AS project_id, detail->>'scope' AS scope,
            detail->>'reason' AS reason, detail->>'allowed' AS allowed, created_at
       FROM intelligence_audit_events
      WHERE track = $1 AND action = $2
        AND ($3::text IS NULL OR detail->>'project_id' = $3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [AUDIT_TRACK, AUDIT_ACTION, requested, n],
  );

  const by_action = {};
  const by_scope = {};
  for (const g of grouped.rows) {
    const key = g.action || "(unknown)";
    by_action[key] = (by_action[key] || 0) + g.n;
    const skey = g.scope || "(unknown)";
    by_scope[skey] = (by_scope[skey] || 0) + g.n;
  }

  const t = totals.rows[0] || { total: 0, allowed: 0, denied: 0 };
  return {
    ok: true,
    total: t.total,
    allowed: t.allowed,
    denied: t.denied,
    by_action,
    by_scope,
    items: recent.rows,
    limit: n,
    auto_applied: 0,
    destructive_operations: 0,
    note: "Read-only summary of access decisions. This report never changes memory or audit data.",
  };
}
