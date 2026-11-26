// Phase 19 workstream C — Debugging Experience.
//
// Connects deterministic debugging-process analysis to evidence-graded, reusable
// experiences. Design invariants (all local, no LLM, no network):
//   * A root cause is "confirmed" ONLY from explicit tool/test evidence markers.
//     An assistant explanation on its own always stays a "hypothesis".
//   * Symptoms, investigations, failed approaches, workarounds and fixes are kept
//     distinct. Failed approaches are preserved for avoidance, never recommended.
//   * Verification status is earned by evidence, never inferred from confidence.
//     "verified" is downgraded unless verification evidence actually exists.
//   * Everything is project-scoped, bounded and append-only. No destructive SQL,
//     no cross-project access, no secrets in stored evidence or audit trails.
import crypto from "node:crypto";
import * as core from "./core.js";

// Ordered stages of a debugging process. Enumerable lowercase keys map to their
// own name; a non-enumerable iterator and uppercase aliases make the constant
// usable both as a list and as a lookup table without polluting Object.keys.
export const DEBUG_STAGES = (() => {
  const names = [
    "problem", "symptoms", "environment", "investigation", "failed_approach",
    "root_cause", "fix", "verification", "outcome",
  ];
  const stages = {};
  for (const n of names) stages[n] = n;
  Object.defineProperty(stages, Symbol.iterator, {
    value: function* () { for (const n of names) yield n; },
    enumerable: false,
  });
  for (const n of names) {
    Object.defineProperty(stages, n.toUpperCase(), { value: n, enumerable: false });
  }
  return Object.freeze(stages);
})();

const MAX_LINES = 80;
const MAX_ITEMS = 40;
const MAX_EVIDENCE = 50;

const DOC_NOISE = /<skill_content|core principle|skill:|reference|documentation/i;

// Deterministic evidence markers. These describe OBSERVABLE transcript/tool
// evidence, not claims to be promoted automatically.
const RE = {
  error: /(error|exception|traceback|failed|fails|failure|assertionerror|assert\s+\S+\s*==|\bFAILED\b|crash(?:ed)?)/i,
  pass: /\b(pass(?:ed)?|success|green|test suite|all tests|1 passed|ok)\b/i,
  regression: /\b(regression|all tests|full suite|test suite|whole suite|entire suite)\b/i,
  rootCause: /\b(root[\s-]?cause|caused by|because of|due to|diagnos(?:ed|is)|the (?:actual |real )?cause is|underlying cause)\b/i,
  failed: /\b(did ?n[o']?t work|did not work|no effect|without success|reverted|abandoned|failed attempt|first(?:ly)? (?:i |we )?tried|initially tried|tried .{0,60}(?:but|failed|didn't)|attempted .{0,60}(?:but|failed|didn't))\b/i,
  workaround: /\b(workaround|temporary|temporarily|for now|hotfix|band-?aid|stopgap|interim|quick fix)\b/i,
  fix: /\b(fix(?:ed|es|ing)?|resolved|corrected|patched|chang(?:e|ed|es|ing)(?:\s+to)?|updated to|replaced|reverting|switch(?:ed)? to)\b/i,
  environment: /\b(node|npm|python|pytest|postgres(?:ql)?|mysql|sqlite|version|v?\d+\.\d+|windows|linux|macos|ubuntu|docker|kubernetes|environment|runtime)\b/i,
  investigation: /\b(investigat|checked|inspect|looked at|reproduc|observed|found|logs?|stack trace|compared|debugg|diagnos)/i,
};

const VERIFICATION_EVIDENCE_RE = /\b(pass(?:ed)?|success|green|regression|test suite|all tests|verified|ok)\b/i;
const ROOT_CAUSE_EVIDENCE_RE = /\b(root[\s-]?cause|caused by|diagnos(?:ed|is)|confirmed|cause\s*:)\b/i;

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0
    : (value !== null && value !== undefined && String(value).trim().length > 0);
}

function clampConfidence(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

// ---- line normalization (never throws on malformed input) ----------------
function normalizeLine(raw, i) {
  let role = "UNKNOWN";
  let text = "";
  let tool = null;
  let seq = i + 1;
  let session_id = null;
  try {
    if (raw && typeof raw === "object") {
      role = String(raw.role ?? "UNKNOWN").toUpperCase();
      text = String(raw.text ?? raw.content ?? raw.message ?? "");
      tool = raw.tool ? String(raw.tool) : null;
      seq = Number.isFinite(Number(raw.seq)) ? Math.trunc(Number(raw.seq)) : i + 1;
      session_id = raw.session_id ? String(raw.session_id) : null;
    } else if (typeof raw === "string") {
      text = raw;
    } else if (raw !== null && raw !== undefined) {
      text = String(raw);
    }
  } catch {
    // A hostile getter or exotic object must not abort analysis.
  }
  return { role, text: core.redact(text).slice(0, 4000), tool, seq, session_id };
}

function emptyExperience() {
  return {
    problem: "",
    symptoms: [],
    environment: [],
    investigation: [],
    failed_approaches: [],
    root_cause: "",
    root_cause_status: "hypothesis",
    fix: "",
    verification: { status: "unverified", evidence: [] },
    outcome: "",
    evidence: [],
  };
}

/**
 * Pure, deterministic extraction of a debugging experience from transcript and
 * tool evidence. No DB writes, no LLM, no network. Never throws; input is bounded
 * to 80 lines. The returned `experience` mirrors the dev_experience columns.
 */
export function analyzeDebugging({ lines = [], project_id, session_id } = {}) {
  const arr = Array.isArray(lines) ? lines.slice(0, MAX_LINES) : [];
  const norm = arr.map(normalizeLine).filter((l) => l.text.trim().length > 0);
  const experience = emptyExperience();
  const ex = experience;

  const add = (key, value) => {
    if (ex[key].length < MAX_ITEMS && !ex[key].includes(value)) ex[key].push(value);
  };
  const ev = (kind, l, extra = {}) => ({
    kind, seq: l.seq, role: l.role, tool: l.tool,
    excerpt: l.text.slice(0, 240), ...extra,
  });
  const addEvidence = (e) => { if (ex.evidence.length < MAX_ITEMS) ex.evidence.push(e); };

  // The problem statement is the first human line (fall back to the first error).
  const human = norm.find((l) => (l.role === "USER" || l.role === "UNKNOWN") && !DOC_NOISE.test(l.text));
  if (human) {
    ex.problem = human.text.slice(0, 400);
    addEvidence(ev("problem", human));
  }

  let lastError = null;
  let lastPass = null;
  let lastFix = null;
  let rootCandidate = null; // { line, isTool }
  let sawToolEvidence = false; // any TOOL error/pass line
  let hasRegression = false;
  let workaroundSeen = false;

  for (const l of norm) {
    if (DOC_NOISE.test(l.text)) continue;
    const isTool = l.role === "TOOL";

    if (RE.environment.test(l.text) && (isTool || l.role === "USER")) {
      add("environment", l.text.slice(0, 240));
      addEvidence(ev("environment", l));
    }
    if (RE.investigation.test(l.text)) {
      add("investigation", l.text.slice(0, 240));
      addEvidence(ev("investigation", l));
    }
    if (RE.error.test(l.text)) {
      add("symptoms", l.text.slice(0, 240));
      addEvidence(ev("symptom", l));
      lastError = l;
      if (isTool) sawToolEvidence = true;
    }
    if (RE.failed.test(l.text)) {
      add("failed_approaches", l.text.slice(0, 240));
      addEvidence(ev("failed_approach", l));
    }
    if (RE.rootCause.test(l.text)) {
      // Prefer an explicit tool-sourced cause over assistant speculation.
      if (!rootCandidate || (isTool && !rootCandidate.isTool)) rootCandidate = { line: l, isTool };
      addEvidence(ev("root_cause", l, { source: isTool ? "tool" : "assistant" }));
    }
    const isWorkaround = RE.workaround.test(l.text);
    if (isWorkaround) {
      workaroundSeen = true;
      addEvidence(ev("workaround", l));
    }
    if (RE.fix.test(l.text)) {
      lastFix = l;
      addEvidence(ev("fix", l, { workaround: isWorkaround, attempted_only: true }));
    }
    if (isTool && RE.pass.test(l.text)) {
      lastPass = l;
      sawToolEvidence = true;
      const reg = RE.regression.test(l.text);
      if (reg) hasRegression = true;
      ex.verification.evidence.push(ev(reg ? "regression" : "pass", l));
    }
  }

  if (!ex.problem && lastError) {
    ex.problem = lastError.text.slice(0, 400);
    addEvidence(ev("problem", lastError, { inferred: true }));
  }

  // Root cause: confirmed only from an explicit tool marker corroborated by a
  // tool/test evidence line. An assistant-only explanation stays a hypothesis.
  if (rootCandidate) {
    ex.root_cause = rootCandidate.line.text.slice(0, 400);
    ex.root_cause_status = (rootCandidate.isTool && sawToolEvidence) ? "confirmed" : "hypothesis";
    addEvidence(ev("root_cause_status", rootCandidate.line,
      { status: ex.root_cause_status, source: rootCandidate.isTool ? "tool" : "assistant" }));
  }

  // Fix and verification: local success != regression-tested success.
  if (lastFix) ex.fix = lastFix.text.slice(0, 400);
  if (hasRegression) ex.verification.status = "regression_tested";
  else if (lastPass) ex.verification.status = "verified";
  else if (lastFix) ex.verification.status = "observed"; // attempted fix, no pass evidence
  else ex.verification.status = "unverified";

  const fixFollowedByPass = lastFix && lastPass && lastPass.seq >= lastFix.seq;
  if (lastFix && lastPass && !fixFollowedByPass) {
    addEvidence(ev("fix_outcome", lastPass, { note: "pass line precedes the fix; fix not confirmed by a later pass" }));
  }

  // Outcome narrative keeps workaround/permanent and local/regression distinct,
  // and records the count of preserved failed approaches without recommending them.
  const parts = [];
  if (lastFix) {
    if (lastPass && fixFollowedByPass) parts.push("fix applied and followed by passing verification");
    else if (lastPass) parts.push("fix recorded but no later passing verification links to it");
    else parts.push("fix attempted without passing verification evidence");
  }
  if (workaroundSeen) parts.push("workaround / temporary mitigation detected (not a confirmed permanent fix)");
  else if (lastFix) parts.push("no workaround markers; appears intended as a permanent fix");
  if (hasRegression) parts.push("regression-tested: full suite / regression evidence passed");
  else if (lastPass) parts.push("locally verified only (focused pass, no regression-suite evidence)");
  else if (lastError) parts.push("no verification evidence recorded");
  if (ex.failed_approaches.length) {
    parts.push(`${ex.failed_approaches.length} failed approach(es) preserved for avoidance; do not retry`);
  }
  ex.outcome = parts.join("; ");

  void project_id; void session_id; // analysis is pure; ids are caller provenance only
  return { ok: true, analyzed_lines: norm.length, experience };
}

// ---- evidence sanitization ------------------------------------------------
function sanitizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_EVIDENCE)) {
    if (item === null || item === undefined) continue;
    let value;
    if (typeof item === "object") {
      try {
        value = {};
        for (const [k, val] of Object.entries(item)) {
          value[String(k).slice(0, 80)] = typeof val === "string"
            ? core.redact(val).slice(0, 500)
            : (val && typeof val === "object" ? "[object]" : String(val ?? "").slice(0, 200));
        }
      } catch {
        value = "[unreadable evidence]";
      }
    } else {
      value = core.redact(String(item)).slice(0, 800);
    }
    out.push(value);
  }
  return out;
}

function hasVerificationEvidence(evidence) {
  return evidence.some((e) => {
    if (typeof e === "string") return VERIFICATION_EVIDENCE_RE.test(e);
    if (e && typeof e === "object") {
      if (e.kind && /verif|pass|test|regression/i.test(String(e.kind))) return true;
      return Object.values(e).some((v) => typeof v === "string" && VERIFICATION_EVIDENCE_RE.test(v));
    }
    return false;
  });
}

function hasRootCauseEvidence(evidence) {
  return evidence.some((e) => {
    if (typeof e === "string") return ROOT_CAUSE_EVIDENCE_RE.test(e);
    if (e && typeof e === "object") {
      if (e.kind && /root|cause|diagnos|confirm/i.test(String(e.kind))) return true;
      return Object.values(e).some((v) => typeof v === "string" && ROOT_CAUSE_EVIDENCE_RE.test(v));
    }
    return false;
  });
}

function withLimitations(row) {
  const limitations = [];
  const v = String(row.verification_status ?? "");
  const rc = String(row.root_cause_status ?? "");
  if (v === "unverified") limitations.push("No verification evidence was recorded; treat the outcome as unverified.");
  else if (v === "observed") limitations.push("Fix was observed/attempted but not verified by a passing test.");
  else if (v === "verified") limitations.push("Verified locally only; no full regression-suite evidence.");
  else if (v === "regression_tested") limitations.push("Verification includes regression-suite evidence.");
  if (rc === "confirmed") limitations.push("Root cause is backed by explicit tool/test evidence.");
  else limitations.push("Root cause is a hypothesis, not tool-confirmed.");
  const failed = Array.isArray(row.failed_approaches) ? row.failed_approaches : [];
  if (failed.length) limitations.push(`${failed.length} failed approach(es) are preserved for avoidance; do not retry them.`);
  return { ...row, limitations };
}

const STOP_WORDS = new Set(["the", "and", "for", "was", "were", "why", "how", "what", "with", "from", "that", "this", "which", "did", "does", "about", "into", "used", "uses", "find", "fix", "debug"]);

function keywordTokens(query) {
  const q = String(query ?? "").slice(0, 200).toLowerCase();
  return [...new Set(q.split(/[^a-z0-9_+.-]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t)))].slice(0, 8);
}

// ---- persistence ----------------------------------------------------------
/**
 * Record a debugging experience. Dedupes on (project_id,title) without overwrite.
 * verification_status='verified' is downgraded to 'observed' unless verification
 * evidence is present; root_cause_status='confirmed' is downgraded to 'hypothesis'
 * unless explicit root-cause evidence is present.
 */
export async function recordDebuggingExperience({
  project_id,
  session_id,
  title,
  problem,
  environment = "",
  approach = "",
  result = "",
  verification_status = "observed",
  root_cause = "",
  root_cause_status = "hypothesis",
  failed_approaches = [],
  evidence = [],
  confidence = null,
  goal_id,
  task_id,
  id,
} = {}) {
  if (!nonEmpty(project_id) || !nonEmpty(title)) {
    return { ok: false, reason: "project_id and title are required" };
  }
  const pid = String(project_id).trim().slice(0, 200);
  if (pid === "_global") return { ok: false, reason: "project_id '_global' is not allowed" };
  const cleanTitle = String(title).slice(0, 300);
  const safeEvidence = sanitizeEvidence(evidence);
  const failed = Array.isArray(failed_approaches)
    ? failed_approaches.slice(0, MAX_EVIDENCE).map((f) => core.redact(String(f ?? "")).slice(0, 500)).filter(Boolean)
    : [];

  let vstatus = String(verification_status ?? "observed").trim().slice(0, 40) || "observed";
  if (vstatus === "verified" && !hasVerificationEvidence(safeEvidence)) vstatus = "observed";
  let rcstatus = String(root_cause_status ?? "hypothesis").trim().slice(0, 40) || "hypothesis";
  if (rcstatus === "confirmed" && !hasRootCauseEvidence(safeEvidence)) rcstatus = "hypothesis";

  const reusability = vstatus === "regression_tested" ? "high" : (vstatus === "verified" ? "medium" : "low");
  const newId = nonEmpty(id) ? String(id).slice(0, 200) : crypto.randomUUID();

  return core.withDb(async (c) => {
    if (nonEmpty(id)) {
      const pk = await c.query("SELECT id FROM dev_experience WHERE id=$1", [newId]);
      if (pk.rowCount) return { ok: true, duplicate: true, id: newId };
    }
    const ins = await c.query(
      `INSERT INTO dev_experience
        (id, project_id, session_id, goal_id, task_id, kind, title, problem,
         environment, approach, result, verification_status, root_cause,
         root_cause_status, failed_approaches, evidence, confidence, reusability,
         status, freshness_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'debugging',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
               $15::jsonb,$16::real,$17,'active',now(),now(),now())
       ON CONFLICT (project_id,title) DO NOTHING RETURNING id`,
      [
        newId, pid,
        session_id ? String(session_id).slice(0, 200) : null,
        goal_id ? String(goal_id).slice(0, 200) : null,
        task_id ? String(task_id).slice(0, 200) : null,
        cleanTitle,
        String(problem ?? "").slice(0, 20000),
        String(environment ?? "").slice(0, 4000),
        String(approach ?? "").slice(0, 20000),
        String(result ?? "").slice(0, 20000),
        vstatus,
        String(root_cause ?? "").slice(0, 4000),
        rcstatus,
        JSON.stringify(failed),
        JSON.stringify(safeEvidence),
        clampConfidence(confidence),
        reusability,
      ],
    );
    if (!ins.rowCount) {
      const prior = await c.query(
        "SELECT id FROM dev_experience WHERE project_id=$1 AND title=$2", [pid, cleanTitle]);
      return { ok: true, duplicate: true, id: prior.rows[0]?.id ?? null };
    }
    await core.audit("debugging.experience_recorded", pid, {
      id: newId, project_id: pid, verification_status: vstatus,
      root_cause_status: rcstatus, evidence_count: safeEvidence.length,
    });
    return { ok: true, id: newId };
  });
}

/**
 * Bounded, project-scoped retrieval. Each result carries verification/root-cause
 * status plus explicit `limitations` so callers can tell proven from hypothetical.
 */
export async function getDebuggingExperiences({ project_id, problem_query = "", limit = 20, status } = {}) {
  if (!nonEmpty(project_id)) {
    return { ok: false, experiences: [], reason: "project_id is required" };
  }
  const pid = String(project_id).trim().slice(0, 200);
  const n = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.trunc(Number(limit)), 200) : 20;
  const patterns = keywordTokens(problem_query).map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
  const r = await core.dbQuery(
    `SELECT id, project_id, session_id, goal_id, task_id, kind, title, problem,
            environment, approach, result, verification_status, root_cause,
            root_cause_status, failed_approaches, evidence, confidence, reusability,
            status, freshness_at, created_at, updated_at
       FROM dev_experience
      WHERE project_id=$1 AND kind='debugging'
        AND (cardinality($2::text[]) = 0
             OR problem ILIKE ANY($2) OR title ILIKE ANY($2) OR root_cause ILIKE ANY($2))
        AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [pid, patterns, status ? String(status).slice(0, 40) : null, n],
  );
  const experiences = r.rows.map(withLimitations);
  return {
    ok: true,
    experiences,
    count: experiences.length,
    note: "evidence-graded; check verification_status, root_cause_status and limitations before relying on an experience",
  };
}

/**
 * Link a recurring failure to an existing experience by appending evidence to the
 * experience's evidence JSONB (no new table). History is preserved: repeated links
 * increment an occurrence counter instead of overwriting; secrets are redacted.
 */
export async function linkRecurringFailure({ project_id, error_signature, experience_id, evidence = [] } = {}) {
  if (!nonEmpty(project_id) || !nonEmpty(error_signature) || !nonEmpty(experience_id)) {
    return { ok: false, reason: "project_id, error_signature and experience_id are required" };
  }
  const pid = String(project_id).trim().slice(0, 200);
  const exp = String(experience_id).slice(0, 200);
  const sig = core.redact(String(error_signature)).slice(0, 500);
  const safeEvidence = sanitizeEvidence(evidence);
  const hash = crypto.createHash("sha256").update(sig).digest("hex").slice(0, 24);

  return core.withDb(async (c) => {
    const cur = await c.query(
      "SELECT id, evidence FROM dev_experience WHERE id=$1 AND project_id=$2", [exp, pid]);
    if (!cur.rowCount) return { ok: false, reason: "experience not found in project" };
    const list = Array.isArray(cur.rows[0].evidence) ? cur.rows[0].evidence.slice() : [];
    const now = new Date().toISOString();
    const existing = list.find((e) => e && typeof e === "object"
      && e.kind === "recurring_failure" && e.error_hash === hash);
    let occurrences;
    if (existing) {
      occurrences = (Number(existing.occurrences) || 1) + 1;
      existing.occurrences = occurrences;
      existing.last_linked_at = now;
      const merged = Array.isArray(existing.evidence) ? existing.evidence.slice() : [];
      const seen = new Set(merged.map((x) => JSON.stringify(x)));
      for (const e of safeEvidence) {
        const k = JSON.stringify(e);
        if (!seen.has(k)) { seen.add(k); merged.push(e); }
      }
      existing.evidence = merged;
    } else {
      occurrences = 1;
      list.push({
        kind: "recurring_failure",
        error_signature: sig,
        error_hash: hash,
        occurrences: 1,
        first_linked_at: now,
        last_linked_at: now,
        evidence: safeEvidence,
      });
    }
    await c.query(
      "UPDATE dev_experience SET evidence=$2::jsonb, freshness_at=now(), updated_at=now() WHERE id=$1 AND project_id=$3",
      [exp, JSON.stringify(list), pid],
    );
    await core.audit("debugging.recurring_failure_linked", pid, {
      experience_id: exp, error_hash: hash, occurrences,
    });
    return { ok: true, id: exp, error_hash: hash, occurrences };
  });
}
