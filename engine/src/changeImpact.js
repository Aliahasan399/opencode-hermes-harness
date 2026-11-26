// Phase 25 capability D — version-aware, stale-safe change impact analysis.
//
// Design rules (deliberately strict, deterministic, no LLM / no network):
//   * EVIDENCE PRODUCER ONLY: direct/transitive/possible/unknown entries are derived
//     solely from indexed code_symbol/code_relationship rows. No edge is invented.
//   * An empty "no dependency found" result is NOT proof of safety: the index is
//     heuristic and bounded; unresolved edges and staleness are reported explicitly.
//   * Freshness is content-hash based. When the latest index hash differs from the
//     current on-disk hash (or no complete index exists), the result is marked stale.
//   * All traversal is bounded (<= 100 nodes, depth <= 4) and every query is
//     project-scoped. DB failures fail closed into degraded/errors, never into claims.
//   * Free text is redacted via core.redact; raw diff content is never stored or
//     returned. Audit is best-effort. No source is written, no task dispatched,
//     no change approved.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const IMPACT_RULES = freeze({
  version: "1.0.0",
  bounds: freeze({
    maxFiles: 3000,
    maxFileBytes: 256 * 1024,
    maxDepth: 12,
    maxTraverseNodes: 100,
    maxTraverseDepth: 4,
    maxArray: 200,
    defaultLimit: 50,
    maxEvidenceItems: 10,
    maxDiffChars: 2000,
  }),
  confidence: freeze({
    direct: 0.7,
    transitive: 0.5,
    possible: 0.20,
    unknown: 0.15,
    test: 0.5,
    decision: 0.4,
    cap: 0.9,
  }),
  categories: freeze(["direct", "transitive", "possible", "unknown", "test", "decision"]),
  note: "Impact is bounded static evidence, not a verified outcome.",
});

// Required safety wording — present in every returned result.
export const SAFETY_NOTE =
  "Static, bounded, evidence-backed source analysis only. A no-dependency-found result is NOT proof of safety: " +
  "the index is heuristic and may be incomplete. Stale indexes cannot silently support recommendations — " +
  "when the indexed version_hash differs from the current on-disk hash, re-index and re-analyze before relying " +
  "on this result. No source was rewritten, no task was dispatched, and no change was approved.";

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "checkpoints", "backups", "__pycache__", ".pytest_cache",
  "dist", "build", "coverage", ".next", ".cache",
]);
const IGNORE_FILE_RE = /(\.pyc$|\.min\.(js|css)$|[-.]min\.(js|css)$|\.map$)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmptyString(p) && p.trim() !== "_global"; }
function short(e) { return String(e?.message || e).replace(/\s+/g, " ").slice(0, 160); }
function clip(text, max) { return core.redact(String(text ?? "")).replace(/\s+/g, " ").slice(0, max); }
function sha256(text) { return crypto.createHash("sha256").update(String(text)).digest("hex"); }
function clampLimit(limit, fallback, max) {
  const n = Number.isInteger(limit) ? limit : fallback;
  return Math.max(0, Math.min(n, max));
}
function boundConfidence(v, fallback) {
  const x = Number(v);
  const base = Number.isFinite(x) && x >= 0 ? x : fallback;
  return Math.round(Math.min(IMPACT_RULES.confidence.cap, Math.max(0, base)) * 10000) / 10000;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function normalizeEvidence(ev, fallback) {
  const out = [];
  if (Array.isArray(ev)) {
    for (const e of ev.slice(0, IMPACT_RULES.bounds.maxEvidenceItems)) {
      if (e === null || e === undefined) continue;
      if (typeof e === "string") out.push({ source: "indexed_evidence", excerpt: clip(e, 200) });
      else if (typeof e === "object") {
        out.push({
          source: String(e.source ?? e.kind ?? "indexed_evidence").slice(0, 60),
          excerpt: clip(e.excerpt ?? e.text ?? e.detail ?? JSON.stringify(e), 200),
        });
      }
    }
  }
  if (!out.length && fallback) out.push({ source: "deterministic", excerpt: clip(fallback, 200) });
  return out;
}

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* best effort */ }
}

function emptyChangeResult(reason, degraded = []) {
  return {
    ok: false, reason, change_ref: null, version_hash: null,
    direct: [], transitive: [], possible: [], unknown: [], tests: [], decisions: [],
    stale: true, evidence: [], persisted: false, degraded, errors: [],
    claim: "Static source evidence only; not a verified engineering outcome.",
    note: SAFETY_NOTE,
  };
}

// --- On-disk discovery -----------------------------------------------------

function discoverLocal(root, bounds) {
  const errors = [];
  if (!nonEmptyString(root)) return { files: [], errors: ["root not provided"] };
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot)) return { files: [], errors: ["root not found"] };
  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= bounds.maxFiles || depth > bounds.maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { errors.push(`readdir: ${short(e)}`); return; }
    for (const ent of entries) {
      if (files.length >= bounds.maxFiles) break;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(abs, depth + 1);
      } else if (ent.isFile()) {
        if (IGNORE_FILE_RE.test(ent.name)) continue;
        let stat;
        try {
          stat = fs.statSync(abs);
          if (stat.size > bounds.maxFileBytes) continue;
          files.push({ path: path.relative(absRoot, abs).split(path.sep).join("/"), hash: sha256(fs.readFileSync(abs)) });
        } catch (e) { errors.push(`read ${ent.name}: ${short(e)}`); }
      }
      // symlinks (and other types) are skipped deliberately
    }
  };
  walk(absRoot, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
}

/** Prefer the indexer's own discovery so the version hash matches indexProject. */
async function discover({ project_id, root, bounds }) {
  const idx = await load("sourceIndexer");
  if (idx?.discoverFiles) {
    try {
      const r = await idx.discoverFiles({
        project_id, root,
        options: { maxFiles: bounds.maxFiles, maxBytes: bounds.maxFileBytes, maxDepth: bounds.maxDepth },
      });
      if (r?.ok && Array.isArray(r.files)) {
        const files = r.files
          .filter((f) => f && nonEmptyString(f.path))
          .map((f) => {
            const hash = f.hash ?? f.content_hash ?? f.sha256;
            return { path: String(f.path).replace(/\\/g, "/"), hash: String(hash ?? "") };
          })
          .filter((f) => f.hash)
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { files, errors: Array.isArray(r.errors) ? r.errors.map(short) : [], via: "sourceIndexer" };
      }
    } catch { /* fall back to local discovery */ }
  }
  return { ...discoverLocal(root, bounds), via: "local" };
}

/** Same algorithm as sourceIndexer.indexProject: sha256 of sorted "path|hash" lines. */
function versionHashFrom(files) {
  const lines = files.map((f) => `${f.path}|${f.hash}`).sort();
  return sha256(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// compareIndexFreshness
// ---------------------------------------------------------------------------

export async function compareIndexFreshness({ project_id, root } = {}) {
  if (!validProject(project_id)) {
    return {
      ok: false, stale: true, indexed_version_hash: null, current_version_hash: null,
      changed_files: [], files_seen: 0, degraded: ["valid project_id required"],
      errors: [], reason: "valid project_id required", note: SAFETY_NOTE,
    };
  }
  const bounds = IMPACT_RULES.bounds;
  const degraded = [];
  const errors = [];

  let disc;
  try { disc = await discover({ project_id, root, bounds }); }
  catch (e) { disc = { files: [], errors: [short(e)] }; }
  for (const e of (disc.errors || [])) errors.push(`discover: ${e}`);
  const files = disc.files || [];
  const current_version_hash = versionHashFrom(files);

  // Latest index state row.
  let indexRow = null;
  try {
    const r = await core.dbQuery(
      `SELECT version_hash, status, root_path, started_at FROM code_index_state
       WHERE project_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1`, [project_id],
    );
    indexRow = r.rows[0] || null;
  } catch (e) { errors.push(`index_state: ${short(e)}`); degraded.push("index state unavailable"); }

  // Current source-file ledger.
  let ledger = new Map();
  try {
    const r = await core.dbQuery(
      `SELECT path, content_hash, status FROM code_source_file WHERE project_id=$1`, [project_id],
    );
    for (const row of r.rows) {
      if (typeof row.path === "string") ledger.set(row.path.replace(/\\/g, "/"), row);
    }
  } catch (e) { errors.push(`source_file: ${short(e)}`); degraded.push("source file ledger unavailable"); }

  const changed_files = [];
  for (const f of files) {
    if (changed_files.length >= bounds.maxArray) { degraded.push("changed_files truncated"); break; }
    const row = ledger.get(f.path);
    if (!row) {
      changed_files.push({ path: f.path, current_hash: f.hash, indexed_hash: null, status: "added",
        evidence: [{ source: "disk", excerpt: `new unindexed file ${f.path}` }] });
    } else if (String(row.content_hash) !== String(f.hash)) {
      changed_files.push({ path: f.path, current_hash: f.hash, indexed_hash: String(row.content_hash), status: "modified",
        evidence: [{ source: "disk_vs_ledger", excerpt: `content hash differs for ${f.path}` }] });
    }
  }
  for (const [p, row] of ledger) {
    if (changed_files.length >= bounds.maxArray) { degraded.push("changed_files truncated"); break; }
    if (String(row.status) === "deleted") continue;
    if (!files.some((f) => f.path === p)) {
      changed_files.push({ path: p, current_hash: null, indexed_hash: String(row.content_hash), status: "removed",
        evidence: [{ source: "ledger_vs_disk", excerpt: `indexed file no longer on disk: ${p}` }] });
    }
  }

  const indexed_version_hash = indexRow && nonEmptyString(indexRow.version_hash) ? String(indexRow.version_hash) : null;
  const dbReadOk = !errors.some((e) => e.startsWith("index_state:") || e.startsWith("source_file:"));
  // Fail closed: no index, a non-complete index, or unreadable index => stale.
  const indexTrusted = Boolean(indexRow) && indexed_version_hash !== null && String(indexRow.status) === "complete" && dbReadOk;
  const stale = !indexTrusted || indexed_version_hash !== current_version_hash;

  await audit("p25.freshness", project_id, { stale, root: root || null, files_seen: files.length });

  return {
    ok: dbReadOk, project_id, stale, indexed_version_hash, current_version_hash,
    changed_files, files_seen: files.length,
    index_status: indexRow ? String(indexRow.status) : null,
    degraded, errors,
    claim: "On-disk content-hash comparison; not a source rewrite.",
    note: SAFETY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// analyzeChange
// ---------------------------------------------------------------------------

/** Redact and bound the caller's change; never expose raw diff content. */
function sanitizeChange(change) {
  const c = change && typeof change === "object" && !Array.isArray(change) ? change : {};
  const out = { path: null, symbol_key: null, files: [], diff: null };
  if (nonEmptyString(c.path)) out.path = String(c.path).replace(/\\/g, "/").slice(0, 512);
  if (nonEmptyString(c.symbol_key)) out.symbol_key = String(c.symbol_key).slice(0, 128);
  if (Array.isArray(c.files)) {
    out.files = c.files.filter(nonEmptyString).map((p) => String(p).replace(/\\/g, "/").slice(0, 512)).slice(0, 100);
  }
  if (c.diff !== undefined && c.diff !== null) out.diff = core.redact(String(c.diff)).slice(0, IMPACT_RULES.bounds.maxDiffChars);
  return out;
}

export async function analyzeChange({ project_id, root, change, limit } = {}) {
  if (!validProject(project_id)) return emptyChangeResult("valid project_id required");
  const bounds = IMPACT_RULES.bounds;
  const n = clampLimit(limit, bounds.defaultLimit, bounds.maxArray);
  const degraded = [];
  const errors = [];

  // (1) Freshness.
  let fresh = null;
  try { fresh = await compareIndexFreshness({ project_id, root }); }
  catch (e) { errors.push(`freshness: ${short(e)}`); degraded.push("freshness unavailable"); }
  for (const e of (fresh?.errors || [])) errors.push(`freshness: ${e}`);
  for (const d of (fresh?.degraded || [])) degraded.push(`freshness: ${d}`);
  const stale = fresh ? fresh.stale !== false : true;
  const version_hash = fresh?.current_version_hash || null;

  const safeChange = sanitizeChange(change);
  const change_ref = sha256(stableStringify(safeChange));

  // Changed paths / explicit symbol keys.
  const paths = new Set();
  if (safeChange.path) paths.add(safeChange.path);
  for (const p of safeChange.files) paths.add(p);
  const keys = new Set();
  if (safeChange.symbol_key) keys.add(safeChange.symbol_key);

  // (2) Resolve changed symbols from code_symbol.
  let symbolRows = [];
  try {
    if (keys.size || paths.size) {
      const params = [project_id];
      const clauses = [];
      if (keys.size) { params.push([...keys]); clauses.push(`symbol_key = ANY($${params.length}::text[])`); }
      if (paths.size) { params.push([...paths]); clauses.push(`file_path = ANY($${params.length}::text[])`); }
      params.push(bounds.maxArray);
      const r = await core.dbQuery(
        `SELECT symbol_key, name, file_path, symbol_type, scope, confidence, evidence, extraction_method, start_line
         FROM code_symbol WHERE project_id=$1 AND status='active' AND (${clauses.join(" OR ")})
         ORDER BY file_path, start_line LIMIT $${params.length}`, params,
      );
      symbolRows = r.rows;
    }
  } catch (e) { errors.push(`code_symbol: ${short(e)}`); degraded.push("symbol resolution unavailable"); }

  // (3) Direct = resolved changed symbols.
  const direct = [];
  const directKeys = new Set();
  for (const row of symbolRows) {
    if (direct.length >= n) break;
    directKeys.add(String(row.symbol_key));
    direct.push({
      symbol_key: String(row.symbol_key), name: String(row.name ?? ""), path: String(row.file_path ?? ""),
      symbol_type: String(row.symbol_type ?? "unknown"), scope: String(row.scope ?? "module"),
      category: "direct", confidence: boundConfidence(row.confidence, IMPACT_RULES.confidence.direct),
      extraction_method: String(row.extraction_method ?? "heuristic"),
      evidence: normalizeEvidence(row.evidence, `symbol ${row.name || row.symbol_key} in ${row.file_path}:${row.start_line}`),
      reason: "symbol matches the changed path or the explicitly supplied symbol_key",
    });
  }

  // (4) Transitive: bounded inbound traversal over code_relationship.
  const transitive = [];
  const seen = new Set(directKeys);
  let frontier = [...directKeys];
  let truncated = false;
  for (let depth = 1; depth <= bounds.maxTraverseDepth && frontier.length; depth++) {
    if (seen.size >= bounds.maxTraverseNodes) { truncated = true; break; }
    let inbound = [];
    try {
      for (let i = 0; i < frontier.length; i += 100) {
        const batch = frontier.slice(i, i + 100);
        const r = await core.dbQuery(
          `SELECT source_key, target_key, relationship_type, status, confidence, evidence, source_file, source_line
           FROM code_relationship
           WHERE project_id=$1 AND target_key = ANY($2::text[]) AND status <> 'unresolved'
           ORDER BY source_key LIMIT $3`,
          [project_id, batch, bounds.maxTraverseNodes],
        );
        inbound.push(...r.rows);
      }
    } catch (e) { errors.push(`code_relationship: ${short(e)}`); degraded.push("relationship traversal degraded"); break; }
    const next = [];
    for (const rel of inbound) {
      const k = String(rel.source_key ?? "");
      if (!k || seen.has(k)) continue;
      if (seen.size >= bounds.maxTraverseNodes) { truncated = true; break; }
      seen.add(k);
      next.push(k);
      if (transitive.length >= n) continue;
      transitive.push({
        symbol_key: k, source_key: k, target_key: String(rel.target_key ?? ""), depth,
        relationship_type: String(rel.relationship_type ?? "unknown"),
        path: String(rel.source_file ?? "") || null,
        category: "transitive", confidence: boundConfidence(rel.confidence, IMPACT_RULES.confidence.transitive),
        evidence: normalizeEvidence(rel.evidence, `inbound ${rel.relationship_type}: ${k} -> ${rel.target_key}`),
        reason: `inbound dependent of a changed symbol (depth ${depth}); not proof of an executed call`,
      });
    }
    frontier = next;
  }
  // Enrich transitive keys with symbol names/paths where known (bounded).
  if (transitive.length) {
    try {
      const tkeys = [...new Set(transitive.map((t) => t.symbol_key))].slice(0, bounds.maxArray);
      const r = await core.dbQuery(
        `SELECT symbol_key, name, file_path FROM code_symbol
         WHERE project_id=$1 AND symbol_key = ANY($2::text[]) LIMIT $3`,
        [project_id, tkeys, bounds.maxArray],
      );
      const info = new Map(r.rows.map((row) => [String(row.symbol_key), row]));
      for (const t of transitive) {
        const meta = info.get(t.symbol_key);
        if (meta) { t.name = String(meta.name ?? ""); if (!t.path) t.path = String(meta.file_path ?? "") || null; }
      }
    } catch (e) { errors.push(`symbol_enrich: ${short(e)}`); }
  }

  // (5) Possible: other symbols in the same changed file/module (low confidence).
  const affectedPaths = [...new Set([...paths, ...symbolRows.map((s) => String(s.file_path ?? ""))].filter(Boolean))];
  const possible = [];
  if (affectedPaths.length) {
    try {
      const r = await core.dbQuery(
        `SELECT symbol_key, name, file_path, symbol_type, confidence, evidence, start_line
         FROM code_symbol WHERE project_id=$1 AND status='active' AND file_path = ANY($2::text[])
         ORDER BY file_path, start_line LIMIT $3`,
        [project_id, affectedPaths, bounds.maxArray],
      );
      for (const row of r.rows) {
        if (possible.length >= n) break;
        const k = String(row.symbol_key);
        if (directKeys.has(k) || seen.has(k)) continue;
        possible.push({
          symbol_key: k, name: String(row.name ?? ""), path: String(row.file_path ?? ""),
          category: "possible", confidence: IMPACT_RULES.confidence.possible,
          evidence: normalizeEvidence(row.evidence, `co-located in changed file ${row.file_path} (low confidence)`),
          reason: "shares a changed file/module but has no resolved inbound edge; possible only, not confirmed",
        });
      }
    } catch (e) { errors.push(`code_symbol_possible: ${short(e)}`); degraded.push("possible-symbol scan degraded"); }
  }

  // (6) Unknown: unresolved relationships touching direct keys.
  const unknown = [];
  if (directKeys.size) {
    try {
      const r = await core.dbQuery(
        `SELECT source_key, target_key, relationship_type, status, confidence, evidence, source_file
         FROM code_relationship
         WHERE project_id=$1 AND status='unresolved'
           AND (source_key = ANY($2::text[]) OR target_key = ANY($2::text[]))
         ORDER BY source_key LIMIT $3`,
        [project_id, [...directKeys], bounds.maxArray],
      );
      for (const rel of r.rows) {
        if (unknown.length >= n) break;
        unknown.push({
          source_key: String(rel.source_key ?? ""), target_key: String(rel.target_key ?? ""),
          relationship_type: String(rel.relationship_type ?? "unknown"), status: "unresolved",
          category: "unknown", confidence: boundConfidence(rel.confidence, IMPACT_RULES.confidence.unknown),
          path: String(rel.source_file ?? "") || null,
          evidence: normalizeEvidence(rel.evidence, `unresolved edge ${rel.source_key} -> ${rel.target_key}`),
          reason: "relationship could not be resolved; coverage is explicitly incomplete",
        });
      }
    } catch (e) { errors.push(`code_relationship_unknown: ${short(e)}`); degraded.push("unresolved-edge scan degraded"); }
  }

  // (7) Tests from code_test_map for affected paths/symbols.
  const affectedKeys = [...new Set([...directKeys, ...transitive.map((t) => t.symbol_key)])];
  const tests = [];
  try {
    const r = await core.dbQuery(
      `SELECT test_path, test_name, source_path, source_key, link_type, confidence, evidence
       FROM code_test_map
       WHERE project_id=$1
         AND ((cardinality($2::text[]) > 0 AND source_path = ANY($2::text[]))
              OR (cardinality($3::text[]) > 0 AND source_key = ANY($3::text[])))
       ORDER BY test_path, test_name LIMIT $4`,
      [project_id, affectedPaths, affectedKeys, bounds.maxArray],
    );
    for (const row of r.rows) {
      if (tests.length >= n) break;
      tests.push({
        test_path: String(row.test_path ?? ""), test_name: String(row.test_name ?? ""),
        source_path: String(row.source_path ?? ""), source_key: String(row.source_key ?? ""),
        link_type: String(row.link_type ?? "unmapped"), category: "test",
        confidence: boundConfidence(row.confidence, IMPACT_RULES.confidence.test),
        evidence: normalizeEvidence(row.evidence, `test link ${row.test_path} -> ${row.source_path || row.source_key}`),
        reason: "indexed test-to-code link; advisory only, not executed",
      });
    }
  } catch (e) { errors.push(`code_test_map: ${short(e)}`); degraded.push("test map unavailable"); }

  // (8) Decisions: best-effort dynamic load; never required.
  const decisions = [];
  const decisionIntel = await load("decisionIntel");
  if (decisionIntel?.decisionsForTask) {
    try {
      const refs = new Set();
      for (const p of affectedPaths) {
        for (const part of String(p).split(/[/\\._-]+/)) if (part.length >= 3) refs.add(part.toLowerCase());
      }
      for (const s of symbolRows) {
        const nm = String(s.name ?? "");
        if (nm.length >= 3) refs.add(nm.toLowerCase());
      }
      for (const k of [...directKeys, ...(safeChange.symbol_key ? [safeChange.symbol_key] : [])]) {
        for (const part of String(k).split(/[/\\._-]+/)) if (part.length >= 3) refs.add(part.toLowerCase());
      }
      const query = clip([...refs].join(" "), 200);
      const dres = await decisionIntel.decisionsForTask({ project_id, query, limit: Math.min(n, 10) });
      if (dres?.ok) {
        for (const d of (dres.decisions || [])) {
          if (decisions.length >= Math.min(n, 10)) break;
          decisions.push({
            id: d.id ?? null, title: String(d.title ?? ""), status: String(d.status ?? ""),
            category: "decision", confidence: boundConfidence(d.confidence, IMPACT_RULES.confidence.decision),
            evidence: normalizeEvidence(d.evidence, `decision "${d.title}" (status ${d.status})`),
            reason: "best-effort project decision lookup for the changed references",
          });
        }
      }
    } catch (e) { degraded.push(`decisionIntel: ${short(e)}`); }
  } else degraded.push("decisionIntel unavailable");

  // Aggregate, redacted evidence — never raw diff content.
  const evidence = [
    { source: "index_freshness", excerpt: `indexed=${fresh?.indexed_version_hash || "none"} current=${version_hash || "none"} stale=${stale}`, confidence: 0.6 },
    { source: "change", excerpt: `paths=${[...paths].join(",") || "none"} symbols=${directKeys.size} diff_present=${safeChange.diff !== null}`, confidence: 0.6 },
    ...direct.slice(0, 3).map((d) => ({ source: "direct", excerpt: `${d.name} @ ${d.path}:${d.symbol_key}`, confidence: d.confidence })),
  ].map((e) => ({ ...e, excerpt: clip(e.excerpt, 200) })).slice(0, bounds.maxEvidenceItems * 2);

  const overall = Math.min(IMPACT_RULES.confidence.cap, (direct.length || transitive.length) ? 0.6 : 0.2);
  const result = {
    ok: errors.length === 0,
    change_ref, version_hash, stale,
    direct, transitive, possible, unknown, tests, decisions,
    truncated,
    counts: { direct: direct.length, transitive: transitive.length, possible: possible.length,
      unknown: unknown.length, tests: tests.length, decisions: decisions.length },
    limits: { limit: n, max_nodes: bounds.maxTraverseNodes, max_depth: bounds.maxTraverseDepth },
    project_id,
    evidence,
    degraded, errors,
    claim: "Static source evidence only; not a verified engineering outcome.",
    note: SAFETY_NOTE,
  };

  // Persist (version-aware upsert).
  let persisted = false;
  try {
    await core.withDb((c) => c.query(
      `INSERT INTO code_analysis (id, project_id, analysis_type, change_ref, version_hash, result, confidence, status)
       VALUES ($1,$2,'impact',$3,$4,$5::jsonb,$6,'complete')
       ON CONFLICT (project_id, analysis_type, change_ref, version_hash)
       DO UPDATE SET result = EXCLUDED.result, confidence = EXCLUDED.confidence, status = 'complete'`,
      [crypto.randomUUID(), project_id, change_ref, version_hash || "", JSON.stringify(result), overall],
    ));
    persisted = true;
  } catch (e) { errors.push(`persist: ${short(e)}`); degraded.push("persist unavailable"); }
  result.persisted = persisted;
  result.ok = errors.length === 0;

  await audit("p25.impact", project_id, {
    change_ref, version_hash, stale, ok: result.ok,
    counts: result.counts, persisted,
  });

  return result;
}

// ---------------------------------------------------------------------------
// getImpact
// ---------------------------------------------------------------------------

export async function getImpact({ project_id, change_ref, version_hash } = {}) {
  if (!validProject(project_id) || !nonEmptyString(change_ref)) {
    return { ok: false, found: false, result: null, reason: "valid project_id and change_ref required", note: SAFETY_NOTE };
  }
  try {
    const r = await core.dbQuery(
      `SELECT result, confidence, status, created_at FROM code_analysis
       WHERE project_id=$1 AND analysis_type='impact' AND change_ref=$2
         AND ($3::text IS NULL OR version_hash=$3)
       ORDER BY created_at DESC LIMIT 1`,
      [project_id, String(change_ref).slice(0, 200), version_hash || null],
    );
    if (!r.rowCount) return { ok: false, found: false, result: null, reason: "no persisted impact", note: SAFETY_NOTE };
    const obj = r.rows[0].result && typeof r.rows[0].result === "object" ? r.rows[0].result : {};
    return {
      ...obj, found: true, result: obj,
      stored_confidence: r.rows[0].confidence, stored_status: r.rows[0].status,
      note: obj.note || SAFETY_NOTE,
    };
  } catch (e) {
    return { ok: false, found: false, result: null, reason: "impact unavailable", degraded: [short(e)], note: SAFETY_NOTE };
  }
}

export default {
  IMPACT_RULES, SAFETY_NOTE, compareIndexFreshness, analyzeChange, getImpact,
};
