// Phase 26 — ownership / recovery. Isolated DB only (MEMORY_DB_NAME=opencode_memory_test).
// No source writes, no spawn, no dispatch, no auto-approval. Unique project ids per
// test; no destructive assertions; core.close() called exactly once in the final test.
//
// Run: node --test test/phase26-recovery.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

const core = await import("../src/core.js");
const own = await import("../src/projectOwnership.js");
const rec = await import("../src/projectRecovery.js");
const approvals = await import("../src/workflowApproval.js");

const uniq = () => crypto.randomUUID().slice(0, 8);
const proj = (tag = "p26") => `${tag}-${uniq()}`;

before(async () => {
  // Defensive DDL — no-ops when migration 024 is already applied.
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS pm_ownership (
    id uuid PRIMARY KEY, project_id text NOT NULL, task_id text NOT NULL, agent text NOT NULL,
    assignment_reason text NOT NULL DEFAULT '', scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    expected_output text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'planned',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb, handoff jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, task_id, agent))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS pm_dependency (
    id bigserial PRIMARY KEY, project_id text NOT NULL, from_type text NOT NULL, from_id text NOT NULL,
    to_type text NOT NULL, to_id text NOT NULL, dependency_type text NOT NULL DEFAULT 'inferred',
    confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, from_type, from_id, to_type, to_id, dependency_type))`);
});

async function seedGoal(project_id, status = "active") {
  const id = `goal-${uniq()}`;
  await core.dbQuery(
    "INSERT INTO dev_goal (id, project_id, title, description, status) VALUES ($1,$2,$3,$4,$5)",
    [id, project_id, `goal ${id}`, "", status]);
  return id;
}

async function seedTask(project_id, opts = {}) {
  const { goal_id = null, status = "failed", deps = [], evidence = [] } = opts;
  const id = `task-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO dev_task (id, project_id, task_key, title, status, goal_id, dependencies, evidence, source_session)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [id, project_id, `${id}:key`, `task ${id}`, status, goal_id,
      JSON.stringify(deps), JSON.stringify(evidence), `sess-${uniq()}`]);
  return id;
}

function binding(id, overrides = {}) {
  return {
    plan_id: `plan-${id}`, plan_version: "v1", plan_hash: `hash-${id}`,
    scope: {}, mode: "simulation", risk: "low", approved_by: "operator", ...overrides,
  };
}

async function makeApproval(project_id, id, overrides = {}) {
  const b = binding(id, overrides);
  const r = await approvals.createApproval({ project_id, ...b });
  assert.equal(r.ok, true, r.reason);
  return { approval_id: r.approval_id, token: r.token, ...b };
}

// ---------------------------------------------------------------------------
// 1. Exports
// ---------------------------------------------------------------------------
test("1. exact exports exist", () => {
  assert.deepEqual(Object.keys(own.default).sort(),
    ["assignOwner", "getOwnership", "ownershipOverview", "setOwnershipState"]);
  assert.deepEqual(Object.keys(rec.default).sort(), ["assessRecovery", "prepareRecovery"]);
});

// ---------------------------------------------------------------------------
// 2-4. assignOwner: happy path, duplicate, task validation + invalid inputs
// ---------------------------------------------------------------------------
test("2. assignOwner records a PLANNED assignment", async () => {
  const p = proj();
  const t = await seedTask(p);
  const r = await own.assignOwner({ project_id: p, task_id: t, agent: "general",
    assignment_reason: "implement feature", scope: { files: ["src/a.js"] },
    expected_output: "patch", created_by: "operator" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.duplicate, false);
  assert.equal(r.status, "planned");
  assert.ok(r.id);
  assert.match(r.note, /PLANNED only/);
});

test("3. assignOwner is idempotent by (project, task, agent)", async () => {
  const p = proj();
  const t = await seedTask(p);
  const a = await own.assignOwner({ project_id: p, task_id: t, agent: "general", assignment_reason: "r" });
  const b = await own.assignOwner({ project_id: p, task_id: t, agent: "general", assignment_reason: "r2" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  const count = await core.dbQuery("SELECT count(*)::int AS n FROM pm_ownership WHERE project_id=$1", [p]);
  assert.equal(count.rows[0].n, 1);
});

test("4. assignOwner rejects cross-project task and invalid inputs (fail closed)", async () => {
  const pA = proj("own-a"), pB = proj("own-b");
  const tB = await seedTask(pB);
  const cross = await own.assignOwner({ project_id: pA, task_id: tB, agent: "general" });
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /does not belong/);
  for (const fn of [
    () => own.assignOwner(),
    () => own.assignOwner({ project_id: "_global", task_id: "t", agent: "a" }),
    () => own.assignOwner({ project_id: pA, task_id: "t", agent: "a", scope: [] }),
    () => own.getOwnership({ project_id: pA, task_id: "t" }),
    () => own.ownershipOverview({ project_id: "_global" }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

// ---------------------------------------------------------------------------
// 5-9. Honest state transitions + evidence gates
// ---------------------------------------------------------------------------
async function owned(p, agent = "general") {
  const t = await seedTask(p);
  const a = await own.assignOwner({ project_id: p, task_id: t, agent, assignment_reason: "r" });
  assert.equal(a.ok, true);
  return { p, t, agent };
}

test("5. self-recorded states (prepared, reviewed) transition without execution evidence", async () => {
  const { p, t, agent } = await owned(proj());
  const a = await own.setOwnershipState({ project_id: p, task_id: t, agent, status: "prepared", actor: "operator" });
  assert.equal(a.ok, true);
  assert.equal(a.status, "prepared");
  const b = await own.setOwnershipState({ project_id: p, task_id: t, agent, status: "reviewed", actor: "operator" });
  assert.equal(b.ok, true);
  assert.equal(b.status, "reviewed");
});

test("6. 'running' requires explicit dispatch evidence; agent claim is rejected", async () => {
  const { p, t, agent } = await owned(proj());
  const bad = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "running", evidence: ["running: I started it"], actor: agent });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "insufficient_evidence");
  const good = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "running", evidence: [{ dispatch_evidence: "dispatched ok" }], actor: "operator" });
  assert.equal(good.ok, true);
  assert.equal(good.status, "running");
  assert.equal(good.gated, true);
});

test("7. 'verified' requires Phase 24-style verification evidence; claim rejected", async () => {
  const { p, t, agent } = await owned(proj());
  const bad = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "verified", evidence: ["done, implemented, verified"], actor: agent });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "insufficient_evidence");
  const good = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "verified", evidence: [{ test_pass: true }], actor: "verifier" });
  assert.equal(good.ok, true);
  assert.equal(good.status, "verified");
});

test("8. 'completed_process' requires process evidence; missing -> unknown with fallback", async () => {
  const { p, t, agent } = await owned(proj());
  const bad = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "completed_process", evidence: ["process finished"], actor: agent });
  assert.equal(bad.ok, false);
  const unknown = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "completed_process", fallback: "unknown", evidence: ["agent says done"], actor: agent });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.status, "unknown");
  const good = await own.setOwnershipState({ project_id: p, task_id: t, agent,
    status: "completed_process", evidence: [{ process_evidence: "exit 0 success" }], actor: "operator" });
  assert.equal(good.ok, true);
  assert.equal(good.status, "completed_process");
});

test("9. actor required; evidence history is appended (never overwritten)", async () => {
  const { p, t, agent } = await owned(proj());
  const noActor = await own.setOwnershipState({ project_id: p, task_id: t, agent, status: "prepared" });
  assert.equal(noActor.ok, false);
  await own.setOwnershipState({ project_id: p, task_id: t, agent, status: "prepared",
    evidence: ["first"], actor: "a" });
  await own.setOwnershipState({ project_id: p, task_id: t, agent, status: "reviewed",
    evidence: ["second"], actor: "b" });
  const get = await own.getOwnership({ project_id: p, task_id: t, agent });
  assert.equal(get.ok, true);
  assert.equal(get.owner.status, "reviewed");
  const kinds = get.owner.evidence.map((e) => e && e.kind).filter(Boolean);
  assert.equal(kinds.filter((k) => k === "ownership_state_transition").length, 2);
  assert.ok(get.owner.evidence.some((e) => e === "first"));
  assert.ok(get.owner.evidence.some((e) => e === "second"));
});

// ---------------------------------------------------------------------------
// 10-12. Overview counts, redaction, bounds
// ---------------------------------------------------------------------------
test("10. ownershipOverview counts by status and is bounded", async () => {
  const p = proj();
  const a = await owned(p, "general");
  const b = await owned(p, "explore");
  await own.setOwnershipState({ project_id: p, task_id: a.t, agent: "general", status: "prepared", actor: "op" });
  await own.setOwnershipState({ project_id: p, task_id: b.t, agent: "explore", status: "reviewed", actor: "op" });
  const ov = await own.ownershipOverview({ project_id: p, limit: 1 });
  assert.equal(ov.ok, true);
  assert.ok(ov.items.length <= 1);
  assert.equal(ov.counts.prepared, 1);
  assert.equal(ov.counts.reviewed, 1);
  assert.equal(ov.counts.planned, 0);
});

test("11. redaction of credential-like strings in reason and evidence", async () => {
  const p = proj();
  const t = await seedTask(p);
  const a = await own.assignOwner({ project_id: p, task_id: t, agent: "general",
    assignment_reason: "use api_key=supersecret123 for deploy" });
  assert.equal(a.ok, true);
  assert.ok(!/supersecret123/.test(a.owner.assignment_reason));
  await own.setOwnershipState({ project_id: p, task_id: t, agent: "general", status: "prepared",
    evidence: ["token: sk-abcdefghijklmnopqrst"], actor: "op" });
  const g = await own.getOwnership({ project_id: p, task_id: t, agent: "general" });
  const all = JSON.stringify(g.owner.evidence);
  assert.ok(!/sk-abcdefghijklmnopqrst/.test(all));
  assert.match(all, /REDACTED/);
});

test("12. cross-project isolation for getOwnership / setOwnershipState", async () => {
  const pA = proj("iso-a"), pB = proj("iso-b");
  const { t, agent } = await owned(pA);
  const g = await own.getOwnership({ project_id: pB, task_id: t, agent });
  assert.equal(g.ok, false);
  const s = await own.setOwnershipState({ project_id: pB, task_id: t, agent, status: "prepared", actor: "op" });
  assert.equal(s.ok, false);
});

// ---------------------------------------------------------------------------
// 13-19. assessRecovery
// ---------------------------------------------------------------------------
test("13. active goal + valid approval -> can_resume true, required_approval false", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const ap = await makeApproval(p, "ok1");
  const r = await rec.assessRecovery({ project_id: p, task_id: t, approval_id: ap.approval_id,
    token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version, plan_hash: ap.plan_hash,
    scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.equal(r.ok, true);
  assert.equal(r.can_resume, true);
  assert.equal(r.required_approval, false);
  assert.equal(r.never_auto_resume, true);
  assert.match(r.recommendation, /Never auto-resume|never resumes/i);
  assert.equal(r.evidence.goal.status, "active");
  assert.equal(r.evidence.approval.verified, true);
});

test("14. no approval -> can_resume false, required_approval true", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const r = await rec.assessRecovery({ project_id: p, task_id: t });
  assert.equal(r.ok, true);
  assert.equal(r.can_resume, false);
  assert.equal(r.required_approval, true);
  assert.ok(r.reasons.some((x) => /approval required/i.test(x)));
  assert.equal(r.never_auto_resume, true);
});

test("15. expired approval is never reused", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const ap = await makeApproval(p, "exp1");
  await core.dbQuery("UPDATE workflow_approval SET expires_at = now() - interval '1 minute' WHERE id=$1",
    [ap.approval_id]);
  const r = await rec.assessRecovery({ project_id: p, task_id: t, approval_id: ap.approval_id,
    token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version, plan_hash: ap.plan_hash,
    scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.equal(r.can_resume, false);
  assert.equal(r.required_approval, true);
  assert.ok(r.reasons.some((x) => /approval invalid/i.test(x)));
});

test("16. consumed approval is never reused", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const ap = await makeApproval(p, "con1");
  await core.dbQuery("UPDATE workflow_approval SET status='consumed' WHERE id=$1", [ap.approval_id]);
  const r = await rec.assessRecovery({ project_id: p, task_id: t, approval_id: ap.approval_id,
    token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version, plan_hash: ap.plan_hash,
    scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.equal(r.can_resume, false);
  assert.equal(r.evidence.approval.verified, false);
});

test("17. goal not active blocks resume", async () => {
  const p = proj();
  const g = await seedGoal(p, "superseded");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const ap = await makeApproval(p, "goal1");
  const r = await rec.assessRecovery({ project_id: p, task_id: t, approval_id: ap.approval_id,
    token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version, plan_hash: ap.plan_hash,
    scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.equal(r.can_resume, false);
  assert.ok(r.reasons.some((x) => /goal not active/i.test(x)));
});

test("18. changed source adds a caution reason (injectable Phase 25 loader)", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const ap = await makeApproval(p, "chg1");
  const fakeLoad = (name) => name === "changeImpact" ? {
    compareIndexFreshness: async () => ({ stale: true, changed_files: [
      { path: "src/a.js" }, { path: "src/b.js" }] }),
  } : null;
  const r = await rec.assessRecovery({ project_id: p, task_id: t, load: fakeLoad,
    approval_id: ap.approval_id, token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version,
    plan_hash: ap.plan_hash, scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.ok(r.reasons.some((x) => /source changed/i.test(x)));
  assert.equal(r.evidence.source.changed_count, 2);
  // Source change is a caution, not an execution permission.
  assert.equal(r.never_auto_resume, true);
});

test("19. inferred dependency is non-authoritative; confirmed unmet dependency blocks", async () => {
  const p = proj();
  const g = await seedGoal(p, "active");
  const t = await seedTask(p, { goal_id: g, status: "failed" });
  const blocker = await seedTask(p, { status: "not_started" });
  await core.dbQuery(
    `INSERT INTO pm_dependency (project_id, from_type, from_id, to_type, to_id, dependency_type, confidence)
     VALUES ($1,'task',$2,'task',$3,'inferred',0.3)`, [p, t, blocker]);
  const ap = await makeApproval(p, "dep1");
  const base = { project_id: p, task_id: t, approval_id: ap.approval_id, token: ap.token,
    plan_id: ap.plan_id, plan_version: ap.plan_version, plan_hash: ap.plan_hash,
    scope: ap.scope, mode: ap.mode, risk: ap.risk };
  const inferred = await rec.assessRecovery(base);
  assert.ok(inferred.reasons.some((x) => /inferred dependency.*non-authoritative/i.test(x)));
  assert.equal(inferred.can_resume, true);
  assert.equal(inferred.evidence.dependencies.inferred_authoritative, false);

  // Now make it a confirmed, unmet dependency — it must block.
  await core.dbQuery(
    `UPDATE pm_dependency SET dependency_type='confirmed' WHERE project_id=$1 AND from_id=$2 AND to_id=$3`,
    [p, t, blocker]);
  const confirmed = await rec.assessRecovery(base);
  assert.equal(confirmed.can_resume, false);
  assert.ok(confirmed.reasons.some((x) => /confirmed dependency not completed/i.test(x)));
});

// ---------------------------------------------------------------------------
// 20-21. prepareRecovery: approval required + dry-run/no-spawn enforcement
// ---------------------------------------------------------------------------
test("20. prepareRecovery rejects when no valid approval is supplied", async () => {
  const p = proj();
  const t = await seedTask(p, { status: "failed" });
  const r = await rec.prepareRecovery({ project_id: p, task_id: t, run_id: "run-x" });
  assert.equal(r.ok, false);
  assert.equal(r.required_approval, true);
  assert.equal(r.no_spawn, true);
  assert.equal(r.never_auto_resume, true);
});

test("21. prepareRecovery forces dry_run and cannot spawn (injectable loader)", async () => {
  const p = proj();
  const t = await seedTask(p, { status: "failed" });
  const ap = await makeApproval(p, "prep1");
  let captured = null;
  let spawned = false;
  const fakeLoad = (name) => name === "workflowRecovery" ? {
    recoverRun: async (args) => { captured = args; return { ok: true, retried: 0, results: [], degraded: [] }; },
  } : null;
  const r = await rec.prepareRecovery({ project_id: p, task_id: t, run_id: "run-1", load: fakeLoad,
    spawnFn: () => { spawned = true; },
    approval_id: ap.approval_id, token: ap.token, plan_id: ap.plan_id, plan_version: ap.plan_version,
    plan_hash: ap.plan_hash, scope: ap.scope, mode: ap.mode, risk: ap.risk });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.no_spawn, true);
  assert.equal(r.mode, "preparation");
  assert.equal(spawned, false);
  assert.ok(captured, "recoverRun must be called");
  assert.equal(captured.dry_run, true);
  assert.equal(captured.mode, "simulation");
  assert.equal(captured.spawnFn, undefined, "no spawn function may be forwarded");
});

test("22. invalid inputs fail closed without throwing", async () => {
  for (const fn of [
    () => rec.assessRecovery(),
    () => rec.assessRecovery({ project_id: "_global", task_id: "t" }),
    () => rec.prepareRecovery(),
    () => rec.prepareRecovery({ project_id: "_global", task_id: "t" }),
    () => own.setOwnershipState({ project_id: "p", task_id: "t", agent: "a", status: "bogus", actor: "x" }),
    () => own.setOwnershipState({ project_id: "p", task_id: "t", agent: "a", status: "prepared",
      evidence: "not-an-array", actor: "x" }),
  ]) {
    let r;
    try { r = await fn(); } catch (e) { assert.fail(`must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false);
  }
});

// ---------------------------------------------------------------------------
// FINAL — DB-down degradation (core.close() exactly once, last test)
// ---------------------------------------------------------------------------
test("FINAL. FINAL degradation after database close", async () => {
  await core.close();
  const a = await rec.assessRecovery({ project_id: proj(), task_id: "t" });
  assert.equal(a.ok, false);
  assert.equal(a.can_resume, false);
  assert.equal(a.never_auto_resume, true);
  const o = await own.ownershipOverview({ project_id: proj() });
  assert.equal(o.ok, false);
  const p = await rec.prepareRecovery({ project_id: proj(), task_id: "t" });
  assert.equal(p.ok, false);
  assert.equal(p.no_spawn, true);
});
