// Phase 25 Capability A — bounded, deterministic source discovery & symbol extraction.
// EVIDENCE PRODUCER ONLY. LEVEL 1: no source rewrite, no spawn, no git, no secret
// exposure, no cross-project leakage, no parser installation and no new dependency.
// All filesystem reads are bounded; evidence is redacted line excerpts (never source
// bodies). Every capability is fail-closed, project-scoped, best-effort audited and
// takes a single options object with `= {}` defaults.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";
const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.floor(n), hi)) : d;
};
const sha = (v) => crypto.createHash("sha256").update(String(v ?? "")).digest("hex");
const shaBytes = (b) => crypto.createHash("sha256").update(b).digest("hex");
const confidence = (c) => Math.max(0, Math.min(1, Number(c) || 0));
const redactExcerpt = (line) => core.redact(String(line ?? "").replace(/\s+/g, " ").slice(0, 200));

const LANG_BY_EXT = Object.freeze({
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".sql": "sql", ".py": "python",
});
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "checkpoints", "backups", "__pycache__", ".pytest_cache", "generated",
]);
const IGNORE_FILE_RE = /(?:\.py[co]$|\.min\.(?:js|mjs|cjs|css)$|\.generated\.|\.bundle\.(?:js|mjs|cjs)$|\.map$)/i;
const JS_RESERVED = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "try", "finally",
  "function", "return", "throw", "typeof", "instanceof", "new", "delete", "void",
  "with", "yield", "await", "super", "this", "class", "import", "export", "default",
]);

async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); } catch { /* best effort */ }
}

/** Resolve containment by prefix (root itself allowed); prevents ../ traversal. */
function underRoot(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/** Read at most maxBytes+1 bytes; a larger file is rejected before being buffered. */
function readBounded(abs, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_a_file" };
    if (st.size > maxBytes) return { ok: false, reason: "too_large", size: st.size };
    const buf = Buffer.allocUnsafe(Math.max(0, st.size));
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, Math.min(st.size - read, 65536), null);
      if (!n) break;
      read += n;
    }
    return { ok: true, size: read, content: buf.subarray(0, read) };
  } catch (e) {
    return { ok: false, reason: short(e?.message || e, 120) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function evidenceFor(lines, start, count = 2) {
  const out = [];
  for (let k = start; k < Math.min(lines.length, start + count) && out.length < count; k++) {
    const t = lines[k].trim();
    if (t) out.push(redactExcerpt(t));
  }
  return out;
}

/** Brace matcher that skips strings and comments; returns 1-based closing line or -1. */
function braceEnd(lines, startIdx, window) {
  let depth = 0, seen = false, quote = null, block = false, lineComment = false;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + window); i++) {
    const line = lines[i];
    lineComment = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j], n = line[j + 1];
      if (lineComment) break;
      if (block) { if (c === "*" && n === "/") { block = false; j++; } continue; }
      if (quote) {
        if (c === "\\") { j++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "/" && n === "/") { lineComment = true; break; }
      if (c === "/" && n === "*") { block = true; j++; continue; }
      if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
      if (c === "{") { depth++; seen = true; }
      else if (c === "}") { depth--; if (seen && depth <= 0) return i + 1; }
    }
  }
  return -1;
}

function makeSymbol({ project_id, filePath, type, name, parent, start, end, isExport, language,
  scope, visibility, confidence: conf, excerpts }) {
  const key = sha(`${project_id}|${filePath}|${type}|${name}|${parent || ""}|${start}`);
  return {
    symbol_key: key.slice(0, 24),
    name: String(name),
    symbol_type: type,
    scope,
    visibility,
    start_line: start,
    end_line: end,
    parent_key: parent || "",
    is_export: !!isExport,
    language,
    extraction_method: "heuristic",
    confidence: confidence(conf),
    evidence: (Array.isArray(excerpts) ? excerpts : []).slice(0, 3).map(redactExcerpt),
  };
}

// ---------------------------------------------------------------------------
// 1. discoverFiles — bounded, symlink-safe, project-contained file inventory.
// ---------------------------------------------------------------------------
export async function discoverFiles({ project_id, root, options = {} } = {}) {
  const empty = { ok: false, files: [], skipped: 0, errors: [], limits: {}, note: "" };
  if (!validProject(project_id)) return { ...empty, reason: "valid project_id required" };
  if (typeof root !== "string" || !root.trim()) return { ...empty, reason: "root must be a directory path" };

  const rootAbs = path.resolve(root);
  let rootStat;
  try { rootStat = fs.statSync(rootAbs); }
  catch (e) { return { ...empty, reason: `root unreadable: ${short(e?.message || e, 100)}` }; }
  if (!rootStat.isDirectory()) return { ...empty, reason: "root is not a directory" };

  const opt = options && typeof options === "object" ? options : {};
  const limits = {
    maxFiles: clamp(opt.maxFiles, 1, 3000, 3000),
    maxBytes: clamp(opt.maxBytes, 16, 256 * 1024, 256 * 1024),
    maxDepth: clamp(opt.maxDepth, 1, 12, 12),
  };
  const files = [], errors = [];
  const skipReasons = { ignore: 0, symlink: 0, size: 0, depth: 0, unreadable: 0 };
  let skipped = 0, truncated = false;
  const stack = [{ dir: rootAbs, depth: 0 }];

  while (stack.length && !truncated) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      skipped++; skipReasons.unreadable++;
      if (errors.length < 50) errors.push(short(e?.message || e, 160));
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= limits.maxFiles) { truncated = true; break; }
      // Symlinks are never followed (directory or file); record a skip instead.
      if (ent.isSymbolicLink()) { skipped++; skipReasons.symlink++; continue; }
      const abs = path.resolve(dir, ent.name);
      if (!underRoot(rootAbs, abs)) { skipped++; skipReasons.ignore++; continue; }

      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith(".")) {
          skipped++; skipReasons.ignore++; continue;
        }
        if (depth + 1 > limits.maxDepth) { skipped++; skipReasons.depth++; continue; }
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) { skipped++; skipReasons.ignore++; continue; }
      if (IGNORE_FILE_RE.test(ent.name)) { skipped++; skipReasons.ignore++; continue; }
      if (depth + 1 > limits.maxDepth) { skipped++; skipReasons.depth++; continue; }

      const read = readBounded(abs, limits.maxBytes);
      if (!read.ok) {
        skipped++;
        if (read.reason === "too_large") skipReasons.size++;
        else { skipReasons.unreadable++; if (errors.length < 50) errors.push(`${ent.name}: ${read.reason}`); }
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      files.push({
        path: path.relative(rootAbs, abs).split(path.sep).join("/"),
        abs,
        ext,
        language: LANG_BY_EXT[ext] || "unknown",
        size: read.size,
        hash: shaBytes(read.content),
      });
      if (files.length >= limits.maxFiles) { truncated = true; break; }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true, files, skipped, errors: errors.slice(0, 50), limits, truncated,
    skip_reasons: skipReasons,
    note: `Discovered ${files.length} bounded file(s) under ${rootAbs}; limits=${JSON.stringify(limits)}.`,
  };
}

// ---------------------------------------------------------------------------
// 2a. JS/TS heuristic extraction (bounded regex + brace matching).
// ---------------------------------------------------------------------------
function extractJs({ project_id, filePath, source, language }) {
  const MAX_LINES = 4000, MAX_SYMBOLS = 500, WINDOW = MAX_LINES;
  const symbols = [], unsupported = [], seen = new Set(), handled = new Set(), classStack = [];
  const allLines = source.split(/\r?\n/);
  if (allLines.length > MAX_LINES) {
    unsupported.push(`line_cap:${MAX_LINES}`);
    allLines.length = MAX_LINES;
  }
  const lines = allLines;
  let capped = false;
  const add = (sym) => {
    if (symbols.length >= MAX_SYMBOLS) {
      if (!capped) { unsupported.push(`symbol_cap:${MAX_SYMBOLS}`); capped = true; }
      return;
    }
    if (!seen.has(sym.symbol_key)) { seen.add(sym.symbol_key); symbols.push(sym); }
  };
  const base = (type, name, start, end, isExport, scope, vis, conf, excerpts, parent = "") =>
    makeSymbol({ project_id, filePath, type, name, parent, start, end, isExport, language,
      scope, visibility: vis, confidence: conf, excerpts });

  for (let i = 0; i < lines.length; i++) {
    if (handled.has(i)) continue;
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    while (classStack.length && classStack[classStack.length - 1].end < i + 1) classStack.pop();
    const parentClass = classStack.length ? classStack[classStack.length - 1] : null;

    // class declaration
    const cm = t.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (cm) {
      const isExport = /^export\b/.test(t);
      const end = braceEnd(lines, i, WINDOW);
      if (end < 0) unsupported.push("unbalanced_braces");
      const sym = base("class", cm[1], i + 1, end < 0 ? i + 1 : end, isExport,
        "module", isExport ? "public" : "internal", 0.9, evidenceFor(lines, i));
      add(sym);
      classStack.push({ key: sym.symbol_key, end: end < 0 ? i + 1 : end });
      handled.add(i);
      continue;
    }

    // function declaration (named), including `export default function name`
    const fm = t.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (fm) {
      const isExport = /^export\b/.test(t);
      const end = braceEnd(lines, i, WINDOW);
      if (end < 0) unsupported.push("unbalanced_braces");
      add(base("function", fm[1], i + 1, end < 0 ? i + 1 : end, isExport,
        "module", isExport ? "public" : "internal", 0.9, evidenceFor(lines, i)));
      handled.add(i);
      continue;
    }
    // anonymous `export default function (` / `function (`
    if (/^(?:export\s+default\s+)?function\s*\(/.test(t)) {
      const isExport = /^export\b/.test(t);
      const end = braceEnd(lines, i, WINDOW);
      unsupported.push("anonymous_function_declaration");
      add(base("function", "default", i + 1, end < 0 ? i + 1 : end, isExport,
        "module", "public", 0.55, evidenceFor(lines, i)));
      handled.add(i);
      continue;
    }

    // method definition (optionally typed/modified), attached to the enclosing class
    const mm = t.match(/^\s*(?:(public|private|protected|static|async|get|set|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::[^{]+)?\{/);
    if (mm && !JS_RESERVED.has(mm[2])) {
      const mods = mm[1] || "";
      const vis = /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : "public";
      const end = braceEnd(lines, i, WINDOW);
      if (end < 0) unsupported.push("unbalanced_braces");
      const conf = parentClass ? 0.75 : 0.45;
      if (!parentClass) unsupported.push("orphan_method");
      add(base("method", mm[2], i + 1, end < 0 ? i + 1 : end, false,
        parentClass ? "class" : "module", vis, conf, evidenceFor(lines, i), parentClass ? parentClass.key : ""));
      handled.add(i);
      continue;
    }

    // static/type imports and require() calls
    if (/^import\b/.test(t) && !/^import\s*\(/.test(t)) {
      let block = lines[i], j = i;
      while (!/[;'"]/.test(block) && j + 1 < lines.length && j - i < 20) {
        j++; block += "\n" + lines[j];
      }
      const fm2 = block.match(/\bfrom\s*["']([^"']+)["']/);
      const sm = !fm2 ? block.match(/^import\s*["']([^"']+)["']/) : null;
      const spec = (fm2 && fm2[1]) || (sm && sm[1]) || "unknown";
      add(base("import", spec, i + 1, j + 1, false, "module", "internal",
        spec === "unknown" ? 0.5 : 0.85, [redactExcerpt(lines[i])]));
      for (let k = i; k <= j; k++) handled.add(k);
      continue;
    }
    const dyn = t.match(/import\s*\(\s*["']([^"']+)["']/);
    if (dyn) {
      add(base("import", dyn[1], i + 1, i + 1, false, "module", "internal", 0.7,
        [redactExcerpt(t)]));
      unsupported.push("dynamic_import");
      handled.add(i);
      continue;
    }
    if (/import\s*\(/.test(t)) { unsupported.push("dynamic_import_expression"); }
    const req = t.match(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/);
    if (req) {
      add(base("import", req[1], i + 1, i + 1, false, "module", "internal", 0.8,
        [redactExcerpt(t)]));
    }

    // arrow function assignment
    const am = t.match(/^\s*(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (am) {
      const isExport = /^export\b/.test(t);
      const bi = t.indexOf("=>");
      const hasBlock = t.slice(bi).includes("{");
      const end = hasBlock ? braceEnd(lines, i, WINDOW) : i + 1;
      if (hasBlock && end < 0) unsupported.push("unbalanced_braces");
      add(base("arrow", am[2], i + 1, end < 0 ? i + 1 : end, isExport,
        "module", isExport ? "public" : "internal", 0.8, evidenceFor(lines, i)));
      handled.add(i);
      continue;
    }

    // top-level const/let (non-arrow)
    const dm = t.match(/^\s*(?:export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (dm) {
      const isExport = /^export\b/.test(t);
      add(base(dm[1] === "const" ? "constant" : "variable", dm[2], i + 1, i + 1, isExport,
        "module", isExport ? "public" : "internal", isExport ? 0.75 : 0.7,
        evidenceFor(lines, i)));
      handled.add(i);
      continue;
    }
    if (/^\s*(?:export\s+)?(?:const|let)\s*[{[]/.test(t)) unsupported.push("destructuring_declaration");

    // named / star / default exports not already represented by a declaration
    const em = t.match(/^export\s*\{([^}]*)\}/);
    if (em) {
      for (const part of em[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) add(base("export", name, i + 1, i + 1, true, "module", "public", 0.85,
          [redactExcerpt(t)]));
      }
      handled.add(i);
      continue;
    }
    const star = t.match(/^export\s+\*\s+from\s*["']([^"']+)["']/);
    if (star) {
      add(base("export", star[1], i + 1, i + 1, true, "module", "public", 0.8,
        [redactExcerpt(t)]));
      handled.add(i);
      continue;
    }
    if (/^export\s+default\s+(?!function\b|class\b)/.test(t)) {
      add(base("export", "default", i + 1, i + 1, true, "module", "public", 0.6,
        [redactExcerpt(t)]));
      handled.add(i);
      continue;
    }
    if (/^export\b/.test(t)) unsupported.push("unhandled_export");
  }

  return { symbols, unsupported: [...new Set(unsupported)].slice(0, 50) };
}

// ---------------------------------------------------------------------------
// 2b. SQL / Python heuristic extraction.
// ---------------------------------------------------------------------------
function statementEnd(lines, startIdx) {
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 12); i++) {
    if (lines[i].includes(";")) return i + 1;
  }
  return startIdx + 1;
}

function extractSql({ project_id, filePath, source, language }) {
  const MAX_LINES = 4000;
  const symbols = [], unsupported = [], seen = new Set();
  const lines = source.split(/\r?\n/).slice(0, MAX_LINES);
  const add = (type, name, start, end, excerpts) => {
    const sym = makeSymbol({ project_id, filePath, type, name, parent: "", start, end,
      isExport: false, language, scope: "schema", visibility: "public", confidence: 0.9,
      excerpts });
    if (!seen.has(sym.symbol_key)) { seen.add(sym.symbol_key); symbols.push(sym); }
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const tbl = t.match(/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?[\w-]+["'`]?\.)?["'`]?([\w-]+)["'`]?/i);
    if (tbl) { add("table", tbl[1], i + 1, statementEnd(lines, i), [redactExcerpt(t)]); continue; }
    const idx = t.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?[\w-]+["'`]?\.)?["'`]?([\w-]+)["'`]?\s+ON\b/i);
    if (idx) { add("index", idx[1], i + 1, statementEnd(lines, i), [redactExcerpt(t)]); continue; }
    if (/^CREATE\b/i.test(t) && !/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(t)) {
      unsupported.push("unhandled_create_statement");
    }
  }
  return { symbols, unsupported: [...new Set(unsupported)].slice(0, 50) };
}

function pyBlockEnd(lines, startIdx, indent) {
  let end = startIdx + 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ind = (lines[i].match(/^\s*/) || [""])[0].length;
    if (ind <= indent) break;
    end = i + 1;
  }
  return end;
}

function extractPython({ project_id, filePath, source, language }) {
  const MAX_LINES = 4000;
  const symbols = [], unsupported = [], seen = new Set(), classStack = [];
  const lines = source.split(/\r?\n/).slice(0, MAX_LINES);
  const add = (sym) => { if (!seen.has(sym.symbol_key)) { seen.add(sym.symbol_key); symbols.push(sym); } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = (raw.match(/^\s*/) || [""])[0].length;
    const t = raw.trim();
    if (!t) continue;
    while (classStack.length && indent <= classStack[classStack.length - 1].indent) classStack.pop();
    const parent = classStack.length ? classStack[classStack.length - 1] : null;
    const cm = t.match(/^class\s+([A-Za-z_]\w*)\s*[\(:]/);
    if (cm) {
      const sym = makeSymbol({ project_id, filePath, type: "class", name: cm[1],
        parent: parent ? parent.key : "", start: i + 1, end: pyBlockEnd(lines, i, indent),
        isExport: false, language, scope: parent ? "class" : "module", visibility: "public",
        confidence: 0.9, excerpts: [redactExcerpt(t)] });
      add(sym);
      classStack.push({ key: sym.symbol_key, indent });
      continue;
    }
    const dm = t.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (dm) {
      const name = dm[1];
      const vis = name.startsWith("__") ? "private" : name.startsWith("_") ? "protected" : "public";
      add(makeSymbol({ project_id, filePath, type: parent ? "method" : "function", name,
        parent: parent ? parent.key : "", start: i + 1, end: pyBlockEnd(lines, i, indent),
        isExport: false, language, scope: parent ? "class" : "module", visibility: vis,
        confidence: parent ? 0.85 : 0.9, excerpts: [redactExcerpt(t)] }));
      continue;
    }
    if (/^@/.test(t)) unsupported.push("decorator");
    if (/^\s*(?:from|import)\s/.test(t)) unsupported.push("python_import");
  }
  return { symbols, unsupported: [...new Set(unsupported)].slice(0, 50) };
}

// ---------------------------------------------------------------------------
// 3. extractSymbols — language dispatch; never stores source bodies.
// ---------------------------------------------------------------------------
export async function extractSymbols({ project_id, root, path: filePath, source, language } = {}) {
  const empty = { ok: false, symbols: [], unsupported: [], errors: [], note: "" };
  if (!validProject(project_id)) return { ...empty, reason: "valid project_id required" };
  if (typeof filePath !== "string" || !filePath.trim()) return { ...empty, reason: "path required" };

  let text = source;
  if (typeof text !== "string") {
    if (typeof root !== "string" || !underRoot(root, path.resolve(root, filePath))) {
      return { ...empty, reason: "source required or path escapes root" };
    }
    const read = readBounded(path.resolve(root, filePath), 256 * 1024);
    if (!read.ok) return { ...empty, reason: `source read failed: ${read.reason}` };
    text = read.content.toString("utf8");
  }
  let lang = String(language || "").toLowerCase();
  if (!["javascript", "typescript", "sql", "python"].includes(lang)) {
    lang = LANG_BY_EXT[path.extname(filePath).toLowerCase()] || "unknown";
  }
  const args = { project_id, filePath: filePath.split(path.sep).join("/"), source: text, language: lang };
  let extracted = { symbols: [], unsupported: [] }, errors = [];
  try {
    if (lang === "javascript" || lang === "typescript") extracted = extractJs(args);
    else if (lang === "sql") extracted = extractSql(args);
    else if (lang === "python") extracted = extractPython(args);
    else extracted = { symbols: [], unsupported: [`unsupported_language:${lang}`] };
  } catch (e) {
    errors.push(short(e?.message || e, 160));
  }
  const symbols = (extracted.symbols || []).slice(0, 500);
  return {
    ok: true, symbols,
    unsupported: (extracted.unsupported || []).slice(0, 50),
    errors: errors.slice(0, 50),
    note: `Extracted ${symbols.length} heuristic symbol(s) from ${filePath} (${lang}); source bodies were not stored.`,
  };
}

// ---------------------------------------------------------------------------
// 4. indexProject — bounded incremental index with versioned, additive writes.
// ---------------------------------------------------------------------------
export async function indexProject({ project_id, root, options = {} } = {}) {
  const base = { ok: false, run_id: null, status: "failed", files_seen: 0, files_indexed: 0,
    files_skipped: 0, files_failed: 0, symbols_extracted: 0, errors: [], version_hash: "", note: "" };
  if (!validProject(project_id)) return { ...base, note: "valid project_id required" };
  if (typeof root !== "string" || !root.trim()) return { ...base, note: "root required" };
  const rootAbs = path.resolve(root);
  const run_id = crypto.randomUUID();
  const errors = [];

  try {
    await core.dbQuery(
      `INSERT INTO code_index_state (id,project_id,root_path,status) VALUES ($1,$2,$3,'running')`,
      [run_id, project_id, rootAbs]);
  } catch (e) {
    return { ...base, run_id, errors: [short(e?.message || e, 180)], note: "index ledger unavailable (DB down)" };
  }

  let discover;
  try { discover = await discoverFiles({ project_id, root: rootAbs, options }); }
  catch (e) { discover = { ok: false, files: [], errors: [short(e?.message || e, 160)], skip_reasons: {} }; }

  const finish = async (status, counts, version_hash, noteExtra) => {
    const errorText = short(errors.join(" | "), 600) || null;
    try {
      await core.dbQuery(
        `UPDATE code_index_state SET status=$1,files_seen=$2,files_indexed=$3,files_skipped=$4,
          files_failed=$5,symbols_extracted=$6,version_hash=$7,error=$8,finished_at=now()
         WHERE id=$9 AND project_id=$10`,
        [status, counts.files_seen, counts.files_indexed, counts.files_skipped, counts.files_failed,
          counts.symbols_extracted, version_hash, errorText, run_id, project_id]);
    } catch (e) { errors.push(short(e?.message || e, 140)); }
    await audit("p25.index", project_id, { run_id, status, files_indexed: counts.files_indexed,
      symbols_extracted: counts.symbols_extracted });
    return {
      ok: status !== "failed", run_id, status, ...counts,
      errors: errors.slice(0, 50), version_hash,
      note: `run ${run_id} ${status}. ${noteExtra || ""} Analysis only; no source was rewritten.`,
    };
  };

  if (!discover?.ok) {
    errors.push(discover?.reason || "discovery failed");
    return finish("failed", { files_seen: 0, files_indexed: 0, files_skipped: 0, files_failed: 0,
      symbols_extracted: 0 }, "", "Discovery failed before indexing.");
  }

  const files = (discover.files || []).slice(0, 3000);
  const version_hash = sha(files.map((f) => `${f.path}|${f.hash}`).sort().join("\n"));
  const counts = { files_seen: files.length, files_indexed: 0, files_skipped: 0,
    files_failed: 0, symbols_extracted: 0 };
  for (const e of discover.errors || []) if (errors.length < 50) errors.push(short(e, 160));

  // Baseline: files indexed by the latest *complete* run for this root.
  let prior = [];
  try {
    const prev = await core.dbQuery(
      `SELECT id FROM code_index_state WHERE project_id=$1 AND root_path=$2 AND status='complete'
        ORDER BY started_at DESC LIMIT 1`, [project_id, rootAbs]);
    if (prev.rowCount) {
      const pf = await core.dbQuery(
        `SELECT path,content_hash FROM code_source_file
          WHERE project_id=$1 AND status='indexed' AND last_indexed_run=$2`,
        [project_id, prev.rows[0].id]);
      prior = pf.rows;
    }
  } catch (e) { errors.push(short(e?.message || e, 160)); }
  const priorByPath = new Map(prior.map((f) => [f.path, f.content_hash]));
  const currentPaths = new Set(files.map((f) => f.path));

  // Rename inference: a missing old path whose hash matches a new path.
  const inferred = [], usedNew = new Set();
  for (const [oldPath, oldHash] of priorByPath) {
    if (currentPaths.has(oldPath)) continue;
    const match = files.find((f) => f.hash === oldHash && !usedNew.has(f.path));
    if (match) { usedNew.add(match.path); inferred.push(`${oldPath}->${match.path}`); }
  }

  for (const f of files) {
    if (priorByPath.get(f.path) === f.hash) {
      counts.files_skipped++;
      // Refresh the run marker so the next baseline still sees this file.
      try {
        await core.dbQuery(
          `UPDATE code_source_file SET last_indexed_run=$1,status='indexed',updated_at=now()
            WHERE project_id=$2 AND path=$3`, [run_id, project_id, f.path]);
      } catch (e) { errors.push(short(e?.message || e, 140)); }
      continue;
    }
    const read = readBounded(f.abs, 256 * 1024);
    if (!read.ok) { counts.files_failed++; errors.push(`${f.path}: ${read.reason}`); continue; }
    let ex;
    try {
      ex = await extractSymbols({ project_id, root: rootAbs, path: f.path,
        source: read.content.toString("utf8"), language: f.language });
    } catch (e) { counts.files_failed++; errors.push(`${f.path}: ${short(e?.message || e, 140)}`); continue; }
    if (!ex?.ok) {
      counts.files_failed++; errors.push(`${f.path}: ${ex?.reason || "extraction failed"}`); continue;
    }
    try {
      await core.dbQuery(
        `INSERT INTO code_source_file (id,project_id,path,language,content_hash,size_bytes,status,
           extractor,last_indexed_run,error,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'indexed','heuristic',$7,NULL,now(),now())
         ON CONFLICT (project_id,path) DO UPDATE SET language=EXCLUDED.language,
           content_hash=EXCLUDED.content_hash,size_bytes=EXCLUDED.size_bytes,status='indexed',
           extractor='heuristic',last_indexed_run=EXCLUDED.last_indexed_run,error=NULL,updated_at=now()`,
        [crypto.randomUUID(), project_id, f.path, f.language, f.hash, f.size, run_id]);
      // Supersede prior symbol versions; history is preserved, never hard-deleted.
      await core.dbQuery(
        `UPDATE code_symbol SET status='superseded'
          WHERE project_id=$1 AND file_path=$2 AND content_hash<>$3 AND status='active'`,
        [project_id, f.path, f.hash]);
      // Batched insert: one round-trip per batch avoids a WAL sync per symbol.
      const SYMBOL_BATCH = 50;
      for (let bi = 0; bi < ex.symbols.length; bi += SYMBOL_BATCH) {
        const batch = ex.symbols.slice(bi, bi + SYMBOL_BATCH);
        const rows = [];
        const params = [];
        let p = 1;
        for (const s of batch) {
          rows.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},'heuristic',$${p++},$${p++}::jsonb,'active',now())`);
          params.push(crypto.randomUUID(), project_id, f.path, s.symbol_key, s.name, s.symbol_type,
            s.scope, s.visibility, s.start_line, s.end_line, s.parent_key, s.is_export,
            s.language, f.hash, version_hash, s.confidence, JSON.stringify(s.evidence));
        }
        await core.dbQuery(
          `INSERT INTO code_symbol (id,project_id,file_path,symbol_key,name,symbol_type,scope,
             visibility,start_line,end_line,parent_key,is_export,language,content_hash,
             version_hash,extraction_method,confidence,evidence,status,indexed_at)
           VALUES ${rows.join(",")}
           ON CONFLICT (project_id,file_path,symbol_key,content_hash) DO NOTHING`, params);
        counts.symbols_extracted += batch.length;
      }
      counts.files_indexed++;
    } catch (e) {
      counts.files_failed++;
      errors.push(`${f.path}: ${short(e?.message || e, 140)}`);
    }
  }

  // Deleted files are marked, never removed.
  try {
    for (const oldPath of priorByPath.keys()) {
      if (!currentPaths.has(oldPath)) {
        await core.dbQuery(
          `UPDATE code_source_file SET status='deleted',updated_at=now()
            WHERE project_id=$1 AND path=$2 AND status<>'deleted'`, [project_id, oldPath]);
      }
    }
  } catch (e) { errors.push(short(e?.message || e, 160)); }

  const gap = counts.files_failed > 0 || errors.length > 0 || !!discover.truncated ||
    (discover.skip_reasons?.size || 0) > 0;
  const status = gap ? "partial" : "complete";
  const noteExtra = `files=${counts.files_indexed} indexed, ${counts.files_skipped} skipped, ${counts.files_failed} failed; symbols=${counts.symbols_extracted}.` +
    (inferred.length ? ` inferred rename(s): ${inferred.slice(0, 10).join(", ")}.` : "");
  return finish(status, counts, version_hash, noteExtra);
}

// ---------------------------------------------------------------------------
// 5. Bounded, project-scoped read APIs.
// ---------------------------------------------------------------------------
export async function indexStatus({ project_id, root, limit } = {}) {
  const n = clamp(limit, 1, 200, 50);
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [], count: 0, limit: n };
  try {
    const r = await core.dbQuery(
      `SELECT id AS run_id,root_path,status,files_seen,files_indexed,files_skipped,files_failed,
         symbols_extracted,version_hash,started_at,finished_at,error
       FROM code_index_state
       WHERE project_id=$1 AND ($2::text IS NULL OR root_path=$2)
       ORDER BY started_at DESC LIMIT $3`,
      [project_id, root ? path.resolve(root) : null, n]);
    return { ok: true, items: r.rows, count: r.rows.length, limit: n,
      note: "Bounded index-run history for this project only." };
  } catch (e) {
    return { ok: false, reason: short(e?.message || e, 160), items: [], count: 0, limit: n };
  }
}

export async function searchSymbols({ project_id, query, symbol_type, path: filePath, limit } = {}) {
  const n = clamp(limit, 1, 200, 50);
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required", items: [], count: 0, limit: n };
  const q = short(query, 200);
  try {
    const r = await core.dbQuery(
      `SELECT cs.symbol_key,cs.name,cs.symbol_type,cs.scope,cs.visibility,cs.start_line,cs.end_line,
         cs.parent_key,cs.is_export,cs.language,cs.file_path,cs.content_hash,cs.version_hash,
         cs.confidence,cs.evidence,cs.indexed_at
       FROM code_symbol cs
       WHERE cs.project_id=$1 AND cs.status='active'
         AND ($2::text='' OR cs.name ILIKE '%'||$2||'%' OR cs.symbol_key ILIKE '%'||$2||'%')
         AND ($3::text IS NULL OR cs.symbol_type=$3)
         AND ($4::text IS NULL OR cs.file_path=$4 OR cs.file_path LIKE $4||'/%')
         AND EXISTS (SELECT 1 FROM code_source_file f
                     WHERE f.project_id=cs.project_id AND f.path=cs.file_path AND f.status='indexed')
       ORDER BY cs.file_path, cs.start_line LIMIT $5`,
      [project_id, q, symbol_type || null, filePath || null, n]);
    return { ok: true, items: r.rows, count: r.rows.length, limit: n,
      note: "Bounded, active, project-scoped symbol matches." };
  } catch (e) {
    return { ok: false, reason: short(e?.message || e, 160), items: [], count: 0, limit: n };
  }
}

export async function getSymbol({ project_id, symbol_key } = {}) {
  if (!validProject(project_id) || !symbol_key) return { ok: false, reason: "valid scope required", symbol: null };
  try {
    const r = await core.dbQuery(
      `SELECT * FROM code_symbol WHERE project_id=$1 AND symbol_key=$2 AND status='active'
        ORDER BY indexed_at DESC LIMIT 1`, [project_id, String(symbol_key)]);
    if (!r.rowCount) return { ok: false, reason: "symbol not found in project scope", symbol: null };
    return { ok: true, symbol: r.rows[0] };
  } catch (e) {
    return { ok: false, reason: short(e?.message || e, 160), symbol: null };
  }
}

export default { discoverFiles, extractSymbols, indexProject, indexStatus, searchSymbols, getSymbol };
