// Deterministic Phase 12.1 usefulness signal: "error did not recur after retrieval".
//
// This module NEVER claims helpfulness. It records a narrow, evidence-backed
// observation only when all of the following are true in the same durable session:
//   1. an error-pattern line occurred BEFORE the retrieval event,
//   2. no error-pattern line occurs AFTER the retrieval event, and
//   3. the retrieved memory's distinctive content is referenced in a later line.
// Absence of evidence is never treated as evidence of usefulness.
//
// ---------------------------------------------------------------------------
// SCHEMA UPDATE REQUIRED (main agent must apply; this module does NOT alter the DB)
// ---------------------------------------------------------------------------
// The live constraint on memory_usefulness_observations.signal currently is:
//   CHECK (signal IN ('used','not_used','helpful','unhelpful','unknown','observed_usage'))
// It does NOT permit 'error_not_recurred'. Apply the additive migration already
// present at E:\OpenCodeData\memory\init\010-usefulness-signal.sql, i.e.:
//
//   ALTER TABLE memory_usefulness_observations
//     DROP CONSTRAINT IF EXISTS memory_usefulness_observations_signal_check;
//   ALTER TABLE memory_usefulness_observations
//     ADD CONSTRAINT memory_usefulness_observations_signal_check
//     CHECK (signal IN ('used','not_used','helpful','unhelpful','unknown','observed_usage','error_not_recurred'));
//
// Until that is applied, observeErrorNonRecurrence still performs the full
// read-only analysis and reports { ok:false, kind:'schema_update_required' }
// (with `would_observe` showing the detection result) instead of throwing or
// fabricating rows.
// ---------------------------------------------------------------------------

import * as core from "./core.js";
import { readLines } from "./transcript.js";

const SIGNAL = "error_not_recurred";
const CLAIM = "deterministic error-non-recurrence observation only — no helpfulness claim inferred";

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Error vocabulary from the task, plus simple plurals. Word boundaries avoid
// matching "errors" inside unrelated identifiers.
const ERROR_RE = /\b(failed|failures?|error|errors|exception|exceptions|traceback|tracebacks|ব্যর্থ|ত্রুটি)\b/i;
// Guard against test summaries such as "0 failed" / "failures: 0" counting as errors.
const NEGATED_ERROR_RE = /\b(?:0|zero|no|without)\s+(?:of\s+\d+\s+)?(?:failed|failures?|errors?|exceptions?|tracebacks?|ব্যর্থ|ত্রুটি)\b|(?:failed|failures?|errors?|exceptions?|tracebacks?)\s*[:=]\s*0\b/i;

function hasError(text) {
  const s = String(text ?? "");
  if (!ERROR_RE.test(s)) return false;
  return ERROR_RE.test(s.replace(NEGATED_ERROR_RE, " "));
}

// A distinctive snippet is required: short generic phrases are not evidence.
function distinctiveSnippets(memory) {
  const out = [];
  const title = norm(memory.title).replace(/^[^a-z0-9\u0980-\u09ff]+/, "");
  const body = norm(memory.content);
  if (title.length >= 20) out.push(title.slice(0, 120));
  if (body.length >= 20) out.push(body.slice(0, 120));
  return [...new Set(out.filter(Boolean))];
}

// Read-only check of the live check constraint. No schema mutation is performed.
async function signalAllowed() {
  const r = await core.dbQuery(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname=$1",
    ["memory_usefulness_observations_signal_check"],
  );
  const def = r.rows[0]?.def || "";
  if (!def) return true; // no constraint at all => unrestricted
  return def.includes(SIGNAL);
}

/**
 * Observe whether a retrieved memory was followed by the prior error not
 * recurring. Deterministic, idempotent, and never claims helpfulness.
 *
 * @returns {Promise<{ok:boolean, observed?:number, kind?:string, claim?:string, [k:string]:any}>}
 */
export async function observeErrorNonRecurrence({ session_id, event_id } = {}) {
  if (!session_id || !event_id) {
    return { ok: false, kind: "invalid_argument", reason: "session_id and event_id are required", claim: CLAIM };
  }
  try {
    const ev = (await core.dbQuery(
      "SELECT id,session_id,project_id,query,memory_ids,created_at FROM memory_retrieval_events WHERE id=$1",
      [event_id],
    )).rows[0];
    if (!ev) return { ok: false, kind: "not_found", reason: "retrieval event not found", claim: CLAIM };
    if (ev.session_id && ev.session_id !== session_id) {
      return { ok: false, kind: "session_mismatch", reason: "event belongs to a different session", claim: CLAIM };
    }
    if (!ev.created_at) {
      return { ok: false, kind: "no_retrieval_time", reason: "retrieval event has no created_at", claim: CLAIM };
    }

    const createdAt = new Date(ev.created_at).getTime();
    if (Number.isNaN(createdAt)) {
      return { ok: false, kind: "no_retrieval_time", reason: "invalid created_at", claim: CLAIM };
    }

    const lines = readLines(session_id);
    const timed = lines
      .filter((l) => l && l.ts && !Number.isNaN(new Date(l.ts).getTime()))
      .map((l) => ({ ...l, _ms: new Date(l.ts).getTime() }));
    const before = timed.filter((l) => l._ms <= createdAt);
    const after = timed.filter((l) => l._ms > createdAt);

    const priorErrors = before.filter((l) => hasError(l.text));
    if (!priorErrors.length) {
      return { ok: true, observed: 0, reason: "no prior error in session before retrieval", claim: CLAIM };
    }
    const laterErrors = after.filter((l) => hasError(l.text));
    if (laterErrors.length) {
      return { ok: true, observed: 0, reason: "error recurred after retrieval",
        prior_error_seq: priorErrors[priorErrors.length - 1].seq,
        later_error_seqs: laterErrors.map((l) => l.seq), claim: CLAIM };
    }
    if (!after.length) {
      return { ok: true, observed: 0, reason: "no later transcript lines", claim: CLAIM };
    }

    const laterHaystack = after.map((l) => norm(l.text)).join("\n");
    const candidates = [];
    for (const mid of ev.memory_ids || []) {
      const m = await core.getMemory(mid);
      if (!m) continue;
      const match = distinctiveSnippets(m).find((s) => laterHaystack.includes(s));
      if (!match) continue; // no retrieved-memory reference => never fabricate
      const already = (await core.dbQuery(
        `SELECT 1 FROM memory_usefulness_observations
         WHERE event_id=$1 AND memory_id=$2 AND signal='${SIGNAL}'`,
        [event_id, mid],
      )).rowCount;
      if (already) continue; // idempotent
      const refSeqs = after.filter((l) => norm(l.text).includes(match)).map((l) => l.seq);
      candidates.push({ mid, match, refSeqs });
    }

    const analysis = {
      retrieval_event_id: event_id,
      prior_error_seq: priorErrors[priorErrors.length - 1].seq,
      matched_error_text: String(priorErrors[priorErrors.length - 1].text).slice(0, 500),
      later_line_seqs: after.map((l) => l.seq),
    };
    if (!candidates.length) {
      return { ok: true, observed: 0, reason: "no retrieved-memory reference in later lines",
        analysis, claim: CLAIM };
    }

    const allowed = await signalAllowed();
    if (!allowed) {
      return { ok: false, kind: "schema_update_required", would_observe: candidates.length,
        reason: "signal value not permitted by live check constraint; apply init/010-usefulness-signal.sql",
        analysis, claim: CLAIM };
    }

    let observed = 0;
    for (const c of candidates) {
      const evidence = {
        signal: SIGNAL,
        retrieval_event_id: event_id,
        retrieval_query: String(ev.query || "").slice(0, 300),
        matched_error_text: analysis.matched_error_text,
        prior_error_seqs: priorErrors.map((l) => l.seq),
        later_reference_seqs: c.refSeqs,
        matched_memory_snippet: c.match,
        session_id,
        note: CLAIM,
      };
      await core.dbQuery(
        `INSERT INTO memory_usefulness_observations (event_id,memory_id,signal,evidence,source)
         VALUES ($1,$2,$3,$4::jsonb,'deterministic')`,
        [event_id, c.mid, SIGNAL, JSON.stringify(evidence)],
      );
      await core.dbQuery("UPDATE memory SET useful_count=useful_count+1 WHERE id=$1", [c.mid]);
      observed++;
    }
    if (observed) {
      await core.audit("retrieval.usefulness.error_not_recurred", session_id, { event_id, observed });
    }
    return { ok: true, observed, analysis, claim: CLAIM };
  } catch (e) {
    return { ok: false, kind: "db_error", code: e.code || null, message: e.message || String(e), claim: CLAIM };
  }
}

/**
 * Counts grouped by signal/source, with explicit helpful-vs-inferred separation,
 * and retrieval events that have no usefulness rows reported as insufficient evidence.
 */
export async function usefulnessSignalSummary({ project_id } = {}) {
  try {
    const byRows = (await core.dbQuery(
      `SELECT u.signal, u.source, count(*)::int AS n
       FROM memory_usefulness_observations u
       JOIN memory_retrieval_events e ON e.id=u.event_id
       WHERE ($1::text IS NULL OR e.project_id=$1)
       GROUP BY 1,2 ORDER BY n DESC, u.signal, u.source`,
      [project_id || null],
    )).rows;

    const total = (await core.dbQuery(
      `SELECT count(*)::int AS n FROM memory_retrieval_events
       WHERE ($1::text IS NULL OR project_id=$1)`,
      [project_id || null],
    )).rows[0].n;

    const evidenced = (await core.dbQuery(
      `SELECT count(DISTINCT u.event_id)::int AS n
       FROM memory_usefulness_observations u
       JOIN memory_retrieval_events e ON e.id=u.event_id
       WHERE ($1::text IS NULL OR e.project_id=$1)`,
      [project_id || null],
    )).rows[0].n;

    const explicit = { helpful: 0, unhelpful: 0, other: 0 };
    const inferred = { observed_usage: 0, error_not_recurred: 0, other: 0 };
    for (const r of byRows) {
      const isUser = r.source === "user";
      if (isUser) {
        if (r.signal === "helpful") explicit.helpful += r.n;
        else if (r.signal === "unhelpful") explicit.unhelpful += r.n;
        else explicit.other += r.n;
      } else {
        if (r.signal === "observed_usage") inferred.observed_usage += r.n;
        else if (r.signal === SIGNAL) inferred.error_not_recurred += r.n;
        else inferred.other += r.n;
      }
    }

    const insufficient = Math.max(0, total - evidenced);
    return {
      ok: true,
      project_id: project_id || null,
      by_signal_source: byRows.map((r) => ({ signal: r.signal, source: r.source, n: r.n })),
      explicit,
      inferred,
      retrieval_events: total,
      events_with_usefulness_rows: evidenced,
      events_without_usefulness_rows: insufficient,
      insufficient_evidence: insufficient,
      deterministic_signals_never_claim_helpful: true,
      no_fabrication: true,
      note: "counts reflect recorded rows only; events with no usefulness rows are insufficient evidence, not helpfulness",
    };
  } catch (e) {
    return { ok: false, kind: "db_error", code: e.code || null, message: e.message || String(e) };
  }
}
