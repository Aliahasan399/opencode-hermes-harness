// Phase 25 Capability F — explainable test selection.
//
// Safety invariants (LEVEL 1, analysis only):
//   * Recommends tests ONLY. It never executes a test, never spawns a process,
//     never rewrites source, and never bypasses the Phase 24 approval gate.
//   * A recommendation is derived from changeImpact.analyzeChange output plus
//     testMap.getTestsFor evidence. Every item carries a human-readable reason
//     and redacted evidence; nothing is selected on a bare guess.
//   * Bounded, project-scoped, deduplicated by (path, test_name). High-confidence
//     direct/indirect links are surfaced as must_not_skip; affected symbols with
//     no test mapping are reported as missing_relations.
//   * All sibling loads are dynamic, fail-closed on bad scope, and degrade
//     gracefully when a sibling module or the database is unavailable.
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const TEST_SELECTION = freeze({
  version: "1.0.0",
  note: "Recommendations only: this module never executes tests, never rewrites source, " +
    "and never bypasses Phase 24 approval gates. Confidence is heuristic; no test result or coverage is claimed.",
  bounds: freeze({
    default_limit: 30,
    max_limit: 100,
    max_affected: 60,
    max_evidence: 5,
    max_reason_chars: 240,
  }),
  must_not_skip: freeze({ types: freeze(["direct", "indirect"]), min_confidence: 0.6 }),
  rules: freeze([
    "Use changeImpact.analyzeChange for affected paths/symbols, then testMap.getTestsFor for each.",
    "Deduplicate by (path, test_name), keeping the highest-confidence link.",
    "Explain every recommendation with a human-readable reason grounded in a real link.",
    "Never execute tests or claim a verification outcome; Phase 24 approval is untouched.",
  ]),
});

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
function validProject(p) {
  return typeof p === "string" && p.trim().length > 0 && p.trim() !== "_global";
}
function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function clip(v, n = 240) { return core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n); }
function clampLimit(limit) {
  const b = TEST_SELECTION.bounds;
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, b.max_limit) : b.default_limit;
}
function base(reason) {
  return {
    ok: false,
    recommended: [], must_not_skip: [], missing_relations: [],
    note: TEST_SELECTION.note, ...(reason ? { reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Affected-set normalization
// ---------------------------------------------------------------------------

function itemPath(x) {
  if (nonEmptyString(x)) return x;
  if (x && typeof x === "object") {
    for (const k of ["path", "file_path", "source_path", "source_file", "file"]) {
      if (nonEmptyString(x[k])) return String(x[k]);
    }
  }
  return "";
}
function itemSymbol(x) {
  if (!x || typeof x !== "object") return null;
  const key = nonEmptyString(x.symbol_key) ? x.symbol_key
    : (nonEmptyString(x.key) ? x.key : "");
  if (!key) return null;
  return { key: String(key).slice(0, 120), name: nonEmptyString(x.name) ? String(x.name).slice(0, 120) : "", path: itemPath(x) };
}

/** Collect distinct affected paths and symbols from impact output and the raw change. */
function collectAffected(impact, change) {
  const max = TEST_SELECTION.bounds.max_affected;
  const paths = [];
  const symbols = [];
  const seenPaths = new Set();
  const seenSymbols = new Set();

  const addPath = (v) => {
    const p = itemPath(v);
    if (p && !seenPaths.has(p) && paths.length < max) { seenPaths.add(p); paths.push(p); }
  };
  const addSymbol = (v) => {
    const s = itemSymbol(v);
    if (s && !seenSymbols.has(s.key) && symbols.length < max) { seenSymbols.add(s.key); symbols.push(s); }
  };
  const scan = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(0, max * 2)) {
      if (typeof row === "string") { addPath(row); continue; }
      if (row && typeof row === "object") { addSymbol(row); addPath(row); }
    }
  };

  for (const group of [impact?.direct, impact?.transitive, impact?.possible, impact?.unknown]) {
    scan(group);
  }
  if (change && typeof change === "object") {
    addPath(change.path);
    scan(change.files);
    addSymbol(change);
  }
  return { paths, symbols };
}

function reasonFor(item, trigger) {
  const src = nonEmptyString(item.source_path) ? item.source_path : trigger;
  let text;
  switch (item.link_type) {
    case "direct":
      text = `direct import of changed module ${src}`;
      break;
    case "indirect":
      text = `imported module name matches ${src} referenced by the change`;
      break;
    case "candidate":
      text = `test name mentions a symbol in ${src}`;
      break;
    default:
      text = `test linked to ${src}`;
  }
  return clip(`Because ${trigger} changed: ${text}`, TEST_SELECTION.bounds.max_reason_chars);
}

function evidenceFor(item, reason) {
  const raw = Array.isArray(item.evidence) ? item.evidence.filter(Boolean).slice(0, TEST_SELECTION.bounds.max_evidence) : [];
  const ev = raw.map((e) => ({
    kind: clip(e?.kind || "link", 60),
    excerpt: clip(e?.excerpt || e?.detail || e?.reason || reason, 200),
  }));
  if (!ev.length) ev.push({ kind: "link", excerpt: clip(reason, 200) });
  return ev;
}

// ---------------------------------------------------------------------------
// recommendTests
// ---------------------------------------------------------------------------

/**
 * Recommend tests for a change. Never executes tests and never touches approval.
 * `analyzeChange` and `getTestsFor` may be injected (used for isolation/tests);
 * otherwise sibling modules are loaded dynamically.
 */
export async function recommendTests({
  project_id, root, change, limit, analyzeChange, getTestsFor,
} = {}) {
  if (!validProject(project_id)) return base("a valid project_id is required");
  const pid = project_id.trim().slice(0, 200);
  const n = clampLimit(limit);
  const degraded = [];
  const out = { ...base(), ok: true, project_id: pid, limit: n, degraded };

  // 1. Affected paths/symbols from changeImpact (injected or dynamically loaded).
  let impact = null;
  if (typeof analyzeChange === "function") {
    try { impact = await analyzeChange({ project_id: pid, root, change, limit: n }); }
    catch (e) { degraded.push(`analyzeChange: ${clip(e?.message || e, 120)}`); }
  }
  if (!impact) {
    const ci = await load("changeImpact");
    if (typeof ci?.analyzeChange === "function") {
      try { impact = await ci.analyzeChange({ project_id: pid, root, change, limit: n }); }
      catch (e) { degraded.push(`changeImpact.analyzeChange: ${clip(e?.message || e, 120)}`); }
    } else {
      degraded.push("changeImpact.analyzeChange unavailable");
    }
  }
  if (impact && impact.ok === false && !Array.isArray(impact.direct)) {
    degraded.push(`analyzeChange returned ok=false: ${clip(impact.reason || "unavailable", 120)}`);
  }

  const affected = collectAffected(impact, change);
  if (!affected.paths.length && !affected.symbols.length) {
    out.note = `${TEST_SELECTION.note} No affected paths or symbols were identified from the supplied change.`;
    return out;
  }

  // 2. Resolve test mappings (injected or dynamically loaded).
  let getter = typeof getTestsFor === "function" ? getTestsFor : null;
  if (!getter) {
    const tm = await load("testMap");
    if (typeof tm?.getTestsFor === "function") getter = tm.getTestsFor;
    else degraded.push("testMap.getTestsFor unavailable");
  }
  if (!getter) {
    out.missing_relations = affected.symbols.map((s) => ({
      symbol_key: s.key, name: s.name, path: s.path, reason: "test map unavailable; no mapping could be checked",
    }));
    out.note = `${TEST_SELECTION.note} Test map unavailable; no recommendations could be formed.`;
    return out;
  }

  const byRecommendation = new Map();
  const symbolCoverage = new Map(affected.symbols.map((s) => [s.key, 0]));
  const tasks = [
    ...affected.paths.map((value) => ({ kind: "path", value })),
    ...affected.symbols.map((value) => ({ kind: "symbol", value })),
  ];

  for (const task of tasks) {
    const trigger = task.kind === "path" ? task.value : (task.value.name || task.value.key);
    const args = task.kind === "path"
      ? { project_id: pid, root, path: task.value, limit: n }
      : { project_id: pid, root, symbol_key: task.value.key, path: task.value.path || undefined, limit: n };
    let items = [];
    try {
      const res = await getter(args);
      items = Array.isArray(res?.items) ? res.items : [];
    } catch (e) {
      degraded.push(`getTestsFor: ${clip(e?.message || e, 120)}`);
    }
    if (task.kind === "symbol") {
      symbolCoverage.set(task.value.key, (symbolCoverage.get(task.value.key) || 0) + items.length);
    }
    for (const item of items) {
      if (!item || !nonEmptyString(item.test_path) || !nonEmptyString(item.test_name)) continue;
      const link = nonEmptyString(item.link_type) ? item.link_type : "unmapped";
      if (link === "unmapped") continue; // no evidence-backed link: never recommend
      const confidence = Number(item.confidence) || 0;
      const reason = reasonFor(item, clip(trigger, 120));
      const rec = {
        path: String(item.test_path).slice(0, 400),
        test_name: String(item.test_name).slice(0, TEST_SELECTION.bounds.max_reason_chars),
        reason,
        link_type: link,
        evidence: evidenceFor(item, reason),
        confidence,
      };
      const key = `${rec.path}\u0000${rec.test_name}`;
      const prev = byRecommendation.get(key);
      if (!prev || rec.confidence > prev.confidence) byRecommendation.set(key, rec);
    }
  }

  const all = [...byRecommendation.values()].sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
  out.recommended = all.slice(0, n);
  out.must_not_skip = all
    .filter((r) => TEST_SELECTION.must_not_skip.types.includes(r.link_type)
      && r.confidence >= TEST_SELECTION.must_not_skip.min_confidence)
    .slice(0, n);
  out.missing_relations = affected.symbols
    .filter((s) => (symbolCoverage.get(s.key) || 0) === 0)
    .map((s) => ({
      symbol_key: s.key,
      name: s.name,
      path: s.path,
      reason: "no test mapping found for affected symbol",
    }));
  return out;
}

export default { TEST_SELECTION, recommendTests };
