// Phase 22 Feature A — intelligent task decomposition and dependency graphs.
// Unique project ids per test; no LLM/network, no cross-project access.
// Standalone: $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase22-decomposition.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const td = await import("../src/taskDecomposition.js");

const uniq = () => `p22-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const sid = () => `s22-${crypto.randomUUID().slice(0, 8)}`;

const TASK_KEYS = [
  "assigned_agent", "completion_criteria", "dependencies", "description", "file_ownership",
  "id", "objective", "parallel_group", "parent_id", "priority", "required_capabilities",
  "risk_level", "status", "title",
].sort();

const TASK_COLUMNS = [
  "plan_id", "objective", "dependencies", "parallel_group", "assigned_agent",
  "required_capabilities", "file_ownership", "completion_criteria", "risk_level",
  "priority", "attempts", "result_ref",
];

// Defensive, idempotent schema guard (migration 020 is normally already applied
// by the parent session). No existing row/table/constraint is altered.
before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS agent_plan (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      session_id text,
      request text NOT NULL,
      status text NOT NULL DEFAULT 'planned',
      decomposition jsonb NOT NULL DEFAULT '{}'::jsonb,
      context_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await core.dbQuery(`
    ALTER TABLE dev_task
      ADD COLUMN IF NOT EXISTS plan_id text,
      ADD COLUMN IF NOT EXISTS objective text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS parallel_group integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS assigned_agent text,
      ADD COLUMN IF NOT EXISTS required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS completion_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low',
      ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS result_ref jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
});

// ---------------- exports / shape ----------------

test("1. exports are present and MAX_TASKS is bounded", () => {
  for (const name of ["decomposeTask", "validateTaskGraph", "savePlan", "getPlan", "listPlans", "getTasks"]) {
    assert.equal(typeof td[name], "function", `${name} exported`);
  }
  assert.equal(td.MAX_TASKS, 12);
  assert.ok(typeof td.default === "object");
});

// ---------------- deterministic decomposition ----------------

test("2. decomposeTask is pure and deterministic for the same input", () => {
  const input = {
    project_id: uniq(), session_id: sid(),
    request: "Implement the exporter; add unit tests for it; update the docs",
  };
  const a = td.decomposeTask(input);
  const b = td.decomposeTask(input);
  assert.deepEqual(a, b, "identical input gives identical output");
  assert.equal(a.ok, true);
  assert.ok(Array.isArray(a.tasks) && Array.isArray(a.warnings) && Array.isArray(a.degraded));
});

test("3. a complex request yields a root plus independent parallel subtasks", () => {
  const r = td.decomposeTask({
    project_id: uniq(), session_id: sid(),
    request: "Implement the new export feature; add unit tests for the exporter; update the README documentation; harden the API authentication",
  });
  assert.equal(r.ok, true);
  assert.ok(r.tasks.length >= 5, `expected >=5 tasks, got ${r.tasks.length}`);
  const [root, ...children] = r.tasks;
  for (const t of r.tasks) {
    assert.deepEqual(Object.keys(t).sort(), TASK_KEYS, "exact task shape");
    assert.equal(t.status, "pending");
    assert.equal(t.assigned_agent, null);
    assert.ok(Array.isArray(t.dependencies) && Array.isArray(t.required_capabilities));
    assert.ok(Array.isArray(t.file_ownership) && Array.isArray(t.completion_criteria));
  }
  assert.equal(root.parent_id, null);
  assert.deepEqual(root.dependencies, []);
  assert.equal(root.parallel_group, 0);
  assert.ok(children.every((t) => t.parent_id === root.id), "children attach to root");
  assert.ok(children.every((t) => t.parallel_group >= 1), "independent work is parallel");
  assert.ok(children.every((t) => t.dependencies.length === 0), "no invented dependencies");
  assert.ok(children.some((t) => t.required_capabilities.includes("testing")), "explicit testing capability");
  assert.ok(children.some((t) => t.required_capabilities.includes("documentation")), "explicit docs capability");
  assert.equal(td.validateTaskGraph({ tasks: r.tasks }).ok, true, "decomposer never emits a bad graph");
});

test("4. indented lines produce nested parent/child tasks", () => {
  const r = td.decomposeTask({
    project_id: uniq(), session_id: sid(),
    request: [
      "Refactor the parser module",
      "  - update tokenizer logic",
      "  - add parser regression tests",
      "    - cover edge cases",
      "Add integration docs",
    ].join("\n"),
  });
  const tasks = r.tasks;
  assert.ok(tasks.length >= 5);
  // root -> section child -> indented children -> deeper indented grandchild
  assert.equal(tasks[1].parent_id, tasks[0].id);
  assert.equal(tasks[2].parent_id, tasks[1].id, "indented item nests under its section");
  assert.equal(tasks[3].parent_id, tasks[1].id);
  assert.equal(tasks[4].parent_id, tasks[3].id, "deeper indentation nests one level further");
  assert.equal(tasks[5].parent_id, tasks[0].id);
  assert.equal(td.validateTaskGraph({ tasks }).ok, true);
});

test("5. ordering keywords and integration tasks create explicit dependencies only", () => {
  const a = td.decomposeTask({
    project_id: uniq(), session_id: sid(),
    request: "Build the core parser module; add parser tests; integrate the parser with the API layer",
  });
  const integration = a.tasks[3];
  assert.ok(integration.dependencies.includes(a.tasks[1].id), "integration depends on implementation");
  assert.ok(integration.dependencies.includes(a.tasks[2].id));
  assert.ok(integration.parallel_group > a.tasks[1].parallel_group, "dependent task runs later");

  const b = td.decomposeTask({
    project_id: uniq(), session_id: sid(),
    request: "Implement the auth module; after that add login tests",
  });
  assert.ok(b.tasks[2].dependencies.includes(b.tasks[1].id), "'after' depends on the previous task");
  assert.equal(td.validateTaskGraph({ tasks: a.tasks }).ok, true);
  assert.equal(td.validateTaskGraph({ tasks: b.tasks }).ok, true);
});

test("6. empty requests degrade safely without inventing tasks", () => {
  const r = td.decomposeTask({ project_id: uniq(), session_id: sid(), request: "" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks, []);
  assert.ok(r.degraded.includes("empty_request"));
});

// ---------------- graph validation ----------------

test("7. validateTaskGraph detects circular dependencies", () => {
  const r = td.validateTaskGraph({
    tasks: [
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["c"] },
      { id: "c", dependencies: ["a"] },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.cycles.length > 0, "cycle reported");
  assert.ok(r.reasons.some((s) => s.includes("cycle")));
});

test("8. validateTaskGraph detects duplicate ids and missing dependencies", () => {
  const r = td.validateTaskGraph({
    tasks: [
      { id: "a", dependencies: ["missing"] },
      { id: "a", dependencies: [] },
      { id: "b", dependencies: ["a"] },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicates, ["a"]);
  assert.ok(r.missing_dependencies.some((s) => s.includes("missing")));
  assert.equal(td.validateTaskGraph({ tasks: [{ id: "a" }, { id: "b", dependencies: ["a"] }] }).ok, true);
  assert.equal(td.validateTaskGraph({ tasks: "not-an-array" }).ok, false);
});

// ---------------- persistence ----------------

test("9. savePlan persists a full plan with all new columns and get/list reads it back", async () => {
  const project = uniq();
  const session = sid();
  const request = "Implement a summary exporter and add tests for it";
  const dec = td.decomposeTask({
    project_id: project, session_id: session, request,
    context: { files: ["src/exporter.js", "test/exporter.test.js"] },
  });
  const saved = await td.savePlan({
    project_id: project, session_id: session, request,
    tasks: dec.tasks, context_refs: ["src/exporter.js"],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.duplicate, false);
  assert.equal(saved.created_tasks, dec.tasks.length);
  assert.equal(saved.skipped_tasks, 0);

  const got = await td.getPlan({ plan_id: saved.plan_id, project_id: project });
  assert.equal(got.ok, true);
  assert.equal(got.plan.id, saved.plan_id);
  assert.equal(got.plan.project_id, project);
  assert.equal(got.plan.status, "planned");
  assert.ok(Array.isArray(got.plan.decomposition) && Array.isArray(got.plan.context_refs));
  assert.equal(got.tasks.length, dec.tasks.length);
  for (const row of got.tasks) {
    for (const col of TASK_COLUMNS) assert.ok(col in row, `${col} persisted`);
    assert.equal(row.plan_id, saved.plan_id);
    assert.equal(row.project_id, project);
    assert.equal(row.status, "pending");
    assert.equal(row.assigned_agent, null);
    assert.equal(row.attempts, 0);
    assert.ok(Array.isArray(row.dependencies));
    assert.ok(Array.isArray(row.required_capabilities));
    assert.ok(Array.isArray(row.file_ownership));
    assert.ok(Array.isArray(row.completion_criteria));
  }

  const listed = await td.listPlans({ project_id: project });
  assert.equal(listed.ok, true);
  assert.ok(listed.plans.some((p) => p.id === saved.plan_id));
  const pending = await td.getTasks({ plan_id: saved.plan_id, project_id: project, status: "pending" });
  assert.equal(pending.ok, true);
  assert.equal(pending.tasks.length, dec.tasks.length);
  const done = await td.getTasks({ plan_id: saved.plan_id, project_id: project, status: "completed" });
  assert.equal(done.tasks.length, 0);
});

test("10. savePlan/getPlan are idempotent on (project, session, request)", async () => {
  const project = uniq();
  const session = sid();
  const request = "Build the widget and verify the widget";
  const dec = td.decomposeTask({ project_id: project, session_id: session, request });
  const first = await td.savePlan({ project_id: project, session_id: session, request, tasks: dec.tasks });
  const second = await td.savePlan({ project_id: project, session_id: session, request, tasks: dec.tasks });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.created_tasks, 0);
  assert.equal(second.plan_id, first.plan_id);
  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM dev_task WHERE plan_id=$1 AND project_id=$2",
    [first.plan_id, project],
  )).rows[0].n;
  assert.equal(count, dec.tasks.length, "no rows added by the second save");
});

test("11. all reads and writes are project scoped", async () => {
  const project = uniq();
  const other = uniq();
  const session = sid();
  const request = "Implement project scoped isolation";
  const saved = await td.savePlan({
    project_id: project, session_id: session, request,
    tasks: [{ id: "root", title: "Root", description: "root", dependencies: [], priority: 0 }],
  });
  assert.equal(saved.ok, true);
  assert.equal((await td.getPlan({ plan_id: saved.plan_id, project_id: other })).ok, false);
  assert.equal((await td.listPlans({ project_id: other })).plans.length, 0);
  assert.equal((await td.getTasks({ plan_id: saved.plan_id, project_id: other })).tasks.length, 0);
  assert.ok((await td.listPlans({ project_id: project })).plans.some((p) => p.id === saved.plan_id));
});

test("12. invalid inputs fail closed", async () => {
  assert.equal((await td.savePlan({ project_id: "", request: "x" })).ok, false);
  assert.equal((await td.savePlan({ project_id: uniq(), request: "" })).ok, false);
  assert.equal((await td.getPlan({})).ok, false);
  assert.equal((await td.listPlans({})).ok, false);
  assert.equal((await td.getTasks({})).ok, false);
  assert.equal(td.validateTaskGraph({ tasks: "bad" }).ok, false);
});

test("13. task count and field lengths are bounded", async () => {
  const steps = Array.from({ length: 30 }, (_, i) => `step ${i}`).join("; ");
  const capped = td.decomposeTask({ project_id: uniq(), session_id: sid(), request: steps, max_tasks: 5 });
  assert.ok(capped.tasks.length <= 5, "bounded to max_tasks");
  assert.ok(capped.warnings.some((w) => w.includes("capped")));

  const long = td.decomposeTask({
    project_id: uniq(), session_id: sid(), request: `Implement ${"x".repeat(10000)}`,
  });
  for (const t of long.tasks) {
    assert.ok(t.title.length <= 200);
    assert.ok(t.description.length <= 2000);
    assert.ok(t.objective.length <= 1000);
  }

  const project = uniq();
  const saved = await td.savePlan({
    project_id: project, session_id: sid(), request: `Bounded save ${project}`,
    tasks: Array.from({ length: 40 }, (_, i) => ({ id: `t-${i}`, title: `task ${i}` })),
  });
  assert.equal(saved.created_tasks, 24, "hard cap of 24 persisted tasks");
  assert.equal(saved.skipped_tasks, 16, "overflow counted as skipped");
});

test("14. file candidates are derived from explicit paths in context", () => {
  const r = td.decomposeTask({
    project_id: uniq(), session_id: sid(), request: "Refactor core logic",
    context: { files: ["src/core.js", "test/core.test.js"], notes: "see src/db.js" },
  });
  const owned = r.tasks.flatMap((t) => t.file_ownership);
  assert.ok(owned.includes("src/core.js"), "context path captured");
  assert.ok(owned.includes("test/core.test.js"), "second context path captured");
  assert.ok(owned.some((p) => p.includes("src/db.js")), "path inside note captured");
  assert.ok(r.tasks.slice(1).every((t) => t.file_ownership.length > 0));
});

test("15. credential-like content is redacted everywhere", async () => {
  const project = uniq();
  const session = sid();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const request = `Implement export using token ${secret} in src/export.js`;
  const dec = td.decomposeTask({ project_id: project, session_id: session, request });
  assert.ok(!JSON.stringify(dec).includes(secret), "decomposition has no secret");
  assert.ok(dec.degraded.includes("secret_redacted"));
  const saved = await td.savePlan({ project_id: project, session_id: session, request, tasks: dec.tasks });
  assert.equal(saved.ok, true);
  const got = await td.getPlan({ plan_id: saved.plan_id, project_id: project });
  assert.ok(!JSON.stringify(got).includes(secret), "persisted plan has no secret");
});

test("close pool", async () => { await core.close(); });
