// Phase 23 Feature A — bounded, explainable project/component health assessments.
//
// Design rules (kept deliberately strict):
//   * Deterministic and local. No LLM, no network, no repository introspection.
//   * Every dimension defaults to "unknown". "healthy" is NEVER the default and
//     requires explicit, caller-supplied positive evidence markers.
//   * No invented metrics: a label is derived only from an observed count of
//     explicit positive/negative markers supplied by the caller.
//   * All free text is passed through core.redact() before it is returned or stored.
//   * Reads/writes are bounded and strictly project-scoped. History is append-only:
//     an existing assessment is never overwritten.
import crypto from "node:crypto";
import * as core from "./core.js";

// Frozen, versioned documentation of exactly how a label is produced.
// The band thresholds are deterministic labelling cutoffs of an observed marker
// ratio (positive / (positive + negative)); they are NOT probabilities or scores
// inferred from repository content.
export const SCORING_RULES = Object.freeze({
  version: "1.0.0",
  unknown: "unknown",
  dimensions: Object.freeze([
    "maintainability",
    "reliability",
    "testability",
    "dependency_stability",
    "architectural_consistency",
    "change_risk",
    "technical_debt",
  ]),
  // Recognised, case-insensitive marker signals. Anything else is ignored
  // (it cannot manufacture a score).
  positive_signals: Object.freeze([
    "positive", "good", "healthy", "pass", "passed", "improved", "resolved", "clean", "stable",
  ]),
  negative_signals: Object.freeze([
    "negative", "bad", "poor", "fail", "failed", "regressed", "degraded", "debt", "risky", "at_risk",
  ]),
  // Ordered high -> low. `min` is the inclusive lower bound of the observed ratio.
  bands: Object.freeze([
    Object.freeze({ label: "healthy", min: 0.8 }),
    Object.freeze({ label: "stable", min: 0.6 }),
    Object.freeze({ label: "needs_attention", min: 0.4 }),
    Object.freeze({ label: "at_risk", min: 0 }),
  ]),
  // Ordering used only by compareAssessments() to express a descriptive delta.
  rank: Object.freeze({
    unknown: 0,
    at_risk: 1,
    needs_attention: 2,
    stable: 3,
    healthy: 4,
  }),
  bounds: Object.freeze({
    max_components: 200,
    max_evidence_per_assessment: 50,
    max_history_rows: 200,
    max_explanation_chars: 2000,
  }),
  rules: Object.freeze([
    "Every dimension is 'unknown' unless explicit positive/negative markers are supplied for it.",
    "Only caller-supplied markers are counted; no metric is inferred from repository content.",
    "label = first band whose min <= (positive / (positive + negative)); unrecognised markers are ignored.",
    "A component with zero recognised markers for a dimension stays 'unknown' for that dimension.",
    "'healthy' is never a default; it requires explicit positive evidence and no negative markers at ratio >= 0.8.",
    "Evidence is redacted via core.redact; assessments are append-only and project-scoped.",
    "A comparison is descriptive: a label change alone is never reported as success or proof of improvement.",
  ]),
});

const DIMENSIONS = SCORING_RULES.dimensions;
const DIM_SET = new Set(DIMENSIONS);
const POSITIVE = new Set(SCORING_RULES.positive_signals);
const NEGATIVE = new Set(SCORING_RULES.negative_signals);
const VALID_LABELS = new Set([SCORING_RULES.unknown, ...Object.keys(SCORING_RULES.rank)]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 500;

const short = (v, n = MAX_TEXT) => core.redact(String(v ?? "").replace(/\s+/g, " ").slice(0, n));
const validProject = (p) => typeof p === "string" && p.trim().length > 0;

// ---- evidence parsing ------------------------------------------------------

// Two supported shapes per component:
//   { [dimension]: [marker, ...] }              (keyed object)
//   [ { dimension, signal, ... }, ... ]          (flat list)
function markersFor(evidence, component, dimension) {
  const comp = evidence && typeof evidence === "object" ? evidence[component] : null;
  if (comp == null) return [];
  let raw;
  if (Array.isArray(comp)) {
    raw = comp.filter((e) => e && typeof e === "object" && e.dimension === dimension);
  } else if (typeof comp === "object") {
    raw = comp[dimension];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e !== null && e !== undefined).slice(0, SCORING_RULES.bounds.max_evidence_per_assessment);
}

function signalOf(marker) {
  if (typeof marker === "string") return marker.trim().toLowerCase();
  if (marker && typeof marker === "object") {
    const s = marker.signal ?? marker.verdict ?? marker.status ?? marker.value ?? marker.label;
    if (s != null) return String(s).trim().toLowerCase();
  }
  return "";
}

function redactMarker(marker) {
  if (typeof marker === "string") return short(marker);
  if (marker && typeof marker === "object") {
    const out = {};
    for (const [k, v] of Object.entries(marker)) out[k] = typeof v === "string" ? short(v) : v;
    return out;
  }
  return short(String(marker ?? ""));
}

function bandFor(ratio) {
  for (const band of SCORING_RULES.bands) if (ratio >= band.min) return band.label;
  return SCORING_RULES.unknown;
}

// ---- analyzeProjectHealth (pure, deterministic) ----------------------------

/**
 * Analyse supplied evidence into bounded, explainable health assessments.
 * Reads no database and invents no data: a dimension with no recognised evidence
 * is always "unknown".
 */
export function analyzeProjectHealth({ project_id, components = [], evidence = {}, limit = 100 } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, reason: "valid project_id required", project_id: project_id ?? null, assessments: [], degraded: [] };
  }
  const rawLimit = Number(limit);
  const cap = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, SCORING_RULES.bounds.max_components)
    : 100;
  const list = Array.isArray(components) ? components : [];
  const selected = [];
  const seen = new Set();
  for (const c of list) {
    if (typeof c !== "string" || !c.trim() || seen.has(c)) continue;
    seen.add(c);
    selected.push(c);
    if (selected.length >= cap) break;
  }

  const assessments = selected.map((component) => {
    const dimensions = {};
    const unknown_areas = [];
    const collected = [];
    const parts = [];

    for (const dimension of DIMENSIONS) {
      const markers = markersFor(evidence, component, dimension);
      let pos = 0, neg = 0;
      for (const m of markers) {
        const sig = signalOf(m);
        if (POSITIVE.has(sig)) pos++;
        else if (NEGATIVE.has(sig)) neg++;
        if (collected.length < SCORING_RULES.bounds.max_evidence_per_assessment) collected.push(redactMarker(m));
      }
      const recognised = pos + neg;
      if (recognised === 0) {
        dimensions[dimension] = SCORING_RULES.unknown;
        unknown_areas.push(dimension);
        parts.push(`${dimension}=unknown(no recognised markers)`);
      } else {
        const ratio = pos / recognised;
        const label = bandFor(ratio);
        dimensions[dimension] = label;
        parts.push(`${dimension}=${label}(${pos}+/${neg}- ratio=${ratio.toFixed(2)})`);
      }
    }

    const explanation = `${component}: ` + parts.join("; ");
    return {
      component,
      dimensions,
      evidence: collected,
      unknown_areas,
      explanation: explanation.slice(0, SCORING_RULES.bounds.max_explanation_chars),
    };
  });

  return {
    ok: true,
    project_id,
    assessments,
    degraded: [],
    note: `Deterministic scoring v${SCORING_RULES.version}; 'unknown' is the default and no metric is inferred.`,
  };
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    component: row.component,
    dimensions: row.dimensions && typeof row.dimensions === "object" ? row.dimensions : {},
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    unknown_areas: Array.isArray(row.unknown_areas) ? row.unknown_areas : [],
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---- recordAssessment (append-only upsert-by-id) ---------------------------

/**
 * Persist a new assessment. History is append-only: if `id` is supplied and a
 * row with that id already exists, it is returned as a duplicate and never
 * overwritten. Returns { ok, id, duplicate? }.
 */
export async function recordAssessment({
  project_id, component = "_project", dimensions, evidence = [], unknown_areas = [], id,
} = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const comp = typeof component === "string" && component.trim() ? component : "_project";
  if (id !== undefined && id !== null) {
    if (!UUID_RE.test(String(id))) return { ok: false, reason: "invalid assessment id" };
  }
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) {
    return { ok: false, reason: "dimensions object required" };
  }

  const safeDimensions = {};
  for (const key of DIMENSIONS) {
    if (Object.prototype.hasOwnProperty.call(dimensions, key)) {
      const raw = dimensions[key];
      const label = VALID_LABELS.has(String(raw)) ? String(raw) : SCORING_RULES.unknown;
      safeDimensions[key] = short(label, 40);
    }
  }
  const safeEvidence = (Array.isArray(evidence) ? evidence : [])
    .slice(0, SCORING_RULES.bounds.max_evidence_per_assessment)
    .map((e) => redactMarker(e));
  const safeUnknown = (Array.isArray(unknown_areas) ? unknown_areas : [])
    .filter((x) => DIM_SET.has(x))
    .slice(0, DIMENSIONS.length);

  return core.withDb(async (client) => {
    if (id) {
      const existing = await client.query(
        "SELECT id, project_id, component FROM project_assessment WHERE id=$1", [String(id)],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.project_id !== project_id || row.component !== comp) {
          return { ok: false, reason: "assessment id belongs to a different project/component" };
        }
        return { ok: true, id: row.id, duplicate: true };
      }
    }

    const newId = id ? String(id) : crypto.randomUUID();
    await client.query(
      `INSERT INTO project_assessment
         (id, project_id, component, dimensions, evidence, unknown_areas, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,'active',now(),now())`,
      [newId, project_id, comp, JSON.stringify(safeDimensions), JSON.stringify(safeEvidence),
        JSON.stringify(safeUnknown)],
    );
    try {
      await core.audit("project_health.assessment_recorded", project_id, {
        id: newId, component: comp, dimension_count: Object.keys(safeDimensions).length,
        evidence_count: safeEvidence.length,
      });
    } catch { /* best effort */ }
    return { ok: true, id: newId };
  });
}

// ---- bounded, project-scoped reads -----------------------------------------

async function readAssessments({ project_id, component, limit, defaultLimit }) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", assessments: [], count: 0 };
  const raw = Number(limit);
  const n = Number.isInteger(raw) && raw > 0 ? Math.min(raw, SCORING_RULES.bounds.max_history_rows) : defaultLimit;
  const params = [project_id, n];
  let where = "project_id=$1";
  if (typeof component === "string" && component.trim()) {
    where += " AND component=$2";
    params.splice(1, 0, component);
  }
  const r = await core.dbQuery(
    `SELECT id, project_id, component, dimensions, evidence, unknown_areas, status, created_at, updated_at
       FROM project_assessment WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const assessments = r.rows.map(normalizeRow);
  return {
    ok: true,
    project_id,
    component: component ?? null,
    assessments,
    assessment: assessments[0] || null,
    count: assessments.length,
    limit: n,
  };
}

export function getAssessment(args = {}) {
  return readAssessments({ ...args, defaultLimit: 10 });
}

export function getHealthHistory(args = {}) {
  return readAssessments({ ...args, defaultLimit: 50 });
}

// ---- compareAssessments (descriptive only) ---------------------------------

/**
 * Compare two stored assessments. A label change is reported descriptively and
 * is NEVER presented as success or proof of improvement.
 */
export async function compareAssessments({ project_id, component, from_id, to_id } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", changes: [], evidence: {} };
  if (!UUID_RE.test(String(from_id ?? "")) || !UUID_RE.test(String(to_id ?? ""))) {
    return { ok: false, reason: "valid from_id and to_id uuids required", changes: [], evidence: {} };
  }
  const comp = typeof component === "string" && component.trim() ? component : "_project";
  const r = await core.dbQuery(
    `SELECT id, project_id, component, dimensions, evidence, unknown_areas, status, created_at, updated_at
       FROM project_assessment WHERE id = ANY($1) AND project_id=$2 AND component=$3`,
    [[String(from_id), String(to_id)], project_id, comp],
  );
  const byId = new Map(r.rows.map((row) => [row.id, normalizeRow(row)]));
  const from = byId.get(String(from_id));
  const to = byId.get(String(to_id));
  if (!from || !to) {
    return { ok: false, reason: "one or both assessments not found in project scope", changes: [], evidence: {} };
  }

  const changes = [];
  for (const dimension of DIMENSIONS) {
    const a = VALID_LABELS.has(String(from.dimensions[dimension])) ? String(from.dimensions[dimension]) : SCORING_RULES.unknown;
    const b = VALID_LABELS.has(String(to.dimensions[dimension])) ? String(to.dimensions[dimension]) : SCORING_RULES.unknown;
    const delta = SCORING_RULES.rank[b] - SCORING_RULES.rank[a];
    changes.push({ dimension, from: a, to: b, delta });
  }

  return {
    ok: true,
    project_id,
    component: comp,
    from_id: from.id,
    to_id: to.id,
    changes,
    evidence: {
      from: from.evidence.slice(0, SCORING_RULES.bounds.max_evidence_per_assessment),
      to: to.evidence.slice(0, SCORING_RULES.bounds.max_evidence_per_assessment),
    },
    note: "Descriptive comparison only: a change in label or status is not proof of improvement and must be backed by the cited evidence; no outcome is inferred from a status change.",
  };
}

export default {
  SCORING_RULES,
  analyzeProjectHealth,
  recordAssessment,
  getAssessment,
  getHealthHistory,
  compareAssessments,
};
