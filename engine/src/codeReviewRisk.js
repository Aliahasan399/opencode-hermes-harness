// Phase 25 capability G: evidence-backed code-review risk findings.
//
// Safety invariant: deterministic, source-local, project-scoped analysis only.
// No AST parser, no new dependency, no source writes, no spawn, no git, no LLM,
// no auto-approval. A suspicious pattern is NEVER reported as a confirmed
// vulnerability: security-shaped markers are emitted as `insufficient_evidence`
// and ordinary code smells as `potential`. Phase 23 finding logic is NOT
// reimplemented here; the four Phase 23 engines are delegated to via dynamic
// import and their results are captured verbatim (bounded) in `delegated`.
// Fail closed on a missing/`_global` project_id. Every path is clamped under
// root and every string is redacted and length-bounded.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

export const FINDING_STATUSES = Object.freeze([
  "confirmed", "potential", "informational", "insufficient_evidence",
]);

// Frozen, explainable description of each deterministic source-local rule.
// `status` is the default when the rule is triggered by a source pattern alone;
// an explicit caller marker/assertion upgrades the finding to `confirmed`.
export const RULES = Object.freeze({
  export_removal: Object.freeze({
    status: "potential", severity: "medium", confidence: 0.70,
    explanation: "An export declaration appears to have been removed in the supplied change evidence.",
    consequence: "Existing importers of that symbol may fail to resolve after the change is applied.",
    action: "Check inbound references and recorded decisions before releasing this change.",
    marker: "export_removal",
  }),
  import_cycle: Object.freeze({
    status: "potential", severity: "medium", confidence: 0.60,
    explanation: "A cycle was detected among the import edges visible in the supplied change evidence.",
    consequence: "Cyclic initialization order can produce fragile or partially-initialized modules.",
    action: "Break the cycle explicitly and record the resulting edge change as evidence.",
    marker: "import_cycle",
  }),
  async_handling: Object.freeze({
    status: "potential", severity: "medium", confidence: 0.50,
    explanation: "A Promise/then marker was seen without an adjacent await or catch in the bounded source window.",
    consequence: "A rejected promise may surface as an unhandled rejection instead of an actionable error.",
    action: "Add an explicit await or catch at the boundary and verify with a focused test.",
    marker: "unhandled_async",
  }),
  error_handling: Object.freeze({
    status: "potential", severity: "medium", confidence: 0.50,
    explanation: "An error-handling gap marker was seen (empty/broad catch, or a db call without nearby try).",
    consequence: "Failures can be swallowed or surface without a bounded, redacted diagnostic.",
    action: "Replace the broad/empty catch with explicit, typed handling and a redacted message.",
    marker: "missing_error_handling",
  }),
  scope_leak: Object.freeze({
    status: "potential", severity: "high", confidence: 0.45,
    explanation: "A hard-coded cross-project string (project_id / `_global`) was seen near a data-access call.",
    consequence: "A hard-coded scope can read or mix data from the wrong project if the call is executed.",
    action: "Derive project scope from the caller context and verify project isolation with a test.",
    marker: "cross_project_string",
  }),
  security_pattern: Object.freeze({
    status: "insufficient_evidence", severity: "medium", confidence: 0.30,
    explanation: "A security-sensitive source pattern was seen; a pattern alone is not proof of a vulnerability.",
    consequence: "If the pattern is reachable with untrusted input it could become a defect, but this analysis cannot establish that.",
    action: "Review the call site with an operator; do not treat this marker as a confirmed vulnerability.",
    marker: "security_pattern",
  }),
  test_gap: Object.freeze({
    status: "informational", severity: "low", confidence: 0.40,
    explanation: "A test-gap marker or a changed source file without a matching test reference was observed.",
    consequence: "The changed behaviour may lack a focused regression check.",
    action: "Add or select a focused test and record the explicit result as evidence.",
    marker: "missing_tests",
  }),
});

const MARKER_TO_CATEGORY = Object.freeze((() => {
  const m = {};
  for (const [cat, rule] of Object.entries(RULES)) {
    m[String(cat).toLowerCase()] = cat;
    m[String(rule.marker).toLowerCase()] = cat;
  }
  m["broad_catch"] = "error_handling";
  m["overly_broad_catch"] = "error_handling";
  m["unhandled_async_marker"] = "async_handling";
  m["new_import_cycle"] = "import_cycle";
  m["cross_project_string_pattern"] = "scope_leak";
  m["security_sensitive_pattern"] = "security_pattern";
  m["missing_try_catch"] = "error_handling";
  m["test_gap_marker"] = "test_gap";
  return m;
})());

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|sql)$/i;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINES = 400;
const MAX_EVIDENCE = 4;
const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_EDGES = 500;
const MAX_CYCLES = 20;
const BUILTIN_MODULES = new Set([
  "fs", "path", "os", "crypto", "url", "util", "events", "stream", "http", "https",
  "net", "assert", "child_process", "node:fs", "node:path", "node:os", "node:crypto",
  "node:url", "node:util", "node:events", "node:stream", "node:assert",
]);

// --- small deterministic helpers ------------------------------------------

function short(v, n = 220) { return core.redact(String(v ?? "").replace(/\s+/g, " ")).slice(0, n); }
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmpty(p) && p.trim() !== "_global"; }
function boundedInt(v, fallback, cap) { return Number.isInteger(v) && v > 0 ? Math.min(v, cap) : fallback; }
function round4(n) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0; }
function ev(x, max = 200) { return short(x, max); }
function db(options) { return typeof options?.dbQuery === "function" ? options.dbQuery : core.dbQuery; }
function clipArray(a, n) { return Array.isArray(a) ? a.slice(0, n) : []; }

async function load(name, loaders) {
  if (loaders && typeof loaders === "object") {
    const v = loaders[name];
    if (typeof v === "function") { try { return await v(); } catch { return null; } }
    if (v && typeof v === "object") return v;
  }
  try { return await import(`./${name}.js`); } catch { return null; }
}

function makeFinding({
  project_id, category, location, evidence = [], explanation = "", consequence = "",
  action = "", severity = "low", confidence = 0.3, status = "potential",
  related_tests = [], note = "", detection_method = "heuristic:source-local",
}) {
  const cat = String(category || "unknown").slice(0, 80);
  const loc = short(location, 240);
  const evs = clipArray(evidence, MAX_EVIDENCE).map((e) => ev(e));
  const fingerprint = crypto.createHash("sha256")
    .update(`${project_id}|${cat}|${loc}|${evs.join("|")}`).digest("hex").slice(0, 16);
  return {
    finding_id: `rev-${fingerprint}`,
    severity: VALID_SEVERITIES.has(String(severity).toLowerCase()) ? String(severity).toLowerCase() : "low",
    confidence: round4(Math.max(0, Math.min(0.95, confidence))),
    category: cat,
    location: loc,
    evidence: evs,
    explanation: short(explanation, 400),
    consequence: short(consequence, 400),
    action: short(action, 600),
    related_tests: clipArray(related_tests, 20).map((t) => short(t, 200)),
    status: FINDING_STATUSES.includes(status) ? status : "insufficient_evidence",
    detection_method,
    note: short(note, 400),
  };
}

function splitLines(text) {
  return String(text ?? "").split(/\r?\n/).slice(0, MAX_LINES)
    .map((t, i) => ({ n: i + 1, t: ev(t) })).filter((l) => l.t.length > 0);
}

function normRel(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").slice(0, 400);
}

function pathUnder(rootAbs, rel) {
  const abs = path.resolve(rootAbs, normRel(rel));
  return abs === rootAbs || abs.startsWith(rootAbs + path.sep) ? abs : null;
}

// --- source gathering (read-only, bounded, clamped under root) -------------

function inlineSources(evidence, change) {
  const out = [];
  const push = (p, content) => {
    if (typeof content === "string" && content.trim()) {
      out.push({ path: normRel(p || "inline"), lines: splitLines(content) });
    }
  };
  for (const s of clipArray(evidence?.sources, MAX_FILES)) {
    if (typeof s === "string") push("inline", s);
    else if (s && typeof s === "object") {
      const content = s.content ?? s.source ?? (Array.isArray(s.lines) ? s.lines.join("\n") : "");
      push(s.path || s.file || "inline", content);
    }
  }
  for (const s of clipArray(evidence?.snippets, MAX_FILES)) push("snippet", s);
  const diff = change?.diff ?? evidence?.diff;
  if (typeof diff === "string") push(change?.path || "diff", diff);
  else if (Array.isArray(diff)) push(change?.path || "diff", diff.join("\n"));
  return out;
}

function readDiskSources(root, paths) {
  if (!nonEmpty(root) || !Array.isArray(paths) || !paths.length) return [];
  const rootAbs = path.resolve(String(root));
  const out = [];
  for (const rel of paths.slice(0, MAX_FILES)) {
    const abs = pathUnder(rootAbs, rel);
    if (!abs) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES || !ALLOWED_EXT.test(path.extname(abs))) continue;
      const text = fs.readFileSync(abs, "utf8");
      out.push({ path: normRel(rel), lines: splitLines(text) });
    } catch { /* unreadable files are skipped, never fatal */ }
  }
  return out;
}

function gatherSources(change, evidence, root) {
  const inline = inlineSources(evidence, change);
  const diskPaths = [];
  if (nonEmpty(change?.path)) diskPaths.push(change.path);
  for (const f of clipArray(change?.files, MAX_FILES)) if (nonEmpty(f)) diskPaths.push(f);
  const disk = readDiskSources(root, diskPaths);
  const byPath = new Map();
  for (const s of [...disk, ...inline]) {
    if (!byPath.has(s.path)) byPath.set(s.path, { path: s.path, lines: [] });
    const target = byPath.get(s.path);
    target.lines.push(...s.lines);
  }
  return [...byPath.values()].slice(0, MAX_FILES)
    .map((s) => ({ path: s.path, lines: s.lines.slice(0, MAX_LINES) }));
}

// --- deterministic source-local rules -------------------------------------

function importsOf(text) {
  const out = [];
  let m;
  const re1 = /\bimport[^'"]*?['"]([^'"]+)['"]/g;
  const re2 = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const re3 = /\bexport[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const re of [re1, re2, re3]) {
    while ((m = re.exec(text)) && out.length < 12) { if (m[1]) out.push(m[1]); }
  }
  return [...new Set(out)];
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(normRel(fromFile));
  return path.posix.normalize(path.posix.join(dir, spec)).replace(/^\.\//, "").slice(0, 400);
}

function findCycles(adjacency) {
  const cycles = [];
  const seen = new Set();
  const state = new Map();
  const stack = [];
  const nodes = [...adjacency.keys()].sort().slice(0, MAX_GRAPH_NODES);
  const visit = (node) => {
    if (cycles.length >= MAX_CYCLES) return;
    if (state.get(node) === "done") return;
    if (state.get(node) === "active") {
      const at = stack.indexOf(node);
      const cyc = [...new Set(stack.slice(at >= 0 ? at : 0).concat(node))].sort();
      const key = cyc.join("|");
      if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      return;
    }
    state.set(node, "active");
    stack.push(node);
    for (const next of adjacency.get(node) || []) {
      if (!adjacency.has(next)) continue;
      visit(next);
      if (cycles.length >= MAX_CYCLES) break;
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const n of nodes) { if (cycles.length >= MAX_CYCLES) break; visit(n); }
  return cycles;
}

function explicitCategories(evidence) {
  const found = new Map();
  const add = (raw, detail, location, status) => {
    const key = String(raw ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "");
    const cat = MARKER_TO_CATEGORY[key];
    if (!cat || !RULES[cat]) return;
    if (!found.has(cat)) found.set(cat, { detail: short(detail, 200), location: short(location, 160), status });
  };
  const ingest = (item) => {
    if (typeof item === "string") {
      const m = item.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]\s*(.*)$/i);
      if (m) add(m[1], m[2], "evidence.markers", m[2] && /confirmed/.test(item) ? "confirmed" : "confirmed");
    } else if (item && typeof item === "object") {
      const raw = item.marker ?? item.category ?? item.kind ?? item.type ?? item.signal;
      add(raw, item.detail ?? item.description ?? item.note ?? "", item.location ?? "evidence.markers",
        item.status === "confirmed" || item.confirmed === true ? "confirmed" : "confirmed");
    }
  };
  if (Array.isArray(evidence?.markers)) for (const m of evidence.markers.slice(0, 60)) ingest(m);
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    for (const [k, v] of Object.entries(evidence)) {
      if (["markers", "sources", "snippets", "diff", "history", "assertions", "related_tests", "tests",
        "test_gaps", "version_hash", "change_ref", "dbQuery", "loaders"].includes(k)) continue;
      if (Array.isArray(v)) for (const x of v.slice(0, 40)) ingest(typeof x === "object" ? { ...x, marker: x.marker ?? k } : `${k}: ${x}`);
      else if (v && typeof v === "object") add(k, "", k, "confirmed");
      else add(k, v, k, "confirmed");
    }
  }
  for (const a of clipArray(evidence?.assertions, 60)) {
    if (typeof a === "string") add(a, a, "evidence.assertions", "confirmed");
    else if (a && typeof a === "object") add(a.category ?? a.marker, a.detail ?? a.description ?? "", a.location ?? "evidence.assertions", "confirmed");
  }
  return found;
}

function detectLocalFindings(sources, evidence, pid, limit) {
  const hits = [];
  const importAdjacency = new Map();
  const importEdges = [];
  const relatedTests = clipArray(evidence?.related_tests ?? evidence?.tests, 20).map((t) => short(t, 200));

  for (const src of sources) {
    const lines = src.lines;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].t;
      const loc = `${src.path}:${lines[i].n}`;
      const window = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 6)).map((l) => l.t).join("\n");
      const note = (extra) => `${extra} (${loc})`;

      if (/^\s*-\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|\{)/.test(text)) {
        hits.push({ cat: "export_removal", loc, ev: [text] });
      }
      for (const spec of importsOf(text)) {
        const to = resolveSpecifier(src.path, spec) ?? spec;
        if (!importAdjacency.has(src.path)) importAdjacency.set(src.path, new Set());
        importAdjacency.get(src.path).add(to);
        importEdges.push({ from: src.path, to, line: loc, raw: spec });
      }
      if (/\bnew\s+Promise\s*\(|\.then\s*\(/.test(text) && !/\b(?:await|catch)\b/.test(window)) {
        hits.push({ cat: "async_handling", loc, ev: [text] });
      }
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text)) {
        hits.push({ cat: "error_handling", loc, ev: [text], note: note("empty or broad catch") });
      }
      const scope = text.match(/\b(?:project_id|projectId)\s*[:=]\s*['"]([^'"]+)['"]/);
      if (scope && scope[1] && scope[1] !== pid && scope[1] !== "_global") {
        hits.push({ cat: "scope_leak", loc, ev: [text] });
      }
      if (/\b(?:dbQuery|withDb|\.query)\s*\(/.test(text) && !/\btry\b/.test(window)) {
        hits.push({ cat: "error_handling", loc, ev: [text], note: note("db call without nearby try") });
      }
      if (/\b(?:eval|exec|execSync|spawn|spawnSync)\s*\(|\bchild_process\b|innerHTML\s*=|\bdangerouslySetInnerHTML\b/.test(text)
        || /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]/i.test(text)) {
        hits.push({ cat: "security_pattern", loc, ev: [text] });
      }
    }
  }

  for (const cycle of findCycles(importAdjacency)) {
    const evs = importEdges.filter((e) => cycle.includes(e.from) && cycle.includes(e.to))
      .slice(0, MAX_EVIDENCE).map((e) => `${e.from} -> ${e.to} (${e.line})`);
    hits.push({ cat: "import_cycle", loc: cycle.join(" -> "), ev: evs.length ? evs : [cycle.join(" -> ")] });
  }

  const gaps = clipArray(evidence?.test_gaps, 20);
  for (const g of gaps) {
    hits.push({ cat: "test_gap", loc: typeof g === "object" ? short(g.location ?? g.component ?? "test_gap", 160) : "test_gap",
      ev: [typeof g === "string" ? g : (g.detail ?? g.description ?? "")] });
  }

  const explicit = explicitCategories(evidence);
  const byCat = new Map();
  for (const h of hits) {
    if (!RULES[h.cat]) continue;
    if (!byCat.has(h.cat)) byCat.set(h.cat, []);
    if (byCat.get(h.cat).length < 12) byCat.get(h.cat).push(h);
  }

  const findings = [];
  for (const [cat, items] of byCat) {
    const rule = RULES[cat];
    const exp = explicit.get(cat);
    for (const item of items) {
      const status = exp?.status ?? rule.status;
      findings.push(makeFinding({
        project_id: pid, category: cat, location: item.loc,
        evidence: exp && !item.ev?.length ? [exp.detail] : item.ev,
        explanation: exp?.detail ? `${rule.explanation} Explicit marker: ${exp.detail}` : (item.note ? `${rule.explanation} ${item.note}` : rule.explanation),
        consequence: rule.consequence, action: rule.action,
        severity: rule.severity, confidence: Math.min(exp ? 0.85 : rule.confidence, rule.confidence + (exp ? 0.15 : 0)),
        status, related_tests: relatedTests,
        note: cat === "security_pattern"
          ? "A suspicious pattern is insufficient evidence of a vulnerability; no confirmed defect is claimed."
          : "Deterministic source-local heuristic; confidence is bounded below certainty.",
      }));
    }
  }
  // Explicitly asserted categories that had no matching source pattern still
  // produce an evidence-backed (confirmed) finding.
  for (const [cat, exp] of explicit) {
    if (byCat.has(cat)) continue;
    const rule = RULES[cat];
    findings.push(makeFinding({
      project_id: pid, category: cat, location: exp.location || "evidence.markers",
      evidence: [exp.detail || `Explicit ${cat} marker`],
      explanation: `${rule.explanation} Explicit marker: ${exp.detail || cat}`,
      consequence: rule.consequence, action: rule.action,
      severity: rule.severity, confidence: 0.85, status: "confirmed",
      related_tests: relatedTests,
      note: "Confirmed here means explicitly asserted by caller evidence, not an independently verified vulnerability.",
    }));
  }

  return findings.slice(0, limit);
}

// --- delegation to Phase 23 (never reimplement their finding logic) -------

function toDelegationEvidence(evidence, findings) {
  const out = {};
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    for (const [k, v] of Object.entries(evidence)) {
      if (["sources", "snippets", "diff", "version_hash", "change_ref", "history", "assertions",
        "dbQuery", "loaders", "related_tests"].includes(k)) continue;
      out[k] = Array.isArray(v) ? v.slice(0, 50) : v;
    }
  }
  const hasMarker = (Array.isArray(out.markers) && out.markers.length > 0)
    || Object.keys(out).some((k) => k !== "test_gaps");
  if (!hasMarker && findings.length) {
    out.markers = findings.map((f) => `${RULES[f.category]?.marker ?? f.category}: ${f.explanation}`).slice(0, 50);
  }
  return out;
}

function phase23Findings(findings) {
  return findings.map((f, i) => ({
    id: f.finding_id, category: RULES[f.category]?.marker ?? f.category,
    component: f.location.split(":")[0] || "_project", description: f.explanation,
    status: f.status === "confirmed" ? "new" : "new", severity: f.severity,
    confidence: f.confidence, impact: f.consequence, remediation: f.action,
    evidence: f.evidence, source: `p25-review-${i}`,
  }));
}

function summaryOf(result) {
  if (!result || typeof result !== "object") return {};
  return {
    count: result.findings?.length ?? result.risks?.length ?? result.predictions?.length ?? result.recommendations?.length ?? null,
    degraded: result.degraded === true,
    ok: result.ok !== false,
    reason: result.reason || null,
    note: short(result.note, 200) || null,
  };
}

async function delegate(label, mod, fn, args, loaders) {
  try {
    const m = await load(mod, loaders);
    if (!m || typeof m[fn] !== "function") {
      return { ok: false, module: mod, fn, reason: `${mod}.${fn} unavailable`, degraded: true, ...summaryOf(null) };
    }
    const r = await m[fn](args);
    if (!r || r.ok === false) {
      return { ok: false, module: mod, fn, reason: r?.reason || `${fn} returned not ok`, degraded: true, ...summaryOf(r) };
    }
    return { ok: true, module: mod, fn, reason: null, degraded: false, ...summaryOf(r), result: r };
  } catch (e) {
    return { ok: false, module: mod, fn, reason: short(e?.message || e, 160), degraded: true, ...summaryOf(null) };
  }
}

async function runDelegation(pid, evidence, findings, edges, limit, loaders) {
  const ev = toDelegationEvidence(evidence, findings);
  const f23 = phase23Findings(findings);
  const [tech_debt, dependency_risk, fragility, recommendations] = await Promise.all([
    delegate("tech_debt", "technicalDebt", "detectDebt",
      { project_id: pid, components: [], evidence: ev, limit }, loaders),
    delegate("dependency_risk", "dependencyRisk", "analyzeDependencies",
      { project_id: pid, edges, evidence: ev, limit }, loaders),
    delegate("fragility", "projectRisk", "predictFragility",
      { project_id: pid, findings: f23, history: clipArray(evidence?.history, 20), evidence: ev, limit }, loaders),
    delegate("recommendations", "recommendationEngine", "buildRecommendations",
      { project_id: pid, findings: f23, predictions: [], test_gaps: clipArray(evidence?.test_gaps, 20), limit }, loaders),
  ]);
  return { tech_debt, dependency_risk, fragility, recommendations };
}

function edgeList(sources) {
  const edges = [];
  for (const src of sources) {
    for (const line of src.lines) {
      for (const spec of importsOf(line.t)) {
        const to = resolveSpecifier(src.path, spec);
        if (to) edges.push({ from: src.path, to });
      }
    }
  }
  return edges.slice(0, MAX_GRAPH_EDGES);
}

// --- persistence (bounded, project-scoped, idempotent upsert) --------------

function persistReview(pid, changeRef, versionHash, payload, confidence, options) {
  const result = {
    findings: payload.findings, counts: payload.counts,
    delegated: Object.fromEntries(Object.entries(payload.delegated).map(([k, v]) => [k, {
      ok: v.ok, reason: v.reason, degraded: v.degraded, count: v.count ?? null,
    }])),
    note: payload.note,
  };
  return db(options)(
    `INSERT INTO code_analysis
       (id, project_id, analysis_type, change_ref, version_hash, result, confidence, status, error)
     VALUES ($1,$2,'review',$3,$4,$5::jsonb,$6,'complete',NULL)
     ON CONFLICT (project_id, analysis_type, change_ref, version_hash)
     DO UPDATE SET result=EXCLUDED.result, confidence=EXCLUDED.confidence,
                   status=EXCLUDED.status, error=NULL`,
    [crypto.randomUUID(), pid, changeRef, versionHash, JSON.stringify(result), confidence],
  );
}

// --- public API ------------------------------------------------------------

export async function reviewChange(options = {}) {
  const rawPid = options?.project_id;
  const pid = nonEmpty(rawPid) ? rawPid.trim() : "";
  if (!validProject(rawPid) || pid !== rawPid.trim()) {
    return { ok: false, findings: [], counts: emptyCounts(), reason: "valid project_id required",
      note: "project_id must be a non-empty string other than '_global'." };
  }
  const limit = boundedInt(options.limit, 100, 300);
  const change = options.change && typeof options.change === "object" ? options.change : {};
  const evidence = options.evidence && typeof options.evidence === "object" ? options.evidence : {};
  const errors = [];

  const sources = gatherSources(change, evidence, options.root);
  const findings = detectLocalFindings(sources, evidence, pid, limit);
  const counts = emptyCounts();
  for (const f of findings) if (counts[f.status] !== undefined) counts[f.status]++;

  const delegated = await runDelegation(pid, evidence, findings, edgeList(sources), limit, options.loaders);

  const changeRef = short(evidence.change_ref ?? change.change_ref ?? change.path ?? change.files?.[0] ?? "manual", 200) || "manual";
  const canonical = JSON.stringify({
    change: { path: short(change.path, 200), files: clipArray(change.files, 20).map((f) => short(f, 200)),
      symbol_key: short(change.symbol_key, 120) },
    sources: sources.map((s) => ({ path: s.path, text: s.lines.map((l) => l.t).join("\n") })),
  });
  const versionHash = short(evidence.version_hash ?? change.version_hash
    ?? crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32), 120) || "empty";

  const confidence = findings.reduce((mx, f) => Math.max(mx, f.confidence), 0);
  let persisted = false;
  try {
    await persistReview(pid, changeRef, versionHash, { findings, counts, delegated, note: reviewNote(findings) },
      round4(confidence), options);
    persisted = true;
  } catch (e) {
    errors.push(`persistence unavailable: ${short(e?.message || e, 160)}`);
  }
  try { await core.audit("p25.review", pid, { change_ref: changeRef, findings: findings.length, persisted }); }
  catch { /* best effort */ }

  const degraded = errors.length > 0 || Object.values(delegated).some((d) => d.degraded || !d.ok);
  return {
    ok: true, project_id: pid, change_ref: changeRef, version_hash: versionHash,
    findings, delegated, counts, persisted, errors, degraded,
    note: reviewNote(findings, degraded),
  };
}

function emptyCounts() {
  return { confirmed: 0, potential: 0, informational: 0, insufficient_evidence: 0 };
}

function reviewNote(findings, degraded) {
  const base = "Deterministic, evidence-backed source-local review heuristics. A suspicious pattern is never a confirmed " +
    "vulnerability; security-shaped markers are insufficient_evidence and other patterns are potential. " +
    "Phase 23 engines are delegated to, not reimplemented. No source was rewritten and no conclusion is certain.";
  return degraded ? `${base} Some capabilities were unavailable and are reported as degraded.` : base;
}

export async function getReview(options = {}) {
  const rawPid = options?.project_id;
  const pid = nonEmpty(rawPid) ? rawPid.trim() : "";
  if (!validProject(rawPid) || pid !== rawPid.trim()) {
    return { ok: false, items: [], reason: "valid project_id required" };
  }
  const limit = boundedInt(options.limit, 50, 200);
  const params = [pid];
  let sql = "SELECT id, project_id, analysis_type, change_ref, version_hash, result, confidence, status, error, created_at FROM code_analysis WHERE project_id=$1 AND analysis_type='review'";
  if (nonEmpty(options.change_ref)) { params.push(short(options.change_ref, 200)); sql += ` AND change_ref=$${params.length}`; }
  if (nonEmpty(options.version_hash)) { params.push(short(options.version_hash, 120)); sql += ` AND version_hash=$${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY created_at DESC, id::text ASC LIMIT $${params.length}`;
  try {
    const r = await db(options)(sql, params);
    const items = (r.rows || []).map((row) => {
      let result = row.result;
      if (typeof result === "string") { try { result = JSON.parse(result); } catch { result = {}; } }
      return { ...row, result: result && typeof result === "object" ? result : {} };
    });
    return { ok: true, items, reviews: items, note: "Bounded, project-scoped read of persisted review analyses." };
  } catch (e) {
    return { ok: false, items: [], reason: `review read failed: ${short(e?.message || e, 160)}` };
  }
}

export default { reviewChange, getReview, RULES, FINDING_STATUSES };
