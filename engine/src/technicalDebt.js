// Phase 23 feature B — evidence-backed technical debt detection and finding lifecycle.
//
// Design rules (deliberately strict and deterministic, no LLM / no network):
//   * A finding is emitted ONLY when an EXPLICIT evidence marker exists. Code that
//     merely "looks unusual" is never classified as debt.
//   * Severity and confidence come from the frozen DEBT_RULES table. Confidence is
//     explainable, bounded (< 1.0) and only nudged by explicit occurrence counts.
//   * All content is redacted (core.redact) and length-bounded before it is returned
//     or persisted. Reads and writes are project-scoped and bounded.
//   * Finding history is append-only: repeated detection merges evidence and bumps
//     last_observed, but NEVER deletes a row or overwrites its status/resolution.
//     A false_positive is a kept row with a status, never a deletion.
import crypto from "node:crypto";
import * as core from "./core.js";

// ---------------------------------------------------------------------------
// Frozen rule vocabulary
// ---------------------------------------------------------------------------

const freeze = (o) => Object.freeze(o);

export const DEBT_RULES = freeze({
  repeated_workaround: freeze({
    severity: "medium", confidence: 0.60,
    markers: freeze(["workaround", "repeated_workaround", "temporary_fix", "repeated_fix"]),
    impact: "Repeated manual workarounds hide the real defect and cost time on every occurrence.",
    remediation: "Replace the workaround with a tracked fix and remove the repeated manual step.",
    note: "Emitted only from an explicit workaround marker; repetition count is taken from evidence, not inferred from code shape.",
  }),
  fragile_dependency: freeze({
    severity: "high", confidence: 0.55,
    markers: freeze(["fragile_dependency", "brittle_dependency", "dependency_risk", "single_point_dependency"]),
    impact: "A fragile dependency can cascade failures into every component that relies on it.",
    remediation: "Add isolation, a fallback or an explicit version pin for the dependency.",
    note: "Emitted only from an explicit fragile-dependency marker; no static import guessing.",
  }),
  missing_error_handling: freeze({
    severity: "medium", confidence: 0.50,
    markers: freeze(["missing_error_handling", "unhandled_error", "no_error_handling", "unhandled_rejection"]),
    impact: "Unhandled errors can surface as opaque failures instead of actionable diagnostics.",
    remediation: "Add explicit error handling and a bounded, redacted error message at the boundary.",
    note: "Emitted only from an explicit marker; absence of a try/catch in source is not evidence.",
  }),
  unstable_component: freeze({
    severity: "high", confidence: 0.50,
    markers: freeze(["unstable_component", "flaky_component", "unstable", "flaky_test"]),
    impact: "An unstable component produces inconsistent results and erodes trust in verification.",
    remediation: "Identify the non-determinism, stabilize it, and keep a bounded observation window.",
    note: "Emitted only from an explicit instability marker; 'weird-looking' code is not instability.",
  }),
  duplicated_logic: freeze({
    severity: "low", confidence: 0.55,
    markers: freeze(["duplicated_logic", "duplicate_logic", "copy_paste", "duplication"]),
    impact: "Duplicated logic drifts over time and forces the same fix in multiple places.",
    remediation: "Extract the shared behaviour into one place and keep the callers thin.",
    note: "Emitted only from an explicit duplication marker; similarity alone is not a finding.",
  }),
  outdated_pattern: freeze({
    severity: "low", confidence: 0.50,
    markers: freeze(["outdated_pattern", "deprecated_pattern", "obsolete_pattern", "legacy_pattern"]),
    impact: "An outdated pattern may be unsupported and slows down future maintenance.",
    remediation: "Confirm the replacement against project decisions before migrating.",
    note: "Emitted only from an explicit deprecation marker; age alone is not evidence.",
  }),
});

export const FINDING_STATUSES = freeze([
  "new", "existing", "resolved", "reopened", "accepted", "false_positive",
]);

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => nonEmptyString(v) && UUID_RE.test(String(v).trim());

// alias marker -> canonical category (built from the frozen rules; no hand-maintained copy)
const CATEGORY_ALIASES = Object.freeze((() => {
  const map = {};
  for (const [category, rule] of Object.entries(DEBT_RULES)) {
    map[markerKey(category)] = category;
    for (const m of rule.markers) map[markerKey(m)] = category;
  }
  return map;
})());

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function markerKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}
function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function finite(n, fallback) { const x = Number(n); return Number.isFinite(x) ? x : fallback; }
function round4(n) { return Math.round(finite(n, 0) * 10000) / 10000; }
function clampLimit(limit, fallback, max) {
  const n = Number.isInteger(limit) ? limit : fallback;
  return Math.max(0, Math.min(n, max));
}
function clip(text, max) { return core.redact(String(text ?? "")).slice(0, max); }
function stableKey(x) {
  if (x && typeof x === "object") {
    try { return JSON.stringify(x, Object.keys(x).sort()); } catch { return String(x); }
  }
  return String(x ?? "");
}
function keyOf(x) {
  if (x && typeof x === "object" && x.id != null) return `id:${x.id}`;
  return `val:${stableKey(x)}`;
}
function mergeEvidence(prev, incoming, cap = 200) {
  const seen = new Set();
  const out = [];
  for (const e of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (e === null || e === undefined) continue;
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}
function boundEvidenceArray(value, cap = 50) {
  const arr = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return arr.slice(0, cap).map((e) => {
    if (typeof e === "string") return clip(e, 400);
    if (e && typeof e === "object") {
      const out = {};
      for (const [k, v] of Object.entries(e).slice(0, 20)) {
        out[String(k).slice(0, 60)] = typeof v === "string" ? clip(v, 400) : v;
      }
      return out;
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Explicit marker extraction (the only way a finding can be created)
// ---------------------------------------------------------------------------

function entryList(evidence) {
  if (Array.isArray(evidence)) return evidence.map((entry) => ({ component: null, entry }));
  if (!evidence || typeof evidence !== "object") return [];
  const out = [];
  const declared = nonEmptyString(evidence.component) ? evidence.component : null;
  if (Array.isArray(evidence.markers)) {
    for (const e of evidence.markers) out.push({ component: declared, entry: e });
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "component" || key === "markers") continue;
    if (Array.isArray(value)) {
      for (const e of value) out.push({ component: key, entry: e });
    } else if (value && typeof value === "object") {
      for (const [mk, mv] of Object.entries(value)) {
        out.push({ component: key, entry: { [mk]: mv, detail: typeof mv === "string" ? mv : undefined, component: key } });
      }
    } else {
      // A key that is itself a known marker is a marker, not a component name.
      const isMarkerKey = Boolean(CATEGORY_ALIASES[markerKey(key)]);
      out.push({ component: isMarkerKey ? null : key, entry: { marker: key, detail: value } });
    }
  }
  return out;
}

function parseMarker(item, fallbackComponent) {
  const e = item.entry;
  let marker = "";
  let detail = "";
  let component = item.component;
  let occurrences = 1;
  let extra = {};

  if (typeof e === "string") {
    const m = e.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]\s*(.*)$/i);
    if (!m) return null;
    marker = m[1];
    detail = m[2];
  } else if (e && typeof e === "object") {
    for (const k of ["marker", "type", "kind", "signal", "category"]) {
      if (nonEmptyString(e[k])) { marker = e[k]; break; }
    }
    if (!marker) {
      for (const k of Object.keys(e)) {
        if (CATEGORY_ALIASES[markerKey(k)]) { marker = k; detail = e[k]; break; }
      }
    }
    if (nonEmptyString(e.component)) component = e.component;
    if (nonEmptyString(e.detail)) detail = e.detail;
    else if (nonEmptyString(e.description)) detail = e.description;
    else if (nonEmptyString(e.note)) detail = e.note;
    if (e.occurrences !== undefined && e.occurrences !== null) occurrences = finite(e.occurrences, 1);
    extra = e;
  } else {
    return null;
  }

  const category = CATEGORY_ALIASES[markerKey(marker)];
  if (!category) return null;
  return {
    category,
    marker: String(marker),
    component: component || fallbackComponent || "_project",
    detail: String(detail ?? ""),
    occurrences,
    extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Detection (pure: no database writes)
// ---------------------------------------------------------------------------

/**
 * Detect debt from explicit evidence markers. Returns deterministic findings.
 * `degraded` is true when some input could not be fully analyzed (unparseable
 * entries, component-filtered entries, or limit truncation).
 */
export function detectDebt({ project_id, components = [], evidence = {}, limit = 100 } = {}) {
  if (!nonEmptyString(project_id)) {
    return { ok: false, findings: [], degraded: false, reason: "a valid project_id is required" };
  }
  const n = clampLimit(limit, 100, 200);
  const scope = Array.isArray(components) ? components.filter(nonEmptyString).map((c) => c.trim()) : [];
  const fallbackComponent = scope.length === 1 ? scope[0] : "_project";

  const candidates = [];
  let skipped = 0;
  for (const item of entryList(evidence)) {
    const sig = parseMarker(item, fallbackComponent);
    if (!sig) {
      if (item.entry !== null && item.entry !== undefined) skipped++;
      continue;
    }
    if (scope.length && !scope.includes(sig.component)) { skipped++; continue; }
    candidates.push(sig);
  }

  const findings = [];
  const seen = new Set();
  for (const sig of candidates) {
    const rule = DEBT_RULES[sig.category];
    const occ = Math.max(1, Math.min(50, Math.floor(finite(sig.occurrences, 1))));
    const description = clip(sig.detail || `Explicit ${sig.category} marker`, 400) || `Explicit ${sig.category} marker`;
    const key = `${sig.component}\u0000${sig.category}\u0000${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      project_id,
      component: sig.component,
      category: sig.category,
      description,
      detection_method: "deterministic",
      evidence: [{
        marker: sig.marker,
        detail: clip(sig.detail, 400),
        occurrences: occ,
        observed_at: new Date().toISOString(),
      }],
      confidence: round4(Math.min(0.85, rule.confidence + 0.05 * (occ - 1))),
      severity: rule.severity,
      impact: clip(sig.extra.impact ?? rule.impact, 400),
      remediation: clip(sig.extra.remediation ?? rule.remediation, 600),
      note: rule.note,
    });
  }

  const truncated = findings.length > n;
  const kept = findings.slice(0, n);
  return {
    ok: true,
    findings: kept,
    degraded: skipped > 0 || truncated,
    skipped,
    examined: candidates.length,
    limit: n,
    note: "Evidence-gated deterministic detection; unusual-looking code alone is never debt. No LLM or network involved.",
  };
}

// ---------------------------------------------------------------------------
// 2. Finding persistence (append-only upsert on the unique key)
// ---------------------------------------------------------------------------

export async function recordFinding({
  project_id, component = "_project", category, description = "",
  detection_method = "deterministic", evidence = [], confidence = null,
  severity = null, impact = "", remediation = "", id,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, id: id ?? null, reason: "a valid project_id is required" };
  if (id !== undefined && id !== null && !isUuid(id)) return { ok: false, id: id ?? null, reason: "id must be a uuid" };
  if (!nonEmptyString(category) || !DEBT_RULES[category]) {
    return { ok: false, id: id ?? null, reason: "a known category is required" };
  }
  if (!nonEmptyString(description)) return { ok: false, id: id ?? null, reason: "a description is required" };
  const comp = nonEmptyString(component) ? component.trim() : "_project";
  const desc = clip(description, 400);
  const rule = DEBT_RULES[category];
  const conf = confidence === null || confidence === undefined
    ? rule.confidence
    : Math.max(0, Math.min(0.85, finite(confidence, rule.confidence)));
  const sev = VALID_SEVERITIES.has(String(severity || "").toLowerCase())
    ? String(severity).toLowerCase() : rule.severity;
  const incomingEvidence = boundEvidenceArray(evidence);

  return core.withDb(async (client) => {
    const dup = await client.query(
      `SELECT id, confidence, severity, evidence, status, resolution, last_observed
         FROM project_finding
        WHERE project_id=$1 AND component=$2 AND category=$3 AND description=$4`,
      [project_id, comp, category, desc],
    );
    const existing = dup.rows[0] || null;

    if (existing) {
      const merged = mergeEvidence(existing.evidence, incomingEvidence);
      const nextConf = round4(Math.max(finite(existing.confidence, 0), conf));
      // Deliberately do NOT touch status, resolution, severity, first_detected.
      await client.query(
        `UPDATE project_finding SET evidence=$2::jsonb, confidence=$3, last_observed=now()
          WHERE id=$1 AND project_id=$4`,
        [existing.id, JSON.stringify(merged), nextConf, project_id],
      );
      return { ok: true, id: existing.id, duplicate: true, changed: true };
    }

    const newId = nonEmptyString(id) ? String(id) : crypto.randomUUID();
    if (nonEmptyString(id)) {
      const pk = await client.query("SELECT id FROM project_finding WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) return { ok: false, duplicate: true, id: newId, reason: "finding id already exists" };
    }
    await client.query(
      `INSERT INTO project_finding
         (id, project_id, component, category, description, detection_method, evidence,
          confidence, severity, impact, remediation, status, first_detected, last_observed, resolution)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'new',now(),now(),'{}'::jsonb)`,
      [newId, project_id, comp, category, desc, clip(detection_method || "deterministic", 80),
        JSON.stringify(incomingEvidence), conf, sev, clip(impact, 400), clip(remediation, 600)],
    );
    await core.audit("debt.finding_recorded", project_id, { id: newId, category, component: comp });
    return { ok: true, id: newId, duplicate: false, changed: true };
  });
}

// ---------------------------------------------------------------------------
// 3. Status lifecycle (non-destructive)
// ---------------------------------------------------------------------------

export async function updateFindingStatus({ id, project_id, status, resolution = {}, evidence = [] } = {}) {
  if (!isUuid(id) || !nonEmptyString(project_id)) {
    return { ok: false, changed: false, reason: "a valid id and project_id are required" };
  }
  if (!FINDING_STATUSES.includes(String(status))) {
    return { ok: false, changed: false, reason: `status must be one of ${FINDING_STATUSES.join(", ")}` };
  }
  const incomingEvidence = boundEvidenceArray(evidence);
  const res = resolution && typeof resolution === "object" && !Array.isArray(resolution) ? resolution : {};

  return core.withDb(async (client) => {
    const cur = await client.query(
      `SELECT id, status, evidence, resolution FROM project_finding WHERE id=$1 AND project_id=$2`,
      [String(id).slice(0, 512), project_id],
    );
    const row = cur.rows[0];
    if (!row) return { ok: false, changed: false, reason: "finding not found in project" };

    const merged = mergeEvidence(row.evidence, incomingEvidence);
    const oldResolution = row.resolution && typeof row.resolution === "object" ? row.resolution : {};
    const history = Array.isArray(oldResolution.history) ? oldResolution.history.slice(-50) : [];
    if (oldResolution.status) {
      history.push({
        status: oldResolution.status,
        at: oldResolution.at ?? null,
        reason: oldResolution.reason ?? null,
      });
    }
    const stampedResolution = {
      ...res,
      status: String(status),
      at: new Date().toISOString(),
      previous_status: row.status,
      evidence_count: merged.length,
      history: history.slice(-50),
    };
    // Bounded + redacted caller-provided resolution fields.
    for (const k of Object.keys(stampedResolution)) {
      if (typeof stampedResolution[k] === "string") stampedResolution[k] = clip(stampedResolution[k], 400);
    }

    const changed = row.status !== String(status) || merged.length !== (Array.isArray(row.evidence) ? row.evidence.length : 0);
    if (!changed) return { ok: true, changed: false, reason: "no status or evidence change" };

    // NOTE: a false_positive (or any status) keeps the row. There is no DELETE here.
    await client.query(
      `UPDATE project_finding SET status=$2, resolution=$3::jsonb, evidence=$4::jsonb, last_observed=now()
        WHERE id=$1 AND project_id=$5`,
      [row.id, String(status), JSON.stringify(stampedResolution), JSON.stringify(merged), project_id],
    );
    await core.audit("debt.finding_status", project_id, { id: row.id, status: String(status) });
    return { ok: true, changed: true, id: row.id, status: String(status) };
  });
}

// ---------------------------------------------------------------------------
// 4. Bounded project-scoped read
// ---------------------------------------------------------------------------

export async function getFindings({ project_id, category, status, severity, limit = 100 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, findings: [], reason: "a valid project_id is required" };
  const n = clampLimit(limit, 100, 200);
  const sev = VALID_SEVERITIES.has(String(severity || "").toLowerCase()) ? String(severity).toLowerCase() : null;
  const r = await core.dbQuery(
    `SELECT id, project_id, component, category, description, detection_method, evidence,
            confidence, severity, impact, remediation, status, first_detected, last_observed, resolution
       FROM project_finding
      WHERE project_id=$1
        AND ($2::text IS NULL OR category=$2)
        AND ($3::text IS NULL OR status=$3)
        AND ($4::text IS NULL OR severity=$4)
      ORDER BY last_observed DESC, id::text ASC
      LIMIT $5`,
    [project_id, category ?? null, status ?? null, sev, n],
  );
  return { ok: true, findings: r.rows, items: r.rows, count: r.rows.length, limit: n };
}

export default {
  DEBT_RULES, FINDING_STATUSES, detectDebt, recordFinding, updateFindingStatus, getFindings,
};
