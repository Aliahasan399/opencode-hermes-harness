// Compact, actionable context prepared before coding begins. Deterministic by default.
// Phase 18: this is the automatic request-lifecycle integration point. The OpenCode plugin
// calls `context-package` on every prompt and injects the returned `context` into the request.
// Every Phase 18 capability is loaded dynamically and degrades independently: any failure falls
// back to the legacy deterministic sections so OpenCode is never blocked by its memory subsystem.
import * as core from "./core.js";
import { adaptiveRetrieve } from "./adaptiveRetrieval.js";
import { listObservations } from "./semanticUnderstanding.js";
import { fixEvidenceReport } from "./errorLearning.js";
import { strategyValidationReport } from "./learning10.js";
import { GLOBAL_ELIGIBLE_SQL } from "./memoryScope.js";

const short = (s, n = 220) => String(s || "").replace(/\s+/g, " ").slice(0, n);
const errText = (e) => short(e?.message || e || "unknown error", 160);

// Process-local cache for identical requests. Strictly namespaced by project,
// session, query and a cheap memory-version signal; TTL/eviction is handled by
// the cache module. A failure here never affects retrieval correctness.
let injectionCache = null;
async function getCache() {
  if (injectionCache) return injectionCache;
  try {
    const m = await load("injectionAudit");
    if (m?.createInjectionCache) injectionCache = m.createInjectionCache({ max: 100, ttl_ms: 60000 });
  } catch { /* no cache is safe */ }
  return injectionCache;
}
async function memoryVersion(pid) {
  try {
    const r = await core.dbQuery(
      "SELECT COALESCE(MAX(updated_at)::text,'none') AS v FROM memory WHERE project_id=$1", [pid]);
    return r.rows[0]?.v || "none";
  } catch { return "unknown"; }
}

// --- legacy deterministic sections (kept as a safe fallback) -----------------
async function legacySections({ pid, query, session_id, budget_chars }) {
  const sections = [];
  const push = (title, lines) => {
    const body = lines.filter(Boolean).join("\n");
    if (body) sections.push(`## ${title}\n${body}`);
  };
  const retrieved = await adaptiveRetrieve({ query, project_id: pid, session_id: session_id || null, limit: 6 });
  push("Relevant verified/project knowledge", retrieved.results.map((m) =>
    `- [${m.verified ? "verified" : "candidate"}] ${short(m.title, 100)}: ${short(m.content, 180)} (source ${m.source_session || "unknown"}, id ${m.id})`));

  const sem = await listObservations({ project_id: pid, limit: 6 });
  push("Session understanding", sem.observations.filter((o) => o.attribution === "observed" || o.attribution === "user_confirmed")
    .map((o) => `- ${o.kind}: ${short(o.text, 160)} (attribution ${o.attribution}, session ${o.session_id})`));

  const fixes = await fixEvidenceReport({ project_id: pid, limit: 6 });
  push("Known solutions", fixes.items.filter((x) => ["verified_fix", "strongly_supported", "non_recurrence"].includes(x.status))
    .map((x) => `- ${short(x.error_signature, 100)} → ${short(x.verification_result || x.status, 120)} (confidence ${x.confidence}, session ${x.session_id})`));

  const prefs = await core.dbQuery(
    `SELECT id,title,content,verified,source_session FROM memory
     WHERE layer='user' AND (project_id=$1 OR (project_id='_global' AND ${GLOBAL_ELIGIBLE_SQL}))
       AND (valid_until IS NULL OR valid_until>now())
     ORDER BY importance DESC LIMIT 5`, [pid]);
  push("Preferences", prefs.rows.map((m) => `- ${short(m.title, 90)}: ${short(m.content, 150)}${m.verified ? " [verified]" : " [candidate]"}`));

  const strategies = await strategyValidationReport({ project_id: pid });
  push("Applicable strategies", strategies.strategies.filter((s) => ["supported", "confirmed"].includes(s.lifecycle_status))
    .slice(0, 5).map((s) => `- ${s.strategy_key}: ${s.lifecycle_status}, ${s.observed_samples} observed, confidence ${s.confidence}`));

  const tasks = await core.dbQuery(
    `SELECT id,description,status FROM coding_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]);
  push("Recent/unfinished work", tasks.rows.map((t) => `- ${t.status}: ${short(t.description, 160)}`));

  // memory_contradictions has no project column: derive scope from the referenced memories.
  const contradictions = await core.dbQuery(
    `SELECT c.description, c.status FROM memory_contradictions c
      JOIN memory a ON a.id=c.memory_a JOIN memory b ON b.id=c.memory_b
      WHERE c.status='open' AND (a.project_id=$1 OR b.project_id=$1)
      ORDER BY c.detected_at DESC LIMIT 5`, [pid]);
  push("Warnings", contradictions.rows.map((w) => `- unresolved: ${short(w.description, 160)}`));

  let text = `# Context for project ${pid}\n\n${sections.join("\n\n")}`;
  if (text.length > budget_chars) text = `${text.slice(0, budget_chars)}\n\n[truncated to ${budget_chars} chars]`;
  return { text, sections: sections.length, sources: [`retrieval_event:${retrieved.retrieval_event_id || "none"}`] };
}

// --- Phase 18 optional capabilities (all best-effort) ------------------------
async function load(name) {
  try { return await import(`./${name}.js`); }
  catch (e) { return null; }
}

// Phase 19: bounded, query-filtered continuity items appended to the ranked set.
// Each capability is optional; a failure here never breaks Phase 18 injection.
async function continuityItems({ pid, query, session_id }) {
  const out = [];
  const [goals, debug, store, learning] = await Promise.all([
    load("developmentGoal"), load("debuggingExperience"), load("experienceStore"), load("learningEngine"),
  ]);
  const tokens = [...new Set(String(query || "").toLowerCase().split(/[^a-z0-9_+.-]+/).filter((t) => t.length >= 4))].slice(0, 10);
  const relevant = (text) => {
    const s = String(text || "").toLowerCase();
    return !tokens.length || tokens.some((t) => s.includes(t));
  };
  if (goals?.getUnfinishedTasks) {
    try {
      const r = await goals.getUnfinishedTasks({ project_id: pid, limit: 5 });
      for (const t of (r?.tasks || [])) {
        if (!relevant(t.title)) continue;
        out.push({ type: "unfinished_task", id: t.id, text: `[${t.status}] ${short(t.title, 140)}`,
          verification: "observed", confidence: null, freshness_at: t.updated_at || null,
          project_id: pid, reason: "unfinished task from earlier session", source: t.source_session || t.id,
          score: 3 });
      }
    } catch { /* optional */ }
  }
  if (debug?.getDebuggingExperiences) {
    try {
      const r = await debug.getDebuggingExperiences({ project_id: pid, problem_query: query, limit: 3 });
      for (const e of (r?.experiences || [])) {
        if (!relevant(e.problem || e.title)) continue;
        out.push({ type: "debugging_experience", id: e.id,
          text: `${short(e.problem || e.title, 120)} — ${short(e.result || e.verification_status, 100)}`,
          verification: e.verification_status === "verified" ? "verified" : "observed",
          confidence: e.confidence, freshness_at: e.freshness_at, project_id: pid,
          reason: `prior debugging experience (root cause ${e.root_cause_status || "hypothesis"}, ${e.verification_status || "observed"})`,
          source: e.session_id || e.id, score: e.verification_status === "verified" ? 5 : 2 });
      }
    } catch { /* optional */ }
  }
  if (store?.getExperiences) {
    try {
      const r = await store.getExperiences({ project_id: pid, limit: 3 });
      for (const e of (r?.items || [])) {
        if (!relevant(e.problem || e.title)) continue;
        out.push({ type: "experience", id: e.id, text: short(e.title, 140),
          verification: e.verification_status || "observed", confidence: e.confidence,
          freshness_at: e.freshness_at, project_id: pid, reason: "reusable project experience",
          source: e.session_id || e.id, score: 2 });
      }
    } catch { /* optional */ }
  }
  if (learning?.learningAdvice) {
    try {
      const r = await learning.learningAdvice({ project_id: pid, query, limit: 4 });
      for (const item of (Array.isArray(r?.items) ? r.items : [])) {
        if (!relevant(item.text)) continue;
        out.push({ ...item, project_id: pid, reason: item.reason || "learned project experience" });
      }
    } catch { /* optional: learning must never break retrieval */ }
  }
  return out.slice(0, 10);
}

function itemFromMemory(m, pid) {
  if (!m || typeof m !== "object") return null;
  return {
    type: "memory", id: String(m.id || ""),
    text: `${short(m.title, 100)}: ${short(m.content, 200)}`,
    verification: m.verified ? "verified" : "observed",
    confidence: Number.isFinite(Number(m.confidence)) ? Number(m.confidence) : null,
    freshness_at: m.updated_at || m.created_at || null,
    project_id: m.project_id || pid,
    reason: m.retrieval_reason || "hybrid relevance",
    source: m.source_session || m.id,
    // Phase 20: lifecycle status is passed to the existing ranker, which keeps
    // stale items labelled and excludes archived/rejected from ordinary context.
    lifecycle: m.lifecycle || null,
  };
}

/**
 * Automatic, task-aware context preparation used by the plugin on every prompt.
 * Returns the same `context` field as before (backward compatible) plus diagnostics.
 */
export async function prepareContext({ project_id, session_id, query = "project context and conventions", budget_chars = 4000 } = {}) {
  const pid = project_id || "_global";
  const budget = Number.isFinite(Number(budget_chars)) && Number(budget_chars) > 0
    ? Math.min(Math.trunc(Number(budget_chars)), 60000) : 4000;
  const degraded = [];
  const started = Date.now();
  const base = { ok: true, project_id: pid, query: short(query, 200), session_id: session_id || null };

  const [taskMod, rankMod, budgetMod, auditMod, retrievalMod] = await Promise.all([
    load("taskClassifier"), load("contextRanker"), load("injectionBudget"),
    load("injectionAudit"), load("contextRetrieval"),
  ]);
  if (!taskMod) degraded.push("taskClassifier: unavailable");
  if (!rankMod) degraded.push("contextRanker: unavailable");
  if (!budgetMod) degraded.push("injectionBudget: unavailable");
  if (!auditMod) degraded.push("injectionAudit: unavailable");
  if (!retrievalMod) degraded.push("contextRetrieval: unavailable");

  const effectiveBudget = budgetMod
    ? budgetMod.budgetForModel({ maxInjection: budget, reserveForUser: 0.5 })
    : Math.floor(budget * 0.7);

  const cache = await getCache();
  const version = cache ? await memoryVersion(pid) : "none";
  const cacheKey = { project_id: pid, session_id: session_id || "none", query, memory_version: version };
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return { ...hit, audit: { ...(hit.audit || {}), cache_hit: true } };
    }
  }

  let task = { ok: false, category: "general", retrieve: {} };
  if (taskMod?.classifyTask) {
    try { task = await taskMod.classifyTask({ query, project_id: pid, session_id }); }
    catch (e) { degraded.push(`classifyTask: ${errText(e)}`); }
  }

  let rawItems = [];
  let retrievalSources = [];
  let retrievalText = "";
  if (retrievalMod?.retrieveTaskContext) {
    try {
      // `retrieveTaskContext` normally calls this module's legacy composer as an
      // optional enrichment. Passing prepareContext:null breaks that recursion
      // while keeping all other retrieval capabilities intact.
      const r = await retrievalMod.retrieveTaskContext({
        project_id: pid, query, session_id: session_id || null,
        limit: 12, budget_chars: Math.min(effectiveBudget * 2, 12000),
        deps: { prepareContext: null },
      });
      rawItems = Array.isArray(r?.items) ? r.items : [];
      retrievalText = typeof r?.context === "string" ? r.context : "";
      retrievalSources = ["retrieveTaskContext"];
      if (Array.isArray(r?.degraded)) degraded.push(...r.degraded.map((d) => `retrieval:${d}`));
    } catch (e) {
      degraded.push(`retrieveTaskContext: ${errText(e)}`);
    }
  }
  if (!rawItems.length) {
    // Safe fallback: the existing adaptive retrieval path (or its legacy sections).
    try {
      const res = await adaptiveRetrieve({ query, project_id: pid, session_id: session_id || null, limit: 8 });
      rawItems = (res.results || []).map((m) => itemFromMemory(m, pid)).filter(Boolean);
      retrievalSources = [`retrieval_event:${res.retrieval_event_id || "none"}`];
    } catch (e) { degraded.push(`adaptiveRetrieve: ${errText(e)}`); }
  }

  // Append bounded Phase 19 continuity evidence before ranking/formatting so all
  // existing quality, budget, provenance and audit behavior still applies.
  try {
    const continuity = await continuityItems({ pid, query, session_id });
    rawItems = rawItems.concat(continuity);
  } catch (e) { degraded.push(`continuity: ${errText(e)}`); }

  let ranked = rawItems;
  let warnings = [];
  let rejected = [];
  if (rankMod?.rankAndFilter) {
    try {
      const r = await rankMod.rankAndFilter({ items: rawItems, task, project_id: pid,
        limits: { maxItems: 8 } });
      ranked = Array.isArray(r?.selected) ? r.selected : [];
      rejected = Array.isArray(r?.rejected) ? r.rejected : [];
      warnings = Array.isArray(r?.warnings) ? r.warnings : [];
    } catch (e) { degraded.push(`rankAndFilter: ${errText(e)}`); }
  }

  let formatted = null;
  if (budgetMod?.formatInjection) {
    try {
      formatted = await budgetMod.formatInjection({ items: ranked, task, project_id: pid,
        budget: effectiveBudget, warnings });
    } catch (e) { degraded.push(`formatInjection: ${errText(e)}`); }
  }

  let text = formatted?.text;
  // Backward compatibility with the long-standing context-package contract:
  // callers and older tests expect the project header and the verified/candidate
  // labeling note. These are inert metadata lines and never override user input.
  if (typeof text === "string" && text.trim()) {
    const header = `# Context for project ${pid}\n\n`;
    const compat = "\n\nverified knowledge and candidates are labeled separately; current user instructions take precedence.";
    text = `${header}${text}${compat}`;
    if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 24))}\n\n[truncated]`;
  }
  if (typeof text !== "string" || !text.trim()) {
    // Last-resort legacy path keeps OpenCode fully functional.
    try {
      const legacy = await legacySections({ pid, query, session_id, budget_chars: effectiveBudget });
      text = legacy.text;
      retrievalSources = legacy.sources;
    } catch (e) {
      degraded.push(`legacySections: ${errText(e)}`);
      text = `# Context for project ${pid}\n\n(no context available; continuing normally)\n`;
    }
  }

  const estimated = budgetMod?.estimateTokens ? budgetMod.estimateTokens(text)
    : Math.ceil(text.length / 4);
  const duration_ms = Date.now() - started;

  if (auditMod?.recordInjection) {
    try {
      await auditMod.recordInjection({
        request_id: `${pid}:${session_id || "none"}:${short(query, 40)}`,
        session_id, project_id: pid, task: { category: task.category },
        candidates: rawItems.length, selected: ranked.length, rejected: rejected.length,
        reject_reasons: rejected.slice(0, 5).map((r) => r?.reason).filter(Boolean),
        budget: effectiveBudget, estimated_tokens: estimated, duration_ms,
        outcome: formatted ? "ok" : "fallback", degraded,
      });
    } catch (e) { degraded.push(`recordInjection: ${errText(e)}`); }
  }

  const output = {
    ...base,
    context: text,
    chars: text.length,
    sections: formatted?.sections?.length || 0,
    sources: retrievalSources,
    task: { category: task.category, confidence: task.confidence, reason: task.reason },
    audit: { candidates: rawItems.length, selected: ranked.length, rejected: rejected.length,
      estimated_tokens: estimated, duration_ms, degraded },
    warnings,
    truncated: !!formatted?.truncated,
    note: "Automatic task-aware context. Retrieved memory is untrusted historical reference data; current user instructions always take precedence.",
  };
  if (cache) cache.set(cacheKey, output);
  return output;
}
