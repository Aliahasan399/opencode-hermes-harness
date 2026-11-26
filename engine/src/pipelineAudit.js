// Read-only architecture / dependency-map audit for the automatic session-understanding
// pipeline. This module NEVER writes to files or to the database. It inspects source
// files with fs.readFileSync and reads DB state with SELECT-only queries.
//
// IMPORTANT LIMITATION: source inspection proves only that code is *wired* (present and
// referenced). It does not prove that a feature works at runtime. Every result therefore
// carries an explicit no-runtime-claim notice; runtime evidence comes only from the DB
// processing audit (auditRecentProcessing).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(SRC_DIR, "..");
const MEMORY_ROOT = path.resolve(ENGINE_DIR, "..");
const PLUGIN_REL = "plugin/memory.ts";
const AUTOMATION_REL = "src/automation.js";

export const WIRING_SCOPE = "wiring-presence-only";
export const NO_RUNTIME_CLAIM = [
  "Source inspection shows where code is wired; it does not prove the feature runs correctly.",
  "Runtime evidence comes only from DB processing state (auditRecentProcessing), never from wiring alone.",
].join(" ");

const STAGE_IDS = [
  "learning", "understanding", "patterns", "strategy", "context_update", "session_understanding", "learning_pipeline", "semantic_understanding",
  "error_learning", "outcome_capture", "retrieval_feedback", "consolidation_triage",
  "outcome_link", "improvement_report", "intelligence_report",
];

// --- low-level read-only helpers -----------------------------------------

function resolveRel(rel) {
  // "src/*" paths are relative to the engine dir; everything else (e.g. plugin/*)
  // is relative to the memory root.
  return rel.startsWith("src/") ? path.join(ENGINE_DIR, rel) : path.join(MEMORY_ROOT, rel);
}

function readSource(rel) {
  const abs = resolveRel(rel);
  try {
    const source = fs.readFileSync(abs, "utf8");
    return { ok: true, source, rel, abs, bytes: source.length, error: null };
  } catch (e) {
    return { ok: false, source: "", rel, abs, bytes: 0, error: String(e?.message || e) };
  }
}

function exportRegex(name) {
  // Matches: export function f, export async function f, export const f
  return new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`);
}

// Verify that claimed exports / literal tokens actually exist in the source file.
function inspectModule(rel, fnNames = [], tokens = []) {
  const r = readSource(rel);
  const functions = fnNames.map((name) => ({
    name,
    present: r.ok && exportRegex(name).test(r.source),
  }));
  const tokenChecks = tokens.map((name) => ({
    name,
    present: r.ok && r.source.includes(name),
  }));
  const missingFunctions = functions.filter((f) => !f.present).map((f) => f.name);
  const missingTokens = tokenChecks.filter((t) => !t.present).map((t) => t.name);
  return {
    file: rel,
    exists: r.ok,
    error: r.error,
    functions,
    tokens: tokenChecks,
    verifiedFunctions: functions.filter((f) => f.present).map((f) => f.name),
    missingFunctions,
    missingTokens,
    verified: r.ok && missingFunctions.length === 0 && missingTokens.length === 0,
  };
}

function declaredStages() {
  const r = readSource(AUTOMATION_REL);
  if (!r.ok) return [];
  const out = new Set();
  const re = /result\.stages\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(r.source))) out.add(m[1]);
  return [...out];
}

// --- 1. pipelineDependencyMap ---------------------------------------------

export function pipelineDependencyMap() {
  const chain = [
    "transcript", "understanding", "knowledge_extraction", "memory",
    "learning", "retrieval", "future_decisions",
  ];

  const definitions = {
    transcript: {
      label: "Durable transcript capture",
      role: "Append-only session record written by the plugin's prompt/tool/event hooks via the CLI.",
      modules: [
        { rel: "src/transcript.js", fns: ["appendLine", "readLines", "transcriptText", "lastSequence", "listDurableSessions", "auditTranscriptRecovery"] },
        { rel: PLUGIN_REL, tokens: ["transcript-append", "durableAppend"] },
        { rel: "src/cli.js", tokens: ["transcript-append", "transcript-read"] },
      ],
    },
    understanding: {
      label: "Role-aware and semantic understanding",
      role: "Reads original session records / durable transcript and derives role-labelled lines and observations.",
      modules: [
        { rel: "src/roles.js", fns: ["extractSession", "classifyText", "languageOf", "enrichSessionSummaries", "rawSession"] },
        { rel: "src/semanticUnderstanding.js", fns: ["analyzeSession", "listObservations", "semanticCoverage"] },
        { rel: AUTOMATION_REL, fns: ["runTurnEnd"], tokens: ["result.stages.understanding", "semanticAnalyze"] },
      ],
    },
    knowledge_extraction: {
      label: "Knowledge / candidate extraction",
      role: "Turns understood lines into memory candidates, patterns, error fingerprints and observed outcomes.",
      modules: [
        { rel: "src/learn.js", fns: ["learnFromTranscript"] },
        { rel: "src/patterns-v2.js", fns: ["analyzeQuality", "patternQuality"] },
        { rel: "src/errorLearning.js", fns: ["analyzeSessionErrors", "fingerprint", "recordFailure", "recordFix", "observeRecurrence"] },
        { rel: "src/learning10.js", fns: ["captureOutcomes", "linkOutcomesToExperiments", "classifyOutcome"] },
      ],
    },
    memory: {
      label: "Memory storage, scoping and governance",
      role: "Persists candidates as memories and applies duplicate detection, scope, authorization and consolidation.",
      modules: [
        { rel: "src/core.js", fns: ["saveMemory", "findDuplicate", "searchMemory", "listMemories", "projectContext", "compactContext"] },
        { rel: "src/memoryScope.js", fns: ["scopeFilter", "filterMemoryResults", "memoryAccessGuard", "isGloballyEligible"] },
        { rel: "src/memoryAuthorization.js", fns: ["authorizeMemoryAccess", "auditAccessDecision", "authorizeRelationshipTraversal"] },
        { rel: "src/memoryGovernance.js", fns: ["classifyGlobalMemories", "proposeScopeCorrections", "approveScopeReview"] },
        { rel: "src/consolidation.js", fns: ["triageSuggestions", "applyApprovedConsolidation", "rollbackConsolidation"] },
      ],
    },
    learning: {
      label: "Learning, feedback and strategy evidence",
      role: "Records tool observations, usefulness signals, experiments and self-improvement evidence.",
      modules: [
        { rel: "src/strategy.js", fns: ["recordObservation", "evaluateStrategies", "observationStats"] },
        { rel: "src/retrievalFeedback.js", fns: ["observeUsage", "explicitFeedback", "usefulnessSummary"] },
        { rel: "src/usefulnessSignals.js", fns: ["observeErrorNonRecurrence", "usefulnessSignalSummary"] },
        { rel: "src/learning10.js", fns: ["createExperiment", "addExperimentResult", "compareStrategies", "selfImprovementReport", "strategyLifecycle"] },
      ],
    },
    retrieval: {
      label: "Retrieval and context packaging",
      role: "Hybrid search, adaptive ranking and compact context assembly for future prompts.",
      modules: [
        { rel: "src/core.js", fns: ["searchMemory", "sessionSearch", "projectContext", "compactContext"] },
        { rel: "src/adaptiveRetrieval.js", fns: ["adaptiveRetrieve", "rankMemories"] },
        { rel: "src/contextPackage.js", fns: ["prepareContext"] },
      ],
    },
    future_decisions: {
      label: "Future decisions / downstream consumers",
      role: "Retrieved context is injected into prompts; recommendations and decisions are gated and recorded.",
      modules: [
        { rel: PLUGIN_REL, tokens: ["context-package", 'session.hook("context"', "Relevant memory (retrieved automatically)"] },
        { rel: "src/optimizer.js", fns: ["recommendStrategy", "decideRecommendation", "prepareAction", "recordActionResult"] },
        { rel: "src/memoryAuthorization.js", fns: ["authorizeMemoryAccess", "auditAccessDecision"] },
        { rel: "src/server.js", tokens: ["automation_run", "context_prepare", "memory_adaptive_search", "optimizer_decide"] },
        { rel: "src/cli.js", tokens: ["context-package", "automate"] },
      ],
    },
  };

  const nodes = {};
  for (const id of chain) {
    const d = definitions[id];
    const modules = d.modules.map((m) => inspectModule(m.rel, m.fns || [], m.tokens || []));
    nodes[id] = {
      id,
      label: d.label,
      role: d.role,
      modules,
      allVerified: modules.every((m) => m.verified),
    };
  }

  const edges = [
    { from: "transcript", to: "understanding", via: "src/roles.js:extractSession + automation.js:runTurnEnd (understanding stage)", evidence: "readLines / transcriptText feed understanding" },
    { from: "understanding", to: "knowledge_extraction", via: "src/roles.js:classifyText + src/learn.js:learnFromTranscript", evidence: "kind-labelled lines become memory candidates" },
    { from: "knowledge_extraction", to: "memory", via: "src/learn.js:learnFromTranscript + src/core.js:saveMemory/findDuplicate", evidence: "candidates persisted as non-verified memories" },
    { from: "memory", to: "learning", via: "src/strategy.js:evaluateStrategies + src/learning10.js:recordOutcome", evidence: "stored memories and observations feed experiments" },
    { from: "learning", to: "retrieval", via: "src/retrievalFeedback.js:observeUsage + src/adaptiveRetrieval.js:adaptiveRetrieve", evidence: "usage observations inform ranking/context" },
    { from: "retrieval", to: "future_decisions", via: "plugin context hook + src/contextPackage.js:prepareContext + src/optimizer.js:decideRecommendation", evidence: "context injected into prompts; decisions gated" },
    { from: "plugin", to: "transcript", via: "plugin/memory.ts:durableAppend -> cli.js:transcript-append -> transcript.js:appendLine", evidence: "prompt/tool/event hooks append durable lines" },
    { from: "plugin", to: "orchestration", via: "plugin/memory.ts -> cli.js:automate --durable -> automation.js:runTurnEnd", evidence: "coalesced turn-end triggers the stage pipeline" },
  ];

  return {
    scope: "read-only source inspection",
    claim: NO_RUNTIME_CLAIM,
    generatedAt: new Date().toISOString(),
    chain,
    nodes,
    edges,
    orchestrator: inspectModule(
      AUTOMATION_REL,
      ["runTurnEnd", "recoverAutomation", "retryPending", "recoverIfDue", "recoverEvents"],
      ["turn_end_orchestration", "claim("],
    ),
    entryPoints: {
      plugin: inspectModule(PLUGIN_REL, [], ["ctx.event.subscribe", "session.idle", "COALESCE_MS", "--durable", "automation-recover-if-due"]),
      cli: inspectModule("src/cli.js", [], ["automate", "context-package", "automation-recover-events"]),
      server: inspectModule("src/server.js", [], ["automation_run", "automation_retry", "context_prepare"]),
    },
    declaredStages: declaredStages(),
  };
}

// --- 2. auditPipelineIntegrity -------------------------------------------

export function auditPipelineIntegrity() {
  const plugin = readSource(PLUGIN_REL);
  const automation = readSource(AUTOMATION_REL);
  const checks = [];

  function add({ id, category, file, src, description, tokens = [], regexes = [] }) {
    const matched = [];
    let ok = src.ok;
    for (const t of tokens) {
      if (src.ok && src.source.includes(t)) matched.push(t);
      else ok = false;
    }
    for (const r of regexes) {
      if (src.ok && r.test(src.source)) matched.push(r.source);
      else ok = false;
    }
    const expected = [...tokens, ...regexes.map((r) => r.source)];
    const absent = expected.filter((e) => !matched.includes(e));
    checks.push({
      id,
      category,
      file,
      description,
      ok,
      present: ok,
      missing: !ok,
      evidence: matched,
      detail: ok
        ? "wiring tokens found in source (presence only, not runtime verification)"
        : src.ok
          ? `expected wiring tokens not found: ${absent.join(" | ")}`
          : `source unreadable: ${src.error}`,
    });
  }

  // Plugin-side wiring.
  add({ id: "plugin.prompt-hook", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Prompt hook captures user text and triggers context packaging.",
    regexes: [/session\.hook\(\s*["']prompt["']/, /context-package/] });
  add({ id: "plugin.context-hook", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Context hook injects retrieved memory into the system prompt.",
    regexes: [/session\.hook\(\s*["']context["']/], tokens: ["Relevant memory (retrieved automatically)"] });
  add({ id: "plugin.tool-before-hook", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Tool execute.before hook records start times.",
    regexes: [/tool\.hook\(\s*["']execute\.before["']/] });
  add({ id: "plugin.tool-after-hook", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Tool execute.after hook records tool text and observations.",
    regexes: [/tool\.hook\(\s*["']execute\.after["']/], tokens: ["observe", "durableAppend"] });
  add({ id: "plugin.event-subscription", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Plugin subscribes to the harness event stream.",
    tokens: ["ctx.event.subscribe", "session.step.ended"] });
  add({ id: "plugin.turn-end-coalescing", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Turn-end events are coalesced before automation runs.",
    tokens: ["session.idle", "session.execution.", "COALESCE_MS", "setTimeout", "processedSeq"] });
  add({ id: "plugin.durable-append", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Captured lines are appended to the durable transcript.",
    tokens: ["transcript-append", "durableAppend"] });
  // Phase 16: turn-end runs the pipeline with the plugin's synchronous in-memory
  // transcript over stdin (with --seq), after a durable-write flush. Verify that
  // equivalent path; the durable append path stays covered by plugin.durable-append.
  add({ id: "plugin.turn-end-automate", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Coalesced turn end invokes the stage pipeline with a complete transcript.",
    tokens: ["automate", "--stdin", "flushAppends", "inMemory.join"],
    regexes: [/scheduleTurnEnd/] });
  add({ id: "plugin.startup-recovery", category: "plugin", file: PLUGIN_REL, src: plugin,
    description: "Startup triggers idempotent automation recovery.",
    tokens: ["automation-recover-if-due"] });

  // Automation-side stage wiring.
  for (const stage of STAGE_IDS) {
    add({
      id: `automation.stage-${stage}`,
      category: "automation",
      file: AUTOMATION_REL,
      src: automation,
      description: `runTurnEnd assigns the '${stage}' stage result.`,
      regexes: [new RegExp(`result\\.stages\\.${stage}\\s*=`)],
    });
  }
  add({ id: "automation.claim-dedupe", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Events are claimed with ON CONFLICT and deduplicated by sequence/hash.",
    tokens: ["ON CONFLICT (session_id,event_id)", "duplicate: true", "out_of_order"] });
  add({ id: "automation.startup-recovery", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Stale claims reset and durable transcripts are recovered at startup.",
    regexes: [/export async function recoverAutomation/] });
  add({ id: "automation.retry-pending", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Pending/failed events can be retried.",
    regexes: [/export async function retryPending/] });
  add({ id: "automation.recover-if-due", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Recovery is rate-limited via harness_state.",
    regexes: [/export async function recoverIfDue/] });
  add({ id: "automation.recover-events", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Event-level recovery supersedes stale sequences.",
    regexes: [/export async function recoverEvents/] });
  add({ id: "automation.audit-trail", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "Turn-end orchestration is written to the intelligence audit trail.",
    tokens: ["turn_end_orchestration"] });
  add({ id: "automation.llm-additive", category: "automation", file: AUTOMATION_REL, src: automation,
    description: "LLM analysis is opt-in and never gates deterministic stages.",
    tokens: ["allow_llm", "never blocks or replaces"] });

  // --- Phase 17 contextual-intelligence wiring (presence only) ----------------
  const p17 = {
    contextIntel: readSource("src/contextIntel.js"),
    decisionIntel: readSource("src/decisionIntel.js"),
    relationshipIntel: readSource("src/relationshipIntel.js"),
    contextRetrieval: readSource("src/contextRetrieval.js"),
    knowledgeQuality: readSource("src/knowledgeQuality.js"),
    contextUpdate: readSource("src/contextUpdate.js"),
    cli: readSource("src/cli.js"),
    server: readSource("src/server.js"),
  };
  add({ id: "p17.project-context", category: "contextual", file: "src/contextIntel.js", src: p17.contextIntel,
    description: "Project context facts are stored with provenance and isolation.",
    tokens: ["upsertProjectContext", "getProjectContext", "project_context_fact"] });
  add({ id: "p17.decisions", category: "contextual", file: "src/decisionIntel.js", src: p17.decisionIntel,
    description: "Technical decisions preserve history and support superseding.",
    tokens: ["recordDecision", "getDecisions", "supersedeDecision", "technical_decision"] });
  add({ id: "p17.relationships", category: "contextual", file: "src/relationshipIntel.js", src: p17.relationshipIntel,
    description: "Evidence-based, bounded, project-scoped relationships exist.",
    tokens: ["createRelationship", "getRelationships", "knowledge_relationship"] });
  add({ id: "p17.context-retrieval", category: "contextual", file: "src/contextRetrieval.js", src: p17.contextRetrieval,
    description: "Unified context retrieval combines adaptive retrieval with new context and degrades gracefully.",
    tokens: ["retrieveTaskContext", "adaptiveRetrieve", "degraded", "budget_chars"] });
  add({ id: "p17.knowledge-quality", category: "contextual", file: "src/knowledgeQuality.js", src: p17.knowledgeQuality,
    description: "Verification status is separate from confidence and never auto-promotes inference.",
    tokens: ["recordQuality", "detectConflict", "freshnessReport", "knowledge_quality"] });
  add({ id: "p17.continuous-updates", category: "contextual", file: "src/contextUpdate.js", src: p17.contextUpdate,
    description: "Durable transcripts drive idempotent, bounded context updates.",
    tokens: ["runContextUpdate", "retryContextUpdates", "context_update", "min_sequence"] });
  add({ id: "p17.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Phase 17 capabilities are exposed through the CLI.",
    tokens: ["context-project", "context-decisions", "context-retrieve", "context-audit"] });
  add({ id: "p17.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Phase 17 capabilities are exposed through MCP tools.",
    tokens: ["context_project_get", "context_decisions_search", "context_retrieve_task", "context_audit"] });

  // --- Phase 18 automatic lifecycle wiring (presence only) --------------------
  const p18 = {
    taskClassifier: readSource("src/taskClassifier.js"),
    contextRanker: readSource("src/contextRanker.js"),
    injectionBudget: readSource("src/injectionBudget.js"),
    injectionAudit: readSource("src/injectionAudit.js"),
    contextPackage: readSource("src/contextPackage.js"),
  };
  add({ id: "p18.task-classifier", category: "automatic", file: "src/taskClassifier.js", src: p18.taskClassifier,
    description: "Deterministic task classification informs retrieval.",
    tokens: ["classifyTask", "CATEGORIES"] });
  add({ id: "p18.context-ranker", category: "automatic", file: "src/contextRanker.js", src: p18.contextRanker,
    description: "Ranking filters by quality, isolation and task relevance.",
    tokens: ["rankAndFilter", "SCORING_RULES"] });
  add({ id: "p18.injection-budget", category: "automatic", file: "src/injectionBudget.js", src: p18.injectionBudget,
    description: "Injected context is budgeted and structured.",
    tokens: ["formatInjection", "budgetForModel"] });
  add({ id: "p18.injection-audit", category: "automatic", file: "src/injectionAudit.js", src: p18.injectionAudit,
    description: "Every injection is audited with content-free metadata.",
    tokens: ["recordInjection", "injectionReport"] });
  add({ id: "p18.lifecycle-integration", category: "automatic", file: "src/contextPackage.js", src: p18.contextPackage,
    description: "prepareContext drives the automatic retrieval/rank/format/audit path.",
    tokens: ["retrieveTaskContext", "classifyTask", "rankAndFilter", "formatInjection", "recordInjection"] });
  add({ id: "p18.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Automatic injection is available through the CLI.",
    tokens: ["context-inject", "context-task", "context-injection-report"] });
  add({ id: "p18.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Automatic injection is available through MCP.",
    tokens: ["context_inject", "context_task_classify", "context_injection_report"] });

  // --- Phase 19 session-understanding wiring (presence only) ------------------
  const p19 = {
    sessionExperience: readSource("src/sessionExperience.js"),
    developmentGoal: readSource("src/developmentGoal.js"),
    debuggingExperience: readSource("src/debuggingExperience.js"),
    experienceStore: readSource("src/experienceStore.js"),
    sessionUnderstanding: readSource("src/sessionUnderstanding.js"),
  };
  add({ id: "p19.session-experience", category: "understanding", file: "src/sessionExperience.js", src: p19.sessionExperience,
    description: "Sessions are understood as connected, evidence-graded events.",
    tokens: ["analyzeSessionExperience", "classifyChange", "CHANGE_STATES"] });
  add({ id: "p19.development-goal", category: "understanding", file: "src/developmentGoal.js", src: p19.developmentGoal,
    description: "Goals and evidence-backed task continuity are maintained.",
    tokens: ["extractGoalCandidates", "recordTask", "canMarkComplete"] });
  add({ id: "p19.debugging-experience", category: "understanding", file: "src/debuggingExperience.js", src: p19.debuggingExperience,
    description: "Debugging processes become graded reusable experiences.",
    tokens: ["analyzeDebugging", "recordDebuggingExperience", "root_cause_status"] });
  add({ id: "p19.experience-store", category: "understanding", file: "src/experienceStore.js", src: p19.experienceStore,
    description: "Experiences are deduplicated and consolidated without losing provenance.",
    tokens: ["recordExperience", "consolidateExperiences", "markExperienceStale"] });
  add({ id: "p19.orchestrator", category: "understanding", file: "src/sessionUnderstanding.js", src: p19.sessionUnderstanding,
    description: "An idempotent orchestrator drives session understanding at turn end.",
    tokens: ["runSessionUnderstanding", "session_understanding", "retrySessionUnderstanding"] });

  // --- Phase 20 memory lifecycle wiring (presence only) ----------------------
  const p20 = {
    orchestrator: readSource("src/memoryLifecycle.js"),
    importance: readSource("src/memoryImportance.js"),
    consolidation: readSource("src/memoryConsolidation.js"),
    recovery: readSource("src/memoryRecovery.js"),
  };
  add({ id: "p20.lifecycle-orchestrator", category: "lifecycle", file: "src/memoryLifecycle.js", src: p20.orchestrator,
    description: "Bounded, advisory lifecycle maintenance with project scope.",
    tokens: ["runLifecycleMaintenance", "getLifecycleStatus", "dry_run"] });
  add({ id: "p20.importance-freshness", category: "lifecycle", file: "src/memoryImportance.js", src: p20.importance,
    description: "Importance and freshness are explainable and separate from verification.",
    tokens: ["recordSignal", "reviewFreshness", "explainImportance"] });
  add({ id: "p20.consolidation", category: "lifecycle", file: "src/memoryConsolidation.js", src: p20.consolidation,
    description: "Consolidation proposals preserve provenance and never auto-merge.",
    tokens: ["findCandidates", "proposeConsolidation", "reviewContradictions"] });
  add({ id: "p20.recovery", category: "lifecycle", file: "src/memoryRecovery.js", src: p20.recovery,
    description: "Versions/archives are recoverable with explicit authorization and audit.",
    tokens: ["restoreVersion", "archiveMemorySafe", "restoreArchived"] });
  add({ id: "p20.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Lifecycle operations are available through the CLI.",
    tokens: ["memory-lifecycle-status", "memory-version-history", "memory-restore-version"] });
  add({ id: "p20.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Lifecycle operations are available through MCP.",
    tokens: ["memory_lifecycle_status", "memory_version_history", "memory_restore_version"] });

  // --- Phase 21 continuous-learning wiring (presence only) -------------------
  const p21 = {
    engine: readSource("src/learningEngine.js"),
    experience: readSource("src/learningExperience.js"),
    intelligence: readSource("src/learningIntelligence.js"),
    integration: readSource("src/learningIntegration.js"),
    pipeline: readSource("src/learningPipeline.js"),
  };
  add({ id: "p21.engine", category: "learning", file: "src/learningEngine.js", src: p21.engine,
    description: "A project-scoped facade exposes learning capabilities.",
    tokens: ["learningStatus", "runLearningNow", "learningExplain", "learningAdvice"] });
  add({ id: "p21.experience", category: "learning", file: "src/learningExperience.js", src: p21.experience,
    description: "Experiences are extracted idempotently from session understanding.",
    tokens: ["extractExperiences", "recordLearningExperience", "getLearningExperiences"] });
  add({ id: "p21.intelligence", category: "learning", file: "src/learningIntelligence.js", src: p21.intelligence,
    description: "Outcomes, patterns and confidence are evidence-backed and explainable.",
    tokens: ["analyzeOutcome", "calculateConfidence", "detectPatterns"] });
  add({ id: "p21.integration", category: "learning", file: "src/learningIntegration.js", src: p21.integration,
    description: "Learning consolidates via lifecycle and feeds existing retrieval.",
    tokens: ["consolidateLearning", "learningContextItems", "explainLearning"] });
  add({ id: "p21.pipeline", category: "learning", file: "src/learningPipeline.js", src: p21.pipeline,
    description: "Feedback and an idempotent, recoverable pipeline drive continuous learning.",
    tokens: ["recordFeedback", "applyFeedback", "runLearningPipeline", "retryLearningPipeline"] });
  add({ id: "p21.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Learning operations are available through the CLI.",
    tokens: ["learning-status", "learning-run", "learning-explain", "learning-pipeline-retry"] });
  add({ id: "p21.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Learning operations are available through MCP.",
    tokens: ["learning_status", "learning_run", "learning_explain", "learning_advice"] });

  // --- Phase 22 agent orchestration wiring (presence only) -------------------
  const p22 = {
    orchestrator: readSource("src/agentOrchestrator.js"),
    decomposition: readSource("src/taskDecomposition.js"),
    registry: readSource("src/agentRegistry.js"),
    coordination: readSource("src/agentCoordination.js"),
    context: readSource("src/agentContext.js"),
    conflicts: readSource("src/agentConflicts.js"),
    validation: readSource("src/agentValidation.js"),
    integration: readSource("src/agentIntegration.js"),
    workflow: readSource("src/agentWorkflowLearning.js"),
  };
  add({ id: "p22.orchestrator", category: "agent", file: "src/agentOrchestrator.js", src: p22.orchestrator,
    description: "Planning/coordination facade without a competing agent runtime.",
    tokens: ["orchestrate", "planStatus", "orchestrationReport", "resumePlan"] });
  add({ id: "p22.decomposition", category: "agent", file: "src/taskDecomposition.js", src: p22.decomposition,
    description: "Task graphs with dependency validation and idempotent persistence.",
    tokens: ["decomposeTask", "validateTaskGraph", "savePlan"] });
  add({ id: "p22.selection", category: "agent", file: "src/agentRegistry.js", src: p22.registry,
    description: "Agents are discovered from actual OpenCode config and selected deterministically.",
    tokens: ["discoverAgents", "selectAgents", "cli_agent_supported"] });
  add({ id: "p22.coordination", category: "agent", file: "src/agentCoordination.js", src: p22.coordination,
    description: "Dependency-aware claiming, recovery and bounded parallel execution.",
    tokens: ["claimTask", "completeTask", "failTask", "retryFailed"] });
  add({ id: "p22.context-conflicts", category: "agent", file: "src/agentContext.js", src: p22.context,
    description: "Project-scoped context supply with a supplied-item ledger.",
    tokens: ["prepareAgentContext", "agent_context_ledger"] });
  add({ id: "p22.validation", category: "agent", file: "src/agentValidation.js", src: p22.validation,
    description: "Agent claims require evidence before acceptance.",
    tokens: ["validateTaskResult", "recordReview"] });
  add({ id: "p22.workflow-learning", category: "agent", file: "src/agentWorkflowLearning.js", src: p22.workflow,
    description: "Workflow outcomes feed the existing Phase 21 learning engine.",
    tokens: ["recordWorkflowExperience", "agentPerformance"] });
  add({ id: "p22.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Orchestration operations are available through the CLI.",
    tokens: ["agent-plan", "agent-plan-status", "agent-claim", "agent-validate"] });
  add({ id: "p22.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Orchestration operations are available through MCP.",
    tokens: ["agent_plan_create", "agent_plan_status", "agent_task_claim", "agent_result_validate"] });

  // --- Phase 23 proactive project intelligence wiring (presence only) -------
  const p23 = {
    facade: readSource("src/projectIntelligence.js"),
    health: readSource("src/projectHealth.js"),
    debt: readSource("src/technicalDebt.js"),
    risk: readSource("src/projectRisk.js"),
    testQuality: readSource("src/testQuality.js"),
    deps: readSource("src/dependencyRisk.js"),
    recommendations: readSource("src/recommendationEngine.js"),
    roadmap: readSource("src/engineeringRoadmap.js"),
  };
  add({ id: "p23.facade", category: "intelligence", file: "src/projectIntelligence.js", src: p23.facade,
    description: "Incremental analysis and bounded unified reports without applying changes.",
    tokens: ["analyzeProject", "projectReport", "prepareEngineeringTasks", "project_analysis_state"] });
  add({ id: "p23.health", category: "intelligence", file: "src/projectHealth.js", src: p23.health,
    description: "Health assessments are evidence-backed and mark unknowns explicitly.",
    tokens: ["analyzeProjectHealth", "SCORING_RULES", "unknown_areas"] });
  add({ id: "p23.debt-risk", category: "intelligence", file: "src/technicalDebt.js", src: p23.debt,
    description: "Debt findings require evidence and preserve resolution history.",
    tokens: ["detectDebt", "recordFinding", "updateFindingStatus"] });
  add({ id: "p23.prediction", category: "intelligence", file: "src/projectRisk.js", src: p23.risk,
    description: "Predictions are conservative and never claim certainty.",
    tokens: ["predictFragility", "recordPrediction", "insufficient_evidence"] });
  add({ id: "p23.quality-deps", category: "intelligence", file: "src/testQuality.js", src: p23.testQuality,
    description: "Test gaps and dependency risks are evidence-backed without invented coverage or vulnerabilities.",
    tokens: ["analyzeTestQuality", "GAP_RULES", "analyzeDependencies"] });
  add({ id: "p23.recommendations", category: "intelligence", file: "src/recommendationEngine.js", src: p23.recommendations,
    description: "Recommendations are prioritized, lifecycle-managed and never auto-applied.",
    tokens: ["buildRecommendations", "PRIORITY_RULES", "updateRecommendationStatus"] });
  add({ id: "p23.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Project intelligence is available through the CLI.",
    tokens: ["project-intelligence-analyze", "project-intelligence-report", "project-intelligence-status"] });
  add({ id: "p23.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Project intelligence is available through MCP.",
    tokens: ["project_analyze", "project_intelligence_report", "project_analysis_status"] });

  // --- Phase 24 controlled autonomous workflow execution (presence only) -----
  // These checks assert WIRING exists. They never claim runtime execution success:
  // process_ok != task_verified and four evidence tiers remain distinct.
  const p24 = {
    facade: readSource("src/controlledWorkflow.js"),
    approval: readSource("src/workflowApproval.js"),
    state: readSource("src/workflowStateMachine.js"),
    adapter: readSource("src/opencodeRunAdapter.js"),
    dispatcher: readSource("src/workflowDispatcher.js"),
    monitor: readSource("src/workflowMonitor.js"),
    recovery: readSource("src/workflowRecovery.js"),
    validation: readSource("src/workflowValidation.js"),
    testExec: readSource("src/testExecution.js"),
    templates: readSource("src/workflowTemplates.js"),
    migration: readSource("init/022-phase24-controlled-workflow.sql"),
  };
  add({ id: "p24.facade", category: "workflow", file: "src/controlledWorkflow.js", src: p24.facade,
    description: "Approval-gated facade composes planning, dispatch, validation, recovery, feedback and reporting.",
    tokens: ["createWorkflow", "approve", "dispatch", "validate", "recover", "report", "simulation"] });
  add({ id: "p24.approval", category: "workflow", file: "src/workflowApproval.js", src: p24.approval,
    description: "Single-use, scope-bound approvals: only token_hash is persisted; replay is rejected.",
    tokens: ["createApproval", "verifyApproval", "consumeApproval", "token_hash", "status='active'"] });
  add({ id: "p24.state-machine", category: "workflow", file: "src/workflowStateMachine.js", src: p24.state,
    description: "Durable run/task state machine enforces legal transitions and dependency readiness.",
    tokens: ["startRun", "transitionTask", "getReadyTasks", "illegal transition"] });
  add({ id: "p24.adapter", category: "workflow", file: "src/opencodeRunAdapter.js", src: p24.adapter,
    description: "Fixed-argument opencode run adapter; process_ok never sets task_verified.",
    tokens: ["buildRunArgs", "executeAgentRun", "task_verified", "--agent", "--worktree"] });
  add({ id: "p24.dispatcher", category: "workflow", file: "src/workflowDispatcher.js", src: p24.dispatcher,
    description: "Bounded, idempotent, ownership-safe dispatch requires a consumed approval.",
    tokens: ["dispatchReady", "checkFileOwnership", "idempotency_key", "getReadyTasks"] });
  add({ id: "p24.monitor", category: "workflow", file: "src/workflowMonitor.js", src: p24.monitor,
    description: "Read-only monitoring with stale detection and bounded status summaries.",
    tokens: ["monitorRun", "listStale", "workflowHealth"] });
  add({ id: "p24.recovery", category: "workflow", file: "src/workflowRecovery.js", src: p24.recovery,
    description: "Bounded retry with no approval bypass and capped attempts.",
    tokens: ["recoverRun", "retryTask", "approval required"] });
  add({ id: "p24.validation", category: "workflow", file: "src/workflowValidation.js", src: p24.validation,
    description: "Evidence-based post-conditions; process_ok alone can never verify.",
    tokens: ["validateTask", "VALID_EVIDENCE", "evidence_class_not_eligible", "assertNoOverclaim"] });
  add({ id: "p24.test-execution", category: "workflow", file: "src/testExecution.js", src: p24.testExec,
    description: "Isolated-DB test execution with fixed argv and redacted output; evidence, not verification.",
    tokens: ["runTests", "non-isolated", "SHELL_META", "task_verified"] });
  add({ id: "p24.templates", category: "workflow", file: "src/workflowTemplates.js", src: p24.templates,
    description: "Templates prepare only; feedback records into Phase 21/23 without auto-applying.",
    tokens: ["listTemplates", "createWorkflow", "feedbackLoop", "Record-only"] });
  add({ id: "p24.migration", category: "workflow", file: "init/022-phase24-controlled-workflow.sql", src: p24.migration,
    description: "Additive-only migration 022 defines the six workflow ledger tables.",
    tokens: ["CREATE TABLE IF NOT EXISTS workflow_approval", "workflow_dispatch", "workflow_verification", "workflow_feedback"] });
  add({ id: "p24.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Controlled workflow is available through the CLI.",
    tokens: ["workflow-create", "workflow-dispatch", "workflow-report"] });
  add({ id: "p24.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Controlled workflow is available through MCP.",
    tokens: ["workflow_create", "workflow_dispatch", "workflow_report"] });

  // --- Phase 25 source-level engineering intelligence (presence only) -------
  // Wiring presence is never runtime proof. Static evidence, explicit confidence
  // and staleness; no source rewriting; no dispatch; no duplicate finding engine.
  const p25 = {
    facade: readSource("src/codeIntelligence.js"),
    indexer: readSource("src/sourceIndexer.js"),
    graph: readSource("src/symbolGraph.js"),
    understanding: readSource("src/codeUnderstanding.js"),
    impact: readSource("src/changeImpact.js"),
    testmap: readSource("src/testMap.js"),
    selector: readSource("src/testSelector.js"),
    review: readSource("src/codeReviewRisk.js"),
    contracts: readSource("src/contractCheck.js"),
    migration: readSource("init/023-phase25-code-intelligence.sql"),
  };
  add({ id: "p25.facade", category: "code-intelligence", file: "src/codeIntelligence.js", src: p25.facade,
    description: "Unified source intelligence report with explicit stale/unsupported/failed states.",
    tokens: ["indexProject", "searchSymbols", "impact", "recommendTests", "review", "report", "NO_RUNTIME_CLAIM", "Static source evidence only"] });
  add({ id: "p25.indexer", category: "code-intelligence", file: "src/sourceIndexer.js", src: p25.indexer,
    description: "Bounded, content-hash incremental source discovery and symbol extraction with confidence.",
    tokens: ["discoverFiles", "extractSymbols", "indexProject", "symbol_key", "confidence", "underRoot", "deleted"] });
  add({ id: "p25.graph", category: "code-intelligence", file: "src/symbolGraph.js", src: p25.graph,
    description: "Evidence-backed symbol relationships with confirmed/inferred/unresolved status.",
    tokens: ["buildRelationships", "getRelationships", "traverse", "unresolved", "evidence"] });
  add({ id: "p25.understanding", category: "code-intelligence", file: "src/codeUnderstanding.js", src: p25.understanding,
    description: "Deterministic per-symbol and per-module structural understanding; no LLM calls.",
    tokens: ["describeSymbol", "moduleUnderstanding", "params", "db_access", "error_handling"] });
  add({ id: "p25.impact", category: "code-intelligence", file: "src/changeImpact.js", src: p25.impact,
    description: "Version-aware change impact; stale indexes cannot silently support recommendations.",
    tokens: ["analyzeChange", "compareIndexFreshness", "transitive", "unknown", "stale", "code_analysis"] });
  add({ id: "p25.testmap", category: "code-intelligence", file: "src/testMap.js", src: p25.testmap,
    description: "Evidence-backed test-to-code links without invented coverage.",
    tokens: ["buildTestMap", "getTestsFor", "link_type", "unmapped", "confidence"] });
  add({ id: "p25.selector", category: "code-intelligence", file: "src/testSelector.js", src: p25.selector,
    description: "Explainable test recommendations; recommends only, never executes or bypasses approval.",
    tokens: ["recommendTests", "must_not_skip", "missing_relations", "reason", "approval"] });
  add({ id: "p25.review", category: "code-intelligence", file: "src/codeReviewRisk.js", src: p25.review,
    description: "Evidence-backed review findings; delegates to Phase 23 instead of duplicating it.",
    tokens: ["reviewChange", "finding_id", "insufficient_evidence", "technicalDebt", "dependencyRisk"] });
  add({ id: "p25.contracts", category: "code-intelligence", file: "src/contractCheck.js", src: p25.contracts,
    description: "Import/export and boundary consistency checks; discrepancies are findings, not proof.",
    tokens: ["checkContracts", "cycles", "discrepancies", "findings", "decisionIntel"] });
  add({ id: "p25.migration", category: "code-intelligence", file: "init/023-phase25-code-intelligence.sql", src: p25.migration,
    description: "Additive-only migration 023 defines six project-scoped, content-versioned tables.",
    tokens: ["CREATE TABLE IF NOT EXISTS code_index_state", "code_symbol", "code_relationship", "code_test_map", "code_analysis"] });
  add({ id: "p25.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Code intelligence is available through the CLI.",
    tokens: ["code-index", "code-impact", "code-test-recommend", "code-report"] });
  add({ id: "p25.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Code intelligence is available through MCP.",
    tokens: ["code_index", "code_change_impact", "code_test_recommend", "code_report"] });

  // --- Phase 26 long-term project management (presence only) ----------------
  // These checks assert wiring exists. They never claim verified project outcomes.
  const p26 = {
    facade: readSource("src/projectManagement.js"),
    goals: readSource("src/projectGoals.js"),
    milestones: readSource("src/projectMilestones.js"),
    progress: readSource("src/projectProgress.js"),
    continuity: readSource("src/projectContinuity.js"),
    dependencies: readSource("src/projectDependencies.js"),
    blockers: readSource("src/projectBlockers.js"),
    drift: readSource("src/projectDrift.js"),
    ownership: readSource("src/projectOwnership.js"),
    recovery: readSource("src/projectRecovery.js"),
    nextAction: readSource("src/nextBestAction.js"),
    migration: readSource("init/024-phase26-project-management.sql"),
  };
  add({ id: "p26.facade", category: "project-management", file: "src/projectManagement.js", src: p26.facade,
    description: "Unified project status/briefing/report assembled from existing authoritative records.",
    tokens: ["status", "briefing", "nextActions", "report", "Record-based evidence only", "no execution was performed"] });
  add({ id: "p26.goals", category: "project-management", file: "src/projectGoals.js", src: p26.goals,
    description: "Extends dev_goal with explicit provenance, history and auditable state changes.",
    tokens: ["dev_goal", "provenance", "success_criteria", "getGoalHistory", "actor"] });
  add({ id: "p26.milestones", category: "project-management", file: "src/projectMilestones.js", src: p26.milestones,
    description: "Milestone completion requires success criteria and verified task evidence.",
    tokens: ["pm_milestone", "success_criteria", "canMarkComplete", "insufficient_evidence", "not_applicable"] });
  add({ id: "p26.progress", category: "project-management", file: "src/projectProgress.js", src: p26.progress,
    description: "Evidence-backed progress snapshots; no invented completion percentages.",
    tokens: ["pm_progress_snapshot", "verified", "insufficient_evidence", "computeProgress"] });
  add({ id: "p26.continuity", category: "project-management", file: "src/projectContinuity.js", src: p26.continuity,
    description: "Cross-session briefing assembled by reference from existing records, not transcripts.",
    tokens: ["buildBriefing", "pm_continuity_snapshot", "references", "unknown"] });
  add({ id: "p26.dependencies", category: "project-management", file: "src/projectDependencies.js", src: p26.dependencies,
    description: "Typed dependencies; only confirmed edges are authoritative constraints.",
    tokens: ["pm_dependency", "confirmed", "inferred", "unresolved", "detectCycles"] });
  add({ id: "p26.blockers", category: "project-management", file: "src/projectBlockers.js", src: p26.blockers,
    description: "Blocker lifecycle and Phase 23 risk delegation without a duplicate risk engine.",
    tokens: ["pm_blocker", "technicalDebt", "dependencyRisk", "insufficient_evidence", "setBlockerStatus"] });
  add({ id: "p26.drift", category: "project-management", file: "src/projectDrift.js", src: p26.drift,
    description: "Explainable drift findings for operator review; never auto-rewrites goals.",
    tokens: ["pm_drift_finding", "finding_key", "orphan_work", "recommendation", "review"] });
  add({ id: "p26.ownership", category: "project-management", file: "src/projectOwnership.js", src: p26.ownership,
    description: "Honest agent ownership states; execution never invented without evidence.",
    tokens: ["pm_ownership", "completed_process", "verified", "unknown", "insufficient_evidence"] });
  add({ id: "p26.recovery", category: "project-management", file: "src/projectRecovery.js", src: p26.recovery,
    description: "Recovery preparation requires valid approval and never auto-resumes execution.",
    tokens: ["assessRecovery", "never_auto_resume", "required_approval", "prepareRecovery", "verifyApproval"] });
  add({ id: "p26.next-action", category: "project-management", file: "src/nextBestAction.js", src: p26.nextAction,
    description: "Deterministic explainable recommendations that never execute or bypass approval.",
    tokens: ["recommend", "reason", "approval_required", "action_kind", "candidates_tied"] });
  add({ id: "p26.migration", category: "project-management", file: "init/024-phase26-project-management.sql", src: p26.migration,
    description: "Additive-only migration 024 extends dev_goal and adds seven pm_* tables.",
    tokens: ["ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS", "pm_milestone", "pm_dependency", "pm_continuity_snapshot", "pm_ownership"] });
  add({ id: "p26.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Project management intelligence is available through the CLI.",
    tokens: ["project-status", "project-briefing", "project-next-actions", "project-report"] });
  add({ id: "p26.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Project management intelligence is available through MCP.",
    tokens: ["pm_status", "pm_briefing", "pm_next_actions", "pm_report"] });
  add({ id: "p26.approval-preserved", category: "integration", file: "src/projectRecovery.js", src: p26.recovery,
    description: "Recovery continues to require Phase 24 approval; no bypass path is introduced.",
    tokens: ["verifyApproval", "required_approval", "never_auto_resume", "dry_run"] });

  // --- Phase 27 adaptive intelligence (presence only) ----------------------
  // Wiring presence is never runtime proof. Phase 21 remains authoritative for
  // learning quality / retrieval usefulness / recurring failures; no duplicate engine.
  const p27 = {
    facade: readSource("src/adaptiveIntelligence.js"),
    outcome: readSource("src/outcomeEvaluation.js"),
    recommendation: readSource("src/recommendationEvaluation.js"),
    prediction: readSource("src/predictionEvaluation.js"),
    decomposition: readSource("src/decompositionEvaluation.js"),
    calibration: readSource("src/adaptiveCalibration.js"),
    reporting: readSource("src/adaptiveReporting.js"),
    migration: readSource("init/025-phase27-adaptive-intelligence.sql"),
  };
  add({ id: "p27.facade", category: "adaptive", file: "src/adaptiveIntelligence.js", src: p27.facade,
    description: "Advisory evaluation/report facade over existing Phase 18-26 systems.",
    tokens: ["ingestOutcome", "evaluateRecommendation", "evaluatePrediction", "evaluateDecomposition",
      "report", "ADVISORY_CLAIM", "no approval was auto-granted"] });
  add({ id: "p27.outcome", category: "adaptive", file: "src/outcomeEvaluation.js", src: p27.outcome,
    description: "Verified outcome ingestion reuses Phase 21 verification; claims and exit codes never verify.",
    tokens: ["analyzeOutcome", "verification_state", "independently_verified", "idempotent"] });
  add({ id: "p27.recommendation", category: "adaptive", file: "src/recommendationEvaluation.js", src: p27.recommendation,
    description: "Recommendation effectiveness preserves accepted/rejected/ignored distinctions.",
    tokens: ["recommendation_type", "operator_decision", "inconclusive", "insufficient_evidence", "not_evaluated"] });
  add({ id: "p27.prediction", category: "adaptive", file: "src/predictionEvaluation.js", src: p27.prediction,
    description: "Prediction evaluation is stored separately; original predictions stay immutable.",
    tokens: ["prediction_type", "observation_window", "insufficient_evidence", "never", "predicted"] });
  add({ id: "p27.decomposition", category: "adaptive", file: "src/decompositionEvaluation.js", src: p27.decomposition,
    description: "Decomposition/agent evaluation reuses Phase 22 performance with sample thresholds.",
    tokens: ["agentPerformance", "min_samples", "insufficient_evidence", "task_category", "no dispatch"] });
  add({ id: "p27.calibration", category: "adaptive", file: "src/adaptiveCalibration.js", src: p27.calibration,
    description: "Bounded advisory calibration proposals with protected targets, approval and rollback.",
    tokens: ["proposeCalibration", "protected_target", "approval_required", "rollbackCalibration", "advisory"] });
  add({ id: "p27.reporting", category: "adaptive", file: "src/adaptiveReporting.js", src: p27.reporting,
    description: "Cross-phase report reuses existing systems with denominators and no invented percentages.",
    tokens: ["learningStatus", "usefulnessSummary", "agentPerformance", "denominator", "insufficient_evidence"] });
  add({ id: "p27.migration", category: "adaptive", file: "init/025-phase27-adaptive-intelligence.sql", src: p27.migration,
    description: "Additive-only migration 025 defines five advisory evaluation/proposal tables.",
    tokens: ["CREATE TABLE IF NOT EXISTS ai_outcome_evaluation", "ai_recommendation_evaluation",
      "ai_prediction_evaluation", "ai_decomposition_evaluation", "ai_calibration_proposal"] });
  add({ id: "p27.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Adaptive intelligence is available through the CLI.",
    tokens: ["adapt-outcome", "adapt-prediction", "adapt-propose", "adapt-report"] });
  add({ id: "p27.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Adaptive intelligence is available through MCP.",
    tokens: ["adapt_outcome_ingest", "adapt_prediction_evaluate", "adapt_calibration_propose", "adapt_report"] });
  add({ id: "p27.reuse-not-duplicate", category: "integration", file: "src/adaptiveIntelligence.js", src: p27.facade,
    description: "Retrieval/failure/quality delegate to authoritative Phase 18/21 modules, not duplicates.",
    tokens: ["retrievalFeedback", "errorLearning", "learningEngine", "learningIntelligence", "Reuses"] });
  add({ id: "p27.approval-preserved", category: "integration", file: "src/adaptiveIntelligence.js", src: p27.facade,
    description: "No dispatch, no auto-approval and no source rewrite in adaptive intelligence.",
    tokens: ["no approval was auto-granted", "no workflow was dispatched", "No source was rewritten"] });

  // --- Phase 28 production hardening (presence only) -----------------------
  const p28 = {
    health: readSource("src/operationalHealth.js"),
    indexes: readSource("init/026-phase28-hardening.sql"),
  };
  add({ id: "p28.health", category: "hardening", file: "src/operationalHealth.js", src: p28.health,
    description: "Unified operational health with explicit verdicts; presence is not runtime proof.",
    tokens: ["operationalHealth", "runtime_check", "Presence checks are not runtime proof", "insufficient_evidence"] });
  add({ id: "p28.indexes", category: "hardening", file: "init/026-phase28-hardening.sql", src: p28.indexes,
    description: "Additive, reversible project_id indexes on high-traffic tables.",
    tokens: ["CREATE INDEX IF NOT EXISTS", "agent_execution", "workflow_verification", "memory_retrieval_events"] });
  add({ id: "p28.cli-integration", category: "integration", file: "src/cli.js", src: p17.cli,
    description: "Operational health is available via the CLI.",
    tokens: ["ops-health"] });
  add({ id: "p28.mcp-integration", category: "integration", file: "src/server.js", src: p17.server,
    description: "Operational health is available via MCP.",
    tokens: ["ops_health"] });

  const missing = checks.filter((c) => c.missing).map((c) => c.id);
  const present = checks.filter((c) => c.ok).map((c) => c.id);

  return {
    ok: missing.length === 0,
    scope: WIRING_SCOPE,
    claim: NO_RUNTIME_CLAIM,
    verifiedBehavior: false,
    checkedAt: new Date().toISOString(),
    sources: {
      plugin: { file: PLUGIN_REL, exists: plugin.ok, bytes: plugin.bytes, error: plugin.error },
      automation: { file: AUTOMATION_REL, exists: automation.ok, bytes: automation.bytes, error: automation.error },
      phase17: Object.fromEntries(Object.entries(p17).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase18: Object.fromEntries(Object.entries(p18).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase19: Object.fromEntries(Object.entries(p19).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase20: Object.fromEntries(Object.entries(p20).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase21: Object.fromEntries(Object.entries(p21).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase22: Object.fromEntries(Object.entries(p22).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase23: Object.fromEntries(Object.entries(p23).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase24: Object.fromEntries(Object.entries(p24).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase25: Object.fromEntries(Object.entries(p25).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase26: Object.fromEntries(Object.entries(p26).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase27: Object.fromEntries(Object.entries(p27).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
      phase28: Object.fromEntries(Object.entries(p28).map(([k, v]) => [k, { file: v.rel, exists: v.ok, bytes: v.bytes, error: v.error }])),
    },
    summary: { total: checks.length, present: present.length, missing: missing.length },
    stages: STAGE_IDS,
    checks,
    present,
    missing,
  };
}

// --- 3. auditRecentProcessing (SELECT-only) -------------------------------

export async function auditRecentProcessing({ limit = 20 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
  const statements = [];
  const errors = [];

  async function q(name, sql, params = []) {
    statements.push(sql);
    try {
      const r = await core.dbQuery(sql, params);
      return { ok: true, rows: r.rows, name };
    } catch (e) {
      errors.push({ query: name, error: String(e?.message || e).slice(0, 300) });
      return { ok: false, rows: [], name };
    }
  }

  const byStatus = await q(
    "automation_events.by_status",
    "SELECT status, count(*)::int AS n FROM automation_events GROUP BY 1 ORDER BY n DESC",
  );
  const processed = await q(
    "automation_events.processed_sessions",
    "SELECT count(DISTINCT session_id)::int AS n FROM automation_events WHERE status='done'",
  );
  const recent = await q(
    "automation_events.recent",
    "SELECT session_id,event_id,status,attempts,sequence,created_at,finished_at FROM automation_events ORDER BY created_at DESC LIMIT $1",
    [cap],
  );
  const duplicates = await q(
    "automation_events.duplicates",
    `SELECT session_id, transcript_hash, count(*)::int AS n FROM automation_events
      WHERE transcript_hash IS NOT NULL GROUP BY session_id, transcript_hash
      HAVING count(*) > 1 ORDER BY n DESC LIMIT $1`,
    [cap],
  );
  const pending = await q(
    "automation_events.pending_or_processing",
    `SELECT session_id,event_id,status,attempts,sequence,created_at FROM automation_events
      WHERE status IN ('pending','processing') ORDER BY created_at LIMIT $1`,
    [cap],
  );
  const stages = await q(
    "automation_events.stage_availability",
    `SELECT k.key AS stage, count(*)::int AS n
      FROM automation_events ae,
           jsonb_object_keys(COALESCE(ae.result->'stages','{}'::jsonb)) AS k(key)
      WHERE ae.status='done' GROUP BY 1 ORDER BY n DESC`,
  );
  const sem = await q(
    "semantic_observation.coverage",
    "SELECT count(DISTINCT session_id)::int AS sessions, count(*)::int AS observations FROM semantic_observation",
  );
  const semBreakdown = await q(
    "semantic_observation.breakdown",
    "SELECT attribution, source, count(*)::int AS n FROM semantic_observation GROUP BY 1,2 ORDER BY n DESC",
  );
  const runs = await q(
    "learning_runs.coverage",
    `SELECT count(DISTINCT session_id)::int AS sessions, count(*)::int AS runs,
            COALESCE(sum(saved),0)::int AS saved FROM learning_runs`,
  );

  return {
    ok: errors.length === 0,
    readOnly: true,
    limit: cap,
    checkedAt: new Date().toISOString(),
    claim: "Read-only DB state; describes observed processing only, not feature correctness.",
    statements,
    errors,
    automation_events: {
      by_status: byStatus.rows,
      processed_sessions: processed.rows[0]?.n || 0,
      recent: recent.rows,
      duplicates: duplicates.rows,
      pending_or_processing: pending.rows,
    },
    stage_availability: stages.rows,
    expected_stages: declaredStages(),
    semantic_observation: {
      sessions: sem.rows[0]?.sessions || 0,
      observations: sem.rows[0]?.observations || 0,
      breakdown: semBreakdown.rows,
    },
    learning_runs: {
      sessions: runs.rows[0]?.sessions || 0,
      runs: runs.rows[0]?.runs || 0,
      saved: runs.rows[0]?.saved || 0,
    },
  };
}

// --- 4. understandingGapReport -------------------------------------------

export async function understandingGapReport({ wiring, processing } = {}) {
  const w = wiring || auditPipelineIntegrity();
  const p = processing || await auditRecentProcessing();
  const map = pipelineDependencyMap();

  const gaps = [];
  function addGap(id, severity, title, detail, evidence, recommendation) {
    gaps.push({ id, severity, title, detail, evidence, recommendation });
  }

  // Wiring gaps: presence only.
  for (const c of (w.checks || []).filter((c) => c.missing)) {
    addGap(
      `wiring:${c.id}`, "high", `Missing wiring: ${c.id}`, c.detail,
      { source: "wiring", file: c.file },
      "Restore the hook/stage reference or confirm the stage is intentionally disabled.",
    );
  }
  if (w.sources && !w.sources.plugin?.exists) {
    addGap("wiring:plugin-source", "high", "Plugin source unreadable", w.sources.plugin?.error || "unknown",
      { source: "wiring", file: PLUGIN_REL }, "Verify the plugin file exists and is readable.");
  }
  if (w.sources && !w.sources.automation?.exists) {
    addGap("wiring:automation-source", "high", "Automation source unreadable", w.sources.automation?.error || "unknown",
      { source: "wiring", file: AUTOMATION_REL }, "Verify automation.js exists and is readable.");
  }

  // Disconnected modules detected by the dependency map.
  const disconnected = [];
  for (const [nodeId, node] of Object.entries(map.nodes || {})) {
    for (const m of node.modules || []) {
      const missingFns = m.missingFunctions || [];
      const missingTokens = m.missingTokens || [];
      if (!m.exists || missingFns.length || missingTokens.length) {
        disconnected.push({ node: nodeId, file: m.file, missingFunctions: missingFns, missingTokens });
      }
    }
  }
  if (disconnected.length) {
    addGap(
      "disconnected-modules", "medium",
      `${disconnected.length} module reference(s) not verified in source`,
      "Some dependency-map references could not be verified against the source files.",
      { source: "wiring", items: disconnected },
      "Re-check the referenced module and export names before relying on this edge.",
    );
  }

  // DB processing gaps: observed state only.
  if (!p.ok) {
    addGap(
      "db-unavailable", "high", "DB processing audit incomplete",
      (p.errors || []).map((e) => `${e.query}: ${e.error}`).join("; ") || "DB queries failed",
      { source: "db", errors: p.errors || [] },
      "Check database connectivity and that all audited tables exist.",
    );
  }

  const ae = p.automation_events || {};
  const pendingRows = ae.pending_or_processing || [];
  const processingRows = pendingRows.filter((e) => e.status === "processing");
  const pendingRowsOnly = pendingRows.filter((e) => e.status === "pending");

  if (processingRows.length) {
    addGap(
      "processing-stuck", "high",
      `${processingRows.length} event(s) stuck in 'processing'`,
      "Claims in 'processing' state may be stale and awaiting lease recovery.",
      { source: "db", events: processingRows.slice(0, 5) },
      "Run automation-recovery / recoverEvents to reset stale claims.",
    );
  }
  if (pendingRowsOnly.length) {
    addGap(
      "pending-events", "medium",
      `${pendingRowsOnly.length} event(s) pending`,
      "Pending automation events have not yet completed the stage pipeline.",
      { source: "db", events: pendingRowsOnly.slice(0, 5) },
      "Allow turn-end automation to run or retry pending events.",
    );
  }

  const byStatus = ae.by_status || [];
  const failed = byStatus.find((s) => s.status === "failed")?.n || 0;
  const superseded = byStatus.find((s) => s.status === "superseded")?.n || 0;
  if (failed) {
    addGap("failed-events", "medium", `${failed} event(s) failed`,
      "Failed events indicate a turn-end pipeline run that did not finish cleanly.",
      { source: "db", status: "failed", count: failed },
      "Inspect event error fields and retry after fixing the cause.");
  }
  if (superseded) {
    addGap("superseded-events", "low", `${superseded} event(s) superseded`,
      "Superseded events are intentionally not replayed (stale sequences).",
      { source: "db", status: "superseded", count: superseded },
      "No action required; this is an expected outcome of out-of-order protection.");
  }
  if ((ae.duplicates || []).length) {
    addGap("duplicate-processing", "low", `${ae.duplicates.length} transcript hash(es) reprocessed`,
      "Multiple events share the same transcript hash for a session.",
      { source: "db", items: ae.duplicates.slice(0, 5) },
      "Confirm dedupe/claim logic is behaving as intended.");
  }

  const processedSessions = ae.processed_sessions || 0;
  if (processedSessions === 0) {
    addGap("no-processed-sessions", "medium", "No completed automation events observed",
      "No session has a 'done' automation event, so no stage can be corroborated by DB evidence.",
      { source: "db", processed_sessions: 0 },
      "Generate a session turn-end and confirm an event reaches status='done'.");
  }

  const observedStages = new Set((p.stage_availability || []).map((s) => s.stage));
  const expectedStages = p.expected_stages || [];
  const missingStages = expectedStages.filter((s) => !observedStages.has(s));
  if (processedSessions > 0 && missingStages.length) {
    addGap("stage-evidence-missing", "low", `${missingStages.length} wired stage(s) with no DB evidence`,
      `Stages wired in code but absent from successful event results: ${missingStages.join(", ")}.`,
      { source: "db", missing_stages: missingStages },
      "Older 'done' events may predate a stage; confirm on a fresh event.");
  }
  if (processedSessions > 0 && (p.semantic_observation?.sessions || 0) === 0) {
    addGap("no-semantic-observations", "low", "No semantic observations recorded",
      "The semantic_understanding stage has no persisted observations in the DB.",
      { source: "db", semantic_sessions: 0 },
      "Confirm deterministic semantic analysis ran on a processed session.");
  }

  const summary = { high: 0, medium: 0, low: 0, total: gaps.length };
  for (const g of gaps) summary[g.severity] = (summary[g.severity] || 0) + 1;

  return {
    // A clean report requires no gaps at all: wiring presence alone never yields a pass.
    ok: summary.total === 0,
    claim: NO_RUNTIME_CLAIM,
    note: "Wiring gaps are presence-only; DB gaps are observed state. Neither proves feature correctness.",
    runtimeVerified: false,
    wiringOnlyVerified: false,
    checkedAt: new Date().toISOString(),
    wiring: { ok: w.ok, scope: w.scope, missing: w.missing || [] },
    processing: {
      ok: p.ok,
      processed_sessions: processedSessions,
      by_status: ae.by_status || [],
      pending_or_processing: pendingRows.length,
      duplicates: (ae.duplicates || []).length,
    },
    disconnectedModules: disconnected,
    gaps,
    summary,
  };
}

export default {
  pipelineDependencyMap,
  auditPipelineIntegrity,
  auditRecentProcessing,
  understandingGapReport,
};
