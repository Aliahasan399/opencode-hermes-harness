// Core memory engine: configuration, redaction, storage, embeddings, hybrid retrieval.
// Everything is local; no paid external API is used.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { scopeFilter } from "./memoryScope.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:"), "..", "..");
export const MEMORY_ROOT = ROOT;

export function loadEnv(file = path.join(ROOT, ".env")) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
export const config = {
  db: {
    host: process.env.MEMORY_DB_HOST || "127.0.0.1",
    port: Number(process.env.MEMORY_DB_PORT || env.MEMORY_DB_PORT || 55432),
    user: process.env.MEMORY_DB_USER || env.MEMORY_DB_USER || "opencode_memory",
    password: process.env.MEMORY_DB_PASSWORD || env.MEMORY_DB_PASSWORD || "",
    database: process.env.MEMORY_DB_NAME || env.MEMORY_DB_NAME || "opencode_memory",
  },
  embed: {
    url: process.env.MEMORY_EMBED_URL || "http://127.0.0.1:11434",
    model: process.env.MEMORY_EMBED_MODEL || env.MEMORY_EMBED_MODEL || "nomic-embed-text",
    dims: Number(process.env.MEMORY_EMBED_DIMS || env.MEMORY_EMBED_DIMS || 768),
  },
  budget: {
    maxContextChars: 6000,
    maxMemories: 8,
  },
};

// --- Secret redaction -----------------------------------------------------
const REDACTORS = [
  { re: /(sk-[A-Za-z0-9_\-]{16,})/g, tag: "[REDACTED_API_KEY]" },
  { re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, tag: "[REDACTED_GITHUB_TOKEN]" },
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}/g, tag: "[REDACTED_AWS_KEY]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, tag: "[REDACTED_PRIVATE_KEY]" },
  { re: /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?([^\s"',;]{6,})/gi, tag: "$1=[REDACTED]" },
  { re: /\bGWAR-[A-Z0-9-]{10,}/g, tag: "[REDACTED_KEY]" },
];

export function redact(text) {
  let out = String(text ?? "");
  for (const { re, tag } of REDACTORS) out = out.replace(re, tag);
  return out;
}
export function looksSensitive(text) {
  const s = String(text ?? "");
  return REDACTORS.some(({ re }) => { re.lastIndex = 0; return re.test(s); });
}

// --- Database -------------------------------------------------------------
const pool = new pg.Pool({ ...config.db, max: 5, idleTimeoutMillis: 30000 });

export async function withDb(fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
export async function dbQuery(text, params = []) {
  return withDb((c) => c.query(text, params));
}
export async function health() {
  const r = await dbQuery("SELECT 1 AS ok, extname FROM pg_extension WHERE extname='vector'");
  return { ok: true, pgvector: r.rows.some((x) => x.extname === "vector") };
}

// --- Embeddings -----------------------------------------------------------
let embedNextTry = 0; // epoch ms; fail-open, but recover after a short cool-down
export async function embed(text) {
  if (Date.now() < embedNextTry) return null;
  try {
    const res = await fetch(`${config.embed.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.embed.model, input: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const json = await res.json();
    const vec = Array.isArray(json.embeddings?.[0]) ? json.embeddings[0] : null;
    return vec && vec.length === config.embed.dims ? vec : null;
  } catch {
    // Fail-open without permanently disabling embeddings: a transient timeout under
    // concurrent load must not degrade semantic search for the rest of the process.
    embedNextTry = Date.now() + 5000;
    return null;
  }
}
export function vectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

// --- Memory operations ----------------------------------------------------
const FIELDS = "id, layer, project_id, title, content, category, tags, source_session, source_kind, confidence, importance, verified, created_at, updated_at, valid_until, version, metadata, lifecycle, quality_score, useful_count, provenance, global_eligible, quality_explanation";

export async function saveMemory(input) {
  const content = redact(input.content);
  if (looksSensitive(content)) throw new Error("refused: content still contains credential-like data after redaction");
  const vec = input.noEmbed ? null : await embed(`${input.title}\n${content}`);
  const r = await dbQuery(
    `INSERT INTO memory (layer, project_id, title, content, category, tags, source_session, source_kind,
       confidence, importance, verified, metadata, embedding, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14)
     RETURNING ${FIELDS}`,
    [
      input.layer, input.project_id || "_global", input.title, content,
      input.category || null, input.tags || [], input.source_session || null,
      input.source_kind || "observed", input.confidence ?? 0.5, input.importance ?? 0.5,
      input.verified ?? false, input.metadata || {}, vec ? vectorLiteral(vec) : null,
      ["production","test_fixture","unknown"].includes(input.provenance) ? input.provenance : "unknown",
    ],
  );
  return r.rows[0];
}

export async function updateMemory(id, patch, reason = "update") {
  return withDb(async (c) => {
    const cur = await c.query(`SELECT ${FIELDS}, embedding FROM memory WHERE id=$1`, [id]);
    if (!cur.rowCount) return null;
    const old = cur.rows[0];
    const next = {
      title: patch.title ?? old.title,
      content: redact(patch.content ?? old.content),
      layer: patch.layer ?? old.layer,
      project_id: patch.project_id ?? old.project_id,
      confidence: patch.confidence ?? old.confidence,
      importance: patch.importance ?? old.importance,
      verified: patch.verified ?? old.verified,
      tags: patch.tags ?? old.tags,
      valid_until: patch.valid_until ?? old.valid_until,
    };
    if (looksSensitive(next.content)) throw new Error("refused: credential-like data in update");
    let vec = old.embedding;
    if (patch.content || patch.title) vec = await embed(`${next.title}\n${next.content}`);
    await c.query(
      `INSERT INTO memory_history (memory_id, version, content, reason) VALUES ($1,$2,$3,$4)`,
      [id, old.version, old.content, reason],
    );
    const r = await c.query(
      `UPDATE memory SET title=$2, content=$3, layer=$4, project_id=$5, confidence=$6,
        importance=$7, verified=$8, tags=$9, valid_until=$10, version=version+1,
        embedding=$11::vector WHERE id=$1 RETURNING ${FIELDS}`,
      [id, next.title, next.content, next.layer, next.project_id, next.confidence,
       next.importance, next.verified, next.tags, next.valid_until,
       vec ? vectorLiteral(vec) : null],
    );
    await c.query(`INSERT INTO audit_log (action, resource, detail) VALUES ('memory.update',$1,$2)`,
      [id, { reason }]);
    return r.rows[0];
  });
}

export async function getMemory(id) {
  const r = await dbQuery(`SELECT ${FIELDS} FROM memory WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

export async function listMemories({ layer, project_id, limit = 50, offset = 0 } = {}) {
  // No project => administrative listing (all rows). With a project => strictly scoped
  // to that project plus explicitly eligible global knowledge.
  const scope = project_id ? scopeFilter({ project_id, startIndex: 2 }) : { sql: "TRUE", params: [] };
  const r = await dbQuery(
    `SELECT ${FIELDS} FROM memory
     WHERE ($1::text IS NULL OR layer=$1)
       AND ${scope.sql}
     ORDER BY importance DESC, updated_at DESC LIMIT $${scope.params.length + 2} OFFSET $${scope.params.length + 3}`,
    [layer || null, ...scope.params, Math.min(limit, 200), offset],
  );
  return r.rows;
}

export async function deleteMemory(id, hard = false) {
  if (hard) {
    const r = await dbQuery("DELETE FROM memory WHERE id=$1", [id]);
    await dbQuery("INSERT INTO audit_log (action,resource,detail) VALUES ('memory.delete_hard',$1,'{}')", [id]);
    return { deleted: r.rowCount };
  }
  const r = await dbQuery("UPDATE memory SET valid_until=now() WHERE id=$1", [id]);
  await dbQuery("INSERT INTO audit_log (action,resource,detail) VALUES ('memory.delete_soft',$1,'{}')", [id]);
  return { expired: r.rowCount };
}

export async function findDuplicate(title, content, project_id) {
  const r = await dbQuery(
    `SELECT id, title, similarity(content, $1) AS sim FROM memory
     WHERE project_id=$2 AND similarity(content, $1) > 0.86 ORDER BY sim DESC LIMIT 1`,
    [content, project_id || "_global"],
  );
  return r.rows[0] || null;
}

// --- Hybrid retrieval (vector + full text, RRF fused) ---------------------
export async function searchMemory({ query, project_id, limit = 8, layer } = {}) {
  const vec = await embed(query);
  const scope = scopeFilter({ project_id, startIndex: 3 });
  const params = [query, Math.min(limit * 2, 30), ...scope.params, layer || null];
  const fts = await dbQuery(
    `SELECT ${FIELDS}, ts_rank_cd(to_tsvector('english', title||' '||content),
        websearch_to_tsquery('english',$1)) AS score
     FROM memory
     WHERE ${scope.sql}
       AND ($5::text IS NULL OR layer=$5)
       AND (valid_until IS NULL OR valid_until > now())
       AND to_tsvector('english', title||' '||content) @@ websearch_to_tsquery('english',$1)
     ORDER BY score DESC LIMIT $2`,
    params,
  );
  let vectorRows = [];
  if (vec) {
    vectorRows = (await dbQuery(
      `SELECT ${FIELDS}, 1-(embedding <=> $1::vector) AS score
       FROM memory
       WHERE embedding IS NOT NULL
         AND ${scope.sql}
         AND ($5::text IS NULL OR layer=$5)
         AND (valid_until IS NULL OR valid_until > now())
       AND (1 - (embedding <=> $1::vector)) >= 0.5
        ORDER BY embedding <=> $1::vector LIMIT $2`,
      [vectorLiteral(vec), Math.min(limit * 2, 30), ...scope.params, layer || null],
    )).rows;
  }
  const scores = new Map();
  const put = (rows) => rows.forEach((row, i) => {
    const prev = scores.get(row.id) || { row, rrf: 0 };
    prev.rrf += 1 / (60 + i + 1);
    scores.set(row.id, prev);
  });
  put(fts.rows); put(vectorRows);
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, Math.min(limit, 20))
    .map(({ row, rrf }) => ({ ...row, score: Number(rrf.toFixed(6)) }));
}

export async function sessionSearch({ query, project_id, limit = 10 } = {}) {
  const r = await dbQuery(
    `SELECT id, project_id, title, summary, time_updated FROM session_index
     WHERE ($2::text IS NULL OR project_id=$2)
       AND (to_tsvector('english', coalesce(title,'')||' '||coalesce(summary,'')) @@ websearch_to_tsquery('english',$1)
            OR id ILIKE '%'||$1||'%')
     ORDER BY time_updated DESC LIMIT $3`,
    [query, project_id || null, Math.min(limit, 50)],
  );
  return r.rows;
}

export async function projectContext(project_id) {
  const r = await dbQuery(
    `SELECT layer, title, content, importance, confidence, updated_at FROM memory
     WHERE project_id=$1 AND (valid_until IS NULL OR valid_until>now())
     ORDER BY importance DESC, confidence DESC LIMIT 12`,
    [project_id],
  );
  return r.rows;
}

export function compactContext(memories, budget = config.budget) {
  const lines = [];
  let chars = 0;
  for (const m of memories.slice(0, budget.maxMemories)) {
    const line = `- [${m.layer}${m.project_id && m.project_id !== "_global" ? ":" + m.project_id : ""}] ${m.title}: ${m.content.replace(/\s+/g, " ").slice(0, 320)}`;
    if (chars + line.length > budget.maxContextChars) break;
    lines.push(line); chars += line.length + 1;
  }
  return lines.join("\n");
}

export async function audit(action, resource, detail = {}) {
  await dbQuery("INSERT INTO audit_log (action,resource,detail) VALUES ($1,$2,$3)", [action, resource, detail]);
}

export async function listSessions({ project_id, limit = 50, offset = 0 } = {}) {
  return (await dbQuery(
    `SELECT id, project_id, directory, title, summary, message_count, time_created, time_updated, imported_at
     FROM session_index WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY time_updated DESC NULLS LAST LIMIT $2 OFFSET $3`,
    [project_id || null, Math.min(limit, 200), offset],
  )).rows;
}

export async function sessionDetail(id) {
  const s = await dbQuery(`SELECT * FROM session_index WHERE id=$1`, [id]);
  if (!s.rowCount) return null;
  const memories = await dbQuery(`SELECT ${FIELDS} FROM memory WHERE source_session=$1`, [id]);
  const evidence = await dbQuery(
    `SELECT p.id, p.kind, p.description, p.confidence, p.occurrences FROM pattern p
     JOIN pattern_evidence pe ON pe.pattern_id=p.id WHERE pe.session_id=$1`, [id],
  );
  return { ...s.rows[0], memories: memories.rows, patterns: evidence.rows };
}

export async function close() { await pool.end(); }
