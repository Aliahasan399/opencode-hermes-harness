// Phase 19 workstreams B + D — development goals, intent and evidence-backed task continuity.
// Unique project ids per test; no deletion, no LLM/network, no cross-project access.
// Standalone: $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase19-development-goal.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const dg = await import("../src/developmentGoal.js");

const uniq = () => `p19-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// Idempotent: migration 017 is already applied by the parent, this is a no-op then.
before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS dev_goal (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'active',
      requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_session text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, title)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS dev_task (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      goal_id text,
      task_key text NOT NULL,
      title text NOT NULL,
      status text NOT NULL DEFAULT 'not_started',
      parent_task_id text,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_session text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, task_key)
    )`);
});

// ---------------- exports / constants ----------------

test("1. status enums are frozen with the exact fixed sets", () => {
  assert.ok(Object.isFrozen(dg.GOAL_STATUSES));
  assert.ok(Object.isFrozen(dg.TASK_STATUSES));
  assert.deepEqual([...dg.GOAL_STATUSES], ["active", "completed", "blocked", "superseded"]);
  assert.deepEqual([...dg.TASK_STATUSES], [
    "not_started", "in_progress", "blocked", "completed", "failed", "abandoned", "superseded",
  ]);
});

// ---------------- canMarkComplete ----------------

test("2. canMarkComplete rejects bare agent claims and empty/malformed evidence", () => {
  for (const bad of [undefined, null, "done", 123, {}]) {
    assert.equal(dg.canMarkComplete(bad), false, `non-array ${String(bad)} rejected`);
  }
  for (const claim of [[], ["done"], ["implemented"], ["completed"], ["task is finished"],
    [{ status: "done" }], [{ claim: "implemented" }], [{ kind: "note", text: "all done" }]]) {
    assert.equal(dg.canMarkComplete(claim), false, `claim ${JSON.stringify(claim)} rejected`);
  }
});

test("3. canMarkComplete accepts explicit verification markers with success", () => {
  assert.equal(dg.canMarkComplete(["test_pass"]), true);
  assert.equal(dg.canMarkComplete([{ test_pass: true }]), true);
  assert.equal(dg.canMarkComplete([{ verification_result: "passed all 12 tests" }]), true);
  assert.equal(dg.canMarkComplete([{ tool_result: { ok: true, output: "green" } }]), true);
  assert.equal(dg.canMarkComplete([{ kind: "tool_result", success: true }]), true);
  assert.equal(dg.canMarkComplete([{ kind: "test_result", status: "passed" }]), true);
  assert.equal(dg.canMarkComplete(["verification_result: success (exit 0)"]), true);
});

test("4. canMarkComplete rejects failed verification even when marker is present", () => {
  assert.equal(dg.canMarkComplete(["test_pass: false"]), false);
  assert.equal(dg.canMarkComplete([{ test_pass: false }]), false);
  assert.equal(dg.canMarkComplete([{ verification_result: "failed: 2 assertions" }]), false);
  assert.equal(dg.canMarkComplete([{ tool_result: { ok: false, status: "failed" } }]), false);
});

// ---------------- extractGoalCandidates ----------------

test("5. extractGoalCandidates is pure, deterministic and bounded", () => {
  const input = {
    lines: [
      "we need to build a CSV export feature",
      "the weather is nice today",
      "I want to add pagination to the API",
      "we need to build a CSV export feature",
      "please fix the login redirect bug",
      "goal: reduce p95 latency below 200ms",
      "requirement: support offline mode",
      ...Array.from({ length: 30 }, (_, i) => `we need to do task number ${i}`),
    ],
    summary: { summary: "we must harden the auth layer" },
    project_id: uniq(),
  };
  const a = dg.extractGoalCandidates(input);
  const b = dg.extractGoalCandidates(input);
  assert.deepEqual(a, b, "same input gives identical output");
  assert.ok(a.length <= 10, "bounded to 10 candidates");
  assert.ok(a.length >= 5);
  for (const c of a) {
    assert.deepEqual(Object.keys(c).sort(), ["constraints", "description", "evidence", "requirements", "title"]);
    assert.ok(c.title.length <= 160);
    assert.ok(c.description.length <= 400);
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
  }
  assert.equal(a.filter((c) => c.title.includes("CSV export")).length, 1, "deduplicated");
});

test("6. extractGoalCandidates never promotes a single instruction into a preference", () => {
  const r = dg.extractGoalCandidates({
    lines: [
      "from now on, always prefer tabs over spaces",
      "we should never use dynamic SQL here",
      "we need to implement the retry policy",
    ],
    project_id: uniq(),
  });
  assert.equal(r.length, 1);
  assert.match(r[0].title, /retry policy/);
  assert.ok(!r.some((c) => /tabs|dynamic SQL/.test(c.title)));
});

// ---------------- goals: creation / dedupe / retrieval ----------------

test("7. recordGoal creates a scoped goal and dedupes without overwrite", async () => {
  const project = `goal-create-${uniq()}`;
  const title = `Goal ${uniq()}`;
  const first = await dg.recordGoal({
    project_id: project, title, description: "original",
    requirements: ["r1", "r2"], constraints: ["c1"],
    evidence: [{ kind: "user_request", text: "need this" }], source_session: `s-${uniq()}`,
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.ok(first.id);

  const second = await dg.recordGoal({
    project_id: project, title, description: "OVERWRITE ATTEMPT",
    requirements: ["changed"], evidence: [],
  });
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id, "duplicate reports the existing id");

  const listed = await dg.getGoals({ project_id: project });
  assert.equal(listed.ok, true);
  assert.equal(listed.goals.length, 1);
  assert.equal(listed.goals[0].description, "original", "active goal was not overwritten");
  assert.deepEqual(listed.goals[0].requirements, ["r1", "r2"]);
  assert.deepEqual(listed.goals[0].constraints, ["c1"]);
});

test("8. getGoals is status-filtered and bounded", async () => {
  const project = `goal-filter-${uniq()}`;
  for (let i = 0; i < 6; i++) {
    await dg.recordGoal({ project_id: project, title: `G${i}-${uniq()}` });
  }
  const g = await dg.getGoals({ project_id: project, limit: 3 });
  assert.equal(g.goals.length, 3, "limit honored");
  const huge = await dg.getGoals({ project_id: project, limit: 999 });
  assert.ok(huge.goals.length <= 200, "limit capped");
  assert.equal((await dg.getGoals({ limit: 10 })).ok, false, "project_id required");
});

// ---------------- goals: status corrections with history ----------------

test("9. setGoalStatus validates, appends evidence and audits content-free", async () => {
  const project = `goal-status-${uniq()}`;
  const made = await dg.recordGoal({
    project_id: project, title: `S ${uniq()}`,
    evidence: [{ kind: "user_request", text: "original evidence" }],
  });
  const bad = await dg.setGoalStatus({ id: made.id, status: "bogus" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid/);

  const changed = await dg.setGoalStatus({
    id: made.id, status: "blocked", evidence: [{ kind: "blocker", text: "waiting on API" }], actor: "test",
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true);
  const goal = (await dg.getGoals({ project_id: project })).goals[0];
  assert.equal(goal.status, "blocked");
  assert.equal(goal.evidence.length, 2, "new evidence appended, old preserved");
  assert.equal(goal.evidence[0].text, "original evidence");

  const audit = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='dev_goal.status' AND detail->>'id'=$1", [made.id],
  )).rows[0].n;
  assert.ok(audit >= 1, "status change audited");
  const detail = (await core.dbQuery(
    "SELECT detail FROM audit_log WHERE action='dev_goal.status' AND detail->>'id'=$1 LIMIT 1", [made.id],
  )).rows[0].detail;
  assert.equal(JSON.stringify(detail).includes("waiting on API"), false, "audit is content-free");
});

// ---------------- tasks: creation / dedupe ----------------

test("10. recordTask creates a scoped task linked to a goal and dedupes", async () => {
  const project = `task-create-${uniq()}`;
  const goal = await dg.recordGoal({ project_id: project, title: `G ${uniq()}` });
  const key = `key-${uniq()}`;
  const first = await dg.recordTask({
    project_id: project, goal_id: goal.id, task_key: key, title: "Do the thing",
    evidence: [{ kind: "plan" }], source_session: `s-${uniq()}`,
  });
  assert.equal(first.ok, true);
  assert.ok(first.id);

  const second = await dg.recordTask({ project_id: project, goal_id: goal.id, task_key: key, title: "overwrite" });
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const unfinished = await dg.getUnfinishedTasks({ project_id: project });
  assert.equal(unfinished.tasks.length, 1);
  assert.equal(unfinished.tasks[0].title, "Do the thing");
  assert.equal(unfinished.tasks[0].goal_id, goal.id);
});

test("11. recordTask rejects invalid inputs and cross-project references", async () => {
  const project = `task-invalid-${uniq()}`;
  const other = `task-other-${uniq()}`;
  const goal = await dg.recordGoal({ project_id: project, title: `G ${uniq()}` });
  assert.equal((await dg.recordTask({ project_id: "", task_key: "k", title: "t" })).ok, false);
  assert.equal((await dg.recordTask({ project_id: project, task_key: "", title: "t" })).ok, false);
  assert.equal((await dg.recordTask({ project_id: project, task_key: "k", title: "" })).ok, false);
  assert.equal((await dg.recordTask({ project_id: project, task_key: "k", title: "t", status: "nope" })).ok, false);
  assert.equal((await dg.recordTask({ project_id: project, task_key: "x", title: "t", goal_id: goal.id })).ok, true);
  const wrongGoal = await dg.recordTask({ project_id: other, task_key: "x2", title: "t", goal_id: goal.id });
  assert.equal(wrongGoal.ok, false, "goal from another project is rejected");
});

// ---------------- evidence-based completion ----------------

test("12. task completion: agent claim rejected, verification accepted; history preserved", async () => {
  const project = `task-complete-${uniq()}`;
  const made = await dg.recordTask({
    project_id: project, task_key: `k-${uniq()}`, title: "Implement feature",
    evidence: [{ kind: "plan", text: "original plan" }],
  });

  const claimed = await dg.setTaskStatus({
    id: made.id, project_id: project, status: "completed",
    evidence: ["done", "implemented"], actor: "agent",
  });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.reason, "insufficient_evidence");
  assert.equal(claimed.changed, false);

  let tasks = (await dg.getUnfinishedTasks({ project_id: project })).tasks;
  assert.equal(tasks[0].status, "not_started", "rejected completion left status unchanged");

  const inProgress = await dg.setTaskStatus({
    id: made.id, project_id: project, status: "in_progress", evidence: [{ kind: "note", text: "started" }],
  });
  assert.equal(inProgress.ok, true);

  const verified = await dg.setTaskStatus({
    id: made.id, project_id: project, status: "completed",
    evidence: [{ test_pass: true, suite: "unit" }], actor: "runner",
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.changed, true);

  tasks = (await dg.getUnfinishedTasks({ project_id: project })).tasks;
  assert.equal(tasks.length, 0, "completed task no longer unfinished");
});

test("13. setTaskStatus appends evidence, preserves history, validates and stays in scope", async () => {
  const project = `task-history-${uniq()}`;
  const key = `k-${uniq()}`;
  const made = await dg.recordTask({
    project_id: project, task_key: key, title: "T",
    evidence: [{ kind: "first", text: "seed" }],
  });
  const bad = await dg.setTaskStatus({ id: made.id, project_id: project, status: "bogus" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid/);

  const r = await dg.setTaskStatus({
    task_key: key, project_id: project, status: "blocked",
    evidence: [{ kind: "blocker", text: "needs input" }],
  });
  assert.equal(r.ok, true, "lookup by task_key works");

  const row = (await core.dbQuery("SELECT status, evidence FROM dev_task WHERE id=$1", [made.id])).rows[0];
  assert.equal(row.status, "blocked");
  assert.equal(row.evidence.length, 2, "evidence appended, never deleted");
  assert.equal(row.evidence[0].text, "seed");

  const wrongProject = await dg.setTaskStatus({ id: made.id, project_id: "some-other-project", status: "completed", evidence: [{ tool_result: { ok: true } }] });
  assert.equal(wrongProject.ok, false, "cannot modify another project's task");
  const missing = await dg.setTaskStatus({ id: "does-not-exist", project_id: project, status: "in_progress" });
  assert.equal(missing.ok, false);
});

// ---------------- unfinished retrieval / continuity ----------------

test("14. getUnfinishedTasks returns only unfinished statuses and filters by goal", async () => {
  const project = `task-unfinished-${uniq()}`;
  const g1 = await dg.recordGoal({ project_id: project, title: `A ${uniq()}` });
  const g2 = await dg.recordGoal({ project_id: project, title: `B ${uniq()}` });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `ns-${uniq()}`, title: "not started", status: "not_started" });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `ip-${uniq()}`, title: "in progress", status: "in_progress" });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `bl-${uniq()}`, title: "blocked", status: "blocked" });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `fa-${uniq()}`, title: "failed", status: "failed" });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `co-${uniq()}`, title: "completed", status: "completed" });
  await dg.recordTask({ project_id: project, goal_id: g1.id, task_key: `ab-${uniq()}`, title: "abandoned", status: "abandoned" });
  await dg.recordTask({ project_id: project, goal_id: g2.id, task_key: `g2-${uniq()}`, title: "other goal", status: "not_started" });

  const all = await dg.getUnfinishedTasks({ project_id: project });
  assert.equal(all.tasks.length, 5, "four in g1 + one in g2, excluding completed/abandoned");
  for (const t of all.tasks) {
    assert.ok(["not_started", "in_progress", "blocked", "failed"].includes(t.status));
  }
  const scoped = await dg.getUnfinishedTasks({ project_id: project, goal_id: g1.id });
  assert.equal(scoped.tasks.length, 4, "goal_id filter applied");
  const bounded = await dg.getUnfinishedTasks({ project_id: project, limit: 999 });
  assert.ok(bounded.tasks.length <= 100, "limit capped");
});

test("15. getGoalContinuity aggregates goals with their project-scoped tasks", async () => {
  const project = `continuity-${uniq()}`;
  const g = await dg.recordGoal({ project_id: project, title: `Goal ${uniq()}` });
  await dg.recordTask({ project_id: project, goal_id: g.id, task_key: `t1-${uniq()}`, title: "t1" });
  await dg.recordTask({ project_id: project, goal_id: g.id, task_key: `t2-${uniq()}`, title: "t2", status: "in_progress" });
  const r = await dg.getGoalContinuity({ project_id: project });
  assert.equal(r.ok, true);
  assert.equal(r.goals.length, 1);
  assert.equal(r.goals[0].tasks.length, 2);
  assert.ok(Array.isArray(r.goals[0].requirements));
  const bounded = await dg.getGoalContinuity({ project_id: project, limit: 999 });
  assert.ok(bounded.goals.length <= 100);
});

// ---------------- project isolation ----------------

test("16. goals and tasks are project-isolated on every read path", async () => {
  const a = `iso-A-${uniq()}`;
  const b = `iso-B-${uniq()}`;
  const goal = await dg.recordGoal({ project_id: a, title: `Secret ${uniq()}` });
  const task = await dg.recordTask({ project_id: a, goal_id: goal.id, task_key: `secret-${uniq()}`, title: "secret task" });

  assert.equal((await dg.getGoals({ project_id: b })).goals.length, 0);
  assert.equal((await dg.getUnfinishedTasks({ project_id: b })).tasks.length, 0);
  assert.equal((await dg.getGoalContinuity({ project_id: b })).goals.length, 0);
  assert.equal((await dg.setTaskStatus({ id: task.id, project_id: b, status: "in_progress" })).ok, false);
  assert.equal((await dg.recordTask({ project_id: b, task_key: "secret-" + uniq(), title: "t", goal_id: goal.id })).ok, false);
});

// ---------------- supersede ----------------

test("17. supersedeGoal preserves history, appends evidence and validates", async () => {
  const project = `sup-${uniq()}`;
  const old = await dg.recordGoal({
    project_id: project, title: `Old ${uniq()}`,
    evidence: [{ kind: "user_request", text: "original" }],
  });
  const replacement = await dg.recordGoal({ project_id: project, title: `New ${uniq()}` });

  assert.equal((await dg.supersedeGoal({ id: "nope" })).ok, false);
  const cross = await dg.supersedeGoal({ id: old.id, by_id: "some-other-project-id" });
  assert.equal(cross.ok, false, "replacement from another project rejected");

  const r = await dg.supersedeGoal({
    id: old.id, by_id: replacement.id, reason: "replaced by new approach",
    evidence: [{ kind: "decision", text: "supersession evidence" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);

  const goals = (await dg.getGoals({ project_id: project })).goals;
  const oldRow = goals.find((g) => g.id === old.id);
  assert.equal(oldRow.status, "superseded", "old goal preserved, not deleted");
  assert.equal(oldRow.evidence[0].text, "original", "original evidence kept");
  assert.equal(oldRow.evidence[oldRow.evidence.length - 1].kind, "supersession");
  assert.equal(oldRow.evidence[oldRow.evidence.length - 1].by_id, replacement.id);
  assert.equal((await dg.supersedeGoal({ id: old.id, by_id: replacement.id })).ok, false, "already superseded");

  const audit = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='dev_goal.supersede' AND detail->>'id'=$1", [old.id],
  )).rows[0].n;
  assert.ok(audit >= 1, "supersession audited");
});

test("close pool", async () => { await core.close(); });
