// Phase 17 capability A — Project Context Intelligence.
//
// Deterministic, additive per-project context facts with provenance and history.
// Invariants:
//   - Facts come ONLY from supplied evidence. This module never scans the file
//     system and never claims that files/directories were inspected.
//   - No LLM calls. No destructive SQL (no DELETE / TRUNCATE / DROP).
//   - Project-scoped writes and reads only; the '_global' sentinel is rejected
//     on every path (fail closed).
//   - A changed fact is never silently overwritten: its previous value is
//     appended to the evidence array as a history record before the row updates.
//   - All queries are bounded by LIMIT and use the (project_id, ...) indexes.

import * as core from "./core.js";
import { GLOBAL_PROJECT_ID } from "./memoryScope.js";

const ALLOWED_STATUSES = new Set([
  "observed", "inferred", "verified", "uncertain", "stale", "superseded", "contradicted",
]);

const MAX_FACTS_PER_UPSERT = 100;
const MAX_EVIDENCE_PER_ITEM = 20;
const MAX_EVIDENCE_STORED = 100;
const MAX_MAP_KEYS = 1000;
const MAX_TEXT = 2000;
const MAX_LIST_LIMIT = 200;

// Optional read cache. Exposed only so callers can clear it; no correctness depends on it.
const cache = new Map();
export function clearContextCache() { cache.clear(); }

function ok(fields) { return { ok: true, ...fields }; }
function fail(code, message) { return { ok: false, error: { code, message } }; }

// Never leak DB internals, SQL, stack traces or secrets to the caller.
function failSafe() {
  return fail("internal_error", "project context request could not be completed");
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// A real project is a non-empty string that is not the '_global' sentinel.
function validProjectId(project_id) {
  if (typeof project_id !== "string") return false;
  const s = project_id.trim();
  return s.length > 0 && s !== GLOBAL_PROJECT_ID;
}

function normText(v) {
  if (typeof v !== "string") return null;
  const s = core.redact(v).trim().slice(0, MAX_TEXT);
  return s.length ? s : null;
}

// Canonical serialization so value comparisons are independent of object key order.
function stable(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

// Redact credentials before a value/evidence payload is persisted.
function safeJson(value) {
  try {
    return JSON.parse(core.redact(JSON.stringify(value === undefined ? null : value)));
  } catch {
    return null;
  }
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  const out = [];
  for (const item of evidence.slice(0, MAX_EVIDENCE_PER_ITEM)) {
    const safe = safeJson(item);
    if (safe !== null) out.push(safe);
  }
  return out;
}

function capEvidence(arr) {
  return arr.length > MAX_EVIDENCE_STORED ? arr.slice(arr.length - MAX_EVIDENCE_STORED) : arr;
}

function clampConfidence(c) {
  if (c === undefined || c === null || c === "") return null;
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeFacts(facts, topSource, topSession) {
  const normalized = [];
  const seen = new Set();
  for (const raw of facts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: fail("invalid_fact", "each fact must be an object") };
    }
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key || key.length > 256) {
      return { error: fail("invalid_fact", "fact key must be a non-empty string of at most 256 characters") };
    }
    const status = raw.status === undefined || raw.status === null || raw.status === ""
      ? "observed" : raw.status;
    if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
      return { error: fail("invalid_fact", "fact status is not one of the allowed values") };
    }
    const value = safeJson(raw.value);
    const dedupe = `${JSON.stringify(key)}|${stable(value)}|${JSON.stringify(status)}`;
    if (seen.has(dedupe)) {
      // Identical key + value + status in the same request: mark skipped, never write twice.
      normalized.push({ key, duplicate: true });
      continue;
    }
    seen.add(dedupe);
    normalized.push({
      key,
      value,
      status,
      confidence: clampConfidence(raw.confidence),
      evidence: normalizeEvidence(raw.evidence),
      // Fact-level source wins; top-level source/session is the fallback.
      source: normText(raw.source) ?? topSource,
      source_session: normText(raw.source_session) ?? topSession,
      duplicate: false,
    });
  }
  return { facts: normalized };
}

async function withTx(fn) {
  return core.withDb(async (client) => {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  });
}

async function auditSafe(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* auditing must never break the primary operation */ }
}

function publicRow(row, outcome, previous) {
  const out = {
    key: row.fact_key,
    value: row.value ?? null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    status: row.status,
    confidence: row.confidence ?? null,
    source: row.source ?? null,
    source_session: row.source_session ?? null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    outcome,
  };
  if (previous) out.previous = previous;
  return out;
}

/**
 * Create/refresh a project's compact context and upsert its facts.
 * Facts are keyed by (project_id, fact_key). A changed fact keeps its previous
 * value inside the evidence history; nothing is ever deleted.
 */
export async function upsertProjectContext(input) {
  try {
    const src = asObject(input);
    const { project_id } = src;
    if (!validProjectId(project_id)) {
      return fail("invalid_project_id", "a non-empty, project-scoped project_id is required");
    }
    const pid = project_id.trim();

    const factsIn = src.facts === undefined || src.facts === null ? [] : src.facts;
    if (!Array.isArray(factsIn)) return fail("invalid_input", "facts must be an array");
    if (factsIn.length > MAX_FACTS_PER_UPSERT) {
      return fail("invalid_input", "too many facts supplied in a single request");
    }
    const summary = normText(src.summary);
    const topSource = normText(src.source);
    const topSession = normText(src.source_session);

    const norm = normalizeFacts(factsIn, topSource, topSession);
    if (norm.error) return norm.error;
    const facts = norm.facts;

    const result = await withTx(async (client) => {
      // Ensure the compact context row exists. ON CONFLICT DO NOTHING preserves history.
      const ins = await client.query(
        `INSERT INTO project_context (project_id, summary, facts, status, created_at, updated_at)
         VALUES ($1, $2, '{}'::jsonb, 'active', now(), now())
         ON CONFLICT (project_id) DO NOTHING
         RETURNING project_id`,
        [pid, summary || ""],
      );
      const contextCreated = ins.rowCount > 0;

      let created = 0, updated = 0, skipped = 0;
      const outcomes = new Map();

      for (const f of facts) {
        const cur = await client.query(
          `SELECT id, value, status, source, evidence FROM project_context_fact
           WHERE project_id=$1 AND fact_key=$2 LIMIT 1`,
          [pid, f.key],
        );
        const row = cur.rows[0];

        if (f.duplicate) {
          // Exact duplicate within this request: never touch storage.
          skipped += 1;
          if (!outcomes.has(f.key)) outcomes.set(f.key, { outcome: "skipped" });
          continue;
        }

        if (!row) {
          await client.query(
            `INSERT INTO project_context_fact
               (project_id, fact_key, value, evidence, status, confidence, source,
                source_session, created_at, updated_at)
             VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,now(),now())`,
            [pid, f.key, JSON.stringify(f.value), JSON.stringify(f.evidence),
             f.status, f.confidence, f.source, f.source_session],
          );
          created += 1;
          outcomes.set(f.key, { outcome: "created" });
          continue;
        }

        if (stable(row.value) === stable(f.value) && row.status === f.status) {
          // Idempotent no-op: identical key + value + status already stored.
          skipped += 1;
          if (!outcomes.has(f.key)) outcomes.set(f.key, { outcome: "skipped" });
          continue;
        }

        // Preserve the old value as an evidence history record before updating.
        const previous = {
          value: row.value ?? null,
          status: row.status,
          source: row.source ?? null,
          changed_at: new Date().toISOString(),
        };
        const priorEvidence = Array.isArray(row.evidence) ? row.evidence : [];
        const merged = capEvidence([...priorEvidence, previous, ...f.evidence]);
        await client.query(
          `UPDATE project_context_fact
              SET value=$2::jsonb, evidence=$3::jsonb, status=$4, confidence=$5,
                  source=$6, source_session=$7, updated_at=now()
            WHERE id=$1`,
          [row.id, JSON.stringify(f.value), JSON.stringify(merged), f.status,
           f.confidence, f.source, f.source_session],
        );
        updated += 1;
        outcomes.set(f.key, { outcome: "updated", previous });
      }

      // Rebuild the compact facts map from current fact rows (bounded, project-indexed).
      const current = await client.query(
        `SELECT fact_key, value, evidence, status, confidence, source, source_session, created_at, updated_at
         FROM project_context_fact
         WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2`,
        [pid, MAX_MAP_KEYS],
      );
      const map = {};
      const byKey = new Map();
      for (const r of current.rows) {
        map[r.fact_key] = r.value;
        byKey.set(r.fact_key, r);
      }

      // Refresh summary (when supplied) and timestamp; never delete anything.
      await client.query(
        `UPDATE project_context SET facts=$2::jsonb, summary=COALESCE($3, summary), updated_at=now()
         WHERE project_id=$1`,
        [pid, JSON.stringify(map), summary],
      );

      const outFacts = [];
      for (const f of facts) {
        const meta = outcomes.get(f.key) || { outcome: "skipped" };
        const row = byKey.get(f.key);
        if (row) outFacts.push(publicRow(row, meta.outcome, meta.previous));
        else outFacts.push({ key: f.key, outcome: meta.outcome, value: f.value ?? null });
      }

      return { contextCreated, created, updated, skipped, outFacts, total: current.rows.length };
    });

    await auditSafe("project_context.upsert", pid, {
      context_created: result.contextCreated,
      facts_created: result.created,
      facts_updated: result.updated,
      facts_skipped: result.skipped,
      fact_total: result.total,
    });

    return ok({
      project_id: pid,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      facts: result.outFacts,
    });
  } catch (e) {
    return failSafe(e);
  }
}

/** Read a project's compact context. Project-scoped SELECT only. */
export async function getProjectContext(input) {
  try {
    const src = asObject(input);
    const { project_id } = src;
    if (!validProjectId(project_id)) {
      return fail("invalid_project_id", "a non-empty, project-scoped project_id is required");
    }
    const pid = project_id.trim();
    const n = Number.isInteger(src.limit) && src.limit >= 0
      ? Math.min(src.limit, MAX_MAP_KEYS) : 100;

    const r = await core.dbQuery(
      "SELECT summary, facts, updated_at FROM project_context WHERE project_id=$1 LIMIT 1",
      [pid],
    );
    const row = r.rows[0];
    if (!row) {
      return ok({ project_id: pid, summary: "", facts: {}, updated_at: null, found: false });
    }
    const stored = row.facts && typeof row.facts === "object" && !Array.isArray(row.facts)
      ? row.facts : {};
    const facts = {};
    let i = 0;
    for (const [k, v] of Object.entries(stored)) {
      if (i >= n) break;
      facts[k] = v;
      i += 1;
    }
    return ok({
      project_id: pid,
      summary: typeof row.summary === "string" ? row.summary : "",
      facts,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      found: true,
    });
  } catch (e) {
    return failSafe(e);
  }
}

/** List full fact rows (with evidence/provenance) for a project. Bounded. */
export async function listProjectContextFacts(input) {
  try {
    const src = asObject(input);
    const { project_id, status } = src;
    if (!validProjectId(project_id)) {
      return fail("invalid_project_id", "a non-empty, project-scoped project_id is required");
    }
    const pid = project_id.trim();
    if (status !== undefined && status !== null) {
      if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
        return fail("invalid_status", "status filter is not one of the allowed values");
      }
    }
    const n = Number.isInteger(src.limit) && src.limit >= 0
      ? Math.min(src.limit, MAX_LIST_LIMIT) : 50;

    const r = await core.dbQuery(
      `SELECT fact_key, value, evidence, status, confidence, source, source_session, created_at, updated_at
       FROM project_context_fact
       WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY updated_at DESC LIMIT $3`,
      [pid, status || null, n],
    );
    const items = r.rows.map((row) => ({
      key: row.fact_key,
      value: row.value ?? null,
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
      status: row.status,
      confidence: row.confidence ?? null,
      source: row.source ?? null,
      source_session: row.source_session ?? null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    }));
    return ok({ items, count: items.length });
  } catch (e) {
    return failSafe(e);
  }
}

/** Mark a fact superseded with a reason in evidence. Never deletes the row. */
export async function supersedeFact(input) {
  try {
    const src = asObject(input);
    const { project_id, fact_key } = src;
    if (!validProjectId(project_id)) {
      return fail("invalid_project_id", "a non-empty, project-scoped project_id is required");
    }
    const pid = project_id.trim();
    if (typeof fact_key !== "string" || !fact_key.trim()) {
      return fail("invalid_fact_key", "fact_key must be a non-empty string");
    }
    const key = fact_key.trim();
    const reasonText = normText(src.reason);
    const evidence = normalizeEvidence(src.evidence);

    const result = await withTx(async (client) => {
      const cur = await client.query(
        `SELECT id, status, source, evidence FROM project_context_fact
         WHERE project_id=$1 AND fact_key=$2 LIMIT 1`,
        [pid, key],
      );
      const row = cur.rows[0];
      if (!row) return { found: false, superseded: false };

      const event = {
        event: "superseded",
        reason: reasonText,
        status: "superseded",
        previous_status: row.status,
        source: row.source ?? null,
        changed_at: new Date().toISOString(),
        evidence,
      };
      const prior = Array.isArray(row.evidence) ? row.evidence : [];
      await client.query(
        `UPDATE project_context_fact
            SET status='superseded', evidence=$2::jsonb, updated_at=now()
          WHERE id=$1`,
        [row.id, JSON.stringify(capEvidence([...prior, event]))],
      );
      return { found: true, superseded: row.status !== "superseded" };
    });

    await auditSafe("project_context.supersede", pid, {
      fact_key: key,
      superseded: result.superseded,
    });
    return ok({ superseded: result.superseded, found: result.found });
  } catch (e) {
    return failSafe(e);
  }
}
