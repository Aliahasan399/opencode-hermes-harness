// Sidecar CLI used by the OpenCode plugin (and handy from a terminal).
import fs from "node:fs";
import * as core from "./core.js";
import { learnFromTranscript } from "./learn.js";
import { importOpenCodeHistory } from "./importer.js";
import { enrichSessionSummaries, rawSession, extractSession } from "./roles.js";
import { analyzeQuality, patternQuality, feedback, feedbackStats } from "./patterns-v2.js";
import { recordObservation, evaluateStrategies, observationStats } from "./strategy.js";
import { resolveProjectId } from "./projectIdentity.js";
import { analyzeSession as semanticAnalyze, listObservations as semanticList } from "./semanticUnderstanding.js";
import { analyzeSessionErrors, fixEvidenceReport } from "./errorLearning.js";
import { adaptiveRetrieve } from "./adaptiveRetrieval.js";
import { prepareContext } from "./contextPackage.js";
import { provenanceReport, dryRunQualityReport } from "./dataQuality.js";
import { intelligenceQualityReport } from "./phase13Report.js";
import { backlogReport, consolidationCoverage } from "./consolidationReport.js";
import * as llm from "./llm-provider.js";
import * as mind from "./memoryIntelligence.js";
import * as gov from "./memoryGovernance.js";
import * as intelligence from "./intelligence.js";
import { runTurnEnd, retryPending, automationStatus, recoverAutomation, recoverIfDue, recoverEvents, parseTranscriptLines } from "./automation.js";
import { appendLine, transcriptText, lastSequence } from "./transcript.js";
import * as pipelineAudit from "./pipelineAudit.js";
import * as contextIntel from "./contextIntel.js";
import * as decisionIntel from "./decisionIntel.js";
import * as relationshipIntel from "./relationshipIntel.js";
import * as contextRetrieval from "./contextRetrieval.js";
import * as knowledgeQuality from "./knowledgeQuality.js";
import * as contextUpdate from "./contextUpdate.js";

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parse(process.argv.slice(2));
const cmd = args._[0] || "status";

try {
  if (cmd === "status") {
    console.log(JSON.stringify({ ok: true, ...(await core.health()) }));
  } else if (cmd === "context") {
    const q = String(args.prompt || "").slice(0, 4000);
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    const r = await adaptiveRetrieve({ query: q || "project context", project_id: pid,
      session_id: args.session || null, limit: 6 });
    console.log(r.context || "");
  } else if (cmd === "transcript-append") {
    const rec = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    console.log(JSON.stringify(appendLine(rec)));
  } else if (cmd === "transcript-read") {
    const sid = args.session || "unknown";
    console.log(JSON.stringify({ lines: transcriptText(sid), sequence: lastSequence(sid) }));
  } else if (cmd === "automate") {
    const durable = !!args.durable;
    const fromStdin = !!args.stdin;
    const transcript = durable ? transcriptText(args.session || "unknown")
      : fromStdin ? fs.readFileSync(0, "utf8")
      : args["transcript-file"] ? fs.readFileSync(args["transcript-file"], "utf8") : (args.transcript || "");
    const seq = durable ? lastSequence(args.session || "unknown")
      : args.seq ? Number(args.seq) : undefined;
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    const r = await runTurnEnd({
      session_id: args.session || "unknown", project_id: pid, directory: args.project,
      transcript, event_id: args["event-id"], sequence: seq,
      min_sequence: Number(args["min-seq"] || 0) || undefined,
      lines: fromStdin || args["transcript-file"] ? parseTranscriptLines(transcript) : undefined,
      allow_llm: !!args.llm,
    });
    console.log(JSON.stringify(r));
  } else if (cmd === "automation-status") {
    console.log(JSON.stringify(await automationStatus()));
  } else if (cmd === "automation-retry") {
    console.log(JSON.stringify(await retryPending({ limit: Number(args.limit || 10) })));
  } else if (cmd === "automation-recover") {
    console.log(JSON.stringify(await recoverAutomation({ limit: Number(args.limit || 20), scan_transcripts: !args["no-scan"] })));
  } else if (cmd === "automation-recover-if-due") {
    console.log(JSON.stringify(await recoverIfDue({})));
  } else if (cmd === "automation-recover-events") {
    console.log(JSON.stringify(await recoverEvents({ limit: Number(args.limit || 30) })));
  } else if (cmd === "learn") {
    const transcript = args["transcript-file"] ? fs.readFileSync(args["transcript-file"], "utf8") : (args.transcript || "");
    const r = await learnFromTranscript({
      session_id: args.session || "unknown",
      project_id: args.project,
      transcript,
      save: args["dry-run"] ? false : true,
    });
    console.log(JSON.stringify(r));
  } else if (cmd === "import") {
    console.log(JSON.stringify(await importOpenCodeHistory({ limit: Number(args.limit || 50) })));
  } else if (cmd === "enrich") {
    console.log(JSON.stringify(await enrichSessionSummaries({ limit: Number(args.limit || 50) })));
  } else if (cmd === "raw-session") {
    console.log(JSON.stringify(await rawSession(args.session, { limit: Number(args.limit || 100), offset: Number(args.offset || 0), role: args.role, kind: args.kind })));
  } else if (cmd === "analyze-quality") {
    console.log(JSON.stringify(await analyzeQuality({ limit: Number(args.limit || 200), force: !!args.force })));
  } else if (cmd === "pattern-quality") {
    console.log(JSON.stringify({ quality: await patternQuality(), feedback: await feedbackStats() }));
  } else if (cmd === "feedback") {
    console.log(JSON.stringify(await feedback(args.id, args.verdict, args.reason || "")));
  } else if (cmd === "observe") {
    console.log(JSON.stringify(await recordObservation({
      session_id: args.session || "unknown", project_id: args.project, tool_name: args.tool,
      duration_ms: Number(args.ms || 0), exit_code: args.exit === undefined ? undefined : Number(args.exit),
      is_error: !!args.error, retry_of: args["retry-of"],
    })));
  } else if (cmd === "strategy-evaluate") {
    console.log(JSON.stringify(await evaluateStrategies({ project_id: args.project })));
  } else if (cmd === "llm-status") {
    console.log(JSON.stringify(llm.status()));
  } else if (cmd === "llm-usage") {
    console.log(JSON.stringify(llm.usage()));
  } else if (cmd === "semantic-analyze") {
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    console.log(JSON.stringify(await semanticAnalyze({ session_id: args.session || "unknown", project_id: pid, force: !!args.force })));
  } else if (cmd === "semantic-observations") {
    console.log(JSON.stringify(await semanticList({ project_id: args.project, session_id: args.session, limit: Number(args.limit || 50) })));
  } else if (cmd === "error-analyze") {
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    console.log(JSON.stringify(await analyzeSessionErrors({ session_id: args.session || "unknown", project_id: pid })));
  } else if (cmd === "error-report") {
    console.log(JSON.stringify(await fixEvidenceReport({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-package") {
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    const r = await prepareContext({ project_id: pid, session_id: args.session || null,
      query: args.prompt, budget_chars: Number(args.budget || 4000) });
    console.log(r.context);
  } else if (cmd === "quality-provenance") {
    console.log(JSON.stringify(await provenanceReport({ project_id: args.project })));
  } else if (cmd === "quality-dry-run") {
    console.log(JSON.stringify(await dryRunQualityReport({ project_id: args.project })));
  } else if (cmd === "intelligence-report") {
    console.log(JSON.stringify(await intelligenceQualityReport({ project_id: args.project })));
  } else if (cmd === "consolidation-backlog") {
    console.log(JSON.stringify(await backlogReport({ project_id: args.project, limit: Number(args.limit || 100) })));
  } else if (cmd === "consolidation-coverage") {
    console.log(JSON.stringify(await consolidationCoverage()));
  } else if (cmd === "quality-score") {
    console.log(JSON.stringify(await mind.scoreMemoryQuality({ memory_id: args.id })));
  } else if (cmd === "maintenance-report") {
    console.log(JSON.stringify(await mind.maintenanceReport({ project_id: args.project, limit: Number(args.limit || 100) })));
  } else if (cmd === "retrieval-explain") {
    const pid = args.project ? await resolveProjectId(args.project) : undefined;
    console.log(JSON.stringify(await mind.explainRetrieval({ query: args.prompt || "project context", project_id: pid })));
  } else if (cmd === "learning-evidence") {
    console.log(JSON.stringify(await mind.learningEvidenceReport({ project_id: args.project })));
  } else if (cmd === "memory-archive") {
    console.log(JSON.stringify(await mind.archiveMemory({ memory_id: args.id })));
  } else if (cmd === "memory-restore") {
    console.log(JSON.stringify(await mind.restoreMemory({ memory_id: args.id })));
  } else if (cmd === "global-classification") {
    console.log(JSON.stringify(await gov.classifyGlobalMemories({ limit: Number(args.limit || 200) })));
  } else if (cmd === "scope-propose") {
    console.log(JSON.stringify(await gov.proposeScopeCorrections({ dry_run: !args.apply, limit: Number(args.limit || 100), memory_id: args.id })));
  } else if (cmd === "scope-reviews") {
    console.log(JSON.stringify(await gov.listScopeReviews({ status: args.status })));
  } else if (cmd === "scope-approve") {
    console.log(JSON.stringify(await gov.approveScopeReview({ id: args.id, approved: true, reviewer: args.reviewer || "operator" })));
  } else if (cmd === "scope-reject") {
    console.log(JSON.stringify(await gov.rejectScopeReview({ id: args.id, rejected: true, reviewer: args.reviewer || "operator" })));
  } else if (cmd === "scope-rollback") {
    console.log(JSON.stringify(await gov.rollbackScopeReview({ id: args.id })));
  } else if (cmd === "pipeline-map") {
    console.log(JSON.stringify(pipelineAudit.pipelineDependencyMap()));
  } else if (cmd === "pipeline-audit") {
    console.log(JSON.stringify(pipelineAudit.auditPipelineIntegrity()));
  } else if (cmd === "pipeline-processing") {
    console.log(JSON.stringify(await pipelineAudit.auditRecentProcessing({ limit: Number(args.limit || 20) })));
  } else if (cmd === "pipeline-gaps") {
    console.log(JSON.stringify(await pipelineAudit.understandingGapReport()));
  } else if (cmd === "project-intelligence-analyze") {
    const m = await import("./projectIntelligence.js");
    const evidence = args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : {};
    console.log(JSON.stringify(await m.analyzeProject({ project_id: args.project, session_id: args.session,
      components: args.components ? String(args.components).split(",") : [], evidence,
      force: args.force === true || args.force === "true" })));
  } else if (cmd === "project-intelligence-report") {
    const m = await import("./projectIntelligence.js");
    console.log(JSON.stringify(await m.projectReport({ project_id: args.project,
      report_type: args.type || "all", component: args.component, limit: Number(args.limit || 50) })));
  } else if (cmd === "project-intelligence-tasks") {
    const m = await import("./projectIntelligence.js");
    console.log(JSON.stringify(await m.prepareEngineeringTasks({ project_id: args.project,
      recommendation_id: args.id, request: args.prompt || "" })));
  } else if (cmd === "project-intelligence-status") {
    const m = await import("./projectIntelligence.js");
    console.log(JSON.stringify(await m.analysisStatus({ project_id: args.project,
      status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "project-intelligence-retry") {
    const m = await import("./projectIntelligence.js");
    console.log(JSON.stringify(await m.retryAnalysis({ limit: Number(args.limit || 20) })));
  } else if (cmd === "agent-plan") {
    const m = await import("./agentOrchestrator.js");
    const context = args.context ? JSON.parse(fs.readFileSync(args.context, "utf8")) : {};
    console.log(JSON.stringify(await m.orchestrate({ project_id: args.project, session_id: args.session,
      request: args.prompt || args.request || "", context,
      max_tasks: Number(args["max-tasks"] || 12) })));
  } else if (cmd === "agent-plan-status") {
    const m = await import("./agentOrchestrator.js");
    console.log(JSON.stringify(await m.planStatus({ plan_id: args.id || args.plan, project_id: args.project })));
  } else if (cmd === "agent-report") {
    const m = await import("./agentOrchestrator.js");
    console.log(JSON.stringify(await m.orchestrationReport({ plan_id: args.id || args.plan, project_id: args.project })));
  } else if (cmd === "agent-resume") {
    const m = await import("./agentOrchestrator.js");
    console.log(JSON.stringify(await m.resumePlan({ plan_id: args.id || args.plan, project_id: args.project })));
  } else if (cmd === "agent-explain") {
    const m = await import("./agentOrchestrator.js");
    console.log(JSON.stringify(await m.explainSelection({ plan_id: args.id || args.plan,
      task_id: args.task, project_id: args.project })));
  } else if (cmd === "agent-discover") {
    const m = await import("./agentRegistry.js");
    console.log(JSON.stringify(await m.discoverAgents()));
  } else if (cmd === "agent-claim") {
    const m = await import("./agentCoordination.js");
    console.log(JSON.stringify(await m.claimTask({ plan_id: args.plan, task_id: args.task,
      agent: args.agent, project_id: args.project, session_id: args.session })));
  } else if (cmd === "agent-complete") {
    const m = await import("./agentCoordination.js");
    const result = args.result ? JSON.parse(fs.readFileSync(args.result, "utf8")) : {};
    console.log(JSON.stringify(await m.completeTask({ plan_id: args.plan, task_id: args.task,
      agent: args.agent, project_id: args.project, result })));
  } else if (cmd === "agent-fail") {
    const m = await import("./agentCoordination.js");
    console.log(JSON.stringify(await m.failTask({ plan_id: args.plan, task_id: args.task,
      agent: args.agent, project_id: args.project, error: args.reason || "task failed" })));
  } else if (cmd === "agent-context") {
    const m = await import("./agentContext.js");
    console.log(JSON.stringify(await m.prepareAgentContext({ plan_id: args.plan, task_id: args.task,
      agent: args.agent, project_id: args.project, request: args.prompt || "",
      context_budget: Number(args.budget || 4000) })));
  } else if (cmd === "agent-conflicts") {
    const m = await import("./agentConflicts.js");
    console.log(JSON.stringify(await m.detectConflicts({ plan_id: args.plan, project_id: args.project })));
  } else if (cmd === "agent-validate") {
    const m = await import("./agentValidation.js");
    const evidence = args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : [];
    console.log(JSON.stringify(await m.validateTaskResult({ plan_id: args.plan, task_id: args.task,
      project_id: args.project, claimed_done: args.claimed === true || args.claimed === "true",
      evidence, completion_criteria: [] })));
  } else if (cmd === "agent-integrate") {
    const m = await import("./agentIntegration.js");
    console.log(JSON.stringify(await m.integrateResults({ plan_id: args.plan, project_id: args.project })));
  } else if (cmd === "learning-status") {
    const m = await import("./learningEngine.js");
    console.log(JSON.stringify(await m.learningStatus({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "learning-run") {
    const m = await import("./learningEngine.js");
    const lines = args.lines ? JSON.parse(fs.readFileSync(args.lines, "utf8")) : undefined;
    console.log(JSON.stringify(await m.runLearningNow({ session_id: args.session, project_id: args.project,
      lines, sequence: Number(args.seq || 0) || undefined, min_sequence: Number(args["min-seq"] || 0) || undefined })));
  } else if (cmd === "learning-explain") {
    const m = await import("./learningEngine.js");
    console.log(JSON.stringify(await m.learningExplain({ project_id: args.project,
      learning_id: args.id, pattern_id: args.pattern })));
  } else if (cmd === "learning-advice") {
    const m = await import("./learningEngine.js");
    console.log(JSON.stringify(await m.learningAdvice({ project_id: args.project,
      query: args.prompt || args.query || "", limit: Number(args.limit || 8) })));
  } else if (cmd === "learning-maintenance") {
    const m = await import("./learningEngine.js");
    console.log(JSON.stringify(await m.learningMaintenance({ project_id: args.project,
      apply: args.apply === true || args.apply === "true", limit: Number(args.limit || 50) })));
  } else if (cmd === "learning-feedback") {
    const m = await import("./learningPipeline.js");
    console.log(JSON.stringify(await m.recordFeedback({ project_id: args.project, learning_id: args.id,
      pattern_id: args.pattern, session_id: args.session, verdict: args.verdict || "corrected",
      explicit_feedback: args.explicit === true || args.explicit === "true", reason: args.reason || "",
      evidence: args.evidence ? String(args.evidence).split("|") : [] })));
  } else if (cmd === "learning-feedback-apply") {
    const m = await import("./learningPipeline.js");
    console.log(JSON.stringify(await m.applyFeedback({ feedback_id: Number(args.id),
      project_id: args.project, actor: args.actor || "operator" })));
  } else if (cmd === "learning-patterns") {
    const m = await import("./learningIntelligence.js");
    console.log(JSON.stringify(await m.getPatterns({ project_id: args.project, kind: args.kind,
      status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "learning-records") {
    const m = await import("./learningExperience.js");
    console.log(JSON.stringify(await m.getLearningExperiences({ project_id: args.project,
      category: args.category, status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "learning-pipeline-status") {
    const m = await import("./learningPipeline.js");
    console.log(JSON.stringify(await m.learningPipelineStatus({ project_id: args.project,
      status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "learning-pipeline-retry") {
    const m = await import("./learningPipeline.js");
    console.log(JSON.stringify(await m.retryLearningPipeline({ limit: Number(args.limit || 20) })));
  } else if (cmd === "memory-lifecycle-status") {
    const m = await import("./memoryLifecycle.js");
    console.log(JSON.stringify(await m.getLifecycleStatus({ project_id: args.project, memory_id: args.id })));
  } else if (cmd === "memory-lifecycle-maintenance") {
    const m = await import("./memoryLifecycle.js");
    console.log(JSON.stringify(await m.runLifecycleMaintenance({ project_id: args.project,
      limit: Number(args.limit || 50), dry_run: args.apply ? false : true, actor: args.actor || "operator" })));
  } else if (cmd === "memory-lifecycle-report") {
    const m = await import("./memoryLifecycle.js");
    console.log(JSON.stringify(await m.lifecycleMaintenanceStatus({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "memory-version-history") {
    const m = await import("./memoryRecovery.js");
    console.log(JSON.stringify(await m.getVersionHistory({ memory_id: args.id, project_id: args.project })));
  } else if (cmd === "memory-restore-version") {
    const m = await import("./memoryRecovery.js");
    console.log(JSON.stringify(await m.restoreVersion({ memory_id: args.id, project_id: args.project,
      version: Number(args.version), explicit: args.explicit === true || args.explicit === "true",
      actor: args.actor || "operator", reason: args.reason || "" })));
  } else if (cmd === "memory-archive-safe") {
    const m = await import("./memoryRecovery.js");
    console.log(JSON.stringify(await m.archiveMemorySafe({ memory_id: args.id, project_id: args.project,
      actor: args.actor || "operator", reason: args.reason || "",
      override: args.override === true || args.override === "true" })));
  } else if (cmd === "memory-restore-archived") {
    const m = await import("./memoryRecovery.js");
    console.log(JSON.stringify(await m.restoreArchived({ memory_id: args.id, project_id: args.project,
      actor: args.actor || "operator" })));
  } else if (cmd === "memory-importance-explain") {
    const m = await import("./memoryImportance.js");
    console.log(JSON.stringify(await m.explainImportance({ memory_id: args.id, project_id: args.project })));
  } else if (cmd === "memory-freshness") {
    const m = await import("./memoryImportance.js");
    console.log(JSON.stringify(await m.getFreshnessReviews({ project_id: args.project,
      memory_id: args.id, limit: Number(args.limit || 50) })));
  } else if (cmd === "memory-consolidation-candidates") {
    const m = await import("./memoryConsolidation.js");
    console.log(JSON.stringify(await m.findCandidates({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "memory-contradictions") {
    const m = await import("./memoryConsolidation.js");
    console.log(JSON.stringify(await m.reviewContradictions({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "session-understanding-run") {
    const m = await import("./sessionUnderstanding.js");
    console.log(JSON.stringify(await m.runSessionUnderstanding({ session_id: args.session,
      project_id: args.project, sequence: Number(args.seq || 0) || undefined,
      min_sequence: Number(args["min-seq"] || 0) || undefined })));
  } else if (cmd === "session-continuity") {
    const m = await import("./developmentGoal.js");
    console.log(JSON.stringify(args.goal
      ? await m.getGoals({ project_id: args.project, limit: Number(args.limit || 50) })
      : await m.getGoalContinuity({ project_id: args.project, limit: Number(args.limit || 20) })));
  } else if (cmd === "session-experiences") {
    const m = await import(args.debugging ? "./debuggingExperience.js" : "./experienceStore.js");
    console.log(JSON.stringify(args.debugging
      ? await m.getDebuggingExperiences({ project_id: args.project,
        problem_query: args.query || "", limit: Number(args.limit || 20) })
      : await m.getExperiences({ project_id: args.project, kind: args.kind,
        status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-inject") {
    const r = await prepareContext({ project_id: args.project, session_id: args.session || null,
      query: args.prompt || args.query || "", budget_chars: Number(args.budget || 4000) });
    console.log(args.json ? JSON.stringify(r) : r.context);
  } else if (cmd === "context-task") {
    const m = await import("./taskClassifier.js");
    console.log(JSON.stringify(await m.classifyTask({ query: args.prompt || args.query || "",
      project_id: args.project, session_id: args.session })));
  } else if (cmd === "context-injection-report") {
    const m = await import("./injectionAudit.js");
    console.log(JSON.stringify(await m.injectionReport({ project_id: args.project,
      session_id: args.session, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-project") {
    console.log(JSON.stringify(await contextIntel.getProjectContext({ project_id: args.project, limit: Number(args.limit || 100) })));
  } else if (cmd === "context-project-upsert") {
    const facts = args.facts ? JSON.parse(fs.readFileSync(args.facts, "utf8")) : [];
    console.log(JSON.stringify(await contextIntel.upsertProjectContext({ project_id: args.project, facts,
      summary: args.summary, source: args.source, source_session: args.session })));
  } else if (cmd === "context-decisions") {
    console.log(JSON.stringify(await decisionIntel.getDecisions({ project_id: args.project,
      query: args.query || "", status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-decision-record") {
    const body = args.file ? JSON.parse(fs.readFileSync(args.file, "utf8")) : {
      title: args.title, description: args.description, reasoning: args.reasoning,
      alternatives: args.alternatives ? String(args.alternatives).split("|") : [],
      consequences: args.consequences ? String(args.consequences).split("|") : [],
      evidence: args.evidence ? String(args.evidence).split("|") : [],
      confidence: args.confidence ? Number(args.confidence) : null,
      source_session: args.session, supersedes: args.supersedes,
    };
    console.log(JSON.stringify(await decisionIntel.recordDecision({ ...body, project_id: args.project || body.project_id })));
  } else if (cmd === "context-relationships") {
    console.log(JSON.stringify(await relationshipIntel.getRelationships({ project_id: args.project,
      subject_type: args.type, subject_id: args.id, direction: args.direction || "both",
      relation_type: args.relation, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-retrieve") {
    const r = await contextRetrieval.retrieveTaskContext({ project_id: args.project,
      query: args.prompt || args.query || "", session_id: args.session,
      limit: Number(args.limit || 8), budget_chars: Number(args.budget || 4000) });
    console.log(args.json ? JSON.stringify(r) : (r.context || ""));
  } else if (cmd === "context-quality") {
    console.log(JSON.stringify(args.subject && args.id
      ? await knowledgeQuality.getQuality({ project_id: args.project, subject_type: args.subject, subject_id: args.id })
      : await knowledgeQuality.freshnessReport({ project_id: args.project, older_than_days: Number(args.days || 30) })));
  } else if (cmd === "context-updates") {
    console.log(JSON.stringify(await contextUpdate.contextUpdateStatus({ project_id: args.project,
      status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "context-update-run") {
    const lines = args.lines ? JSON.parse(fs.readFileSync(args.lines, "utf8")) : undefined;
    console.log(JSON.stringify(await contextUpdate.runContextUpdate({ session_id: args.session,
      project_id: args.project, transcript_lines: lines,
      sequence: Number(args.seq || 0) || undefined,
      min_sequence: Number(args["min-seq"] || 0) || undefined })));
  } else if (cmd === "context-audit") {
    console.log(JSON.stringify({ ok: (await pipelineAudit.auditPipelineIntegrity()).ok,
      wiring: pipelineAudit.auditPipelineIntegrity().summary,
      sources: pipelineAudit.auditPipelineIntegrity().sources.phase17 }));
  } else if (cmd === "maintenance-issues") {
    console.log(JSON.stringify(await gov.staleDuplicateContradictionReport({ project_id: args.project })));
  } else if (cmd === "workflow-templates") {
    const m = await import("./workflowTemplates.js");
    console.log(JSON.stringify(await m.listTemplates()));
  } else if (cmd === "workflow-create") {
    const m = await import("./controlledWorkflow.js");
    let scope = {};
    if (args.scope) { try { scope = JSON.parse(args.scope); } catch { scope = {}; } }
    console.log(JSON.stringify(await m.createWorkflow({ project_id: args.project,
      template: args.template, objective: args.prompt || args.objective || "", scope,
      risk: args.risk, mode: args.mode, source_ref: args["source-ref"] || args.source,
      created_by: args["created-by"], plan_id: args.plan,
      plan_version: args.version, plan_hash: args.hash })));
  } else if (cmd === "workflow-approve") {
    const m = await import("./controlledWorkflow.js");
    let scope = {};
    if (args.scope) { try { scope = JSON.parse(args.scope); } catch { scope = {}; } }
    console.log(JSON.stringify(await m.approve({ project_id: args.project,
      plan_id: args.plan, plan_version: args.version, plan_hash: args.hash, scope,
      mode: args.mode, risk: args.risk, approved_by: args["approved-by"],
      expires_in_ms: Number(args["expires-in-ms"] || 0) || undefined })));
  } else if (cmd === "workflow-approvals") {
    const m = await import("./workflowApproval.js");
    console.log(JSON.stringify(await m.listApprovals({ project_id: args.project,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "workflow-dispatch") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.dispatch({ project_id: args.project, run_id: args.run,
      approval_id: args.approval, token: args.token, mode: args.mode,
      max_parallel: Number(args.parallel || 4), dry_run: args["dry-run"] === undefined
        ? true : (args["dry-run"] === true || args["dry-run"] === "true") })));
  } else if (cmd === "workflow-status") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.status({ project_id: args.project, run_id: args.run,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "workflow-validate") {
    const m = await import("./controlledWorkflow.js");
    const checks = args.checks ? JSON.parse(fs.readFileSync(args.checks, "utf8")) : [];
    console.log(JSON.stringify(await m.validate({ project_id: args.project, run_id: args.run,
      task_key: args.task, checks, evidence_class: args.evidence,
      process_ok: args["process-ok"] === true || args["process-ok"] === "true" })));
  } else if (cmd === "workflow-recover") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.recover({ project_id: args.project, run_id: args.run,
      approval_id: args.approval, token: args.token,
      max_attempts: Number(args["max-attempts"] || 2), dry_run: args["dry-run"] !== "false" })));
  } else if (cmd === "workflow-test") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.test({ project_id: args.project, run_id: args.run,
      task_key: args.task, mode: args.mode, test_command: args["test-command"],
      dry_run: args["dry-run"] !== "false", db_name: args.db })));
  } else if (cmd === "workflow-feedback") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.feedback({ project_id: args.project, run_id: args.run })));
  } else if (cmd === "workflow-report") {
    const m = await import("./controlledWorkflow.js");
    console.log(JSON.stringify(await m.report({ project_id: args.project, run_id: args.run,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "code-index") {
    const m = await import("./codeIntelligence.js");
    let options = {};
    if (args.options) { try { options = JSON.parse(args.options); } catch { options = {}; } }
    console.log(JSON.stringify(await m.indexProject({ project_id: args.project,
      root: args.root, options })));
  } else if (cmd === "code-status") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.indexStatus({ project_id: args.project, root: args.root,
      limit: Number(args.limit || 10) })));
  } else if (cmd === "code-search") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.searchSymbols({ project_id: args.project, query: args.query || "",
      symbol_type: args.type, path: args.path, limit: Number(args.limit || 50) })));
  } else if (cmd === "code-symbol") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.symbol({ project_id: args.project, symbol_key: args.key || args.symbol })));
  } else if (cmd === "code-relationships") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.relationships({ project_id: args.project, symbol_key: args.key || args.symbol,
      direction: args.direction, type: args.type, limit: Number(args.limit || 50),
      build: args.build === true || args.build === "true", root: args.root })));
  } else if (cmd === "code-graph") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.graph({ project_id: args.project, symbol_key: args.key || args.symbol,
      max_depth: Number(args.depth || 3), max_nodes: Number(args.nodes || 100) })));
  } else if (cmd === "code-module") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.module({ project_id: args.project, path: args.path })));
  } else if (cmd === "code-impact") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.impact({ project_id: args.project, root: args.root,
      change: args.change ? JSON.parse(fs.readFileSync(args.change, "utf8")) : { path: args.path },
      limit: Number(args.limit || 50) })));
  } else if (cmd === "code-freshness") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.freshness({ project_id: args.project, root: args.root })));
  } else if (cmd === "code-tests") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.tests({ project_id: args.project, root: args.root,
      build: args.build === true || args.build === "true", path: args.path,
      symbol_key: args.key || args.symbol, limit: Number(args.limit || 50) })));
  } else if (cmd === "code-test-recommend") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.recommendTests({ project_id: args.project, root: args.root,
      change: args.change ? JSON.parse(fs.readFileSync(args.change, "utf8")) : { path: args.path },
      limit: Number(args.limit || 30) })));
  } else if (cmd === "code-review") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.review({ project_id: args.project, root: args.root,
      change: args.change ? JSON.parse(fs.readFileSync(args.change, "utf8")) : { path: args.path },
      limit: Number(args.limit || 50) })));
  } else if (cmd === "code-contracts") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.contracts({ project_id: args.project, root: args.root,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "code-report") {
    const m = await import("./codeIntelligence.js");
    console.log(JSON.stringify(await m.report({ project_id: args.project, root: args.root,
      change: args.change ? JSON.parse(fs.readFileSync(args.change, "utf8")) : undefined,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-status") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.status({ project_id: args.project, limit: Number(args.limit || 20) })));
  } else if (cmd === "project-goals") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.goals({ project_id: args.project, op: args.op || "list",
      title: args.title, goal_id: args.goal, status: args.status, goal_type: args.type,
      provenance: args.provenance, success_criteria: args.criteria ? JSON.parse(args.criteria) : undefined,
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      actor: args.actor, patch: args.patch ? JSON.parse(args.patch) : undefined,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-milestones") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.milestones({ project_id: args.project, op: args.op || "list",
      milestone_key: args.key || args.milestone, title: args.title, goal_id: args.goal,
      success_criteria: args.criteria ? JSON.parse(args.criteria) : undefined,
      status: args.status, evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      actor: args.actor, priority: Number(args.priority || 0), limit: Number(args.limit || 50) })));
  } else if (cmd === "project-progress") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.progress({ project_id: args.project, op: args.op || "compute",
      snapshot_key: args.key, goal_id: args.goal, milestone_id: args.milestone, task_id: args.task,
      session_id: args.session, status: args.status,
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-dependencies") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.dependencies({ project_id: args.project, op: args.op || "analyze",
      node_type: args.type, node_id: args.id, from_type: args.from, from_id: args["from-id"],
      to_type: args.to, to_id: args["to-id"], dependency_type: args["dep-type"],
      max_depth: Number(args.depth || 3), max_nodes: Number(args.nodes || 100),
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-blockers") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.blockers({ project_id: args.project, op: args.op || "list",
      blocker_key: args.key || args.blocker, title: args.title, description: args.description,
      severity: args.severity, category: args.category, status: args.status,
      affected_goals: args.goals ? JSON.parse(args.goals) : undefined,
      affected_milestones: args.milestones ? JSON.parse(args.milestones) : undefined,
      affected_tasks: args.tasks ? JSON.parse(args.tasks) : undefined,
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      actor: args.actor, limit: Number(args.limit || 50) })));
  } else if (cmd === "project-briefing") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.briefing({ project_id: args.project, op: args.op || "build",
      session_id: args.session, limit: Number(args.limit || 20) })));
  } else if (cmd === "project-drift") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.drift({ project_id: args.project, op: args.op || "analyze",
      finding_key: args.key, status: args.status, actor: args.actor,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-ownership") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.ownership({ project_id: args.project, op: args.op || "overview",
      task_id: args.task, agent: args.agent, assignment_reason: args.reason,
      status: args.status, evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      actor: args.actor, limit: Number(args.limit || 50) })));
  } else if (cmd === "project-recovery") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.recovery({ project_id: args.project, op: args.op || "assess",
      task_id: args.task, run_id: args.run, approval_id: args.approval, token: args.token,
      limit: Number(args.limit || 50) })));
  } else if (cmd === "project-next-actions") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.nextActions({ project_id: args.project,
      limit: Number(args.limit || 10) })));
  } else if (cmd === "project-report") {
    const m = await import("./projectManagement.js");
    console.log(JSON.stringify(await m.report({ project_id: args.project, limit: Number(args.limit || 20) })));
  } else if (cmd === "adapt-outcome") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.ingestOutcome({ project_id: args.project,
      source_type: args.type, source_id: args.id, subsystem: args.subsystem,
      observation: args.observation, expected_outcome: args.expected ? JSON.parse(args.expected) : undefined,
      actual_outcome: args.actual ? JSON.parse(args.actual) : undefined,
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      actor: args.actor })));
  } else if (cmd === "adapt-recommendation") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.evaluateRecommendation({ project_id: args.project,
      recommendation_type: args.type, recommendation_id: args.id,
      original: args.original ? JSON.parse(fs.readFileSync(args.original, "utf8")) : undefined,
      reason: args.reason, evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      confidence: Number(args.confidence || 0) || undefined,
      operator_decision: args.decision, action_occurred: args["action-occurred"] === "true",
      result_verified: args["result-verified"] === "true", observed_outcome: args.outcome })));
  } else if (cmd === "adapt-prediction") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.evaluatePrediction({ project_id: args.project,
      prediction_type: args.type, prediction_id: args.id,
      predicted: args.predicted ? JSON.parse(fs.readFileSync(args.predicted, "utf8")) : undefined,
      confidence: Number(args.confidence || 0) || undefined, prediction_time: args.time,
      observation_window: args.window, actual: args.actual ? JSON.parse(fs.readFileSync(args.actual, "utf8")) : undefined,
      verification_evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined })));
  } else if (cmd === "adapt-decomposition") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.evaluateDecomposition({ project_id: args.project, plan_id: args.plan,
      task_count: Number(args.tasks || 0), dependency_count: Number(args.deps || 0),
      ownership_conflicts: Number(args.conflicts || 0), review_failures: Number(args["review-failures"] || 0),
      rework_count: Number(args.rework || 0), completion_verified: args.verified === "true",
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined })));
  } else if (cmd === "adapt-agent") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.agentSuitability({ project_id: args.project, agent: args.agent,
      task_category: args.category, min_samples: Number(args["min-samples"] || 5) })));
  } else if (cmd === "adapt-retrieval") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.retrievalUsefulness({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "adapt-failures") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.failurePatterns({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "adapt-quality") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.learningQuality({ project_id: args.project, limit: Number(args.limit || 50) })));
  } else if (cmd === "adapt-propose") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.proposeCalibration({ project_id: args.project, proposal_key: args.key,
      target_subsystem: args.target, current_behavior: args.current ? JSON.parse(args.current) : undefined,
      proposed_behavior: args.proposed ? JSON.parse(args.proposed) : undefined, reason: args.reason,
      evidence: args.evidence ? JSON.parse(fs.readFileSync(args.evidence, "utf8")) : undefined,
      sample_size: Number(args["sample-size"] || 0), confidence: Number(args.confidence || 0) || undefined,
      expected_benefit: args.benefit, potential_downside: args.downside, reversal: args.reversal })));
  } else if (cmd === "adapt-review-calibration") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.reviewCalibration({ project_id: args.project, proposal_id: args.id,
      decision: args.decision, actor: args.actor })));
  } else if (cmd === "adapt-apply-calibration") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.applyCalibration({ project_id: args.project, proposal_id: args.id, actor: args.actor })));
  } else if (cmd === "adapt-rollback-calibration") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.rollbackCalibration({ project_id: args.project, proposal_id: args.id, actor: args.actor })));
  } else if (cmd === "adapt-proposals") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.proposals({ project_id: args.project, status: args.status, limit: Number(args.limit || 50) })));
  } else if (cmd === "adapt-report") {
    const m = await import("./adaptiveIntelligence.js");
    console.log(JSON.stringify(await m.report({ project_id: args.project, window: args.window, limit: Number(args.limit || 50) })));
  } else if (cmd === "ops-health") {
    const m = await import("./operationalHealth.js");
    console.log(JSON.stringify(await m.operationalHealth({ project_id: args.project, limit: Number(args.limit || 20) })));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(String(e?.message || e));
  process.exitCode = 1;
} finally {
  await core.close();
}
