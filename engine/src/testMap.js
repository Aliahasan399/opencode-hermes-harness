// Phase 25 Capability E — deterministic, evidence-backed test-to-code mapping.
//
// Safety invariants (LEVEL 1, analysis only):
//   * Deterministic heuristics only; no AST parser, no LLM, no network, no spawn.
//   * A link is emitted ONLY from an explicit import/require (direct), an imported
//     module basename that matches a source file basename (indirect), or a test
//     name that mentions a symbol name (candidate). Co-location in the same
//     directory is NEVER treated as coverage.
//   * No coverage percentage is computed or invented. Absence of evidence yields
//     an explicit `unmapped` entry, never a fabricated score.
//   * Every mapping carries confidence, redacted evidence and a version hash of
//     the source (or test) content it was derived from.
//   * Project-scoped, bounded, idempotent persistence (ON CONFLICT DO NOTHING).
//     Database failures degrade gracefully; they never abort the request.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const LINK_RULES = freeze({
  version: "1.0.0",
  link_types: freeze({
    direct: freeze({ confidence: 0.9, method: "resolved import/require path" }),
    indirect: freeze({ confidence: 0.6, method: "imported module basename matches a source basename" }),
    candidate: freeze({ confidence: 0.3, method: "test name mentions a symbol name" }),
    unmapped: freeze({ confidence: 0, method: "no evidence-backed link" }),
  }),
  bounds: freeze({
    max_files: 2000,
    max_test_files: 400,
    max_depth: 10,
    max_file_bytes: 512 * 1024,
    max_total_bytes: 12 * 1024 * 1024,
    max_test_cases_per_file: 150,
    max_imports_per_file: 80,
    max_symbols_per_file: 120,
    max_mappings: 800,
    max_unmapped: 400,
    max_evidence: 5,
    max_name_len: 200,
    max_get_limit: 200,
  }),
  ignore_dirs: freeze([
    ".git", "node_modules", "checkpoints", "backups", "__pycache__", ".pytest_cache",
    "dist", "build", "coverage", ".cache", ".venv", "venv", "vendor",
  ]),
  code_ext: freeze([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py"]),
  rules: freeze([
    "A direct link requires an import/require specifier that resolves to a real project file.",
    "An indirect link requires an imported module basename matching a source basename; no directory co-location claim.",
    "A candidate link requires the test name to mention a symbol name; it is low confidence.",
    "No coverage percentage is computed or reported; unmapped tests are listed explicitly.",
    "All free text is redacted with core.redact and bounded before it is returned or stored.",
  ]),
});

const NOTE = "Evidence-backed test-to-code links from explicit imports and symbol-name mentions. " +
  "No coverage percentage is computed or claimed, and same-directory co-location is never coverage. " +
  "Symbol-key filters resolve through code_symbol where indexed; missing evidence is reported as unmapped.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validProject(p) {
  return typeof p === "string" && p.trim().length > 0 && p.trim() !== "_global";
}
function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function clip(v, n = 200) { return core.redact(String(v ?? "")).replace(/\s+/g, " ").slice(0, n); }
function hash(v) {
  return crypto.createHash("sha256").update(String(v ?? "")).digest("hex").slice(0, 24);
}
/** Deterministic file-level identity, distinct from symbol-level keys owned by sourceIndexer. */
function fileKey(project_id, sourcePath) { return hash(`${project_id}|file|${sourcePath}`); }
function clampLimit(limit, fallback, max) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
}
function emptyResult(note = NOTE) {
  return { ok: false, test_files: [], test_cases: 0, mappings: [], unmapped: [], errors: [], note };
}

function toPosix(p) { return String(p ?? "").replace(/\\/g, "/"); }
function normalizePath(p) {
  let s = toPosix(p).trim();
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------------------------------------------------------------------------
// Bounded discovery
// ---------------------------------------------------------------------------

function isIgnored(name) { return LINK_RULES.ignore_dirs.includes(String(name).toLowerCase()); }

function walk(rootAbs, errors) {
  const b = LINK_RULES.bounds;
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  const stack = [{ dir: rootAbs, depth: 0 }];
  while (stack.length && files.length < b.max_files) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { errors.push(`readdir ${clip(dir, 120)}: ${clip(e?.message || e, 120)}`); continue; }
    for (const ent of entries) {
      if (files.length >= b.max_files || totalBytes >= b.max_total_bytes) break;
      const name = String(ent.name);
      if (isIgnored(name)) continue;
      const abs = path.join(dir, name);
      if (ent.isSymbolicLink()) { skipped.push(name); continue; }
      if (ent.isDirectory()) {
        if (depth + 1 <= b.max_depth) stack.push({ dir: abs, depth: depth + 1 });
        else skipped.push(name);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!LINK_RULES.code_ext.includes(ext)) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      if (size > b.max_file_bytes) { skipped.push(name); continue; }
      const rel = toPosix(path.relative(rootAbs, abs));
      // Traversal guard: resolved path must stay under root.
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (totalBytes + size > b.max_total_bytes) { skipped.push(name); continue; }
      totalBytes += size;
      files.push({ path: rel, abs, ext, size });
    }
  }
  return { files, skipped };
}

function isTestFile(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  const segments = toPosix(rel).toLowerCase().split("/");
  const inTestDir = segments.slice(0, -1).some((s) => s === "test" || s === "tests" || s === "__tests__");
  const byName = /\.(test|spec)\.(js|mjs|cjs|jsx|ts|tsx)$/.test(base)
    || /^test_.+\.py$/.test(base) || /^.+_test\.py$/.test(base);
  return inTestDir || byName;
}

function readFile(abs, errors) {
  try { return fs.readFileSync(abs, "utf8").slice(0, LINK_RULES.bounds.max_file_bytes); }
  catch (e) { errors.push(`read ${clip(abs, 120)}: ${clip(e?.message || e, 120)}`); return ""; }
}

// ---------------------------------------------------------------------------
// Extraction (deterministic, line/token based)
// ---------------------------------------------------------------------------

/** Extract node:test / pytest names with their source line. */
function extractTestCases(content, ext) {
  const out = [];
  const max = LINK_RULES.bounds.max_test_cases_per_file;
  if (ext === ".py") {
    const re = /(?:^\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm;
    let m;
    while ((m = re.exec(content)) && out.length < max) {
      const before = content.slice(0, m.index);
      out.push({ test_name: m[1].slice(0, LINK_RULES.bounds.max_name_len), line: before.split("\n").length });
    }
    return out;
  }
  const re = /\b(test|it|describe)\s*\(\s*(['"`])([^'"`\n]{1,200})\2/g;
  let m;
  while ((m = re.exec(content)) && out.length < max) {
    const before = content.slice(0, m.index);
    out.push({ test_name: m[3].slice(0, LINK_RULES.bounds.max_name_len), line: before.split("\n").length });
  }
  return out;
}

/** Extract import/require specifiers with line + the raw statement excerpt. */
function extractImports(content, ext) {
  const out = [];
  const max = LINK_RULES.bounds.max_imports_per_file;
  const add = (spec, line, excerpt) => {
    if (out.length < max && nonEmptyString(spec)) out.push({ spec: spec.trim(), line, excerpt });
  };
  const lines = content.split("\n");
  if (ext === ".py") {
    let m;
    const re = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
    while ((m = re.exec(content)) && out.length < max) {
      const before = content.slice(0, m.index);
      add(m[1] || m[2], before.split("\n").length, lines[before.split("\n").length - 1] || "");
    }
    return out;
  }
  const patterns = [
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bfrom\s+(['"])([^'"]+)\1/g,
    /\bimport\s+(?:[\s\S]{0,160}?\bfrom\s+)?(['"])([^'"]+)\1/g,
    /^\s*import\s+(['"])([^'"]+)\1/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) && out.length < max) {
      const before = content.slice(0, m.index);
      const line = before.split("\n").length;
      add(m[2], line, lines[line - 1] || "");
    }
  }
  return out;
}

/** Source symbol names used only for naming-heuristic candidate links. */
function extractSymbolNames(content, ext) {
  const names = new Set();
  const patterns = ext === ".py"
    ? [/\bdef\s+([A-Za-z_][\w]{2,})\s*\(/g, /\bclass\s+([A-Za-z_][\w]{2,})/g]
    : [
        /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]{2,})/g,
        /\bclass\s+([A-Za-z_$][\w$]{2,})/g,
        /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]{2,})\s*=/g,
        /\b(?:export\s+)?let\s+([A-Za-z_$][\w$]{2,})\s*=/g,
      ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) && names.size < LINK_RULES.bounds.max_symbols_per_file) {
      names.add(m[1].slice(0, 80));
    }
  }
  return [...names];
}

/** Resolve a relative import specifier to a project file (with extension fallbacks). */
function resolveImport(spec, testRel, ext, fileSet) {
  const dir = path.posix.dirname(testRel);
  let base;
  if (spec.startsWith(".")) {
    base = path.posix.normalize(path.posix.join(dir, spec));
  } else if (ext === ".py") {
    base = spec.replace(/\./g, "/");
  } else {
    return null; // bare package import: not a direct project-file link
  }
  if (!base || base.startsWith("..")) return null;
  const candidates = [base];
  const exts = ext === ".py" ? [".py"] : [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"];
  for (const e of exts) if (!base.endsWith(e)) candidates.push(`${base}${e}`);
  for (const e of exts) candidates.push(path.posix.join(base, `index${e}`));
  for (const c of candidates) {
    const norm = path.posix.normalize(c);
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

function importBasename(spec) {
  const clean = spec.replace(/^@[^/]+\//, "");
  const parts = String(clean).replace(/\\/g, "/").split("/").filter(Boolean);
  let base = parts[parts.length - 1] || "";
  base = base.replace(/\.(js|mjs|cjs|jsx|ts|tsx|py)$/i, "");
  return base.length >= 2 ? base.toLowerCase() : "";
}

function nameMentions(testName, symbolName) {
  const n = String(testName).toLowerCase();
  const s = String(symbolName).toLowerCase();
  if (s.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9_$])${escapeRe(s)}([^a-z0-9_$]|$)`).test(n);
}

// ---------------------------------------------------------------------------
// buildTestMap
// ---------------------------------------------------------------------------

/**
 * Discover bounded test files under `root`, extract test names and emit
 * evidence-backed test-to-source mappings, then persist them idempotently.
 */
export async function buildTestMap({ project_id, root } = {}) {
  const result = emptyResult();
  if (!validProject(project_id)) { result.reason = "a valid project_id is required"; return result; }
  if (!nonEmptyString(root)) { result.reason = "a valid root directory is required"; return result; }
  const pid = project_id.trim().slice(0, 200);
  let rootAbs;
  try { rootAbs = path.resolve(root); }
  catch { result.reason = "invalid root path"; return result; }
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    result.reason = "root must be an existing directory"; return result;
  }

  const b = LINK_RULES.bounds;
  const { files, skipped } = walk(rootAbs, result.errors);
  const allByRel = new Map(files.map((f) => [f.path, f]));
  const fileSet = new Set(files.map((f) => f.path));
  const testFiles = files.filter((f) => isTestFile(f.path)).slice(0, b.max_test_files);
  const sourceFiles = files.filter((f) => !isTestFile(f.path));

  // Precompute content hashes + symbol names for candidate links (bounded).
  const sourceHash = new Map();
  const symbolToPaths = new Map();
  const basenameToPaths = new Map();
  for (const f of sourceFiles) {
    const content = readFile(f.abs, result.errors);
    sourceHash.set(f.path, hash(content));
    const base = path.posix.basename(f.path).replace(/\.[^.]+$/, "").toLowerCase();
    if (base.length >= 2) {
      if (!basenameToPaths.has(base)) basenameToPaths.set(base, []);
      basenameToPaths.get(base).push(f.path);
    }
    for (const sym of extractSymbolNames(content, f.ext)) {
      const k = sym.toLowerCase();
      if (!symbolToPaths.has(k)) symbolToPaths.set(k, []);
      if (symbolToPaths.get(k).length < 20) symbolToPaths.get(k).push(f.path);
    }
  }

  const mappings = [];
  const unmapped = [];
  const seen = new Map(); // dedupe by (test_path,test_name,source_key,version_hash)

  const addMapping = (m) => {
    if (mappings.length >= b.max_mappings) return;
    const key = `${m.test_path}\u0000${m.test_name}\u0000${m.source_key}\u0000${m.version_hash}`;
    const prev = seen.get(key);
    if (prev && prev.confidence >= m.confidence) return;
    if (prev) mappings[mappings.indexOf(prev)] = m;
    else mappings.push(m);
    seen.set(key, m);
  };

  for (const tf of testFiles) {
    const content = readFile(tf.abs, result.errors);
    const testHash = hash(content);
    const cases = extractTestCases(content, tf.ext);
    const imports = extractImports(content, tf.ext);

    // Resolve imports once per test file.
    const directTargets = [];
    const indirectTargets = [];
    for (const imp of imports) {
      const resolved = resolveImport(imp.spec, tf.path, tf.ext, fileSet);
      if (resolved && !isTestFile(resolved)) {
        directTargets.push({ source_path: resolved, imp });
      } else {
        const base = importBasename(imp.spec);
        if (base && basenameToPaths.has(base)) {
          for (const sp of basenameToPaths.get(base).slice(0, 8)) {
            if (sp !== tf.path) indirectTargets.push({ source_path: sp, imp, base });
          }
        }
      }
    }

    for (const tc of cases) {
      const made = [];
      const ev = (kind, excerpt) => ({ kind, excerpt: clip(excerpt, 200) });

      for (const d of directTargets) {
        const sourceHashValue = sourceHash.get(d.source_path) || hash(d.source_path);
        made.push({
          test_path: tf.path, test_name: clip(tc.test_name, b.max_name_len),
          source_path: d.source_path, source_key: fileKey(pid, d.source_path),
          link_type: "direct", confidence: LINK_RULES.link_types.direct.confidence,
          evidence: [ev("import", d.imp.excerpt || d.imp.spec), ev("resolved", d.source_path)].slice(0, b.max_evidence),
          version_hash: sourceHashValue,
        });
      }
      for (const i of indirectTargets) {
        const sourceHashValue = sourceHash.get(i.source_path) || hash(i.source_path);
        made.push({
          test_path: tf.path, test_name: clip(tc.test_name, b.max_name_len),
          source_path: i.source_path, source_key: fileKey(pid, i.source_path),
          link_type: "indirect", confidence: LINK_RULES.link_types.indirect.confidence,
          evidence: [ev("import_basename", `${i.imp.excerpt || i.imp.spec} -> basename '${i.base}'`)].slice(0, b.max_evidence),
          version_hash: sourceHashValue,
        });
      }
      // Candidate: only when no stronger link exists for this test case.
      if (made.length === 0) {
        const tokens = String(tc.test_name).toLowerCase().match(/[a-z0-9_$]{3,}/g) || [];
        const seenSrc = new Set();
        for (const token of tokens) {
          const paths = symbolToPaths.get(token) || [];
          for (const sp of paths.slice(0, 5)) {
            if (seenSrc.has(sp)) continue;
            seenSrc.add(sp);
            made.push({
              test_path: tf.path, test_name: clip(tc.test_name, b.max_name_len),
              source_path: sp, source_key: fileKey(pid, sp),
              link_type: "candidate", confidence: LINK_RULES.link_types.candidate.confidence,
              evidence: [ev("name_mention", `test name '${tc.test_name}' mentions symbol '${token}' in ${sp}`)].slice(0, b.max_evidence),
              version_hash: sourceHash.get(sp) || hash(sp),
            });
          }
        }
      }

      if (made.length === 0) {
        if (unmapped.length < b.max_unmapped) {
          unmapped.push({
            test_path: tf.path, test_name: clip(tc.test_name, b.max_name_len),
            line: tc.line, reason: "no import or symbol-name link found", version_hash: testHash, evidence: [],
          });
        }
      } else {
        for (const m of made) addMapping(m);
      }
    }
  }

  mappings.sort((a, c) => c.confidence - a.confidence || a.test_path.localeCompare(c.test_path));

  // Idempotent, bounded persistence. DB errors degrade; they never abort.
  try {
    await core.withDb(async (client) => {
      for (const m of mappings) {
        await client.query(
          `INSERT INTO code_test_map
             (project_id, test_path, test_name, source_path, source_key,
              link_type, confidence, evidence, version_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
           ON CONFLICT DO NOTHING`,
          [pid, m.test_path, m.test_name, m.source_path, m.source_key,
            m.link_type, m.confidence, JSON.stringify(m.evidence), m.version_hash],
        );
      }
    });
  } catch (e) {
    result.errors.push(`persist code_test_map: ${clip(e?.message || e, 160)}`);
  }
  try {
    await core.audit("p25.testmap_build", pid, {
      test_files: testFiles.length, mappings: mappings.length, unmapped: unmapped.length,
    });
  } catch { /* best effort */ }

  result.ok = true;
  result.project_id = pid;
  result.test_files = testFiles.map((f) => f.path);
  result.test_cases = testFiles.reduce((n, tf) => n + extractTestCases(readFile(tf.abs, result.errors), tf.ext).length, 0);
  result.mappings = mappings;
  result.unmapped = unmapped;
  result.skipped = skipped.length;
  return result;
}

// ---------------------------------------------------------------------------
// getTestsFor
// ---------------------------------------------------------------------------

/** Bounded, project-scoped retrieval of test mappings by source path and/or symbol. */
export async function getTestsFor({ project_id, path: sourcePath, symbol_key, limit, root } = {}) {
  const out = { ok: false, items: [], note: NOTE };
  if (!validProject(project_id)) { out.reason = "a valid project_id is required"; return out; }
  const pid = project_id.trim().slice(0, 200);
  const n = clampLimit(limit, 50, LINK_RULES.bounds.max_get_limit);
  const clauses = ["project_id=$1"];
  const params = [pid];

  const pathFilter = nonEmptyString(sourcePath) ? normalizePath(sourcePath) : "";
  const pathCandidates = [];
  if (pathFilter) pathCandidates.push(pathFilter);
  // The indexer stores absolute paths while testMap stores repo-relative paths.
  // When a root is supplied, also match the relative form so the two modules bridge.
  if (pathFilter && nonEmptyString(root)) {
    try {
      const rel = normalizePath(path.relative(path.resolve(String(root)), path.resolve(pathFilter)));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !pathCandidates.includes(rel)) {
        pathCandidates.push(rel);
      }
    } catch { /* keep the original candidate only */ }
  }
  if (pathCandidates.length) {
    const ors = [];
    for (const cand of pathCandidates) {
      params.push(cand, fileKey(pid, cand));
      ors.push(`source_path=$${params.length - 1}`, `source_key=$${params.length}`);
    }
    clauses.push(`(${ors.join(" OR ")})`);
  }

  const degraded = [];
  if (nonEmptyString(symbol_key)) {
    const key = String(symbol_key).slice(0, 120);
    let symFiles = [];
    try {
      const r = await core.dbQuery(
        "SELECT DISTINCT file_path FROM code_symbol WHERE project_id=$1 AND symbol_key=$2 LIMIT 5",
        [pid, key],
      );
      symFiles = (r.rows || []).map((row) => normalizePath(row.file_path)).filter(Boolean);
    } catch (e) {
      degraded.push(`symbol lookup: ${clip(e?.message || e, 120)}`);
    }
    // Match the symbol key itself and any indexed symbol's file (exact path or
    // file-level key). All options are OR'd inside a single grouped clause.
    const symVals = [key];
    for (const f of symFiles) symVals.push(f, fileKey(pid, f));
    const ors = [];
    for (const v of symVals) {
      params.push(v);
      ors.push(`source_key=$${params.length}`);
      if (symFiles.includes(v)) ors.push(`source_path=$${params.length}`);
    }
    clauses.push(`(${ors.join(" OR ")})`);
  }

  params.push(n);
  const sql = `SELECT test_path, test_name, source_path, source_key, link_type, confidence, evidence, version_hash
                 FROM code_test_map
                WHERE ${clauses.join(" AND ")}
                ORDER BY confidence DESC, created_at DESC, id DESC
                LIMIT $${params.length}`;
  try {
    const r = await core.dbQuery(sql, params);
    out.items = (r.rows || []).map((row) => ({
      test_path: row.test_path,
      test_name: row.test_name,
      source_path: row.source_path,
      source_key: row.source_key,
      link_type: row.link_type,
      confidence: Number(row.confidence) || 0,
      evidence: Array.isArray(row.evidence) ? row.evidence.slice(0, LINK_RULES.bounds.max_evidence) : [],
      version_hash: row.version_hash,
    }));
    out.ok = true;
  } catch (e) {
    out.ok = true;
    out.items = [];
    degraded.push(`query code_test_map: ${clip(e?.message || e, 120)}`);
  }
  out.limit = n;
  if (degraded.length) out.degraded = degraded;
  return out;
}

export default { LINK_RULES, buildTestMap, getTestsFor };
