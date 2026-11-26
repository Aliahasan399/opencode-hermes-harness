import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const pm = await import("../src/projectManagement.js");
const pipelineAudit = await import("../src/pipelineAudit.js");

const projectA = `p26-e2e-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p26-e2e-b-${crypto.randomUUID().slice(0, 8)}`;
const DDL = [
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS goal_type text NOT NULL DEFAULT 'short_term'`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS target_date timestamptz`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT ''`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user_approved'`,
  `ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS parent_goal_id text NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS pm_milestone (id uuid PRIMARY KEY, project_id text NOT NULL, milestone_key text NOT NULL, goal_id text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb, priority integer NOT NULL DEFAULT 0, target_date timestamptz, status text NOT NULL DEFAULT 'planned', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, milestone_key))`,
  `CREATE TABLE IF NOT EXISTS pm_progress_snapshot (id bigserial PRIMARY KEY, project_id text NOT NULL, snapshot_key text NOT NULL, goal_id text NOT NULL DEFAULT '', milestone_id text NOT NULL DEFAULT '', task_id text NOT NULL DEFAULT '', session_id text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'partial', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, summary jsonb NOT NULL DEFAULT '{}'::jsonb, source_refs jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, snapshot_key))`,
  `CREATE TABLE IF NOT EXISTS pm_dependency (id bigserial PRIMARY KEY, project_id text NOT NULL, from_type text NOT NULL, from_id text NOT NULL, to_type text NOT NULL, to_id text NOT NULL, dependency_type text NOT NULL DEFAULT 'inferred', confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb, created_by text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, from_type, from_id, to_type, to_id, dependency_type))`,
  `CREATE TABLE IF NOT EXISTS pm_blocker (id uuid PRIMARY KEY, project_id text NOT NULL, blocker_key text NOT NULL, title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', severity text NOT NULL DEFAULT 'medium', category text NOT NULL DEFAULT 'technical', status text NOT NULL DEFAULT 'identified', affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb, affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb, affected_tasks jsonb NOT NULL DEFAULT '[]'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb, owner text NOT NULL DEFAULT '', resolution jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, blocker_key))`,
  `CREATE TABLE IF NOT EXISTS pm_drift_finding (id uuid PRIMARY KEY, project_id text NOT NULL, finding_key text NOT NULL, category text NOT NULL DEFAULT 'other', severity text NOT NULL DEFAULT 'low', confidence real NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'open', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb, affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb, recommendation text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, finding_key))`,
  `CREATE TABLE IF NOT EXISTS pm_continuity_snapshot (id uuid PRIMARY KEY, project_id text NOT NULL, briefing jsonb NOT NULL DEFAULT '{}'::jsonb, freshness jsonb NOT NULL DEFAULT '{}'::jsonb, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS pm_ownership (id uuid PRIMARY KEY, project_id text NOT NULL, task_id text NOT NULL, agent text NOT NULL, assignment_reason text NOT NULL DEFAULT '', scope jsonb NOT NULL DEFAULT '{}'::jsonb, expected_output text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'planned', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, handoff jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, task_id, agent))`,
];
for (const d of DDL) { try { await core.dbQuery(d); } catch { /* migration 024 normally applied */ } }
const VERIFIED = [{ kind: "test_pass", result: "passed", session: "real-session" }];

test("0. facade exports the project-management surface", () => {
  assert.deepEqual(Object.keys(pm.default).sort(),
    ["blockers", "briefing", "dependencies", "drift", "goals", "milestones", "nextActions",
      "ownership", "progress", "recovery", "report", "status"]);
});

test("1. goal lifecycle extends dev_goal with provenance and auditable history", async () => {
  const g = await pm.goals({ project_id: projectA, op: "create", title: "Ship Phase 26",
    goal_type: "short_term", provenance: "user_approved", priority: 9, owner: "operator",
    success_criteria: ["tests pass", "report complete"], evidence: [{ kind: "user_request", text: "ship it" }],
    created_by: "operator" });
  assert.equal(g.ok, true, g.reason || "");
  assert.ok(g.id);
  globalThis.__goal = g.id;
  const st = await pm.goals({ project_id: projectA, op: "state", goal_id: g.id, status: "active",
    evidence: [{ kind: "status_change", note: "started" }], actor: "operator" });
  assert.equal(st.ok, true, st.reason || "");
  const hist = await pm.goals({ project_id: projectA, op: "history", goal_id: g.id, limit: 20 });
  assert.equal(hist.ok, true);
  assert.ok((hist.items || hist.history || []).length >= 1);
});

test("2. milestone completion requires success criteria AND verified evidence", async () => {
  const m1 = await pm.milestones({ project_id: projectA, op: "create", milestone_key: "m1",
    title: "Core capabilities", goal_id: globalThis.__goal, success_criteria: ["goal verified"], created_by: "operator" });
  assert.equal(m1.ok, true, m1.reason || "");
  const bad = await pm.milestones({ project_id: projectA, op: "state", milestone_key: "m1",
    status: "completed", evidence: [{ kind: "agent_claim", status: "done" }], actor: "agent" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason || "", /evidence|verif/i);
  const good = await pm.milestones({ project_id: projectA, op: "state", milestone_key: "m1",
    status: "completed", evidence: VERIFIED, actor: "operator" });
  assert.equal(good.ok, true, good.reason || "");
});

test("3. progress snapshots never invent percentages", async () => {
  const v = await pm.progress({ project_id: projectA, op: "record", snapshot_key: "s1",
    goal_id: globalThis.__goal, status: "verified", evidence: VERIFIED, session_id: "sess-1" });
  assert.equal(v.ok, true, v.reason || "");
  const bad = await pm.progress({ project_id: projectA, op: "record", snapshot_key: "s2",
    status: "verified", evidence: [{ kind: "agent_claim" }] });
  assert.equal(bad.ok, false);
  const c = await pm.progress({ project_id: projectA, op: "compute", goal_id: globalThis.__goal });
  assert.equal(c.ok, true);
  assert.ok(["unknown", "insufficient_evidence", "not_applicable"].includes(c.completion));
  assert.doesNotMatch(JSON.stringify(c), /\d+(\.\d+)?\s*%/);
});

test("4. dependency analysis distinguishes confirmed from inferred", async () => {
  const r = await pm.dependencies({ project_id: projectA, op: "record", from_type: "task", from_id: "t1",
    to_type: "task", to_id: "t2", dependency_type: "confirmed", evidence: [{ kind: "explicit" }], created_by: "operator" });
  assert.equal(r.ok, true, r.reason || "");
  const inf = await pm.dependencies({ project_id: projectA, op: "record", from_type: "task", from_id: "t2",
    to_type: "task", to_id: "t3", dependency_type: "inferred", evidence: [] });
  assert.equal(inf.ok, true);
  const a = await pm.dependencies({ project_id: projectA, op: "analyze", node_type: "task", node_id: "t1" });
  assert.equal(a.ok, true);
  assert.match(a.note || "", /incomplete|confirmed|unknown/i);
});

test("5. blocker lifecycle requires verification evidence to resolve", async () => {
  const b = await pm.blockers({ project_id: projectA, op: "record", blocker_key: "b1", title: "Provider timeout",
    severity: "high", category: "dependency", affected_goals: [globalThis.__goal] });
  assert.equal(b.ok, true, b.reason || "");
  const bad = await pm.blockers({ project_id: projectA, op: "state", blocker_key: "b1", status: "resolved",
    evidence: [{ kind: "claim" }], actor: "agent" });
  assert.equal(bad.ok, false);
  const ok = await pm.blockers({ project_id: projectA, op: "state", blocker_key: "b1", status: "resolved",
    evidence: VERIFIED, actor: "operator" });
  assert.equal(ok.ok, true, ok.reason || "");
});

test("6. drift findings are explainable review recommendations", async () => {
  const d = await pm.drift({ project_id: projectA, op: "analyze" });
  assert.equal(d.ok, true, d.reason || "");
  const items = d.findings || d.items || [];
  assert.ok(items.every((f) => f.finding_key && f.category && Array.isArray(f.evidence)));
  assert.match(d.note || "", /review|not.*rewrite|recommend/i);
});

test("7. ownership states never invent execution", async () => {
  const a = await pm.ownership({ project_id: projectA, op: "assign", task_id: "t1", agent: "general",
    assignment_reason: "best fit", scope: { paths: ["src/"] }, expected_output: "patch", created_by: "operator" });
  assert.equal(a.ok, true, a.reason || "");
  const bad = await pm.ownership({ project_id: projectA, op: "state", task_id: "t1", agent: "general",
    status: "verified", evidence: [{ kind: "agent_claim" }], actor: "agent" });
  assert.equal(bad.ok, false);
  const unk = await pm.ownership({ project_id: projectA, op: "state", task_id: "t1", agent: "general",
    status: "unknown", evidence: [], actor: "system" });
  assert.equal(unk.ok, true);
});

test("8. continuity briefing is assembled from authoritative records", async () => {
  const br = await pm.briefing({ project_id: projectA, op: "build", session_id: "sess-1" });
  assert.equal(br.ok, true, br.reason || "");
  const b = br.briefing || br;
  for (const k of ["project_overview", "verified_progress", "current_work", "blockers_risks",
    "project_drift", "recovery", "recommended_actions", "evidence_confidence"]) {
    assert.ok(k in b, `briefing must include ${k}`);
  }
  assert.match(br.note || "", /reference|transcript|unknown/i);
});

test("9. next actions are explainable and non-executing", async () => {
  const n = await pm.nextActions({ project_id: projectA, limit: 10 });
  assert.equal(n.ok, true, n.reason || "");
  const recs = n.recommendations || [];
  assert.ok(recs.every((r) => r.action && r.reason && Array.isArray(r.evidence)
    && typeof r.approval_required === "boolean" && r.action_kind));
  assert.match(n.note || "", /never execute|approval|operator|not override/i);
});

test("10. recovery requires approval and never auto-resumes", async () => {
  const r = await pm.recovery({ project_id: projectA, op: "assess", task_id: "t1" });
  // ok = assessment ran; can_resume/required_approval carry the safety decision.
  assert.equal(r.ok, true);
  assert.equal(r.can_resume, false);
  assert.equal(r.never_auto_resume, true);
  assert.equal(r.required_approval, true);
});

test("11. project status and unified report assemble without mutation", () => {
  const before = fs.readFileSync(new URL("../src/projectManagement.js", import.meta.url), "utf8");
  return pm.report({ project_id: projectA }).then((r) => {
    assert.equal(r.ok, true);
    assert.match(r.claim, /no execution was performed/);
    const after = fs.readFileSync(new URL("../src/projectManagement.js", import.meta.url), "utf8");
    assert.equal(before, after);
  });
});

test("12. project isolation: project B sees none of project A's state", async () => {
  const g = await pm.goals({ project_id: projectB, op: "list", limit: 50 });
  assert.equal(g.ok, true);
  assert.equal((g.goals || []).length, 0);
  const br = await pm.briefing({ project_id: projectB, op: "build" });
  assert.equal(br.ok, true);
  const st = await pm.status({ project_id: projectB });
  assert.deepEqual(st.goals, []);
  const rec = await pm.recovery({ project_id: projectB, op: "assess", task_id: "t1" });
  assert.equal(rec.can_resume, false);
});

test("13. pipeline audit covers Phase 26 wiring without runtime claims", () => {
  const a = pipelineAudit.auditPipelineIntegrity();
  assert.equal(a.ok, true);
  assert.ok(Object.keys(a.sources.phase26).length >= 10);
  assert.equal(a.verifiedBehavior, false);
  assert.ok(a.checks.filter((c) => c.id.startsWith("p26.")).length >= 14);
});

test("14. all facade ops reject _global / empty scope", async () => {
  for (const op of ["status", "goals", "milestones", "progress", "dependencies", "blockers",
    "briefing", "drift", "ownership", "recovery", "nextActions", "report"]) {
    let r;
    try { r = await pm[op]({ project_id: "_global", goal_id: "x", task_id: "x" }); }
    catch (e) { assert.fail(`${op} must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false, `${op} must reject _global`);
  }
});

test("15. LEVEL 1 and HARNESS_SEMANTIC_LLM unchanged; no source writes in p26 modules", () => {
  const files = ["projectManagement.js", "projectGoals.js", "projectMilestones.js", "projectProgress.js",
    "projectContinuity.js", "projectDependencies.js", "projectBlockers.js", "projectDrift.js",
    "projectOwnership.js", "projectRecovery.js", "nextBestAction.js"];
  for (const f of files) {
    let s = "";
    try { s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"); } catch { continue; }
    assert.doesNotMatch(s, /process\.env\.(OPTIMIZATION_LEVEL|HARNESS_SEMANTIC_LLM)\s*=/);
    assert.doesNotMatch(s, /auto_execute\s*:\s*true/);
    assert.doesNotMatch(s, /writeFileSync|unlinkSync|rmSync|git\s+(reset|merge|push)/);
  }
  assert.notEqual(process.env.OPTIMIZATION_LEVEL, "3");
  assert.notEqual(process.env.HARNESS_SEMANTIC_LLM, "1");
});

test("16. FINAL degradation after database close", async () => {
  await core.close();
  const r = await pm.report({ project_id: projectA });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.degraded));
  const g = await pm.goals({ project_id: projectA, op: "list" });
  assert.equal(g.ok, false);
});
