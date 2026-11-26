// Phase 25 capability C: deterministic, evidence-only structural understanding.
//
// Safety invariant: reads code_symbol / code_relationship / code_test_map only.
// No AST parser, no source reads, no LLM calls (HARNESS_SEMANTIC_LLM=0), no
// network. Every claim is traceable to a redacted evidence excerpt; anything not
// supported by evidence is listed as an explicit unknown rather than guessed.
// Project-scoped and bounded; fail closed on missing/`_global` scope.
import * as core from "./core.js";

const MAX_EVIDENCE = 12;
const MAX_SYMBOLS = 500;
const MAX_RELATED = 50;
const DEF_CONF = 0.5;
const MAX_CONF = 0.85;

const SYMBOL_FIELDS =
  "project_id, file_path, symbol_key, name, symbol_type, scope, visibility, start_line, " +
  "end_line, parent_key, is_export, language, content_hash, version_hash, " +
  "extraction_method, confidence, evidence, status, indexed_at";

const NON_PARAM = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof",
  "instanceof", "new", "delete", "void", "await", "yield", "throw", "super",
  "try", "do", "else", "with", "of", "in", "case",
]);

function short(v, n = 220) {
  return String(v ?? "").replace(/\s+/g, " ").slice(0, n);
}
function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function validProject(p) {
  return nonEmpty(p) && p.trim() !== "_global";
}
function runner(options) {
  const q = options?.dbQuery;
  return typeof q === "function" ? q : core.dbQuery;
}
function uniq(arr) {
  return [...new Set(arr.filter((x) => typeof x === "string" && x.length > 0))];
}
function evidenceLines(evidence) {
  const out = [];
  if (!Array.isArray(evidence)) return out;
  for (const item of evidence.slice(0, 60)) {
    if (typeof item === "string") {
      if (item.trim()) out.push(core.redact(item).slice(0, 200));
    } else if (item && typeof item === "object") {
      const raw = item.text ?? item.excerpt ?? item.line_text ?? item.evidence ?? "";
      const t = core.redact(String(raw ?? "")).slice(0, 200);
      if (t.trim()) out.push(t);
    }
  }
  return out;
}
function clampConf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(0.9, Math.max(0, n)) : DEF_CONF;
}

// --- deterministic signal extraction --------------------------------------

function extractParams(lines) {
  const out = [];
  const patterns = [
    /\b(?:function|def)\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
    /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:\{|=>)/g,
    /\b([A-Za-z_$][\w$]*)\s*=>/g,
  ];
  for (const text of lines) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && out.length < 30) {
        const group = m[2] ?? m[1];
        if (NON_PARAM.has(m[1] ?? "")) continue;
        if (!group) continue;
        for (const part of group.split(",")) {
          const token = part.trim().split("=")[0].split(":")[0].trim()
            .replace(/^\.\.\./, "").replace(/^[{\[]/, "").replace(/[}\]]$/, "").trim();
          if (/^[A-Za-z_$][\w$]*$/.test(token) && !NON_PARAM.has(token)) out.push(token);
        }
      }
    }
  }
  return uniq(out).slice(0, 30);
}

function extractCalls(lines) {
  const out = [];
  for (const text of lines) {
    const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(text)) && out.length < 40) {
      const name = m[1];
      if (!NON_PARAM.has(name)) out.push(name);
    }
  }
  return uniq(out).slice(0, 40);
}

function extractModuleRefs(text) {
  const imports = [];
  const exports = [];
  let m = text.match(/\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
  if (m) {
    const module = m[2];
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) imports.push({ name, module, evidence: short(text, 200) });
    }
  }
  m = text.match(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/);
  if (m) imports.push({ name: m[1], module: m[2], evidence: short(text, 200) });
  m = text.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (m) imports.push({ name: "", module: m[1], evidence: short(text, 200) });
  m = text.match(/\bexport\s*\{([^}]*)\}/);
  if (m) for (const part of m[1].split(",")) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) exports.push({ name, evidence: short(text, 200) });
  }
  m = text.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (m) exports.push({ name: m[1], evidence: short(text, 200) });
  return { imports, exports };
}

function hasPattern(lines, re) {
  return lines.find((t) => re.test(t)) || null;
}

// --- describeSymbol --------------------------------------------------------

export async function describeSymbol(options = {}) {
  const pid = short(options?.project_id, 200).trim();
  if (!validProject(options?.project_id) || pid !== options.project_id.trim() || !nonEmpty(options.symbol_key)) {
    return { ok: false, error: "valid project_id and symbol_key are required", note: "Fail closed: invalid scope." };
  }
  const key = short(options.symbol_key, 120);
  let row;
  try {
    const r = await runner(options)(
      `SELECT ${SYMBOL_FIELDS} FROM code_symbol
        WHERE project_id=$1 AND symbol_key=$2
        ORDER BY indexed_at DESC LIMIT 1`,
      [pid, key],
    );
    row = r.rows?.[0];
  } catch (e) {
    return { ok: false, error: `symbol read failed: ${short(e?.message || e, 160)}`,
      note: "Index unavailable; no description produced. Fail closed." };
  }
  if (!row) {
    return { ok: false, error: "symbol not found", note: "No indexed symbol with that key in this project." };
  }

  const lines = evidenceLines(row.evidence);
  const params = extractParams(lines);
  let calls = extractCalls(lines);

  // Add relationship-derived call targets (resolved symbol names only).
  try {
    const rels = await runner(options)(
      `SELECT DISTINCT target_key FROM code_relationship
        WHERE project_id=$1 AND source_key=$2 AND relationship_type='call'
        LIMIT $3`,
      [pid, key, MAX_RELATED],
    );
    const keys = (rels.rows || []).map((r) => r.target_key)
      .filter((k) => nonEmpty(k) && !k.startsWith("unresolved:"));
    if (keys.length) {
      const names = await runner(options)(
        `SELECT symbol_key, name FROM code_symbol
          WHERE project_id=$1 AND symbol_key = ANY($2::text[]) LIMIT $3`,
        [pid, keys, MAX_RELATED],
      );
      calls = uniq([...calls, ...(names.rows || []).map((n) => short(n.name).trim())]);
    }
  } catch { /* relationships are enrichment only; evidence-derived calls stand */ }

  const dbHit = hasPattern(lines, /\b(dbQuery|withDb|SELECT|INSERT|UPDATE|DELETE|sql|pg|pool|query)\b/i);
  const errHit = hasPattern(lines, /\b(try|catch|finally|throw|reject)\b|\.catch\s*\(/);
  const sideHit = hasPattern(lines, /\b(fs\.|writeFile|appendFile|unlink|mkdir|emit|process\.exit|fetch\s*\()/);
  const db_access = !!dbHit;
  const error_handling = !!errHit;
  const side_effects = !!sideHit;

  let related_tests = [];
  let testNote = "";
  try {
    const tr = await runner(options)(
      `SELECT test_path, test_name, source_key, link_type, confidence, evidence
         FROM code_test_map
        WHERE project_id=$1 AND source_key=$2
        ORDER BY created_at DESC LIMIT $3`,
      [pid, key, MAX_RELATED],
    );
    related_tests = (tr.rows || []).map((t) => ({
      test_path: short(t.test_path, 240),
      test_name: short(t.test_name, 200),
      source_key: short(t.source_key, 120),
      link_type: short(t.link_type, 40),
      confidence: clampConf(t.confidence),
      evidence: evidenceLines(t.evidence).slice(0, 2),
    }));
  } catch { testNote = " Test map unavailable; related_tests=[] means unknown, not proven absence."; }

  const symbol = {
    project_id: short(row.project_id, 200),
    file_path: short(row.file_path, 240),
    symbol_key: short(row.symbol_key, 120),
    name: short(row.name, 120),
    symbol_type: short(row.symbol_type, 40),
    scope: short(row.scope, 40),
    visibility: short(row.visibility, 40),
    start_line: Number.isInteger(row.start_line) ? row.start_line : 0,
    end_line: Number.isInteger(row.end_line) ? row.end_line : 0,
    parent_key: short(row.parent_key, 120),
    is_export: !!row.is_export,
    language: short(row.language, 40),
    content_hash: short(row.content_hash, 80),
    version_hash: short(row.version_hash, 80),
    extraction_method: short(row.extraction_method, 80),
    status: short(row.status, 40),
  };

  const summary = `${symbol.symbol_type || "symbol"} ${symbol.name || "(unnamed)"} ` +
    `in ${symbol.file_path || "(unknown file)"} lines ${symbol.start_line}-${symbol.end_line}` +
    `${symbol.is_export ? " (exported)" : ""}. Structural description from indexed evidence only.`;

  const unknowns = [];
  if (!params.length) unknowns.push("params");
  if (!calls.length) unknowns.push("calls");
  if (!db_access) unknowns.push("db_access");
  if (!error_handling) unknowns.push("error_handling");
  if (!side_effects) unknowns.push("side_effects");
  if (!related_tests.length) unknowns.push("related_tests");

  const signals = [params.length > 0, calls.length > 0, db_access, error_handling, side_effects, related_tests.length > 0]
    .filter(Boolean).length;
  const confidence = Number(Math.min(MAX_CONF, Math.max(0.1, clampConf(row.confidence) + signals * 0.05)).toFixed(2));

  return {
    ok: true,
    symbol,
    summary,
    params,
    calls,
    db_access,
    error_handling,
    side_effects,
    related_tests,
    evidence: lines.slice(0, MAX_EVIDENCE),
    confidence,
    signals: { db: dbHit ? short(dbHit, 200) : null, error: errHit ? short(errHit, 200) : null,
      side_effect: sideHit ? short(sideHit, 200) : null },
    unknowns,
    error: null,
    note: "Static evidence only; no AST/LLM/runtime verification. An empty field listed in `unknowns` means insufficient evidence, not proven absence. " +
      "Calls are name tokens from evidence plus resolved call edges and are not proof of dynamic dispatch." + testNote,
  };
}

// --- moduleUnderstanding ---------------------------------------------------

export async function moduleUnderstanding(options = {}) {
  const pid = short(options?.project_id, 200).trim();
  if (!validProject(options?.project_id) || pid !== options.project_id.trim() || !nonEmpty(options.path)) {
    return { ok: false, path: "", symbols: [], imports: [], exports: [], responsibilities: [],
      evidence: [], note: "Fail closed: valid project_id and path are required." };
  }
  const filePath = short(options.path, 240);
  let symbols;
  try {
    const r = await runner(options)(
      `SELECT ${SYMBOL_FIELDS} FROM code_symbol
        WHERE project_id=$1 AND file_path=$2
        ORDER BY start_line ASC LIMIT $3`,
      [pid, filePath, MAX_SYMBOLS],
    );
    symbols = (r.rows || []).map((s) => ({
      symbol_key: short(s.symbol_key, 120),
      name: short(s.name, 120),
      symbol_type: short(s.symbol_type, 40),
      start_line: Number.isInteger(s.start_line) ? s.start_line : 0,
      is_export: !!s.is_export,
      confidence: clampConf(s.confidence),
    }));
  } catch (e) {
    return { ok: false, path: filePath, symbols: [], imports: [], exports: [], responsibilities: [],
      evidence: [], note: `Symbol index unavailable: ${short(e?.message || e, 160)}. Fail closed.` };
  }

  // Re-read evidence for this file to derive module-level facts. Bounded by the
  // same symbol set above; no source-file access.
  const imports = [];
  const exports = [];
  const evidence = [];
  let dbSeen = false, errSeen = false, sideSeen = false, httpSeen = false, testSeen = false, configSeen = false;
  try {
    const r = await runner(options)(
      `SELECT evidence, is_export, name FROM code_symbol
        WHERE project_id=$1 AND file_path=$2 ORDER BY start_line ASC LIMIT $3`,
      [pid, filePath, MAX_SYMBOLS],
    );
    for (const row of r.rows || []) {
      for (const t of evidenceLines(row.evidence)) {
        if (evidence.length < MAX_EVIDENCE) evidence.push(t);
        const { imports: ims, exports: exs } = extractModuleRefs(t);
        imports.push(...ims);
        exports.push(...exs);
        if (!dbSeen && /\b(dbQuery|withDb|SELECT|INSERT|UPDATE|DELETE|sql|pg|pool)\b/i.test(t)) dbSeen = true;
        if (!errSeen && /\b(try|catch|finally|throw)\b/.test(t)) errSeen = true;
        if (!sideSeen && /\b(fs\.|writeFile|appendFile|emit|unlink|mkdir|process\.exit)\b/.test(t)) sideSeen = true;
        if (!httpSeen && /\b(fetch|http\.|axios|https\.)\b/.test(t)) httpSeen = true;
        if (!testSeen && /\b(test\s*\(|describe\s*\(|it\s*\(|assert\.|pytest)\b/.test(t)) testSeen = true;
        if (!configSeen && /\b(process\.env|config|settings|env\()/i.test(t)) configSeen = true;
      }
      if (row.is_export && nonEmpty(row.name) && !exports.some((e) => e.name === short(row.name).trim())) {
        exports.push({ name: short(row.name).trim(), evidence: "symbol.is_export" });
      }
    }
  } catch { /* module facts remain best-effort from the symbol rows already loaded */ }

  const responsibilities = [];
  if (dbSeen) responsibilities.push("database_access");
  if (errSeen) responsibilities.push("error_handling");
  if (sideSeen) responsibilities.push("side_effects");
  if (httpSeen) responsibilities.push("http_client");
  if (testSeen) responsibilities.push("test_support");
  if (configSeen) responsibilities.push("configuration");
  if (exports.length) responsibilities.push("export_surface");
  if (!responsibilities.length) responsibilities.push("unclassified_insufficient_evidence");

  return {
    ok: true,
    path: filePath,
    symbols,
    imports: imports.slice(0, 60),
    exports: exports.slice(0, 60),
    responsibilities: responsibilities.slice(0, 10),
    evidence,
    note: "Module view aggregated from indexed symbol evidence only; no source parsing or runtime inspection. " +
      "Import/export lists are explicit statements found in evidence, not a complete module graph. " +
      (symbols.length ? "" : "No indexed symbols were found for this path."),
  };
}

export default { describeSymbol, moduleUnderstanding };
