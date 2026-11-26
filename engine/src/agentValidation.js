// Phase 22 workstream G — result validation.
//
// Deliberately strict and local: a claimed result is NEVER accepted on the claim
// alone. Acceptance requires at least one explicit verification marker
// (test_pass / verification_result / tool_result ... with a determinate success
// result) found in test_results or evidence. All output is bounded and every
// string is passed through core.redact() before it is returned or stored.
//
// No LLM, no network, no git operations. Reads of dev_task (for an optional
// file whitelist / completion criteria) are best-effort and fail closed to
// "no whitelist" if the database is unavailable.
import * as core from "./core.js";

const VERDICT_SET = new Set(["accepted", "rejected", "needs_revision", "blocked"]);
export const VALID_VERDICTS = Object.freeze(["accepted", "rejected", "needs_revision", "blocked"]);

// The explicit marker vocabulary that is allowed to establish verification.
const VERIFICATION_MARKERS = new Set([
  "test_pass", "test_result", "test_success", "test_suite", "tests",
  "verification_result", "verification", "verified_outcome",
  "tool_result", "tool_success", "build_success", "build_result",
]);
const SUCCESS_WORDS = new Set([
  "true", "pass", "passed", "success", "succeeded", "successful", "green",
  "ok", "fixed", "resolved", "complete", "completed", "done",
]);
const FAILURE_WORDS = new Set([
  "false", "fail", "failed", "failure", "red", "error", "crash", "crashed",
  "regression", "exception", "blocked",
]);

const MAX_INPUT_ITEMS = 100;
const MAX_REASONS = 20;
const MAX_EVIDENCE = 20;
const MAX_STR = 240;
const MAX_STORED = 800;
const MAX_LIMIT = 200;

// ---- small deterministic helpers -------------------------------------------
function short(v, n = MAX_STR) {
  if (v === null || v === undefined) return "";
  return core.redact(String(v)).replace(/\s+/g, " ").trim().slice(0, n);
}

function validId(v, max = 200) {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
}

function clampLimit(v, fallback, max) {
  return Number.isInteger(v) && v >= 0 ? Math.min(v, max) : fallback;
}

function wordOf(value) {
  const m = String(value ?? "").toLowerCase().match(/[a-z]+/);
  return m ? m[0] : "";
}

function markerOf(entry) {
  if (typeof entry === "string") {
    const m = entry.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
    return m ? m[1].toLowerCase() : "";
  }
  if (entry && typeof entry === "object") {
    for (const k of ["marker", "type", "kind", "metric", "name", "source", "signal"]) {
      const v = entry[k];
      if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
    }
    for (const k of Object.keys(entry)) {
      const lower = k.toLowerCase();
      if (VERIFICATION_MARKERS.has(lower)) return lower;
    }
  }
  return "";
}

function resultOf(entry) {
  if (entry && typeof entry === "object") {
    if (entry.success === true || entry.passed === true || entry.ok === true) return "success";
    if (entry.success === false || entry.passed === false || entry.ok === false || entry.is_error === true) return "failure";
    for (const k of ["exit_code", "exit"]) {
      const raw = entry[k];
      if (raw !== undefined && raw !== null && raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) return n === 0 ? "success" : "failure";
      }
    }
    for (const k of ["value", "result", "status", "outcome"]) {
      const raw = entry[k];
      if (raw !== undefined && raw !== null) {
        const w = wordOf(raw);
        if (SUCCESS_WORDS.has(w)) return "success";
        if (FAILURE_WORDS.has(w)) return "failure";
      }
    }
    return null;
  }
  if (typeof entry === "string") {
    const em = entry.match(/exit\s*[:=]\s*(-?\d+)/i);
    if (em) return Number(em[1]) === 0 ? "success" : "failure";
    const after = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : entry;
    const w = wordOf(after);
    if (SUCCESS_WORDS.has(w)) return "success";
    if (FAILURE_WORDS.has(w)) return "failure";
    const lower = entry.toLowerCase();
    if (/\b(fail|failed|failure|error|crash|regression|exception|blocked)\b/.test(lower)) return "failure";
    if (/\b(pass|passed|success|succeeded|green|fixed|resolved)\b/.test(lower)) return "success";
  }
  return null;
}

function signalsOf(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items.slice(0, MAX_INPUT_ITEMS) : []) {
    const marker = markerOf(item);
    if (!marker || !VERIFICATION_MARKERS.has(marker)) continue;
    const result = resultOf(item);
    if (result) out.push({ marker, result });
  }
  return out;
}

function normalizePath(v) {
  return short(v, 200).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_INPUT_ITEMS).map((x) => short(x, 200)).filter(Boolean);
}

function storeText(value) {
  if (typeof value === "string") return short(value, MAX_STORED);
  if (value && typeof value === "object") {
    try { return short(JSON.stringify(value, Object.keys(value).sort()), MAX_STORED); }
    catch { return short(String(value), MAX_STORED); }
  }
  return short(value, MAX_STORED);
}

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
  for (const key of ["reasons", "evidence", "verdict", "reviewer"]) {
    if (out[key] !== undefined && out[key] !== null) out[key] = redactAny(out[key]);
  }
  return out;
}

function emptyReport(verdict) {
  return {
    ok: false,
    verdict: verdict || "blocked",
    reasons: [],
    evidence: [],
  };
}

// ---- best-effort task metadata (whitelist / criteria) -----------------------
async function taskMetadata(project_id, task_id) {
  const out = { whitelist: [], criteria: [] };
  try {
    const r = await core.dbQuery(
      `SELECT file_ownership, completion_criteria FROM dev_task
        WHERE project_id=$1 AND (id=$2 OR task_key=$2) LIMIT 1`,
      [project_id, task_id],
    );
    const row = r.rows[0];
    if (row) {
      out.whitelist = asStringArray(row.file_ownership);
      out.criteria = asStringArray(row.completion_criteria);
    }
  } catch {
    // No database / missing columns: degrade to "no whitelist, no criteria".
  }
  return out;
}

/**
 * Validate a claimed task result. A bare claim is always rejected: acceptance
 * requires an explicit verification marker with a determinate success result.
 */
export async function validateTaskResult({
  plan_id, task_id, project_id, claimed_done = false, files_changed = [],
  test_results = [], evidence = [], completion_criteria = [],
  // Optional explicit whitelist. When absent, dev_task.file_ownership is used.
  file_whitelist, allowed_files,
} = {}) {
  if (!validId(plan_id) || !validId(task_id) || !validId(project_id)) {
    return { ...emptyReport("blocked"), reasons: ["invalid_input"] };
  }

  const meta = await taskMetadata(String(project_id).trim(), String(task_id).trim());
  const providedWl = file_whitelist || allowed_files;
  const whitelist = (Array.isArray(providedWl) && providedWl.length
    ? asStringArray(providedWl)
    : meta.whitelist).map(normalizePath).filter(Boolean);
  const criteria = (Array.isArray(completion_criteria) && completion_criteria.length
    ? asStringArray(completion_criteria)
    : meta.criteria).map((c) => c.toLowerCase());

  const tests = Array.isArray(test_results) ? test_results.slice(0, MAX_INPUT_ITEMS) : [];
  const ev = Array.isArray(evidence) ? evidence.slice(0, MAX_INPUT_ITEMS) : [];
  const signals = signalsOf([...tests, ...ev]);
  const hasSuccess = signals.some((s) => s.result === "success");
  const hasFailure = signals.some((s) => s.result === "failure");

  // Detect files changed outside the whitelist (only when a whitelist exists).
  const unauthorized = [];
  if (whitelist.length) {
    const allowed = new Set(whitelist);
    for (const f of asStringArray(files_changed)) {
      const p = normalizePath(f);
      if (p && !allowed.has(p)) unauthorized.push(f);
    }
  }

  // Completion criteria are considered met only when each one is mentioned in
  // the supplied evidence/test text. With no criteria this check is a no-op.
  const corpus = [...tests, ...ev]
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .join(" ").toLowerCase();
  const unmet = criteria.filter((c) => c && !corpus.includes(c)).slice(0, MAX_REASONS);

  const reasons = [];
  const outEvidence = [];
  for (const s of signals.slice(0, MAX_EVIDENCE)) {
    outEvidence.push({ marker: short(s.marker, 60), result: s.result });
  }

  let verdict = "accepted";
  if (hasFailure) {
    verdict = "rejected";
    reasons.push("explicit_verification_failure");
  } else if (!hasSuccess) {
    verdict = "rejected";
    reasons.push("no_explicit_verification");
    if (claimed_done) reasons.push("bare_claim_not_accepted");
  } else if (unauthorized.length) {
    verdict = "rejected";
    reasons.push("unauthorized_file_change");
    outEvidence.push({ kind: "unauthorized_files", files: unauthorized.map((f) => short(f, 120)).slice(0, 10) });
  } else if (unmet.length) {
    verdict = "needs_revision";
    reasons.push("completion_criteria_unmet");
    outEvidence.push({ kind: "unmet_criteria", criteria: unmet.map((c) => short(c, 120)).slice(0, 10) });
  } else {
    reasons.push("verification_evidence_present");
  }
  if (!claimed_done) reasons.push("result_not_claimed_done");

  outEvidence.push({ kind: "verification_check", has_success: hasSuccess, has_failure: hasFailure });
  return {
    ok: verdict !== "blocked",
    verdict,
    reasons: reasons.slice(0, MAX_REASONS).map((r) => short(r, 120)),
    evidence: outEvidence.slice(0, MAX_EVIDENCE),
  };
}

/**
 * Insert an agent_review row. Only ids / verdict / counts reach the audit log;
 * reason and evidence CONTENT is never audited (and is redacted before storage).
 */
export async function recordReview({
  plan_id, task_id, project_id, verdict, reasons = [], evidence = [],
  reviewer = "system",
} = {}) {
  if (!validId(plan_id) || !validId(task_id) || !validId(project_id)) {
    return { ok: false, id: null, reason: "invalid_input" };
  }
  if (!VERDICT_SET.has(verdict)) {
    return { ok: false, id: null, reason: "invalid_verdict" };
  }
  const p = String(project_id).trim();
  const pl = String(plan_id).trim();
  const t = String(task_id).trim();
  const storedReasons = (Array.isArray(reasons) ? reasons.slice(0, 50) : []).map(storeText);
  const storedEvidence = (Array.isArray(evidence) ? evidence.slice(0, 50) : []).map(storeText);
  const rev = validId(String(reviewer), 120) ? short(reviewer, 120) : "system";

  try {
    const r = await core.dbQuery(
      `INSERT INTO agent_review (plan_id, task_id, project_id, verdict, reasons, evidence, reviewer)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id`,
      [pl, t, p, verdict, JSON.stringify(storedReasons), JSON.stringify(storedEvidence), rev],
    );
    const id = r.rows[0]?.id ?? null;
    try {
      // Content-free audit: ids, verdict and COUNTS only. No reason/evidence text.
      await core.audit("agent.review_recorded", `agent_review:${pl}:${t}`, {
        plan_id: pl, task_id: t, project_id: p, verdict,
        reason_count: storedReasons.length, evidence_count: storedEvidence.length, reviewer: rev,
      });
    } catch { /* best effort */ }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, id: null, reason: "review could not be recorded" };
  }
}

/** Bounded, strictly project-scoped read of review rows. No writes. */
export async function getReviews({ plan_id, task_id, project_id, limit = 50 } = {}) {
  if (!validId(project_id)) {
    return { ok: false, items: [], count: 0, reason: "invalid_project_id" };
  }
  const n = clampLimit(limit, 50, MAX_LIMIT);
  try {
    const r = await core.dbQuery(
      `SELECT id, plan_id, task_id, project_id, verdict, reasons, evidence, reviewer, created_at
         FROM agent_review
        WHERE project_id=$1
          AND ($2::text IS NULL OR plan_id=$2)
          AND ($3::text IS NULL OR task_id=$3)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [String(project_id).trim(), validId(plan_id) ? String(plan_id).trim() : null,
        validId(task_id) ? String(task_id).trim() : null, n],
    );
    return { ok: true, items: r.rows.map(redactRow), count: r.rows.length, limit: n };
  } catch {
    return { ok: false, items: [], count: 0, reason: "review request could not be completed" };
  }
}

export default {
  VALID_VERDICTS,
  validateTaskResult,
  recordReview,
  getReviews,
};
