// Role-aware, multilingual extraction from original OpenCode session records.
// All SQLite access is read-only. Original files are never modified.
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import * as core from "./core.js";

const SQLITE = process.env.SQLITE3 || "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";

const BENGALI = {
  preference: / always | never | prefer | must | should | চাই | চান | অবশ্যই | কখনো | পছন্দ | সবসময় | কখনই | করবেন | করতে | ব্যবহার/i,
  correction: / wrong | incorrect | instead | do not | don't | stop | ভুল | না | বদলে | পরিবর্তে | আবার | থামুন | করবেন না/i,
  failure: /(?:^|\s)(error:|failed|fails|failure|exception|traceback|crash|bug)(?:\s|$)|ত্রুটি|ব্যর্থ|এরর|বাগ/i,
  success: / fixed | resolved | solution | solved | works now | ঠিক | সমাধান | কাজ করছে | সম্পন্ন| fixed/i,
  decision: / decided | chose | went with | agreed | সিদ্ধান্ত | বেছে | নির্বাচন/i,
};

export function classifyText(text, role) {
  const t = ` ${String(text || "").replace(/\s+/g, " ").toLowerCase()} `;
  if (role === "USER") {
    if (BENGALI.correction.test(t)) return "user_correction";
    if (BENGALI.preference.test(t)) return "user_preference";
    if (BENGALI.failure.test(t)) return "repeated_failure";
    if (BENGALI.decision.test(t)) return "historical_decision";
    if (BENGALI.success.test(t)) return "successful_solution";
    return "user_statement";
  }
  if (role === "ASSISTANT") {
    if (BENGALI.failure.test(t) && BENGALI.success.test(t)) return "debugging_pattern";
    if (BENGALI.success.test(t)) return "successful_solution";
    if (BENGALI.failure.test(t)) return "repeated_failure";
    if (BENGALI.decision.test(t)) return "historical_decision";
    return "agent_reasoning";
  }
  return null; // tool/system/output is never a learning signal
}

export function languageOf(text) {
  const s = String(text || "");
  if (/[\u0980-\u09FF]/.test(s) && /[A-Za-z]/.test(s)) return "mixed";
  if (/[\u0980-\u09FF]/.test(s)) return "bn";
  return "en";
}

function sqliteRows(db, sql) {
  const out = execFileSync(SQLITE, ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

// Extract role-labelled lines from the ORIGINAL db (read-only).
export function extractSession(db, sessionId, limit = 80) {
  const sid = String(sessionId).replace(/'/g, "''");
  const rows = sqliteRows(db, `
    SELECT type, seq, json_extract(data,'$.text') AS direct, json_extract(data,'$.content') AS content,
           json_extract(data,'$.time.created') AS created
    FROM session_message WHERE session_id='${sid}'
    ORDER BY seq LIMIT ${Math.min(limit, 300)};`);
  const out = [];
  for (const r of rows) {
    let text = "";
    if (r.type === "user" && typeof r.direct === "string") text = r.direct;
    else if (r.type === "assistant" && r.content) {
      try {
        const arr = JSON.parse(r.content);
        text = (Array.isArray(arr) ? arr : []).filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text).join(" ");
      } catch { /* skip malformed */ }
    } else continue;
    text = String(text).replace(/\s+/g, " ").trim().slice(0, 1000);
    if (text.length < 8) continue;
    const role = r.type === "user" ? "USER" : "ASSISTANT";
    out.push({ role, seq: r.seq, text, time_created: r.created, kind: classifyText(text, role), language: languageOf(text) });
  }
  return out;
}

// Fill role-labelled summaries for indexed sessions that lack one. Original summary untouched.
export async function enrichSessionSummaries({ opencode_db, limit = 50 } = {}) {
  const db = opencode_db || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  const sessions = (await core.dbQuery(
    `SELECT id, directory FROM session_index WHERE summary_roles IS NULL ORDER BY time_updated DESC NULLS LAST LIMIT $1`,
    [Math.min(limit, 200)],
  )).rows;
  let enriched = 0, lines = 0;
  for (const s of sessions) {
    let extracted = [];
    try { extracted = extractSession(db, s.id); } catch { continue; }
    if (!extracted.length) continue;
    const signals = extracted.filter((x) => x.kind && x.kind !== "user_statement" && x.kind !== "agent_reasoning");
    const body = (signals.length ? signals : extracted.slice(0, 6))
      .map((x) => `${x.role}: ${x.text.slice(0, 280)}`).join("\n").slice(0, 6000);
    await core.dbQuery(`UPDATE session_index SET summary_roles=$2, role_extracted_at=now() WHERE id=$1`, [s.id, body]);
    for (const x of extracted) {
      await core.dbQuery(
        `INSERT INTO session_raw_lines (session_id, role, seq, text, kind, language, time_created)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7::bigint/1000.0) END)
         ON CONFLICT DO NOTHING`,
        [s.id, x.role, x.seq, x.text, x.kind, x.language, x.time_created || null],
      );
    }
    enriched++; lines += extracted.length;
  }
  await core.audit("history.role_enrich", "opencode.db", { enriched, lines });
  return { ok: true, sessions_enriched: enriched, lines_stored: lines, original_db_read_only: true };
}

export async function rawSession(id, { limit = 100, offset = 0, role, kind } = {}) {
  const total = (await core.dbQuery("SELECT count(*)::int AS n FROM session_raw_lines WHERE session_id=$1", [id])).rows[0].n;
  const rows = (await core.dbQuery(
    `SELECT role, seq, text, time_created FROM session_raw_lines
     WHERE session_id=$1 AND ($2::text IS NULL OR role=$2) AND ($3::text IS NULL OR kind=$3)
     ORDER BY seq LIMIT $4 OFFSET $5`,
    [id, role || null, kind || null, Math.min(limit, 300), offset],
  )).rows;
  const kinds = (await core.dbQuery(
    `SELECT kind, count(*)::int AS n FROM session_raw_lines WHERE session_id=$1 GROUP BY 1 ORDER BY n DESC`, [id],
  )).rows;
  return { ok: true, session_id: id, total, returned: rows.length, lines: rows, kinds };
}
