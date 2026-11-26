// Phase 21 workstream A — automatic experience extraction from existing session
// understanding. Local, deterministic and additive-only: no LLM, no network, no
// destructive SQL. Extraction is pure (reads nothing, writes nothing); persistence
// is strictly project-scoped, bounded, deduplicated without overwrite and never
// promotes a weaker verification claim into a stronger one without real evidence.
import crypto from "node:crypto";
import * as core from "./core.js";

/** Frozen taxonomy of reusable experience categories. */
export const EXPERIENCE_CATEGORIES = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  DEBUGGING: "debugging",
  PATTERN: "pattern",
  CORRECTION: "correction",
  DECISION: "decision",
  WORKFLOW: "workflow",
});

// Read-path redaction: stored evidence from legacy/fixture rows must never be
// returned with raw credentials. Bounded recursion avoids pathological payloads.
function redactAny(value, depth = 0) {
  if (depth > 4) return "[redacted-depth]";
  if (typeof value === "string") return core.redact(value);
  if (Array.isArray(value)) return value.slice(0, 60).map((v) => redactAny(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = redactAny(v, depth + 1);
    return out;
  }
  return value;
}
function redactRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const key of ["problem", "approach", "signature", "reason", "error"]) {
    if (typeof out[key] === "string") out[key] = core.redact(out[key]);
  }
  for (const key of ["evidence", "confidence_breakdown", "metadata"]) {
    if (out[key] !== undefined && out[key] !== null) out[key] = redactAny(out[key]);
  }
  return out;
}

const CATEGORIES = new Set(Object.values(EXPERIENCE_CATEGORIES));
const OUTCOMES = new Set(["success", "failure", "uncertain"]);
const VERIFICATIONS = new Set(["verified", "observed", "inferred"]);
const REUSABILITY = new Set(["project", "team", "global"]);

const MAX_LINES = 80;
const MAX_EXPERIENCES = 12;
const MAX_EVIDENCE = 6;
const MAX_STORED_EVIDENCE = 60;
const EXCERPT = 160;
const FIELD = 240;
const MAX_LIST_LIMIT = 200;

const FIELDS = `id, project_id, session_id, signature, category, problem, approach,
  outcome, verification, confidence, confidence_breakdown, reusability, evidence,
  status, superseded_by, created_at, updated_at`;

// ---- deterministic detection rules (transcript/tool evidence only) --------
const PASS_RE = /\b(pass(?:ed)?|ok|green|all tests|\d+\s+tests?\s+(?:passed|ok)|test suite passed|verified)\b/i;
const FAIL_RE = /\b(\d+\s+tests?\s+failed|tests?\s+fail(?:ed)?|failing|assertionerror|assert\s+\S+\s*==|\bFAILED\b|fail)\b/i;
const ERROR_RE = /(?:error|exception|traceback|failed|fails|failure|assertionerror|assert\s+\S+\s*==|\bFAILED\b|crash(?:ed)?|non-?zero)/i;
const TEST_CMD_RE = /(node --test|npm test|pytest|vitest|jest|mocha|test suite|tests?\b)/i;
const FIX_RE = /\b(fix(?:ed|es|ing)?|resolved|corrected|patched|changed|updated to|replaced|switch(?:ed)? to|workaround)\b/i;
const CLAIM_RE = /\b(fixed|resolved|completed|done|all tests pass|tests? pass(?:ed)?|successfully|verified|now works|working now)\b/i;
const CORRECTION_RE = /\b(no[,.]|that'?s (?:wrong|incorrect|not right)|incorrect|wrong|not quite|instead|you should(?:n't)?|i meant|actually[,.]|correction|please (?:change|use|don't)|rather than)\b/i;
const DECISION_RE = /\b(decided|chose|choose|selected|opted(?:\s+for)?|went with|will use|shall use|going to use|migrated to|decision\s*:)\b/i;
const WRITE_TOOL_RE = /\b(edit|write|create|patch|apply_patch|replace|mkdir|touch|copy|move)\b/i;
const PASS_NEGATION_RE = /^\s*(0 failed|no error|passed|success)/i;
const VERIFICATION_EVIDENCE_RE = /\b(pass(?:ed)?|verified|test suite|all tests|pytest|node --test|npm test|vitest|jest)\b/i;

// ---- small pure helpers ----------------------------------------------------
function short(v, n = FIELD) {
  if (v === null || v === undefined) return "";
  return core.redact(String(v)).replace(/\s+/g, " ").trim().slice(0, n);
}

function nonEmpty(v) {
  return typeof v === "string" ? v.trim().length > 0 : (v !== null && v !== undefined && String(v).trim().length > 0);
}

function validProject(v) {
  return nonEmpty(v) && String(v).trim() !== "_global";
}

function sigOf(text, category) {
  const s = core.redact(String(text ?? ""))
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/gi, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{12,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[^\p{L}\p{N}<>:_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${category}:${s || "unknown"}`;
}

function clampConfidence(c) {
  if (c === null || c === undefined || c === "") return 0;
  const n = Number(c);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function boundedLimit(v, fallback, hard) {
  return Number.isInteger(v) && v >= 0 ? Math.min(v, hard) : fallback;
}

const errText = (e) => short(e && (e.message || e) ? (e.message || e) : "unknown error", 120);

// ---- extraction (pure, deterministic, no writes) ---------------------------
function normalizeLines(lines) {
  const arr = Array.isArray(lines) ? lines.slice(0, MAX_LINES) : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    try {
      const raw = arr[i] && typeof arr[i] === "object" ? arr[i] : {};
      let role = String(raw.role ?? "UNKNOWN").toUpperCase();
      if (!["USER", "ASSISTANT", "TOOL"].includes(role)) role = "UNKNOWN";
      const kind = raw.kind ? String(raw.kind).toUpperCase() : null;
      const tool = raw.tool ? short(raw.tool, 120) : null;
      const text = short(raw.text ?? raw.content ?? raw.message ?? "", 4000);
      if (!text) continue;
      const seq = Number.isFinite(Number(raw.seq)) ? Math.trunc(Number(raw.seq)) : i + 1;
      const exit = raw.metadata && raw.metadata.exit !== undefined
        ? raw.metadata.exit
        : (raw.exit !== undefined ? raw.exit : null);
      const isTool = role === "TOOL" || kind === "TOOL_RESULT"
        || (!kind && !!tool && role !== "ASSISTANT" && role !== "USER");
      out.push({ seq, role, kind, tool, text, exit, isTool });
    } catch {
      // A malformed line is skipped; extraction never throws on input.
      continue;
    }
  }
  return out;
}

function failedExit(ev) {
  const x = ev.exit;
  return x !== null && x !== undefined && x !== "" && Number(x) !== 0;
}

function isPass(ev, passSeqs) {
  if (!ev.isTool) return false;
  if (passSeqs.has(ev.seq)) return !FAIL_RE.test(ev.text);
  return PASS_RE.test(ev.text)
    && (TEST_CMD_RE.test(ev.tool || "") || TEST_CMD_RE.test(ev.text))
    && !FAIL_RE.test(ev.text) && !failedExit(ev);
}

function isError(ev, errorSeqs) {
  if (!ev.isTool) return false;
  if (errorSeqs.has(ev.seq)) return true;
  return (ERROR_RE.test(ev.text) || failedExit(ev)) && !PASS_NEGATION_RE.test(ev.text);
}

function isFix(ev) {
  return FIX_RE.test(ev.text) && (ev.role === "ASSISTANT" || ev.isTool);
}

function evidenceOf(ev) {
  return {
    seq: ev.seq,
    role: ev.role,
    ...(ev.tool ? { tool: ev.tool } : {}),
    excerpt: short(ev.text, EXCERPT),
  };
}

function goalFromUnderstanding(understanding) {
  const gh = understanding && understanding.summary && understanding.summary.goal_hints;
  return Array.isArray(gh) && gh.length ? short(gh[0], FIELD) : "";
}

/**
 * Pure, deterministic extraction of reusable experiences from transcript lines.
 * Reuses sessionExperience.analyzeSessionExperience when available (best effort),
 * but never writes anything. A passing test command is success+verified; a tool
 * error with no later fix/pass is a failure; a user correction is a correction;
 * a bare assistant claim is always uncertain/observed, never verified.
 */
export async function extractExperiences({
  session_id, project_id, lines = [], understanding = null,
} = {}) {
  const degraded = [];
  const arr = Array.isArray(lines) ? lines.slice(0, MAX_LINES) : [];
  const evs = normalizeLines(arr);

  // Best-effort reuse of the Phase 19 session analyzer. It is pure; a failure to
  // load or run it degrades gracefully and never blocks local extraction.
  let analysis = null;
  try {
    const sess = await import("./sessionExperience.js");
    if (typeof sess.analyzeSessionExperience === "function") {
      analysis = sess.analyzeSessionExperience({ session_id, project_id, lines: arr });
      if (analysis && typeof analysis.then === "function") analysis = await analysis;
      if (!analysis || analysis.ok !== true) {
        degraded.push("analyzeSessionExperience: unavailable");
        analysis = null;
      }
    } else {
      degraded.push("sessionExperience: no analyzer");
    }
  } catch (e) {
    degraded.push(`sessionExperience: ${errText(e)}`);
    analysis = null;
  }

  const passSeqs = new Set();
  const errorSeqs = new Set();
  if (analysis) {
    for (const t of (Array.isArray(analysis.summary?.tests) ? analysis.summary.tests : [])) {
      if (t && t.result === "pass" && t.seq !== undefined) passSeqs.add(t.seq);
    }
    for (const e of (Array.isArray(analysis.summary?.errors) ? analysis.summary.errors : [])) {
      if (e && e.seq !== undefined) errorSeqs.add(e.seq);
    }
  }

  // Map every event to the latest user/assistant statement before it, so each
  // experience carries a short problem/approach rather than the whole session.
  let currentUser = goalFromUnderstanding(understanding);
  let currentAssistant = "";
  const userBefore = [];
  const assistantBefore = [];
  for (let i = 0; i < evs.length; i++) {
    userBefore[i] = currentUser;
    assistantBefore[i] = currentAssistant;
    if (evs[i].role === "USER") currentUser = short(evs[i].text, FIELD);
    else if (evs[i].role === "ASSISTANT") currentAssistant = short(evs[i].text, FIELD);
  }

  const candidates = [];
  const seen = new Set();
  const add = (e) => {
    if (seen.has(e.signature)) return;
    seen.add(e.signature);
    candidates.push(e);
  };
  const make = (category, key, problem, approach, outcome, verification, evidence, confidence_hint) => ({
    signature: sigOf(key, category),
    category,
    problem: short(problem, FIELD) || "Session work",
    approach: short(approach, FIELD),
    outcome,
    verification,
    evidence: evidence.slice(0, MAX_EVIDENCE).map(evidenceOf),
    confidence_hint,
    reusability: "project",
  });

  const passEvents = [];
  const errorEvents = [];
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (isPass(ev, passSeqs)) passEvents.push(i);
    if (isError(ev, errorSeqs)) errorEvents.push(i);
  }

  // 1. A passing test command is observed, verified success.
  for (const i of passEvents) {
    const ev = evs[i];
    add(make("success", ev.tool || ev.text, userBefore[i] || "Verify the change",
      ev.tool ? `${ev.tool} ${ev.text}` : ev.text, "success", "verified",
      [ev], 0.85));
  }

  // 2. Tool errors: a later fix or passing verification makes it a debugging
  // experience; an unresolved error is preserved as a failure.
  for (const i of errorEvents) {
    const ev = evs[i];
    const resolved = evs.some((later, j) => j > i && (isFix(later) || isPass(later, passSeqs)));
    const problem = userBefore[i] || short(ev.text, FIELD);
    if (resolved) {
      const fixIdx = evs.findIndex((later, j) => j > i && isFix(later));
      const approach = fixIdx >= 0 ? evs[fixIdx].text : ev.text;
      add(make("debugging", ev.text, problem, approach, "uncertain", "observed",
        [ev, ...(fixIdx >= 0 ? [evs[fixIdx]] : [])], 0.6));
    } else {
      add(make("failure", ev.text, problem,
        ev.tool ? `${ev.tool} ${ev.text}` : ev.text, "failure", "observed",
        [ev], 0.7));
    }
  }

  // 3. User corrections describe what the user actually wanted instead.
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.role === "USER" && CORRECTION_RE.test(ev.text)) {
      add(make("correction", ev.text, assistantBefore[i] || userBefore[i],
        ev.text, "uncertain", "observed", [ev], 0.6));
    }
  }

  // 4. A bare assistant claim, with no passing test evidence anywhere, is only
  //    an observed pattern — never a verified success.
  if (passEvents.length === 0) {
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.role === "ASSISTANT" && CLAIM_RE.test(ev.text)) {
        add(make("pattern", ev.text, userBefore[i], ev.text, "uncertain", "observed",
          [ev], 0.35));
      }
    }
  }

  // 5. Explicit decisions and repeated tool procedures are captured at low
  //    confidence; neither is ever treated as verified.
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (DECISION_RE.test(ev.text)) {
      add(make("decision", ev.text, userBefore[i], ev.text, "uncertain", "observed",
        [ev], 0.5));
    }
  }
  const writeTools = [...new Set(evs.filter((e) => e.isTool && WRITE_TOOL_RE.test(e.tool || ""))
    .map((e) => e.tool).filter(Boolean))];
  if (writeTools.length >= 3) {
    add(make("workflow", writeTools.join(" "), userBefore[0] || "Repeated procedure",
      writeTools.join(" -> "), "uncertain", "observed",
      evs.filter((e) => e.isTool && WRITE_TOOL_RE.test(e.tool || "")).slice(0, MAX_EVIDENCE),
      0.5));
  }

  return {
    ok: true,
    analyzed_lines: arr.length,
    experiences: candidates.slice(0, MAX_EXPERIENCES),
    degraded,
  };
}

// ---- persistence helpers ---------------------------------------------------
function evidenceString(value) {
  if (typeof value === "string") return core.redact(value).trim();
  if (value && typeof value === "object") {
    try { return core.redact(JSON.stringify(value, Object.keys(value).sort())); }
    catch { return core.redact(String(value)); }
  }
  return core.redact(String(value ?? "")).trim();
}

function normalizeEvidence(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input.slice(0, 20)) {
    const s = evidenceString(item).slice(0, 800);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function mergeEvidence(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of (Array.isArray(list) ? list : [])) {
      if (typeof item === "string") {
        if (seen.has(item)) continue;
        seen.add(item);
      }
      out.push(item);
    }
  }
  return out.length > MAX_STORED_EVIDENCE ? out.slice(out.length - MAX_STORED_EVIDENCE) : out;
}

function hasVerificationEvidence(list) {
  return list.some((e) => {
    if (typeof e === "string") return VERIFICATION_EVIDENCE_RE.test(e);
    if (e && typeof e === "object") {
      if (/verif|pass|test/i.test(String(e.kind || ""))) return true;
      return Object.values(e).some((v) => typeof v === "string" && VERIFICATION_EVIDENCE_RE.test(v));
    }
    return false;
  });
}

const VRANK = { inferred: 1, observed: 2, verified: 3 };

function decideVerification(oldV, newV, evidence) {
  const o = VRANK[oldV] ?? 2;
  const n = VRANK[newV] ?? 2;
  if (n <= o) return oldV; // no demotion, no equal-strength promotion
  if (oldV === "inferred" && newV === "verified") return oldV; // explicit hard rule
  if (newV === "verified" && !hasVerificationEvidence(evidence)) return oldV;
  return newV;
}

/**
 * Record an extracted learning experience. Dedupes on (project_id, signature)
 * WITHOUT overwriting: a duplicate appends its evidence to the evidence history,
 * bumps updated_at, and keeps the original status/verification unless incoming
 * evidence is strictly stronger. `inferred` is never promoted to `verified`.
 */
export async function recordLearningExperience({
  project_id, session_id, signature, category, problem, approach, outcome,
  verification, confidence, evidence = [], reusability = "project", id,
} = {}) {
  if (!validProject(project_id)) {
    return { ok: false, created: false, id: null, reason: "invalid_project_id" };
  }
  if (!nonEmpty(signature)) {
    return { ok: false, created: false, id: null, reason: "invalid_signature" };
  }
  if (!Array.isArray(evidence)) {
    return { ok: false, created: false, id: null, reason: "invalid_evidence" };
  }

  const pid = String(project_id).trim().slice(0, 200);
  const cleanSig = short(signature, 500);
  if (!cleanSig) return { ok: false, created: false, id: null, reason: "invalid_signature" };
  const sessionId = nonEmpty(session_id) ? short(session_id, 200) : null;
  const cleanCategory = CATEGORIES.has(category) ? category : "pattern";
  const cleanOutcome = OUTCOMES.has(outcome) ? outcome : "uncertain";
  const cleanReusability = REUSABILITY.has(reusability) ? reusability : "project";
  const conf = clampConfidence(confidence);
  const safeEvidence = normalizeEvidence(evidence);

  let cleanVerification = VERIFICATIONS.has(verification) ? verification : "observed";
  if (cleanVerification === "verified" && !hasVerificationEvidence(safeEvidence)) {
    cleanVerification = "observed";
  }
  const callerId = nonEmpty(id) ? short(id, 200) : null;
  const newId = callerId || crypto.randomUUID();

  const result = await core.withDb(async (c) => {
    const dup = await c.query(
      "SELECT * FROM learning_record WHERE project_id=$1 AND signature=$2 LIMIT 1",
      [pid, cleanSig],
    );
    const existing = dup.rows[0] || null;

    if (existing) {
      const oldEvidence = Array.isArray(existing.evidence) ? existing.evidence.slice() : [];
      const oldVerification = String(existing.verification || "observed");
      const finalVerification = decideVerification(oldVerification, cleanVerification, safeEvidence);
      const history = {
        event: "learning.record_duplicate",
        at: new Date().toISOString(),
        previous: {
          status: existing.status || "active",
          verification: oldVerification,
          confidence: existing.confidence ?? null,
          evidence_count: oldEvidence.length,
        },
        incoming: {
          category: cleanCategory,
          outcome: cleanOutcome,
          verification: cleanVerification,
          confidence: conf,
          session_id: sessionId,
          evidence_count: safeEvidence.length,
        },
        history: safeEvidence,
      };
      const merged = mergeEvidence([oldEvidence, [history], safeEvidence]);
      await c.query(
        "UPDATE learning_record SET evidence=$2::jsonb, verification=$3, updated_at=now() WHERE id=$1 AND project_id=$4",
        [existing.id, JSON.stringify(merged), finalVerification, pid],
      );
      return {
        ok: true, id: existing.id, created: false, duplicate: true,
        promoted: finalVerification !== oldVerification,
      };
    }

    if (callerId) {
      const pk = await c.query("SELECT id FROM learning_record WHERE id=$1 LIMIT 1", [newId]);
      if (pk.rowCount) return { ok: false, created: false, id: newId, reason: "id_collision" };
    }

    await c.query(
      `INSERT INTO learning_record
         (id, project_id, session_id, signature, category, problem, approach,
          outcome, verification, confidence, confidence_breakdown, reusability,
          evidence, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,'active',now(),now())`,
      [newId, pid, sessionId, cleanSig, cleanCategory, short(problem, 2000),
        short(approach, 2000), cleanOutcome, cleanVerification, conf,
        JSON.stringify({}), cleanReusability, JSON.stringify(safeEvidence)],
    );
    return { ok: true, id: newId, created: true, duplicate: false };
  });

  try {
    await core.audit("learning.experience_recorded", pid, {
      id: result.id, created: result.created, duplicate: !!result.duplicate,
      category: cleanCategory, verification: cleanVerification,
    });
  } catch { /* best effort */ }
  return result;
}

// ---- bounded, strictly project-scoped reads --------------------------------
export async function getLearningExperiences({ project_id, category, status, limit = 50 } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, items: [], count: 0, reason: "invalid_project_id" };
  }
  if (category !== undefined && category !== null && !CATEGORIES.has(category)) {
    return { ok: false, items: [], count: 0, reason: "invalid_category" };
  }
  if (status !== undefined && status !== null && typeof status !== "string") {
    return { ok: false, items: [], count: 0, reason: "invalid_status" };
  }
  const n = boundedLimit(limit, 50, MAX_LIST_LIMIT);
  try {
    const r = await core.dbQuery(
      `SELECT ${FIELDS} FROM learning_record
        WHERE project_id=$1
          AND ($2::text IS NULL OR category=$2)
          AND ($3::text IS NULL OR status=$3)
        ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [String(project_id).trim(), category ?? null, status ?? null, n],
    );
    return { ok: true, items: r.rows.map(redactRow), count: r.rows.length };
  } catch {
    return { ok: false, items: [], count: 0, reason: "learning request could not be completed" };
  }
}

export async function getLearningBySession({ session_id, project_id, limit = 50 } = {}) {
  if (!validProject(project_id)) {
    return { ok: false, items: [], count: 0, reason: "invalid_project_id" };
  }
  if (!nonEmpty(session_id)) {
    return { ok: false, items: [], count: 0, reason: "invalid_session_id" };
  }
  const n = boundedLimit(limit, 50, MAX_LIST_LIMIT);
  try {
    const r = await core.dbQuery(
      `SELECT ${FIELDS} FROM learning_record
        WHERE project_id=$1 AND session_id=$2
        ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [String(project_id).trim(), short(session_id, 200), n],
    );
    return { ok: true, items: r.rows.map(redactRow), count: r.rows.length };
  } catch {
    return { ok: false, items: [], count: 0, reason: "learning request could not be completed" };
  }
}

export default {
  EXPERIENCE_CATEGORIES,
  extractExperiences,
  recordLearningExperience,
  getLearningExperiences,
  getLearningBySession,
};
