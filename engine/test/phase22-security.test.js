// Phase 22 workstream E — security, isolation and reliability tests for the
// agent-orchestration layer.
//
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), HARNESS_SEMANTIC_LLM=0.
// Unique project ids; no row is ever deleted, reclassified or overwritten in
// place. Sibling modules are imported dynamically and a missing module skips
// only the affected test / portion of a test. core.close() is called AT MOST
// once, in the FINAL test, and nothing runs after it.
//
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase22-security.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

const RUN = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const projectA = `p22sec-a-${RUN}`;
const projectB = `p22sec-b-${RUN}`;
const downProject = `p22sec-down-${RUN}`;

// Dynamic import with a null result; tests use t.skip when a sibling is absent.
async function load(name) {
  try { return await import(`../src/${name}.js`); }
  catch { return null; }
}
const srcFile = (name) => path.join(import.meta.dirname, "..", "src",
  name.endsWith(".js") ? name : `${name}.js`);
const readSource = (name) => {
  try { return fs.readFileSync(srcFile(name), "utf8"); }
  catch { return null; }
};
const allSourcesPresent = (names) => names.every((n) => fs.existsSync(srcFile(n)));

// Remove comments so "never exec/spawn" documentation cannot trip the static
// destructive-operation check.
const stripComments = (s) => String(s || "")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const firstArray = (obj, keys) => {
  for (const k of keys) if (Array.isArray(obj?.[k])) return obj[k];
  return [];
};

// Is an "agent completed" verdict an acceptance claim? Conservative: anything
// that explicitly signals rejection / missing evidence is NOT an acceptance.
function claimAccepted(value) {
  if (!value || typeof value !== "object") return false;
  if (value.accepted === true || value.promoted === true || value.verified === true) return true;
  const v = String(value.verdict ?? value.status ?? "").toLowerCase();
  if (!v) return false;
  if (/reject|fail|insufficien|need|miss|pending|infer|uncertain|unverified|denied|disput/.test(v)) return false;
  return /accept|pass|approve|done|complete|verified|success|ready/.test(v);
}

const fx = {};

test.before(async () => {
  const core = await load("core");
  if (!core) throw new Error("core module unavailable; cannot run Phase 22 security tests");

  // Idempotent, additive schema guards (no-ops once migration 020 is applied).
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
    CREATE TABLE IF NOT EXISTS agent_execution (
      id bigserial PRIMARY KEY,
      plan_id text NOT NULL,
      task_id text NOT NULL,
      project_id text NOT NULL,
      agent text NOT NULL,
      session_id text,
      status text NOT NULL DEFAULT 'running',
      result jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text,
      attempts integer NOT NULL DEFAULT 1,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      UNIQUE (plan_id, task_id, attempts)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS agent_context_ledger (
      id bigserial PRIMARY KEY,
      plan_id text NOT NULL,
      task_id text NOT NULL,
      project_id text NOT NULL,
      agent text NOT NULL,
      item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      context_chars integer NOT NULL DEFAULT 0,
      degraded jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS agent_review (
      id bigserial PRIMARY KEY,
      plan_id text NOT NULL,
      task_id text NOT NULL,
      project_id text NOT NULL,
      verdict text NOT NULL,
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      reviewer text NOT NULL DEFAULT 'system',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  for (const col of [
    "plan_id text",
    "objective text NOT NULL DEFAULT ''",
    "dependencies jsonb NOT NULL DEFAULT '[]'::jsonb",
    "parallel_group integer NOT NULL DEFAULT 0",
    "assigned_agent text",
    "required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb",
    "file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb",
    "completion_criteria jsonb NOT NULL DEFAULT '[]'::jsonb",
    "risk_level text NOT NULL DEFAULT 'low'",
    "priority integer NOT NULL DEFAULT 0",
    "attempts integer NOT NULL DEFAULT 0",
    "result_ref jsonb NOT NULL DEFAULT '{}'::jsonb",
  ]) {
    await core.dbQuery(`ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS ${col}`);
  }

  fx.sessionA = `p22sec-sess-a-${RUN}`;
  fx.bCanary = `p22sec-B-ONLY-${RUN}`;
  fx.memA = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "A private note", content: `alpha-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.memB = await core.saveMemory({ layer: "project", project_id: projectB,
    title: "B private note", content: fx.bCanary, source_kind: "observed", noEmbed: true });
  fx.ineligibleGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "ineligible global", content: `global-no-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.eligibleGlobal = await core.saveMemory({ layer: "user", project_id: "_global",
    title: "eligible global", content: `global-yes-${RUN}`, source_kind: "user",
    verified: true, metadata: { global_approval: true }, noEmbed: true });
  fx.assistantGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "assistant claim global", content: `global-assistant-${RUN}`,
    source_kind: "attempt", verified: false, noEmbed: true });

  fx.genericCanary = `P22SEC_CANARY_${RUN}`;
  fx.canaryMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "canary holder", content: fx.genericCanary, source_kind: "observed", noEmbed: true });

  // Credential-shaped canaries: recognized by core/llm redactors so the write
  // path, injection path and ledger/review paths must all strip them.
  fx.skCanary = `sk-${"a".repeat(32)}`;
  fx.bearerCanary = `Bearer sk-${"b".repeat(32)}`;
  fx.awsCanary = `AKIA${"C".repeat(16)}`;
  fx.secretMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "secret holder", content: `${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}`,
    source_kind: "observed", noEmbed: true });

  // Two project-scoped plans. B's request embeds a unique non-credential canary
  // so cross-project context leakage is detectable without redaction noise.
  const dec = await load("taskDecomposition");
  if (dec) {
    const reqA = `- Implement p22sec-a.js\n- Write tests for p22sec-a.test.js`;
    const reqB = `- Implement ${fx.bCanary}.js\n- Write tests for ${fx.bCanary}.test.js`;
    const decA = dec.decomposeTask({ project_id: projectA, session_id: fx.sessionA, request: reqA });
    const decB = dec.decomposeTask({ project_id: projectB, session_id: `p22sec-sess-b-${RUN}`, request: reqB });
    if (decA.ok && decB.ok) {
      const sA = await dec.savePlan({ project_id: projectA, session_id: fx.sessionA,
        request: reqA, tasks: decA.tasks });
      const sB = await dec.savePlan({ project_id: projectB, session_id: `p22sec-sess-b-${RUN}`,
        request: reqB, tasks: decB.tasks });
      fx.planA = sA.ok ? sA.plan_id : null;
      fx.planB = sB.ok ? sB.plan_id : null;
      if (fx.planA) {
        fx.tasksA = (await dec.getTasks({ project_id: projectA, plan_id: fx.planA, limit: 10 })).tasks || [];
        fx.taskA = fx.tasksA[0]?.id || null;
      }
      if (fx.planB) {
        fx.tasksB = (await dec.getTasks({ project_id: projectB, plan_id: fx.planB, limit: 10 })).tasks || [];
        fx.taskB = fx.tasksB[0]?.id || null;
      }
    }
  }

  fx.countTable = async (table) => (await core.dbQuery(
    `SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n || 0;
});

// ---------------------------------------------------------------------------
// 1. Project A cannot read, modify or claim tasks from Project B.
// ---------------------------------------------------------------------------
test("1. Project A cannot read, modify or claim Project B tasks", async (t) => {
  const core = await load("core");
  const dec = await load("taskDecomposition");
  const coord = await load("agentCoordination");
  const ctx = await load("agentContext");
  const authz = await load("memoryAuthorization");
  if (!core || !dec || !fx.planA || !fx.planB) return t.skip("task plans not yet available");

  // READ: cross-project plan/task lookups are empty/fail-closed.
  const gp = await dec.getPlan({ project_id: projectA, plan_id: fx.planB });
  assert.ok(!gp.plan || gp.plan.project_id !== projectB, "A must not read B's plan");
  assert.equal(firstArray(gp, ["tasks"]).some((x) => x.id === fx.taskB), false);
  const gt = await dec.getTasks({ project_id: projectA, plan_id: fx.planB, limit: 50 });
  assert.equal(firstArray(gt, ["tasks"]).some((x) => x.id === fx.taskB), false);
  const lp = await dec.listPlans({ project_id: projectA, limit: 200 });
  assert.equal(firstArray(lp, ["plans"]).some((p) => p.id === fx.planB), false);

  // MODIFY: a cross-project file-ownership write leaves B's task untouched.
  if (ctx?.registerFileOwnership) {
    const before = (await core.dbQuery(
      "SELECT file_ownership FROM dev_task WHERE id=$1", [fx.taskB])).rows[0]?.file_ownership;
    try { await ctx.registerFileOwnership({ project_id: projectA, plan_id: fx.planB,
      task_id: fx.taskB, files: ["p22sec-hijack.js"] }); } catch { /* fail closed is fine */ }
    const after = (await core.dbQuery(
      "SELECT file_ownership FROM dev_task WHERE id=$1", [fx.taskB])).rows[0]?.file_ownership;
    assert.deepEqual(after, before, "A must not modify B's file ownership");
  }

  // CLAIM / COMPLETE: no execution row is ever recorded in A for B's task.
  if (coord?.claimTask) {
    try { await coord.claimTask({ project_id: projectA, plan_id: fx.planB,
      task_id: fx.taskB, agent: "p22sec-probe" }); } catch { /* fail closed is fine */ }
  }
  if (coord?.completeTask) {
    try { await coord.completeTask({ project_id: projectA, plan_id: fx.planB,
      task_id: fx.taskB, agent: "p22sec-probe", result: { status: "done" } }); } catch { /* fail closed */ }
  }
  const claims = await core.dbQuery(
    "SELECT project_id FROM agent_execution WHERE task_id=$1", [fx.taskB]);
  assert.equal(claims.rows.some((r) => r.project_id === projectA), false,
    "A must never claim or complete B's task");
  const bTask = (await core.dbQuery(
    "SELECT project_id, status, attempts FROM dev_task WHERE id=$1", [fx.taskB])).rows[0];
  assert.equal(bTask.project_id, projectB);
  assert.equal(bTask.status, "pending", "B's task status is unchanged by A");
  assert.equal(Number(bTask.attempts), 0, "B's task attempts are unchanged by A");

  // Direct memory authorization is unchanged: B's memories stay denied.
  if (authz) {
    const denied = await authz.authorizeMemoryAccess({
      tool: "memory_get", project_id: projectA, memory_id: fx.memB.id });
    assert.equal(denied.allowed, false);
    assert.equal(denied.scope, "denied");
  }
});

// ---------------------------------------------------------------------------
// 2. Global eligibility unchanged; no cross-project context leakage.
// ---------------------------------------------------------------------------
test("2. Global eligibility unchanged; prepareAgentContext leaks no cross-project context", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const ctx = await load("agentContext");
  if (!core || !scope) return t.skip("core modules not yet available");

  assert.equal(scope.isGloballyEligible(fx.eligibleGlobal), true);
  assert.equal(scope.isGloballyEligible(fx.ineligibleGlobal), false);
  assert.equal(scope.isGloballyEligible(fx.assistantGlobal), false);
  assert.equal(scope.isGloballyEligible({ global_eligible: true, source_kind: "assistant",
    layer: "knowledge", verified: false }), true, "an explicit flag is sufficient");
  assert.equal(scope.isGloballyEligible({ source_kind: "user", layer: "user", verified: false,
    metadata: { global_approval: true } }), false, "unverified user facts are not eligible");

  const filtered = scope.filterMemoryResults(
    [fx.memA, fx.memB, fx.eligibleGlobal, fx.ineligibleGlobal, fx.assistantGlobal],
    { project_id: projectA });
  const ids = filtered.map((m) => m.id);
  assert.ok(ids.includes(fx.memA.id));
  assert.ok(ids.includes(fx.eligibleGlobal.id));
  assert.equal(ids.includes(fx.memB.id), false);
  assert.equal(ids.includes(fx.ineligibleGlobal.id), false);
  assert.equal(ids.includes(fx.assistantGlobal.id), false);

  const listed = await core.listMemories({ project_id: projectA, limit: 200 });
  assert.equal(listed.some((m) => m.id === fx.memB.id), false);
  const no = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.ineligibleGlobal.id]);
  assert.equal(no.rowCount, 0);
  const yes = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.eligibleGlobal.id]);
  assert.equal(yes.rowCount, 1);

  if (!ctx?.prepareAgentContext) {
    t.diagnostic("skipping context-leak portion: agentContext not yet available");
    return;
  }
  const r = await ctx.prepareAgentContext({ project_id: projectA, plan_id: fx.planA,
    task_id: fx.taskA, request: `summarise alpha-${RUN}`, budget_chars: 2500 });
  assert.ok(r && typeof r === "object", "prepareAgentContext must return an object");
  const blob = JSON.stringify(r);
  assert.equal(blob.includes(fx.bCanary), false, "B's private content leaked into A's agent context");
  if (fx.planB) assert.equal(blob.includes(fx.planB), false, "B's plan id leaked into A's context");
  if (fx.taskB) assert.equal(blob.includes(fx.taskB), false, "B's task id leaked into A's context");
});

// ---------------------------------------------------------------------------
// 3. Secret canaries absent from agent context, ledgers, reviews and audits.
// ---------------------------------------------------------------------------
test("3. sk-/Bearer/AKIA canaries never appear in agent context, ledgers, reviews or audits", async (t) => {
  const core = await load("core");
  const ctx = await load("agentContext");
  const val = await load("agentValidation");
  const integ = await load("agentIntegration");
  const budget = await load("injectionBudget");
  if (!core) return t.skip("core module not yet available");

  const canaries = [fx.skCanary, fx.bearerCanary, fx.awsCanary];
  const assertClean = (value, label) => {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    for (const c of canaries) {
      assert.equal(s.includes(c), false, `${label} leaked ${c.slice(0, 14)}...`);
    }
  };

  assert.doesNotMatch(core.redact(`key ${fx.skCanary}`), /sk-aaa/);
  assert.doesNotMatch(core.redact(`key ${fx.awsCanary}`), /AKIACCC/);
  assertClean((await core.getMemory(fx.secretMem.id)).content, "stored memory");

  if (ctx?.prepareAgentContext) {
    const r = await ctx.prepareAgentContext({ project_id: projectA, plan_id: fx.planA,
      task_id: fx.taskA, request: `use ${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}`,
      budget_chars: 2500 });
    assertClean(r, "agent context");
  }
  if (val?.validateTaskResult && fx.taskA) {
    const r = await val.validateTaskResult({ project_id: projectA, plan_id: fx.planA,
      task_id: fx.taskA, claimed_done: true,
      evidence: [{ output: `token ${fx.skCanary} auth ${fx.bearerCanary} key ${fx.awsCanary}` }],
      completion_criteria: ["tests pass"], reviewer: "p22sec-probe" });
    assertClean(r, "validation result");
  }
  if (integ?.integrateResults && fx.planA) {
    const r = await integ.integrateResults({ project_id: projectA, plan_id: fx.planA,
      actor: "p22sec-probe" });
    assertClean(r, "integration report");
  }
  for (const table of ["agent_context_ledger", "agent_review", "agent_execution",
    "agent_plan", "dev_task"]) {
    const { rows } = await core.dbQuery(`SELECT * FROM ${table} WHERE project_id=$1 LIMIT 50`, [projectA]);
    assertClean(rows, `${table} rows`);
  }
  const auditRows = await core.dbQuery(
    `SELECT * FROM audit_log WHERE resource LIKE $1 OR detail::text LIKE $1 LIMIT 50`,
    [`%${fx.planA || RUN}%`]);
  assertClean(auditRows.rows, "audit_log");
  const intelRows = await core.dbQuery(
    `SELECT * FROM intelligence_audit_events WHERE resource=$1 OR detail::text LIKE $2 LIMIT 50`,
    [fx.planA || RUN, `%${RUN}%`]);
  assertClean(intelRows.rows, "intelligence_audit_events");

  // The existing injection path redacts the same canaries (reuse contract).
  if (budget) {
    const f = budget.formatInjection({ project_id: projectA, budget_chars: 4000,
      items: [{ id: "p22sec-secret-probe",
        content: `${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}` }] });
    assert.equal(f.ok, true);
    assert.match(f.text, /UNTRUSTED/);
    assertClean(f.text, "injected context");
    assert.match(f.text, /\[REDACTED/);
  }
});

// ---------------------------------------------------------------------------
// 4. Retrieved memory remains untrusted in prepareContext output.
// ---------------------------------------------------------------------------
test("4. prepareContext keeps the UNTRUSTED banner and instruction precedence", async () => {
  const pc = await load("contextPackage");
  if (!pc) return t.skip("contextPackage module not yet available");
  const r = await pc.prepareContext({ project_id: projectA,
    query: `summarise alpha-${RUN}`, budget_chars: 2500 });
  assert.equal(r.ok, true);
  assert.match(r.context, /UNTRUSTED HISTORICAL REFERENCE DATA/);
  assert.match(r.context, /current user request|current user instructions take precedence/i);
  assert.match(r.note, /untrusted historical reference data/i);
  assert.match(r.note, /current user instructions always take precedence/i);
});

// ---------------------------------------------------------------------------
// 5. Pipeline audit returns ok with every wiring check present.
// ---------------------------------------------------------------------------
test("5. Pipeline audit returns ok with all wiring checks present", async (t) => {
  const pa = await load("pipelineAudit");
  if (!pa) return t.skip("pipelineAudit module not yet available");
  const needed = ["agentOrchestrator", "taskDecomposition", "agentRegistry",
    "agentCoordination", "agentContext", "agentConflicts", "agentValidation",
    "agentIntegration", "agentWorkflowLearning"];
  if (!allSourcesPresent(needed)) return t.skip("sibling Phase 22 source files not yet available");
  const a = pa.auditPipelineIntegrity();
  assert.equal(a.ok, true, `missing checks: ${(a.missing || []).join(", ")}`);
  assert.ok(a.summary.total > 0);
  assert.equal(a.summary.missing, 0);
  assert.equal(a.checks.length, a.summary.total);
  assert.equal(a.checks.filter((c) => c.ok === true && c.present === true && c.missing === false).length,
    a.checks.length, "every check is present");
  assert.deepEqual(a.missing, []);
  for (const id of ["p22.orchestrator", "p22.decomposition", "p22.selection",
    "p22.coordination", "p22.context-conflicts", "p22.validation",
    "p22.workflow-learning", "p22.cli-integration", "p22.mcp-integration"]) {
    assert.ok(a.present.includes(id), `expected p22 wiring check ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Bounded listing / status functions respect their limits.
// ---------------------------------------------------------------------------
test("6. Bounded listing and status functions respect their limits", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const authz = await load("memoryAuthorization");
  const dec = await load("taskDecomposition");
  const coord = await load("agentCoordination");
  const val = await load("agentValidation");
  const workflow = await load("agentWorkflowLearning");
  if (!core || !scope) return t.skip("core modules not yet available");

  const bounded = (r, keys, limit, label) => {
    assert.ok(!r || r.ok !== false, `${label} unexpectedly failed: ${r?.reason || ""}`);
    const arr = firstArray(r, keys);
    assert.ok(arr.length <= limit, `${label} returned ${arr.length} items, limit ${limit}`);
  };

  bounded(await scope.globalMisclassificationReport({ limit: 2 }), ["items"], 2,
    "globalMisclassificationReport");
  bounded(await authz.securityAuditReport({ project_id: projectA, limit: 2 }), ["items"], 2,
    "securityAuditReport");
  assert.ok((await core.listMemories({ project_id: projectA, limit: 2 })).length <= 2);

  if (dec) {
    bounded(await dec.listPlans({ project_id: projectA, limit: 2 }), ["plans"], 2, "listPlans");
    bounded(await dec.getTasks({ project_id: projectA, limit: 2 }), ["tasks"], 2, "getTasks");
  }
  if (coord?.executionStatus && fx.planA) {
    bounded(await coord.executionStatus({ project_id: projectA, plan_id: fx.planA, limit: 2 }),
      ["items", "executions"], 2, "executionStatus");
  }
  if (val?.getReviews && fx.planA) {
    bounded(await val.getReviews({ project_id: projectA, plan_id: fx.planA, limit: 2 }),
      ["items", "reviews"], 2, "getReviews");
  }
  if (workflow?.agentPerformance) {
    // This aggregate requires an agent name and returns counts, not an items list.
    const perf = await workflow.agentPerformance({ project_id: projectA,
      agent: "p22sec-probe", limit: 2 });
    assert.ok(perf?.ok !== false, `agentPerformance failed: ${perf?.reason || perf?.note || ""}`);
    assert.ok(Number(perf?.total || 0) <= 2,
      `agentPerformance total ${perf?.total} exceeds the limit of 2`);
  }
});

// ---------------------------------------------------------------------------
// 7. Unsupported agent completion claim is rejected by validation.
// ---------------------------------------------------------------------------
test("7. validateTaskResult rejects a completion claim without evidence", async (t) => {
  const core = await load("core");
  const val = await load("agentValidation");
  if (!val?.validateTaskResult) return t.skip("agentValidation not yet available");
  if (!fx.taskA) return t.skip("task fixture not available");

  const before = (await core.dbQuery(
    "SELECT COALESCE(MAX(id),0)::int AS n FROM agent_review")).rows[0].n;
  const r = await val.validateTaskResult({ project_id: projectA, plan_id: fx.planA,
    task_id: fx.taskA, claimed_done: true, evidence: [],
    completion_criteria: ["tests pass", "independent verification"],
    reviewer: "p22sec-probe" });
  assert.equal(claimAccepted(r), false,
    "an unsupported agent self-report must never be accepted as completed");

  const newRows = (await core.dbQuery(
    "SELECT verdict, reasons FROM agent_review WHERE id > $1 AND project_id=$2",
    [before, projectA])).rows;
  for (const row of newRows) {
    assert.equal(claimAccepted(row), false, "no new review may accept the unsupported claim");
  }
});

// ---------------------------------------------------------------------------
// 8. Destructive operations are never executed; only review records are written.
// ---------------------------------------------------------------------------
test("8. validateTaskResult/integrateResults never call shell/exec and never delete rows", async (t) => {
  const core = await load("core");
  const val = await load("agentValidation");
  const integ = await load("agentIntegration");

  // Static: the modules must not import a child process API or call exec/spawn.
  for (const name of ["agentValidation", "agentIntegration"]) {
    const raw = readSource(name);
    if (!raw) continue;
    const src = stripComments(raw);
    assert.doesNotMatch(src, /node:child_process|require\(\s*["']child_process["']\s*\)|from\s+["']child_process["']/,
      `${name} must not import child_process`);
    assert.doesNotMatch(src, /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/,
      `${name} must not call exec/spawn`);
    assert.doesNotMatch(src, /\bshell\s*:\s*true/, `${name} must not enable a shell`);
  }
  if (!core || (!val?.validateTaskResult && !integ?.integrateResults)) {
    return t.skip("validation/integration modules not yet available (static checks done)");
  }

  const tables = ["agent_plan", "agent_execution", "agent_context_ledger", "dev_task"];
  const before = {};
  for (const table of tables) before[table] = await fx.countTable(table);

  if (val?.validateTaskResult && fx.taskA) {
    await val.validateTaskResult({ project_id: projectA, plan_id: fx.planA,
      task_id: fx.taskA, claimed_done: false, evidence: [],
      completion_criteria: ["evidence required"], reviewer: "p22sec-probe" });
  }
  if (integ?.integrateResults && fx.planA) {
    await integ.integrateResults({ project_id: projectA, plan_id: fx.planA,
      actor: "p22sec-probe" });
  }
  for (const table of tables) {
    const after = await fx.countTable(table);
    assert.ok(after >= before[table],
      `${table} shrank from ${before[table]} to ${after}: destructive operation detected`);
    assert.equal(after, before[table],
      `${table} changed from ${before[table]} to ${after}: these functions must only write review records`);
  }
});

// ---------------------------------------------------------------------------
// 9. FINAL: database-down graceful degradation. Nothing runs after this test.
// ---------------------------------------------------------------------------
test("9. FINAL: prepareContext degrades gracefully when the database is down", async () => {
  const core = await load("core");
  const pc = await load("contextPackage");
  await core.close(); // the ONLY close() call in this file

  const r = await pc.prepareContext({ project_id: downProject,
    query: `post-close-${RUN}`, budget_chars: 1200 });
  assert.equal(r.ok, true, "context preparation must never block a request");
  assert.equal(typeof r.context, "string");
  assert.ok(r.context.length > 0, "a safe fallback context is still returned");
  assert.ok(Array.isArray(r.audit?.degraded));
  assert.ok(r.audit.degraded.length > 0, "degraded diagnostics expected when the DB is unavailable");
  assert.match(r.context, /UNTRUSTED|current user instructions|no context available/i);
});
