// Phase 17 capability B: Technical Decision Intelligence.
//
// Additive-only layer over the `technical_decision` table (migration 015).
// Invariants:
//   - history is preserved (no DELETE, no content reclassification);
//   - an active decision is never overwritten by a same-title duplicate;
//   - supersession requires non-empty evidence and is audited via core.audit;
//   - every read is project-scoped and bounded; no LLM calls, no cross-project access.
import crypto from "node:crypto";
import * as core from "./core.js";

const FIELDS = "id, project_id, title, description, reasoning, alternatives, consequences, evidence, status, confidence, superseded_by, source_session, created_at, updated_at";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clampConfidence(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function fail(reason, id = null) {
  return { ok: false, created: false, superseded: [], id, reason };
}

/**
 * Record a technical decision. When `supersedes` names an existing decision in the
 * same project, that older row is archived (status='superseded', superseded_by=this
 * id) -- but only when non-empty evidence is supplied. Without `supersedes`, a
 * same-title active decision is reported as a duplicate and left untouched.
 */
export async function recordDecision({
  project_id,
  title,
  description = "",
  reasoning = "",
  alternatives = [],
  consequences = [],
  evidence = [],
  confidence = null,
  status = "active",
  source_session,
  supersedes = null,
  id,
} = {}) {
  if (!nonEmptyString(project_id)) return fail("project_id is required", id ?? null);
  if (!nonEmptyString(title)) return fail("title is required", id ?? null);
  if (!Array.isArray(evidence)) return fail("evidence must be an array", id ?? null);
  if (!Array.isArray(alternatives)) alternatives = [];
  if (!Array.isArray(consequences)) consequences = [];

  const newId = nonEmptyString(id) ? id : crypto.randomUUID();
  const conf = clampConfidence(confidence);
  const st = nonEmptyString(status) ? status : "active";
  const wantsSupersede = supersedes !== null && supersedes !== undefined && supersedes !== "";

  return core.withDb(async (c) => {
    let oldRow = null;
    if (wantsSupersede) {
      const old = await c.query(
        `SELECT ${FIELDS} FROM technical_decision WHERE id=$1 AND project_id=$2 LIMIT 1`,
        [String(supersedes).slice(0, 512), project_id],
      );
      if (!old.rowCount) return fail("supersedes target not found in project", newId);
      oldRow = old.rows[0];
      // A supersession with no evidence would be a misleading history rewrite.
      if (evidence.length === 0) return fail("superseding a decision requires non-empty evidence", newId);
    }

    // Never overwrite an existing same-title decision unless we are explicitly
    // replacing that exact row via `supersedes`.
    const dup = await c.query(
      `SELECT ${FIELDS} FROM technical_decision WHERE project_id=$1 AND title=$2 LIMIT 1`,
      [project_id, title],
    );
    const existing = dup.rows[0] || null;
    if (existing && (!oldRow || oldRow.id !== existing.id)) {
      return {
        ok: false, duplicate: true, created: false, superseded: [], id: existing.id,
        reason: "an active decision with this title already exists; pass supersedes to replace it",
      };
    }

    // Guard against a caller-supplied primary-key collision.
    if (nonEmptyString(id)) {
      const pk = await c.query("SELECT id FROM technical_decision WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) {
        return { ok: false, duplicate: true, created: false, superseded: [], id: newId, reason: "decision id already exists" };
      }
    }

    if (oldRow) {
      // Free the UNIQUE(project_id,title) key for the replacement while keeping
      // the old row's content intact. Only the title carries an archive marker.
      const archivedTitle = oldRow.title === title
        ? `${title} [superseded ${newId.slice(0, 8)}]`
        : oldRow.title;
      await c.query(
        `UPDATE technical_decision SET title=$2, status='superseded', superseded_by=$3, updated_at=now()
         WHERE id=$1 AND project_id=$4`,
        [oldRow.id, archivedTitle.slice(0, 512), newId, project_id],
      );
    }

    const ins = await c.query(
      `INSERT INTO technical_decision
        (id, project_id, title, description, reasoning, alternatives, consequences,
         evidence, status, confidence, superseded_by, source_session)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       RETURNING ${FIELDS}`,
      [
        newId, project_id, title, String(description ?? "").slice(0, 20000),
        String(reasoning ?? "").slice(0, 20000), JSON.stringify(alternatives),
        JSON.stringify(consequences), JSON.stringify(evidence), st, conf, null,
        source_session ? String(source_session).slice(0, 512) : null,
      ],
    );

    const supersededIds = oldRow ? [oldRow.id] : [];
    await core.audit("decision.record", project_id, {
      id: newId,
      project_id,
      status: st,
      superseded: supersededIds,
      evidence_count: evidence.length,
    });
    return {
      ok: true, id: newId, created: true, superseded: supersededIds,
      decision: ins.rows[0] || null,
    };
  });
}

/** Bounded, project-scoped listing with an ILIKE filter over title/description/reasoning. */
export async function getDecisions({ project_id, query = "", status, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, decisions: [], reason: "project_id is required" };
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const q = String(query ?? "").slice(0, 200);
  // Match any meaningful keyword rather than the whole natural-language phrase,
  // so a question like "why was the local cache chosen" can find a decision about
  // "local cache". Deterministic and bounded; no LLM involved.
  const stop = new Set(["the", "and", "for", "was", "were", "why", "how", "what", "with", "from", "that", "this", "which", "did", "does", "about", "into", "used", "uses"]);
  const tokens = [...new Set(q.toLowerCase().split(/[^a-z0-9_+.-]+/).filter((t) => t.length >= 3 && !stop.has(t)))].slice(0, 8);
  const patterns = tokens.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
  const params = [project_id, patterns, status ?? null, n];
  const r = await core.dbQuery(
    `SELECT ${FIELDS} FROM technical_decision
      WHERE project_id=$1
        AND (cardinality($2::text[]) = 0 OR title ILIKE ANY($2::text[])
             OR description ILIKE ANY($2::text[]) OR reasoning ILIKE ANY($2::text[]))
        AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    params,
  );
  return { ok: true, decisions: r.rows };
}

/**
 * Mark a decision superseded. Never deletes. Requires evidence, verifies that a
 * replacement id (when given) lives in the same project, and writes an audit entry.
 */
export async function supersedeDecision({ id, by_id, reason = "", evidence = [], actor = "operator" } = {}) {
  if (!nonEmptyString(id)) return { ok: false, reason: "id is required", superseded: null };
  if (!Array.isArray(evidence)) return { ok: false, reason: "evidence must be an array", superseded: null };
  if (evidence.length === 0) return { ok: false, reason: "superseding requires non-empty evidence", superseded: null };

  return core.withDb(async (c) => {
    const cur = await c.query(`SELECT ${FIELDS} FROM technical_decision WHERE id=$1 LIMIT 1`, [String(id).slice(0, 512)]);
    if (!cur.rowCount) return { ok: false, reason: "decision not found", superseded: null };
    const row = cur.rows[0];
    if (row.status === "superseded") return { ok: false, reason: "decision is already superseded", superseded: null };

    let replacement = null;
    if (by_id !== null && by_id !== undefined && by_id !== "") {
      const rep = await c.query("SELECT id, project_id FROM technical_decision WHERE id=$1 LIMIT 1", [String(by_id).slice(0, 512)]);
      if (!rep.rowCount) return { ok: false, reason: "by_id decision not found", superseded: null };
      if (rep.rows[0].project_id !== row.project_id) {
        return { ok: false, reason: "by_id belongs to a different project", superseded: null };
      }
      replacement = rep.rows[0].id;
    }

    const upd = await c.query(
      `UPDATE technical_decision SET status='superseded', superseded_by=$2, updated_at=now()
       WHERE id=$1 AND project_id=$3 RETURNING ${FIELDS}`,
      [row.id, replacement, row.project_id],
    );
    const auditActor = String(actor ?? "operator").slice(0, 120);
    const superseded = {
      id: row.id,
      project_id: row.project_id,
      by_id: replacement,
      status: "superseded",
      reason: String(reason ?? "").slice(0, 500),
      evidence_count: evidence.length,
      actor: auditActor,
    };
    await core.audit("decision.supersede", row.project_id, {
      id: row.id, by_id: replacement, actor: auditActor, evidence_count: evidence.length,
    });
    return { ok: true, superseded, decision: upd.rows[0] || null };
  });
}

/** Project-isolated lookup by id. */
export async function getDecisionById({ id, project_id } = {}) {
  if (!nonEmptyString(id) || !nonEmptyString(project_id)) {
    return { ok: false, decision: null, reason: "id and project_id are required" };
  }
  const r = await core.dbQuery(
    `SELECT ${FIELDS} FROM technical_decision WHERE id=$1 AND project_id=$2 LIMIT 1`,
    [String(id).slice(0, 512), project_id],
  );
  return { ok: true, decision: r.rows[0] || null };
}

/** Retrieval helper: active decisions relevant to a task, bounded to <= 10. */
export async function decisionsForTask({ project_id, query = "", limit = 10 } = {}) {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 10;
  const r = await getDecisions({ project_id, query, status: "active", limit: n });
  return { ok: r.ok, decisions: r.decisions, reason: r.reason };
}
