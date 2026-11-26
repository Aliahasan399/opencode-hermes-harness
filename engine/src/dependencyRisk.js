// Phase 23 feature E — evidence-backed dependency risk analysis.
//
// Design rules (deliberately strict and deterministic, no LLM / no network):
//   * Risks come only from explicitly supplied edges and explicit evidence
//     markers. No package registry is queried and no vulnerability identifier is
//     invented. A dependency that merely "looks old" is not a risk.
//   * Cycles and concentration are derived deterministically from the caller's
//     edge list; an empty edge list yields no structural risks.
//   * Confidence is bounded (< 1) and documented by DEPENDENCY_RULES.
//   * All free text is redacted via core.redact and length-bounded.
//
// This module is pure: it reads no database and writes no files.
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const DEPENDENCY_RULES = freeze({
  version: "1.0.0",
  categories: freeze({
    circular_dependency: freeze({
      severity: "high", confidence: 0.55, detection: "explicit_edge_cycle",
      impact: "A cycle in the explicitly supplied edges can make initialization order fragile.",
      remediation: "Break the cycle explicitly and record the resulting edge change as evidence.",
      note: "Derived only from caller-supplied edges; no runtime import graph is introspected.",
    }),
    single_point_failure: freeze({
      severity: "high", confidence: 0.55, detection: "explicit_edge_concentration",
      impact: "Several explicit dependents converge on one component, widening the blast radius of a failure.",
      remediation: "Add isolation or a bounded fallback for the shared dependency.",
      note: "Concentration is counted from explicit edges; no failure is asserted as observed.",
    }),
    fragile_dependency: freeze({
      severity: "high", confidence: 0.50, detection: "explicit_marker",
      impact: "An explicitly flagged fragile dependency can cascade failures into its dependents.",
      remediation: "Pin, isolate or provide a fallback for the flagged dependency.",
      note: "Emitted only from an explicit fragility marker; no package fact is inferred.",
    }),
    version_drift: freeze({
      severity: "medium", confidence: 0.45, detection: "explicit_marker",
      impact: "Explicitly reported version drift can change behaviour between environments.",
      remediation: "Reconcile the reported versions and record the explicit result.",
      note: "Emitted only from an explicit drift marker; versions are never guessed.",
    }),
    unpinned_version: freeze({
      severity: "medium", confidence: 0.45, detection: "explicit_marker",
      impact: "An explicitly unpinned version can resolve differently across installs.",
      remediation: "Pin the dependency to a reviewed version and verify the resolution.",
      note: "Emitted only from an explicit pinning marker; no manifest is read.",
    }),
    outdated_dependency: freeze({
      severity: "low", confidence: 0.40, detection: "explicit_marker",
      impact: "An explicitly flagged outdated dependency may need a reviewed upgrade.",
      remediation: "Check the recorded project decision before changing the version.",
      note: "Emitted only from an explicit outdated marker; age alone is not evidence.",
    }),
    missing_fallback: freeze({
      severity: "medium", confidence: 0.45, detection: "explicit_marker",
      impact: "An explicitly missing fallback can turn a dependency failure into a hard outage.",
      remediation: "Add a bounded fallback and verify it with an explicit test result.",
      note: "Emitted only from an explicit fallback marker; no behaviour is assumed.",
    }),
  }),
  bounds: freeze({
    max_edges: 500,
    max_nodes: 200,
    max_risks: 100,
    max_evidence_per_risk: 20,
    min_concentration: 2,
  }),
  rules: freeze([
    "Every risk requires an explicit edge or evidence marker; no vulnerability identifier is produced.",
    "Cycles and concentration are computed only from the caller's explicit edge list.",
    "Confidence is deterministic and capped below certainty; no causation is asserted.",
    "All free text is redacted with core.redact and bounded before it is returned.",
  ]),
});

const MARKER_TO_RISK = Object.freeze((() => {
  const map = {};
  const add = (cat, names) => { for (const n of names) map[markerKey(n)] = cat; };
  for (const cat of Object.keys(DEPENDENCY_RULES.categories)) add(cat, [cat]);
  add("fragile_dependency", ["fragile_dependency", "brittle_dependency", "dependency_risk"]);
  add("version_drift", ["version_drift", "drift", "version_mismatch"]);
  add("unpinned_version", ["unpinned_version", "unpinned", "no_pin", "floating_version"]);
  add("outdated_dependency", ["outdated_dependency", "outdated", "deprecated_dependency"]);
  add("missing_fallback", ["missing_fallback", "no_fallback", "no_failure_fallback"]);
  add("circular_dependency", ["circular_dependency", "cycle", "dependency_cycle"]);
  add("single_point_failure", ["single_point_failure", "concentration", "dependency_concentration"]);
  return map;
})());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markerKey(v) { return String(v ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, ""); }
function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function finite(n, fallback) { const x = Number(n); return Number.isFinite(x) ? x : fallback; }
function round4(n) { return Math.round(finite(n, 0) * 10000) / 10000; }
function clip(text, max) { return core.redact(String(text ?? "")).replace(/\s+/g, " ").slice(0, max); }
function clampLimit(limit, fallback, max) {
  const n = Number.isInteger(limit) ? limit : fallback;
  return Math.max(0, Math.min(n, max));
}

function markerFrom(value) {
  if (typeof value === "string") {
    const m = value.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
    return m ? m[1] : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["marker", "type", "kind", "signal", "status", "category", "risk"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
    for (const k of Object.keys(value)) if (MARKER_TO_RISK[markerKey(k)]) return k;
  }
  return "";
}

function detailFrom(value) {
  if (typeof value === "string") {
    const i = value.search(/[:=]/);
    return i >= 0 ? value.slice(i + 1).trim() : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["detail", "description", "note", "reason", "excerpt", "name"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
  }
  return "";
}

function componentFrom(value, fallback = "_project") {
  if (value && typeof value === "object") {
    for (const k of ["component", "module", "to", "dependency", "name"]) {
      if (nonEmptyString(value[k])) return String(value[k]).trim();
    }
  }
  return fallback;
}

function parseEdge(raw) {
  if (nonEmptyString(raw)) {
    const m = raw.match(/^\s*([^\s-]+)\s*(?:->|=>|:)\s*([^\s]+)\s*$/);
    if (m) return { from: m[1].trim(), to: m[2].trim() };
    return null;
  }
  if (raw && typeof raw === "object") {
    const from = raw.from ?? raw.source ?? raw.parent;
    const to = raw.to ?? raw.target ?? raw.dependency;
    if (nonEmptyString(from) && nonEmptyString(to)) return { from: String(from).trim(), to: String(to).trim() };
  }
  return null;
}

/** Deterministic cycle detection over the caller's explicit edges only. */
function findCycles(adjacency) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "active") {
      const at = stack.indexOf(node);
      const cycle = stack.slice(at >= 0 ? at : 0).concat(node);
      const key = [...new Set(cycle)].sort().join("|");
      if (!cycles.some((c) => c.key === key)) cycles.push({ key, nodes: [...new Set(cycle)].sort() });
      return;
    }
    state.set(node, "active");
    stack.push(node);
    for (const next of adjacency.get(node) || []) visit(next);
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...adjacency.keys()].sort()) {
    if (state.get(node) !== "done") visit(node);
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// analyzeDependencies (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * Analyze explicitly supplied dependency edges and evidence markers.
 * No registry access, no vulnerability identifiers, no certainty claims.
 */
export function analyzeDependencies({ project_id, edges = [], evidence = {}, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) {
    return { ok: false, risks: [], reason: "a valid project_id is required", note: "no conclusion without a project" };
  }
  const n = clampLimit(limit, 50, DEPENDENCY_RULES.bounds.max_risks);
  const rawEdges = (Array.isArray(edges) ? edges : []).slice(0, DEPENDENCY_RULES.bounds.max_edges);
  const parsed = [];
  const seenEdge = new Set();
  for (const raw of rawEdges) {
    const e = parseEdge(raw);
    if (!e) continue;
    const k = `${e.from}\u0000${e.to}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    parsed.push(e);
  }

  const adjacency = new Map();
  const incoming = new Map();
  const nodes = new Set();
  for (const e of parsed) {
    nodes.add(e.from); nodes.add(e.to);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e.to);
    if (!incoming.has(e.to)) incoming.set(e.to, new Set());
    incoming.get(e.to).add(e.from);
    if (nodes.size > DEPENDENCY_RULES.bounds.max_nodes) break;
  }

  const signals = [];
  for (const cycle of findCycles(adjacency)) {
    signals.push({
      category: "circular_dependency",
      component: cycle.nodes[0],
      detail: `explicit edge cycle: ${cycle.nodes.join(" -> ")}`,
      source: "explicit_edge",
    });
  }
  for (const [to, parents] of incoming) {
    if (parents.size < DEPENDENCY_RULES.bounds.min_concentration) continue;
    signals.push({
      category: "single_point_failure",
      component: to,
      detail: `${parents.size} explicit dependents converge on ${to}`,
      source: "explicit_edge",
    });
  }

  const entries = [];
  if (Array.isArray(evidence)) {
    for (const e of evidence) entries.push({ component: null, entry: e });
  } else if (evidence && typeof evidence === "object") {
    const declared = nonEmptyString(evidence.component) ? evidence.component : null;
    if (Array.isArray(evidence.markers)) {
      for (const e of evidence.markers) entries.push({ component: declared, entry: e });
    }
    for (const [key, value] of Object.entries(evidence)) {
      if (key === "component" || key === "markers" || key === "tests" || key === "history") continue;
      if (Array.isArray(value)) for (const e of value) entries.push({ component: key, entry: e });
      else {
        const isMarkerKey = Boolean(MARKER_TO_RISK[markerKey(key)]);
        entries.push({ component: isMarkerKey ? null : key, entry: { marker: key, detail: value } });
      }
    }
  }
  for (const item of entries) {
    const cat = MARKER_TO_RISK[markerKey(markerFrom(item.entry))];
    if (!cat) continue;
    signals.push({
      category: cat,
      component: componentFrom(item.entry, item.component || "_project"),
      detail: detailFrom(item.entry) || String(markerFrom(item.entry)),
      source: "explicit_evidence",
    });
  }

  const grouped = new Map();
  for (const s of signals) {
    const key = `${s.component}\u0000${s.category}\u0000${s.detail}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }

  const risks = [];
  for (const [key, group] of grouped) {
    if (risks.length >= n) break;
    const [component, category, description] = key.split("\u0000");
    const rule = DEPENDENCY_RULES.categories[category];
    const occurrences = new Set(group.map((s) => `${s.source}|${s.detail}`)).size;
    const confidence = round4(Math.min(0.70, rule.confidence + 0.05 * Math.max(0, occurrences - 1)));
    risks.push({
      id: null,
      project_id,
      component,
      category,
      risk_category: category,
      description: clip(description || `Explicit ${category} marker`, 400),
      detection_method: rule.detection,
      severity: rule.severity,
      confidence,
      impact: clip(rule.impact, 400),
      preventive_action: clip(rule.remediation, 600),
      remediation: clip(rule.remediation, 600),
      evidence: group.slice(0, DEPENDENCY_RULES.bounds.max_evidence_per_risk).map((s) => ({
        marker: category, source: s.source, excerpt: clip(s.detail, 400),
      })),
      signals: group.slice(0, 20).map((s) => ({ source: s.source, component: s.component, detail: clip(s.detail, 400) })),
      occurrences,
      certainty_claim: "none",
      causation_claim: "none",
      note: rule.note,
    });
  }

  const unknownAreas = [...nodes].filter((node) => !risks.some((r) => r.component === node)).slice(0, 50);
  return {
    ok: true,
    project_id,
    risks,
    count: risks.length,
    limit: n,
    edges_examined: parsed.length,
    nodes_examined: nodes.size,
    unknown_areas: unknownAreas,
    note: "Evidence-backed deterministic dependency analysis. No package registry is queried, no vulnerability " +
      "identifier is produced and no certainty or causation is asserted.",
  };
}

export default { DEPENDENCY_RULES, analyzeDependencies };
