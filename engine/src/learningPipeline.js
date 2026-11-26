// Phase 21 workstream D — explicit feedback, idempotent learning pipeline, recovery.
// Local, additive-only and content-free in audits. No LLM, no network, no deletes.
// Sibling capabilities (learningExperience / learningIntelligence) are loaded with
// dynamic import only and every failure is isolated into result.degraded.
import * as core from "./core.js";
import { readLines, lastSequence } from "./transcript.js";

/** Documented, closed verdict vocabulary. Only `confirmed` can raise confidence. */
export const FEEDBACK_VERDICTS = Object.freeze(["confirmed", "corrected", "rejected", "outdated"]);
const VERDICT_SET = new Set(FEEDBACK_VERDICTS);
const CONFIDENCE_DELTA = Object.freeze({
  confirmed: 0.05,
  corrected: -0.15,
  rejected: -0.25,
  outdated: -0.10,
});
const MAX_LINES = 80;
const MAX_FEEDBACK_EVIDENCE = 20;
const MAX_RECORD_EVIDENCE = 60;
const MAX_RETRIES = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const short = (v, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const errText = (e) => short(e?.message || e || "unknown error", 160);
const finiteInt = (v, fallback, cap) => Number.isFinite(Number(v)) && Number(v) >= 0
  ? Math.min(Math.trunc(Number(v)), cap) : fallback;
const validProject = (v) => typeof v === "string" && v.trim().length > 0 && v.trim() !== "_global";
const stable = (v) => { try { return JSON.stringify(v, Object.keys(v || {}).sort()); } catch { return String(v); } };

function cleanEvidence(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value.slice(0, MAX_FEEDBACK_EVIDENCE)) {
    let s = typeof item === "string" ? item.trim() : (item && typeof item === "object" ? stable(item) : String(item ?? "").trim());
    s = core.redact(s).slice(0, 800);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function defaultLoad(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// 1. Feedback recording
// ---------------------------------------------------------------------------

/**
 * Record explicit or inferred feedback. `confirmed` (a confidence-raising verdict)
 * requires explicit_feedback === true. Rows are never deleted and no content is
 * written to the audit log.
 */
export async function recordFeedback({
  project_id, learning_id, pattern_id, session_id, verdict,
  explicit_feedback = false, reason = "", evidence = [],
} = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  if (!VERDICT_SET.has(verdict)) return { ok: false, reason: `verdict must be one of ${FEEDBACK_VERDICTS.join(",")}` };
  if (verdict === "confirmed" && explicit_feedback !== true) {
    return { ok: false, reason: "explicit_feedback=true is required for confidence-raising verdicts" };
  }
  if (learning_id != null && !UUID_RE.test(String(learning_id))) return { ok: false, reason: "invalid learning_id" };
  if (pattern_id != null && !UUID_RE.test(String(pattern_id))) return { ok: false, reason: "invalid pattern_id" };

  const pid = project_id.trim();
  const explicit = explicit_feedback === true;
  const cleanReason = core.redact(short(reason, 2000));
  const cleanEv = cleanEvidence(evidence);
  const lid = learning_id != null ? String(learning_id) : null;
  const prid = pattern_id != null ? String(pattern_id) : null;
  const sid = session_id != null ? short(session_id, 200) : null;

  const dup = await core.dbQuery(
    `SELECT id, evidence FROM learning_feedback
      WHERE project_id=$1 AND verdict=$2 AND explicit_feedback=$3 AND reason=$4
        AND learning_id IS NOT DISTINCT FROM $5 AND pattern_id IS NOT DISTINCT FROM $6
        AND session_id IS NOT DISTINCT FROM $7
      ORDER BY created_at DESC, id DESC LIMIT 5`,
    [pid, verdict, explicit, cleanReason, lid, prid, sid],
  );
  for (const row of dup.rows) {
    if (stable(row.evidence) === stable(cleanEv)) return { ok: true, id: row.id, duplicate: true };
  }

  const ins = await core.dbQuery(
    `INSERT INTO learning_feedback
       (project_id, learning_id, pattern_id, session_id, verdict, explicit_feedback, reason, evidence, applied)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false) RETURNING id, applied`,
    [pid, lid, prid, sid, verdict, explicit, cleanReason, JSON.stringify(cleanEv)],
  );
  const row = ins.rows[0];
  try {
    await core.audit("learning.feedback_recorded", pid, {
      feedback_id: row.id, verdict, explicit_feedback: explicit,
      has_learning: !!lid, has_pattern: !!prid, evidence_count: cleanEv.length,
    });
  } catch { /* best effort */ }
  return { ok: true, id: row.id };
}

// ---------------------------------------------------------------------------
// 2. Feedback application (conservative, idempotent, auditable)
// ---------------------------------------------------------------------------

/**
 * Apply an authorized feedback row to its learning record / pattern.
 * Explicit feedback, or an override backed by non-empty evidence, is required.
 * Only confidence and evidence history change; verification is never promoted.
 */
export async function applyFeedback({ feedback_id, project_id, actor = "system", explicit_override = false } = {}) {
  if (!validProject(project_id)) return { ok: false, changed: false, reason: "valid project_id required" };
  const fid = Number(feedback_id);
  if (!Number.isInteger(fid) || fid <= 0) return { ok: false, changed: false, reason: "valid feedback_id required" };
  const pid = project_id.trim();
  const who = short(actor, 80) || "system";
  const override = explicit_override === true;

  return core.withDb(async (client) => {
    const fb = (await client.query(
      "SELECT * FROM learning_feedback WHERE id=$1 AND project_id=$2 FOR UPDATE", [fid, pid],
    )).rows[0];
    if (!fb) return { ok: false, changed: false, reason: "feedback not found in project" };
    if (fb.applied) return { ok: true, changed: false, reason: "already_applied", feedback_id: fid };

    const evidence = Array.isArray(fb.evidence) ? fb.evidence : [];
    const authorized = fb.explicit_feedback === true || (override && evidence.length > 0);
    if (!authorized) {
      return { ok: false, changed: false, reason: "explicit feedback or override with evidence required", feedback_id: fid };
    }

    let target = null;
    if (fb.learning_id) {
      target = (await client.query(
        `SELECT id, confidence, confidence_breakdown, evidence, verification, status
           FROM learning_record WHERE id=$1 AND project_id=$2 FOR UPDATE`,
        [fb.learning_id, pid],
      )).rows[0] || null;
    } else if (fb.pattern_id) {
      target = (await client.query(
        `SELECT id, confidence, evidence, verified, status
           FROM pattern WHERE id=$1 AND projects @> ARRAY[$2]::text[] FOR UPDATE`,
        [fb.pattern_id, pid],
      )).rows[0] || null;
    }
    if (!target) return { ok: false, changed: false, reason: "target record not found in project", feedback_id: fid };

    const before = Number(target.confidence) || 0;
    let delta = CONFIDENCE_DELTA[fb.verdict] ?? 0;
    // A single, weak positive signal must never laminate important knowledge.
    if (delta > 0 && before >= 0.9) delta = 0;
    const after = Math.max(0, Math.min(1, Number((before + delta).toFixed(4))));
    const history = {
      event: "learning.feedback_applied",
      at: new Date().toISOString(),
      feedback_id: fid,
      verdict: fb.verdict,
      actor: who,
      explicit: fb.explicit_feedback === true,
      override,
      delta,
      previous: {
        confidence: target.confidence ?? null,
        confidence_breakdown: target.confidence_breakdown ?? {},
      },
    };
    const merged = [...(Array.isArray(target.evidence) ? target.evidence : []), history]
      .slice(-MAX_RECORD_EVIDENCE);
    const breakdown = {
      ...(target.confidence_breakdown && typeof target.confidence_breakdown === "object" ? target.confidence_breakdown : {}),
      feedback: { feedback_id: fid, verdict: fb.verdict, delta, applied_at: history.at },
    };

    if (fb.learning_id) {
      await client.query(
        `UPDATE learning_record SET confidence=$2, confidence_breakdown=$3::jsonb, evidence=$4::jsonb,
           updated_at=now() WHERE id=$1 AND project_id=$5`,
        [target.id, after, JSON.stringify(breakdown), JSON.stringify(merged), pid],
      );
    } else {
      // Pattern: confidence only. `verified` is deliberately untouched.
      await client.query(
        `UPDATE pattern SET confidence=$2, evidence=$3::jsonb, updated_at=now()
          WHERE id=$1 AND projects @> ARRAY[$4]::text[]`,
        [target.id, after, JSON.stringify(merged), pid],
      );
    }
    await client.query("UPDATE learning_feedback SET applied=true WHERE id=$1 AND project_id=$2", [fid, pid]);
    return {
      ok: true, changed: true, reason: "applied", feedback_id: fid,
      verdict: fb.verdict, delta, confidence_before: before, confidence_after: after,
      verification_unchanged: true,
    };
  }).then(async (r) => {
    if (r.changed) {
      try {
        await core.audit("learning.feedback_applied", pid, {
          feedback_id: fid, verdict: r.verdict, actor: who, override,
          delta: r.delta, confidence_before: r.confidence_before, confidence_after: r.confidence_after,
        });
      } catch { /* best effort */ }
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// 3. Idempotent learning pipeline
// ---------------------------------------------------------------------------

/**
 * Extract experiences, analyze outcomes, record learnings and detect patterns.
 * Refuses incomplete transcripts before taking a ledger claim. All sibling
 * failures are captured in result.degraded; the function never throws.
 */
export async function runLearningPipeline({
  session_id, project_id, lines = [], sequence, min_sequence, _load,
} = {}) {
  if (!validProject(project_id) || !session_id || !String(session_id).trim()) {
    return { ok: false, reason: "valid session_id and project_id required" };
  }
  const pid = project_id.trim();
  const sid = String(session_id).slice(0, 200);
  const load = typeof _load === "function" ? _load : defaultLoad;

  // Completeness guard uses the DURABLE transcript, before any claim is written.
  const durableSeq = lastSequence(sid);
  const minSeq = Number.isFinite(Number(min_sequence)) ? Number(min_sequence) : 0;
  if (minSeq > 0 && durableSeq < minSeq) {
    return { ok: false, incomplete: true, expected_sequence: minSeq, actual_sequence: durableSeq };
  }

  const supplied = Array.isArray(lines) ? lines : [];
  const seq = Number.isFinite(Number(sequence)) && Number(sequence) > 0
    ? Math.trunc(Number(sequence)) : (durableSeq || supplied.length);
  if (!seq || !supplied.length) return { ok: false, reason: "empty transcript" };
  const safeLines = supplied.slice(0, MAX_LINES);
  const analyzedLines = safeLines.length;

  const degraded = [];
  const result = { extracted: 0, recorded: 0, patterns: 0, degraded, analyzed_lines: analyzedLines };

  let runId;
  try {
    const claimed = await core.dbQuery(
      `INSERT INTO learning_pipeline_run (project_id, session_id, transcript_sequence, status, result, attempts)
       VALUES ($1,$2,$3,'processing','{}'::jsonb,1)
       ON CONFLICT (session_id, transcript_sequence) DO NOTHING RETURNING id`,
      [pid, sid, seq],
    );
    if (claimed.rowCount) {
      runId = claimed.rows[0].id;
    } else {
      const prior = (await core.dbQuery(
        "SELECT id,status,result FROM learning_pipeline_run WHERE session_id=$1 AND transcript_sequence=$2",
        [sid, seq],
      )).rows[0];
      if (!prior || prior.status === "done") {
        return { ok: true, duplicate: true, run_id: prior?.id, result: prior?.result || result, status: "done" };
      }
      // Reclaim failed / stale processing rows in place: attempts and history are preserved.
      const re = await core.dbQuery(
        `UPDATE learning_pipeline_run SET status='processing', attempts=attempts+1, updated_at=now()
          WHERE id=$1 AND status IN ('pending','failed','processing') RETURNING id`,
        [prior.id],
      );
      if (!re.rowCount) {
        return { ok: true, duplicate: true, run_id: prior.id, result: prior.result || result, status: prior.status };
      }
      runId = prior.id;
    }

    const [exp, intel] = await Promise.all([
      load("learningExperience").catch((e) => { degraded.push(`learningExperience: ${errText(e)}`); return null; }),
      load("learningIntelligence").catch((e) => { degraded.push(`learningIntelligence: ${errText(e)}`); return null; }),
    ]);
    if (!exp) degraded.push("learningExperience: unavailable");
    if (!intel) degraded.push("learningIntelligence: unavailable");

    const analyzeOutcome = intel && typeof intel.analyzeOutcome === "function" ? intel.analyzeOutcome : null;

    let experiences = [];
    if (exp && typeof exp.extractExperiences === "function") {
      try {
        const x = await exp.extractExperiences({ session_id: sid, project_id: pid, lines: safeLines, understanding: null });
        if (Array.isArray(x?.degraded)) for (const d of x.degraded.slice(0, 10)) degraded.push(short(d, 160));
        experiences = Array.isArray(x?.experiences) ? x.experiences.slice(0, 12) : [];
      } catch (e) { degraded.push(`extractExperiences: ${errText(e)}`); }
    }
    result.extracted = experiences.length;

    let outcomes = 0;
    if (exp && typeof exp.recordLearningExperience === "function") {
      for (const ex of experiences) {
        try {
          // Analyze the outcome first; a missing/broken analyzer degrades once, not per item.
          if (analyzeOutcome) {
            analyzeOutcome({ experience: ex, evidence: Array.isArray(ex.evidence) ? ex.evidence : [] });
            outcomes += 1;
          }
          const r = await exp.recordLearningExperience({
            project_id: pid, session_id: sid,
            signature: ex.signature, category: ex.category, problem: ex.problem,
            approach: ex.approach, outcome: ex.outcome, verification: ex.verification,
            confidence: ex.confidence_hint, evidence: ex.evidence || [],
            reusability: ex.reusability || "project",
          });
          if (r?.ok) result.recorded += 1;
          else if (result.recorded === 0 && degraded.length < 12) degraded.push("recordLearningExperience: refused");
        } catch (e) { degraded.push(`recordLearningExperience: ${errText(e)}`); }
      }
    } else if (experiences.length) {
      degraded.push("recordLearningExperience: unavailable");
    }

    if (intel && typeof intel.detectPatterns === "function") {
      try {
        const pr = await intel.detectPatterns({ project_id: pid, limit: 20 });
        result.patterns = Array.isArray(pr?.patterns) ? pr.patterns.length : 0;
      } catch (e) { degraded.push(`detectPatterns: ${errText(e)}`); }
    }

    await core.dbQuery(
      `UPDATE learning_pipeline_run SET status='done', result=$2::jsonb, error=NULL, updated_at=now()
        WHERE id=$1`,
      [runId, JSON.stringify(result)],
    );
    try {
      await core.audit("learning.pipeline", sid, {
        project_id: pid, transcript_sequence: seq, analyzed_lines: analyzedLines,
        extracted: result.extracted, recorded: result.recorded, patterns: result.patterns,
        degraded_count: degraded.length,
      });
    } catch { /* best effort */ }
    return { ok: true, run_id: runId, result };
  } catch (e) {
    const error = errText(e);
    try {
      await core.dbQuery(
        `UPDATE learning_pipeline_run SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
        [runId, error],
      );
    } catch { /* best effort */ }
    try { await core.audit("learning.pipeline_failed", sid, { project_id: pid, transcript_sequence: seq, error }); }
    catch { /* best effort */ }
    return { ok: false, run_id: runId, error, result };
  }
}

// ---------------------------------------------------------------------------
// 4. Bounded project-scoped status
// ---------------------------------------------------------------------------

export async function learningPipelineStatus({ project_id, status, limit = 50 } = {}) {
  if (!validProject(project_id)) return { ok: false, items: [], count: 0, reason: "valid project_id required" };
  const n = Math.min(finiteInt(limit, 50, 200), 200);
  const r = await core.dbQuery(
    `SELECT id, session_id, transcript_sequence, status, error, attempts, created_at, updated_at
       FROM learning_pipeline_run
      WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY updated_at DESC, id DESC LIMIT $3`,
    [project_id.trim(), status || null, n],
  );
  return { ok: true, items: r.rows, count: r.rows.length };
}

// ---------------------------------------------------------------------------
// 5. Recovery: retry pending/failed rows without deleting or rewriting history
// ---------------------------------------------------------------------------

export async function retryLearningPipeline({ limit = 20, project_id, session_id } = {}) {
  const n = Math.min(finiteInt(limit, 20, MAX_RETRIES), MAX_RETRIES);
  const rows = (await core.dbQuery(
    `SELECT id, project_id, session_id, transcript_sequence, attempts
       FROM learning_pipeline_run
      WHERE status IN ('pending','failed')
        AND ($1::text IS NULL OR project_id=$1)
        AND ($2::text IS NULL OR session_id=$2)
      ORDER BY created_at, id LIMIT $3`,
    [validProject(project_id) ? project_id.trim() : null, session_id || null, n],
  )).rows;

  let retried = 0, failed = 0;
  for (const r of rows) {
    try {
      const res = await runLearningPipeline({
        session_id: r.session_id, project_id: r.project_id,
        sequence: r.transcript_sequence, lines: readLines(r.session_id),
      });
      if (res.ok && !res.duplicate) retried += 1;
      else failed += 1;
    } catch {
      failed += 1;
      try {
        await core.dbQuery(
          "UPDATE learning_pipeline_run SET status='failed', attempts=attempts+1, updated_at=now() WHERE id=$1",
          [r.id],
        );
      } catch { /* best effort */ }
    }
  }
  const out = { ok: true, attempted: rows.length, retried, failed };
  try { await core.audit("learning.pipeline_retry", "all", out); } catch { /* best effort */ }
  return out;
}

export default {
  FEEDBACK_VERDICTS,
  recordFeedback, applyFeedback, runLearningPipeline,
  learningPipelineStatus, retryLearningPipeline,
};
