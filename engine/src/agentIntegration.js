// Phase 22 workstream H — integration coordination.
//
// Collects agent reviews and executions for a plan, coordinates their verdicts
// and flags overlapping file claims and incompatible verdicts. Strictly
// read-only from the database: no git operations, no writes, no discarding of
// work. All collections are bounded and output is redacted.
import * as core from "./core.js";

const VALID_VERDICTS = new Set(["accepted", "rejected", "needs_revision", "blocked"]);
const MAX_ROWS = 200;
const MAX_LIST = 50;
const MAX_STR = 240;

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

function emptyReport() {
  return {
    accepted: 0,
    rejected: 0,
    needs_revision: 0,
    blocked: 0,
    overlaps: [],
    integration_failures: [],
    notes: [],
  };
}

function normalizePath(v) {
  return short(v, 200).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Collect file paths claimed in an execution result (best effort, bounded). */
function filesClaimedBy(result) {
  const out = [];
  let obj = result;
  if (typeof result === "string") {
    try { obj = JSON.parse(result); } catch { return out; }
  }
  if (!obj || typeof obj !== "object") return out;
  const candidates = obj.files_changed || obj.files || obj.changed_files || [];
  if (!Array.isArray(candidates)) return out;
  for (const f of candidates.slice(0, 50)) {
    const p = normalizePath(f);
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/**
 * Coordinate reviews + executions for one plan/project.
 * Returns { ok, report } where report counts per-verdict tasks and lists
 * overlaps / integration failures / notes. Work is never discarded: every
 * observed task is counted in exactly one verdict bucket.
 */
export async function integrateResults({ plan_id, project_id, limit = 50 } = {}) {
  if (!validId(plan_id) || !validId(project_id)) {
    return { ok: false, report: emptyReport(), reason: "invalid_input" };
  }
  const n = clampLimit(limit, 50, MAX_ROWS);
  const pl = String(plan_id).trim();
  const p = String(project_id).trim();

  try {
    const revRows = (await core.dbQuery(
      `SELECT id, task_id, verdict, created_at
         FROM agent_review
        WHERE plan_id=$1 AND project_id=$2
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [pl, p, n],
    )).rows;
    const execRows = (await core.dbQuery(
      `SELECT id, task_id, agent, status, result, error, attempts, finished_at
         FROM agent_execution
        WHERE plan_id=$1 AND project_id=$2
        ORDER BY claimed_at DESC, id DESC LIMIT $3`,
      [pl, p, n],
    )).rows;

    const report = emptyReport();

    // Latest review verdict per task (rows are newest-first).
    const latestVerdict = new Map();
    const verdictsByTask = new Map();
    for (const r of revRows) {
      const t = short(r.task_id, 200);
      if (!t) continue;
      const v = VALID_VERDICTS.has(r.verdict) ? r.verdict : null;
      if (!verdictsByTask.has(t)) verdictsByTask.set(t, new Set());
      if (v) verdictsByTask.get(t).add(v);
      if (v && !latestVerdict.has(t)) latestVerdict.set(t, v);
    }

    // Incompatible verdicts: a task carrying more than one distinct verdict.
    for (const [t, set] of verdictsByTask) {
      if (set.size > 1) {
        if (report.integration_failures.length < MAX_LIST) {
          report.integration_failures.push({
            type: "incompatible_verdicts",
            task_id: t,
            verdicts: [...set].slice(0, 8),
          });
        }
      }
    }

    // Overlapping file claims: same file claimed by more than one task.
    const fileToTasks = new Map();
    for (const e of execRows) {
      const t = short(e.task_id, 200);
      if (!t) continue;
      for (const f of filesClaimedBy(e.result)) {
        if (!fileToTasks.has(f)) fileToTasks.set(f, new Map());
        const taskMap = fileToTasks.get(f);
        if (!taskMap.has(t)) taskMap.set(t, new Set());
        const agent = short(e.agent, 120);
        if (agent) taskMap.get(t).add(agent);
      }
    }
    for (const [file, taskMap] of fileToTasks) {
      if (taskMap.size > 1) {
        if (report.overlaps.length < MAX_LIST) {
          const tasks = [...taskMap.keys()].slice(0, 20);
          const agents = [...new Set([...taskMap.values()].flatMap((s) => [...s]))].slice(0, 20);
          report.overlaps.push({ file, tasks, agents });
        }
      }
    }

    // One verdict bucket per observed task, newest-review wins. Work with no
    // review is retained as needs_revision (or blocked on a failed execution).
    const failedTasks = new Set();
    const taskAgents = new Map();
    for (const e of execRows) {
      const t = short(e.task_id, 200);
      if (!t) continue;
      if (String(e.status).toLowerCase() === "failed" || (e.error && short(e.error))) failedTasks.add(t);
      if (!taskAgents.has(t)) taskAgents.set(t, short(e.agent, 120));
    }

    const allTasks = new Set([...latestVerdict.keys(), ...taskAgents.keys()]);
    for (const t of allTasks) {
      const v = latestVerdict.get(t);
      if (VALID_VERDICTS.has(v)) {
        report[v] += 1;
      } else if (failedTasks.has(t)) {
        report.blocked += 1;
      } else {
        report.needs_revision += 1;
      }
    }

    // Malformed / unusable rows are recorded, never silently dropped.
    for (const e of execRows) {
      if (!short(e.task_id, 200) && report.integration_failures.length < MAX_LIST) {
        report.integration_failures.push({ type: "malformed_execution", id: e.id });
      }
    }
    for (const r of revRows) {
      if (!VALID_VERDICTS.has(r.verdict) && report.integration_failures.length < MAX_LIST) {
        report.integration_failures.push({ type: "unknown_verdict", id: r.id, verdict: short(r.verdict, 60) });
      }
    }

    report.notes.push(
      `Retained ${execRows.length} execution(s) and ${revRows.length} review(s); no work discarded.`,
    );
    const unreviewed = [...allTasks].filter((t) => !latestVerdict.has(t)).length;
    if (unreviewed) report.notes.push(`${unreviewed} task(s) had no accepted review and were retained for follow-up.`);
    report.notes.push("Integration is read-only: no git operations were performed.");

    report.notes = report.notes.slice(0, MAX_LIST).map((x) => short(x, 400));
    return { ok: true, report };
  } catch {
    return { ok: false, report: emptyReport(), reason: "integration could not be completed" };
  }
}

export default { integrateResults };
