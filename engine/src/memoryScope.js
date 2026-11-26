// Global-memory eligibility and cross-project isolation for MCP memory access paths.
//
// Problem this module addresses (audit findings, read-only):
//   - core.saveMemory() defaults project_id to '_global' when the caller omits it.
//   - core.listMemories(), core.searchMemory() and contextPackage.prepareContext()
//     include rows with `project_id='_global'` in EVERY project's results via
//     `... OR project_id='_global'`.
//   - The automation/learning/import paths write project-scoped facts with
//     project_id '_global' (no explicit approval metadata), so a project's private
//     knowledge can be returned to any unrelated project.
//   - contextRetrieve() even *boosts* `_global` rows (+0.03, "global").
//
// This module is a pure/new layer. It never reclassifies or mutates existing rows.
// It relies on a `global_eligible boolean` column that the PARENT migration adds
// (ALTER TABLE memory ADD COLUMN global_eligible boolean NOT NULL DEFAULT false).
// Until that migration lands, the post-filter path (which needs no column) still
// works, and the SQL path must be used against a table that has the column.

import * as core from "./core.js";

export const GLOBAL_PROJECT_ID = "_global";

// SQL predicate: a row is globally eligible iff it carries an explicit flag, or it
// is a verified user fact explicitly approved for global use in its metadata.
// `metadata @> '{"global_approval": true}'::jsonb` matches only a JSON boolean true.
export const GLOBAL_ELIGIBLE_SQL = `(
  global_eligible IS TRUE
  OR (
    source_kind = 'user'
    AND layer = 'user'
    AND verified IS TRUE
    AND metadata @> '{"global_approval": true}'::jsonb
  )
)`;

function parseMetadata(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

// A real project is any non-empty project id that is not the sentinel '_global'.
function requestedProject(project_id) {
  if (typeof project_id !== "string" || project_id.length === 0) return null;
  return project_id === GLOBAL_PROJECT_ID ? null : project_id;
}

/**
 * Pure eligibility check. Explicit rules only:
 *   eligible iff memory.global_eligible === true
 *   OR (source_kind === 'user' && layer === 'user' && verified === true
 *       && memory.metadata.global_approval === true)
 * Everything else is ineligible. No row is reclassified or mutated.
 */
export function isGloballyEligible(memory) {
  if (!memory || typeof memory !== "object") return false;
  if (memory.global_eligible === true) return true;
  const metadata = parseMetadata(memory.metadata);
  const approval = metadata && typeof metadata === "object" ? metadata.global_approval : undefined;
  return memory.source_kind === "user"
    && memory.layer === "user"
    && memory.verified === true
    && approval === true;
}

/**
 * Build a SQL WHERE fragment that includes ONLY the requested project plus
 * globally-eligible rows (when allow_global). Other projects are never included.
 * Returns { sql, clause, params }; `clause` is an alias for `sql`.
 * `startIndex` lets a parent embed the fragment into a query with prior params.
 */
export function scopeFilter({ project_id, allow_global = true, startIndex = 1 } = {}) {
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    throw new RangeError("startIndex must be a positive integer");
  }
  const requested = requestedProject(project_id);
  const pProject = `$${startIndex}`;
  const pGlobal = `$${startIndex + 1}`;
  const sql = `(( ${pProject}::text IS NOT NULL AND project_id = ${pProject} )
    OR ( ${pGlobal}::boolean AND project_id = '${GLOBAL_PROJECT_ID}' AND ${GLOBAL_ELIGIBLE_SQL} ))`;
  return { sql, clause: sql, params: [requested, allow_global === true] };
}

/**
 * Post-filter already-fetched rows with the same rules. Returns a NEW array and
 * never mutates the input rows or the input array.
 */
export function filterMemoryResults(results, { project_id, allow_global = true } = {}) {
  const requested = requestedProject(project_id);
  const list = Array.isArray(results) ? results : [];
  return list.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (requested && m.project_id === requested) return true;
    if (allow_global === true && m.project_id === GLOBAL_PROJECT_ID && isGloballyEligible(m)) return true;
    return false;
  });
}

/**
 * READ-ONLY report of `_global` rows that are currently NOT globally eligible.
 * No writes, no deletes, no updates. Returns bounded items + a total count.
 */
export async function globalMisclassificationReport({ limit = 100 } = {}) {
  const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 500) : 100;
  const { rows } = await core.dbQuery(
    `SELECT id, source_session, source_kind, layer, created_at,
            (count(*) OVER ())::int AS total,
            CASE
              WHEN source_kind IS DISTINCT FROM 'user' THEN 'source_kind is not user'
              WHEN layer IS DISTINCT FROM 'user' THEN 'layer is not user'
              WHEN verified IS NOT TRUE THEN 'not verified'
              ELSE 'no global_eligible flag and no explicit global_approval metadata'
            END AS reason
     FROM memory
     WHERE project_id = '${GLOBAL_PROJECT_ID}'
       AND NOT (${GLOBAL_ELIGIBLE_SQL})
     ORDER BY created_at DESC
     LIMIT $1`,
    [n],
  );
  const items = rows.map(({ id, source_session, source_kind, layer, created_at, reason }) =>
    ({ id, source_session, source_kind, layer, created_at, reason }));
  return {
    ok: true,
    total: rows[0]?.total ?? 0,
    items,
    auto_applied: 0,
    destructive_operations: 0,
    note: "Read-only classification audit. This report never changes memory.",
  };
}

const ADMIN_TOOLS = new Set([
  "memory_save", "memory_update", "memory_delete", "memory_lifecycle",
  "memory_suggestion_resolve", "consolidation_apply_approved", "consolidation_rollback",
  "consolidation_triage", "memory_import_history", "memory_sessions_enrich",
  "memory_mark_useful", "memory_explicit_feedback", "memory_observe_usage",
  "memory_assess_quality", "memory_detect_duplicates", "memory_find_contradictions",
  "learning_strategy_lifecycle", "optimizer_decide", "optimizer_prepare_action",
  "optimizer_evaluate_result",
]);

const RETRIEVAL_TOOLS = new Set([
  "memory_search", "memory_semantic_search", "memory_adaptive_search", "memory_get",
  "memory_list", "memory_project_context", "memory_summarize", "memory_resume_session",
  "memory_session_search", "memory_session_detail", "memory_versions",
  "memory_get_relationships", "memory_patterns_list", "optimizer_get_context",
  "context_prepare",
]);

/**
 * Guard MCP tool calls. Administrative/user-approved tools stay allowed but are
 * flagged for caller-side auditing. Retrieval tools must carry an explicit project
 * scope; unscoped retrieval is denied by default, and any global rows returned by
 * an allowed retrieval must be limited to the globally eligible set.
 */
export function memoryAccessGuard({ tool, args, project_id } = {}) {
  const name = String(tool || "");
  if (ADMIN_TOOLS.has(name)) {
    return {
      allowed: true,
      reason: `administrative/user-approved tool '${name}'; caller must write an audit entry`,
      scope: "administrative",
      audited_by_caller: true,
      require_global_eligibility: false,
    };
  }
  if (RETRIEVAL_TOOLS.has(name)) {
    const pid = project_id ?? args?.project_id ?? null;
    const requested = requestedProject(pid);
    if (requested) {
      return {
        allowed: true,
        reason: `project-scoped retrieval for '${requested}'; global rows limited to the eligible set`,
        scope: "project",
        project_id: requested,
        audited_by_caller: false,
        require_global_eligibility: true,
      };
    }
    if (pid === GLOBAL_PROJECT_ID) {
      return {
        allowed: true,
        reason: "explicit global retrieval; only globally-eligible memories may be returned",
        scope: "global-eligible-only",
        project_id: GLOBAL_PROJECT_ID,
        audited_by_caller: false,
        require_global_eligibility: true,
      };
    }
    return {
      allowed: false,
      reason: "retrieval tools require an explicit project scope; pass project_id",
      scope: "none",
      audited_by_caller: false,
      require_global_eligibility: true,
    };
  }
  return {
    allowed: false,
    reason: `unknown tool '${name}'; not a recognized retrieval or administrative tool`,
    scope: "unknown",
  };
}
