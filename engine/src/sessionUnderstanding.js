// Phase 19 orchestrator: turn development transcripts into structured, idempotent,
// project-scoped session understanding. All sibling capabilities are optional and are
// loaded dynamically with isolated try/catch so a failure in one never blocks the others.
import * as core from "./core.js";
import { readLines, lastSequence } from "./transcript.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const errText = (e) => short(e?.message || e || "unknown error", 160);

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch (e) { return null; }
}

/**
 * Idempotent session-understanding pass.
 * - refuses incomplete transcripts when min_sequence is asserted (no ledger claim),
 * - claims an entry on (session_id, transcript_sequence),
 * - runs evidence-backed extraction through the four optional capabilities,
 * - records a structured summary and audits content-free metadata.
 */
export async function runSessionUnderstanding({ session_id, project_id, lines: suppliedLines,
  sequence, min_sequence } = {}) {
  if (!session_id || !project_id || project_id === "_global") {
    return { ok: false, reason: "valid session_id and project_id required" };
  }
  const lines = Array.isArray(suppliedLines) ? suppliedLines : readLines(session_id);
  const durableSeq = lastSequence(session_id);
  const minSeq = Number.isFinite(Number(min_sequence)) ? Number(min_sequence) : 0;
  if (minSeq > 0 && durableSeq < minSeq) {
    // No claim, no learning from an incomplete transcript.
    return { ok: false, incomplete: true, expected_sequence: minSeq, actual_sequence: durableSeq };
  }
  const seq = Number.isFinite(Number(sequence)) ? Number(sequence) : (durableSeq || lines.length);
  if (!seq || !lines.length) return { ok: false, reason: "empty transcript" };

  const claimed = await core.dbQuery(
    `INSERT INTO session_understanding (project_id, session_id, transcript_sequence, status, summary, events, evidence)
     VALUES ($1,$2,$3,'processing','{}'::jsonb,'[]'::jsonb,'[]'::jsonb)
     ON CONFLICT (session_id, transcript_sequence) DO UPDATE SET status='processing', updated_at=now()
     WHERE session_understanding.status IN ('pending','failed','processing')
       AND session_understanding.updated_at < now() - interval '2 minutes'
     RETURNING id`, [project_id, session_id, seq]);
  if (!claimed.rowCount) {
    const prior = await core.dbQuery(
      "SELECT id,status,summary FROM session_understanding WHERE session_id=$1 AND transcript_sequence=$2",
      [session_id, seq]);
    return { ok: true, duplicate: true, status: prior.rows[0]?.status,
      result: prior.rows[0]?.summary || {} };
  }
  const ledgerId = claimed.rows[0].id;

  const degraded = [];
  const result = { project_id, session_id, transcript_sequence: seq, analyzed_lines: lines.length,
    goals: 0, tasks: 0, debugging: 0, experiences: 0, degraded };

  try {
    const [sess, goals, debug, store] = await Promise.all([
      load("sessionExperience"), load("developmentGoal"),
      load("debuggingExperience"), load("experienceStore"),
    ]);
    if (!sess) degraded.push("sessionExperience: unavailable");
    if (!goals) degraded.push("developmentGoal: unavailable");
    if (!debug) degraded.push("debuggingExperience: unavailable");
    if (!store) degraded.push("experienceStore: unavailable");

    let summary = { goal_hints: [], changes: [], errors: [], tests: [], decisions: [], unfinished: [], constraints: [] };
    let events = [];
    if (sess?.analyzeSessionExperience) {
      try {
        const r = await sess.analyzeSessionExperience({ session_id, project_id, lines });
        summary = r?.summary || summary;
        events = Array.isArray(r?.events) ? r.events : [];
      } catch (e) { degraded.push(`analyzeSessionExperience: ${errText(e)}`); }
    }

    if (goals) {
      try {
        const candidates = goals.extractGoalCandidates
          ? goals.extractGoalCandidates({ lines, summary, project_id }) : [];
        for (const c of (Array.isArray(candidates) ? candidates : []).slice(0, 5)) {
          const r = await goals.recordGoal({ project_id, title: c.title,
            description: c.description || "", requirements: c.requirements || [],
            constraints: c.constraints || [], evidence: c.evidence || [], source_session: session_id });
          if (r?.ok && !r.duplicate) {
            result.goals += 1;
            for (const t of (Array.isArray(c.tasks) ? c.tasks : []).slice(0, 10)) {
              const tr = await goals.recordTask({ project_id, goal_id: r.id, task_key: t.task_key || short(t.title, 120),
                title: t.title, status: t.status || "not_started", evidence: t.evidence || [],
                source_session: session_id });
              if (tr?.ok && !tr.duplicate) result.tasks += 1;
            }
          }
        }
      } catch (e) { degraded.push(`goals: ${errText(e)}`); }
    }

    // Explicit unfinished signals from the session analysis become not_started
    // tasks. Never advance status here: only verification evidence can do that.
    if (goals?.recordTask) {
      try {
        const unfinished = (Array.isArray(summary.unfinished) ? summary.unfinished : []).slice(0, 8);
        const activeGoal = (await goals.getGoals({ project_id, limit: 1 }))?.goals?.[0];
        for (const u of unfinished) {
          const text = typeof u === "string" ? u : u?.text;
          if (!text) continue;
          const key = `unfinished-${short(text, 80)}`;
          const r = await goals.recordTask({ project_id, goal_id: activeGoal?.id || null,
            task_key: key, title: short(text, 180), status: "not_started",
            evidence: [{ kind: "session_evidence", session: session_id, seq: u?.seq || null }],
            source_session: session_id });
          if (r?.ok && !r.duplicate) result.tasks += 1;
        }
      } catch (e) { degraded.push(`unfinished tasks: ${errText(e)}`); }
    }

    if (debug?.analyzeDebugging) {
      try {
        const d = await debug.analyzeDebugging({ lines, project_id, session_id });
        const exp = d?.experience;
        if (exp && (exp.problem || exp.symptoms?.length || exp.errors?.length)) {
          const r = await debug.recordDebuggingExperience({ project_id, session_id,
            title: short(exp.problem || exp.symptoms?.[0] || "debugging experience", 180),
            problem: exp.problem || "", environment: (exp.environment || []).join("; "),
            approach: exp.fix || (exp.investigation || []).join("; "), result: exp.outcome || "",
            verification_status: exp.verification?.status || "observed",
            root_cause: exp.root_cause || "", root_cause_status: exp.root_cause_status || "hypothesis",
            failed_approaches: exp.failed_approaches || [], evidence: exp.evidence || [] });
          if (r?.ok && !r.duplicate) result.debugging += 1;
        }
      } catch (e) { degraded.push(`debugging: ${errText(e)}`); }
    }

    if (store?.recordExperience) {
      try {
        const items = (Array.isArray(summary.decisions) ? summary.decisions.map((d) => ({ ...d, kind: "pattern" })) : [])
          .concat(Array.isArray(summary.unfinished) ? summary.unfinished.map((u) => ({ ...u, kind: "integration" })) : [])
          .slice(0, 6);
        for (const it of items) {
          if (!it?.text) continue;
          const r = await store.recordExperience({ project_id, session_id,
            title: short(it.text, 200), kind: it.kind || "pattern",
            problem: short(it.text, 300), evidence: [it.evidence || `session:${session_id}`, `seq:${it.seq}`],
            verification_status: "observed" });
          if (r?.ok && !r.duplicate) result.experiences += 1;
        }
      } catch (e) { degraded.push(`experienceStore: ${errText(e)}`); }
    }

    const evidence = [
      ...(Array.isArray(summary.errors) ? summary.errors.slice(0, 5).map((x) => `error:${short(x.signature || x.text, 80)}`) : []),
      ...(Array.isArray(summary.tests) ? summary.tests.slice(0, 5).map((x) => `test:${short(x.result, 80)}`) : []),
      `session:${session_id}`, `seq:${seq}`,
    ];
    await core.dbQuery(
      `UPDATE session_understanding SET status='done', summary=$2::jsonb, events=$3::jsonb,
        evidence=$4::jsonb, updated_at=now() WHERE id=$1`,
      [ledgerId, JSON.stringify(result), JSON.stringify(events.slice(0, 80)), JSON.stringify(evidence)]);
    try {
      await core.audit("session.understanding", session_id, {
        project_id, transcript_sequence: seq, analyzed_lines: lines.length,
        goals: result.goals, tasks: result.tasks, debugging: result.debugging,
        experiences: result.experiences, degraded,
      });
    } catch { /* best effort */ }
    return { ok: true, understanding_id: ledgerId, result };
  } catch (e) {
    const err = errText(e);
    try {
      await core.dbQuery("UPDATE session_understanding SET status='failed', updated_at=now() WHERE id=$1", [ledgerId]);
    } catch { /* best effort */ }
    return { ok: false, error: err, understanding_id: ledgerId };
  }
}

export async function sessionUnderstandingStatus({ project_id, status, limit = 50 } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, reason: "valid project_id required" };
  const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
  const r = await core.dbQuery(
    `SELECT id,session_id,transcript_sequence,status,created_at,updated_at
       FROM session_understanding
      WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY updated_at DESC LIMIT $3`, [project_id, status || null, n]);
  return { ok: true, items: r.rows, count: r.rows.length };
}

export async function retrySessionUnderstanding({ limit = 20 } = {}) {
  const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : 20;
  const rows = await core.dbQuery(
    `SELECT session_id,project_id,transcript_sequence FROM session_understanding
      WHERE status IN ('pending','failed') ORDER BY created_at LIMIT $1`, [n]);
  let retried = 0;
  for (const r of rows.rows) {
    try {
      const res = await runSessionUnderstanding({ session_id: r.session_id, project_id: r.project_id,
        sequence: r.transcript_sequence });
      if (res.ok && !res.duplicate) retried += 1;
    } catch { /* best effort */ }
  }
  return { ok: true, attempted: rows.rowCount, retried };
}

export default { runSessionUnderstanding, sessionUnderstandingStatus, retrySessionUnderstanding };
