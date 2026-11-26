// Phase 17.E — Advanced context-aware retrieval.
//
// Basic retrieval (hybrid search + adaptive rerank) ALWAYS works. The optional
// sibling capabilities (project context, decisions, relationships, knowledge
// quality) are loaded with dynamic import inside try/catch: if one is absent or
// throws, the rest still contribute and the failure is reported in `degraded`.
import { adaptiveRetrieve as baseAdaptiveRetrieve } from "./adaptiveRetrieval.js";
import * as core from "./core.js";

// Sorting-only verification weights (mirrors knowledgeQuality.qualityRank).
const VERIF_RANK = {
  verified: 7, observed: 6, inferred: 5, uncertain: 4,
  stale: 3, contradicted: 2, superseded: 1,
};
const STATUS_MAP = {
  active: "observed", open: "observed", candidate: "inferred",
  confirmed: "verified", verified: "verified", verified_fix: "verified",
  strongly_supported: "verified", supported: "inferred", hypothesis: "uncertain",
  disputed: "contradicted", contradicted: "contradicted", stale: "stale",
  deprecated: "superseded", rejected: "superseded", superseded: "superseded",
};
// Multiplicative factors let a low-relevance verified item outrank a
// high-relevance contradicted/stale one, as required by the preference rules.
const VERIF_FACTOR = {
  verified: 1.25, observed: 1, inferred: 0.9, uncertain: 0.75,
  stale: 0.5, contradicted: 0.3, superseded: 0.2,
};

// Capability descriptors. `loader` uses the sibling paths required by the spec
// (from src/, "../src/<name>.js" resolves to that same src directory).
const CAPABILITIES = {
  contextIntel: {
    loader: () => import("../src/contextIntel.js"),
    names: ["getProjectContext", "projectContextSummary", "buildProjectContext", "listProjectFacts", "getContext", "contextSummary"],
    resultKeys: ["context", "facts", "project", "summary"],
    type: "project_context",
  },
  decisionIntel: {
    loader: () => import("../src/decisionIntel.js"),
    names: ["listDecisions", "getDecisions", "recentDecisions", "decisionReport", "getActiveDecisions"],
    resultKeys: ["decisions", "items", "results"],
    type: "decision",
  },
  relationshipIntel: {
    loader: () => import("../src/relationshipIntel.js"),
    names: ["getRelationships", "listRelationships", "relationshipsFor", "relatedKnowledge", "getRelated"],
    resultKeys: ["relationships", "items", "results", "related"],
    type: "relationship",
  },
  knowledgeQuality: {
    loader: () => import("../src/knowledgeQuality.js"),
    names: ["getQuality", "qualityFor"],
    resultKeys: ["quality", "items"],
    type: "quality",
  },
};

const stringify = (v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
const short = (v, n = 220) => core.redact(stringify(v)).replace(/\s+/g, " ").slice(0, n);
const errText = (e) => short(e?.message || e || "unknown error", 160);

function normalizeVerification(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s in VERIF_RANK) return s;
  return STATUS_MAP[s] || "observed";
}

function pickFn(mod, names) {
  for (const name of names) {
    if (typeof mod?.[name] === "function") return mod[name];
    if (typeof mod?.default?.[name] === "function") return mod.default[name];
  }
  return null;
}

async function loadCapability(key, loaders, degraded) {
  const loader = loaders?.[key] || CAPABILITIES[key].loader;
  try {
    const mod = await loader();
    if (!mod) throw new Error("empty module");
    return mod;
  } catch (e) {
    degraded.push(`${key}: unavailable (${errText(e)})`);
    return null;
  }
}

// prepareContext is the existing project-context composer. It is loaded
// dynamically so an unavailable capability never breaks basic retrieval.
async function getPrepareContext(deps, degraded) {
  if (deps.prepareContext !== undefined) {
    return typeof deps.prepareContext === "function" ? deps.prepareContext : null;
  }
  // A caller that injects its own retrieval adapter is in a controlled/offline
  // mode; do not silently reach into the real database for extra context.
  if (deps.adaptiveRetrieve) return null;
  try {
    const mod = await import("./contextPackage.js");
    if (typeof mod.prepareContext !== "function") throw new Error("no prepareContext export");
    return mod.prepareContext;
  } catch (e) {
    degraded.push(`prepareContext: unavailable (${errText(e)})`);
    return null;
  }
}

async function callCapability(mod, spec, args, degraded) {
  if (!mod) return null; // loader already recorded the degradation
  const fn = pickFn(mod, spec.names);
  if (!fn) {
    degraded.push(`${spec.type}: no compatible export`);
    return null;
  }
  try {
    return await fn(args);
  } catch (e) {
    degraded.push(`${spec.type}.${spec.names[0]}: ${errText(e)}`);
    return null;
  }
}

function extractItems(result, spec) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === "string" || typeof result === "number") return [{ content: result }];
  if (typeof result !== "object") return [];
  for (const key of [...spec.resultKeys, "items", "results", "facts", "decisions",
    "relationships", "observations", "data", "context"]) {
    if (Array.isArray(result[key])) return result[key];
  }
  if (result.context) return [{ content: result.context }];
  if (result.summary) return [{ content: result.summary, title: "Project context" }];
  return [];
}

/** Normalize a raw capability row into a safe, explainable item. */
function normalizeItem(raw, spec, project_id) {
  if (!raw || typeof raw !== "object") {
    return {
      type: spec.type, id: short(raw, 80), title: "", content: short(raw),
      reason: `${spec.type} capability`, project_id, verification: "observed",
      confidence: null, freshness_at: null, score: 0, source: "",
    };
  }

  // Project isolation: drop any row that names a different real project.
  const itemProject = typeof raw.project_id === "string" ? raw.project_id : null;
  if (itemProject && itemProject !== project_id && itemProject !== "_global") return null;

  const id = short(raw.id ?? raw.fact_key ?? raw.decision_id ?? raw.key ?? raw.title ?? "", 120);
  const type = short(raw.type || raw.kind || spec.type, 40);
  const title = short(raw.title || raw.fact_key || raw.name || "", 120);
  const content = short(raw.content ?? raw.value ?? raw.description ?? raw.summary
    ?? raw.text ?? raw.reasoning ?? "", 240);
  const rawReason = raw.reason ?? raw.retrieval_reason ?? raw.explanation
    ?? raw.ranking_explanation ?? raw.evidence;
  const reason = Array.isArray(rawReason)
    ? rawReason.map((x) => short(x, 60)).join(" ")
    : (rawReason ? short(rawReason, 160) : `${spec.type} capability`);
  const verification = normalizeVerification(
    raw.verification ?? raw.status ?? raw.lifecycle
    ?? (raw.verified === true ? "verified" : undefined),
  );
  const confidence = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null;
  const freshness_at = raw.freshness_at ?? raw.updated_at ?? raw.created_at ?? null;
  const baseScore = raw.adaptive_score ?? raw.rerank_score ?? raw.score ?? raw.confidence ?? 0;
  const score = Number.isFinite(Number(baseScore)) ? Number(baseScore) : 0;

  return {
    type, id, title, content, reason,
    project_id: itemProject || project_id,
    verification, confidence, freshness_at, score,
    source: short(raw.source ?? raw.source_session ?? "", 80),
  };
}

function adjustedScore(item) {
  let s = (item.score || 0) * (VERIF_FACTOR[item.verification] ?? 1);
  // Verification rank is an additional ordering signal; freshness a smaller one.
  s += ((VERIF_RANK[item.verification] ?? VERIF_RANK.observed) - VERIF_RANK.observed) * 0.05;
  if (item.freshness_at) {
    const ageDays = (Date.now() - new Date(item.freshness_at).getTime()) / 86400000;
    if (Number.isFinite(ageDays)) {
      if (ageDays > 180) s -= 0.12;
      else if (ageDays > 30) s -= 0.06;
      else if (ageDays >= 0) s += 0.02;
    }
  }
  return Number(s.toFixed(6));
}

/**
 * Combine hybrid retrieval with project context, decisions, relationships and
 * knowledge quality into one bounded, explainable context block.
 */
export async function retrieveTaskContext({
  project_id,
  query = "",
  session_id,
  limit = 8,
  budget_chars = 4000,
  deps = {},
} = {}) {
  const pid = project_id || "_global";
  const degraded = [];
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 30) : 8;
  const budget = Number.isInteger(budget_chars) && budget_chars > 0
    ? Math.min(budget_chars, 60000) : 4000;
  const candidates = [];

  // 1. Core path — must survive failure of every optional capability.
  try {
    const adapter = deps.adaptiveRetrieve || baseAdaptiveRetrieve;
    const res = await adapter({ query, project_id: pid, session_id: session_id || null, limit: lim });
    for (const raw of Array.isArray(res?.results) ? res.results : []) {
      const item = normalizeItem({ ...raw, type: raw.type || "memory" }, { type: "memory" }, pid);
      if (item) {
        item.reason = raw.retrieval_reason || raw.explanation
          || (Array.isArray(raw.ranking_explanation) ? raw.ranking_explanation.join(" ") : null)
          || "hybrid relevance (vector + full-text, adaptively reranked)";
        item.reason = short(item.reason, 160);
        candidates.push(item);
      }
    }
  } catch (e) {
    degraded.push(`basic_retrieval: ${errText(e)}`);
  }

  // 2. Existing project-context composer — best-effort and bounded.
  let preparedText = "";
  const prepare = await getPrepareContext(deps, degraded);
  if (prepare) {
    try {
      const prepared = await prepare({
        project_id: pid, query, session_id: session_id || null,
        budget_chars: Math.min(budget, 1200),
      });
      if (typeof prepared?.context === "string") {
        preparedText = short(prepared.context, Math.min(budget, 1200));
      }
    } catch (e) {
      degraded.push(`prepareContext.call: ${errText(e)}`);
    }
  }

  // 3. Optional capabilities — independent, each failure is isolated.
  const loaders = deps.loaders || {};
  const [contextMod, decisionMod, relationshipMod, qualityMod] = await Promise.all([
    loadCapability("contextIntel", loaders, degraded),
    loadCapability("decisionIntel", loaders, degraded),
    loadCapability("relationshipIntel", loaders, degraded),
    loadCapability("knowledgeQuality", loaders, degraded),
  ]);

  const [contextRes, decisionRes, relationshipRes] = await Promise.all([
    callCapability(contextMod, CAPABILITIES.contextIntel,
      { project_id: pid, query, session_id, limit: lim }, degraded),
    callCapability(decisionMod, CAPABILITIES.decisionIntel,
      { project_id: pid, query, limit: lim }, degraded),
    callCapability(relationshipMod, CAPABILITIES.relationshipIntel,
      { project_id: pid, query, limit: lim }, degraded),
  ]);

  const groups = [
    [contextRes, CAPABILITIES.contextIntel],
    [decisionRes, CAPABILITIES.decisionIntel],
    [relationshipRes, CAPABILITIES.relationshipIntel],
  ];
  for (const [result, spec] of groups) {
    for (const raw of extractItems(result, spec)) {
      const item = normalizeItem(raw, spec, pid);
      if (item) candidates.push(item);
    }
  }

  // 4. Quality annotation. Only explicit records override an existing status;
  //    the default OBSERVED returned for absent rows is ignored.
  if (qualityMod) {
    const getQ = pickFn(qualityMod, CAPABILITIES.knowledgeQuality.names);
    if (!getQ) {
      degraded.push("knowledgeQuality: no getQuality export");
    } else {
      const memoryItems = candidates.filter((x) => x.type === "memory" && x.id);
      for (const item of memoryItems) {
        try {
          const res = await getQ({ project_id: pid, subject_type: "memory", subject_id: item.id });
          const q = res?.quality;
          if (q?.verification && res.default !== true) {
            item.verification = normalizeVerification(q.verification);
            if (Number.isFinite(Number(q.confidence))) item.confidence = Number(q.confidence);
            if (q.freshness_at) item.freshness_at = q.freshness_at;
            item.reason = `${item.reason} [quality:${item.verification}]`.slice(0, 200);
          }
        } catch (e) {
          degraded.push(`quality.getQuality: ${errText(e)}`);
          break;
        }
      }
    }
  }

  // 5. Dedupe by (type,id), rank, bound.
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  for (const item of unique) item.final_score = adjustedScore(item);
  unique.sort((a, b) => b.final_score - a.final_score || a.type.localeCompare(b.type));
  const selected = unique.slice(0, lim);

  // 6. Budget-aware context assembly (compactContext-like truncation).
  const header = `# Task context for project ${pid}\n\n`
    + (preparedText ? `${preparedText}\n\n## Ranked items\n` : "");
  let text = header;
  const included = [];
  for (const item of selected) {
    const line = `- [${item.type}/${item.verification}] ${item.title || item.id}: ${item.content}`
      + ` (reason: ${item.reason})${item.source ? ` (source ${item.source})` : ""}\n`;
    if (text.length + line.length > budget) break;
    text += line;
    included.push(item);
  }
  if (included.length < selected.length) {
    const marker = `[truncated to ${budget} chars]`;
    text = `${text.slice(0, Math.max(0, budget - marker.length - 1)).replace(/\s+$/, "")}\n${marker}`;
  }
  if (text.length > budget) text = text.slice(0, budget);

  const explanation = `Selected ${included.length}/${candidates.length} candidates for project '${pid}'`
    + ` (limit ${lim}, budget ${budget} chars) using hybrid retrieval + adaptive rerank,`
    + " prepareContext, project context, decisions, relationships and knowledge quality."
    + " Verified and fresh items are preferred; contradicted/stale/superseded items are"
    + " downweighted; items are deduplicated by (type,id) and cross-project rows excluded."
    + (degraded.length ? ` Degraded capabilities: ${degraded.join("; ")}.` : "");

  return {
    ok: true,
    context: text,
    items: included,
    explanation,
    budget_used: text.length,
    degraded,
    project_id: pid,
  };
}

/** Short, deterministic explanation for one selected item. */
export function explainSelection({ item, project_id } = {}) {
  if (!item || typeof item !== "object") return short(item ?? "");
  const type = short(item.type || "item", 40);
  const v = normalizeVerification(item.verification);
  const sc = Number.isFinite(Number(item.final_score ?? item.score))
    ? Number(item.final_score ?? item.score).toFixed(3) : "n/a";
  const reason = short(item.reason || "no explicit reason", 120);
  const age = item.freshness_at ? `, freshness ${short(item.freshness_at, 40)}` : "";
  const scope = project_id ? ` for project ${short(project_id, 60)}` : "";
  return `${type} (verification ${v}, score ${sc}${age})${scope}: ${reason}`;
}

// Thin convenience alias.
export const retrieveContext = retrieveTaskContext;
