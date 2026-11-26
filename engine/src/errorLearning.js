// Error fingerprinting, fix verification, recurrence and non-recurrence evidence.
// Nothing here promotes a strategy or memory to verified; it only records evidence.
import crypto from "node:crypto";
import * as core from "./core.js";
import { readLines } from "./transcript.js";

// Extended to recognize real tool-output failure signatures (pytest "FAILED
// path::test", "AssertionError: assert -1 == 5", bare "failed"), not just the
// older "error:" / "failed:" spellings. Ordinary prose is still filtered by
// DOC_NOISE and by preferring TOOL lines when linking a fix.
const ERROR_RE = /(?:^|\s)(error:|exception:|traceback|failed:|fails:|test[s]?\s+fail|build\s+fail|crash(?:ed)?|assertionerror|assert\s+\S+\s*==|\bfailed\b|\berrors?\b|\bexceptions?\b|ব্যর্থ|ত্রুটি|এরর)(?:\s|:|$)/i;
const PASS_RE = /\b(pass|passed|success|ok|green|1 test passed)\b/i;
const DOC_NOISE = /<skill_content|core principle|skill:|reference|documentation/i;

export function isErrorLine(text) {
  const s = String(text || "");
  if (DOC_NOISE.test(s)) return false;
  return ERROR_RE.test(s) && !/^\s*(0 failed|no error|passed)/i.test(s);
}

export function fingerprint(text) {
  const sig = String(text || "")
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/gi, "<path>")
    .replace(/[a-z]:\/[^\s]+/gi, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{12,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[^\p{L}\p{N}<>:_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return { hash: crypto.createHash("sha256").update(sig).digest("hex").slice(0, 24), signature: sig };
}

function findErrorLines(lines) {
  const found = lines.filter((l) => isErrorLine(l.text));
  // Keep all evidence, but put actual tool output last so a fix is linked to the
  // concrete execution error rather than a user prompt that merely says "error".
  return [...found.filter((l) => l.role !== "TOOL"), ...found.filter((l) => l.role === "TOOL")];
}

export async function recordFailure({ session_id, project_id, text, seq } = {}) {
  if (!text || !isErrorLine(text)) return { ok: true, recorded: 0 };
  const fp = fingerprint(text);
  const pid = project_id || "_global";
  const r = await core.dbQuery(
    `INSERT INTO fix_evidence (project_id,error_hash,error_signature,session_id,status,confidence,evidence)
     VALUES ($1,$2,$3,$4,'observed_failure',0.8,$5::jsonb)
     ON CONFLICT (project_id,error_hash,session_id) DO NOTHING RETURNING id`,
    [pid, fp.hash, fp.signature, session_id, JSON.stringify({ seq: seq || null, excerpt: String(text).slice(0, 300) })],
  );
  await core.audit("learning.error_failure", session_id, { hash: fp.hash, recorded: r.rowCount });
  return { ok: true, recorded: r.rowCount, error_hash: fp.hash, signature: fp.signature };
}

export async function recordFix({ session_id, project_id, error_hash, attempted_fix, verification_command, verification_result } = {}) {
  if (!error_hash || !session_id) return { ok: false, reason: "error_hash and session_id required" };
  const verified = PASS_RE.test(String(verification_result || ""));
  const status = verified ? "verified_fix" : "attempted_fix";
  const confidence = verified ? 0.75 : 0.45;
  const r = await core.dbQuery(
    `UPDATE fix_evidence SET attempted_fix=$3,verification_command=$4,verification_result=$5,
       status=$6,confidence=GREATEST(confidence,$7),updated_at=now()
     WHERE session_id=$1 AND error_hash=$2 AND status IN ('observed_failure','attempted_fix')
     RETURNING id`,
    [session_id, error_hash, String(attempted_fix || "").slice(0, 1000) || null,
     String(verification_command || "").slice(0, 500) || null,
     String(verification_result || "").slice(0, 500) || null, status, confidence],
  );
  await core.audit("learning.fix_verification", session_id, { error_hash, status });
  return { ok: true, updated: r.rowCount, status, verification_observed: verified };
}

export async function observeRecurrence({ session_id, project_id, error_hash, window_days = 7 } = {}) {
  if (!error_hash) return { ok: false, reason: "error_hash required" };
  const pid = project_id || "_global";
  const source = (await core.dbQuery("SELECT * FROM fix_evidence WHERE project_id=$1 AND error_hash=$2 ORDER BY id LIMIT 1", [pid, error_hash])).rows[0];
  if (!source) return { ok: false, reason: "error not found in project" };
  const later = (await core.dbQuery(
    `SELECT 1 FROM fix_evidence WHERE project_id=$1 AND error_hash=$2 AND id > $3 LIMIT 1`,
    [pid, error_hash, source.id])).rowCount;
  if (later) {
    await core.dbQuery("UPDATE fix_evidence SET status='regressed',confidence=LEAST(confidence,0.35),updated_at=now() WHERE project_id=$1 AND error_hash=$2", [pid, error_hash]);
    await core.audit("learning.error_recurrence", pid, { error_hash, outcome: "regressed" });
    return { ok: true, outcome: "regressed", confidence: 0.35 };
  }
  const ageDays = (Date.now() - new Date(source.created_at).getTime()) / 86400000;
  if (ageDays < window_days) return { ok: true, outcome: "observation_window_open", days: Number(ageDays.toFixed(2)) };
  const status = source.status === "verified_fix" ? "strongly_supported" : "non_recurrence";
  const confidence = source.status === "verified_fix" ? 0.8 : 0.55;
  await core.dbQuery("UPDATE fix_evidence SET status=$3,confidence=GREATEST(confidence,$4),updated_at=now() WHERE project_id=$1 AND error_hash=$2",
    [pid, error_hash, status, confidence]);
  await core.audit("learning.error_non_recurrence", pid, { error_hash, outcome: status });
  return { ok: true, outcome: status, confidence };
}

export async function analyzeSessionErrors({ session_id, project_id, lines: suppliedLines } = {}) {
  // Use the caller's durable snapshot when provided: the learning and error stages
  // then analyze the exact same transcript, with no second read that could observe
  // a different (still incomplete) file state. Fallback keeps old callers working.
  const lines = Array.isArray(suppliedLines) ? suppliedLines : readLines(session_id);
  const errors = findErrorLines(lines);
  let recorded = 0;
  for (const l of errors) {
    const r = await recordFailure({ session_id, project_id, text: l.text, seq: l.seq });
    recorded += r.recorded;
  }
  // Prefer a real TOOL pass line (with its verification command) over ordinary
  // text that happens to contain "pass", so generic prompts are not mistaken for
  // a verified execution result.
  let passCandidates = lines.filter((l) => PASS_RE.test(String(l.text || "")));
  // A late verification line can land in the durable transcript after the
  // in-memory snapshot was taken. Reading it here is safe: it is append-only and
  // may only ADD evidence, never remove or rewrite it.
  if (!passCandidates.length && Array.isArray(suppliedLines)) {
    const durable = readLines(session_id);
    passCandidates = durable.filter((l) => PASS_RE.test(String(l.text || "")));
  }
  const passLine = passCandidates.find((l) => l.role === "TOOL")
    || passCandidates[passCandidates.length - 1] || null;
  let fix = null;
  if (passLine && errors.length) {
    const fp = fingerprint(errors[errors.length - 1].text);
    fix = await recordFix({ session_id, project_id, error_hash: fp.hash,
      attempted_fix: lines.filter((l) => /fix|install|change|update|add/i.test(l.text)).map((l) => l.text.slice(0, 300)).join(" | "),
      verification_command: passLine.tool || null, verification_result: passLine.text });
  }
  return {
    ok: true,
    errors: errors.length,
    recorded,
    lines: lines.length,
    fix_linked: fix !== null,
    verified: fix?.verification_observed === true,
    verification_command: passLine?.tool || null,
  };
}

export async function fixEvidenceReport({ project_id, limit = 50 } = {}) {
  const rows = (await core.dbQuery(
    `SELECT session_id,project_id,error_hash,error_signature,status,confidence,verification_result,created_at
     FROM fix_evidence WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY created_at DESC LIMIT $2`, [project_id || null, Math.min(limit, 200)])).rows;
  const summary = (await core.dbQuery(
    `SELECT status,count(*)::int n FROM fix_evidence WHERE ($1::text IS NULL OR project_id=$1) GROUP BY 1`, [project_id || null])).rows;
  return { ok: true, summary, items: rows, note: "evidence only; no automatic verification promotion" };
}
