// Phase 26 facade: long-term project management intelligence. Composes existing
// Phase 18-25 systems; it is NOT a second memory/learning/orchestration/risk/
// workflow engine. LEVEL 1 and HARNESS_SEMANTIC_LLM=0 unchanged. Analysis and
// preparation only: no auto-approval, no dispatch, no source rewrite.
async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}
const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const validProject = (p) => typeof p === "string" && p.trim() && p !== "_global";

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

/** Unified project status assembled from authoritative records. */
export async function status({ project_id, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const [goals, milestones, blockers, progress] = await Promise.all([
    call("developmentGoal", "getGoals", { project_id, limit: 20 }, "goals", degraded),
    call("projectMilestones", "listMilestones", { project_id, limit: 20 }, "milestones", degraded),
    call("projectBlockers", "listBlockers", { project_id, limit: 20 }, "blockers", degraded),
    call("projectProgress", "computeProgress", { project_id }, "progress", degraded),
  ]);
  await audit("p26.status", project_id, { ok: true });
  return { ok: true, project_id,
    goals: goals?.goals || [], milestones: milestones?.items || milestones?.milestones || [],
    blockers: blockers?.items || [], progress: progress || null, degraded,
    note: "Record-based status. Unknown means insufficient evidence, not healthy." };
}

export async function goals(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "list";
  const m = "projectGoals";
  let r;
  if (op === "create") r = await call(m, "recordGoalExtended", args, "goals.create", degraded);
  else if (op === "state") r = await call(m, "setGoalState", args, "goals.state", degraded);
  else if (op === "update") r = await call(m, "updateGoalDetails", args, "goals.update", degraded);
  else if (op === "detail") r = await call(m, "getGoalDetail", args, "goals.detail", degraded);
  else if (op === "history") r = await call(m, "getGoalHistory", args, "goals.history", degraded);
  else r = await call(m, "listGoals", args, "goals.list", degraded);
  await audit("p26.goals", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "goal management unavailable", degraded };
}

export async function milestones(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "list";
  const m = "projectMilestones";
  let r;
  if (op === "create") r = await call(m, "recordMilestone", args, "milestones.create", degraded);
  else if (op === "state") r = await call(m, "setMilestoneStatus", args, "milestones.state", degraded);
  else if (op === "progress") r = await call(m, "milestoneProgress", args, "milestones.progress", degraded);
  else if (op === "get") r = await call(m, "getMilestone", args, "milestones.get", degraded);
  else r = await call(m, "listMilestones", args, "milestones.list", degraded);
  await audit("p26.milestones", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "milestone management unavailable", degraded };
}

export async function progress(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "compute";
  const m = "projectProgress";
  let r;
  if (op === "record") r = await call(m, "recordSnapshot", args, "progress.record", degraded);
  else if (op === "history") r = await call(m, "progressHistory", args, "progress.history", degraded);
  else if (op === "list") r = await call(m, "getProgress", args, "progress.list", degraded);
  else r = await call(m, "computeProgress", args, "progress.compute", degraded);
  await audit("p26.progress", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "progress tracking unavailable", degraded };
}

export async function dependencies(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "analyze";
  const m = "projectDependencies";
  let r;
  if (op === "record") r = await call(m, "recordDependency", args, "deps.record", degraded);
  else if (op === "list") r = await call(m, "getDependencies", args, "deps.list", degraded);
  else if (op === "cycles") r = await call(m, "detectCycles", args, "deps.cycles", degraded);
  else r = await call(m, "analyzeDependencies", args, "deps.analyze", degraded);
  await audit("p26.dependencies", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "dependency analysis unavailable", degraded };
}

export async function blockers(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "list";
  const m = "projectBlockers";
  let r;
  if (op === "record") r = await call(m, "recordBlocker", args, "blockers.record", degraded);
  else if (op === "state") r = await call(m, "setBlockerStatus", args, "blockers.state", degraded);
  else if (op === "resolve") r = await call(m, "resolveBlocker", args, "blockers.resolve", degraded);
  else if (op === "risks") r = await call(m, "assessRisks", args, "blockers.risks", degraded);
  else r = await call(m, "listBlockers", args, "blockers.list", degraded);
  await audit("p26.blockers", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "blocker management unavailable", degraded };
}

export async function briefing(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "build";
  const m = "projectContinuity";
  const r = op === "save"
    ? await call(m, "saveBriefing", args, "briefing.save", degraded)
    : op === "latest"
      ? await call(m, "getLatestBriefing", args, "briefing.latest", degraded)
      : await call(m, "buildBriefing", args, "briefing.build", degraded);
  await audit("p26.briefing", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "continuity briefing unavailable", degraded };
}

export async function drift(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "analyze";
  const m = "projectDrift";
  const r = op === "list" ? await call(m, "listDrift", args, "drift.list", degraded)
    : op === "state" ? await call(m, "setDriftStatus", args, "drift.state", degraded)
      : await call(m, "analyzeDrift", args, "drift.analyze", degraded);
  await audit("p26.drift", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "drift analysis unavailable", degraded };
}

export async function ownership(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "overview";
  const m = "projectOwnership";
  const r = op === "assign" ? await call(m, "assignOwner", args, "ownership.assign", degraded)
    : op === "state" ? await call(m, "setOwnershipState", args, "ownership.state", degraded)
      : op === "get" ? await call(m, "getOwnership", args, "ownership.get", degraded)
        : await call(m, "ownershipOverview", args, "ownership.overview", degraded);
  await audit("p26.ownership", args.project_id, { op, ok: !!r?.ok });
  return r || { ok: false, reason: "ownership tracking unavailable", degraded };
}

export async function recovery(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const op = args.op || "assess";
  const m = "projectRecovery";
  const r = op === "prepare" ? await call(m, "prepareRecovery", args, "recovery.prepare", degraded)
    : await call(m, "assessRecovery", args, "recovery.assess", degraded);
  await audit("p26.recovery", args.project_id, { op, ok: !!r?.ok, can_resume: !!r?.can_resume });
  return r || { ok: false, reason: "recovery assessment unavailable", degraded };
}

export async function nextActions(args = {}) {
  if (!validProject(args.project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const r = await call("nextBestAction", "recommend", args, "nextActions", degraded);
  await audit("p26.next_actions", args.project_id, { count: r?.recommendations?.length || 0 });
  return r || { ok: false, reason: "next-action intelligence unavailable", degraded };
}

/** Unified report with explicit freshness, evidence, unknowns and limitations. */
export async function report({ project_id, limit } = {}) {
  if (!validProject(project_id)) return { ok: false, reason: "valid project_id required" };
  const degraded = [];
  const [st, br, dr, nx, own] = await Promise.all([
    status({ project_id, limit: 10 }),
    briefing({ project_id, op: "latest" }),
    drift({ project_id, op: "list", limit: 20 }),
    nextActions({ project_id, limit: 10 }),
    ownership({ project_id, op: "overview", limit: 10 }),
  ]);
  return {
    ok: true, project_id,
    project_status: { goals: (st.goals || []).length, milestones: (st.milestones || []).length,
      blockers: (st.blockers || []).length, progress: st.progress || null },
    continuity: { available: !!br?.briefing, freshness: br?.freshness || null,
      sections: br?.briefing ? Object.keys(br.briefing) : [] },
    drift: { findings: dr?.items || dr?.findings || [], count: (dr?.items || dr?.findings || []).length },
    next_actions: { recommendations: nx?.recommendations || [], tied: nx?.candidates_tied || [] },
    ownership: { overview: own?.counts || own?.items || null },
    degraded: [...(st.degraded || []), ...(br?.degraded || []), ...(dr?.degraded || []),
      ...(nx?.degraded || []), ...(own?.degraded || []), ...degraded],
    claim: "Record-based evidence only; not runtime proof; no execution was performed.",
    note: "Unknown means insufficient evidence. No goal, task or workflow was changed by this report.",
  };
}

export default { status, goals, milestones, progress, dependencies, blockers, briefing,
  drift, ownership, recovery, nextActions, report };
