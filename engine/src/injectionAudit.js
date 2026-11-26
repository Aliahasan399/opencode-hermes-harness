// Phase 18 workstream E — injection observability + strictly isolated injection cache.
//
// Design contract (read-only, fail-soft):
//   - recordInjection writes ONE content-free row to intelligence_audit_events with
//     track='context', action='injection', resource=<attributable project id>.
//     The `detail` jsonb holds ONLY counts, ids, categories, reason tokens, numbers
//     and booleans. Item text, memory content, titles, prompts, API keys, env values
//     and arbitrary free-form strings are NEVER persisted here.
//   - injectionReport is a bounded, project-scoped, read-only SELECT. It can never
//     return another project's rows and fails closed on an invalid project id.
//   - createInjectionCache is a pure in-memory, namespaced, TTL + size-bounded cache.
//     Its namespace always includes project_id, so Project A can never read
//     Project B's entry even when every other key component is identical.
//
// Both audit functions NEVER throw: any failure returns { ok:false, reason } so an
// observability write can never break the context-injection path it observes.

import * as core from "./core.js";

const AUDIT_TRACK = "context";
const AUDIT_ACTION = "injection";
const GLOBAL_PROJECT_ID = "_global";

// Only a deliberately narrow character set may reach the audit row. Anything that
// does not match (control characters, brackets from a redacted secret, quotes, etc.)
// is dropped rather than stored. core.redact is ALWAYS applied first, defensively.
const SAFE_TEXT_RE = /^[A-Za-z0-9 ._\-:/@]{1,256}$/;

function safeText(value, max = 128) {
  if (value === undefined || value === null) return null;
  let s;
  try {
    s = core.redact(String(value));
  } catch {
    return null;
  }
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !SAFE_TEXT_RE.test(s)) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function safeCount(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 1e12);
}

const OUTCOMES = new Set([
  "ok", "partial", "error", "timeout", "degraded", "empty", "fallback", "skipped",
]);
function safeOutcome(value) {
  const s = safeText(value, 32);
  return s && OUTCOMES.has(s) ? s : "other";
}

const CATEGORIES = new Set([
  "implementation", "bugfix", "debugging", "architecture", "refactoring",
  "database", "api", "testing", "security", "documentation", "planning",
  "research", "general",
]);
function safeCategory(value) {
  const s = safeText(value, 32);
  return s && CATEGORIES.has(s) ? s : null;
}

function safeTokens(value, maxItems = 20, maxLen = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= maxItems) break;
    const token = safeText(item, maxLen);
    if (token) out.push(token);
  }
  return out;
}

// Writes must be attributable: a non-empty, non-global, safe-text project id.
function writeProject(project_id) {
  if (typeof project_id !== "string" || project_id.length === 0 || project_id === GLOBAL_PROJECT_ID) return null;
  return safeText(project_id, 128);
}

// Reads require a concrete project scope as well; '_global' is permitted here but
// (by construction) has no injection rows, so it returns an empty, isolated result.
function readProject(project_id) {
  if (typeof project_id !== "string" || project_id.length === 0) return null;
  return safeText(project_id, 128);
}

/**
 * Record a single context-injection decision. Content-free by construction.
 * @returns {Promise<{ok:boolean, id?:*, reason?:string}>}
 */
export async function recordInjection({
  request_id,
  session_id,
  project_id,
  task = {},
  candidates = 0,
  selected = 0,
  rejected = 0,
  reject_reasons = [],
  budget = 0,
  estimated_tokens = 0,
  duration_ms = 0,
  outcome = "ok",
  degraded = [],
  cache_hit = false,
} = {}) {
  try {
    const resource = writeProject(project_id);
    if (!resource) return { ok: false, reason: "invalid_project_id" };

    const category = safeCategory(task && typeof task === "object" ? task.category : undefined);
    const detail = {
      request_id: safeText(request_id, 128),
      session_id: safeText(session_id, 128),
      project_id: resource,
      category,
      candidates: safeCount(candidates),
      selected: safeCount(selected),
      rejected: safeCount(rejected),
      reject_reasons: safeTokens(reject_reasons),
      budget: safeNumber(budget),
      estimated_tokens: safeNumber(estimated_tokens),
      duration_ms: safeNumber(duration_ms),
      outcome: safeOutcome(outcome),
      degraded: safeTokens(degraded),
      cache_hit: cache_hit === true,
    };

    const { rows } = await core.dbQuery(
      `INSERT INTO intelligence_audit_events (track, action, resource, detail)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [AUDIT_TRACK, AUDIT_ACTION, resource, JSON.stringify(detail)],
    );
    return { ok: true, id: rows[0]?.id ?? null };
  } catch {
    // Injection observability must never break the caller.
    return { ok: false, reason: "audit_write_failed" };
  }
}

/**
 * Bounded, project-scoped, content-free report of recorded injection decisions.
 * @returns {Promise<{ok:boolean, items:Array, count:number, reason?:string}>}
 */
export async function injectionReport({ project_id, session_id, limit = 50 } = {}) {
  try {
    const resource = readProject(project_id);
    if (!resource) return { ok: false, items: [], count: 0, reason: "invalid_project_id" };

    const n = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 200) : 50;
    const session = safeText(session_id, 128);

    const { rows } = await core.dbQuery(
      `SELECT id, resource, detail, created_at
         FROM intelligence_audit_events
        WHERE track = $1 AND action = $2 AND resource = $3
          AND ($4::text IS NULL OR detail->>'session_id' = $4)
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [AUDIT_TRACK, AUDIT_ACTION, resource, session, n],
    );
    return { ok: true, items: rows, count: rows.length };
  } catch {
    return { ok: false, items: [], count: 0, reason: "audit_read_failed" };
  }
}

/**
 * Pure in-memory, namespaced, TTL + size-bounded cache for injection results.
 * No timers are created; expiry is lazy. No I/O, no network, no LLM.
 */
export function createInjectionCache({ max = 200, ttl_ms = 60000 } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.max(1, Math.floor(max)) : 200;
  const ttl = Number.isFinite(ttl_ms) && ttl_ms >= 0 ? ttl_ms : 60000;

  // Map preserves insertion order: the first key is the oldest and is evicted first.
  const store = new Map(); // namespacedKey -> { value, expiresAt }
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function normalizeQuery(query) {
    return String(query ?? "").trim().toLowerCase();
  }

  function makeKey(key) {
    const k = key && typeof key === "object" ? key : {};
    return JSON.stringify([
      String(k.project_id ?? ""),
      String(k.session_id ?? ""),
      normalizeQuery(k.query),
      String(k.memory_version ?? ""),
    ]);
  }

  function clone(value) {
    if (value === null || typeof value !== "object") return value;
    try { return structuredClone(value); }
    catch {
      try { return JSON.parse(JSON.stringify(value)); }
      catch { return value; }
    }
  }

  function pruneExpired() {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.expiresAt <= now) store.delete(k);
    }
  }

  function get(key) {
    const k = makeKey(key);
    const entry = store.get(k);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) store.delete(k);
      misses += 1;
      return undefined;
    }
    hits += 1;
    return clone(entry.value);
  }

  function set(key, value) {
    const k = makeKey(key);
    if (store.has(k)) store.delete(k);
    while (store.size >= cap) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
      evictions += 1;
    }
    store.set(k, { value: clone(value), expiresAt: Date.now() + ttl });
  }

  function clear() {
    store.clear();
  }

  function stats() {
    pruneExpired();
    return { size: store.size, hits, misses, evictions };
  }

  // The cache never invents or transforms values; callers must not put secrets in.
  // Defensive copies on both set() and get() prevent external mutation of cached data.
  return { get, set, clear, stats };
}
