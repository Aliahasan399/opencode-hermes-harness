// Phase 22 Features B+C — agent discovery/selection + task coordination.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test). Unique ids; no row
// deletion; core.close() called exactly once in the final test.
// Run: MEMORY_DB_NAME=opencode_memory_test node --test test/phase22-coordination.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.MEMORY_DB_NAME = process.env.MEMORY_DB_NAME || "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

let core;
let registry;
let coord;
async function load() {
  if (!core) {
    core = await import("../src/core.js");
    registry = await import("../src/agentRegistry.js");
    coord = await import("../src/agentCoordination.js");
  }
  return { core, registry, coord };
}

const uniq = () => `p22c-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function seedPlan(specs = []) {
  const db = (await load()).core;
  const project_id = `proj-${uniq()}`;
  const plan_id = `plan-${uniq()}`;
  const session_id = `sess-${uniq()}`;
  await db.dbQuery(
    `INSERT INTO agent_plan (id, project_id, session_id, request, status, decomposition)
     VALUES ($1,$2,$3,$4,'planned',$5::jsonb)`,
    [plan_id, project_id, session_id, `coordination test ${uniq()}`, JSON.stringify([])],
  );
  const idMap = new Map();
  specs.forEach((s, i) => idMap.set(s.key, `${plan_id}-${s.key}-${i}`));
  for (const s of specs) {
    const deps = (s.deps || []).map((d) => idMap.get(d)).filter(Boolean);
    await db.dbQuery(
      `INSERT INTO dev_task (id, project_id, task_key, title, status, plan_id, objective,
        dependencies, required_capabilities, file_ownership, completion_criteria,
        risk_level, priority, attempts, result_ref, evidence, source_session)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,$17)`,
      [
        idMap.get(s.key), project_id, `${plan_id}:${s.key}`.slice(0, 200), s.title || s.key,
        s.status || "pending", plan_id, s.objective || "", JSON.stringify(deps),
        JSON.stringify(s.caps || []), JSON.stringify([]), JSON.stringify([]),
        "low", s.priority ?? 0, 0, JSON.stringify({}), JSON.stringify([]), session_id,
      ],
    );
  }
  return { project_id, plan_id, session_id, idMap };
}

async function countExecutions(plan_id, project_id) {
  const db = (await load()).core;
  const r = await db.dbQuery(
    "SELECT count(*)::int AS n FROM agent_execution WHERE plan_id=$1 AND project_id=$2",
    [plan_id, project_id],
  );
  return r.rows[0].n;
}

async function taskStatus(id) {
  const db = (await load()).core;
  const r = await db.dbQuery("SELECT status, attempts FROM dev_task WHERE id=$1", [id]);
  return r.rows[0];
}

// ---- 1. discovery reads the real opencode.json ----------------------------
test("1. discoverAgents reads real config and includes harness agents", async () => {
  const { registry: reg } = await load();
  const r = await reg.discoverAgents();
  assert.equal(r.ok, true);
  assert.equal(r.cli_agent_supported, true);
  assert.ok(Array.isArray(r.agents) && Array.isArray(r.degraded));

  const byName = new Map(r.agents.map((a) => [a.name, a]));
  for (const name of ["explore", "explorer", "general"]) {
    assert.ok(byName.has(name), `missing harness/config agent ${name}`);
  }
  const explorer = byName.get("explorer");
  assert.equal(explorer.source, "config", "real config explorer must be reported from config");
  assert.equal(explorer.model, "9router/claude-opus-free");
  assert.match(explorer.description, /Fast explorer subagent/);
  assert.equal(explorer.mode, "subagent");
  assert.deepEqual(explorer.capabilities, ["search", "read"]);
  assert.deepEqual(byName.get("general").capabilities, ["implementation", "testing"]);
  assert.equal(byName.get("explore").source, "harness");
  assert.equal(byName.get("general").source, "harness");
});

// ---- 2. unavailable model handling ----------------------------------------
test("2. agents pinned to a dead upstream are unavailable and degraded", async () => {
  const { registry: reg } = await load();
  const r = await reg.discoverAgents();
  const explorer = r.agents.find((a) => a.name === "explorer");
  assert.equal(explorer.available, false);
  assert.ok(r.degraded.some((d) => d.agent === "explorer" && /9router/.test(d.reason || "")));
  for (const a of r.agents) {
    if (a.source === "harness") assert.equal(a.available, true);
  }

  const selected = await reg.selectAgents({
    tasks: [{ id: "t", required_capabilities: ["search", "read"] }],
    agents: r.agents,
    max_parallel: 4,
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.assignments[0].agent, "explore", "dead explorer must not be selected");
  assert.ok(selected.degraded.some((d) => d.agent === "explorer"));
});

// ---- 3. selection by capability, determinism, confidence -----------------
test("3. selectAgents matches capabilities, is deterministic and scores confidence", async () => {
  const { registry: reg } = await load();
  const agents = [
    { name: "general", capabilities: ["implementation", "testing"], available: true },
    { name: "explorer", capabilities: ["search", "read"], available: false },
    { name: "explore", capabilities: ["search", "read"], available: true },
  ];
  const tasks = [
    { id: "impl-1", required_capabilities: ["implementation", "testing"] },
    { id: "search-1", required_capabilities: ["search", "read"] },
    { id: "weird-1", required_capabilities: ["quantum"] },
  ];
  const args = { tasks, agents, history: [], project_id: `proj-${uniq()}`, max_parallel: 4 };
  const a = await reg.selectAgents(args);
  const b = await reg.selectAgents(args);
  assert.equal(a.ok, true);
  assert.deepEqual(a, b, "selection must be deterministic");
  assert.equal(a.assignments.length, 2);
  assert.equal(a.assignments.find((x) => x.task_id === "impl-1").agent, "general");
  assert.equal(a.assignments.find((x) => x.task_id === "search-1").agent, "explore");
  assert.equal(a.rejected.length, 1);
  assert.equal(a.rejected[0].task_id, "weird-1");
  assert.equal(a.rejected[0].reason, "no_capable_agent");
  assert.ok(a.assignments.every((x) => x.confidence >= 0 && x.confidence <= 1));
  assert.ok(a.assignments.every((x) => typeof x.reason === "string" && x.reason.length > 0));
});

// ---- 4. workload balance + parallel bound ---------------------------------
test("4. selection balances workload and respects the parallel bound", async () => {
  const { registry: reg } = await load();
  const agents = [
    { name: "general", capabilities: ["implementation"], available: true },
    { name: "explore", capabilities: ["search"], available: true },
  ];
  const tasks = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}` }));
  const all = await reg.selectAgents({ tasks, agents, max_parallel: 4 });
  assert.equal(all.assignments.length, 4);
  const counts = {};
  for (const x of all.assignments) counts[x.agent] = (counts[x.agent] || 0) + 1;
  assert.deepEqual(counts, { explore: 2, general: 2 }, "work should be spread evenly");

  const bounded = await reg.selectAgents({ tasks, agents, max_parallel: 2 });
  assert.equal(bounded.assignments.length, 2);
  assert.equal(bounded.rejected.length, 2);
  assert.ok(bounded.rejected.every((r) => r.reason === "parallel_bound"));
});

// ---- 5. claim happy path ---------------------------------------------------
test("5. claimTask inserts an execution and assigns the task", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([{ key: "a" }]);
  const r = await c.claimTask({
    plan_id, task_id: idMap.get("a"), agent: "general", project_id, session_id: "s1",
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.duplicate, false);
  assert.equal(r.attempts, 1);
  assert.equal(typeof r.execution_id, "number");
  assert.equal(await countExecutions(plan_id, project_id), 1);
  const t = await taskStatus(idMap.get("a"));
  assert.equal(t.status, "in_progress");
});

// ---- 6. dependency gating --------------------------------------------------
test("6. claimTask refuses tasks with unfinished dependencies", async () => {
  const { coord: c, core: db } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([
    { key: "dep" },
    { key: "child", deps: ["dep"] },
  ]);
  const blocked = await c.claimTask({
    plan_id, task_id: idMap.get("child"), agent: "general", project_id,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "dependencies not completed");
  assert.deepEqual(blocked.dependencies, [idMap.get("dep")]);
  assert.equal(await countExecutions(plan_id, project_id), 0);

  await db.dbQuery("UPDATE dev_task SET status='completed' WHERE id=$1", [idMap.get("dep")]);
  const ready = await c.claimTask({
    plan_id, task_id: idMap.get("child"), agent: "general", project_id,
  });
  assert.equal(ready.ok, true, ready.reason);
});

// ---- 7. claim idempotency --------------------------------------------------
test("7. repeated claimTask is idempotent via duplicate detection", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([{ key: "a" }]);
  const args = { plan_id, task_id: idMap.get("a"), agent: "general", project_id };
  const first = await c.claimTask(args);
  const second = await c.claimTask(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.execution_id, first.execution_id);
  assert.equal(await countExecutions(plan_id, project_id), 1, "no duplicate execution row");
});

// ---- 8. parallel bound -----------------------------------------------------
test("8. claimTask enforces the per-plan parallel bound", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan(
    Array.from({ length: 5 }, (_, i) => ({ key: `t${i}` })),
  );
  for (let i = 0; i < 4; i++) {
    const r = await c.claimTask({
      plan_id, task_id: idMap.get(`t${i}`), agent: "general", project_id,
    });
    assert.equal(r.ok, true, `claim ${i}: ${r.reason}`);
  }
  const over = await c.claimTask({
    plan_id, task_id: idMap.get("t4"), agent: "general", project_id,
  });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "parallel bound reached");
  assert.equal(over.max, 4);

  await c.completeTask({
    plan_id, task_id: idMap.get("t0"), agent: "general", project_id,
    result: { ok: true },
  });
  const after = await c.claimTask({
    plan_id, task_id: idMap.get("t4"), agent: "general", project_id,
  });
  assert.equal(after.ok, true, after.reason);
});

// ---- 9. completion, unblocking, result validation -------------------------
test("9. completeTask finalizes the task and reports newly unblocked tasks", async () => {
  const { coord: c, core: db } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([
    { key: "dep" },
    { key: "c1", deps: ["dep"] },
    { key: "c2", deps: ["dep"] },
  ]);
  const empty = await c.completeTask({
    plan_id, task_id: idMap.get("dep"), agent: "general", project_id, result: {},
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "non-empty result is required");

  const claim = await c.claimTask({
    plan_id, task_id: idMap.get("dep"), agent: "general", project_id,
  });
  assert.equal(claim.ok, true);
  const done = await c.completeTask({
    plan_id, task_id: idMap.get("dep"), agent: "general", project_id,
    result: { accepted: true, summary: "done" },
  });
  assert.equal(done.ok, true, done.reason);
  assert.deepEqual(new Set(done.unblocked), new Set([idMap.get("c1"), idMap.get("c2")]));
  assert.equal((await taskStatus(idMap.get("dep"))).status, "completed");
  const ex = (await db.dbQuery("SELECT status, result FROM agent_execution WHERE id=$1", [claim.execution_id])).rows[0];
  assert.equal(ex.status, "done");
  assert.equal(ex.result.accepted, true);
});

// ---- 10. bounded retries preserve history ---------------------------------
test("10. failTask bounds retries to three attempts and preserves history", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([{ key: "a" }]);
  const tid = idMap.get("a");
  const statuses = [];
  for (let i = 1; i <= 3; i++) {
    const claim = await c.claimTask({ plan_id, task_id: tid, agent: "general", project_id });
    assert.equal(claim.ok, true, `claim ${i}: ${claim.reason}`);
    const failed = await c.failTask({
      plan_id, task_id: tid, agent: "general", project_id, error: `boom ${i}`,
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.attempts, i);
    statuses.push(failed.status);
    if (i < 3) {
      const retry = await c.retryFailed({ plan_id, project_id, limit: 10 });
      assert.deepEqual(retry.retried, [tid]);
    }
  }
  assert.deepEqual(statuses, ["failed", "failed", "exhausted"]);
  assert.equal((await taskStatus(tid)).status, "exhausted");
  assert.equal(await countExecutions(plan_id, project_id), 3, "all failure history preserved");
  const retry = await c.retryFailed({ plan_id, project_id, limit: 10 });
  assert.equal(retry.count, 0, "exhausted tasks must not be retried");
});

// ---- 11. fail guards + agent ownership ------------------------------------
test("11. failTask and completeTask refuse mismatched or missing executions", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([{ key: "a" }]);
  const tid = idMap.get("a");
  const noExec = await c.failTask({ plan_id, task_id: tid, agent: "general", project_id, error: "x" });
  assert.equal(noExec.ok, false);

  await c.claimTask({ plan_id, task_id: tid, agent: "general", project_id });
  const wrongAgent = await c.completeTask({
    plan_id, task_id: tid, agent: "explore", project_id, result: { ok: true },
  });
  assert.equal(wrongAgent.ok, false);
  assert.equal(wrongAgent.reason, "agent does not own execution");
  const stillRunning = await c.failTask({
    plan_id, task_id: tid, agent: "explore", project_id, error: "x",
  });
  assert.equal(stillRunning.ok, false);
});

// ---- 12. retryFailed bounded and plan-scoped ------------------------------
test("12. retryFailed is limit-bounded and scoped to one plan", async () => {
  const { coord: c } = await load();
  const base = await seedPlan(Array.from({ length: 3 }, (_, i) => ({ key: `a${i}` })));
  const { project_id, plan_id, idMap } = base;
  const otherPlanId = `plan-${uniq()}`;
  const tidOther = `x-${uniq()}`;
  const db = (await load()).core;
  // A second plan in the SAME project: retryFailed for `plan_id` must not touch it.
  await db.dbQuery(
    `INSERT INTO agent_plan (id, project_id, session_id, request, status)
     VALUES ($1,$2,$3,$4,'planned')`,
    [otherPlanId, project_id, `s-${uniq()}`, `other plan ${uniq()}`],
  );
  await db.dbQuery(
    `INSERT INTO dev_task (id, project_id, task_key, title, status, plan_id, attempts)
     VALUES ($1,$2,$3,'other','failed',$4,1)`,
    [tidOther, project_id, `${otherPlanId}:b0`.slice(0, 200), otherPlanId],
  );

  for (const tid of idMap.values()) {
    await db.dbQuery("UPDATE dev_task SET status='failed', attempts=1 WHERE id=$1", [tid]);
    await db.dbQuery(
      `INSERT INTO agent_execution (plan_id, task_id, project_id, agent, status, attempts)
       VALUES ($1,$2,$3,'general','failed',1)`,
      [plan_id, tid, project_id],
    );
  }
  await db.dbQuery(
    `INSERT INTO agent_execution (plan_id, task_id, project_id, agent, status, attempts)
     VALUES ($1,$2,$3,'general','failed',1)`,
    [otherPlanId, tidOther, project_id],
  );

  const limited = await c.retryFailed({ plan_id, project_id, limit: 1 });
  assert.equal(limited.count, 1);
  assert.equal(limited.retried.length, 1);
  const rest = await c.retryFailed({ plan_id, project_id, limit: 10 });
  assert.equal(rest.count, 2);
  const untouched = await taskStatus(tidOther);
  assert.equal(untouched.status, "failed", "other plan must be untouched");
});

// ---- 13. ready tasks + execution status views -----------------------------
test("13. getReadyTasks and executionStatus are bounded and project-scoped", async () => {
  const { coord: c } = await load();
  const { project_id, plan_id, idMap } = await seedPlan([
    { key: "dep" },
    { key: "child", deps: ["dep"] },
  ]);
  let ready = await c.getReadyTasks({ plan_id, project_id });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.tasks.map((t) => t.id), [idMap.get("dep")]);

  await c.claimTask({ plan_id, task_id: idMap.get("dep"), agent: "general", project_id });
  await c.completeTask({
    plan_id, task_id: idMap.get("dep"), agent: "general", project_id, result: { accepted: true },
  });
  ready = await c.getReadyTasks({ plan_id, project_id });
  assert.deepEqual(ready.tasks.map((t) => t.id), [idMap.get("child")]);

  const status = await c.executionStatus({ plan_id, project_id });
  assert.equal(status.ok, true);
  assert.equal(status.items.length, 1);
  assert.equal(status.by_status.done, 1);
  assert.equal(status.task_status.completed, 1);
  assert.deepEqual(status.executions, status.items);
});

// ---- 14. project isolation -------------------------------------------------
test("14. coordination never crosses project boundaries", async () => {
  const { coord: c } = await load();
  const a = await seedPlan([{ key: "a" }]);
  const b = await seedPlan([{ key: "b" }]);
  const cross = await c.claimTask({
    plan_id: a.plan_id, task_id: a.idMap.get("a"), agent: "general", project_id: b.project_id,
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, "task not found in plan/project");
  const viewA = await c.executionStatus({ plan_id: a.plan_id, project_id: a.project_id });
  const viewB = await c.executionStatus({ plan_id: b.plan_id, project_id: b.project_id });
  assert.equal(viewA.items.length, 0);
  assert.equal(viewB.items.length, 0);
  const readyB = await c.getReadyTasks({ plan_id: a.plan_id, project_id: b.project_id });
  assert.equal(readyB.tasks.length, 0);
});

// ---- 15. invalid inputs never throw ---------------------------------------
test("15. malformed inputs return ok:false without throwing", async () => {
  const { coord: c, registry: reg } = await load();
  const bad = [undefined, null, 123, "x", [], {}];
  for (const v of bad) {
    assert.equal((await reg.selectAgents(v)).ok, false);
    assert.equal((await c.claimTask(v)).ok, false);
    assert.equal((await c.completeTask(v)).ok, false);
    assert.equal((await c.failTask(v)).ok, false);
    assert.equal((await c.retryFailed(v)).ok, false);
    assert.equal((await c.getReadyTasks(v)).ok, false);
    assert.equal((await c.executionStatus(v)).ok, false);
  }
  assert.equal((await c.claimTask({ project_id: "p" })).ok, false);
  assert.equal((await c.completeTask({ plan_id: "x", task_id: "y", project_id: "p" })).ok, false);
  assert.equal((await reg.selectAgents({ tasks: "no", agents: [] })).ok, false);
  assert.equal((await reg.selectAgents({ tasks: [], agents: "no" })).ok, false);
});

// ---- 16. close pool --------------------------------------------------------
test("16. close pool once", async () => {
  const { core: db } = await load();
  await db.close();
});
