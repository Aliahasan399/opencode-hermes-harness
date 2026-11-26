// MCP server exposing the memory engine to OpenCode.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as core from "./core.js";
import { learnFromTranscript } from "./learn.js";
import { importOpenCodeHistory } from "./importer.js";
import * as patterns from "./patterns.js";
import * as consolidation from "./consolidation.js";
import { enrichSessionSummaries, rawSession } from "./roles.js";
import * as q from "./patterns-v2.js";
import * as strategy from "./strategy.js";
import * as intel from "./intelligence.js";
import * as retrievalFeedback from "./retrievalFeedback.js";
import * as learning from "./learning10.js";
import * as optimizer from "./optimizer.js";
import * as llm from "./llm-provider.js";
import * as worker from "./session-worker.js";
import * as semantic from "./semanticUnderstanding.js";
import * as errors13 from "./errorLearning.js";
import * as adaptive from "./adaptiveRetrieval.js";
import { prepareContext } from "./contextPackage.js";
import * as quality13 from "./dataQuality.js";
import { intelligenceQualityReport } from "./phase13Report.js";
import * as usefulness13 from "./usefulnessSignals.js";
import * as consolidationReport from "./consolidationReport.js";
import { filterMemoryResults, memoryAccessGuard, globalMisclassificationReport } from "./memoryScope.js";
import * as mind from "./memoryIntelligence.js";
import * as gov from "./memoryGovernance.js";
import * as authz from "./memoryAuthorization.js";
import { runTurnEnd, retryPending, automationStatus, recoverAutomation, recoverIfDue, recoverEvents } from "./automation.js";
import * as pipelineAudit from "./pipelineAudit.js";
import * as contextIntel from "./contextIntel.js";
import * as decisionIntel from "./decisionIntel.js";
import * as relationshipIntel from "./relationshipIntel.js";
import * as contextRetrieval from "./contextRetrieval.js";
import * as knowledgeQuality from "./knowledgeQuality.js";
import * as contextUpdate from "./contextUpdate.js";

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const s = new McpServer({ name: "opencode-memory", version: "0.1.0" });

s.tool("memory_status", {}, wrap(async () => ({ ok: true, ...(await core.health()), root: core.MEMORY_ROOT })));

s.tool("memory_search", {
  query: z.string().min(1),
  project_id: z.string().optional(),
  layer: z.enum(["user", "project", "session", "knowledge"]).optional(),
  limit: z.number().int().min(1).max(20).default(8),
}, wrap(async (a) => ({ ok: true, results: await core.searchMemory(a) })));

s.tool("memory_save", {
  layer: z.enum(["user", "project", "session", "knowledge"]),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(20000),
  project_id: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source_session: z.string().optional(),
  source_kind: z.enum(["observed", "user", "hypothesis", "attempt", "verified"]).default("observed"),
  confidence: z.number().min(0).max(1).default(0.5),
  importance: z.number().min(0).max(1).default(0.5),
  verified: z.boolean().default(false),
}, wrap(async (a) => {
  const dup = await core.findDuplicate(a.title, a.content, a.project_id);
  if (dup) return { ok: false, duplicate_of: dup.id, message: "similar memory already exists" };
  return { ok: true, memory: await core.saveMemory(a) };
}));

s.tool("memory_update", {
  id: z.string().uuid(),
  title: z.string().optional(),
  content: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  verified: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  valid_until: z.string().optional(),
  reason: z.string().default("update"),
}, wrap(async ({ id, reason, ...patch }) => ({ ok: true, memory: await core.updateMemory(id, patch, reason) })));

s.tool("memory_get", { id: z.string().uuid(), project_id: z.string().optional() }, wrap(async (a) => {
  const guard = memoryAccessGuard({ tool: "memory_get", args: a, project_id: a.project_id });
  if (!guard.allowed) return { ok: false, error: guard.reason };
  const m = await core.getMemory(a.id);
  if (!m) return { ok: false, error: "memory not found" };
  const visible = filterMemoryResults([m], { project_id: a.project_id });
  if (!visible.length) return { ok: false, error: "not visible in requested project scope" };
  return { ok: true, memory: m };
}));

s.tool("memory_list", {
  layer: z.enum(["user", "project", "session", "knowledge"]).optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}, wrap(async (a) => {
  const guard = memoryAccessGuard({ tool: "memory_list", args: a, project_id: a.project_id });
  if (!guard.allowed) return { ok: false, error: guard.reason };
  return { ok: true, memories: await core.listMemories(a) };
}));

s.tool("memory_delete", {
  id: z.string().uuid(),
  hard: z.boolean().default(false),
}, wrap(async (a) => ({ ok: true, result: await core.deleteMemory(a.id, a.hard) })));

s.tool("memory_summarize", {
  project_id: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(8),
}, wrap(async (a) => {
  const memories = a.query
    ? await core.searchMemory({ query: a.query, project_id: a.project_id, limit: a.limit })
    : await core.listMemories({ project_id: a.project_id, limit: a.limit });
  return { ok: true, context: core.compactContext(memories), count: memories.length };
}));

s.tool("memory_session_search", {
  query: z.string().min(1),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
}, wrap(async (a) => ({ ok: true, sessions: await core.sessionSearch(a) })));

s.tool("memory_project_context", { project_id: z.string().min(1) }, wrap(async (a) => ({ ok: true, memories: await core.projectContext(a.project_id) })));

s.tool("memory_learning_analyze", {
  session_id: z.string().min(1),
  project_id: z.string().optional(),
  transcript: z.string().min(1).max(200000),
  save: z.boolean().default(true),
}, wrap(async (a) => ({ ok: true, ...(await learnFromTranscript(a)) })));

s.tool("memory_resume_session", {
  project_id: z.string().min(1),
  query: z.string().optional(),
}, wrap(async (a) => {
  const sessions = await core.sessionSearch({ query: a.query || "resume", project_id: a.project_id, limit: 5 });
  const memories = await core.searchMemory({ query: a.query || "unfinished task", project_id: a.project_id, limit: 6 });
  return { ok: true, sessions, context: core.compactContext(memories) };
}));

s.tool("memory_import_history", {
  opencode_db: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => ({ ok: true, ...(await importOpenCodeHistory(a)) })));

// Phase 6
s.tool("memory_patterns_analyze", {
  limit: z.number().int().min(1).max(500).default(200),
  project_id: z.string().optional(),
  force: z.boolean().default(false),
}, wrap(async (a) => ({ ok: true, ...(await patterns.analyzePatterns(a)) })));

s.tool("memory_patterns_list", {
  kind: z.string().optional(),
  project_id: z.string().optional(),
  min_occurrences: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => ({ ok: true, patterns: await patterns.listPatterns(a) })));

s.tool("memory_analytics", { days: z.number().int().min(1).max(365).default(30) },
  wrap(async (a) => patterns.analytics(a.days)));
s.tool("memory_activity", {
  limit: z.number().int().min(1).max(200).default(50),
  session_id: z.string().optional(),
  action: z.string().optional(),
}, wrap(async (a) => ({ ok: true, activity: await patterns.learningActivity(a) })));

// Phase 7
s.tool("memory_consolidation_scan", {}, wrap(async () => ({ ok: true, ...(await consolidation.scanConsolidation()) })));
s.tool("memory_suggestions", {
  status: z.string().default("pending"),
  kind: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => ({ ok: true, suggestions: await consolidation.listSuggestions(a) })));
s.tool("memory_suggestion_resolve", {
  id: z.string().uuid(),
  status: z.enum(["approved", "rejected", "resolved"]),
  note: z.string().default(""),
}, wrap(async (a) => consolidation.resolveSuggestion(a.id, a)));
s.tool("memory_versions", { id: z.string().uuid() },
  wrap(async (a) => ({ ok: true, versions: await consolidation.memoryVersions(a.id) })));

// Phase 8 data
s.tool("memory_sessions_list", {
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}, wrap(async (a) => ({ ok: true, sessions: await core.listSessions(a) })));
s.tool("memory_session_detail", { id: z.string().min(1), project_id: z.string().optional() },
  wrap(async (a) => {
    const guard = memoryAccessGuard({ tool: "memory_session_detail", args: a, project_id: a.project_id });
    if (!guard.allowed) return { ok: false, error: guard.reason };
    const session = await core.sessionDetail(a.id);
    if (!session) return { ok: false, error: "session not found" };
    if (a.project_id && session.project_id !== a.project_id && a.project_id !== "_global") {
      return { ok: false, error: "session belongs to another project" };
    }
    return { ok: true, session };
  }));

// Phase 9
s.tool("memory_session_raw", {
  id: z.string().min(1),
  limit: z.number().int().min(1).max(300).default(100),
  offset: z.number().int().min(0).default(0),
  role: z.enum(["USER", "ASSISTANT"]).optional(),
  kind: z.string().optional(),
}, wrap(async (a) => rawSession(a.id, { limit: a.limit, offset: a.offset, role: a.role, kind: a.kind })));
s.tool("memory_sessions_enrich", { limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => enrichSessionSummaries({ limit: a.limit })));
s.tool("memory_patterns_quality_analyze", {
  limit: z.number().int().min(1).max(500).default(200),
  project_id: z.string().optional(),
  force: z.boolean().default(false),
}, wrap(async (a) => q.analyzeQuality(a)));
s.tool("memory_pattern_quality", {}, wrap(async () => ({ ok: true, quality: await q.patternQuality(), feedback: await q.feedbackStats() })));
s.tool("memory_pattern_feedback", {
  id: z.string().uuid(), verdict: z.enum(["useful", "not_useful"]), reason: z.string().default(""),
}, wrap(async (a) => q.feedback(a.id, a.verdict, a.reason)));
s.tool("memory_strategy_evaluate", { project_id: z.string().optional() },
  wrap(async (a) => strategy.evaluateStrategies(a)));
s.tool("memory_strategy_list", { project_id: z.string().optional() },
  wrap(async (a) => ({ ok: true, strategies: await strategy.strategyList(a) })));
s.tool("memory_strategy_stats", { project_id: z.string().optional() },
  wrap(async (a) => strategy.observationStats(a)));

// ---- Phase 10: Memory intelligence ----
s.tool("memory_semantic_search", {
  query: z.string().min(1), project_id: z.string().optional(), session_id: z.string().optional(),
  task_type: z.string().optional(), language: z.string().optional(), limit: z.number().int().min(1).max(20).default(8),
}, wrap(async (a) => intel.contextRetrieve(a)));
s.tool("memory_observe_usage", { event_id: z.number().int().positive(), session_id: z.string().min(1) },
  wrap(async (a) => retrievalFeedback.observeUsage(a)));
s.tool("memory_explicit_feedback", {
  event_id: z.number().int().positive(), memory_id: z.string().uuid(), verdict: z.enum(["helpful","unhelpful"]), reason: z.string().default(""),
}, wrap(async (a) => retrievalFeedback.explicitFeedback(a)));
s.tool("memory_usefulness_summary", { project_id: z.string().optional() },
  wrap(async (a) => retrievalFeedback.usefulnessSummary(a)));
s.tool("memory_find_contradictions", { memory_id: z.string().uuid(), limit: z.number().int().min(1).max(30).default(15) },
  wrap(async (a) => intel.detectContradictions(a)));
s.tool("memory_detect_duplicates", {
  memory_id: z.string().uuid(), limit: z.number().int().min(1).max(30).default(20), threshold: z.number().min(0).max(1).default(0.88),
}, wrap(async (a) => intel.detectDuplicates(a)));
s.tool("memory_assess_quality", { memory_id: z.string().uuid() }, wrap(async (a) => intel.assessQuality(a.memory_id)));
s.tool("memory_get_relationships", { memory_id: z.string().uuid() }, wrap(async (a) => ({
  ok: true, relationships: (await core.dbQuery(
    "SELECT * FROM memory_relationships WHERE source_id=$1 OR target_id=$1 ORDER BY created_at DESC", [a.memory_id])).rows,
  contradictions: (await core.dbQuery(
    "SELECT * FROM memory_contradictions WHERE memory_a=$1 OR memory_b=$1 ORDER BY detected_at DESC", [a.memory_id])).rows,
})));
s.tool("memory_lifecycle", {
  memory_id: z.string().uuid(), target: z.enum(["HYPOTHESIS","SUPPORTED","VERIFIED","OUTDATED","DISPUTED","REJECTED","ARCHIVED"]),
  evidence: z.array(z.object({ source: z.string(), detail: z.string().optional() })).default([]),
  note: z.string().default(""),
}, wrap(async (a) => intel.transitionLifecycle(a.memory_id, a.target, a)));
s.tool("memory_mark_useful", {
  event_id: z.number().int().positive(), memory_id: z.string().uuid(),
  signal: z.enum(["used","not_used","helpful","unhelpful","unknown"]),
  evidence: z.record(z.any()).default({}), source: z.string().default("observed"),
}, wrap(async (a) => intel.markUsefulness(a)));
s.tool("memory_usefulness_stats", {}, wrap(async () => intel.usefulnessStats()));
s.tool("memory_semantic_classify", {
  text: z.string().min(1), role: z.enum(["USER","ASSISTANT"]).default("USER"),
  project_id: z.string().optional(), source_session: z.string().optional(),
}, wrap(async (a) => intel.semanticClassify(a)));

// ---- Phase 10: Learning engine ----
s.tool("learning_record_task", {
  description: z.string().min(1), session_id: z.string().optional(), project_id: z.string().optional(),
  task_type: z.string().optional(), language: z.string().optional(), framework: z.string().optional(), task_id: z.string().optional(),
}, wrap(async (a) => learning.recordTask(a)));
s.tool("learning_record_attempt", {
  task_id: z.string().min(1), approach: z.string().min(1), strategy_id: z.string().optional(),
  duration_ms: z.number().int().optional(), retry_number: z.number().int().min(0).default(0),
}, wrap(async (a) => learning.recordAttempt(a)));
s.tool("learning_record_outcome", {
  task_id: z.string().min(1), attempt_id: z.number().int().optional(), metric: z.string().min(1),
  value: z.string().min(1), measurement: z.enum(["observed","estimated","missing"]).default("observed"),
  evidence: z.record(z.any()).default({}),
}, wrap(async (a) => learning.recordOutcome(a)));
s.tool("learning_get_outcomes", { task_id: z.string().optional(), project_id: z.string().optional() },
  wrap(async (a) => learning.getOutcomes(a)));
s.tool("learning_run_experiment", {
  baseline: z.string().min(1), alternative: z.string().min(1), strategy_key: z.string().optional(),
  task_context: z.record(z.any()).default({}), sample_required: z.number().int().min(1).default(5), limitations: z.string().default(""),
}, wrap(async (a) => learning.createExperiment(a)));
s.tool("learning_add_result", {
  experiment_id: z.string().uuid(), task_id: z.string().optional(), strategy_key: z.string().optional(),
  strategy_version: z.number().int().optional(), outcome: z.enum(["success","failure","inconclusive"]),
  metrics: z.record(z.any()).default({}), measurement: z.enum(["observed","estimated","missing"]).default("observed"), limitations: z.string().default(""),
}, wrap(async (a) => learning.addExperimentResult(a)));
s.tool("learning_compare_strategies", {
  experiment_id: z.string().uuid(), min_samples: z.number().int().min(1).default(5),
}, wrap(async (a) => learning.compareStrategies(a)));
s.tool("learning_get_insights", { project_id: z.string().optional() }, wrap(async (a) => learning.learningInsights(a)));
s.tool("learning_capture_outcomes", { session_id: z.string().min(1), project_id: z.string().optional() },
  wrap(async (a) => learning.captureOutcomes(a)));
s.tool("learning_link_outcomes", { project_id: z.string().optional(), limit: z.number().int().min(1).max(500).default(200) },
  wrap(async (a) => learning.linkOutcomesToExperiments(a)));
s.tool("learning_strategy_lifecycle", {
  strategy_key: z.string().min(1), min_samples: z.number().int().min(2).default(5), approval: z.boolean().default(false),
}, wrap(async (a) => learning.strategyLifecycle(a)));
s.tool("learning_self_improvement_report", { project_id: z.string().optional() },
  wrap(async (a) => learning.selfImprovementReport(a)));
s.tool("consolidation_triage", { batch: z.number().int().min(1).max(500).default(200), project_id: z.string().optional() },
  wrap(async (a) => consolidation.triageSuggestions(a)));
s.tool("consolidation_quality_report", { project_id: z.string().optional() },
  wrap(async (a) => consolidation.qualityReport(a)));
s.tool("consolidation_apply_approved", {
  suggestion_id: z.string().uuid(), approved: z.boolean().default(false), actor: z.string().default("user"), note: z.string().default(""),
}, wrap(async (a) => consolidation.applyApprovedConsolidation(a)));
s.tool("consolidation_rollback", { rollback_id: z.number().int().positive(), actor: z.string().default("user") },
  wrap(async (a) => consolidation.rollbackConsolidation(a)));
s.tool("learning_strategy_versions", { strategy_key: z.string().optional() }, wrap(async (a) => ({ ok: true, versions: await learning.strategyVersions(a) })));
s.tool("learning_strategy_rollback", { strategy_key: z.string().min(1), version: z.number().int().min(1) },
  wrap(async (a) => learning.rollbackStrategy(a)));

// ---- Phase 10: Autonomous optimization ----
s.tool("optimizer_analyze_task", {
  project_id: z.string().optional(), description: z.string().min(1), session_id: z.string().optional(),
  task_type: z.string().optional(), language: z.string().optional(), framework: z.string().optional(), error_category: z.string().optional(),
}, wrap(async (a) => optimizer.analyzeTask(a)));
s.tool("optimizer_recommend_strategy", {
  context: z.record(z.any()).default({}), strategy_key: z.string().min(1), min_samples: z.number().int().min(1).default(3),
}, wrap(async (a) => optimizer.recommendStrategy(a)));
s.tool("optimizer_get_evidence", { strategy_key: z.string().min(1) }, wrap(async (a) => ({
  ok: true, results: (await core.dbQuery(
    "SELECT outcome,measurement,metrics,limitations,created_at FROM strategy_experiment_results WHERE strategy_key=$1 ORDER BY created_at DESC", [a.strategy_key])).rows,
})));
s.tool("optimizer_evaluate_result", {
  action_id: z.number().int().positive(), status: z.enum(["executed","validated","failed","rolled_back"]),
  result: z.record(z.any()).default({}), rollback_info: z.record(z.any()).default({}), executed_by: z.string().default("user"),
}, wrap(async (a) => optimizer.recordActionResult(a)));
s.tool("optimizer_get_context", { project_id: z.string().optional(), query: z.string().min(1) },
  wrap(async (a) => intel.contextRetrieve({ ...a, limit: 6 })));
s.tool("optimizer_autonomy_status", {}, wrap(async () => optimizer.autonomyStatus()));
s.tool("optimizer_recommendations", { status: z.string().default("pending"), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => ({ ok: true, recommendations: await optimizer.getRecommendations(a) })));
s.tool("optimizer_decide", {
  id: z.string().uuid(), decision: z.enum(["approved","rejected"]), actor: z.string().default("user"), note: z.string().default(""),
}, wrap(async (a) => optimizer.decideRecommendation(a)));
s.tool("optimizer_prepare_action", {
  recommendation_id: z.string().uuid(), action: z.string().min(1),
  result: z.record(z.any()).default({}), rollback_info: z.record(z.any()).default({}),
}, wrap(async (a) => optimizer.prepareAction(a)));
s.tool("optimizer_evaluation_report", { baseline_key: z.string().default("phase9"), candidate_key: z.string().default("phase10") },
  wrap(async (a) => optimizer.evaluationReport(a)));

// ---- Phase 11: secure inference adapter + worker ----
s.tool("llm_status", {}, wrap(async () => llm.status()));
s.tool("llm_usage", {}, wrap(async () => llm.usage()));
s.tool("llm_test", {
  task: z.enum(["session_understanding","memory_extraction","multilingual_classification","contradiction_analysis","outcome_evaluation","strategy_evaluation"]),
  payload: z.record(z.any()).default({}),
}, wrap(async (a) => llm.runTask(a.task, a.payload)));
s.tool("llm_redact", { text: z.string() }, wrap(async (a) => ({ ok: true, text: llm.redact(a.text) })));
s.tool("worker_process_session", { session_id: z.string().min(1), force: z.boolean().default(false) },
  wrap(async (a) => worker.processSession(a)));
s.tool("worker_process_incremental", { limit: z.number().int().min(1).max(100).default(10), force: z.boolean().default(false) },
  wrap(async (a) => worker.processIncremental(a)));
s.tool("worker_queue_status", {}, wrap(async () => worker.queueStatus()));
s.tool("worker_retry_paused", { limit: z.number().int().min(1).max(20).default(5) }, wrap(async (a) => worker.retryPaused(a)));
s.tool("memory_ai_classify", {
  text: z.string().min(1), role: z.enum(["USER","ASSISTANT"]).default("USER"),
  project_id: z.string().optional(), source_session: z.string().optional(),
}, wrap(async (a) => intel.semanticClassify(a)));
s.tool("learning_interpret_outcome", { task_id: z.string().min(1), evidence: z.record(z.any()).default({}) },
  wrap(async (a) => learning.interpretOutcome(a)));
s.tool("memory_ai_contradiction", { memory_a: z.string().uuid(), memory_b: z.string().uuid() },
  wrap(async (a) => intel.assessContradiction(a)));

// ---- Turn-end automation ----
s.tool("automation_run", {
  session_id: z.string().min(1), directory: z.string().optional(), project_id: z.string().optional(),
  transcript: z.string().default(""), event_id: z.string().optional(), allow_llm: z.boolean().default(false),
}, wrap(async (a) => runTurnEnd(a)));
s.tool("automation_status", {}, wrap(async () => automationStatus()));
s.tool("automation_retry", { limit: z.number().int().min(1).max(100).default(10) },
  wrap(async (a) => retryPending(a)));
s.tool("automation_recover", { limit: z.number().int().min(1).max(100).default(20), scan_transcripts: z.boolean().default(true) },
  wrap(async (a) => recoverAutomation(a)));
s.tool("automation_recover_events", { limit: z.number().int().min(1).max(100).default(30), max_attempts: z.number().int().min(1).default(5) },
  wrap(async (a) => recoverEvents(a)));

// ---- Phase 13 tools ----
s.tool("session_semantic_analyze", { session_id: z.string().min(1), project_id: z.string().optional(), force: z.boolean().default(false) },
  wrap(async (a) => semantic.analyzeSession(a)));
s.tool("session_semantic_observations", { project_id: z.string().optional(), session_id: z.string().optional(), kind: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => semantic.listObservations(a)));
s.tool("error_record_failure", { session_id: z.string().min(1), project_id: z.string().optional(), text: z.string().min(1), seq: z.number().int().optional() },
  wrap(async (a) => errors13.recordFailure(a)));
s.tool("error_record_fix", { session_id: z.string().min(1), project_id: z.string().optional(), error_hash: z.string().min(1), attempted_fix: z.string().optional(), verification_command: z.string().optional(), verification_result: z.string().optional() },
  wrap(async (a) => errors13.recordFix(a)));
s.tool("error_observe_recurrence", { session_id: z.string().min(1), project_id: z.string().optional(), error_hash: z.string().min(1), window_days: z.number().int().min(1).default(7) },
  wrap(async (a) => errors13.observeRecurrence(a)));
s.tool("error_fix_report", { project_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => errors13.fixEvidenceReport(a)));
s.tool("memory_adaptive_search", { query: z.string().min(1), project_id: z.string().optional(), task_type: z.string().optional(), session_id: z.string().optional(), limit: z.number().int().min(1).max(20).default(8) },
  wrap(async (a) => adaptive.adaptiveRetrieve(a)));
s.tool("context_prepare", { project_id: z.string().optional(), query: z.string().default("project context and conventions"), budget_chars: z.number().int().min(200).max(12000).default(4000) },
  wrap(async (a) => prepareContext(a)));
s.tool("data_quality_provenance", { project_id: z.string().optional() }, wrap(async (a) => quality13.provenanceReport(a)));
s.tool("data_quality_dry_run", { project_id: z.string().optional() }, wrap(async (a) => quality13.dryRunQualityReport(a)));
s.tool("global_misclassification_report", { limit: z.number().int().min(0).max(500).default(100) },
  wrap(async (a) => globalMisclassificationReport({ limit: a.limit })));
s.tool("memory_quality_score", { memory_id: z.string().uuid(), actor: z.string().default("harness") },
  wrap(async (a) => mind.scoreMemoryQuality(a)));
s.tool("memory_maintenance_report", { project_id: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
  wrap(async (a) => mind.maintenanceReport(a)));
s.tool("memory_retrieval_explain", { query: z.string().min(1), project_id: z.string().optional(), limit: z.number().int().min(1).max(20).default(8) },
  wrap(async (a) => mind.explainRetrieval(a)));
s.tool("learning_evidence_report", { project_id: z.string().optional(), limit: z.number().int().min(1).max(100).default(100) },
  wrap(async (a) => mind.learningEvidenceReport(a)));
s.tool("memory_archive", { memory_id: z.string().uuid(), actor: z.string().default("user"), note: z.string().default("") },
  wrap(async (a) => mind.archiveMemory(a)));
s.tool("memory_restore", { memory_id: z.string().uuid(), actor: z.string().default("user") },
  wrap(async (a) => mind.restoreMemory(a)));

// ---- Phase 14 governance and authorization ----
s.tool("global_classification_report", { limit: z.number().int().min(0).max(500).default(200) },
  wrap(async (a) => gov.classifyGlobalMemories(a)));
s.tool("scope_corrections_propose", {
  limit: z.number().int().min(1).max(500).default(100), dry_run: z.boolean().default(true), memory_id: z.string().uuid().optional(),
}, wrap(async (a) => gov.proposeScopeCorrections(a)));
s.tool("scope_reviews_list", { status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => gov.listScopeReviews(a)));
s.tool("scope_review_approve", {
  id: z.string().uuid(), approved: z.boolean().default(false), reviewer: z.string().default(""), note: z.string().default(""),
}, wrap(async (a) => gov.approveScopeReview(a)));
s.tool("scope_review_reject", {
  id: z.string().uuid(), rejected: z.boolean().default(false), reviewer: z.string().default(""), note: z.string().default(""),
}, wrap(async (a) => gov.rejectScopeReview(a)));
s.tool("scope_review_rollback", { id: z.string().uuid(), reviewer: z.string().default("user") },
  wrap(async (a) => gov.rollbackScopeReview(a)));
s.tool("maintenance_issues_report", { project_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(100) },
  wrap(async (a) => gov.staleDuplicateContradictionReport(a)));
s.tool("memory_quality_explain", { memory_id: z.string().uuid() },
  wrap(async (a) => gov.memoryQualityExplainability(a)));
s.tool("memory_authorize", {
  tool: z.string().min(1), project_id: z.string().optional(), memory_id: z.string().uuid().optional(),
  admin: z.boolean().default(false), action: z.string().default("read"),
}, wrap(async (a) => authz.authorizeMemoryAccess(a)));
s.tool("memory_authorize_relationships", { project_id: z.string().optional(), memory_id: z.string().uuid() },
  wrap(async (a) => authz.authorizeRelationshipTraversal(a)));
s.tool("memory_authorize_versions", { project_id: z.string().optional(), memory_id: z.string().uuid() },
  wrap(async (a) => authz.authorizeVersionHistory(a)));
s.tool("memory_authorize_session", { project_id: z.string().optional(), session_id: z.string().min(1) },
  wrap(async (a) => authz.authorizeSessionDetail(a)));
s.tool("memory_authorize_suggestion", { project_id: z.string().optional(), suggestion_id: z.string().uuid() },
  wrap(async (a) => authz.authorizeSuggestionAccess(a)));
s.tool("memory_security_report", { project_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(100) },
  wrap(async (a) => authz.securityAuditReport(a)));
s.tool("intelligence_quality_report", { project_id: z.string().optional() }, wrap(async (a) => intelligenceQualityReport(a)));
s.tool("memory_observe_error_non_recurrence", { session_id: z.string().min(1), event_id: z.number().int().positive() },
  wrap(async (a) => usefulness13.observeErrorNonRecurrence(a)));
s.tool("memory_usefulness_signal_summary", { project_id: z.string().optional() },
  wrap(async (a) => usefulness13.usefulnessSignalSummary(a)));
s.tool("consolidation_backlog_report", { project_id: z.string().optional(), limit: z.number().int().min(0).max(200).default(100) },
  wrap(async (a) => consolidationReport.backlogReport(a)));
s.tool("consolidation_stale_report", { older_than_days: z.number().int().min(1).default(30), project_id: z.string().optional(), limit: z.number().int().min(0).max(200).default(100) },
  wrap(async (a) => consolidationReport.staleSuggestionReport(a)));
s.tool("consolidation_coverage", {}, wrap(async () => consolidationReport.consolidationCoverage()));

// Phase 15 read-only pipeline audit tools. Wiring presence is never presented as
// runtime proof; the processing/gap tools report observed DB state separately.
s.tool("pipeline_dependency_map", {}, wrap(async () => pipelineAudit.pipelineDependencyMap()));
s.tool("pipeline_wiring_audit", {}, wrap(async () => pipelineAudit.auditPipelineIntegrity()));
s.tool("pipeline_processing_audit", { limit: z.number().int().min(1).max(100).default(20) },
  wrap(async (a) => pipelineAudit.auditRecentProcessing(a)));
s.tool("pipeline_gap_report", {}, wrap(async () => pipelineAudit.understandingGapReport()));

// Phase 17 — contextual intelligence. Read tools are inspection-only; mutation tools
// enforce project scope and return structured results. No secrets/env are exposed.
// Phase 23 — proactive project intelligence. Analysis/recommendations only; never applies changes.
s.tool("project_analyze", {
  project_id: z.string().min(1), session_id: z.string().optional(),
  components: z.array(z.string()).default([]), force: z.boolean().default(false),
}, wrap(async (a) => (await import("./projectIntelligence.js")).analyzeProject(a)));
s.tool("project_intelligence_report", {
  project_id: z.string().min(1), report_type: z.enum(["all", "health", "debt", "risk", "tests", "dependencies", "architecture", "recommendations", "roadmap", "history"]).default("all"),
  component: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectIntelligence.js")).projectReport(a)));
s.tool("project_engineering_tasks", {
  project_id: z.string().min(1), recommendation_id: z.string().uuid(), request: z.string().optional(),
}, wrap(async (a) => (await import("./projectIntelligence.js")).prepareEngineeringTasks(a)));
s.tool("project_analysis_status", {
  project_id: z.string().min(1), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectIntelligence.js")).analysisStatus(a)));
s.tool("project_analysis_retry", { limit: z.number().int().min(1).max(100).default(20) },
  wrap(async (a) => (await import("./projectIntelligence.js")).retryAnalysis(a)));

// Phase 22 — agent orchestration. Planning/execution uses real OpenCode interfaces via the caller.
s.tool("agent_plan_create", {
  project_id: z.string().min(1), request: z.string().min(1), session_id: z.string().optional(),
  max_tasks: z.number().int().min(1).max(30).default(12),
}, wrap(async (a) => (await import("./agentOrchestrator.js")).orchestrate(a)));
s.tool("agent_plan_status", { plan_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentOrchestrator.js")).planStatus(a)));
s.tool("agent_report", { plan_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentOrchestrator.js")).orchestrationReport(a)));
s.tool("agent_resume", { plan_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentOrchestrator.js")).resumePlan(a)));
s.tool("agent_selection_explain", { plan_id: z.string().min(1), task_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentOrchestrator.js")).explainSelection(a)));
s.tool("agent_discover", {}, wrap(async () => (await import("./agentRegistry.js")).discoverAgents()));
s.tool("agent_task_claim", {
  plan_id: z.string().min(1), task_id: z.string().min(1), agent: z.string().min(1),
  project_id: z.string().min(1), session_id: z.string().optional(),
}, wrap(async (a) => (await import("./agentCoordination.js")).claimTask(a)));
s.tool("agent_task_complete", {
  plan_id: z.string().min(1), task_id: z.string().min(1), agent: z.string().min(1),
  project_id: z.string().min(1), result: z.record(z.unknown()).default({}),
}, wrap(async (a) => (await import("./agentCoordination.js")).completeTask(a)));
s.tool("agent_task_fail", {
  plan_id: z.string().min(1), task_id: z.string().min(1), agent: z.string().min(1),
  project_id: z.string().min(1), error: z.string().default("task failed"),
}, wrap(async (a) => (await import("./agentCoordination.js")).failTask(a)));
s.tool("agent_context_prepare", {
  plan_id: z.string().min(1), task_id: z.string().min(1), agent: z.string().min(1),
  project_id: z.string().min(1), request: z.string().default(""),
  context_budget: z.number().int().min(200).max(60000).default(4000),
}, wrap(async (a) => (await import("./agentContext.js")).prepareAgentContext(a)));
s.tool("agent_conflicts", { plan_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentConflicts.js")).detectConflicts(a)));
s.tool("agent_result_validate", {
  plan_id: z.string().min(1), task_id: z.string().min(1), project_id: z.string().min(1),
  claimed_done: z.boolean().default(false), evidence: z.array(z.string()).default([]),
}, wrap(async (a) => (await import("./agentValidation.js")).validateTaskResult(a)));
s.tool("agent_integrate", { plan_id: z.string().min(1), project_id: z.string().min(1) },
  wrap(async (a) => (await import("./agentIntegration.js")).integrateResults(a)));

// Phase 24 — controlled, approval-gated workflow execution. LEVEL 1 preserved:
// simulation is the default; real dispatch requires a single-use scope-bound token.
// process_ok never implies task_verified; four evidence tiers are kept distinct.
s.tool("workflow_templates", {},
  wrap(async () => (await import("./workflowTemplates.js")).listTemplates()));
s.tool("workflow_create", {
  project_id: z.string().min(1), template: z.string().min(1), objective: z.string().default(""),
  scope: z.record(z.unknown()).default({}),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  mode: z.enum(["simulation", "real"]).default("simulation"),
  source_ref: z.string().optional(), created_by: z.string().optional(),
  plan_id: z.string().optional(), plan_version: z.string().optional(), plan_hash: z.string().optional(),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).createWorkflow(a)));
s.tool("workflow_approve", {
  project_id: z.string().min(1), plan_id: z.string().min(1),
  plan_version: z.string().default(""), plan_hash: z.string().default(""),
  scope: z.record(z.unknown()).default({}),
  mode: z.enum(["simulation", "real"]).default("simulation"),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  approved_by: z.string().default(""),
  expires_in_ms: z.number().int().min(1000).max(2592000000).optional(), request: z.string().optional(),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).approve(a)));
s.tool("workflow_approvals", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./workflowApproval.js")).listApprovals(a)));
s.tool("workflow_dispatch", {
  project_id: z.string().min(1), run_id: z.string().min(1),
  approval_id: z.string().min(1), token: z.string().min(1),
  mode: z.enum(["simulation", "real"]).default("simulation"),
  max_parallel: z.number().int().min(1).max(8).default(4), dry_run: z.boolean().default(true),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).dispatch(a)));
s.tool("workflow_status", {
  project_id: z.string().min(1), run_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).status(a)));
s.tool("workflow_validate", {
  project_id: z.string().min(1), run_id: z.string().min(1), task_key: z.string().min(1),
  checks: z.array(z.object({ pass: z.boolean(), name: z.string().optional() })).default([]),
  evidence_class: z.enum(["mock", "api", "runtime", "agent"]).default("api"),
  process_ok: z.boolean().default(false),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).validate(a)));
s.tool("workflow_recover", {
  project_id: z.string().min(1), run_id: z.string().min(1),
  approval_id: z.string().min(1), token: z.string().min(1),
  max_attempts: z.number().int().min(1).max(5).default(2), dry_run: z.boolean().default(true),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).recover(a)));
s.tool("workflow_test", {
  project_id: z.string().min(1), run_id: z.string().min(1), task_key: z.string().min(1),
  mode: z.enum(["simulation", "real"]).default("simulation"),
  test_command: z.string().optional(), dry_run: z.boolean().default(true), db_name: z.string().optional(),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).test(a)));
s.tool("workflow_feedback", {
  project_id: z.string().min(1), run_id: z.string().min(1),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).feedback(a)));
s.tool("workflow_report", {
  project_id: z.string().min(1), run_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./controlledWorkflow.js")).report(a)));

// Phase 25 — source-level engineering intelligence. Analysis only: static evidence,
// explicit confidence/staleness, no source rewriting and no dispatch.
s.tool("code_index", {
  project_id: z.string().min(1), root: z.string().min(1),
  options: z.record(z.unknown()).default({}),
}, wrap(async (a) => (await import("./codeIntelligence.js")).indexProject(a)));
s.tool("code_index_status", {
  project_id: z.string().min(1), root: z.string().optional(), limit: z.number().int().min(1).max(200).default(10),
}, wrap(async (a) => (await import("./codeIntelligence.js")).indexStatus(a)));
s.tool("code_symbol_search", {
  project_id: z.string().min(1), query: z.string().default(""), symbol_type: z.string().optional(),
  path: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).searchSymbols(a)));
s.tool("code_symbol_detail", {
  project_id: z.string().min(1), symbol_key: z.string().min(1),
}, wrap(async (a) => (await import("./codeIntelligence.js")).symbol(a)));
s.tool("code_relationships", {
  project_id: z.string().min(1), symbol_key: z.string().optional(),
  direction: z.enum(["in", "out"]).optional(), type: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  build: z.boolean().default(false), root: z.string().optional(),
}, wrap(async (a) => (await import("./codeIntelligence.js")).relationships(a)));
s.tool("code_graph", {
  project_id: z.string().min(1), symbol_key: z.string().min(1),
  max_depth: z.number().int().min(1).max(6).default(3), max_nodes: z.number().int().min(1).max(500).default(100),
}, wrap(async (a) => (await import("./codeIntelligence.js")).graph(a)));
s.tool("code_module", {
  project_id: z.string().min(1), path: z.string().min(1),
}, wrap(async (a) => (await import("./codeIntelligence.js")).module(a)));
s.tool("code_change_impact", {
  project_id: z.string().min(1), root: z.string().min(1), change: z.record(z.unknown()).default({}),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).impact(a)));
s.tool("code_freshness", {
  project_id: z.string().min(1), root: z.string().min(1),
}, wrap(async (a) => (await import("./codeIntelligence.js")).freshness(a)));
s.tool("code_test_map", {
  project_id: z.string().min(1), root: z.string().optional(), build: z.boolean().default(false),
  path: z.string().optional(), symbol_key: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).tests(a)));
s.tool("code_test_recommend", {
  project_id: z.string().min(1), root: z.string().min(1), change: z.record(z.unknown()).default({}),
  limit: z.number().int().min(1).max(100).default(30),
}, wrap(async (a) => (await import("./codeIntelligence.js")).recommendTests(a)));
s.tool("code_review", {
  project_id: z.string().min(1), root: z.string().min(1), change: z.record(z.unknown()).default({}),
  evidence: z.record(z.unknown()).default({}), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).review(a)));
s.tool("code_contracts", {
  project_id: z.string().min(1), root: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).contracts(a)));
s.tool("code_report", {
  project_id: z.string().min(1), root: z.string().min(1), change: z.record(z.unknown()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./codeIntelligence.js")).report(a)));

// Phase 26 — long-term project management intelligence. Record-based evidence only;
// no auto-approval, dispatch or source rewrite. Read tools are analysis; ops are explicit.
s.tool("pm_status", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(20),
}, wrap(async (a) => (await import("./projectManagement.js")).status(a)));
s.tool("pm_goals", {
  project_id: z.string().min(1), op: z.enum(["list", "create", "state", "update", "detail", "history"]).default("list"),
  title: z.string().optional(), goal_id: z.string().optional(), status: z.string().optional(),
  goal_type: z.enum(["vision", "long_term", "short_term"]).optional(),
  provenance: z.enum(["user_approved", "inferred", "ai_recommendation", "verified_outcome"]).optional(),
  parent_goal_id: z.string().optional(), success_criteria: z.array(z.string()).optional(),
  evidence: z.array(z.record(z.unknown())).optional(), actor: z.string().optional(),
  patch: z.record(z.unknown()).optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).goals(a)));
s.tool("pm_milestones", {
  project_id: z.string().min(1), op: z.enum(["list", "create", "state", "progress", "get"]).default("list"),
  milestone_key: z.string().optional(), title: z.string().optional(), goal_id: z.string().optional(),
  success_criteria: z.array(z.string()).optional(), status: z.string().optional(),
  evidence: z.array(z.record(z.unknown())).optional(), actor: z.string().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).milestones(a)));
s.tool("pm_progress", {
  project_id: z.string().min(1), op: z.enum(["compute", "record", "list", "history"]).default("compute"),
  snapshot_key: z.string().optional(), goal_id: z.string().optional(), milestone_id: z.string().optional(),
  task_id: z.string().optional(), session_id: z.string().optional(), status: z.string().optional(),
  evidence: z.array(z.record(z.unknown())).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).progress(a)));
s.tool("pm_dependencies", {
  project_id: z.string().min(1), op: z.enum(["analyze", "record", "list", "cycles"]).default("analyze"),
  node_type: z.string().optional(), node_id: z.string().optional(),
  from_type: z.string().optional(), from_id: z.string().optional(),
  to_type: z.string().optional(), to_id: z.string().optional(),
  dependency_type: z.enum(["confirmed", "inferred", "proposed", "unresolved"]).optional(),
  max_depth: z.number().int().min(1).max(6).default(3), max_nodes: z.number().int().min(1).max(500).default(100),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).dependencies(a)));
s.tool("pm_blockers", {
  project_id: z.string().min(1), op: z.enum(["list", "record", "state", "resolve", "risks"]).default("list"),
  blocker_key: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
  severity: z.string().optional(), category: z.string().optional(), status: z.string().optional(),
  affected_goals: z.array(z.string()).optional(), affected_milestones: z.array(z.string()).optional(),
  affected_tasks: z.array(z.string()).optional(), evidence: z.array(z.record(z.unknown())).optional(),
  actor: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).blockers(a)));
s.tool("pm_briefing", {
  project_id: z.string().min(1), op: z.enum(["build", "save", "latest"]).default("build"),
  session_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(20),
}, wrap(async (a) => (await import("./projectManagement.js")).briefing(a)));
s.tool("pm_drift", {
  project_id: z.string().min(1), op: z.enum(["analyze", "list", "state"]).default("analyze"),
  finding_key: z.string().optional(), status: z.string().optional(), actor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).drift(a)));
s.tool("pm_ownership", {
  project_id: z.string().min(1), op: z.enum(["overview", "assign", "state", "get"]).default("overview"),
  task_id: z.string().optional(), agent: z.string().optional(), assignment_reason: z.string().optional(),
  status: z.string().optional(), evidence: z.array(z.record(z.unknown())).optional(),
  actor: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).ownership(a)));
s.tool("pm_recovery", {
  project_id: z.string().min(1), op: z.enum(["assess", "prepare"]).default("assess"),
  task_id: z.string().optional(), run_id: z.string().optional(),
  approval_id: z.string().optional(), token: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./projectManagement.js")).recovery(a)));
s.tool("pm_next_actions", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(10),
}, wrap(async (a) => (await import("./projectManagement.js")).nextActions(a)));
s.tool("pm_report", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(20),
}, wrap(async (a) => (await import("./projectManagement.js")).report(a)));

// Phase 27 — adaptive intelligence. Evaluation and advisory proposals only; no
// auto-approval, dispatch, source rewrite, or verification from model confidence.
s.tool("adapt_outcome_ingest", {
  project_id: z.string().min(1), source_type: z.string().min(1), source_id: z.string().default(""),
  subsystem: z.string().optional(), observation: z.string().default(""),
  expected_outcome: z.record(z.unknown()).optional(), actual_outcome: z.record(z.unknown()).optional(),
  evidence: z.array(z.record(z.unknown())).default([]), actor: z.string().optional(),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).ingestOutcome(a)));
s.tool("adapt_recommendation_evaluate", {
  project_id: z.string().min(1), recommendation_type: z.string().min(1), recommendation_id: z.string().min(1),
  original: z.record(z.unknown()).optional(), reason: z.string().optional(),
  evidence: z.array(z.record(z.unknown())).default([]), confidence: z.number().min(0).max(1).optional(),
  operator_decision: z.string().optional(), action_occurred: z.boolean().default(false),
  result_verified: z.boolean().default(false), observed_outcome: z.string().optional(),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).evaluateRecommendation(a)));
s.tool("adapt_prediction_evaluate", {
  project_id: z.string().min(1), prediction_type: z.string().min(1), prediction_id: z.string().min(1),
  predicted: z.record(z.unknown()).optional(), confidence: z.number().min(0).max(1).optional(),
  prediction_time: z.string().optional(), observation_window: z.string().optional(),
  actual: z.record(z.unknown()).optional(), verification_evidence: z.array(z.record(z.unknown())).default([]),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).evaluatePrediction(a)));
s.tool("adapt_decomposition_evaluate", {
  project_id: z.string().min(1), plan_id: z.string().min(1),
  task_count: z.number().int().min(0).default(0), dependency_count: z.number().int().min(0).default(0),
  ownership_conflicts: z.number().int().min(0).default(0), review_failures: z.number().int().min(0).default(0),
  rework_count: z.number().int().min(0).default(0), completion_verified: z.boolean().default(false),
  evidence: z.array(z.record(z.unknown())).default([]),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).evaluateDecomposition(a)));
s.tool("adapt_agent_suitability", {
  project_id: z.string().min(1), agent: z.string().min(1), task_category: z.string().optional(),
  min_samples: z.number().int().min(1).max(100).default(5),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).agentSuitability(a)));
s.tool("adapt_retrieval_usefulness", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).retrievalUsefulness(a)));
s.tool("adapt_failure_patterns", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).failurePatterns(a)));
s.tool("adapt_learning_quality", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).learningQuality(a)));
s.tool("adapt_calibration_propose", {
  project_id: z.string().min(1), proposal_key: z.string().min(1), target_subsystem: z.string().min(1),
  current_behavior: z.record(z.unknown()).default({}), proposed_behavior: z.record(z.unknown()).default({}),
  reason: z.string().default(""), evidence: z.array(z.record(z.unknown())).default([]),
  sample_size: z.number().int().min(0).default(0), confidence: z.number().min(0).max(1).optional(),
  expected_benefit: z.string().optional(), potential_downside: z.string().optional(), reversal: z.string().optional(),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).proposeCalibration(a)));
s.tool("adapt_calibration_review", {
  project_id: z.string().min(1), proposal_id: z.string().min(1), decision: z.enum(["approve", "reject"]),
  actor: z.string().min(1),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).reviewCalibration(a)));
s.tool("adapt_calibration_apply", {
  project_id: z.string().min(1), proposal_id: z.string().min(1), actor: z.string().min(1),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).applyCalibration(a)));
s.tool("adapt_calibration_rollback", {
  project_id: z.string().min(1), proposal_id: z.string().min(1), actor: z.string().min(1),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).rollbackCalibration(a)));
s.tool("adapt_proposals", {
  project_id: z.string().min(1), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).proposals(a)));
s.tool("adapt_report", {
  project_id: z.string().min(1), window: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./adaptiveIntelligence.js")).report(a)));
s.tool("ops_health", {
  project_id: z.string().optional(), limit: z.number().int().min(1).max(50).default(20),
}, wrap(async (a) => (await import("./operationalHealth.js")).operationalHealth(a)));

// Phase 21 — continuous learning. Reads inspection-only; mutations require explicit flags.
s.tool("learning_status", { project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => (await import("./learningEngine.js")).learningStatus(a)));
s.tool("learning_run", {
  session_id: z.string().min(1), project_id: z.string().min(1),
  sequence: z.number().int().optional(), min_sequence: z.number().int().optional(),
}, wrap(async (a) => (await import("./learningEngine.js")).runLearningNow(a)));
s.tool("learning_explain", {
  project_id: z.string().min(1), learning_id: z.string().uuid().optional(), pattern_id: z.string().uuid().optional(),
}, wrap(async (a) => (await import("./learningEngine.js")).learningExplain(a)));
s.tool("learning_advice", {
  project_id: z.string().min(1), query: z.string().default(""), limit: z.number().int().min(1).max(20).default(8),
}, wrap(async (a) => (await import("./learningEngine.js")).learningAdvice(a)));
s.tool("learning_maintenance", {
  project_id: z.string().min(1), apply: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./learningEngine.js")).learningMaintenance(a)));
s.tool("learning_feedback_record", {
  project_id: z.string().min(1), verdict: z.enum(["confirmed", "corrected", "rejected", "outdated"]),
  learning_id: z.string().uuid().optional(), pattern_id: z.string().uuid().optional(),
  session_id: z.string().optional(), explicit_feedback: z.boolean().default(false),
  reason: z.string().default(""), evidence: z.array(z.string()).default([]),
}, wrap(async (a) => (await import("./learningPipeline.js")).recordFeedback(a)));
s.tool("learning_feedback_apply", {
  feedback_id: z.number().int().positive(), project_id: z.string().min(1), actor: z.string().default("operator"),
}, wrap(async (a) => (await import("./learningPipeline.js")).applyFeedback(a)));
s.tool("learning_patterns", {
  project_id: z.string().min(1), kind: z.string().optional(), status: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./learningIntelligence.js")).getPatterns(a)));
s.tool("learning_records", {
  project_id: z.string().min(1), category: z.string().optional(), status: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./learningExperience.js")).getLearningExperiences(a)));
s.tool("learning_pipeline_status", {
  project_id: z.string().min(1), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./learningPipeline.js")).learningPipelineStatus(a)));
s.tool("learning_pipeline_retry", { limit: z.number().int().min(1).max(100).default(20) },
  wrap(async (a) => (await import("./learningPipeline.js")).retryLearningPipeline(a)));

// Phase 20 — memory lifecycle. Reads are inspection-only; state changes require explicit flags.
s.tool("memory_lifecycle_status", { project_id: z.string().min(1), memory_id: z.string().uuid() },
  wrap(async (a) => (await import("./memoryLifecycle.js")).getLifecycleStatus({ project_id: a.project_id, memory_id: a.memory_id })));
s.tool("memory_lifecycle_maintenance", {
  project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50),
  apply: z.boolean().default(false), actor: z.string().default("operator"),
}, wrap(async (a) => (await import("./memoryLifecycle.js")).runLifecycleMaintenance({ ...a, dry_run: !a.apply })));
s.tool("memory_lifecycle_report", { project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => (await import("./memoryLifecycle.js")).lifecycleMaintenanceStatus(a)));
s.tool("memory_version_history", { project_id: z.string().min(1), memory_id: z.string().uuid() },
  wrap(async (a) => (await import("./memoryRecovery.js")).getVersionHistory({ memory_id: a.memory_id, project_id: a.project_id })));
s.tool("memory_restore_version", {
  project_id: z.string().min(1), memory_id: z.string().uuid(), version: z.number().int().positive(),
  explicit: z.boolean().default(false), actor: z.string().default("operator"), reason: z.string().default(""),
}, wrap(async (a) => (await import("./memoryRecovery.js")).restoreVersion(a)));
s.tool("memory_archive_safe", {
  project_id: z.string().min(1), memory_id: z.string().uuid(), reason: z.string().default(""),
  override: z.boolean().default(false), actor: z.string().default("operator"),
}, wrap(async (a) => (await import("./memoryRecovery.js")).archiveMemorySafe(a)));
s.tool("memory_restore_archived", { project_id: z.string().min(1), memory_id: z.string().uuid(), actor: z.string().default("operator") },
  wrap(async (a) => (await import("./memoryRecovery.js")).restoreArchived(a)));
s.tool("memory_importance_explain", { project_id: z.string().min(1), memory_id: z.string().uuid() },
  wrap(async (a) => (await import("./memoryImportance.js")).explainImportance(a)));
s.tool("memory_freshness_list", {
  project_id: z.string().min(1), memory_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(200).default(50),
}, wrap(async (a) => (await import("./memoryImportance.js")).getFreshnessReviews(a)));
s.tool("memory_consolidation_candidates", { project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => (await import("./memoryConsolidation.js")).findCandidates(a)));
s.tool("memory_contradictions_list", { project_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) },
  wrap(async (a) => (await import("./memoryConsolidation.js")).reviewContradictions(a)));

// Phase 19 — structured session understanding and continuity (read-only unless explicit).
s.tool("session_understanding_run", {
  session_id: z.string().min(1), project_id: z.string().min(1),
  sequence: z.number().int().optional(), min_sequence: z.number().int().optional(),
}, wrap(async (a) => (await import("./sessionUnderstanding.js")).runSessionUnderstanding(a)));
s.tool("session_continuity_get", {
  project_id: z.string().min(1), goal_id: z.string().optional(), limit: z.number().int().min(1).max(100).default(20),
}, wrap(async (a) => a.goal_id
  ? (await import("./developmentGoal.js")).getGoals({ project_id: a.project_id, limit: a.limit })
  : (await import("./developmentGoal.js")).getGoalContinuity(a)));
s.tool("session_experiences_search", {
  project_id: z.string().min(1), query: z.string().default(""),
  debugging: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20),
}, wrap(async (a) => a.debugging
  ? (await import("./debuggingExperience.js")).getDebuggingExperiences({ project_id: a.project_id,
      problem_query: a.query, limit: a.limit })
  : (await import("./experienceStore.js")).getExperiences({ project_id: a.project_id, limit: a.limit })));

// Phase 18 — automatic lifecycle integration. `context_inject` runs the same path the
// plugin uses on every prompt; the other two expose diagnostics/task classification.
s.tool("context_inject", {
  project_id: z.string().min(1), session_id: z.string().optional(),
  query: z.string().default(""), budget_chars: z.number().int().min(200).max(60000).default(4000),
}, wrap(async (a) => prepareContext({ project_id: a.project_id, session_id: a.session_id || null,
  query: a.query, budget_chars: a.budget_chars })));
s.tool("context_task_classify", { query: z.string().default(""), project_id: z.string().optional(), session_id: z.string().optional() },
  wrap(async (a) => (await import("./taskClassifier.js")).classifyTask(a)));
s.tool("context_injection_report", {
  project_id: z.string().min(1), session_id: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
}, wrap(async (a) => (await import("./injectionAudit.js")).injectionReport(a)));
s.tool("context_project_get", { project_id: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) },
  wrap(async (a) => contextIntel.getProjectContext(a)));
s.tool("context_project_upsert", {
  project_id: z.string().min(1),
  facts: z.array(z.object({
    key: z.string().min(1), value: z.unknown(), status: z.string().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    evidence: z.array(z.string()).optional(), source: z.string().optional(),
  })).default([]),
  summary: z.string().optional(), source: z.string().optional(), source_session: z.string().optional(),
}, wrap(async (a) => contextIntel.upsertProjectContext(a)));
s.tool("context_decisions_search", {
  project_id: z.string().min(1), query: z.string().default(""),
  status: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
}, wrap(async (a) => decisionIntel.getDecisions(a)));
s.tool("context_decision_record", {
  project_id: z.string().min(1), title: z.string().min(1),
  description: z.string().default(""), reasoning: z.string().default(""),
  alternatives: z.array(z.string()).default([]), consequences: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]), confidence: z.number().min(0).max(1).nullable().optional(),
  source_session: z.string().optional(), supersedes: z.string().optional(),
}, wrap(async (a) => decisionIntel.recordDecision(a)));
s.tool("context_relationship_get", {
  project_id: z.string().min(1), subject_type: z.string().min(1), subject_id: z.string().min(1),
  direction: z.enum(["source", "target", "both"]).default("both"),
  relation_type: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
}, wrap(async (a) => relationshipIntel.getRelationships(a)));
s.tool("context_quality_get", {
  project_id: z.string().min(1), subject_type: z.string().min(1), subject_id: z.string().min(1),
}, wrap(async (a) => knowledgeQuality.getQuality(a)));
s.tool("context_retrieve_task", {
  project_id: z.string().min(1), query: z.string().default(""), session_id: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(8), budget_chars: z.number().int().min(200).max(12000).default(4000),
}, wrap(async (a) => contextRetrieval.retrieveTaskContext(a)));
s.tool("context_update_status", {
  project_id: z.string().min(1), status: z.string().optional(), limit: z.number().int().min(1).max(100).default(50),
}, wrap(async (a) => contextUpdate.contextUpdateStatus(a)));
s.tool("context_update_run", {
  project_id: z.string().min(1), session_id: z.string().min(1), sequence: z.number().int().optional(),
  min_sequence: z.number().int().optional(),
  transcript_lines: z.array(z.object({ role: z.string(), text: z.string(), tool: z.string().optional() })).optional(),
}, wrap(async (a) => contextUpdate.runContextUpdate(a)));
s.tool("context_audit", {}, wrap(async () => {
  const wiring = pipelineAudit.auditPipelineIntegrity();
  return { ok: wiring.ok, summary: wiring.summary, phase17: wiring.sources.phase17 };
}));

void recoverIfDue().catch((e) => console.error(`[opencode-memory] startup recovery error: ${String(e?.message || e)}`));

await s.connect(new StdioServerTransport());
