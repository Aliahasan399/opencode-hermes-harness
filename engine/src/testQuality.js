// Phase 23 feature D — evidence-backed test-quality gap detection.
//
// Design rules (deliberately strict and deterministic, no LLM / no network):
//   * A gap is emitted ONLY from explicit markers in supplied tests, history or
//     evidence. Code that merely "looks untested" is never a gap.
//   * NO coverage percentage is computed or invented. With no evidence the
//     result is explicitly "unknown", never a fabricated number.
//   * Confidence is deterministic, bounded (< 1) and documented by GAP_RULES.
//   * All free text is redacted via core.redact and length-bounded.
//   * The sibling dependencyRisk.analyzeDependencies function owns dependency
//     edges; this module never speculates about packages or vulnerabilities.
//
// This module is pure: it reads no database and writes no files.
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const GAP_RULES = freeze({
  version: "1.0.0",
  categories: freeze({
    untested_module: freeze({
      severity: "medium", confidence: 0.50,
      markers: freeze(["missing_tests", "no_tests", "untested_module", "test_gap"]),
      impact: "An explicitly flagged untested module can regress without a signal; no coverage figure is inferred.",
      remediation: "Add focused tests for the flagged module and record the explicit test result as evidence.",
      note: "Emitted only from an explicit missing-test marker; absence of a test file is not evidence.",
    }),
    weak_assertion: freeze({
      severity: "medium", confidence: 0.45,
      markers: freeze(["weak_assertion", "no_assertion", "assertion_gap"]),
      impact: "A weak assertion can let a regression pass unnoticed.",
      remediation: "Strengthen the assertion so it distinguishes the expected result from a plausible wrong one.",
      note: "Emitted only from an explicit assertion marker; assertion quality is never guessed from source text.",
    }),
    flaky_test: freeze({
      severity: "high", confidence: 0.50,
      markers: freeze(["flaky_test", "flaky", "intermittent_test", "unstable_test"]),
      impact: "An explicitly flaky test weakens trust in the verification signal.",
      remediation: "Identify the non-determinism, stabilize the test, and keep a bounded observation window.",
      note: "Emitted only from an explicit flakiness marker, including a recorded flaky observation.",
    }),
    unverified_change: freeze({
      severity: "high", confidence: 0.45,
      markers: freeze(["unverified_change", "unverified", "missing_verification", "no_verification"]),
      impact: "A change without explicit verification evidence can carry an undetected regression.",
      remediation: "Run a focused verification and attach the determinate result as evidence.",
      note: "Emitted only from an explicit missing-verification marker; a bare claim never counts as verification.",
    }),
    stale_test: freeze({
      severity: "low", confidence: 0.40,
      markers: freeze(["stale_test", "stale", "outdated_test"]),
      impact: "An explicitly stale test may no longer reflect current behaviour.",
      remediation: "Review the test against the current contract before relying on its result.",
      note: "Emitted only from an explicit staleness marker; file age alone is not evidence.",
    }),
    missing_failure_path: freeze({
      severity: "medium", confidence: 0.45,
      markers: freeze(["missing_failure_path", "no_failure_path", "error_path_untested", "unhandled_error"]),
      impact: "An explicitly untested failure path can surface as an opaque error.",
      remediation: "Add a focused test for the failure path and verify the surfaced error message.",
      note: "Emitted only from an explicit failure-path marker; error handling quality is never inferred from code.",
    }),
  }),
  bounds: freeze({
    max_modules: 200,
    max_tests: 500,
    max_history: 500,
    max_gaps: 100,
    max_evidence_per_gap: 20,
  }),
  rules: freeze([
    "Every gap requires an explicit marker in tests, history or evidence; unusual-looking code is never a gap.",
    "No coverage percentage is computed, estimated or reported; unknown means insufficient evidence.",
    "Confidence is deterministic and capped below certainty; repetition nudges it only within the cap.",
    "All free text is redacted with core.redact and bounded before it is returned.",
    "No vulnerability identifier, package fact or dependency conclusion is produced here.",
  ]),
});

const MARKER_TO_GAP = Object.freeze((() => {
  const map = {};
  for (const [category, rule] of Object.entries(GAP_RULES.categories)) {
    map[markerKey(category)] = category;
    for (const m of rule.markers) map[markerKey(m)] = category;
  }
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
function stableKey(x) {
  if (x && typeof x === "object") {
    try { return JSON.stringify(x, Object.keys(x).sort()); } catch { return String(x); }
  }
  return String(x ?? "");
}

function markerFrom(value) {
  if (typeof value === "string") {
    const m = value.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
    return m ? m[1] : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["marker", "type", "kind", "signal", "status", "verdict", "category", "gap"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
    if (value.flaky === true) return "flaky_test";
    if (value.unverified === true) return "unverified_change";
    for (const k of Object.keys(value)) if (MARKER_TO_GAP[markerKey(k)]) return k;
  }
  return "";
}

function detailFrom(value) {
  if (typeof value === "string") {
    const i = value.search(/[:=]/);
    return i >= 0 ? value.slice(i + 1).trim() : "";
  }
  if (value && typeof value === "object") {
    for (const k of ["detail", "description", "note", "reason", "name", "test", "excerpt"]) {
      if (nonEmptyString(value[k])) return value[k];
    }
  }
  return "";
}

function componentFrom(value, fallback = "_project") {
  if (value && typeof value === "object") {
    for (const k of ["module", "component", "path", "file"]) {
      if (nonEmptyString(value[k])) return String(value[k]).trim();
    }
  }
  return fallback;
}

// Flexible evidence shapes: [entries] | { markers: [...] } | { [module]: [entries] }
function evidenceEntries(evidence) {
  const out = [];
  if (Array.isArray(evidence)) {
    for (const e of evidence) out.push({ component: null, entry: e });
    return out;
  }
  if (!evidence || typeof evidence !== "object") return out;
  const declared = nonEmptyString(evidence.component) ? evidence.component : null;
  if (Array.isArray(evidence.markers)) {
    for (const e of evidence.markers) out.push({ component: declared, entry: e });
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "component" || key === "markers") continue;
    if (Array.isArray(value)) for (const e of value) out.push({ component: key, entry: e });
    else {
      const isMarkerKey = Boolean(MARKER_TO_GAP[markerKey(key)]);
      out.push({ component: isMarkerKey ? null : key, entry: { marker: key, detail: value } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// analyzeTestQuality (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * Analyze supplied tests/history/evidence into explicit, bounded test gaps.
 * No coverage percentage is invented; empty input yields unknown, not a score.
 */
export function analyzeTestQuality({
  project_id, modules = [], tests = [], history = [], evidence = {}, limit = 50,
} = {}) {
  if (!nonEmptyString(project_id)) {
    return { ok: false, gaps: [], reason: "a valid project_id is required", coverage: "unknown" };
  }
  const n = clampLimit(limit, 50, GAP_RULES.bounds.max_gaps);
  const moduleList = (Array.isArray(modules) ? modules : [])
    .filter(nonEmptyString).map((m) => m.trim()).slice(0, GAP_RULES.bounds.max_modules);
  const moduleSet = new Set(moduleList);
  const selected = (value) => moduleSet.size === 0 || moduleSet.has(value);

  const signals = [];
  for (const t of (Array.isArray(tests) ? tests : []).slice(0, GAP_RULES.bounds.max_tests)) {
    if (!t || (typeof t !== "object" && typeof t !== "string")) continue;
    const cat = MARKER_TO_GAP[markerKey(markerFrom(t))];
    if (!cat) continue;
    const component = componentFrom(t);
    if (!selected(component)) continue;
    signals.push({ category: cat, component, detail: detailFrom(t) || String(markerFrom(t)),
      source: "test_record" });
  }
  for (const h of (Array.isArray(history) ? history : []).slice(0, GAP_RULES.bounds.max_history)) {
    if (!h || (typeof h !== "object" && typeof h !== "string")) continue;
    const cat = MARKER_TO_GAP[markerKey(markerFrom(h))];
    if (!cat) continue;
    const component = componentFrom(h);
    if (!selected(component)) continue;
    signals.push({ category: cat, component, detail: detailFrom(h) || String(markerFrom(h)),
      source: "history_observation" });
  }
  for (const item of evidenceEntries(evidence)) {
    const cat = MARKER_TO_GAP[markerKey(markerFrom(item.entry))];
    if (!cat) continue;
    const component = componentFrom(item.entry, item.component || (moduleList.length === 1 ? moduleList[0] : "_project"));
    if (!selected(component)) continue;
    signals.push({ category: cat, component, detail: detailFrom(item.entry) || String(markerFrom(item.entry)),
      source: "explicit_evidence" });
  }

  const grouped = new Map();
  for (const s of signals) {
    const key = `${s.component}\u0000${s.category}\u0000${s.detail}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }

  const gaps = [];
  for (const [key, group] of grouped) {
    if (gaps.length >= n) break;
    const [component, category, description] = key.split("\u0000");
    const rule = GAP_RULES.categories[category];
    const occurrences = new Set(group.map((s) => `${s.source}|${s.detail}`)).size;
    const confidence = round4(Math.min(0.75, rule.confidence + 0.05 * Math.max(0, occurrences - 1)));
    gaps.push({
      id: null,
      project_id,
      component,
      category,
      gap: category,
      description: clip(description || `Explicit ${category} marker`, 400),
      severity: rule.severity,
      confidence,
      impact: clip(rule.impact, 400),
      remediation: clip(rule.remediation, 600),
      suggestion: clip(rule.remediation, 600),
      evidence: group.slice(0, GAP_RULES.bounds.max_evidence_per_gap).map((s) => ({
        marker: category, source: s.source, excerpt: clip(s.detail, 400),
      })),
      occurrences,
      detection_method: "deterministic",
      certainty_claim: "none",
      causation_claim: "none",
      note: rule.note,
    });
  }

  const missingAreas = moduleList.filter((m) => !gaps.some((g) => g.component === m));
  return {
    ok: true,
    project_id,
    gaps,
    count: gaps.length,
    limit: n,
    coverage: "unknown",
    unknown_areas: missingAreas,
    examined: { tests: Array.isArray(tests) ? tests.length : 0, history: Array.isArray(history) ? history.length : 0, evidence: evidenceEntries(evidence).length },
    note: "Evidence-gated deterministic gap detection. No coverage percentage is computed or invented; " +
      "absence of evidence means unknown. No vulnerability identifier or dependency conclusion is produced.",
  };
}

export default { GAP_RULES, analyzeTestQuality };
