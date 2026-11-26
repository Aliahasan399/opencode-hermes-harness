// Phase 22 Feature A — deterministic task decomposition and dependency graphs.
//
// Invariants:
//   - pure decomposition: no LLM, no network, no clock, no randomness (ids are
//     derived with a stable sha256 of the inputs);
//   - all user-influenced text is passed through core.redact before it is
//     returned or persisted;
//   - dependencies are only emitted when the request explicitly implies an
//     ordering ("after", "then", "integration", "depends on", ...). They always
//     point backwards, so cycles cannot be produced by the decomposer;
//   - capabilities are never invented: a capability is emitted only when its
//     keyword is literally present in the request/clause;
//   - task counts and every field are bounded; every write is project-scoped,
//     idempotent and additive (existing rows are never overwritten);
//   - no paid API, no cross-project reads.

import crypto from "node:crypto";
import * as core from "./core.js";

export const MAX_TASKS = 12;
const HARD_MAX_TASKS = 24;
const REQUEST_CAP = 4000;
const CONTEXT_CAP = 4000;
const TITLE_CAP = 200;
const DESC_CAP = 2000;
const OBJECTIVE_CAP = 1000;
const CRITERION_CAP = 160;
const PATH_CAP = 200;
const MAX_CANDIDATES = 24;
const MAX_DEPS = 12;
const MAX_ARRAY = 24;
const MAX_REASONS = 100;
const MAX_GRAPH_NODES = 500;

const PLAN_FIELDS =
  "id, project_id, session_id, request, status, decomposition, context_refs, created_at, updated_at";
const TASK_FIELDS =
  "id, project_id, plan_id, goal_id, task_key, title, status, parent_task_id, objective, " +
  "dependencies, parallel_group, assigned_agent, required_capabilities, file_ownership, " +
  "completion_criteria, risk_level, priority, attempts, result_ref, evidence, source_session, " +
  "created_at, updated_at";

// Capability keywords are an explicit allow-list. Only a literal match in the
// user's own text can add a capability; nothing is inferred beyond the words
// the user actually used.
const CAPABILITY_KEYWORDS = [
  ["database", /\b(database|postgres|postgresql|sql|migration|schema|tables?|quer(y|ies))\b/i],
  ["api", /\b(api|apis|rest|restful|graphql|endpoints?|routes?)\b/i],
  ["security", /\b(security|secure|auth|authentication|authorization|xss|csrf|injection|sanitize)\b/i],
  ["testing", /\b(tests?|testing|jest|vitest|mocha|coverage|assertions?)\b/i],
  ["frontend", /\b(frontend|ui|react|vue|angular|browser|css|html)\b/i],
  ["backend", /\b(backend|server|node|express|worker)\b/i],
  ["documentation", /\b(docs?|documentation|readme|changelog)\b/i],
];

const HIGH_RISK_RE = /\b(security|auth|authentication|authorization|migration|drop\s+table|delete|production|credentials?|secrets?)\b/i;
const MED_RISK_RE = /\b(refactor|rename|api|integration|integrate|schema|deploy|cache|concurrency)\b/i;
const INTEGRATION_RE = /\b(integrat(e|es|ed|ion)|combine|wire\s+together|hook\s+up|stitch)\b/i;
const ORDER_RE = /^\s*(after|then|once|finally|subsequently|lastly)\b/i;
const DEPENDENCY_RE = /\b(depend(?:s|ing)?\s+on|requires?|blocked\s+by|prerequisite)\b/i;

const PATH_RE = /(?:[A-Za-z]:[\\/])?(?:\.\.?[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+/g;
const FILE_RE = /\b[\w@-]+\.(?:js|jsx|ts|tsx|json|sql|md|py|go|rs|java|kt|rb|php|css|scss|html|ya?ml|txt|sh|toml|lock)\b/gi;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedLimit(limit, fallback, cap) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, cap) : fallback;
}

function plainString(value, cap) {
  let s;
  try { s = value == null ? "" : (typeof value === "string" ? value : String(value)); }
  catch { s = ""; }
  return s.slice(0, cap);
}

function safeString(value, cap) {
  return core.redact(plainString(value, cap)).slice(0, cap);
}

// Identifiers are opaque values, not user-facing prose. Never run them through
// redact: generated ids such as `task-<hash>` contain an `sk-` substring that
// the credential redactor would otherwise collapse into one tag.
function capStrings(values, cap = MAX_ARRAY, perItem = TITLE_CAP) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = safeString(v, perItem).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= cap) break;
  }
  return out;
}

function capIdStrings(values, cap = MAX_DEPS, perItem = 200) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = plainString(v, perItem).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= cap) break;
  }
  return out;
}

function capInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Flatten bounded, redacted string values out of a caller-supplied context. */
function contextStrings(context) {
  const out = [];
  const visit = (value, depth) => {
    if (out.length >= 60 || depth > 3) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push(String(value).slice(0, CONTEXT_CAP));
    } else if (Array.isArray(value)) {
      for (const v of value.slice(0, 40)) visit(v, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value).slice(0, 40)) {
        if (typeof v === "string" || typeof v === "number") {
          out.push(`${k}: ${String(v)}`.slice(0, CONTEXT_CAP));
        } else {
          visit(v, depth + 1);
        }
      }
    }
  };
  visit(context, 0);
  return out;
}

/** Extract explicit file-path-like tokens. No path is guessed from prose. */
function extractPaths(texts) {
  const found = new Set();
  for (const raw of texts) {
    const t = safeString(raw, CONTEXT_CAP);
    for (const re of [PATH_RE, FILE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t)) !== null) {
        const p = m[0].replace(/^[.]+/, "").replace(/\\/g, "/").slice(0, PATH_CAP);
        if (p && p.length > 1 && !p.endsWith("/")) found.add(p);
        if (found.size >= MAX_ARRAY * 4) break;
      }
    }
  }
  return [...found].sort().slice(0, MAX_ARRAY);
}

/** Derive coarse components from explicit paths only. */
function extractComponents(paths) {
  const components = new Set();
  for (const p of paths) {
    const segments = p.split(/[\\/]/).filter(Boolean);
    if (segments.length < 2) continue;
    if (/^[A-Za-z]:$/.test(segments[0])) segments.shift();
    const last = segments[segments.length - 1];
    const dirs = /\./.test(last) ? segments.slice(0, -1) : segments;
    const candidate = dirs[dirs.length - 1] || dirs[0];
    if (candidate && candidate.length <= 60) components.add(candidate.toLowerCase());
    if (components.size >= MAX_ARRAY) break;
  }
  return [...components].sort();
}

/** Split a request into bounded, depth-aware work items. */
function splitSegments(requestText) {
  const out = [];
  for (const line of requestText.split(/\r?\n/)) {
    const leading = (line.match(/^[\t ]*/) || [""])[0];
    const spaces = leading.replace(/\t/g, "  ").length;
    const depth = Math.min(2, Math.floor(spaces / 2));
    const body = line
      .replace(/^[\t ]*/, "")
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .trim();
    if (!body) continue;
    for (const piece of body.split(/;|\.\s+(?=[A-Z])/)) {
      const text = piece.trim();
      if (text.length >= 3) out.push({ text, depth, paths: [] });
    }
  }
  if (out.length <= 1) {
    const base = out[0] ? out[0].text : requestText.trim();
    const pieces = base
      .split(/,\s+(?:and\s+)?|\s+and\s+|\s+then\s+|\s+also\s+|\s+plus\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    if (pieces.length >= 2) return pieces.map((text) => ({ text, depth: 0, paths: [] })).slice(0, MAX_CANDIDATES);
  }
  if (!out.length && requestText.trim()) out.push({ text: requestText.trim(), depth: 0, paths: [] });
  return out.slice(0, MAX_CANDIDATES);
}

function capabilitiesFor(text) {
  return CAPABILITY_KEYWORDS.filter(([, re]) => re.test(text)).map(([name]) => name).slice(0, MAX_ARRAY);
}

function riskFor(text) {
  if (HIGH_RISK_RE.test(text)) return "high";
  if (MED_RISK_RE.test(text)) return "medium";
  return "low";
}

function criteriaFor(text) {
  const out = [];
  if (/\b(tests?|testing|verify|verification|assert|coverage)\b/i.test(text)) out.push("tests and assertions pass");
  if (/\b(docs?|documentation|readme|changelog)\b/i.test(text)) out.push("documentation updated");
  if (/\b(migrat|schema|column|table)\b/i.test(text)) out.push("schema change applied and reversible");
  if (/\b(api|apis|endpoints?|routes?)\b/i.test(text)) out.push("API contract verified");
  if (!out.length) out.push("change implemented and verified");
  return out.slice(0, MAX_ARRAY).map((c) => c.slice(0, CRITERION_CAP));
}

function stableId(project_id, session_id, request, index, title) {
  const hash = crypto.createHash("sha256")
    .update(`${safeString(project_id, 200)}\n${safeString(session_id, 200)}\n${request}\n${index}\n${title}`)
    .digest("hex")
    .slice(0, 16);
  return `task-${hash}`;
}

function textMentions(text, candidateText) {
  const needle = safeString(candidateText, 60).toLowerCase();
  return needle.length >= 6 && text.toLowerCase().includes(needle);
}

/**
 * Pure deterministic decomposition. Returns a root task plus bounded work
 * items. Dependencies only ever point at earlier siblings, so the produced
 * graph is acyclic by construction.
 */
export function decomposeTask({
  project_id,
  session_id,
  request,
  context = {},
  max_tasks = 12,
} = {}) {
  const warnings = [];
  const degraded = [];
  const rawRequest = typeof request === "string" ? request : "";
  const safeRequest = safeString(rawRequest, REQUEST_CAP);
  const degradedInput = core.redact(rawRequest) !== rawRequest;
  if (degradedInput) {
    degraded.push("secret_redacted");
    warnings.push("Credential-like content was redacted from the request.");
  }

  if (!safeRequest.trim()) {
    degraded.push("empty_request");
    return {
      ok: true,
      tasks: [],
      warnings: ["Empty request; nothing to decompose.", ...warnings],
      degraded,
    };
  }

  const contextTexts = contextStrings(context);
  const allPaths = extractPaths([safeRequest, ...contextTexts]);
  const components = extractComponents(allPaths);
  if (!allPaths.length) {
    degraded.push("no_explicit_paths");
    warnings.push("No explicit file paths found; file ownership is limited to mentioned paths.");
  }

  const maxTasks = boundedLimit(max_tasks, MAX_TASKS, HARD_MAX_TASKS);
  let segments = splitSegments(safeRequest);
  // A path-heavy request with no action words still yields per-component work items.
  if (segments.length < 2 && allPaths.length >= 2) {
    segments = allPaths.map((p) => ({
      text: `Update ${p}${components.length ? ` (${components[0]})` : ""}`,
      depth: 0,
      paths: [p],
    })).slice(0, MAX_CANDIDATES);
  }

  const slots = Math.max(0, maxTasks - 1);
  if (segments.length > slots) {
    warnings.push(`Task count capped at ${maxTasks} (root + ${slots} work items).`);
    degraded.push("task_count_capped");
  }
  segments = segments.slice(0, slots);

  const rootTitle = `Plan: ${safeRequest.slice(0, TITLE_CAP - 6)}`.slice(0, TITLE_CAP);
  const rootId = stableId(project_id, session_id, safeRequest, 0, rootTitle);
  const root = {
    id: rootId,
    parent_id: null,
    title: rootTitle,
    description: safeRequest.slice(0, DESC_CAP),
    objective: safeRequest.slice(0, OBJECTIVE_CAP),
    dependencies: [],
    parallel_group: 0,
    assigned_agent: null,
    required_capabilities: capabilitiesFor(safeRequest),
    file_ownership: [],
    completion_criteria: criteriaFor(safeRequest),
    risk_level: riskFor(safeRequest),
    priority: 0,
    status: "pending",
  };

  const childIds = segments.map((seg, i) => stableId(project_id, session_id, safeRequest, i + 1, seg.text));
  const deps = segments.map((seg, i) => {
    const out = [];
    const push = (d) => { if (d && d !== childIds[i] && !out.includes(d)) out.push(d); };
    if (ORDER_RE.test(seg.text) && i > 0) push(childIds[i - 1]);
    if (DEPENDENCY_RE.test(seg.text)) {
      for (let j = 0; j < i; j++) if (textMentions(seg.text, segments[j].text)) push(childIds[j]);
    }
    if (INTEGRATION_RE.test(seg.text)) {
      for (let j = 0; j < i; j++) {
        if (!INTEGRATION_RE.test(segments[j].text)) push(childIds[j]);
      }
    }
    return out.slice(0, MAX_DEPS);
  });

  const groups = new Array(segments.length).fill(1);
  for (let i = 0; i < segments.length; i++) {
    let g = 1;
    for (const dep of deps[i]) {
      const j = childIds.indexOf(dep);
      if (j >= 0 && j < i) g = Math.max(g, groups[j] + 1);
    }
    groups[i] = g;
  }

  // Per-item paths: explicit in the clause first; otherwise distribute the
  // global candidates once so context-derived files are never silently lost.
  const perItemPaths = segments.map((seg, i) => {
    const own = extractPaths([seg.text]);
    return own.length ? own : (i === 0 ? allPaths : []);
  });
  let assignedAny = perItemPaths.some((p) => p.length > 0);
  if (!assignedAny && allPaths.length) perItemPaths[0] = allPaths;

  const tasks = [root];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let parentId = rootId;
    for (let j = i - 1; j >= 0; j--) {
      if (segments[j].depth < seg.depth) { parentId = childIds[j]; break; }
    }
    const title = safeString(seg.text, TITLE_CAP);
    const description = safeString(seg.text, DESC_CAP);
    tasks.push({
      id: childIds[i],
      parent_id: parentId,
      title,
      description,
      objective: safeString(seg.text, OBJECTIVE_CAP),
      dependencies: deps[i].slice(),
      parallel_group: capInt(groups[i], 1, 0, 1000),
      assigned_agent: null,
      required_capabilities: capabilitiesFor(seg.text),
      file_ownership: capStrings(perItemPaths[i], MAX_ARRAY, PATH_CAP),
      completion_criteria: criteriaFor(seg.text),
      risk_level: riskFor(seg.text),
      priority: i + 1,
      status: "pending",
    });
  }

  return { ok: true, tasks, warnings, degraded };
}

/** Deterministic graph validation: duplicate ids, missing deps and cycles. */
export function validateTaskGraph({ tasks = [] } = {}) {
  const cycles = [];
  const duplicates = [];
  const missing_dependencies = [];
  const reasons = [];
  if (!Array.isArray(tasks)) {
    return { ok: false, cycles, duplicates, missing_dependencies, reasons: ["tasks must be an array"] };
  }

  const nodes = tasks.slice(0, MAX_GRAPH_NODES);
  const ids = nodes.map((t, i) => (t && typeof t === "object" ? plainString(t.id ?? "", 200) : `#${i}`));
  const idSet = new Set(ids.filter(Boolean));
  const counts = new Map();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) {
      duplicates.push(id);
      if (reasons.length < MAX_REASONS) reasons.push(`duplicate task id: ${id}`);
    }
  }
  duplicates.sort();

  const adj = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const id = ids[i];
    if (!id || adj.has(id)) continue;
    const deps = Array.isArray(nodes[i] && nodes[i].dependencies) ? nodes[i].dependencies : [];
    const clean = [];
    for (const raw of deps.slice(0, MAX_DEPS)) {
      const d = raw && typeof raw === "object" ? plainString(raw.id ?? "", 200) : plainString(raw, 200);
      if (!d) continue;
      if (!idSet.has(d)) {
        if (missing_dependencies.length < MAX_REASONS) {
          missing_dependencies.push(`${id} -> ${d}`);
          if (reasons.length < MAX_REASONS) reasons.push(`missing dependency: ${id} -> ${d}`);
        }
        continue;
      }
      if (!clean.includes(d)) clean.push(d);
    }
    adj.set(id, clean);
  }

  const color = new Map();
  const stack = [];
  const seenCycles = new Set();
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      if (color.get(next) === 1) {
        const at = stack.indexOf(next);
        const cycle = stack.slice(at).concat(next);
        const key = [...new Set(cycle)].sort().join("|");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(cycle);
          if (reasons.length < MAX_REASONS) reasons.push(`cycle detected: ${cycle.join(" -> ")}`);
        }
      } else if (!color.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of adj.keys()) if (!color.has(id)) visit(id);

  return {
    ok: cycles.length === 0 && duplicates.length === 0 && missing_dependencies.length === 0,
    cycles: cycles.slice(0, MAX_REASONS),
    duplicates,
    missing_dependencies,
    reasons: reasons.slice(0, MAX_REASONS),
  };
}

/** Normalize a caller-supplied task before it is returned or persisted. */
function normalizeTask(task, index) {
  const t = task && typeof task === "object" ? task : {};
  return {
    id: plainString(t.id ?? `task-${index + 1}`, 200),
    parent_id: nonEmptyString(t.parent_id) ? plainString(t.parent_id, 200) : null,
    title: safeString(t.title ?? `task ${index + 1}`, TITLE_CAP) || `task ${index + 1}`,
    description: safeString(t.description ?? t.title ?? "", DESC_CAP),
    objective: safeString(t.objective ?? t.description ?? t.title ?? "", OBJECTIVE_CAP),
    dependencies: capIdStrings(Array.isArray(t.dependencies) ? t.dependencies : [], MAX_DEPS, 200),
    parallel_group: capInt(t.parallel_group ?? 0, 0, 0, 1000),
    assigned_agent: null, // never invent an agent assignment
    required_capabilities: capStrings(Array.isArray(t.required_capabilities) ? t.required_capabilities : [], MAX_ARRAY, 80),
    file_ownership: capStrings(Array.isArray(t.file_ownership) ? t.file_ownership : [], MAX_ARRAY, PATH_CAP),
    completion_criteria: capStrings(Array.isArray(t.completion_criteria) ? t.completion_criteria : [], MAX_ARRAY, CRITERION_CAP),
    risk_level: ["low", "medium", "high"].includes(t.risk_level) ? t.risk_level : "low",
    priority: capInt(t.priority ?? index + 1, index + 1, -100, 1000),
  };
}

/**
 * Persist a plan and its tasks. Idempotent on (project_id, session_id, request).
 * All rows use the caller's project_id and cryptographically random ids; task
 * references (parent/dependencies) are remapped to the new row ids.
 */
export async function savePlan({
  plan_id,
  project_id,
  session_id,
  request,
  tasks = [],
  context_refs = [],
} = {}) {
  const empty = { ok: false, plan_id: null, created_tasks: 0, skipped_tasks: 0 };
  if (!nonEmptyString(project_id)) return { ...empty, reason: "project_id is required" };
  if (!nonEmptyString(request)) return { ...empty, reason: "request is required" };
  const safeRequest = safeString(request, REQUEST_CAP);
  if (!safeRequest.trim()) return { ...empty, reason: "request is empty after redaction" };

  const planId = nonEmptyString(plan_id) ? plainString(plan_id, 128) : crypto.randomUUID();
  const safeSession = nonEmptyString(session_id) ? plainString(session_id, 512) : null;
  const inputTasks = Array.isArray(tasks) ? tasks : [];
  const kept = inputTasks.slice(0, HARD_MAX_TASKS);
  const normalized = kept.map(normalizeTask);
  const overflow = inputTasks.length - kept.length;

  const refs = Array.isArray(context_refs) ? context_refs.slice(0, 100) : [];
  const safeRefs = refs.map((v) => {
    if (v && typeof v === "object") {
      try { return JSON.parse(safeString(JSON.stringify(v), 1000)); }
      catch { return null; }
    }
    return safeString(v, 500);
  }).filter((v) => v !== null && v !== "");

  return core.withDb(async (c) => {
    const dup = await c.query(
      `SELECT id FROM agent_plan
        WHERE project_id=$1 AND session_id IS NOT DISTINCT FROM $2 AND request=$3 LIMIT 1`,
      [project_id, safeSession, safeRequest],
    );
    if (dup.rowCount) {
      return {
        ok: true, duplicate: true, plan_id: dup.rows[0].id,
        created_tasks: 0, skipped_tasks: inputTasks.length,
        reason: "plan already exists for this project/session/request",
      };
    }
    const pk = await c.query("SELECT id FROM agent_plan WHERE id=$1 LIMIT 1", [planId]);
    if (pk.rowCount) {
      return {
        ok: true, duplicate: true, plan_id: planId,
        created_tasks: 0, skipped_tasks: inputTasks.length,
        reason: "plan_id already exists",
      };
    }

    await c.query(
      `INSERT INTO agent_plan (id, project_id, session_id, request, status, decomposition, context_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [planId, project_id, safeSession, safeRequest, "planned",
        JSON.stringify(normalized), JSON.stringify(safeRefs)],
    );

    const newIds = normalized.map(() => crypto.randomUUID());
    const idMap = new Map();
    normalized.forEach((t, i) => idMap.set(t.id, newIds[i]));

    let created = 0;
    let skipped = overflow;
    for (let i = 0; i < normalized.length; i++) {
      const t = normalized[i];
      const dependencies = t.dependencies.map((d) => idMap.get(d) || d).slice(0, MAX_DEPS);
      const parentId = t.parent_id ? (idMap.get(t.parent_id) || t.parent_id) : null;
      const r = await c.query(
        `INSERT INTO dev_task
          (id, project_id, plan_id, task_key, title, status, parent_task_id, objective,
           dependencies, parallel_group, assigned_agent, required_capabilities, file_ownership,
           completion_criteria, risk_level, priority, attempts, result_ref, evidence, source_session)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15,$16,$17,$18::jsonb,$19::jsonb,$20)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          newIds[i], project_id, planId,
          `${planId}:${i}`.slice(0, 256), t.title, "pending", parentId, t.objective,
          JSON.stringify(dependencies), t.parallel_group, null,
          JSON.stringify(t.required_capabilities), JSON.stringify(t.file_ownership),
          JSON.stringify(t.completion_criteria), t.risk_level, t.priority, 0, "{}", "[]",
          safeSession,
        ],
      );
      if (r.rowCount) created++;
      else skipped++;
    }

    return { ok: true, duplicate: false, plan_id: planId, created_tasks: created, skipped_tasks: skipped };
  });
}

/** Read a single plan and its tasks. Strictly project-scoped. */
export async function getPlan({ plan_id, project_id } = {}) {
  if (!nonEmptyString(plan_id) || !nonEmptyString(project_id)) {
    return { ok: false, plan: null, tasks: [], reason: "plan_id and project_id are required" };
  }
  const plan = (await core.dbQuery(
    `SELECT ${PLAN_FIELDS} FROM agent_plan WHERE id=$1 AND project_id=$2 LIMIT 1`,
    [plainString(plan_id, 128), project_id],
  )).rows[0] || null;
  if (!plan) return { ok: false, plan: null, tasks: [], reason: "plan not found in project" };
  const tasks = (await core.dbQuery(
    `SELECT ${TASK_FIELDS} FROM dev_task WHERE plan_id=$1 AND project_id=$2
      ORDER BY priority ASC, created_at ASC, id ASC LIMIT 100`,
    [plan.id, project_id],
  )).rows;
  return { ok: true, plan, tasks };
}

/** Bounded, project-scoped plan listing. */
export async function listPlans({ project_id, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, plans: [], reason: "project_id is required" };
  const n = boundedLimit(limit, 50, 200);
  const rows = (await core.dbQuery(
    `SELECT ${PLAN_FIELDS} FROM agent_plan WHERE project_id=$1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [project_id, n],
  )).rows;
  return { ok: true, plans: rows };
}

/** Bounded, read-only, project-scoped task listing with optional filters. */
export async function getTasks({ plan_id, project_id, status, limit = 100 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, tasks: [], reason: "project_id is required" };
  const n = boundedLimit(limit, 100, 200);
  const rows = (await core.dbQuery(
    `SELECT ${TASK_FIELDS} FROM dev_task
      WHERE project_id=$1
        AND ($2::text IS NULL OR plan_id=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY priority ASC, created_at ASC, id ASC LIMIT $4`,
    [project_id, nonEmptyString(plan_id) ? plainString(plan_id, 128) : null,
      nonEmptyString(status) ? plainString(status, 64) : null, n],
  )).rows;
  return { ok: true, tasks: rows };
}

export default {
  MAX_TASKS,
  decomposeTask,
  validateTaskGraph,
  savePlan,
  getPlan,
  listPlans,
  getTasks,
};
