// Phase 17 capability C: Relationship Intelligence.
//
// Evidence-only, project-scoped, bounded traversal over `knowledge_relationship`
// (migration 015). Unsupported "keyword-only" links are rejected: a relationship
// is stored only with at least one evidence item. No LLM calls, no deletes, no
// unbounded scans -- every lookup is pinned to project_id and an indexed subject.
import * as core from "./core.js";

const FIELDS = "id, project_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence, created_at";
const VALID_DIRECTIONS = new Set(["source", "target", "both"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clampConfidence(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function boundedLimit(value, fallback, cap) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, cap) : fallback;
}

function short(value) {
  return String(value).slice(0, 512);
}

/** Pure validator -- no database access. */
export function validateRelationship(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, reason: "input must be an object" };
  for (const key of ["project_id", "source_type", "source_id", "target_type", "target_id", "relation_type"]) {
    if (!nonEmptyString(input[key])) return { ok: false, reason: `${key} is required` };
  }
  if (!Array.isArray(input.evidence)) return { ok: false, reason: "evidence must be an array" };
  if (input.evidence.length === 0) {
    return { ok: false, reason: "evidence is required; unsupported relationships are not stored" };
  }
  if (input.source_id === input.target_id) {
    return { ok: false, reason: "source_id and target_id must differ" };
  }
  return { ok: true };
}

/**
 * Insert an evidence-backed relationship. Duplicate links are a no-op via the
 * table's UNIQUE constraint (ON CONFLICT DO NOTHING), never an overwrite.
 */
export async function createRelationship({
  project_id,
  source_type,
  source_id,
  target_type,
  target_id,
  relation_type,
  confidence = null,
  evidence = [],
} = {}) {
  const check = validateRelationship({
    project_id, source_type, source_id, target_type, target_id, relation_type, evidence,
  });
  if (!check.ok) return { ok: false, duplicate: false, id: null, reason: check.reason };

  const pid = short(project_id);
  const st = short(source_type);
  const sid = short(source_id);
  const tt = short(target_type);
  const tid = short(target_id);
  const rt = short(relation_type);
  const conf = clampConfidence(confidence);

  const ins = await core.dbQuery(
    `INSERT INTO knowledge_relationship
      (project_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (project_id, source_type, source_id, target_type, target_id, relation_type) DO NOTHING
     RETURNING id`,
    [pid, st, sid, tt, tid, rt, conf, JSON.stringify(evidence)],
  );
  if (ins.rowCount === 0) {
    const ex = await core.dbQuery(
      `SELECT id FROM knowledge_relationship
        WHERE project_id=$1 AND source_type=$2 AND source_id=$3
          AND target_type=$4 AND target_id=$5 AND relation_type=$6 LIMIT 1`,
      [pid, st, sid, tt, tid, rt],
    );
    return { ok: true, duplicate: true, id: ex.rows[0]?.id ?? null };
  }

  const id = ins.rows[0].id;
  await core.audit("relationship.create", pid, {
    id, project_id: pid, relation_type: rt, evidence_count: evidence.length,
  });
  return { ok: true, duplicate: false, id };
}

/**
 * Bounded, project-scoped traversal. `source` uses kr_source_idx, `target` uses
 * kr_target_idx, `both` is a bitmap OR of the two -- no full-table scan.
 */
export async function getRelationships({
  project_id,
  subject_type,
  subject_id,
  direction = "both",
  relation_type,
  limit = 50,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, relationships: [], reason: "project_id is required" };
  if (!nonEmptyString(subject_type) || !nonEmptyString(subject_id)) {
    return { ok: false, relationships: [], reason: "subject_type and subject_id are required" };
  }
  if (!VALID_DIRECTIONS.has(direction)) {
    return { ok: false, relationships: [], reason: "direction must be source|target|both" };
  }

  const n = boundedLimit(limit, 50, 100);
  const params = [short(project_id), short(subject_type), short(subject_id)];
  let predicate;
  if (direction === "source") predicate = "source_type=$2 AND source_id=$3";
  else if (direction === "target") predicate = "target_type=$2 AND target_id=$3";
  else predicate = "(source_type=$2 AND source_id=$3) OR (target_type=$2 AND target_id=$3)";

  let sql = `SELECT ${FIELDS} FROM knowledge_relationship
             WHERE project_id=$1 AND (${predicate})`;
  if (nonEmptyString(relation_type)) {
    params.push(short(relation_type));
    sql += ` AND relation_type=$${params.length}`;
  }
  params.push(n);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

  const r = await core.dbQuery(sql, params);
  return { ok: true, relationships: r.rows };
}

/**
 * Related records grouped by the "other" side of each relationship, carrying the
 * relation_type(s) and the strongest observed confidence. Bounded to <= 100 items.
 */
export async function relatedContext({ project_id, subject_type, subject_id, limit = 25 } = {}) {
  const n = boundedLimit(limit, 25, 100);
  const r = await getRelationships({
    project_id, subject_type, subject_id, direction: "both", limit: n,
  });
  if (!r.ok) return { ok: false, items: [], reason: r.reason };

  const st = short(subject_type);
  const sid = short(subject_id);
  const groups = new Map();
  for (const rel of r.relationships) {
    const fromSource = rel.source_type === st && rel.source_id === sid;
    const type = fromSource ? rel.target_type : rel.source_type;
    const id = fromSource ? rel.target_id : rel.source_id;
    const key = `${type}\u0000${id}`;
    let group = groups.get(key);
    if (!group) {
      group = { type, id, relation_types: [], confidence: null, relationships: [] };
      groups.set(key, group);
    }
    if (!group.relation_types.includes(rel.relation_type)) group.relation_types.push(rel.relation_type);
    if (rel.confidence !== null && rel.confidence !== undefined
        && (group.confidence === null || Number(rel.confidence) > Number(group.confidence))) {
      group.confidence = rel.confidence;
    }
    group.relationships.push({
      id: rel.id,
      relation_type: rel.relation_type,
      confidence: rel.confidence,
      direction: fromSource ? "out" : "in",
    });
  }

  const items = [...groups.values()].map((g) => ({
    type: g.type,
    id: g.id,
    relation_type: g.relation_types.length === 1 ? g.relation_types[0] : null,
    relation_types: g.relation_types,
    confidence: g.confidence,
    relationships: g.relationships,
  }));
  return { ok: true, items };
}
