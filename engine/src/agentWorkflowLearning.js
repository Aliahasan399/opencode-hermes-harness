// Phase 22 workstream I — workflow learning + agent performance.
//
// Records workflow experiences through the Phase 21 learningExperience module
// via DYNAMIC import (best effort, degrade gracefully). Signatures are derived
// from the task/agent pattern, confidence stays conservative, and a weak claim
// is never auto-promoted to a stronger verification. No LLM, no network.
import crypto from "node:crypto";
import * as core from "./core.js";

const MAX_TASKS = 50;
const MAX_EVIDENCE = 20;
const MAX_STR = 240;
const MAX_LIMIT = 200;

// Verification markers allowed to back a "verified" claim (mirrors Phase 21).
const VERIFICATION_MARKERS = new Set([
  "test_pass", "test_result", "test_success", "test_suite", "tests",
  "verification_result", "verification", "verified_outcome",
  "tool_result", "tool_success", "build_success", "build_result",
]);

function short(v, n = MAX_STR) {
  if (v === null || v === undefined) return "";
  return core.redact(String(v)).replace(/\s+/g, " ").trim().slice(0, n);
}

function validProject(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 && s !== "_global" && s.length <= 200;
}

function clampLimit(v, fallback, max) {
  return Number.isInteger(v) && v >= 0 ? Math.min(v, max) : fallback;
}

function stable(v) {
  if (v && typeof v === "object") {
    try { return JSON.stringify(v, Object.keys(v).sort()); }
    catch { return String(v); }
  }
  return String(v);
}

function taskKeyOf(t) {
  if (!t || typeof t !== "object") return short(t, 80);
  return short(t.id ?? t.task_id ?? t.task_key ?? t.title ?? t.key, 80);
}

function agentOf(x) {
  if (!x || typeof x !== "object") return "";
  return short(x.assigned_agent ?? x.agent ?? x.agent_id, 120);
}

/** Deterministic signature derived from the task + agent pattern. */
function signatureOf(tasks, reviews, executions) {
  const keys = (Array.isArray(tasks) ? tasks : []).slice(0, MAX_TASKS)
    .map(taskKeyOf).filter(Boolean).sort();
  const agents = [...new Set([
    ...(Array.isArray(tasks) ? tasks : []).slice(0, MAX_TASKS).map(agentOf),
    ...(Array.isArray(executions) ? executions : []).slice(0, MAX_TASKS).map(agentOf),
  ].filter(Boolean))].sort();
  const verdicts = (Array.isArray(reviews) ? reviews : []).slice(0, MAX_TASKS)
    .map((r) => short(r && r.verdict, 40)).filter(Boolean).sort();
  const base = `${keys.join("|")}::${agents.join("|")}::${verdicts.join("|")}`;
  const hash = crypto.createHash("sha256").update(base).digest("hex").slice(0, 24);
  const lead = agents.slice(0, 5).join(",") || "unknown";
  return short(`workflow:${lead}:${hash}`, 400);
}

function hasStrongEvidence(evidence) {
  return evidence.some((e) => {
    if (typeof e === "string") {
      const m = e.match(/^\s*([a-z][a-z0-9_\-]*)\s*[:=]/i);
      if (!m || !VERIFICATION_MARKERS.has(m[1].toLowerCase())) return false;
      return /\b(pass|passed|success|succeeded|green|ok|done|exit\s*[:=]\s*0)\b/i.test(e);
    }
    if (e && typeof e === "object") {
      const marker = short(e.marker ?? e.kind ?? e.type, 60).toLowerCase();
      if (!VERIFICATION_MARKERS.has(marker)) return false;
      return e.success === true || e.passed === true || e.ok === true
        || e.result === "success" || e.exit_code === 0;
    }
    return false;
  });
}

/** Build bounded, redacted, evidence-backed strings from reviews/executions. */
function buildEvidence(reviews, executions) {
  const out = [];
  for (const r of (Array.isArray(reviews) ? reviews : []).slice(0, MAX_TASKS)) {
    if (!r || typeof r !== "object") continue;
    const v = short(r.verdict, 40);
    const t = taskKeyOf(r);
    if (v) out.push(`review_verdict:${v}:${t}`);
    for (const ev of (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 5)) {
      const s = typeof ev === "string" ? ev : stable(ev);
      if (s) out.push(short(s, 160));
    }
  }
  for (const e of (Array.isArray(executions) ? executions : []).slice(0, MAX_TASKS)) {
    if (!e || typeof e !== "object") continue;
    const status = short(e.status, 40);
    if (status) out.push(`execution_status:${status}:${taskKeyOf(e)}`);
    if (e.error) out.push(`execution_error:${short(e.error, 160)}`);
    let result = e.result;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { /* keep raw */ } }
    if (result && typeof result === "object" && Array.isArray(result.files_changed)) {
      out.push(`files:${result.files_changed.slice(0, 5).map((f) => short(f, 80)).join(",")}`);
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    if (!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  }).slice(0, MAX_EVIDENCE);
}

/**
 * Record a workflow experience via Phase 21 recordLearningExperience (dynamic
 * import). Idempotent on the derived signature; degrades gracefully on any
 * import/DB failure and never throws.
 */
export async function recordWorkflowExperience({
  plan_id, project_id, tasks = [], reviews = [], executions = [], outcome = "unknown",
} = {}) {
  if (!validProject(project_id)) {
    return { ok: false, learning_id: null, reason: "invalid_project_id" };
  }
  if (!validProject(plan_id) && !(typeof plan_id === "string" && plan_id.trim())) {
    return { ok: false, learning_id: null, reason: "invalid_plan_id" };
  }
  const sig = signatureOf(tasks, reviews, executions);
  const evidence = buildEvidence(reviews, executions);
  const strong = hasStrongEvidence(evidence);
  const verdicts = (Array.isArray(reviews) ? reviews : []).slice(0, MAX_TASKS)
    .map((r) => short(r && r.verdict, 40)).map((v) => v.toLowerCase());
  const wanted = String(outcome ?? "unknown").toLowerCase();

  let resolved = "uncertain";
  if (strong && (wanted === "success" || wanted === "done" || verdicts.includes("accepted"))) resolved = "success";
  else if (wanted === "failure" || wanted === "failed" || verdicts.includes("rejected")) resolved = "failure";

  // Conservative: verified only with explicit success evidence; confidence
  // stays low and is never boosted by repetition.
  const verification = strong ? "verified" : "observed";
  const confidence = strong ? 0.55 : 0.40;
  const agents = signatureOf(tasks, reviews, executions).split(":")[1] || "unknown";
  const problem = short(`Workflow for plan ${short(plan_id, 120)} with agents ${agents}`, 2000);
  const approach = short(`Tasks: ${(Array.isArray(tasks) ? tasks : []).slice(0, MAX_TASKS).map(taskKeyOf).filter(Boolean).join(", ") || "none"}`, 2000);

  let le;
  try {
    le = await import("./learningExperience.js");
  } catch (e) {
    return { ok: false, learning_id: null, degraded: ["learningExperience import failed"],
      reason: "learning module unavailable" };
  }
  if (typeof le.recordLearningExperience !== "function") {
    return { ok: false, learning_id: null, degraded: ["no recordLearningExperience"],
      reason: "learning module unavailable" };
  }
  try {
    const res = await le.recordLearningExperience({
      project_id: String(project_id).trim(),
      session_id: typeof plan_id === "string" ? short(plan_id, 200) : null,
      signature: sig,
      category: "workflow",
      problem,
      approach,
      outcome: resolved,
      verification,
      confidence,
      evidence,
      reusability: "project",
    });
    if (!res || res.ok !== true) {
      return { ok: false, learning_id: (res && res.id) || null, duplicate: false,
        reason: (res && res.reason) || "learning record rejected" };
    }
    return { ok: true, learning_id: res.id ?? null, duplicate: !!res.duplicate };
  } catch {
    return { ok: false, learning_id: null, duplicate: false,
      degraded: ["learning record failed"], reason: "learning record could not be completed" };
  }
}

/**
 * Bounded aggregate of agent performance over agent_execution + agent_review.
 * Reviews are matched to an agent through the (plan_id, task_id) pairs of that
 * agent's executions. Read-only.
 */
export async function agentPerformance({ project_id, agent, limit = 50 } = {}) {
  const empty = { ok: false, total: 0, accepted: 0, rejected: 0, failed: 0, note: "" };
  if (!validProject(project_id) || !validProject(agent)) {
    return { ...empty, note: "a valid project_id and agent are required", reason: "invalid_input" };
  }
  const n = clampLimit(limit, 50, MAX_LIMIT);
  const p = String(project_id).trim();
  const a = String(agent).trim();
  try {
    const execs = (await core.dbQuery(
      `SELECT id, plan_id, task_id, status, error, attempts
         FROM agent_execution
        WHERE project_id=$1 AND agent=$2
        ORDER BY claimed_at DESC, id DESC LIMIT $3`,
      [p, a, n],
    )).rows;
    const pairs = new Set(execs.map((e) => `${e.plan_id}\u0000${e.task_id}`));
    const reviews = (await core.dbQuery(
      `SELECT plan_id, task_id, verdict, created_at
         FROM agent_review
        WHERE project_id=$1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [p, Math.min(n, MAX_LIMIT)],
    )).rows.filter((r) => pairs.has(`${r.plan_id}\u0000${r.task_id}`));

    const latest = new Map();
    for (const r of reviews) {
      const k = `${r.plan_id}\u0000${r.task_id}`;
      if (!latest.has(k)) latest.set(k, r.verdict);
    }
    let accepted = 0, rejected = 0, needs = 0, blocked = 0, failed = 0;
    for (const v of latest.values()) {
      if (v === "accepted") accepted += 1;
      else if (v === "rejected") rejected += 1;
      else if (v === "needs_revision") needs += 1;
      else if (v === "blocked") blocked += 1;
    }
    for (const e of execs) {
      if (String(e.status).toLowerCase() === "failed" || (e.error && short(e.error))) failed += 1;
    }
    const distinctTasks = new Set(execs.map((e) => `${e.plan_id}\u0000${e.task_id}`)).size;
    return {
      ok: true,
      total: distinctTasks,
      accepted,
      rejected,
      failed,
      note: `Aggregated ${execs.length} execution(s) and ${reviews.length} matching review(s) (limit ${n}); ` +
        `needs_revision=${needs}, blocked=${blocked}. Read-only; work is not discarded.`,
    };
  } catch {
    return { ...empty, note: "performance aggregate could not be completed" };
  }
}

export default { recordWorkflowExperience, agentPerformance };
