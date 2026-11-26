// Phase 26 — projectDrift + nextBestAction tests.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network,
// unique project ids per test, no destructive assertions outside test-owned ids.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase26-nextaction.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const drift = await import("../src/projectDrift.js");
const nba = await import("../src/nextBestAction.js");

const { analyzeDrift, listDrift, setDriftStatus, DRIFT_RULES, DRIFT_CATEGORIES, DRIFT_STATUSES } = drift;
const { recommend, RULES, ACTION_KINDS } = nba;

const uid = () => crypto.randomUUID();
const projects = new Set();
const uniq = (prefix = "p26") => {
  const p = `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  projects.add(p);
  return p;
};

// Defensive DDL: no-ops when migration 024 is already applied.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_milestone (
      id uuid PRIMARY KEY, project_id text NOT NULL, milestone_key text NOT NULL,
      goal_id text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '', success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      priority integer NOT NULL DEFAULT 0, target_date timestamptz, status text NOT NULL DEFAULT 'planned',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, created_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, milestone_key))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_blocker (
      id uuid PRIMARY KEY, project_id text NOT NULL, blocker_key text NOT NULL,
      title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
      severity text NOT NULL DEFAULT 'medium', category text NOT NULL DEFAULT 'technical',
      status text NOT NULL DEFAULT 'identified', affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
      affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb, affected_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, owner text NOT NULL DEFAULT '',
      resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, blocker_key))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_drift_finding (
      id uuid PRIMARY KEY, project_id text NOT NULL, finding_key text NOT NULL,
      category text NOT NULL DEFAULT 'other', severity text NOT NULL DEFAULT 'low',
      confidence real NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'open',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
      affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb, recommendation text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, finding_key))`);
});

// ---- seed helpers (test-owned project ids only) ----------------------------
async function insertGoal(project, over = {}) {
  const id = over.id || uid();
  await core.dbQuery(
    `INSERT INTO dev_goal (id, project_id, title, status, success_criteria, goal_type, priority)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [id, project, over.title ?? "Goal", over.status ?? "active",
      JSON.stringify(over.success_criteria ?? ["done"]), over.goal_type ?? "short_term", over.priority ?? 0]);
  return id;
}
async function insertTask(project, over = {}) {
  const id = over.id || uid();
  await core.dbQuery(
    `INSERT INTO dev_task (id, project_id, goal_id, task_key, title, status, evidence, dependencies, attempts, result_ref, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11)`,
    [id, project, over.goal_id ?? null, over.task_key ?? `t-${id.slice(0, 8)}`, over.title ?? "Task",
      over.status ?? "not_started", JSON.stringify(over.evidence ?? []),
      JSON.stringify(over.dependencies ?? []), over.attempts ?? 0,
      JSON.stringify(over.result_ref ?? {}), over.priority ?? 0]);
  return id;
}
async function insertMilestone(project, over = {}) {
  const id = over.id || uid();
  await core.dbQuery(
    `INSERT INTO pm_milestone (id, project_id, milestone_key, goal_id, title, success_criteria, target_date, status, priority)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [id, project, over.milestone_key ?? `m-${id.slice(0, 8)}`, over.goal_id ?? "", over.title ?? "Milestone",
      JSON.stringify(over.success_criteria ?? []), over.target_date ?? null, over.status ?? "planned", over.priority ?? 0]);
  return id;
}
async function insertBlocker(project, over = {}) {
  const id = over.id || uid();
  await core.dbQuery(
    `INSERT INTO pm_blocker (id, project_id, blocker_key, title, severity, status, affected_goals, affected_milestones, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
    [id, project, over.blocker_key ?? `b-${id.slice(0, 8)}`, over.title ?? "Blocker",
      over.severity ?? "high", over.status ?? "identified",
      JSON.stringify(over.affected_goals ?? []), JSON.stringify(over.affected_milestones ?? []),
      JSON.stringify(over.evidence ?? [])]);
  return id;
}
async function insertFinding(project, over = {}) {
  const id = over.id || uid();
  await core.dbQuery(
    `INSERT INTO pm_drift_finding (id, project_id, finding_key, category, severity, confidence, status, evidence, affected_goals, affected_milestones, recommendation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
    [id, project, over.finding_key ?? `f-${id.slice(0, 8)}`, over.category ?? "orphan_work",
      over.severity ?? "medium", over.confidence ?? 0.7, over.status ?? "open",
      JSON.stringify(over.evidence ?? []), JSON.stringify(over.affected_goals ?? []),
      JSON.stringify(over.affected_milestones ?? []), over.recommendation ?? "Review"]);
  return id;
}
async function insertDependency(project, over = {}) {
  await core.dbQuery(
    `INSERT INTO pm_dependency (project_id, from_type, from_id, to_type, to_id, dependency_type, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [project, over.from_type ?? "task", over.from_id, over.to_type ?? "task", over.to_id,
      over.dependency_type ?? "confirmed", over.confidence ?? 0.9]);
}
async function insertImpact(project, over = {}) {
  await core.dbQuery(
    `INSERT INTO code_analysis (id, project_id, analysis_type, change_ref, version_hash, result, confidence, status)
     VALUES ($1,$2,'impact',$3,$4,$5::jsonb,$6,'complete')`,
    [uid(), project, over.change_ref ?? uid(), over.version_hash ?? "v1",
      JSON.stringify(over.result ?? { stale: true }), over.confidence ?? 0.3]);
}
async function insertDecision(project, over = {}) {
  await core.dbQuery(
    `INSERT INTO technical_decision (id, project_id, title, status, evidence)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [over.id || uid(), project, over.title ?? "Use local cache", over.status ?? "active", JSON.stringify(["doc"])]);
}

const has = (arr, cat) => arr.some((f) => f.category === cat);

// ---------------------------------------------------------------------------
// 0. exports + frozen rule tables
// ---------------------------------------------------------------------------
test("0. exact exports exist and rule tables are frozen and complete", () => {
  for (const name of ["analyzeDrift", "listDrift", "setDriftStatus"]) {
    assert.equal(typeof drift[name], "function", `${name} must be a function`);
  }
  assert.equal(typeof recommend, "function");
  assert.equal(Object.isFrozen(DRIFT_RULES), true);
  assert.equal(Object.isFrozen(RULES), true);
  assert.equal(Object.isFrozen(RULES.order), true);
  assert.equal(Object.isFrozen(RULES.priority), true);
  assert.equal(Object.isFrozen(RULES.action_kind), true);
  assert.deepEqual([...RULES.order], ["blocker", "at_risk_milestone", "recovery", "ready_task", "drift_finding", "goal_without_work"]);
  assert.deepEqual([...DRIFT_CATEGORIES].sort(), [
    "architecture_effect", "decision_conflict", "goal_without_work", "missing_success_criteria",
    "orphan_work", "repeated_deferral", "scope_growth", "stale_milestone",
  ]);
  assert.deepEqual([...DRIFT_STATUSES], ["open", "acknowledged", "dismissed", "resolved"]);
  assert.deepEqual([...ACTION_KINDS], ["preparation", "execution"]);
  assert.equal(typeof drift.default.analyzeDrift, "function");
  assert.equal(typeof nba.default.recommend, "function");
});

// ---------------------------------------------------------------------------
// 1. orphan_work
// ---------------------------------------------------------------------------
test("1. drift detects orphan_work for an unfinished task with no active goal", async () => {
  const p = uniq("p26o");
  await insertGoal(p, { title: "Active goal" });
  const taskId = await insertTask(p, { task_key: "orphan-1", status: "not_started", goal_id: null });
  const r = await analyzeDrift({ project_id: p });
  assert.equal(r.ok, true, JSON.stringify(r.degraded));
  const f = r.findings.find((x) => x.category === "orphan_work");
  assert.ok(f, "orphan_work finding emitted");
  assert.match(f.finding_key, /^orphan_work:/);
  assert.ok(f.evidence.length >= 1 && f.evidence[0].excerpt.includes("orphan-1"));
  assert.deepEqual(f.affected_goals, []);
  assert.equal(f.status, "open");
  const row = (await core.dbQuery("SELECT status FROM pm_drift_finding WHERE project_id=$1 AND finding_key=$2", [p, f.finding_key])).rows[0];
  assert.equal(row.status, "open", "finding persisted");
  assert.equal(taskId.length > 0, true);
});

// ---------------------------------------------------------------------------
// 2. goal_without_work
// ---------------------------------------------------------------------------
test("2. drift detects goal_without_work for an active goal with no tasks", async () => {
  const p = uniq("p26g");
  const gid = await insertGoal(p, { title: "Lonely goal", success_criteria: ["verified"] });
  const r = await analyzeDrift({ project_id: p });
  assert.equal(r.ok, true);
  const f = r.findings.find((x) => x.category === "goal_without_work");
  assert.ok(f, "goal_without_work finding emitted");
  assert.deepEqual(f.affected_goals, [gid]);
  assert.match(f.recommendation, /Review this active goal/);
});

// ---------------------------------------------------------------------------
// 3. stale_milestone + missing_success_criteria
// ---------------------------------------------------------------------------
test("3. drift detects stale_milestone and missing_success_criteria from seeded records", async () => {
  const p = uniq("p26s");
  const gid = await insertGoal(p, { title: "Goal with criteria", success_criteria: ["x"] });
  const mid = await insertMilestone(p, {
    goal_id: gid, milestone_key: "old-ms", status: "planned", success_criteria: [],
    target_date: new Date(Date.now() - 86400000 * 5).toISOString(),
  });
  const emptyGoal = await insertGoal(p, { title: "No criteria goal", success_criteria: [] });
  const r = await analyzeDrift({ project_id: p });
  assert.equal(r.ok, true);
  assert.ok(has(r.findings, "stale_milestone"), "stale milestone detected");
  assert.ok(has(r.findings, "missing_success_criteria"), "missing success criteria detected");
  const stale = r.findings.find((x) => x.category === "stale_milestone");
  assert.deepEqual(stale.affected_milestones, [mid]);
  assert.equal(stale.severity, "high", "past target date raises severity");
  const miss = r.findings.filter((x) => x.category === "missing_success_criteria");
  assert.ok(miss.some((x) => x.affected_goals.includes(emptyGoal)), "goal criteria gap recorded");
  const m = (await core.dbQuery("SELECT status FROM pm_milestone WHERE id=$1", [mid])).rows[0];
  assert.equal(m.status, "planned", "no auto-rewrite of milestone status");
});

// ---------------------------------------------------------------------------
// 4. remaining categories (decision_conflict, scope_growth, repeated_deferral, architecture_effect)
// ---------------------------------------------------------------------------
test("4. drift detects decision_conflict, scope_growth, repeated_deferral and architecture_effect", async () => {
  const p = uniq("p26c");
  const gid = await insertGoal(p, { title: "Goal", success_criteria: ["ok"] });
  const decId = uid();
  await insertDecision(p, { id: decId, title: "Use local cache" });
  await insertTask(p, {
    goal_id: gid, task_key: "conflict-task", status: "in_progress", title: "Bypass local cache",
    evidence: [{ marker: "violates_decision", detail: decId }],
  });
  for (let i = 0; i < 3; i++) {
    await insertTask(p, {
      task_key: `deferred-${i}`, status: "not_started", goal_id: null,
      evidence: [{ marker: "deferred" }, { marker: "postponed" }],
    });
  }
  await insertImpact(p, { result: { stale: true }, confidence: 0.3 });
  const r = await analyzeDrift({ project_id: p });
  assert.equal(r.ok, true, JSON.stringify(r.degraded));
  const cats = r.findings.map((f) => f.category);
  assert.ok(has(r.findings, "decision_conflict"), cats.join(","));
  assert.ok(has(r.findings, "scope_growth"), cats.join(","));
  assert.ok(has(r.findings, "repeated_deferral"), cats.join(","));
  assert.ok(has(r.findings, "architecture_effect"), cats.join(","));
  assert.ok(has(r.findings, "orphan_work"), cats.join(","));
});

// ---------------------------------------------------------------------------
// 5. finding shape + no auto-rewrite
// ---------------------------------------------------------------------------
test("5. every finding has evidence/severity/confidence/status and changes nothing", async () => {
  const p = uniq("p26shape");
  const gid = await insertGoal(p, { title: "Shape goal", success_criteria: ["ok"] });
  const tid = await insertTask(p, { task_key: "shape-task", status: "not_started", goal_id: null });
  const r = await analyzeDrift({ project_id: p });
  assert.equal(r.ok, true);
  assert.ok(r.findings.length >= 1);
  for (const f of r.findings) {
    assert.ok(nonEmpty(f.finding_key));
    assert.equal(f.project_id, p);
    assert.ok(DRIFT_CATEGORIES.includes(f.category));
    assert.ok(["low", "medium", "high", "critical"].includes(f.severity));
    assert.ok(f.confidence >= 0 && f.confidence <= 1);
    assert.ok(Array.isArray(f.evidence) && f.evidence.length >= 1);
    assert.ok(Array.isArray(f.affected_goals) && Array.isArray(f.affected_milestones));
    assert.ok(nonEmpty(f.recommendation));
    assert.equal(f.status, "open");
  }
  assert.match(r.note, /REVIEW RECOMMENDATIONS|review recommendations/);
  assert.match(r.note, /No goal, task, milestone, decision/);
  const g = (await core.dbQuery("SELECT status FROM dev_goal WHERE id=$1", [gid])).rows[0];
  const t = (await core.dbQuery("SELECT status FROM dev_task WHERE id=$1", [tid])).rows[0];
  assert.equal(g.status, "active", "goal unchanged");
  assert.equal(t.status, "not_started", "task unchanged");
});
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }

// ---------------------------------------------------------------------------
// 6. idempotent persistence
// ---------------------------------------------------------------------------
test("6. analyzeDrift persists findings idempotently (no duplicate rows)", async () => {
  const p = uniq("p26idem");
  await insertTask(p, { task_key: "idem-orphan", status: "not_started", goal_id: null });
  const a = await analyzeDrift({ project_id: p });
  const b = await analyzeDrift({ project_id: p });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.deepEqual(a.findings.map((f) => f.finding_key).sort(), b.findings.map((f) => f.finding_key).sort());
  const rows = (await core.dbQuery("SELECT finding_key FROM pm_drift_finding WHERE project_id=$1", [p])).rows;
  assert.equal(rows.length, a.findings.length, "no duplicate findings after second run");
});

// ---------------------------------------------------------------------------
// 7. listDrift + setDriftStatus
// ---------------------------------------------------------------------------
test("7. listDrift filters and setDriftStatus requires actor and valid status", async () => {
  const p = uniq("p26list");
  await insertFinding(p, { finding_key: "k1", category: "orphan_work", severity: "high" });
  await insertFinding(p, { finding_key: "k2", category: "stale_milestone", severity: "low" });
  const all = await listDrift({ project_id: p });
  assert.equal(all.ok, true); assert.equal(all.count, 2);
  const filtered = await listDrift({ project_id: p, category: "orphan_work" });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.items[0].finding_key, "k1");
  const changed = await setDriftStatus({ project_id: p, finding_key: "k1", status: "acknowledged", actor: "op-1" });
  assert.equal(changed.ok, true); assert.equal(changed.changed, true);
  const ack = await listDrift({ project_id: p, status: "acknowledged" });
  assert.equal(ack.count, 1);
  assert.equal((await setDriftStatus({ project_id: p, finding_key: "k1", status: "bogus", actor: "op" })).ok, false);
  assert.equal((await setDriftStatus({ project_id: p, finding_key: "k1", status: "resolved" })).ok, false, "actor required");
  assert.equal((await setDriftStatus({ project_id: uniq(), finding_key: "k1", status: "resolved", actor: "op" })).ok, true);
  assert.equal((await listDrift({ project_id: uniq() })).count, 0, "cross-project isolation");
});

// ---------------------------------------------------------------------------
// 8. recommend ordering follows frozen rules
// ---------------------------------------------------------------------------
test("8. recommend ordering follows the frozen rule order", async () => {
  const p = uniq("p26order");
  const gid = await insertGoal(p, { title: "Main goal", success_criteria: ["ok"] });
  const emptyGoal = await insertGoal(p, { title: "Empty goal", success_criteria: ["ok"] });
  await insertBlocker(p, { blocker_key: "blk", severity: "critical" });
  await insertMilestone(p, { milestone_key: "risky", goal_id: gid, status: "at_risk", success_criteria: ["ok"] });
  await insertTask(p, {
    goal_id: gid, task_key: "interrupted", status: "in_progress",
    evidence: [{ marker: "interrupted", detail: "crash" }], attempts: 1,
  });
  await insertTask(p, { goal_id: gid, task_key: "ready", status: "not_started" });
  await insertFinding(p, { finding_key: "drift-1", category: "orphan_work", severity: "low" });
  const r = await recommend({ project_id: p });
  assert.equal(r.ok, true, JSON.stringify(r.degraded));
  const rules = r.recommendations.map((x) => x.rule).slice(0, 6);
  assert.deepEqual(rules, [...RULES.order]);
  assert.ok(r.recommendations.every((x, i) => i === 0 || x.priority <= r.recommendations[i - 1].priority), "sorted by priority desc");
});

// ---------------------------------------------------------------------------
// 9. only confirmed dependencies gate ready tasks
// ---------------------------------------------------------------------------
test("9. ready tasks use only CONFIRMED dependencies", async () => {
  const p = uniq("p26deps");
  const gid = await insertGoal(p, { title: "Dep goal", success_criteria: ["ok"] });
  const done = await insertTask(p, { task_key: "done-dep", status: "completed", goal_id: gid });
  const pending = await insertTask(p, { task_key: "pending-dep", status: "not_started", goal_id: gid });
  const readySatisfied = await insertTask(p, { task_key: "ready-satisfied", status: "not_started", goal_id: gid });
  const blockedByConfirmed = await insertTask(p, { task_key: "blocked-by-confirmed", status: "not_started", goal_id: gid });
  const readyUnconfirmed = await insertTask(p, {
    task_key: "ready-unconfirmed", status: "not_started", goal_id: gid, dependencies: [done],
  });
  await insertDependency(p, { from_id: readySatisfied, to_id: done, dependency_type: "confirmed" });
  await insertDependency(p, { from_id: blockedByConfirmed, to_id: pending, dependency_type: "confirmed" });
  await insertDependency(p, { from_id: readyUnconfirmed, to_id: pending, dependency_type: "inferred" });
  const r = await recommend({ project_id: p, context: { rule: "ready_task" } });
  assert.equal(r.ok, true);
  const keys = r.recommendations.map((x) => x.task_id);
  assert.ok(keys.includes(readySatisfied), "confirmed + satisfied -> ready");
  assert.ok(keys.includes(readyUnconfirmed), "unconfirmed deps ignored as constraints -> ready");
  assert.equal(keys.includes(blockedByConfirmed), false, "confirmed unsatisfied dep -> not ready");
  const sat = r.recommendations.find((x) => x.task_id === readySatisfied);
  assert.equal(sat.dependencies.length, 1);
  assert.equal(sat.dependencies[0].dependency_type, "confirmed");
  assert.equal(sat.dependencies[0].status, "satisfied");
  const unc = r.recommendations.find((x) => x.task_id === readyUnconfirmed);
  assert.deepEqual(unc.dependencies, [], "inferred dependency not an execution constraint");
  assert.ok(unc.evidence.some((e) => e.excerpt.includes("unconfirmed")), "ignored deps explained");
});

// ---------------------------------------------------------------------------
// 10. ties produce multiple candidates
// ---------------------------------------------------------------------------
test("10. equal-priority candidates are returned as ties, not one winner", async () => {
  const p = uniq("p26tie");
  await insertBlocker(p, { blocker_key: "b1", severity: "high" });
  await insertBlocker(p, { blocker_key: "b2", severity: "high" });
  const r = await recommend({ project_id: p });
  assert.equal(r.ok, true);
  assert.equal(r.tie_detected, true);
  assert.equal(r.candidates_tied.length, 2);
  assert.deepEqual(r.candidates_tied.map((x) => x.rule), ["blocker", "blocker"]);
  for (const c of r.candidates_tied) {
    for (const f of ["action", "reason", "expected_outcome", "goal_id", "milestone_id", "task_id",
      "dependencies", "blockers", "evidence", "confidence", "priority", "approval_required", "action_kind"]) {
      assert.ok(Object.hasOwn(c, f), `tie candidate has ${f}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 11. full fields + approval/action_kind correctness
// ---------------------------------------------------------------------------
test("11. recommendations carry all required fields with correct approval/action_kind", async () => {
  const p = uniq("p26fields");
  const gid = await insertGoal(p, { title: "Fields goal", success_criteria: ["ok"] });
  await insertBlocker(p, { blocker_key: "blk", severity: "medium" });
  await insertTask(p, { goal_id: gid, task_key: "ready", status: "not_started" });
  const r = await recommend({ project_id: p });
  assert.equal(r.ok, true);
  assert.ok(r.recommendations.length >= 2);
  const required = ["action", "reason", "expected_outcome", "goal_id", "milestone_id", "task_id",
    "dependencies", "blockers", "evidence", "confidence", "priority", "approval_required", "action_kind"];
  for (const item of r.recommendations) {
    for (const f of required) assert.ok(Object.hasOwn(item, f), `${f} present`);
    assert.ok(ACTION_KINDS.includes(item.action_kind));
    if (item.action_kind === "execution") {
      assert.equal(item.approval_required, true, "execution requires approval");
    } else {
      assert.equal(item.approval_required, false, "preparation does not require approval");
    }
  }
  const ready = r.recommendations.find((x) => x.rule === "ready_task");
  assert.equal(ready.action_kind, "execution");
  assert.equal(ready.approval_required, true);
});

// ---------------------------------------------------------------------------
// 12. never executes anything (injectable loader that throws on any access)
// ---------------------------------------------------------------------------
test("12. recommend and analyzeDrift never execute anything", async () => {
  const p = uniq("p26noexec");
  await insertGoal(p, { title: "No exec goal", success_criteria: ["ok"] });
  await insertTask(p, { goal_id: p, task_key: "unlinked", status: "not_started" });
  const bomb = new Proxy({}, { get() { throw new Error("EXECUTION ATTEMPT"); } });
  const r = await recommend({ project_id: p, _load: async () => bomb });
  assert.equal(r.ok, true, "throwing loader degrades, never throws");
  assert.ok(r.degraded.length >= 1);
  const d = await analyzeDrift({ project_id: p, _load: async () => { throw new Error("EXECUTION ATTEMPT"); } });
  assert.equal(d.ok, true);
  assert.ok(d.degraded.length >= 1);
});

// ---------------------------------------------------------------------------
// 13. cross-project isolation
// ---------------------------------------------------------------------------
test("13. all reads are strictly project-scoped", async () => {
  const a = uniq("p26isoA"), b = uniq("p26isoB");
  await insertGoal(a, { title: "Secret goal" });
  await insertTask(a, { task_key: "secret-task", status: "not_started" });
  await insertBlocker(a, { blocker_key: "secret-blocker" });
  await insertFinding(a, { finding_key: "secret-finding" });
  const da = await analyzeDrift({ project_id: a });
  const db = await analyzeDrift({ project_id: b });
  assert.ok(da.findings.length >= 1);
  assert.equal(db.findings.length, 0, "no drift leakage");
  const ra = await recommend({ project_id: a });
  const rb = await recommend({ project_id: b });
  assert.ok(ra.recommendations.length >= 1);
  assert.equal(rb.recommendations.length, 0, "no recommendation leakage");
  assert.equal((await listDrift({ project_id: b })).count, 0);
});

// ---------------------------------------------------------------------------
// 14. redaction
// ---------------------------------------------------------------------------
test("14. secrets are redacted from drift and recommendations", async () => {
  const p = uniq("p26red");
  const secret = "sk-1234567890abcdefghijklmnop";
  await insertGoal(p, { title: `Goal uses ${secret}`, success_criteria: ["ok"] });
  const d = await analyzeDrift({ project_id: p });
  assert.equal(JSON.stringify(d).includes(secret), false, "drift redacted");
  assert.match(JSON.stringify(d), /REDACTED/);
  const r = await recommend({ project_id: p });
  assert.equal(JSON.stringify(r).includes(secret), false, "recommendations redacted");
});

// ---------------------------------------------------------------------------
// 15. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("15. invalid inputs fail closed without throwing", async () => {
  assert.equal((await analyzeDrift({})).ok, false);
  assert.equal((await analyzeDrift({ project_id: "_global" })).ok, false);
  assert.equal((await listDrift({})).ok, false);
  assert.equal((await setDriftStatus({ project_id: uniq(), finding_key: "x", status: "resolved" })).ok, false);
  assert.equal((await setDriftStatus({ project_id: uniq(), finding_key: "x", status: "bogus", actor: "op" })).ok, false);
  assert.equal((await recommend({})).ok, false);
  assert.equal((await recommend({ project_id: "_global" })).ok, false);
});

// ---------------------------------------------------------------------------
// 16. bounded reads
// ---------------------------------------------------------------------------
test("16. analyzeDrift and recommend honour bounded limits", async () => {
  const p = uniq("p26bound");
  await insertGoal(p, { title: "Bound goal", success_criteria: ["ok"] });
  for (let i = 0; i < 4; i++) await insertTask(p, { task_key: `b-${i}`, status: "not_started", goal_id: null });
  const d = await analyzeDrift({ project_id: p, limit: 2 });
  assert.equal(d.ok, true);
  assert.equal(d.findings.length, 2, "returned findings bounded");
  assert.ok(d.count >= 2, "total count still reported");
  const r = await recommend({ project_id: p, limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.recommendations.length, 1);
});

// ---------------------------------------------------------------------------
// 17. cleanup + close pool + DB-down degradation (final)
// ---------------------------------------------------------------------------
test("close pool + DB-down degradation (final)", async () => {
  const ps = [...projects];
  if (ps.length) {
    for (const table of ["pm_drift_finding", "pm_blocker", "pm_milestone", "pm_dependency",
      "pm_progress_snapshot", "technical_decision", "code_analysis", "dev_task", "dev_goal"]) {
      try { await core.dbQuery(`DELETE FROM ${table} WHERE project_id = ANY($1)`, [ps]); } catch { /* best effort */ }
    }
  }
  await core.close();

  const p = `p26-down-${uid().slice(0, 8)}`;
  const d = await analyzeDrift({ project_id: p });
  assert.equal(d.ok, false, "DB down fails closed");
  assert.deepEqual(d.findings, []);
  assert.ok(d.degraded.length >= 1);
  const r = await recommend({ project_id: p });
  assert.equal(r.ok, false, "DB down fails closed");
  assert.deepEqual(r.recommendations, []);
  assert.ok(r.degraded.length >= 1);
});
