// Phase 22 Features D+E — agent context sharing + file-ownership conflicts.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), unique ids, no deletion
// of any row. No LLM and no network.
//
// Run:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase22-context-conflicts.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.MEMORY_DB_NAME = process.env.MEMORY_DB_NAME || "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

let core, ctx, conf;
async function load() {
  if (!core) {
    core = await import("../src/core.js");
    ctx = await import("../src/agentContext.js");
    conf = await import("../src/agentConflicts.js");
  }
  return { core, ctx, conf };
}

const uniq = (p) => `${p}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const token = () => `z${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;

async function insertDecision(project, title, status = "active") {
  const db = core;
  const id = uniq("dec");
  await db.dbQuery(
    `INSERT INTO technical_decision
       (id, project_id, title, description, reasoning, alternatives, consequences,
        evidence, status, confidence, source_session)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [id, project, title.slice(0, 512), `context about ${title}`.slice(0, 2000),
      "recorded for phase22 test", "[]", "[]", "[]", status, 0.9, null],
  );
  return id;
}

async function insertTask({
  project, plan, id, title, files = [], agent = null, group = 0, resultRef = {},
}) {
  await core.dbQuery(
    `INSERT INTO dev_task
       (id, project_id, plan_id, task_key, title, status, objective, dependencies,
        parallel_group, assigned_agent, required_capabilities, file_ownership,
        completion_criteria, risk_level, priority, attempts, result_ref, evidence)
     VALUES ($1,$2,$3,$4,$5,'pending','',$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
             'low',0,0,$12::jsonb,$13::jsonb)`,
    [id, project, plan, `${plan}:${id}`.slice(0, 256), title.slice(0, 256),
      "[]", group, agent, "[]", JSON.stringify(files), "[]",
      JSON.stringify(resultRef), "[]"],
  );
  return id;
}

// ---------------------------------------------------------------------------
// 1. context retrieved + budgeted
// ---------------------------------------------------------------------------
test("1. prepareAgentContext retrieves project context and bounds the text", async () => {
  await load();
  const project = uniq("p1"), plan = uniq("plan1"), task = uniq("task1");
  const t = token();
  await insertDecision(project, `${t} active decision`);

  const r = await ctx.prepareAgentContext({
    plan_id: plan, task_id: task, agent: "agent-a", project_id: project,
    request: `summarize ${t}`, context_budget: 700,
  });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.items) && r.items.length >= 1, "at least one item supplied");
  assert.equal(r.chars, r.text.length);
  assert.ok(r.text.length <= 700, "text respects the budget");
  assert.ok(Array.isArray(r.degraded));
  assert.ok(r.items.every((i) => i.id && i.provenance), "every item carries id + provenance");
  assert.ok(
    r.items.some((i) => `${i.title} ${i.content}`.includes(t)),
    "the project decision appears in the supplied items",
  );
});

// ---------------------------------------------------------------------------
// 2. ledger recorded
// ---------------------------------------------------------------------------
test("2. prepareAgentContext records supplied item ids in agent_context_ledger", async () => {
  await load();
  const project = uniq("p2"), plan = uniq("plan2"), task = uniq("task2");
  await insertDecision(project, `${token()} ledger decision`);

  const r = await ctx.prepareAgentContext({
    plan_id: plan, task_id: task, agent: "ledger-agent", project_id: project, request: "",
  });
  assert.equal(r.ok, true);
  assert.notEqual(r.ledger_id, null, "ledger row id returned");

  const q = await core.dbQuery(
    "SELECT plan_id, task_id, project_id, agent, item_ids, context_chars, degraded FROM agent_context_ledger WHERE id=$1",
    [r.ledger_id],
  );
  assert.equal(q.rowCount, 1);
  const row = q.rows[0];
  assert.equal(row.project_id, project);
  assert.equal(row.plan_id, plan);
  assert.equal(row.task_id, task);
  assert.equal(row.agent, "ledger-agent");
  assert.deepEqual(row.item_ids, r.items.map((i) => i.id));
  assert.equal(row.context_chars, r.chars);
  assert.ok(Array.isArray(row.degraded));
});

// ---------------------------------------------------------------------------
// 3. project isolation
// ---------------------------------------------------------------------------
test("3. context and ledger are project-isolated", async () => {
  await load();
  const pa = uniq("pa"), pb = uniq("pb");
  const planA = uniq("planA"), planB = uniq("planB");
  const ta = token(), tb = token();
  await insertDecision(pa, `${ta} alpha only`);
  await insertDecision(pb, `${tb} beta only`);

  const ra = await ctx.prepareAgentContext({
    plan_id: planA, task_id: uniq("tA"), agent: "a", project_id: pa, request: ta,
  });
  const rb = await ctx.prepareAgentContext({
    plan_id: planB, task_id: uniq("tB"), agent: "b", project_id: pb, request: tb,
  });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);

  const textA = ra.items.map((i) => `${i.title} ${i.content}`).join(" ");
  const textB = rb.items.map((i) => `${i.title} ${i.content}`).join(" ");
  assert.ok(textA.includes(ta) && !textA.includes(tb), "A sees only A's decision");
  assert.ok(textB.includes(tb) && !textB.includes(ta), "B sees only B's decision");

  const la = await core.dbQuery("SELECT project_id FROM agent_context_ledger WHERE id=$1", [ra.ledger_id]);
  assert.equal(la.rows[0].project_id, pa);
});

// ---------------------------------------------------------------------------
// 4. archived / superseded excluded
// ---------------------------------------------------------------------------
test("4. superseded decisions are excluded from agent context", async () => {
  await load();
  const project = uniq("p4");
  const t = token();
  await insertDecision(project, `${t} ACTIVE_MARKER`);
  await insertDecision(project, `${t} SUPERSEDED_MARKER`, "superseded");

  const r = await ctx.prepareAgentContext({
    plan_id: uniq("plan4"), task_id: uniq("task4"), agent: "a",
    project_id: project, request: t,
  });
  assert.equal(r.ok, true);
  const text = r.items.map((i) => `${i.title} ${i.content}`).join(" ");
  assert.ok(text.includes("ACTIVE_MARKER"), "active decision present");
  assert.ok(!text.includes("SUPERSEDED_MARKER"), "superseded decision excluded");
});

// ---------------------------------------------------------------------------
// 5. handoff summary
// ---------------------------------------------------------------------------
test("5. contextForHandoff summarises prior task result refs (project-scoped)", async () => {
  await load();
  const project = uniq("p5"), plan = uniq("plan5");
  const from = uniq("from"), to = uniq("to");
  await insertTask({
    project, plan, id: from, title: "Implement auth",
    resultRef: { memory_id: "m-handoff-1", files: ["auth.js"], note: "done" },
  });

  const r = await ctx.contextForHandoff({ plan_id: plan, from_task: from, to_task: to, project_id: project });
  assert.equal(r.ok, true);
  assert.match(r.text, /Handoff/);
  assert.ok(r.text.length <= 1800, "handoff text is bounded");
  assert.ok(r.items.length >= 1);
  const joined = r.items.map((i) => `${i.title} ${i.content}`).join(" ");
  assert.ok(joined.includes("memory_id") && joined.includes("m-handoff-1"));
  assert.ok(r.items.every((i) => i.provenance === "handoff"));

  // Same plan/task id in a different project cannot read the refs.
  const other = await ctx.contextForHandoff({ plan_id: plan, from_task: from, to_task: to, project_id: uniq("p5b") });
  assert.equal(other.ok, true);
  assert.equal(other.items.length, 0);
});

// ---------------------------------------------------------------------------
// 6. ownership registration
// ---------------------------------------------------------------------------
test("6. registerFileOwnership records file claims without conflicts", async () => {
  await load();
  const project = uniq("p6"), plan = uniq("plan6"), task = uniq("task6");
  await insertTask({ project, plan, id: task, title: "Owner A", files: [] });

  const r = await conf.registerFileOwnership({
    plan_id: plan, task_id: task, agent: "agent-a",
    files: ["src/a.js", "src/b.js"], project_id: project,
  });
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.deepEqual(r.conflicts, []);

  const q = await core.dbQuery("SELECT file_ownership FROM dev_task WHERE id=$1", [task]);
  assert.deepEqual(new Set(q.rows[0].file_ownership), new Set(["src/a.js", "src/b.js"]));
});

// ---------------------------------------------------------------------------
// 7. shared-file conflict detection
// ---------------------------------------------------------------------------
test("7. shared file across two tasks is detected by register + detectConflicts", async () => {
  await load();
  const project = uniq("p7"), plan = uniq("plan7");
  const a = uniq("a7"), b = uniq("b7");
  await insertTask({ project, plan, id: a, title: "Task A", files: [], agent: "agent-a" });
  await insertTask({ project, plan, id: b, title: "Task B", files: [], agent: "agent-b" });

  const r1 = await conf.registerFileOwnership({
    plan_id: plan, task_id: a, agent: "agent-a", files: ["shared.js"], project_id: project,
  });
  assert.equal(r1.accepted, true);

  const r2 = await conf.registerFileOwnership({
    plan_id: plan, task_id: b, agent: "agent-b", files: ["shared.js"], project_id: project,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.accepted, false, "contested claim is not cleanly accepted");
  const conflict = r2.conflicts.find((c) => c.file === "shared.js");
  assert.ok(conflict, "shared.js reported as a conflict");
  assert.ok(conflict.tasks.includes(a) && conflict.tasks.includes(b));
  assert.ok(["single-owner", "sequentialize", "split"].includes(conflict.recommendation));

  // The contested file is persisted on both tasks, so a full scan sees it.
  const d = await conf.detectConflicts({ plan_id: plan, project_id: project });
  assert.equal(d.ok, true);
  assert.ok(d.conflicts.some((c) => c.file === "shared.js"));
});

// ---------------------------------------------------------------------------
// 8. sequential / single-owner / split recommendations
// ---------------------------------------------------------------------------
test("8. recommendations: parallel group => sequentialize, shared agent => single-owner, 3+ => split", async () => {
  await load();
  const project = uniq("p8"), plan = uniq("plan8");

  // Two different agents in the SAME parallel group.
  const a = uniq("a8"), b = uniq("b8");
  await insertTask({ project, plan, id: a, title: "A", files: [], agent: "agent-x", group: 1 });
  await insertTask({ project, plan, id: b, title: "B", files: [], agent: "agent-y", group: 1 });
  await conf.registerFileOwnership({ plan_id: plan, task_id: a, agent: "agent-x", files: ["seq.js"], project_id: project });
  const seq = await conf.registerFileOwnership({ plan_id: plan, task_id: b, agent: "agent-y", files: ["seq.js"], project_id: project });
  assert.equal(seq.conflicts.find((c) => c.file === "seq.js").recommendation, "sequentialize");

  // Same agent, different parallel groups.
  const c = uniq("c8"), d = uniq("d8");
  await insertTask({ project, plan, id: c, title: "C", files: [], agent: "agent-same", group: 2 });
  await insertTask({ project, plan, id: d, title: "D", files: [], agent: "agent-same", group: 3 });
  await conf.registerFileOwnership({ plan_id: plan, task_id: c, agent: "agent-same", files: ["one.js"], project_id: project });
  const one = await conf.registerFileOwnership({ plan_id: plan, task_id: d, agent: "agent-same", files: ["one.js"], project_id: project });
  assert.equal(one.conflicts.find((x) => x.file === "one.js").recommendation, "single-owner");

  // Three claimants => split.
  const e = uniq("e8"), f = uniq("f8"), g = uniq("g8");
  for (const [id, agent, group] of [[e, "e", 4], [f, "f", 5], [g, "g", 6]]) {
    await insertTask({ project, plan, id, title: id, files: [], agent, group });
  }
  await conf.registerFileOwnership({ plan_id: plan, task_id: e, agent: "e", files: ["big.js"], project_id: project });
  await conf.registerFileOwnership({ plan_id: plan, task_id: f, agent: "f", files: ["big.js"], project_id: project });
  const three = await conf.registerFileOwnership({ plan_id: plan, task_id: g, agent: "g", files: ["big.js"], project_id: project });
  assert.equal(three.conflicts.find((x) => x.file === "big.js").recommendation, "split");
});

// ---------------------------------------------------------------------------
// 9. handoff validation
// ---------------------------------------------------------------------------
test("9. validateHandoff detects shared-file conflicts and clean handoffs", async () => {
  await load();
  const project = uniq("p9"), plan = uniq("plan9");
  const a = uniq("a9"), b = uniq("b9"), c = uniq("c9");
  await insertTask({ project, plan, id: a, title: "A", files: ["x.js"] });
  await insertTask({ project, plan, id: b, title: "B", files: ["y.js"] });
  await insertTask({ project, plan, id: c, title: "C", files: ["x.js"] });

  const clean = await conf.validateHandoff({ plan_id: plan, from_task: a, to_task: b, project_id: project });
  assert.equal(clean.ok, true);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.conflicts, []);

  const dirty = await conf.validateHandoff({ plan_id: plan, from_task: a, to_task: c, project_id: project });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.clean, false);
  assert.ok(dirty.conflicts.some((x) => x.file === "x.js" && x.tasks.includes(a) && x.tasks.includes(c)));

  const missing = await conf.validateHandoff({ plan_id: plan, from_task: uniq("none"), to_task: b, project_id: project });
  assert.equal(missing.ok, false);
});

// ---------------------------------------------------------------------------
// 10. invalid input
// ---------------------------------------------------------------------------
test("10. invalid inputs fail closed", async () => {
  await load();
  assert.equal((await ctx.prepareAgentContext({})).ok, false);
  assert.equal((await ctx.contextForHandoff({})).ok, false);
  assert.equal((await conf.registerFileOwnership({})).ok, false);
  assert.equal((await conf.detectConflicts({})).ok, false);
  assert.equal((await conf.validateHandoff({})).ok, false);
});

// ---------------------------------------------------------------------------
// 11. close the shared pool exactly once
// ---------------------------------------------------------------------------
test("11. close pool once", async () => {
  await load();
  await core.close();
});
