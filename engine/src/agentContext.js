// Phase 22 Feature D — bounded, project-scoped context for orchestrated agents.
//
// Composes a single context block for one (plan, task, agent) by reusing the
// existing Phase 18-21 retrieval capabilities. Every sibling capability is
// imported dynamically inside its own try/catch: a missing/broken capability
// degrades gracefully and is reported, but never blocks context assembly.
// This module makes no LLM and no network call of its own; all text is redacted
// with the shared core.redact() before it leaves the module.
//
// Run: MEMORY_DB_NAME=opencode_memory_test node --test test/phase22-context-conflicts.test.js

import * as core from "./core.js";

const MAX_QUERY = 2000;
const MAX_ITEMS = 12;
const MAX_FIELD = 320;
const MAX_ID = 120;
const BUDGET_MIN = 200;
const BUDGET_MAX = 60000;
const HANDOFF_BUDGET = 1800;

// Statuses that must never be surfaced to an agent as *current* context.
const EXCLUDED = new Set([
  "superseded", "archived", "rejected", "deprecated", "invalid",
  "deleted", "expired", "obsolete", "withdrawn",
]);

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function short(v, n = MAX_FIELD) {
  return core.redact(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, n);
}

function errText(e) {
  return short(e?.message || e || "unknown error", 160);
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Stable, tiny synthetic id for items that do not carry one of their own.
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function isArchived(item) {
  const fields = [item.status, item.lifecycle, item.verification, item.state, item.disposition];
  for (const f of fields) {
    if (typeof f === "string" && EXCLUDED.has(f.trim().toLowerCase())) return true;
  }
  if (item.valid_until) {
    const t = new Date(item.valid_until).getTime();
    if (Number.isFinite(t) && t <= Date.now()) return true;
  }
  if (item.superseded_by && item.status !== "active") return true;
  return false;
}

// A real project id from another project is never visible; "_global" and
// unscoped rows are retained (the upstream sources are already project-scoped
// and apply the global-eligibility rule themselves).
function projectAllowed(item, project_id) {
  const p = item && typeof item.project_id === "string" ? item.project_id : null;
  if (!p || p === project_id || p === "_global") return true;
  return false;
}

function normalize(raw, provenance, project_id) {
  if (!raw || typeof raw !== "object") return null;
  if (isArchived(raw) || !projectAllowed(raw, project_id)) return null;

  const id = short(raw.id ?? raw.fact_key ?? raw.decision_id ?? raw.key
    ?? raw.pattern_key ?? raw.signature ?? "", MAX_ID);
  const content = short(raw.content ?? raw.text ?? raw.value ?? raw.description
    ?? raw.summary ?? raw.reasoning ?? raw.problem ?? raw.approach ?? "");
  const title = short(raw.title ?? raw.fact_key ?? raw.name ?? raw.category ?? "", 120);
  if (!id && !content) return null;

  const rawReason = raw.reason ?? raw.retrieval_reason ?? raw.explanation ?? "";
  return {
    id: id || `${provenance}:${hashText(content)}`,
    provenance,
    type: short(raw.type ?? raw.kind ?? provenance, 40),
    title,
    content,
    reason: short(Array.isArray(rawReason) ? rawReason.join(" ") : rawReason, 160),
    source: short(raw.source ?? raw.source_session ?? "", 80),
    verification: short(raw.verification ?? raw.status ?? "observed", 30),
    project_id: typeof raw.project_id === "string" ? raw.project_id : project_id,
  };
}

function selectCandidates(candidates) {
  const seenIds = new Set();
  const seenText = new Set();
  const out = [];
  for (const item of candidates) {
    if (seenIds.has(item.id)) continue;
    const textKey = item.content ? item.content.slice(0, 160) : null;
    if (textKey && seenText.has(textKey)) continue;
    if (textKey) seenText.add(textKey);
    seenIds.add(item.id);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function assemble(items, budget, header) {
  let text = short(header, budget);
  const included = [];
  for (const it of items) {
    const line = `- [${it.provenance}/${it.verification}] ${it.title || it.id}: ${it.content}`
      + (it.reason ? ` (why: ${it.reason})` : "")
      + (it.source ? ` (source ${it.source})` : "") + "\n";
    if (text.length + line.length > budget) break;
    text += line;
    included.push(it);
  }
  if (text.length > budget) text = text.slice(0, budget);
  return { text, included };
}

/**
 * Compose a bounded, provenance-labelled context block for one orchestrated task.
 * Returns { ok, items, text, ledger_id, chars, degraded }.
 */
export async function prepareAgentContext({
  plan_id, task_id, agent, project_id, request, context_budget = 4000,
} = {}) {
  const degraded = [];
  const empty = (reason) => ({
    ok: false, items: [], text: "", ledger_id: null, chars: 0,
    degraded: reason ? [short(reason, 160)] : degraded,
    ...(reason ? { reason: short(reason, 160) } : {}),
  });

  if (!nonEmptyString(project_id)) return empty("project_id is required");
  const pid = project_id.trim().slice(0, 200);
  const budget = boundedInt(context_budget, 4000, BUDGET_MIN, BUDGET_MAX);
  const query = short(request ?? "", MAX_QUERY);
  const candidates = [];

  // 1. Phase 17 retrieval facade (hybrid search + adaptive rerank + siblings).
  try {
    const mod = await import("./contextRetrieval.js");
    const fn = mod.retrieveTaskContext || mod.retrieveContext;
    if (typeof fn !== "function") throw new Error("no retrieveTaskContext export");
    const res = await fn({
      project_id: pid, query,
      session_id: nonEmptyString(plan_id) ? short(plan_id, 200) : null,
      limit: 6, budget_chars: Math.min(budget, 2000),
    });
    for (const raw of Array.isArray(res?.items) ? res.items : []) {
      const item = normalize(raw, "retrieval", pid);
      if (item) candidates.push(item);
    }
    if (Array.isArray(res?.degraded)) {
      for (const d of res.degraded) degraded.push(`retrieval: ${short(d, 160)}`);
    }
  } catch (e) {
    degraded.push(`retrieval: ${errText(e)}`);
  }

  // 2. Phase 21 learning advice.
  try {
    const mod = await import("./learningEngine.js");
    if (typeof mod.learningAdvice !== "function") throw new Error("no learningAdvice export");
    const res = await mod.learningAdvice({ project_id: pid, query, limit: 6 });
    if (res && res.ok === false && res.reason) degraded.push(`learning: ${short(res.reason, 160)}`);
    for (const raw of Array.isArray(res?.items) ? res.items : []) {
      const item = normalize(raw, "learning", pid);
      if (item) candidates.push(item);
    }
    if (Array.isArray(res?.degraded)) {
      for (const d of res.degraded) degraded.push(`learning: ${short(d, 160)}`);
    }
  } catch (e) {
    degraded.push(`learning: ${errText(e)}`);
  }

  // 3. Phase 17.B decision intelligence (active decisions only).
  try {
    const mod = await import("./decisionIntel.js");
    if (typeof mod.getDecisions !== "function") throw new Error("no getDecisions export");
    const res = await mod.getDecisions({ project_id: pid, query, status: "active", limit: 6 });
    if (res && res.ok === false && res.reason) degraded.push(`decision: ${short(res.reason, 160)}`);
    for (const raw of Array.isArray(res?.decisions) ? res.decisions : []) {
      const item = normalize({ ...raw, type: "decision", kind: "decision" }, "decision", pid);
      if (item) candidates.push(item);
    }
  } catch (e) {
    degraded.push(`decision: ${errText(e)}`);
  }

  const selected = selectCandidates(candidates);
  const header = `# Agent context | project ${pid} | plan ${short(plan_id ?? "", 120)}`
    + ` | task ${short(task_id ?? "", 120)} | agent ${short(agent ?? "unknown", 80)}\n\n`;
  const { text, included } = assemble(selected, budget, header);

  // Record exactly the item ids that were supplied in the bounded block.
  let ledger_id = null;
  try {
    const r = await core.dbQuery(
      `INSERT INTO agent_context_ledger
         (plan_id, task_id, project_id, agent, item_ids, context_chars, degraded)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) RETURNING id`,
      [
        short(plan_id ?? "", 200), short(task_id ?? "", 200), pid,
        short(agent ?? "unknown", 120),
        JSON.stringify(included.map((i) => i.id)), text.length,
        JSON.stringify(degraded),
      ],
    );
    ledger_id = r.rows[0]?.id ?? null;
  } catch (e) {
    degraded.push(`ledger: ${errText(e)}`);
  }

  return {
    ok: true,
    items: included,
    text,
    ledger_id,
    chars: text.length,
    degraded,
  };
}

/**
 * Bounded handoff summary: the result references of a completed prior task,
 * scoped to (project_id, plan_id) so no other plan/project leaks across.
 * Returns { ok, text, items }.
 */
export async function contextForHandoff({ plan_id, from_task, to_task, project_id } = {}) {
  if (!nonEmptyString(project_id) || !nonEmptyString(plan_id) || !nonEmptyString(from_task)) {
    return {
      ok: false, text: "", items: [],
      reason: "project_id, plan_id and from_task are required",
    };
  }
  const pid = project_id.trim().slice(0, 200);
  const plan = plan_id.trim().slice(0, 200);
  const from = from_task.trim().slice(0, 200);
  const to = short(to_task ?? "", 200);

  let row = null;
  try {
    const r = await core.dbQuery(
      `SELECT id, task_key, title, status, result_ref, file_ownership, assigned_agent
         FROM dev_task
        WHERE project_id=$1 AND plan_id=$2 AND id=$3 LIMIT 1`,
      [pid, plan, from],
    );
    row = r.rows[0] || null;
  } catch (e) {
    return { ok: false, text: "", items: [], reason: `lookup failed: ${errText(e)}` };
  }

  const items = [];
  if (row) {
    const refs = row.result_ref && typeof row.result_ref === "object" ? row.result_ref : {};
    const entries = Object.entries(refs).slice(0, 12);
    const base = {
      provenance: "handoff",
      task_id: short(row.id, MAX_ID),
      to_task: to,
      source: short(row.task_key ?? "", 80),
    };
    if (entries.length === 0) {
      items.push({
        ...base,
        id: short(row.id, MAX_ID),
        type: "task",
        title: short(row.title || row.id, 120),
        content: `status=${short(row.status ?? "", 40)} (no result refs)`,
        verification: short(row.status ?? "observed", 30),
      });
    } else {
      for (const [key, value] of entries) {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        items.push({
          ...base,
          id: short(`${row.id}:${key}`, MAX_ID),
          type: "result_ref",
          title: short(key, 120),
          content: short(rendered, 240),
          verification: short(row.status ?? "observed", 30),
        });
      }
    }
  }

  const header = `# Handoff | project ${pid} | plan ${plan} | ${from} -> ${to || "(unknown)"}\n\n`;
  const { text, included } = assemble(items, HANDOFF_BUDGET, header);
  return { ok: true, text, items: included };
}

export default { prepareAgentContext, contextForHandoff };
