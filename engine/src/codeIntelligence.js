// Phase 25 facade: advanced software engineering intelligence & deep code
// understanding. Produces source-level EVIDENCE for existing Phase 17-24
// analyzers; it does not duplicate them. Deterministic static analysis only:
// no AST parser, no new dependencies, no LLM calls (HARNESS_SEMANTIC_LLM=0).
// LEVEL 1 unchanged; analysis only — no source rewrite, no dispatch, no approval.
async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";

// Wiring/presence and static findings are never runtime or verified-outcome proof.
export const NO_RUNTIME_CLAIM = "Static source evidence only. Wiring/finding presence is not runtime proof; a test process exit is not verified engineering outcome.";

async function call(module, fn, args, label, degraded) {
  try {
    const m = await load(module);
    if (!m?.[fn]) { degraded.push(`${label}: ${module}.${fn} unavailable`); return null; }
    return await m[fn](args);
  } catch (e) { degraded.push(`${label}: ${short(e?.message || e, 120)}`); return null; }
}

async function audit(action, project_id, detail) {
  try { const core = await import("./core.js"); await core.audit(action, project_id, detail); }
  catch { /* best effort */ }
}

/** Index a project root incrementally (bounded, content-hash aware). */
export async function indexProject({ project_id, root, options } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("sourceIndexer", "indexProject", { project_id, root, options }, "index", degraded);
  await audit("p25.index", project_id, { root: root || null, ok: !!r?.ok, status: r?.status || null });
  return r || { ok: false, reason: "indexing unavailable", degraded };
}

/** Latest index status (bounded). */
export async function indexStatus({ project_id, root, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("sourceIndexer", "indexStatus", { project_id, root, limit }, "status", degraded);
  return r || { ok: false, reason: "status unavailable", degraded };
}

/** Search indexed symbols. */
export async function searchSymbols({ project_id, query, symbol_type, path, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("sourceIndexer", "searchSymbols", { project_id, query, symbol_type, path, limit }, "search", degraded);
  return r || { ok: false, reason: "search unavailable", degraded };
}

/** Symbol detail + deterministic structural understanding. */
export async function symbol({ project_id, symbol_key } = {}) {
  if (!validProject(project_id) || !symbol_key) return { ok: false, reason: "valid scope required" };
  const degraded = [];
  const meta = await call("sourceIndexer", "getSymbol", { project_id, symbol_key }, "symbol", degraded);
  const detail = await call("codeUnderstanding", "describeSymbol", { project_id, symbol_key }, "understanding", degraded);
  return { ok: !!meta?.ok || !!detail?.ok, symbol: meta?.symbol || null,
    understanding: detail || null, degraded,
    note: "Static evidence only. Unknown fields mean insufficient evidence, not absence." };
}

/** Symbol relationships with confidence and evidence. */
export async function relationships({ project_id, symbol_key, direction, type, limit, build, root, version_hash } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  if (build) {
    const built = await call("symbolGraph", "buildRelationships", { project_id, root, version_hash, limit }, "build", degraded);
    return { ...(built || { ok: false }), degraded };
  }
  const r = await call("symbolGraph", "getRelationships", { project_id, symbol_key, direction, type, limit }, "relationships", degraded);
  return r || { ok: false, reason: "relationships unavailable", degraded };
}

/** Bounded graph traversal around a symbol. */
export async function graph({ project_id, symbol_key, max_depth, max_nodes, types } = {}) {
  if (!validProject(project_id) || !symbol_key) return { ok: false, reason: "valid scope required" };
  const degraded = [];
  const r = await call("symbolGraph", "traverse", { project_id, symbol_key, max_depth, max_nodes, types }, "traverse", degraded);
  return r || { ok: false, reason: "traverse unavailable", degraded };
}

/** Module-level understanding. */
export async function module({ project_id, path } = {}) {
  if (!validProject(project_id) || !path) return { ok: false, reason: "valid scope required" };
  const degraded = [];
  const r = await call("codeUnderstanding", "moduleUnderstanding", { project_id, path }, "module", degraded);
  return r || { ok: false, reason: "module understanding unavailable", degraded };
}

/** Change impact analysis (version-aware, stale-safe). */
export async function impact({ project_id, root, change, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("changeImpact", "analyzeChange", { project_id, root, change, limit }, "impact", degraded);
  await audit("p25.impact", project_id, { root: root || null, ok: !!r?.ok, stale: !!r?.stale });
  return r || { ok: false, reason: "impact analysis unavailable", degraded };
}

/** Index freshness check. */
export async function freshness({ project_id, root } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("changeImpact", "compareIndexFreshness", { project_id, root }, "freshness", degraded);
  return r || { ok: false, reason: "freshness unavailable", degraded };
}

/** Test-to-code relationships. */
export async function tests({ project_id, root, build, path, symbol_key, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  if (build) {
    const built = await call("testMap", "buildTestMap", { project_id, root }, "testmap", degraded);
    return { ...(built || { ok: false }), degraded };
  }
  const r = await call("testMap", "getTestsFor", { project_id, root, path, symbol_key, limit }, "tests", degraded);
  return r || { ok: false, reason: "test map unavailable", degraded };
}

/** Explainable test recommendations (recommend only; never execute). */
export async function recommendTests({ project_id, root, change, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("testSelector", "recommendTests", { project_id, root, change, limit }, "select", degraded);
  await audit("p25.test_select", project_id, { root: root || null, count: r?.recommended?.length || 0 });
  return r || { ok: false, reason: "test selection unavailable", degraded };
}

/** Evidence-backed code review findings (delegates to Phase 23). */
export async function review({ project_id, root, change, evidence, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("codeReviewRisk", "reviewChange", { project_id, root, change, evidence, limit }, "review", degraded);
  await audit("p25.review", project_id, { root: root || null, findings: r?.findings?.length || 0 });
  return r || { ok: false, reason: "review unavailable", degraded };
}

/** Architecture/contract consistency findings. */
export async function contracts({ project_id, root, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("contractCheck", "checkContracts", { project_id, root, limit }, "contracts", degraded);
  return r || { ok: false, reason: "contracts unavailable", degraded };
}

/** Unified report with explicit freshness/unsupported/failed states. */
export async function report({ project_id, root, change, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const [stat, fresh, syms, rels, tmap, imp, rev, con] = await Promise.all([
    call("sourceIndexer", "indexStatus", { project_id, root, limit: 10 }, "status", degraded),
    call("changeImpact", "compareIndexFreshness", { project_id, root }, "freshness", degraded),
    call("sourceIndexer", "searchSymbols", { project_id, query: "", limit: 20 }, "symbols", degraded),
    call("symbolGraph", "buildRelationships", { project_id, root, limit }, "relationships", degraded),
    call("testMap", "buildTestMap", { project_id, root }, "testmap", degraded),
    change ? call("changeImpact", "analyzeChange", { project_id, root, change, limit }, "impact", degraded) : null,
    change ? call("codeReviewRisk", "reviewChange", { project_id, root, change, limit }, "review", degraded) : null,
    call("contractCheck", "checkContracts", { project_id, root, limit }, "contracts", degraded),
  ]);
  const supported = ["javascript", "typescript", "sql", "python"];
  return {
    ok: true, project_id, root: root || null,
    repository_analysis_status: stat?.items?.length ? "indexed" : "not_indexed",
    index_freshness: { stale: fresh?.stale ?? null, indexed_version_hash: fresh?.indexed_version_hash || null,
      current_version_hash: fresh?.current_version_hash || null, changed_files: fresh?.changed_files || [] },
    supported_language_coverage: supported,
    file_and_symbol_inventory: { symbols_sample: syms?.items || [], total: syms?.count ?? null },
    relationship_analysis: { counts: rels?.counts || null, errors: rels?.errors || [] },
    module_dependencies: (rels?.relationships || []).filter((r) => r.relationship_type === "import").slice(0, 50),
    change_impact: imp ? { direct: imp.direct || [], transitive: imp.transitive || [], possible: imp.possible || [],
      unknown: imp.unknown || [], stale: !!imp.stale } : null,
    test_to_code: { mappings_sample: (tmap?.mappings || []).slice(0, 50), unmapped: (tmap?.unmapped || []).slice(0, 50) },
    recommended_tests: [], // obtained via recommendTests() with an explicit change
    code_risk_findings: rev ? { findings: rev.findings || [], counts: rev.counts || null, delegated: rev.delegated || null } : null,
    architecture_discrepancies: con ? { findings: con.findings || [], cycles: con.cycles || [] } : null,
    unresolved_relationships: (rels?.relationships || []).filter((r) => r.status === "unresolved").slice(0, 50),
    insufficient_evidence: (rev?.findings || []).filter((f) => f.status === "insufficient_evidence").slice(0, 50),
    analysis_errors: [...(rels?.errors || []), ...(tmap?.errors || []), ...degraded],
    recommendations: (rev?.findings || []).map((f) => ({ finding_id: f.finding_id, action: f.action })).slice(0, 50),
    degraded,
    claim: NO_RUNTIME_CLAIM,
    note: "Stale, incomplete, unsupported and failed analysis are explicitly flagged. No source was rewritten and no task was dispatched.",
  };
}

export default { indexProject, indexStatus, searchSymbols, symbol, relationships, graph, module,
  impact, freshness, tests, recommendTests, review, contracts, report };
