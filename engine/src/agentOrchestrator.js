// Phase 22 facade: planning, coordination and evaluation layer around the real
// OpenCode agent capabilities. It never executes arbitrary code itself and never
// replaces OpenCode's native agent runtime. All capabilities are optional and
// dynamically loaded so a failure degrades without breaking existing behavior.
import * as core from "./core.js";

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

/**
 * Produce an orchestration plan (no execution). Execution is handed to supported
 * OpenCode interfaces (subagent tool / `opencode run --agent`) by the caller.
 */
export async function orchestrate({ project_id, session_id, request, context = {}, max_tasks = 12 } = {}) {
  if (!project_id || project_id === "_global" || !request) {
    return { ok: false, reason: "valid project_id and request required" };
  }
  const degraded = [];
  const [decomp, registry, conflicts] = await Promise.all([
    load("taskDecomposition"), load("agentRegistry"), load("agentConflicts"),
  ]);
  if (!decomp?.decomposeTask) return { ok: false, reason: "task decomposition unavailable" };
  let plan = await decomp.decomposeTask({ project_id, session_id, request, context, max_tasks });
  if (!plan.ok) return plan;
  if (Array.isArray(plan.degraded)) degraded.push(...plan.degraded);

  const saved = decomp.savePlan
    ? await decomp.savePlan({ project_id, session_id, request, tasks: plan.tasks,
        context_refs: Array.isArray(context.refs) ? context.refs : [] })
    : { ok: false, reason: "plan persistence unavailable" };
  if (!saved.ok) return { ...plan, ok: false, reason: saved.reason, degraded };

  let assignments = [];
  if (registry?.discoverAgents && registry?.selectAgents) {
    try {
      const agents = await registry.discoverAgents();
      const sel = await registry.selectAgents({ tasks: plan.tasks, agents: agents.agents || [],
        history: Array.isArray(context.history) ? context.history : [], project_id,
        max_parallel: Math.min(4, Number(context.max_parallel || 4)) });
      assignments = sel.assignments || [];
      if (Array.isArray(sel.degraded)) degraded.push(...sel.degraded);
    } catch (e) { degraded.push(`agent selection: ${String(e?.message || e).slice(0, 120)}`); }
  } else degraded.push("agentRegistry: unavailable");

  let conflictReport = { ok: true, conflicts: [] };
  if (conflicts?.detectConflicts) {
    try { conflictReport = await conflicts.detectConflicts({ plan_id: saved.plan_id, project_id }); }
    catch (e) { degraded.push(`conflict detection: ${String(e?.message || e).slice(0, 120)}`); }
  }

  try {
    await core.audit("agent.orchestration_plan", project_id, {
      plan_id: saved.plan_id, tasks: plan.tasks.length,
      assignments: assignments.length, conflicts: conflictReport.conflicts?.length || 0,
      degraded,
    });
  } catch { /* best effort */ }

  return { ok: true, plan_id: saved.plan_id, project_id, session_id: session_id || null,
    tasks: plan.tasks, assignments, conflicts: conflictReport.conflicts || [],
    created_tasks: saved.created_tasks, warnings: plan.warnings || [], degraded,
    note: "Plan prepared only. Actual agent execution uses OpenCode subagent/CLI interfaces and requires the caller." };
}

export async function planStatus({ plan_id, project_id } = {}) {
  const [decomp, coord] = await Promise.all([load("taskDecomposition"), load("agentCoordination")]);
  if (!decomp?.getPlan) return { ok: false, reason: "task decomposition unavailable" };
  const plan = await decomp.getPlan({ plan_id, project_id });
  if (!plan.ok) return plan;
  let executions = { ok: true, items: [] };
  if (coord?.executionStatus) {
    try { executions = await coord.executionStatus({ plan_id, project_id }); }
    catch { /* optional */ }
  }
  const tasks = decomp.getTasks ? await decomp.getTasks({ plan_id, project_id, limit: 100 }) : { items: [] };
  return { ok: true, plan: plan.plan || plan, tasks: tasks.items || tasks.tasks || [],
    executions: executions.items || [], degraded: executions.degraded || [] };
}

export async function orchestrationReport({ plan_id, project_id } = {}) {
  const [validation, integration, learning] = await Promise.all([
    load("agentValidation"), load("agentIntegration"), load("agentWorkflowLearning"),
  ]);
  const reports = { ok: true, plan_id, project_id, reviews: [], integration: null, learning: null, degraded: [] };
  if (validation?.getReviews) {
    try { const r = await validation.getReviews({ plan_id, project_id, limit: 100 }); reports.reviews = r.items || []; }
    catch (e) { reports.degraded.push(`reviews: ${String(e?.message || e).slice(0, 100)}`); }
  }
  if (integration?.integrateResults) {
    try { reports.integration = await integration.integrateResults({ plan_id, project_id }); }
    catch (e) { reports.degraded.push(`integration: ${String(e?.message || e).slice(0, 100)}`); }
  }
  if (learning?.agentPerformance) {
    try {
      const roster = await load("agentRegistry");
      const agents = roster?.discoverAgents ? (await roster.discoverAgents()).agents || [] : [];
      const perAgent = [];
      for (const a of agents.slice(0, 5)) {
        const perf = await learning.agentPerformance({ project_id, agent: a.name, limit: 20 });
        if (perf?.ok) perAgent.push({ agent: a.name, ...perf });
      }
      reports.learning = { ok: true, per_agent: perAgent,
        note: "Per-agent execution/verification counts only; claims are never verified outcomes." };
    } catch (e) { reports.degraded.push(`performance: ${String(e?.message || e).slice(0, 100)}`); }
  }
  return reports;
}

export async function resumePlan({ plan_id, project_id } = {}) {
  const coord = await load("agentCoordination");
  if (!coord?.retryFailed) return { ok: false, reason: "coordination unavailable" };
  return coord.retryFailed({ plan_id, project_id, limit: 20 });
}

export async function explainSelection({ plan_id, task_id, project_id } = {}) {
  const plan = await planStatus({ plan_id, project_id });
  if (!plan.ok) return plan;
  const task = (plan.tasks || []).find((t) => t.id === task_id || t.task_key === task_id);
  if (!task) return { ok: false, reason: "task not found in plan" };
  return { ok: true, project_id, plan_id, task: task.title, agent: task.assigned_agent || null,
    reason: task.assignment_reason || "assignment recorded in plan",
    capabilities: Array.isArray(task.required_capabilities) ? task.required_capabilities : [],
    note: "Agent selection is deterministic and explainable; no hidden model call." };
}

export default { orchestrate, planStatus, orchestrationReport, resumePlan, explainSelection };
