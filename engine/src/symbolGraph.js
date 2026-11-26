// Phase 25 capability B: deterministic, evidence-backed symbol relationships.
//
// Safety invariant: static, project-scoped, bounded analysis only. No AST parser,
// no source reads/writes, no spawn, no git, no LLM calls. Every edge is derived
// from explicit tokens in indexed evidence (or supplied symbols) and carries a
// status, confidence, extraction_method and at least one evidence item. Similar
// names alone never create an edge. Fail closed on missing/`_global` scope.
import * as core from "./core.js";

const REL_TYPES = Object.freeze(["import", "export", "extends", "implements", "call"]);
const STATUSES = Object.freeze(["confirmed", "inferred", "unresolved"]);
const CONF = Object.freeze({ confirmed: 0.92, inferred: 0.5, unresolved: 0.12 });
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SYMBOLS = 1500;
const MAX_UNRESOLVED = 40;
const MAX_EVIDENCE_PER_EDGE = 4;
const TRAVERSE_DEF_DEPTH = 3;
const TRAVERSE_MAX_DEPTH = 6;
const TRAVERSE_DEF_NODES = 100;
const TRAVERSE_MAX_NODES = 500;

const FIELDS =
  "id, project_id, source_key, target_key, relationship_type, source_file, source_line, " +
  "status, confidence, extraction_method, evidence, version_hash, created_at";

// Tokens that are language/API builtins rather than project symbol references.
// Suppressing them keeps unresolved edges meaningful instead of noisy.
const STOPLIST = new Set([
  "console", "log", "warn", "error", "info", "debug", "trace",
  "JSON", "parse", "stringify", "Object", "Array", "String", "Number", "Boolean",
  "BigInt", "Math", "Date", "RegExp", "Promise", "resolve", "reject", "Error",
  "TypeError", "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Symbol",
  "Reflect", "Proxy", "process", "require", "module", "exports", "globalThis",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "fetch", "dbQuery", "withDb", "audit", "query", "emit",
  "writeFile", "readFile", "appendFile", "push", "pop", "slice", "map", "filter",
  "reduce", "forEach", "then", "catch", "finally", "join", "split", "trim",
]);

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof",
  "instanceof", "new", "delete", "void", "await", "yield", "throw", "super",
  "this", "do", "else", "try", "return", "of", "in", "case", "default",
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
function boundedInt(v, fallback, cap) {
  return Number.isInteger(v) && v > 0 ? Math.min(v, cap) : fallback;
}
function uniq(arr) {
  return [...new Set(arr.filter((x) => typeof x === "string" && x.length > 0))];
}
function ident(s) {
  return typeof s === "string" && /^[A-Za-z_$][\w$]*$/.test(s);
}
function runner(options) {
  const q = options?.dbQuery;
  return typeof q === "function" ? q : core.dbQuery;
}
function evidenceLines(evidence) {
  const out = [];
  if (!Array.isArray(evidence)) return out;
  for (const item of evidence.slice(0, 60)) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ text: core.redact(item).slice(0, 200), line: null });
    } else if (item && typeof item === "object") {
      const raw = item.text ?? item.excerpt ?? item.line_text ?? item.evidence ?? "";
      const text = core.redact(String(raw ?? "")).slice(0, 200);
      if (!text.trim()) continue;
      let line = null;
      if (Number.isInteger(item.line)) line = item.line;
      else if (Number.isInteger(item.start_line)) line = item.start_line;
      out.push({ text, line });
    }
  }
  return out;
}

// --- token extractors (bounded, line-local, no parsing beyond the line) ------

function importTokens(text) {
  const out = [];
  let m = text.match(/\bimport\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/);
  if (m) for (const part of m[1].split(",")) {
    const id = part.trim().split(/\s+as\s+/)[0].trim();
    if (ident(id)) out.push(id);
  }
  m = text.match(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (m) out.push(m[1]);
  m = text.match(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]/);
  if (m) out.push(m[1]);
  if (/\brequire\s*\(/.test(text)) {
    m = text.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/);
    if (m) out.push(m[1]);
  }
  return uniq(out);
}

function exportTokens(text) {
  const out = [];
  let m = text.match(/\bexport\s*\{([^}]*)\}/);
  if (m) for (const part of m[1].split(",")) {
    const id = part.trim().split(/\s+as\s+/)[0].trim();
    if (ident(id)) out.push(id);
  }
  m = text.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (m) out.push(m[1]);
  return uniq(out);
}

function heritageTokens(text) {
  const out = [];
  const re = /\b(extends|implements)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 10) {
    out.push({ kind: m[1] === "implements" ? "implements" : "extends", name: m[2] });
  }
  return out;
}

function callTokens(text) {
  const out = [];
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(text)) && out.length < 40) {
    const name = m[1];
    if (!CALL_KEYWORDS.has(name) && !STOPLIST.has(name)) out.push(name);
  }
  return uniq(out);
}

// --- symbol loading / resolution -------------------------------------------

async function loadSymbols(options, pid, limit) {
  if (Array.isArray(options.symbols)) {
    return options.symbols.slice(0, MAX_SYMBOLS).map((s) => (s && typeof s === "object" ? s : {}));
  }
  const r = await runner(options)(
    `SELECT file_path, symbol_key, name, symbol_type, is_export, start_line, confidence, evidence
       FROM code_symbol
      WHERE project_id=$1 AND status='active'
      ORDER BY file_path ASC, start_line ASC LIMIT $2`,
    [pid, limit],
  );
  return (r.rows || []).map((s) => ({ ...s }));
}

function nameIndex(symbols) {
  const idx = new Map();
  for (const s of symbols) {
    const name = short(s.name).trim();
    if (!name) continue;
    if (!idx.has(name)) idx.set(name, []);
    idx.get(name).push(s);
  }
  return idx;
}

function resolveName(idx, name, sourceFile) {
  const candidates = idx.get(name) || [];
  if (!candidates.length) return null;
  const same = candidates.find((c) => short(c.file_path) === short(sourceFile));
  const target = same || candidates[0];
  if (!target || !nonEmpty(target.symbol_key)) return null;
  return { target, sameFile: !!same };
}

// --- edge derivation --------------------------------------------------------

function callConfidence(sameFile, mentions) {
  let c = sameFile ? 0.5 : 0.3;
  if (mentions >= 2) c += 0.1;
  return Math.round(Math.min(0.6, Math.max(0.3, c)) * 100) / 100;
}

function makeEdge({ source, targetKey, type, status, confidence, method, line, evidence }) {
  return {
    source_key: short(source.symbol_key, 120),
    target_key: short(targetKey, 120),
    relationship_type: type,
    source_file: short(source.file_path, 240),
    source_line: Number.isInteger(line) && line >= 0 ? line : 0,
    status,
    confidence: Number(confidence.toFixed(2)),
    extraction_method: method,
    evidence: uniq(evidence.filter((e) => typeof e === "string")).slice(0, MAX_EVIDENCE_PER_EDGE),
  };
}

function deriveRelationships(symbols, limit) {
  const usable = symbols.filter((s) => nonEmpty(s?.symbol_key));
  const idx = nameIndex(usable);
  const byKey = new Map();
  const edges = new Map();
  let unresolvedCount = 0;

  for (const s of usable) {
    const sourceKey = short(s.symbol_key, 120);
    const sourceName = short(s.name).trim();
    const sourceFile = short(s.file_path);
    byKey.set(sourceKey, s);
    const lines = evidenceLines(s.evidence);

    const put = (edge) => {
      if (edge.target_key === edge.source_key) return;
      const id = `${edge.source_key}\u0000${edge.target_key}\u0000${edge.relationship_type}`;
      const rank = { confirmed: 3, inferred: 2, unresolved: 1 };
      const prev = edges.get(id);
      if (!prev) { edges.set(id, edge); return; }
      if (rank[edge.status] > rank[prev.status]) { edges.set(id, edge); return; }
      if (rank[edge.status] === rank[prev.status]) {
        prev.evidence = uniq([...prev.evidence, ...edge.evidence]).slice(0, MAX_EVIDENCE_PER_EDGE);
        if (edge.confidence > prev.confidence) prev.confidence = edge.confidence;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const { text, line: explicitLine } = lines[i];
      const line = explicitLine ?? ((Number.isInteger(s.start_line) ? s.start_line : 0) + i);
      const ev = [text];

      for (const name of importTokens(text)) {
        if (name === sourceName) continue;
        const hit = resolveName(idx, name, sourceFile);
        if (hit) {
          put(makeEdge({ source: s, targetKey: hit.target.symbol_key, type: "import",
            status: "confirmed", confidence: CONF.confirmed, method: "heuristic:import", line, evidence: ev }));
        } else if (unresolvedCount < MAX_UNRESOLVED) {
          unresolvedCount++;
          put(makeEdge({ source: s, targetKey: `unresolved:import:${name}`, type: "import",
            status: "unresolved", confidence: CONF.unresolved, method: "heuristic:unresolved", line, evidence: ev }));
        }
      }

      for (const name of exportTokens(text)) {
        if (name === sourceName) continue; // a declaration is not a reference
        const hit = resolveName(idx, name, sourceFile);
        if (hit) {
          put(makeEdge({ source: s, targetKey: hit.target.symbol_key, type: "export",
            status: "confirmed", confidence: CONF.confirmed, method: "heuristic:export", line, evidence: ev }));
        } else if (unresolvedCount < MAX_UNRESOLVED) {
          unresolvedCount++;
          put(makeEdge({ source: s, targetKey: `unresolved:export:${name}`, type: "export",
            status: "unresolved", confidence: CONF.unresolved, method: "heuristic:unresolved", line, evidence: ev }));
        }
      }

      for (const h of heritageTokens(text)) {
        if (h.name === sourceName) continue;
        const hit = resolveName(idx, h.name, sourceFile);
        if (hit) {
          put(makeEdge({ source: s, targetKey: hit.target.symbol_key, type: h.kind,
            status: "confirmed", confidence: CONF.confirmed, method: `heuristic:${h.kind}`, line, evidence: ev }));
        } else if (unresolvedCount < MAX_UNRESOLVED) {
          unresolvedCount++;
          put(makeEdge({ source: s, targetKey: `unresolved:${h.kind}:${h.name}`, type: h.kind,
            status: "unresolved", confidence: CONF.unresolved, method: "heuristic:unresolved", line, evidence: ev }));
        }
      }

      const mentions = new Map();
      for (const name of callTokens(text)) mentions.set(name, (mentions.get(name) || 0) + 1);
      for (const [name, count] of mentions) {
        if (name === sourceName) continue;
        const hit = resolveName(idx, name, sourceFile);
        if (hit) {
          put(makeEdge({ source: s, targetKey: hit.target.symbol_key, type: "call",
            status: "inferred", confidence: callConfidence(hit.sameFile, count),
            method: "heuristic:call", line, evidence: ev }));
        } else if (unresolvedCount < MAX_UNRESOLVED && /^[A-Z]/.test(name)) {
          unresolvedCount++;
          put(makeEdge({ source: s, targetKey: `unresolved:call:${name}`, type: "call",
            status: "unresolved", confidence: CONF.unresolved, method: "heuristic:unresolved", line, evidence: ev }));
        }
      }
    }
  }

  const all = [...edges.values()].sort((a, b) =>
    a.source_key.localeCompare(b.source_key) ||
    a.target_key.localeCompare(b.target_key) ||
    a.relationship_type.localeCompare(b.relationship_type));
  return all.slice(0, limit);
}

function countByStatus(edges) {
  const counts = { confirmed: 0, inferred: 0, unresolved: 0 };
  for (const e of edges) if (counts[e.status] !== undefined) counts[e.status]++;
  return counts;
}

// --- public API -------------------------------------------------------------

export async function buildRelationships(options = {}) {
  const pid = short(options?.project_id, 200).trim();
  if (!validProject(options?.project_id) || pid !== options.project_id.trim()) {
    return { ok: false, relationships: [], counts: countByStatus([]), errors: ["valid project_id required"],
      note: "project_id must be a non-empty string other than '_global'." };
  }
  const limit = boundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const errors = [];
  const degraded = [];
  let symbols;
  try {
    symbols = await loadSymbols(options, pid, limit);
  } catch (e) {
    return { ok: false, relationships: [], counts: countByStatus([]),
      errors: [`symbol load failed: ${short(e?.message || e, 160)}`], degraded: true,
      note: "Symbol index unavailable; no relationships derived. Fail closed." };
  }

  let relationships;
  try {
    relationships = deriveRelationships(symbols, limit);
  } catch (e) {
    return { ok: false, relationships: [], counts: countByStatus([]),
      errors: [`derivation failed: ${short(e?.message || e, 160)}`], degraded: true,
      note: "Relationship derivation failed; fail closed." };
  }

  const versionHash = short(options.version_hash, 120);
  for (const e of relationships) {
    try {
      await runner(options)(
        `INSERT INTO code_relationship
           (project_id, source_key, target_key, relationship_type, source_file, source_line,
            status, confidence, extraction_method, evidence, version_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT (project_id, source_key, target_key, relationship_type, version_hash) DO NOTHING`,
        [pid, e.source_key, e.target_key, e.relationship_type, e.source_file, e.source_line,
          e.status, e.confidence, e.extraction_method, JSON.stringify(e.evidence), versionHash],
      );
    } catch (err) {
      errors.push(`persist failed: ${short(err?.message || err, 160)}`);
      degraded.push("persistence unavailable");
      break;
    }
  }

  try { await core.audit("p25.relationships.build", pid, { count: relationships.length, limit }); }
  catch { /* best effort */ }

  return {
    ok: true,
    relationships,
    counts: countByStatus(relationships),
    errors,
    degraded,
    note: relationships.length
      ? "Static, evidence-backed edges only; similarity alone never creates an edge. Confirmed edges come from explicit import/export/heritage statements; call edges are inferred and unresolved edges carry evidence but no proven target."
      : "No evidence-backed relationships derived from the supplied symbols.",
  };
}

function normalizeRow(row) {
  let ev = row.evidence;
  if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch { ev = []; } }
  return { ...row, evidence: Array.isArray(ev) ? ev.slice(0, MAX_EVIDENCE_PER_EDGE) : [] };
}

export async function getRelationships(options = {}) {
  const pid = short(options?.project_id, 200).trim();
  if (!validProject(options?.project_id) || pid !== options.project_id.trim()) {
    return { ok: false, items: [], reason: "valid project_id required" };
  }
  const direction = ["in", "out", "both"].includes(options.direction) ? options.direction : "both";
  const limit = boundedInt(options.limit, 100, 500);
  const params = [pid];
  let predicate = "TRUE";
  if (nonEmpty(options.symbol_key)) {
    const key = short(options.symbol_key, 120);
    if (direction === "out") { predicate = "source_key=$2"; params.push(key); }
    else if (direction === "in") { predicate = "target_key=$2"; params.push(key); }
    else { predicate = "(source_key=$2 OR target_key=$2)"; params.push(key); }
  }
  let sql = `SELECT ${FIELDS} FROM code_relationship WHERE project_id=$1 AND ${predicate}`;
  if (nonEmpty(options.type)) {
    if (!REL_TYPES.includes(options.type)) {
      return { ok: false, items: [], reason: `type must be one of ${REL_TYPES.join("|")}` };
    }
    params.push(short(options.type, 60));
    sql += ` AND relationship_type=$${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  try {
    const r = await runner(options)(sql, params);
    return { ok: true, items: (r.rows || []).map(normalizeRow) };
  } catch (e) {
    return { ok: false, items: [], reason: `relationship read failed: ${short(e?.message || e, 160)}` };
  }
}

/**
 * Bounded depth-first traversal. Both bounds are hard clamps; `truncated` is set
 * whenever a frontier was cut by depth or by the node budget. Coverage is never
 * claimed complete, and is explicitly disclaimed when unresolved edges exist.
 */
export async function traverse(options = {}) {
  const pid = short(options?.project_id, 200).trim();
  if (!validProject(options?.project_id) || pid !== options.project_id.trim() || !nonEmpty(options.symbol_key)) {
    return { ok: false, nodes: [], edges: [], truncated: false,
      note: "valid project_id and symbol_key are required." };
  }
  const root = short(options.symbol_key, 120);
  const maxDepth = boundedInt(options.max_depth, TRAVERSE_DEF_DEPTH, TRAVERSE_MAX_DEPTH);
  const maxNodes = boundedInt(options.max_nodes, TRAVERSE_DEF_NODES, TRAVERSE_MAX_NODES);
  const types = Array.isArray(options.types)
    ? options.types.filter((t) => REL_TYPES.includes(t)).slice(0, 5) : null;

  const nodes = [{ symbol_key: root, depth: 0 }];
  const edges = [];
  const seenEdges = new Set();
  const visited = new Set([root]);
  const stack = [{ key: root, depth: 0 }];
  let truncated = false;
  let readFailed = false;

  try {
    while (stack.length) {
      const cur = stack.pop();
      if (cur.depth >= maxDepth) {
        // Do not expand past the depth bound; mark truncation only if there was
        // something to expand (checked with a cheap bounded read below).
        const maybe = await getRelationships({ ...options, project_id: pid,
          symbol_key: cur.key, direction: "both", limit: 1 });
        if (!maybe.ok) { readFailed = true; break; }
        if (maybe.items.length) truncated = true;
        continue;
      }
      const r = await getRelationships({ ...options, project_id: pid,
        symbol_key: cur.key, direction: "both", limit: 64 });
      if (!r.ok) { readFailed = true; truncated = true; break; }
      let expanded = 0;
      for (const e of r.items) {
        if (types && !types.includes(e.relationship_type)) continue;
        if (!seenEdges.has(e.id)) { seenEdges.add(e.id); edges.push(e); }
        const next = e.target_key === cur.key ? e.source_key : e.target_key;
        if (!next || visited.has(next)) continue;
        if (nodes.length >= maxNodes) { truncated = true; break; }
        visited.add(next);
        nodes.push({ symbol_key: next, depth: cur.depth + 1 });
        stack.push({ key: next, depth: cur.depth + 1 });
        expanded++;
      }
      if (nodes.length >= maxNodes && stack.length) truncated = true;
      if (r.items.length > 64) truncated = true;
      void expanded;
    }
  } catch (e) {
    truncated = true;
    return { ok: false, nodes, edges, truncated,
      note: `Traversal aborted: ${short(e?.message || e, 160)}. Coverage incomplete.` };
  }

  if (readFailed) {
    return { ok: false, nodes, edges, truncated,
      note: "Relationship index unavailable during traversal; result is incomplete. Fail closed." };
  }

  let hasUnresolved = edges.some((e) => e.status === "unresolved");
  if (!hasUnresolved) {
    try {
      const u = await runner(options)(
        `SELECT 1 FROM code_relationship WHERE project_id=$1 AND status='unresolved' LIMIT 1`, [pid]);
      hasUnresolved = (u.rows || []).length > 0;
    } catch { /* best effort */ }
  }

  const note = hasUnresolved
    ? `Bounded static traversal (depth<=${maxDepth}, nodes<=${maxNodes}); coverage is incomplete: unresolved edges exist, so a missing link is not proof of absence.`
    : `Bounded static traversal (depth<=${maxDepth}, nodes<=${maxNodes}); coverage is limited by these bounds and by the indexed evidence; it is not a complete dependency graph.`;
  return { ok: true, nodes, edges, truncated, note };
}

export default { buildRelationships, getRelationships, traverse };
