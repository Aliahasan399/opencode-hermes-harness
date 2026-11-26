// Single turn-end orchestrator for the three core capabilities:
// extraction → project identity → role-aware understanding → candidate memories
// → pattern analysis → strategy evaluation → durable audit.
// Deterministic by default; optional LLM analysis never gates the deterministic path.
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import * as core from "./core.js";
import { resolveProjectId } from "./projectIdentity.js";
import { learnFromTranscript } from "./learn.js";
import { analyzeQuality } from "./patterns-v2.js";
import * as strategy from "./strategy.js";
import { extractSession } from "./roles.js";
import { readLines, transcriptText, listDurableSessions } from "./transcript.js";
import * as retrievalFeedback from "./retrievalFeedback.js";
import { triageSuggestions } from "./consolidation.js";
import { linkOutcomesToExperiments, selfImprovementReport, captureOutcomes } from "./learning10.js";
import { analyzeSession as semanticAnalyze } from "./semanticUnderstanding.js";
import { analyzeSessionErrors } from "./errorLearning.js";
import { intelligenceQualityReport } from "./phase13Report.js";
import { observeErrorNonRecurrence } from "./usefulnessSignals.js";

const OPENCODE_DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const CLAIM_LEASE_MS = Math.max(30000, Number(process.env.HARNESS_CLAIM_LEASE_MS || 120000));

async function due(key, intervalMs) {
  const r = await core.dbQuery("SELECT updated_at FROM harness_state WHERE key=$1", [key]);
  if (!r.rowCount) return true;
  return Date.now() - new Date(r.rows[0].updated_at).getTime() >= intervalMs;
}
async function markDue(key) {
  await core.dbQuery(
    `INSERT INTO harness_state (key,value,updated_at) VALUES ($1,'{}'::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET updated_at=now()`, [key],
  );
}

function hashOf(session_id, text) {
  return crypto.createHash("sha256").update(`${session_id}|${text}`).digest("hex");
}

// Parse an explicit transcript (e.g. the plugin's in-memory, already-complete
// transcript) into the same line shape the durable reader produces. The optional
// tool name after the role is accepted because the plugin writes "TOOL shell:".
export function parseTranscriptLines(raw) {
  return String(raw || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^(USER|ASSISTANT|TOOL|UNKNOWN)(?:\s+[^:]+)?:\s*([\s\S]*)$/i);
    return m
      ? { seq: i + 1, role: m[1].toUpperCase(), text: m[2], tool: null }
      : { seq: i + 1, role: "UNKNOWN", text: line, tool: null };
  });
}

async function claim(session_id, event_id, directory, project_id, hash, transcript, sequence) {
  const r = await core.dbQuery(
    `INSERT INTO automation_events (session_id,event_id,directory,project_id,transcript_hash,payload,status,attempts,sequence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'processing',1,$7)
     ON CONFLICT (session_id,event_id) DO UPDATE SET status='processing',
       payload=EXCLUDED.payload, attempts=automation_events.attempts+1, updated_at=now(),
       sequence=EXCLUDED.sequence
     WHERE automation_events.status IN ('pending','failed')
        OR (automation_events.status='processing' AND automation_events.updated_at < now() - ($8::bigint || ' milliseconds')::interval)
     RETURNING session_id`,
    [session_id, event_id, directory || null, project_id, hash,
      JSON.stringify({ transcript: String(transcript || "").slice(0, 200000) }), sequence ?? null, CLAIM_LEASE_MS],
  );
  return r.rowCount > 0;
}

async function finish(session_id, event_id, status, result, error) {
  await core.dbQuery(
    `UPDATE automation_events SET status=$3,result=$4::jsonb,error=$5,
      superseded=false, finished_at=now(),updated_at=now()
      WHERE session_id=$1 AND event_id=$2`,
    [session_id, event_id, status, JSON.stringify(result || {}), error ? String(error).slice(0, 1000) : null],
  );
}

export async function runTurnEnd({ session_id, directory, transcript, project_id, event_id, sequence, min_sequence, lines: suppliedLines, allow_llm = false } = {}) {
  if (!session_id) throw new Error("session_id required");
  const raw = String(transcript || "");
  const hash = hashOf(session_id, raw);
  const seq = Number.isFinite(Number(sequence)) ? Number(sequence) : null;
  const eid = event_id || (seq !== null ? `seq-${seq}-${hash.slice(0, 16)}` : hash.slice(0, 24));
  const pid = project_id || await resolveProjectId(directory);

  // Durable transcript state is inspected before any claim is taken. A caller
  // that knows how many lines it queued (the turn-end plugin) passes min_sequence;
  // if the durable file is shorter, processing is REFUSED rather than reported as
  // successful on partial data. No claim is created, so existing recovery can
  // retry this session once all writes have landed.
  // An explicit in-memory snapshot from the plugin is already complete; the
  // durable file is only used when no snapshot was supplied (recovery / CLI).
  const durable = Array.isArray(suppliedLines) ? suppliedLines : readLines(session_id);
  const durableSeq = durable.length ? Math.max(...durable.map((l) => l.seq || 0)) : 0;
  const minSeq = Number.isFinite(Number(min_sequence)) ? Number(min_sequence) : 0;
  if (minSeq > 0 && durableSeq < minSeq) {
    await core.dbQuery(
      `INSERT INTO intelligence_audit_events (track,action,resource,detail)
       VALUES ('learning','turn_end_incomplete',$1,$2::jsonb)`,
      [session_id, JSON.stringify({ expected: minSeq, actual: durableSeq,
        lines: durable.length, project_id: pid, event_id: eid })],
    );
    return { ok: false, incomplete: true, expected_sequence: minSeq,
      actual_sequence: durableSeq, project_id: pid };
  }

  // Reject stale/out-of-order events: never overwrite newer completed work.
  if (seq !== null) {
    const newest = (await core.dbQuery(
      `SELECT sequence FROM automation_events
       WHERE session_id=$1 AND status='done' AND superseded=false AND sequence IS NOT NULL
       ORDER BY sequence DESC LIMIT 1`, [session_id])).rows[0];
    if (newest && seq < Number(newest.sequence)) {
      await core.dbQuery(
        `INSERT INTO intelligence_audit_events (track,action,resource,detail)
         VALUES ('learning','turn_end_out_of_order',$1,$2::jsonb)`,
        [session_id, JSON.stringify({ incoming: seq, newest: newest.sequence, event_id: eid })],
      );
      return { ok: true, duplicate: true, reason: "out_of_order", incoming_sequence: seq,
        newest_sequence: newest.sequence, project_id: pid };
    }
  }

  if (!(await claim(session_id, eid, directory, pid, hash, raw, seq))) {
    const prior = (await core.dbQuery("SELECT status,result FROM automation_events WHERE session_id=$1 AND event_id=$2", [session_id, eid])).rows[0];
    return { ok: true, duplicate: true, status: prior?.status, result: prior?.result || {}, project_id: pid };
  }

  const started = Date.now();
  const result = { session_id, project_id: pid, stages: {},
    transcript: { lines: durable.length, sequence: durableSeq,
      expected_sequence: minSeq || seq, complete: true } };
  let failed = false, error = null;
  try {
    // 1-2: role-aware extraction + candidate memory learning (idempotent, non-destructive).
    result.stages.learning = await learnFromTranscript({ session_id, project_id: pid, directory, transcript: raw });

    // 3: role-aware understanding from the ORIGINAL session records (read-only).
    try {
      const lines = extractSession(OPENCODE_DB, session_id, 40);
      const roles = {};
      for (const l of lines) roles[l.kind || "other"] = (roles[l.kind || "other"] || 0) + 1;
      result.stages.understanding = { ok: true, lines: lines.length, roles, languages: [...new Set(lines.map((l) => l.language))] };
    } catch (e) {
      result.stages.understanding = { ok: false, reason: String(e?.message || e).slice(0, 200) };
    }

    // 4: cross-session pattern analysis (incremental via analysis_state).
    try {
      result.stages.patterns = await analyzeQuality({ project_id: pid, limit: 60 });
    } catch (e) { result.stages.patterns = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // 5: strategy evaluation — evidence-only, never auto-promotes.
    try { result.stages.strategy = await strategy.evaluateStrategies({ project_id: pid }); }
    catch (e) { result.stages.strategy = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // 6: retrieval usefulness — deterministic observed usage only, never a helpfulness claim.
    try {
      const events = (await core.dbQuery(
        "SELECT id FROM memory_retrieval_events WHERE session_id=$1 AND created_at > now() - interval '1 day'", [session_id])).rows;
      let observed = 0;
      for (const e of events) {
        const o = await retrievalFeedback.observeUsage({ event_id: e.id, session_id });
        observed += o.observed || 0;
        const nr = await observeErrorNonRecurrence({ event_id: e.id, session_id });
        if (nr.ok) observed += nr.observed || 0;
      }
      result.stages.retrieval_feedback = { ok: true, events: events.length, observed };
    } catch (e) { result.stages.retrieval_feedback = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // 5b: semantic observations are optional; deterministic understanding already ran above.
    try {
      // semanticAnalyze itself uses the deterministic path when the adapter is disabled.
      result.stages.semantic_understanding = await semanticAnalyze({ session_id, project_id: pid });
    } catch (e) { result.stages.semantic_understanding = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // 5c: error fingerprinting, fix verification and recurrence evidence.
    // Pass the same durable snapshot used for the completeness guard and learning,
    // so tool-output errors and their verified fixes come from one consistent view.
    try { result.stages.error_learning = await analyzeSessionErrors({ session_id, project_id: pid, lines: durable }); }
    catch (e) { result.stages.error_learning = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // Phase 17 capability F: incremental project-context update from the same
    // complete durable snapshot. Failures are recorded as a stage error and never
    // block the memory/learning pipeline; the context_update ledger makes retries safe.
    try {
      const ctxUpdate = await import("./contextUpdate.js");
      result.stages.context_update = await ctxUpdate.runContextUpdate({
        session_id, project_id: pid, transcript_lines: durable,
        sequence: durableSeq, min_sequence: minSeq || undefined,
      });
    } catch (e) {
      result.stages.context_update = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }

    // Phase 19: connected session understanding over the same complete durable
    // transcript. Optional and bounded; failures never affect existing stages.
    try {
      const su = await import("./sessionUnderstanding.js");
      result.stages.session_understanding = await su.runSessionUnderstanding({
        session_id, project_id: pid, lines: durable,
        sequence: durableSeq, min_sequence: minSeq || undefined,
      });
    } catch (e) {
      result.stages.session_understanding = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }

    // Phase 21: continuous learning from the same complete durable transcript.
    // Additive, idempotent and failure-isolated; never blocks the existing stages.
    try {
      const lp = await import("./learningPipeline.js");
      result.stages.learning_pipeline = await lp.runLearningPipeline({
        session_id, project_id: pid, lines: durable,
        sequence: durableSeq, min_sequence: minSeq || undefined,
      });
    } catch (e) {
      result.stages.learning_pipeline = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }

    // 6b: turn tool executions become observed coding outcomes (no invented metrics).
    try { result.stages.outcome_capture = await captureOutcomes({ session_id, project_id: pid }); }
    catch (e) { result.stages.outcome_capture = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // 7-8: bounded maintenance, rate-limited so turns stay fast.
    try {
      if (await due(`triage:${pid}`, Number(process.env.HARNESS_TRIAGE_INTERVAL_MS || 600000))) {
        result.stages.consolidation_triage = await triageSuggestions({ batch: 100, project_id: pid });
        await markDue(`triage:${pid}`);
      } else result.stages.consolidation_triage = { ok: true, skipped: "recent" };
    } catch (e) { result.stages.consolidation_triage = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    try {
      if (await due(`outcome_link:${pid}`, Number(process.env.HARNESS_LINK_INTERVAL_MS || 600000))) {
        result.stages.outcome_link = await linkOutcomesToExperiments({ project_id: pid, limit: 100 });
        await markDue(`outcome_link:${pid}`);
      } else result.stages.outcome_link = { ok: true, skipped: "recent" };
    } catch (e) { result.stages.outcome_link = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    try {
      if (await due(`improvement_report:${pid}`, 3600000)) {
        result.stages.improvement_report = await selfImprovementReport({ project_id: pid });
        result.stages.intelligence_report = await intelligenceQualityReport({ project_id: pid });
        await markDue(`improvement_report:${pid}`);
      }
    } catch (e) { result.stages.improvement_report = { ok: false, error: String(e?.message || e).slice(0, 200) }; }

    // Optional LLM analysis is additive and never blocks or replaces the above.
    if (allow_llm) {
      try {
        const llm = await import("./llm-provider.js");
        const worker = await import("./session-worker.js");
        result.stages.llm = await worker.processSession({ session_id });
        result.stages.llm_status = llm.status().enabled;
      } catch (e) { result.stages.llm = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    }
  } catch (e) {
    failed = true; error = e;
    result.error = String(e?.message || e).slice(0, 500);
  }

  result.duration_ms = Date.now() - started;
  await finish(session_id, eid, failed ? "failed" : "done", result, error);
  // A higher-sequence run saw the complete transcript. Older provisional runs for
  // the same session are marked superseded (kept as history, never deleted), so
  // only the complete result is treated as authoritative.
  if (!failed && seq !== null) {
    await core.dbQuery(
      `UPDATE automation_events SET status='superseded', superseded=true, updated_at=now()
       WHERE session_id=$1 AND event_id<>$2 AND status='done'
         AND sequence IS NOT NULL AND sequence < $3`,
      [session_id, eid, seq],
    );
  }
  await core.dbQuery(
    `INSERT INTO intelligence_audit_events (track,action,resource,detail)
     VALUES ('learning','turn_end_orchestration',$1,$2::jsonb)`,
    [session_id, JSON.stringify({ project_id: pid, stages: Object.keys(result.stages), failed, duplicate: false, event_id: eid })],
  );
  return { ok: !failed, duplicate: false, ...result };
}

// Startup recovery: reset stale claims, retry pending/failed, and recover sessions whose
// durable transcripts exist but never entered the pipeline (e.g. service died mid-session).
export async function recoverAutomation({ limit = 20, scan_transcripts = true, scan_limit = 5, session_ids } = {}) {
  const started = Date.now();
  const stale = (await core.dbQuery(
    `UPDATE automation_events SET status='pending', updated_at=now()
     WHERE status='processing' AND updated_at < now() - ($1::bigint || ' milliseconds')::interval
     RETURNING session_id,event_id`, [CLAIM_LEASE_MS])).rows;
  await core.dbQuery(
    `INSERT INTO intelligence_audit_events (track,action,resource,detail)
     VALUES ('learning','startup_stale_claim_reset','all',$1::jsonb)`,
    [JSON.stringify({ count: stale.length, lease_ms: CLAIM_LEASE_MS })],
  );

  let discovered = 0, recovered = 0;
  if (scan_transcripts) {
    const candidates = session_ids ? session_ids.map(String) : listDurableSessions().slice(0, Math.min(scan_limit, 50));
    for (const sid of candidates) {
      const lines = readLines(sid);
      if (!lines.length) continue;
      const known = (await core.dbQuery(
        `SELECT status FROM automation_events WHERE session_id=$1 AND status IN ('done','processing') LIMIT 1`, [sid])).rows[0];
      if (known) continue;
      discovered++;
      const seq = Math.max(...lines.map((l) => l.seq || 0));
      const r = await runTurnEnd({ session_id: sid, transcript: transcriptText(sid), sequence: seq });
      if (r.ok && !r.duplicate) recovered++;
    }
  }
  const retry = await retryPending({ limit });
  const summary = { stale_reset: stale.length, sessions_discovered: discovered,
    sessions_recovered: recovered, retried: retry.attempted, retried_ok: retry.retried, duration_ms: Date.now() - started };
  await core.dbQuery(
    `INSERT INTO intelligence_audit_events (track,action,resource,detail)
     VALUES ('learning','startup_recovery','all',$1::jsonb)`, [JSON.stringify(summary)],
  );
  return { ok: true, ...summary };
}

export async function retryPending({ limit = 10 } = {}) {
  const rows = (await core.dbQuery(
    `SELECT session_id,event_id,directory,project_id,transcript_hash,payload,sequence FROM automation_events
     WHERE status IN ('pending','failed') ORDER BY created_at LIMIT $1`, [Math.min(limit, 100)])).rows;
  let retried = 0;
  for (const r of rows) {
    const res = await runTurnEnd({
      session_id: r.session_id, event_id: r.event_id, directory: r.directory,
      project_id: r.project_id, transcript: r.payload?.transcript || "", sequence: r.sequence ?? undefined,
    });
    if (res.ok) retried++;
  }
  return { ok: true, attempted: rows.length, retried };
}

// Called once at process/plugin startup. Uses harness_state so multiple MCP connections
// in the same process do not repeatedly recover the same work.
export async function recoverIfDue({ min_interval_ms = 60000 } = {}) {
  const key = "last_automation_recovery";
  const row = (await core.dbQuery("SELECT value,updated_at FROM harness_state WHERE key=$1", [key])).rows[0];
  const age = row ? Date.now() - new Date(row.updated_at).getTime() : Infinity;
  if (row && age < min_interval_ms) return { ok: true, skipped: "recent", age_ms: age };
  await core.dbQuery(
    `INSERT INTO harness_state (key,value,updated_at) VALUES ($1,'{}'::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value='{}'::jsonb, updated_at=now()`, [key],
  );
  return recoverAutomation({ scan_limit: 5 });
}

// Recover pending/failed events without ever marking an event done unless its pipeline ran.
// Older pending events for a session that already completed a newer sequence are SUPERSEDED
// (observable, not successful) so they cannot replay stale outcomes.
export async function recoverEvents({ limit = 30, max_attempts = 5 } = {}) {
  const rows = (await core.dbQuery(
    `SELECT session_id,event_id,status,attempts,sequence,payload,directory,project_id FROM automation_events
     WHERE status IN ('pending','failed','processing') AND attempts < $2
     ORDER BY created_at LIMIT $1`, [Math.min(limit, 100), max_attempts])).rows;
  const bySession = {};
  for (const r of rows) (bySession[r.session_id] ||= []).push(r);
  const stats = { examined: rows.length, retried: 0, succeeded: 0, superseded: 0, failed: 0 };
  for (const [sid, events] of Object.entries(bySession)) {
    const done = (await core.dbQuery(
      `SELECT max(sequence) AS seq FROM automation_events WHERE session_id=$1 AND status='done' AND sequence IS NOT NULL`, [sid])).rows[0];
    const doneSeq = Number(done?.seq || 0);
    for (const e of events.sort((a, b) => (a.sequence || 0) - (b.sequence || 0))) {
      if (e.sequence && doneSeq && e.sequence <= doneSeq) {
        await core.dbQuery("UPDATE automation_events SET status='superseded',updated_at=now() WHERE session_id=$1 AND event_id=$2",
          [sid, e.event_id]);
        await core.dbQuery(
          `INSERT INTO intelligence_audit_events (track,action,resource,detail) VALUES ('learning','event_superseded',$1,$2::jsonb)`,
          [sid, JSON.stringify({ event_id: e.event_id, sequence: e.sequence, newer_done: doneSeq })],
        );
        stats.superseded++;
        continue;
      }
      stats.retried++;
      try {
        if (e.status === "processing") {
          await core.dbQuery("UPDATE automation_events SET status='failed',error='stale processing claim',updated_at=now() WHERE session_id=$1 AND event_id=$2", [sid, e.event_id]);
        }
        const r = await runTurnEnd({ session_id: sid, event_id: e.event_id,
          directory: e.directory || undefined, project_id: e.project_id || undefined,
          transcript: e.payload?.transcript || "" });
        if (r.ok && !r.duplicate) stats.succeeded++;
        else stats.failed++;
      } catch (err) {
        stats.failed++;
        await core.dbQuery("UPDATE automation_events SET status='failed',attempts=attempts+1,error=$3,updated_at=now() WHERE session_id=$1 AND event_id=$2",
          [sid, e.event_id, String(err?.message || err).slice(0, 500)]);
      }
    }
  }
  await core.audit("learning.event_recovery", "all", stats);
  return { ok: true, ...stats };
}

export async function automationStatus() {
  const byStatus = (await core.dbQuery("SELECT status,count(*)::int n FROM automation_events GROUP BY 1")).rows;
  const recent = (await core.dbQuery(
    "SELECT session_id,event_id,status,attempts,error,created_at,finished_at FROM automation_events ORDER BY created_at DESC LIMIT 20")).rows;
  return { ok: true, by_status: byStatus, recent };
}
