// Phase 22 Features B+C — agent discovery and deterministic selection.
//
// Design invariants (all local, no LLM, no network, no clock, no randomness):
//   - discoverAgents() reads the REAL opencode.json agent section from disk and
//     overlays the harness-provided explore/explorer/general agents.
//   - Capabilities come only from a fixed name->capability table. Nothing is
//     inferred from free-form descriptions, so no capability is ever invented.
//   - Agents on a known-dead upstream (9router) are reported unavailable and
//     listed in `degraded`; they are never selected.
//   - selectAgents() is deterministic: same input => same output. Ties break on
//     agent name (ascending). It is pure (no DB, no I/O).
//   - "Smallest suitable team" is a soft preference (a decaying reuse bonus),
//     balanced against workload spread. max_parallel bounds assignments per round.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.json");

// Upstream providers that are known to be down. An agent pinned to one of these
// cannot run, even though its config entry is otherwise valid.
const DEAD_MODEL_PREFIXES = Object.freeze(["9router"]);

// Fixed, name-based capability mapping. Unknown names get NO capabilities.
const CAPABILITY_MAP = Object.freeze({
  explore: ["search", "read"],
  explorer: ["search", "read"],
  general: ["implementation", "testing"],
});

const HARNESS_AGENTS = Object.freeze([
  { name: "explore", description: "Harness explore agent: fast, read-only codebase search", mode: "subagent" },
  { name: "explorer", description: "Harness explorer agent: codebase exploration", mode: "subagent" },
  { name: "general", description: "Harness general agent: multi-step implementation and testing", mode: "subagent" },
]);

const OUTCOME_SUCCESS = new Set(["success", "accepted", "done", "passed", "completed", "ok"]);
const OUTCOME_FAILURE = new Set(["failure", "failed", "rejected", "error", "false"]);

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function safeStr(v, cap = Infinity) {
  let s = "";
  try { s = v === undefined || v === null ? "" : String(v); } catch { s = ""; }
  return s.slice(0, cap);
}

function boundedInt(v, fallback, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function capabilitiesFor(name) {
  const key = safeStr(name).trim().toLowerCase();
  const caps = CAPABILITY_MAP[key];
  return Array.isArray(caps) ? [...caps] : [];
}

function unavailableReason(model) {
  const m = safeStr(model).trim().toLowerCase();
  if (!m) return null;
  for (const prefix of DEAD_MODEL_PREFIXES) {
    if (m === prefix || m.startsWith(`${prefix}/`) || m.startsWith(`${prefix}:`)) {
      return `upstream '${prefix}' is unavailable`;
    }
  }
  return null;
}

// --- Discovery -------------------------------------------------------------

/**
 * Discover agents from the real opencode.json plus the harness-builtin agents.
 * @returns {Promise<{ok:boolean,agents:Array,cli_agent_supported:boolean,degraded:Array}>}
 */
export async function discoverAgents(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  const configPath = nonEmptyString(input.config_path) ? input.config_path : DEFAULT_CONFIG;
  const degraded = [];

  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    degraded.push({
      source: "config",
      reason: "opencode.json could not be read or parsed",
      detail: safeStr(e && e.message || e, 180),
    });
  }

  const defaultModel = cfg && nonEmptyString(cfg.model) ? safeStr(cfg.model, 200) : null;
  const agents = [];
  const seen = new Set();

  // 1. Configured agents (config wins on a name collision so the real config is
  //    never silently overridden by a builtin of the same name).
  const cfgAgents = cfg && cfg.agent && typeof cfg.agent === "object" && !Array.isArray(cfg.agent)
    ? cfg.agent : {};
  for (const [name, def] of Object.entries(cfgAgents)) {
    if (!nonEmptyString(name) || !def || typeof def !== "object" || Array.isArray(def)) continue;
    const cleanName = safeStr(name, 120).trim();
    const model = nonEmptyString(def.model) ? safeStr(def.model, 200) : null;
    const reason = unavailableReason(model);
    const agent = {
      name: cleanName,
      description: safeStr(def.description || "", 500),
      model,
      mode: nonEmptyString(def.mode) ? safeStr(def.mode, 80) : "subagent",
      source: "config",
      capabilities: capabilitiesFor(cleanName),
      available: reason === null,
    };
    agents.push(agent);
    seen.add(cleanName);
    if (reason !== null) {
      degraded.push({ agent: cleanName, model, reason });
    }
  }

  // 2. Harness-provided agents. These are always available: they run on the
  //    session model, not on a pinned (possibly dead) provider.
  for (const h of HARNESS_AGENTS) {
    if (seen.has(h.name)) continue;
    agents.push({
      name: h.name,
      description: h.description,
      model: defaultModel,
      mode: h.mode,
      source: "harness",
      capabilities: capabilitiesFor(h.name),
      available: true,
    });
    seen.add(h.name);
  }

  return { ok: true, agents, cli_agent_supported: true, degraded };
}

// --- Selection -------------------------------------------------------------

function normalizeCapabilities(value) {
  const raw = Array.isArray(value) ? value
    : (value && typeof value === "object" ? Object.keys(value) : []);
  const out = [];
  const seen = new Set();
  for (const c of raw.slice(0, 50)) {
    const s = safeStr(c, 80).trim().toLowerCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function capabilityMatch(required, caps) {
  if (!required.length) return 0.5; // neutral: any available agent is suitable
  const have = new Set(caps.map((c) => safeStr(c).trim().toLowerCase()));
  let hits = 0;
  for (const c of required) if (have.has(c)) hits++;
  return hits / required.length;
}

function buildStats(history) {
  const stats = new Map();
  for (const h of history) {
    if (!h || typeof h !== "object" || !nonEmptyString(h.agent)) continue;
    const name = safeStr(h.agent, 120).trim();
    let outcome = null;
    if (typeof h.success === "boolean") outcome = h.success;
    else {
      const verdict = safeStr(h.verdict ?? h.status ?? h.outcome ?? "", 60).trim().toLowerCase();
      if (OUTCOME_SUCCESS.has(verdict)) outcome = true;
      else if (OUTCOME_FAILURE.has(verdict)) outcome = false;
    }
    if (outcome === null) continue;
    const s = stats.get(name) || { success: 0, total: 0 };
    s.total++;
    if (outcome) s.success++;
    stats.set(name, s);
  }
  return stats;
}

function successRate(name, stats) {
  const s = stats.get(name);
  if (!s || !s.total) return 0.5; // neutral prior
  return clamp01(s.success / s.total);
}

/**
 * Deterministically map ready tasks to available agents.
 * @param {{tasks?:Array,agents?:Array,history?:Array,project_id?:string,max_parallel?:number}} options
 */
export async function selectAgents(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  if (!Array.isArray(input.tasks)) {
    return { ok: false, assignments: [], rejected: [], degraded: [], reason: "tasks must be an array" };
  }
  if (!Array.isArray(input.agents)) {
    return { ok: false, assignments: [], rejected: [], degraded: [], reason: "agents must be an array" };
  }

  const parallel = boundedInt(input.max_parallel, 4, 1, 50);
  const degraded = [];
  const pool = [];
  for (const a of input.agents) {
    if (!a || typeof a !== "object" || !nonEmptyString(a.name)) continue;
    const name = safeStr(a.name, 120).trim();
    if (a.available === false) {
      degraded.push({ agent: name, reason: "unavailable", model: a.model ?? null });
      continue;
    }
    pool.push({
      name,
      capabilities: Array.isArray(a.capabilities) ? [...a.capabilities] : [],
    });
  }

  const stats = buildStats(Array.isArray(input.history) ? input.history : []);
  const load = new Map(); // agent name -> assignments made in this round
  const assignments = [];
  const rejected = [];

  for (const task of input.tasks) {
    if (!task || typeof task !== "object") {
      rejected.push({ task_id: null, reason: "invalid_task" });
      continue;
    }
    const taskId = nonEmptyString(task.id) ? safeStr(task.id, 256)
      : (nonEmptyString(task.task_id) ? safeStr(task.task_id, 256) : null);
    if (!taskId) {
      rejected.push({ task_id: null, reason: "invalid_task" });
      continue;
    }
    if (assignments.length >= parallel) {
      rejected.push({ task_id: taskId, reason: "parallel_bound" });
      continue;
    }
    if (!pool.length) {
      rejected.push({ task_id: taskId, reason: "no_available_agents" });
      continue;
    }

    const required = normalizeCapabilities(task.required_capabilities ?? task.capabilities);
    let best = null;
    for (const agent of pool) {
      const cap = capabilityMatch(required, agent.capabilities);
      const succ = successRate(agent.name, stats);
      const used = load.get(agent.name) || 0;
      // Decaying reuse bonus: prefers reusing an already-selected agent once
      // (smaller team), then spreads work as that agent's load grows.
      const reuse = used > 0 ? 1 / used : 0;
      const score = cap * 0.55 + succ * 0.2 + reuse * 0.1 - used * 0.1;
      const candidate = { agent, cap, succ, used, score };
      if (!best || better(candidate, best)) best = candidate;
    }

    if (required.length && best.cap <= 0) {
      rejected.push({ task_id: taskId, reason: "no_capable_agent", required_capabilities: required });
      continue;
    }

    load.set(best.agent.name, best.used + 1);
    const confidence = clamp01(best.cap * 0.6 + best.succ * 0.4);
    assignments.push({
      task_id: taskId,
      agent: best.agent.name,
      reason: `capability=${best.cap.toFixed(2)}; history=${best.succ.toFixed(2)}; load=${best.used}; reuse=${best.used > 0 ? "yes" : "no"}`,
      confidence: Number(confidence.toFixed(3)),
    });
  }

  return {
    ok: true,
    assignments,
    rejected,
    degraded,
    project_id: input.project_id ?? null,
  };
}

// Strict deterministic ordering: higher score first, then stronger capability
// match, then better history, then lighter load, then name ascending.
function better(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  if (a.cap !== b.cap) return a.cap > b.cap;
  if (a.succ !== b.succ) return a.succ > b.succ;
  if (a.used !== b.used) return a.used < b.used;
  return a.agent.name < b.agent.name;
}

export default { discoverAgents, selectAgents };
