// Phase 23 feature C — conservative, evidence-backed fragility prediction.
//
// Design rules (deliberately strict and deterministic, no LLM / no network):
//   * Predictions are NEVER certainties and NEVER claims of proven causation.
//   * Evidence class is explicit: observed_defect | detected_risk |
//     historical_pattern | potential_failure | insufficient_evidence.
//   * When history is too sparse, confidence is capped and an explicit
//     'insufficient_evidence' prediction is returned instead of a guess.
//   * All content is redacted and length-bounded; reads/writes are project-scoped
//     and bounded. Review history is append-only (no deletion, no rewrites).
import crypto from "node:crypto";
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const EVIDENCE_CLASSES = freeze([
  "observed_defect", "detected_risk", "historical_pattern", "potential_failure", "insufficient_evidence",
]);

// Confidence is always well below certainty. `max_confidence` is a hard ceiling.
export const RISK_RULES = freeze({
  repeated_failure: freeze({
    evidence_class: "historical_pattern", severity: "medium",
    base_confidence: 0.50, max_confidence: 0.72, min_supports: 2,
    note: "Repeated historical observations suggest a pattern; the recurrence is not proof of cause.",
  }),
  dependency_concentration: freeze({
    evidence_class: "detected_risk", severity: "high",
    base_confidence: 0.45, max_confidence: 0.70, min_supports: 2,
    note: "A concentration of explicit dependency-risk signals; an actual failure is not asserted.",
  }),
  missing_tests: freeze({
    evidence_class: "potential_failure", severity: "medium",
    base_confidence: 0.40, max_confidence: 0.62, min_supports: 1,
    note: "A potential failure mode flagged by an explicit test-gap marker; not an observed defect.",
  }),
  architectural_conflict: freeze({
    evidence_class: "detected_risk", severity: "medium",
    base_confidence: 0.42, max_confidence: 0.68, min_supports: 1,
    note: "An explicit architectural-conflict signal; impact is not proven without review.",
  }),
  regression_risk: freeze({
    evidence_class: "historical_pattern", severity: "high",
    base_confidence: 0.45, max_confidence: 0.70, min_supports: 1,
    note: "Prior regressed/reopened observations raise a regression risk; no certainty is claimed.",
  }),
  insufficient_evidence: freeze({
    evidence_class: "insufficient_evidence", severity: "low",
    base_confidence: 0.10, max_confidence: 0.10, min_supports: 0,
    note: "History is too sparse to support a reliable prediction; no conclusion is drawn.",
  }),
});

export const REVIEW_STATUSES = freeze(["pending", "confirmed", "dismissed", "needs_review", "accepted", "rejected"]);

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => nonEmptyString(v) && UUID_RE.test(String(v).trim());
const MIN_HISTORY = 2;
const GLOBAL_CONFIDENCE_CEILING = 0.75; // never certainty

const RISK_MARKERS = Object.freeze((() => {
  const map = {};
  const add = (cat, names) => { for (const n of names) map[markerKey(n)] = cat; };
  add("repeated_failure", ["repeated_failure", "recurring_failure", "failure_recurrence", "repeat_failure"]);
  add("dependency_concentration", ["dependency_concentration", "concentrated_dependency", "single_dependency", "dependency_risk"]);
  add("missing_tests", ["missing_tests", "no_tests", "untested", "test_gap", "missing_coverage"]);
  add("architectural_conflict", ["architectural_conflict", "architecture_conflict", "conflicting_architecture", "architecture_drift"]);
  add("regression_risk", ["regression_risk", "regression", "regressed", "reopened"]);
  return map;
})());

// Which debt findings can feed which risk categories.
const FINDING_TO_RISK = Object.freeze({
  repeated_workaround: "repeated_failure",
  unstable_component: "repeated_failure",
  fragile_dependency: "dependency_concentration",
  missing_error_handling: "missing_tests",
  outdated_pattern: "architectural_conflict",
  duplicated_logic: "architectural_conflict",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markerKey(v) { return String(v ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, ""); }
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
function mergeList(prev, incoming, cap = 100) {
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
function boundList(value, cap = 50) {
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

function markerFrom(value) {
  if (typeof value === "string") {
    const m = value.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
    return m ? m[1] : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["marker", "type", "kind", "signal", "category", "outcome", "status"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
    for (const k of Object.keys(value)) if (RISK_MARKERS[markerKey(k)]) return k;
  }
  return "";
}

function detailFrom(value) {
  if (typeof value === "string") {
    const i = value.search(/[:=]/);
    return i >= 0 ? value.slice(i + 1).trim() : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["detail", "description", "note", "reason", "excerpt"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
  }
  return "";
}

function componentFrom(value, fallback = "_project") {
  if (value && typeof value === "object" && nonEmptyString(value.component)) return value.component.trim();
  return fallback;
}

/** Reduce history entries to distinct fingerprints; count only determinate entries. */
function distinctHistory(history) {
  const seen = new Set();
  const out = [];
  for (const h of Array.isArray(history) ? history : []) {
    if (h === null || h === undefined) continue;
    const id = h && typeof h === "object" && h.id != null ? `id:${h.id}` : `val:${stableKey(h)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Conservative prediction
// ---------------------------------------------------------------------------

/**
 * Predict fragility from findings + history + explicit evidence markers.
 * No certainty or causation is ever claimed; insufficient data is reported as such.
 */
export function predictFragility({ project_id, findings = [], history = [], evidence = {}, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) {
    return { ok: false, predictions: [], note: "a valid project_id is required" };
  }
  const n = clampLimit(limit, 50, 200);
  const hist = distinctHistory(history);
  const sparseHistory = hist.length < MIN_HISTORY;
  const confidenceCeiling = sparseHistory ? 0.45 : GLOBAL_CONFIDENCE_CEILING;

  // Collect explicit risk signals from three sources.
  const signals = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || typeof f !== "object") continue;
    const cat = FINDING_TO_RISK[String(f.category || "")];
    if (!cat) continue;
    const status = String(f.status || "new").toLowerCase();
    // Statuses resolved/false_positive/accepted are closed and do not feed new risk.
    if (["resolved", "false_positive", "accepted"].includes(status)) continue;
    // repeated_failure needs recurrence evidence, not a single open finding.
    if (cat === "repeated_failure" && !["reopened", "existing"].includes(status)) continue;
    signals.push({
      category: cat,
      component: componentFrom(f),
      detail: String(f.description || f.category || ""),
      source: "detected_finding",
      finding_id: f.id || null,
    });
  }

  for (const h of hist) {
    const mk = markerKey(markerFrom(h));
    const cat = RISK_MARKERS[mk];
    if (!cat) continue;
    signals.push({
      category: cat,
      component: componentFrom(h),
      detail: detailFrom(h) || String(mk),
      source: "historical_observation",
    });
  }

  // Explicit evidence object: { markers: [...] } | [ ... ] | { component: [...markers] }
  let evEntries = [];
  if (Array.isArray(evidence)) {
    evEntries = evidence.map((e) => ({ component: null, entry: e }));
  } else if (evidence && typeof evidence === "object") {
    const declared = nonEmptyString(evidence.component) ? evidence.component : null;
    if (Array.isArray(evidence.markers)) {
      for (const e of evidence.markers) evEntries.push({ component: declared, entry: e });
    }
    for (const [key, value] of Object.entries(evidence)) {
      if (key === "component" || key === "markers") continue;
      if (Array.isArray(value)) for (const e of value) evEntries.push({ component: key, entry: e });
      else {
        const isMarkerKey = Boolean(RISK_MARKERS[markerKey(key)]);
        evEntries.push({ component: isMarkerKey ? null : key, entry: { marker: key, detail: value } });
      }
    }
  }
  for (const item of evEntries) {
    const mk = markerKey(markerFrom(item.entry));
    const cat = RISK_MARKERS[mk];
    if (!cat) continue;
    const entry = item.entry && typeof item.entry === "object" ? item.entry : {};
    signals.push({
      category: cat,
      component: componentFrom(item.entry, item.component || "_project"),
      detail: detailFrom(item.entry) || String(mk),
      source: "explicit_evidence",
      evidence_class: EVIDENCE_CLASSES.includes(entry.evidence_class) ? entry.evidence_class : undefined,
    });
  }

  const byCategory = new Map();
  for (const s of signals) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }

  const predictions = [];
  for (const category of Object.keys(RISK_RULES)) {
    if (category === "insufficient_evidence") continue;
    const rule = RISK_RULES[category];
    const catSignals = byCategory.get(category) || [];
    const distinctSupports = new Set(catSignals.map((s) => keyOf({
      component: s.component, detail: s.detail, source: s.source, finding_id: s.finding_id,
    }))).size;
    if (distinctSupports < rule.min_supports) continue;

    const evidenceClass = catSignals.find((s) => s.evidence_class)?.evidence_class || rule.evidence_class;
    const rawConfidence = rule.base_confidence + 0.08 * Math.max(0, distinctSupports - rule.min_supports);
    const capReasons = [];
    if (rawConfidence > rule.max_confidence) capReasons.push(`rule ceiling ${rule.max_confidence}`);
    if (sparseHistory && GLOBAL_CONFIDENCE_CEILING > confidenceCeiling) capReasons.push("sparse history");
    if (rawConfidence > GLOBAL_CONFIDENCE_CEILING) capReasons.push("global ceiling");
    const confidence = round4(Math.min(rule.max_confidence, confidenceCeiling, rawConfidence));

    const components = [...new Set(catSignals.map((s) => s.component))].slice(0, 10);
    predictions.push({
      project_id,
      component: components.length === 1 ? components[0] : "_project",
      components,
      risk_category: category,
      evidence_class: evidenceClass,
      signals: catSignals.slice(0, 25).map((s) => ({
        source: s.source, component: s.component, detail: clip(s.detail, 400),
        finding_id: s.finding_id || null,
      })),
      evidence: catSignals.slice(0, 25).map((s) => ({
        marker: category, source: s.source,
        excerpt: clip(s.detail, 400), observed_at: new Date().toISOString(),
      })),
      confidence,
      severity: rule.severity,
      impact: clip(`Potential impact if the ${category} risk materialises; not an observed outcome.`, 400),
      preventive_action: clip(preventiveActionFor(category), 600),
      status: "observed",
      review_status: "pending",
      certainty_claim: "none",
      causation_claim: "none",
      confidence_cap_reason: capReasons.length ? capReasons.join("; ") : null,
      note: rule.note,
    });
  }

  if (sparseHistory) {
    predictions.push({
      project_id,
      component: "_project",
      components: [],
      risk_category: "insufficient_evidence",
      evidence_class: "insufficient_evidence",
      signals: [{ source: "history", distinct_history_entries: hist.length, required: MIN_HISTORY }],
      evidence: [{ marker: "insufficient_evidence", excerpt: `only ${hist.length} distinct history entry(ies); at least ${MIN_HISTORY} required`, observed_at: new Date().toISOString() }],
      confidence: round4(Math.min(RISK_RULES.insufficient_evidence.max_confidence, confidenceCeiling, RISK_RULES.insufficient_evidence.base_confidence)),
      severity: RISK_RULES.insufficient_evidence.severity,
      impact: "No reliable risk conclusion can be drawn from the available history.",
      preventive_action: "Collect more explicit historical observations before relying on these predictions.",
      status: "observed",
      review_status: "pending",
      certainty_claim: "none",
      causation_claim: "none",
      confidence_cap_reason: `sparse history (${hist.length} < ${MIN_HISTORY})`,
      note: RISK_RULES.insufficient_evidence.note,
    });
  }

  const kept = predictions.slice(0, n);
  return {
    ok: true,
    predictions: kept,
    count: kept.length,
    limit: n,
    sparse_history: sparseHistory,
    insufficient_evidence: sparseHistory,
    note: "Conservative deterministic estimates, not certainties. No proven causation is asserted; " +
      "observed defects, detected risks, historical patterns and potential failures are labelled via evidence_class. " +
      "No LLM or network involved.",
  };
}

function preventiveActionFor(category) {
  switch (category) {
    case "repeated_failure": return "Track each recurrence with a distinct fingerprint, then verify a fix before closing the finding.";
    case "dependency_concentration": return "Introduce isolation or a fallback for the concentrated dependency and review the blast radius.";
    case "missing_tests": return "Add a focused test around the flagged gap and record the explicit test result as evidence.";
    case "architectural_conflict": return "Confirm the conflict against recorded technical decisions before changing the architecture.";
    case "regression_risk": return "Add a regression check for the previously regressed behaviour and review before release.";
    default: return "Collect more explicit evidence before acting.";
  }
}

// ---------------------------------------------------------------------------
// 2. Prediction persistence (bounded, project-scoped upsert)
// ---------------------------------------------------------------------------

export async function recordPrediction({
  project_id, component = "_project", risk_category, signals = [], evidence = [],
  confidence = null, severity = null, impact = "", preventive_action = "",
  status = "observed", review_status = "pending", id,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, id: id ?? null, reason: "a valid project_id is required" };
  if (id !== undefined && id !== null && !isUuid(id)) return { ok: false, id: id ?? null, reason: "id must be a uuid" };
  if (!RISK_RULES[String(risk_category)]) {
    return { ok: false, id: id ?? null, reason: "a known risk_category is required" };
  }
  const comp = nonEmptyString(component) ? component.trim() : "_project";
  const st = nonEmptyString(status) ? status : "observed";
  const rv = REVIEW_STATUSES.includes(String(review_status)) ? String(review_status) : "pending";
  const rule = RISK_RULES[risk_category];
  const conf = confidence === null || confidence === undefined
    ? rule.base_confidence
    : Math.max(0, Math.min(GLOBAL_CONFIDENCE_CEILING, finite(confidence, rule.base_confidence)));
  const sev = VALID_SEVERITIES.has(String(severity || "").toLowerCase()) ? String(severity).toLowerCase() : rule.severity;
  const inSignals = boundList(signals);
  const inEvidence = boundList(evidence);

  return core.withDb(async (client) => {
    const dup = await client.query(
      `SELECT id, confidence, signals, evidence, review_status, severity
         FROM project_prediction
        WHERE project_id=$1 AND component=$2 AND risk_category=$3 AND status=$4`,
      [project_id, comp, risk_category, st],
    );
    const existing = dup.rows[0] || null;
    if (existing) {
      const nextSignals = mergeList(existing.signals, inSignals);
      const nextEvidence = mergeList(existing.evidence, inEvidence);
      const nextConf = round4(Math.max(finite(existing.confidence, 0), conf));
      // Preserve review_status here; reviewPrediction is the only review writer.
      await client.query(
        `UPDATE project_prediction SET signals=$2::jsonb, evidence=$3::jsonb, confidence=$4, updated_at=now()
          WHERE id=$1 AND project_id=$5`,
        [existing.id, JSON.stringify(nextSignals), JSON.stringify(nextEvidence), nextConf, project_id],
      );
      return { ok: true, id: existing.id, duplicate: true, changed: true };
    }

    const newId = nonEmptyString(id) ? String(id) : crypto.randomUUID();
    if (nonEmptyString(id)) {
      const pk = await client.query("SELECT id FROM project_prediction WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) return { ok: false, duplicate: true, id: newId, reason: "prediction id already exists" };
    }
    await client.query(
      `INSERT INTO project_prediction
         (id, project_id, component, risk_category, signals, evidence, confidence, severity,
          impact, preventive_action, status, review_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,now(),now())`,
      [newId, project_id, comp, risk_category, JSON.stringify(inSignals), JSON.stringify(inEvidence),
        conf, sev, clip(impact, 400), clip(preventive_action, 600), st, rv],
    );
    await core.audit("risk.prediction_recorded", project_id, { id: newId, risk_category, component: comp });
    return { ok: true, id: newId, duplicate: false, changed: true };
  });
}

// ---------------------------------------------------------------------------
// 3. Bounded project-scoped reads
// ---------------------------------------------------------------------------

export async function getPredictions({ project_id, component, status, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, predictions: [], reason: "a valid project_id is required" };
  const n = clampLimit(limit, 50, 200);
  const r = await core.dbQuery(
    `SELECT id, project_id, component, risk_category, signals, evidence, confidence, severity,
            impact, preventive_action, status, review_status, created_at, updated_at
       FROM project_prediction
      WHERE project_id=$1
        AND ($2::text IS NULL OR component=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC, id::text ASC
      LIMIT $4`,
    [project_id, component ?? null, status ?? null, n],
  );
  return { ok: true, predictions: r.rows, items: r.rows, count: r.rows.length, limit: n };
}

// ---------------------------------------------------------------------------
// 4. Review (append-only, project-scoped)
// ---------------------------------------------------------------------------

export async function reviewPrediction({ id, project_id, review_status, evidence = [] } = {}) {
  if (!isUuid(id) || !nonEmptyString(project_id)) {
    return { ok: false, changed: false, reason: "a valid id and project_id are required" };
  }
  if (!REVIEW_STATUSES.includes(String(review_status))) {
    return { ok: false, changed: false, reason: `review_status must be one of ${REVIEW_STATUSES.join(", ")}` };
  }
  const inEvidence = boundList(evidence);

  return core.withDb(async (client) => {
    const cur = await client.query(
      `SELECT id, review_status, signals, evidence FROM project_prediction WHERE id=$1 AND project_id=$2`,
      [String(id).slice(0, 512), project_id],
    );
    const row = cur.rows[0];
    if (!row) return { ok: false, changed: false, reason: "prediction not found in project" };

    const reviewEvent = {
      marker: "review",
      from: row.review_status,
      to: String(review_status),
      evidence_count: inEvidence.length,
      at: new Date().toISOString(),
    };
    const stampedEvidence = inEvidence.map((e) => ({
      marker: "review_evidence",
      review_status: String(review_status),
      at: reviewEvent.at,
      excerpt: typeof e === "string" ? clip(e, 400) : e,
    }));
    const nextEvidence = mergeList(row.evidence, stampedEvidence);
    const nextSignals = mergeList(row.signals, [reviewEvent]);
    const changed = row.review_status !== String(review_status) || nextEvidence.length !== (Array.isArray(row.evidence) ? row.evidence.length : 0);
    if (!changed) return { ok: true, changed: false, reason: "no review change" };

    await client.query(
      `UPDATE project_prediction SET review_status=$2, evidence=$3::jsonb, signals=$4::jsonb, updated_at=now()
        WHERE id=$1 AND project_id=$5`,
      [row.id, String(review_status), JSON.stringify(nextEvidence), JSON.stringify(nextSignals), project_id],
    );
    await core.audit("risk.prediction_review", project_id, { id: row.id, review_status: String(review_status) });
    return { ok: true, changed: true, id: row.id, review_status: String(review_status) };
  });
}

export default {
  RISK_RULES, EVIDENCE_CLASSES, REVIEW_STATUSES, predictFragility,
  recordPrediction, getPredictions, reviewPrediction,
};
