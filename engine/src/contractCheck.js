// Phase 25 capability H: architecture / contract consistency checks.
//
// Safety invariant: deterministic, source-local, project-scoped analysis only.
// No AST parser, no source writes, no spawn, no git, no LLM, no auto-rewrite.
// Import edges come from indexed code_relationship/code_symbol evidence and a
// bounded read of source files under root. Directory conventions are compared
// to actual edges, cycles are found with bounded DFS, and documented contract
// tokens (README/cli/server) are compared to actual exports on a best-effort
// basis. Every discrepancy is a FINDING, never automatic proof of a defect.
// Phase 18 decisionIntel/relationshipIntel are reused via dynamic import and
// degradation is recorded when they are unavailable. Fail closed on a missing
// or `_global` project_id. Paths are clamped under root; text is redacted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

export const FINDING_STATUSES = Object.freeze(["confirmed", "potential", "informational", "insufficient_evidence"]);
const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", "checkpoints", "backups", "__pycache__", ".pytest_cache", "dist", "build", "coverage"]);
const MAX_FILES = 300;
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 10;
const MAX_NODES = 200;
const MAX_EDGES = 500;
const MAX_CYCLES = 20;
const MAX_EVIDENCE = 4;
const BUILTINS = new Set([
  "fs", "path", "os", "crypto", "url", "util", "events", "stream", "http", "https", "net",
  "assert", "node:fs", "node:path", "node:os", "node:crypto", "node:url", "node:util",
  "node:events", "node:stream", "node:assert", "node:test", "zod", "pg",
]);

// --- helpers ---------------------------------------------------------------

function short(v, n = 220) { return core.redact(String(v ?? "").replace(/\s+/g, " ")).slice(0, n); }
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmpty(p) && p.trim() !== "_global"; }
function boundedInt(v, fallback, cap) { return Number.isInteger(v) && v > 0 ? Math.min(v, cap) : fallback; }
function round4(n) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0; }
function clipArray(a, n) { return Array.isArray(a) ? a.slice(0, n) : []; }
function db(options) { return typeof options?.dbQuery === "function" ? options.dbQuery : core.dbQuery; }
function ev(x, max = 200) { return short(x, max); }
function normRel(p) { return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").slice(0, 400); }

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
  action = "", severity = "medium", confidence = 0.5, status = "potential", related_tests = [],
}) {
  const cat = String(category || "unknown").slice(0, 80);
  const loc = short(location, 240);
  const evs = clipArray(evidence, MAX_EVIDENCE).map((e) => ev(e));
  const fingerprint = crypto.createHash("sha256")
    .update(`${project_id}|${cat}|${loc}|${evs.join("|")}`).digest("hex").slice(0, 16);
  return {
    finding_id: `con-${fingerprint}`,
    severity: VALID_SEVERITIES.has(String(severity).toLowerCase()) ? String(severity).toLowerCase() : "medium",
    confidence: round4(Math.max(0, Math.min(0.95, confidence))),
    category: cat, location: loc, evidence: evs,
    explanation: short(explanation, 400), consequence: short(consequence, 400),
    action: short(action, 600),
    related_tests: clipArray(related_tests, 20).map((t) => short(t, 200)),
    status: FINDING_STATUSES.includes(status) ? status : "informational",
    note: "A discrepancy is a lead for review, never automatic proof of a defect.",
  };
}

// --- indexed evidence ------------------------------------------------------

async function loadIndexed(pid, limit, options) {
  const out = { symbols: [], relationships: [], ok: true, reason: null };
  try {
    const s = await db(options)(
      `SELECT file_path, symbol_key, name, symbol_type, is_export, confidence, evidence
         FROM code_symbol WHERE project_id=$1 AND status='active'
        ORDER BY file_path ASC, start_line ASC LIMIT $2`, [pid, limit]);
    out.symbols = s.rows || [];
  } catch (e) { out.ok = false; out.reason = `code_symbol read failed: ${short(e?.message || e, 140)}`; }
  try {
    const r = await db(options)(
      `SELECT source_key, target_key, relationship_type, source_file, source_line,
              status, confidence, evidence, extraction_method
         FROM code_relationship WHERE project_id=$1
        ORDER BY source_key ASC LIMIT $2`, [pid, limit]);
    out.relationships = r.rows || [];
  } catch (e) { out.ok = false; out.reason = `${out.reason ? out.reason + "; " : ""}code_relationship read failed: ${short(e?.message || e, 140)}`; }
  return out;
}

function parseEvidence(x) {
  if (Array.isArray(x)) return x.slice(0, MAX_EVIDENCE).map((e) => ev(typeof e === "string" ? e : (e?.text ?? e?.excerpt ?? "")));
  if (typeof x === "string") { try { return parseEvidence(JSON.parse(x)); } catch { return [ev(x)]; } }
  return [];
}

// --- bounded source discovery + token extraction ---------------------------

function discoverFiles(root) {
  if (!nonEmpty(root)) return [];
  const rootAbs = path.resolve(String(root));
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile() && ALLOWED_EXT.test(path.extname(entry.name))) {
        try { if (fs.statSync(abs).size <= MAX_BYTES) out.push({ abs, rel: normRel(path.relative(rootAbs, abs)) }); }
        catch { /* skip unreadable */ }
      }
    }
  };
  walk(rootAbs, 0);
  return out;
}

function readLines(abs) {
  try {
    return String(fs.readFileSync(abs, "utf8")).split(/\r?\n/).slice(0, 800)
      .map((t, i) => ({ n: i + 1, t: ev(t) })).filter((l) => l.t.length);
  } catch { return []; }
}

function importTokens(text) {
  const out = [];
  let m;
  const patterns = [
    /\bimport[^'"]*?['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    while ((m = re.exec(text)) && out.length < 12) { if (m[1]) out.push(m[1]); }
  }
  return [...new Set(out)];
}

function exportTokens(text) {
  const out = [];
  let m = text.match(/\bexport\s*\{([^}]*)\}/);
  if (m) for (const part of m[1].split(",")) {
    const id = part.trim().split(/\s+as\s+/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(id)) out.push(id);
  }
  const re = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(text)) && out.length < 20) out.push(m[1]);
  return [...new Set(out)];
}

function normTarget(fromRel, spec) {
  if (!spec.startsWith(".")) return spec;
  const dir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(dir, spec)).replace(/^\.\//, "").slice(0, 400);
}

function layerOf(rel) {
  const f = normRel(rel).toLowerCase();
  if (/(^|\/)tests?(\/|$)/.test(f) || /[._-](test|spec)\.[cm]?[jt]sx?$/.test(f)) return "test";
  if (/(^|\/)dashboard(\/|$)/.test(f)) return "dashboard";
  if (/(^|\/)engine(\/|$)/.test(f)) return "engine";
  if (/(^|\/)src(\/|$)/.test(f)) return "src";
  return "other";
}

// --- bounded cycle detection -----------------------------------------------

function findCycles(adjacency) {
  const cycles = [];
  const seen = new Set();
  const state = new Map();
  const stack = [];
  const nodes = [...adjacency.keys()].sort().slice(0, MAX_NODES);
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

// --- documented contract tokens (best effort) ------------------------------

function contractTokens(root, files) {
  const textByName = new Map();
  for (const f of files) {
    const base = path.posix.basename(f.rel).toLowerCase();
    if (base === "cli.js" || base === "server.js") {
      try { textByName.set(base, String(fs.readFileSync(f.abs, "utf8")).slice(0, 200000)); } catch { /* best effort */ }
    }
  }
  // README.md is documentation, not a source extension, so read it directly
  // from the clamped root (best effort, bounded).
  let readme = "";
  if (nonEmpty(root)) {
    try {
      const rootAbs = path.resolve(String(root));
      const abs = path.resolve(rootAbs, "README.md");
      if (abs.startsWith(rootAbs + path.sep) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= MAX_BYTES * 2) {
        readme = String(fs.readFileSync(abs, "utf8")).slice(0, 200000);
      }
    } catch { /* best effort */ }
  }
  textByName.set("readme.md", readme);
  const impl = `${textByName.get("cli.js") || ""}\n${textByName.get("server.js") || ""}`;
  const documented = [...new Set((readme.match(/\bp25\.[a-z][a-z0-9_]*\b/g) || []))].slice(0, 40);
  const missing = documented.filter((token) => !impl.includes(token)).slice(0, 40);
  return { documented, missing, readmePresent: !!readme, implPresent: !!(textByName.get("cli.js") || textByName.get("server.js")) };
}

// --- Phase 18 reuse --------------------------------------------------------

async function relatedContext(pid, limit, loaders) {
  const out = { decisions: [], relationships: [], degraded: [] };
  const decisionIntel = await load("decisionIntel", loaders);
  if (decisionIntel?.getDecisions) {
    try {
      const r = await decisionIntel.getDecisions({ project_id: pid, limit: Math.min(limit, 20) });
      if (r.ok) out.decisions = clipArray(r.decisions, 20).map((d) => ({
        id: d.id, title: short(d.title, 200), status: short(d.status, 40),
      }));
      else out.degraded.push(`decisionIntel: ${short(r.reason, 100)}`);
    } catch (e) { out.degraded.push(`decisionIntel: ${short(e?.message || e, 100)}`); }
  } else out.degraded.push("decisionIntel unavailable");

  const relationshipIntel = await load("relationshipIntel", loaders);
  if (relationshipIntel?.getRelationships) {
    for (const d of out.decisions.slice(0, 5)) {
      try {
        const r = await relationshipIntel.getRelationships({
          project_id: pid, subject_type: "decision", subject_id: String(d.id), limit: 10,
        });
        if (r.ok) out.relationships.push(...clipArray(r.relationships, 10).map((x) => ({
          id: x.id, relation_type: short(x.relation_type, 80), confidence: x.confidence,
          decision_id: d.id,
        })));
      } catch (e) { out.degraded.push(`relationshipIntel: ${short(e?.message || e, 100)}`); }
    }
  } else out.degraded.push("relationshipIntel unavailable");
  return out;
}

// --- public API ------------------------------------------------------------

export async function checkContracts(options = {}) {
  const rawPid = options?.project_id;
  const pid = nonEmpty(rawPid) ? rawPid.trim() : "";
  if (!validProject(rawPid) || pid !== rawPid.trim()) {
    return { ok: false, findings: [], imports: [], exports: [], cycles: [], discrepancies: [],
      reason: "valid project_id required", note: "project_id must be a non-empty string other than '_global'." };
  }
  const limit = boundedInt(options.limit, 200, 500);
  const errors = [];
  const degraded = [];

  const indexed = await loadIndexed(pid, limit, options);
  if (!indexed.ok) { errors.push(indexed.reason); degraded.push("indexed evidence unavailable"); }

  const files = discoverFiles(options.root);
  const imports = [];
  const exports = [];
  const adjacency = new Map();
  const seenEdges = new Set();

  // Source-derived edges (bounded). Only project-relative targets feed the graph.
  for (const f of files) {
    for (const line of readLines(f.abs)) {
      for (const spec of importTokens(line.t)) {
        const to = normTarget(f.rel, spec);
        const isProject = spec.startsWith(".");
        const edge = { from: f.rel, to, file: f.rel, line: line.n, raw: spec, status: "source" };
        if (imports.length < limit) imports.push(edge);
        if (isProject && !BUILTINS.has(to)) {
          if (!adjacency.has(f.rel)) adjacency.set(f.rel, new Set());
          adjacency.get(f.rel).add(to);
          const key = `${f.rel}\u0000${to}`;
          if (!seenEdges.has(key)) { seenEdges.add(key); }
        }
      }
      for (const name of exportTokens(line.t)) {
        if (exports.length < limit) exports.push({ name, file: f.rel, line: line.n, symbol_key: null, source: "source" });
      }
    }
  }

  // Indexed edges supplement (never duplicate) the source-derived graph.
  for (const rel of indexed.relationships) {
    if (String(rel.relationship_type || "") !== "import") continue;
    const from = normRel(rel.source_file || rel.source_key);
    const to = normRel(rel.target_key);
    if (!from || !to || from === to) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
    const key = `${from}\u0000${to}`;
    if (!seenEdges.has(key) && imports.length < limit) {
      seenEdges.add(key);
      imports.push({ from, to, file: from, line: rel.source_line || 0,
        raw: short(rel.evidence?.[0], 120) || to, status: short(rel.status, 40) });
    }
  }
  for (const s of indexed.symbols) {
    if (s.is_export && exports.length < limit) {
      exports.push({ name: short(s.name, 120), file: normRel(s.file_path), line: 0,
        symbol_key: short(s.symbol_key, 120), source: "index" });
    }
  }

  const cycles = findCycles(adjacency).map((nodes) => ({
    nodes,
    evidence: imports.filter((e) => nodes.includes(e.from) && nodes.includes(e.to))
      .slice(0, MAX_EVIDENCE).map((e) => `${e.from} -> ${e.to}${e.line ? ` (line ${e.line})` : ""}`),
  })).slice(0, MAX_CYCLES);

  const contracts = contractTokens(options.root, files);
  const intel = await relatedContext(pid, limit, options.loaders);
  degraded.push(...intel.degraded);

  const findings = [];
  const add = (f) => { if (findings.length < limit) findings.push(f); };
  const constraints = [
    { from: "src", to: "test", label: "src_imports_test" },
    { from: "engine", to: "dashboard", label: "engine_imports_dashboard" },
  ];
  for (const edge of imports) {
    const fromLayer = layerOf(edge.from);
    const toLayer = layerOf(edge.to);
    for (const c of constraints) {
      if (fromLayer === c.from && toLayer === c.to) {
        add(makeFinding({
          project_id: pid, category: c.label,
          location: `${edge.from}:${edge.line} -> ${edge.to}`,
          evidence: [edge.raw, `${fromLayer} -> ${toLayer}`],
          explanation: `Import crosses an intended boundary: ${fromLayer} module imports from ${toLayer}.`,
          consequence: "The dependency direction can invert layering and pull test/dashboard concerns into production code.",
          action: "Confirm the boundary against recorded decisions; move the shared code or justify an explicit exception.",
          severity: "medium", confidence: 0.65, status: "potential",
          related_tests: intel.relationships.filter((r) => r.confidence != null).map((r) => r.relation_type).slice(0, 10),
        }));
      }
    }
  }
  for (const cyc of cycles) {
    add(makeFinding({
      project_id: pid, category: "import_cycle", location: cyc.nodes.join(" -> "),
      evidence: cyc.evidence.length ? cyc.evidence : [cyc.nodes.join(" -> ")],
      explanation: "A bounded DFS over observed import edges found a cycle.",
      consequence: "Cyclic initialization order can make module loading fragile and hard to reason about.",
      action: "Break the cycle explicitly and record the resulting edge change as evidence.",
      severity: "medium", confidence: 0.60, status: "potential",
    }));
  }
  for (const token of contracts.missing) {
    add(makeFinding({
      project_id: pid, category: "documented_contract_missing", location: "README.md -> cli.js/server.js",
      evidence: [token],
      explanation: `Contract token "${token}" is documented in README but not found in the bounded cli/server source read.`,
      consequence: "Users may expect a command/API that is not present in the inspected source (documentation drift).",
      action: "Verify against the real entry points before changing docs or code; a missing token is not proof of a defect.",
      severity: "low", confidence: 0.50, status: "informational",
    }));
  }
  for (const symbol of exports.slice(0, 25)) {
    const name = symbol.name;
    if (!name || name === "default") continue;
    const documented = `${contracts.readmePresent ? "" : ""}${contracts.documented.join(" ")}`;
    if (documented.includes(name)) continue;
    add(makeFinding({
      project_id: pid, category: "undocumented_export", location: `${symbol.file}:${symbol.line || 0}`,
      evidence: [`export ${name}`],
      explanation: `Exported symbol "${name}" was not referenced by the documented contract tokens in the README read.`,
      consequence: "The export may be internal or the documentation may be stale; this is informational only.",
      action: "Confirm the public contract with an operator before changing visibility.",
      severity: "low", confidence: 0.35, status: "informational",
    }));
  }

  const boundedFindings = findings.slice(0, limit);
  try { await core.audit("p25.contracts.check", pid, { findings: boundedFindings.length, cycles: cycles.length }); }
  catch { /* best effort */ }

  return {
    ok: true, project_id: pid,
    findings: boundedFindings,
    imports: imports.slice(0, limit),
    exports: exports.slice(0, limit),
    cycles,
    discrepancies: boundedFindings,
    related_decisions: intel.decisions,
    related_relationships: intel.relationships,
    errors, degraded,
    note: "A discrepancy is a finding, never automatic proof of a defect. Boundary and token checks are deterministic, " +
      "bounded heuristics over indexed evidence and a bounded source read; missing evidence is not evidence of absence. " +
      "No source was rewritten.",
  };
}

export default { checkContracts, FINDING_STATUSES };
