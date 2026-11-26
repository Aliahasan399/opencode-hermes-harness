// Phase 9 quality-aware pattern analysis. Additive: new statuses/columns, no deletions.
import crypto from "node:crypto";
import * as core from "./core.js";
import { classifyText, languageOf } from "./roles.js";

const TOKEN = /[\p{L}\p{N}_-]{3,}/gu;
const STOP = new Set(`the and for that this with from were have will would should must into your their about which while
  because however only even still used using make made run running there here what when where why how all any some
  more most other one two not no yes can could may might do does did done has had been being are was were its
  please just okay now also then than`.split(/\s+/));
const STOP_BN = new Set(`এই ওই যে এবং বা কিন্তু যদি তবে হবে ছিল আছে আছেন করে করুন করেন না নয় হ্যাঁ খুব
  আর সব কিছু এখন পরে আগে কারণ জন্য একটি`.split(/\s+/));

export function tokens(text) {
  return String(text || "").toLowerCase().match(TOKEN) || [];
}

export function clusterKey(kind, text) {
  const ts = tokens(text)
    .filter((t) => !STOP.has(t) && !STOP_BN.has(t) && t.length > 2)
    .sort()
    .slice(0, 7);
  return `${kind}:${ts.length ? ts.join("|") : crypto.createHash("md5").update(String(text).slice(0, 80)).digest("hex").slice(0, 12)}`;
}

function statusFor(kind, distinctSessions, hasOutcome, language) {
  if (distinctSessions >= 2 && hasOutcome && (kind === "successful_solution" || kind === "debugging_pattern" || kind === "historical_decision"))
    return "verified_fact";
  if (distinctSessions >= 2) return "repeated_observation";
  if (hasOutcome && (kind === "successful_solution" || kind === "debugging_pattern")) return "root_cause_candidate";
  return "hypothesis"; // NEVER promoted to confirmed without multi-session + outcome evidence
}

function linesFor(s) {
  const raw = s.summary_roles || s.summary || "";
  return String(raw).split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 10 && x.length < 700).slice(0, 60);
}

function parseLine(line) {
  const m = line.match(/^(USER|ASSISTANT):\s*(.*)$/s);
  if (m) return { role: m[1], text: m[2].trim() };
  return { role: "UNKNOWN", text: line };
}

export async function analyzeQuality({ limit = 200, project_id, force = false } = {}) {
  const sessions = (await core.dbQuery(
    `SELECT id, project_id, title, summary, summary_roles, message_count, time_updated FROM session_index
     WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY time_updated DESC NULLS LAST LIMIT $2`,
    [project_id || null, Math.min(limit, 500)],
  )).rows;
  let analyzed = 0, skipped = 0, signals = 0, promoted = 0;

  for (const s of sessions) {
    const hash = crypto.createHash("sha256")
      .update(`${s.title}|${s.summary}|${s.summary_roles}|${s.message_count}|${s.time_updated}`).digest("hex");
    const prev = await core.dbQuery("SELECT content_hash FROM analysis_state WHERE session_id=$1", [s.id]);
    if (!force && prev.rows[0]?.content_hash === hash) { skipped++; continue; }

    const pid = s.project_id || "_global";
    const seenInRun = new Set();
    for (const line of linesFor(s)) {
      const { role, text } = parseLine(line);
      const kind = classifyText(text, role);
      if (!kind || kind === "user_statement" || kind === "agent_reasoning") continue;
      // Agent reasoning is NEVER a signal; tool/system text is ignored by classifyText.
      const key = clusterKey(kind, text);
      if (key.length < 12) continue;
      const lang = languageOf(text);
      const hasOutcome = /fixed|resolved|worked|success|ঠিক|সমাধান|কাজ করছে/i.test(text);
      const evidence = JSON.stringify([{ session: s.id, project: pid, excerpt: text.slice(0, 400), role, lang }]);

      const existing = await core.dbQuery("SELECT * FROM pattern WHERE kind=$1 AND pattern_key=$2", [kind, key]);
      const distinct = new Set(existing.rows[0]?.sessions || []);
      distinct.add(s.id);
      const nDistinct = distinct.size;
      const status = statusFor(kind, nDistinct, hasOutcome, lang);
      const verified = status === "verified_fact";
      const confidence = Math.min(0.95, (status === "verified_fact" ? 0.75 : 0.45) + 0.08 * (nDistinct - 1));
      const sessionsArr = [...distinct];

      const r = await core.dbQuery(
        `INSERT INTO pattern (kind, pattern_key, description, occurrences, sessions, projects, evidence,
            confidence, verified, suggested_improvement, status, distinct_sessions, verification_reason, language)
         VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (kind, pattern_key) DO UPDATE SET
            description = CASE WHEN pattern.verified THEN pattern.description ELSE EXCLUDED.description END,
            occurrences = EXCLUDED.occurrences,
            sessions = EXCLUDED.sessions,
            projects = EXCLUDED.projects,
            distinct_sessions = EXCLUDED.distinct_sessions,
            status = EXCLUDED.status,
            verification_reason = EXCLUDED.verification_reason,
            confidence = EXCLUDED.confidence,
            verified = EXCLUDED.verified,
            language = EXCLUDED.language,
            last_observed = now(), updated_at = now()
         RETURNING id, verified`,
        [kind, key, text.slice(0, 300), sessionsArr.length, sessionsArr, [pid], evidence, confidence,
         verified, `Review as ${status}.`, status, nDistinct,
         verified ? `${nDistinct} distinct sessions with explicit outcome marker` : `${nDistinct} session(s), no verified outcome yet`, lang],
      );
      if (verified && !existing.rows[0]?.verified) promoted++;

      // Idempotent evidence: never insert an identical (pattern, session, excerpt) row twice.
      const ex = r.rows[0].id;
      if (!seenInRun.has(ex)) {
        seenInRun.add(ex);
        await core.dbQuery(
          `INSERT INTO pattern_evidence (pattern_id, session_id, project_id, excerpt)
           SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
             SELECT 1 FROM pattern_evidence WHERE pattern_id=$1 AND session_id=$2 AND excerpt=$4)`,
          [ex, s.id, pid, text.slice(0, 400)],
        );
      }
      signals++;
    }
    await core.dbQuery(
      `INSERT INTO analysis_state (session_id, source_updated, content_hash, analyzed_at)
       VALUES ($1,$2,$3,now()) ON CONFLICT (session_id) DO UPDATE SET
       source_updated=EXCLUDED.source_updated, content_hash=EXCLUDED.content_hash, analyzed_at=now()`,
      [s.id, s.time_updated || null, hash],
    );
    analyzed++;
  }
  await core.audit("pattern.quality_run", "all", { analyzed, skipped, signals, promoted });
  return { ok: true, sessions_seen: sessions.length, sessions_analyzed: analyzed, sessions_skipped: skipped, signals, promoted_to_verified: promoted };
}

export async function patternQuality() {
  return (await core.dbQuery(
    `SELECT status, verified, language, count(*)::int AS n, round(avg(confidence)::numeric,2) AS avg_conf
     FROM pattern GROUP BY 1,2,3 ORDER BY n DESC`,
  )).rows;
}

export async function feedback(pattern_id, verdict, reason = "") {
  if (!["useful", "not_useful"].includes(verdict)) throw new Error("invalid verdict");
  await core.dbQuery("INSERT INTO pattern_feedback (pattern_id,verdict,reason) VALUES ($1,$2,$3)", [pattern_id, verdict, reason]);
  if (verdict === "not_useful") {
    await core.dbQuery(`UPDATE pattern SET verified=false, status='rejected_false_positive',
      verification_reason='Rejected via user feedback' WHERE id=$1`, [pattern_id]);
  }
  await core.audit("pattern.feedback", pattern_id, { verdict, reason });
  return { ok: true, verdict };
}

export async function feedbackStats() {
  const r = await core.dbQuery(`SELECT verdict, count(*)::int AS n FROM pattern_feedback GROUP BY 1`);
  const out = { useful: 0, not_useful: 0 };
  for (const x of r.rows) out[x.verdict] = x.n;
  return out;
}
