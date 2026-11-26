// Adaptive reranking on top of the existing hybrid retriever. Provider-independent.
import * as core from "./core.js";
import { contextRetrieve } from "./intelligence.js";

export async function rankMemories({ query, project_id, task_type, limit = 8, results } = {}) {
  const base = results || (await contextRetrieve({ query, project_id, task_type, limit: Math.min(limit * 3, 30) })).results;
  const strategy = (await core.dbQuery(
    `SELECT strategy_key, outcome, measurement FROM strategy_experiment_results
     WHERE ($1::text IS NULL OR project_id=$1) AND measurement='observed'`, [project_id || null])).rows;
  const strategyRate = {};
  for (const s of strategy) {
    if (!strategyRate[s.strategy_key]) strategyRate[s.strategy_key] = { n: 0, ok: 0 };
    strategyRate[s.strategy_key].n++;
    if (s.outcome === "success") strategyRate[s.strategy_key].ok++;
  }
  const ranked = base.map((m) => {
    const components = { base: Number(m.rerank_score ?? m.score ?? 0) };
    const why = [];
    const add = (key, delta) => { components[key] = Number(delta.toFixed(4)); if (delta) why.push(`${key}:${delta > 0 ? "+" : ""}${delta.toFixed(3)}`); };
    // Reliability, not popularity. Retrieval count is deliberately NOT used as a boost.
    add("verification", m.verified ? 0.10 : 0);
    add("lifecycle", m.lifecycle === "VERIFIED" ? 0.04 : m.lifecycle === "DISPUTED" || m.lifecycle === "REJECTED" ? -0.15 : 0);
    add("source_reliability", m.source_kind === "verified" || m.source_kind === "user" ? 0.03 : m.source_kind === "hypothesis" ? -0.05 : 0);
    add("explicit_feedback", Math.min(0.06, Number(m.explicit_helpful || 0) * 0.02 - Number(m.explicit_unhelpful || 0) * 0.04));
    add("observed_reuse", Math.min(0.04, Number(m.observed_usage || 0) * 0.01));
    const prov = m.provenance || "unknown";
    add("provenance", prov === "test_fixture" ? -0.25 : prov === "production" ? 0.06 : 0);
    const sk = m.metadata?.strategy_key;
    const st = sk ? strategyRate[sk] : null;
    const rate = st && st.n >= 3 ? st.ok / st.n : 0;
    add("strategy_effectiveness", rate ? Math.min(0.06, (rate - 0.5) * 0.12) : 0);
    const finalScore = Number(Math.max(0, Object.values(components).reduce((a, b) => a + b, 0)).toFixed(6));
    return { ...m, adaptive_score: finalScore, ranking_components: components,
      retrieval_reason: why.join(" ") || "base relevance only",
      evidence_type: m.verified ? "verified_knowledge" : m.source_kind === "user" ? "user_statement" : "candidate",
      source_session: m.source_session || null, project_id: m.project_id || null,
      confidence: Number(m.confidence || 0), explanation: why };
  }).sort((a, b) => b.adaptive_score - a.adaptive_score).slice(0, limit);
  return { ok: true, results: ranked };
}

export async function adaptiveRetrieve({ query, project_id, task_type, session_id, limit = 8 } = {}) {
  const base = await contextRetrieve({ query, project_id, task_type, session_id, limit: Math.min(limit * 3, 30) });
  // Attach usefulness signals BEFORE ranking: explicit user feedback stays separate from inferred reuse.
  const signals = (await core.dbQuery(
    `SELECT memory_id, signal, source FROM memory_usefulness_observations
     WHERE memory_id = ANY($1::uuid[])`, [base.results.map((x) => x.id)])).rows;
  for (const m of base.results) {
    const own = signals.filter((s) => s.memory_id === m.id);
    m.explicit_helpful = own.filter((s) => s.signal === "helpful" && s.source === "user").length;
    m.explicit_unhelpful = own.filter((s) => s.signal === "unhelpful" && s.source === "user").length;
    m.observed_usage = own.filter((s) => s.signal === "observed_usage" || s.signal === "error_not_recurred").length;
  }
  const ranked = await rankMemories({ query, project_id, task_type, limit, results: base.results });
  return { ok: true, retrieval_event_id: base.event_id, results: ranked.results };
}
