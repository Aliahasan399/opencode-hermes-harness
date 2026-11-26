// Phase 26 §2.1-2.2 — long-term goals and evidence-gated milestones.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), unique project ids per
// test, no LLM/network/git/spawn, no source writes, no cross-project access.
// Standalone: $env:MEMORY_DB_NAME='opencode_memory_test'; node --test test/phase26-goals.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const pg = await import("../src/projectGoals.js");
const pm = await import("../src/projectMilestones.js");
const dg = await import("../src/developmentGoal.js");

const uniq = () => `p26-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const verifyEv = () => [{ test_pass: true }];
const agentClaim = () => ["done", "implemented", "process succeeded"];

// Defensive DDL: migration 024 is normally applied by the parent, but this test
// must also pass on a fresh isolated DB. All statements are IF NOT EXISTS.
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
  for (const stmt of [
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS goal_type text NOT NULL DEFAULT 'short_term'",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS target_date timestamptz",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT ''",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'user_approved'",
    "ALTER TABLE dev_goal ADD COLUMN IF NOT EXISTS parent_goal_id text NOT NULL DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS pm_milestone (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      milestone_key text NOT NULL,
      goal_id text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      priority integer NOT NULL DEFAULT 0,
      target_date timestamptz,
      status text NOT NULL DEFAULT 'planned',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, milestone_key)
    )`,
  ]) await core.dbQuery(stmt);
});

// ---------------- 1. exports ----------------

test("1. frozen vocabularies and required exports", () => {
  for (const v of [pg.GOAL_TYPES, pg.PROVENANCE, pg.GOAL_STATES, pm.MILESTONE_STATUSES, pm.COMPLETION]) {
    assert.ok(Object.isFrozen(v));
  }
  assert.deepEqual([...pg.GOAL_TYPES], ["vision", "long_term", "short_term"]);
  assert.deepEqual([...pg.PROVENANCE], ["user_approved", "inferred", "ai_recommendation", "verified_outcome"]);
  assert.deepEqual([...pg.GOAL_STATES], ["proposed", "active", "paused", "achieved", "cancelled", "superseded", "at_risk"]);
  assert.deepEqual([...pm.MILESTONE_STATUSES], ["planned", "active", "at_risk", "blocked", "completed", "delayed", "cancelled"]);
  assert.deepEqual([...pm.COMPLETION], ["unknown", "insufficient_evidence", "not_applicable"]);
  for (const fn of ["listGoals", "recordGoalExtended", "setGoalState", "updateGoalDetails", "getGoalDetail", "getGoalHistory"]) {
    assert.equal(typeof pg[fn], "function", `pg.${fn}`);
    assert.equal(typeof pg.default[fn], "function", `pg.default.${fn}`);
  }
  for (const fn of ["recordMilestone", "listMilestones", "getMilestone", "setMilestoneStatus", "milestoneProgress"]) {
    assert.equal(typeof pm[fn], "function", `pm.${fn}`);
    assert.equal(typeof pm.default[fn], "function", `pm.default.${fn}`);
  }
});

// ---------------- 2. schema extension ----------------

test("2. dev_goal carries migration-024 columns and reads expose them", async () => {
  const cols = (await core.dbQuery(
    "SELECT column_name FROM information_schema.columns WHERE table_name='dev_goal'",
  )).rows.map((r) => r.column_name);
  for (const c of ["goal_type", "priority", "target_date", "owner", "success_criteria", "provenance", "parent_goal_id"]) {
    assert.ok(cols.includes(c), `dev_goal.${c}`);
  }
  const project = `schema-${uniq()}`;
  const made = await pg.recordGoalExtended({ project_id: project, title: `G ${uniq()}` });
  assert.equal(made.ok, true);
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  for (const c of ["goal_type", "priority", "target_date", "owner", "success_criteria", "provenance", "parent_goal_id"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail.goal, c), `detail.${c}`);
  }
  const listed = await pg.listGoals({ project_id: project });
  assert.equal(listed.goals.length, 1);
  assert.equal(listed.goals[0].id, made.id);
});

// ---------------- 3. record extended goal ----------------

test("3. recordGoalExtended stores provenance, goal_type and metadata via delegation", async () => {
  const project = `goal-rec-${uniq()}`;
  const parent = await pg.recordGoalExtended({ project_id: project, title: `Parent ${uniq()}` });
  const made = await pg.recordGoalExtended({
    project_id: project, title: `Child ${uniq()}`, description: "extended goal",
    goal_type: "vision", priority: 7, target_date: "2030-01-02T00:00:00Z", owner: "alice",
    success_criteria: ["criterion A", "criterion B"], provenance: "verified_outcome",
    parent_goal_id: parent.id, evidence: [{ kind: "user_request", text: "seed" }],
    source_session: `s-${uniq()}`, created_by: "tester",
  });
  assert.equal(made.ok, true);
  assert.equal(made.created, true);
  assert.equal(made.duplicate, false);
  assert.ok(made.id);
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  assert.equal(detail.goal.goal_type, "vision");
  assert.equal(detail.goal.provenance, "verified_outcome");
  assert.equal(detail.goal.priority, 7);
  assert.equal(detail.goal.owner, "alice");
  assert.equal(detail.goal.parent_goal_id, parent.id);
  assert.deepEqual(detail.goal.success_criteria, ["criterion A", "criterion B"]);
  assert.equal(detail.goal.evidence[0].text, "seed", "base insert delegated evidence preserved");

  // defaults are applied when omitted
  const plain = await pg.recordGoalExtended({ project_id: project, title: `Plain ${uniq()}` });
  const d2 = await pg.getGoalDetail({ project_id: project, goal_id: plain.id });
  assert.equal(d2.goal.goal_type, "short_term");
  assert.equal(d2.goal.provenance, "user_approved");
});

// ---------------- 4. duplicate no-op ----------------

test("4. duplicate goal is a no-op with the original extended values intact", async () => {
  const project = `goal-dup-${uniq()}`;
  const title = `Dup ${uniq()}`;
  const first = await pg.recordGoalExtended({
    project_id: project, title, goal_type: "long_term", provenance: "inferred", owner: "first",
  });
  const second = await pg.recordGoalExtended({
    project_id: project, title, goal_type: "vision", provenance: "verified_outcome", owner: "overwrite",
  });
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: first.id });
  assert.equal(detail.goal.owner, "first", "duplicate did not overwrite");
  assert.equal(detail.goal.goal_type, "long_term");
  assert.equal((await pg.listGoals({ project_id: project })).goals.length, 1);
});

// ---------------- 5. vocabulary validation ----------------

test("5. invalid goal_type / provenance rejected before any insert", async () => {
  const project = `goal-vocab-${uniq()}`;
  assert.equal((await pg.recordGoalExtended({ project_id: project, title: `A ${uniq()}`, goal_type: "epic" })).ok, false);
  assert.equal((await pg.recordGoalExtended({ project_id: project, title: `B ${uniq()}`, provenance: "guessed" })).ok, false);
  assert.equal((await pg.recordGoalExtended({ project_id: project, title: `C ${uniq()}`, target_date: "not-a-date" })).ok, false);
  assert.equal((await pg.listGoals({ project_id: project })).goals.length, 0, "nothing was inserted");
});

// ---------------- 6. parent validation ----------------

test("6. parent_goal_id must exist in the same project", async () => {
  const a = `parent-A-${uniq()}`;
  const b = `parent-B-${uniq()}`;
  const foreign = await pg.recordGoalExtended({ project_id: b, title: `Foreign ${uniq()}` });
  const cross = await pg.recordGoalExtended({
    project_id: a, title: `Child ${uniq()}`, parent_goal_id: foreign.id,
  });
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /parent/);
  assert.equal((await pg.listGoals({ project_id: a })).goals.length, 0, "no partial goal created");

  const own = await pg.recordGoalExtended({ project_id: a, title: `Root ${uniq()}` });
  const good = await pg.recordGoalExtended({
    project_id: a, title: `OK ${uniq()}`, parent_goal_id: own.id,
  });
  assert.equal(good.ok, true);
});

// ---------------- 7. full seven-state setter ----------------

test("7. setGoalState accepts all seven extended states", async () => {
  const project = `goal-states-${uniq()}`;
  const made = await pg.recordGoalExtended({ project_id: project, title: `S ${uniq()}` });
  for (const st of pg.GOAL_STATES) {
    const r = await pg.setGoalState({
      project_id: project, goal_id: made.id, status: st,
      evidence: [{ kind: "state_change", status: st }], actor: "tester",
    });
    assert.equal(r.ok, true, `state ${st}`);
    assert.equal(r.changed, true);
    assert.equal(r.status, st);
  }
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  assert.equal(detail.goal.status, "at_risk", "last state wins");
  const auditCount = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='p26.goal_state' AND detail->>'id'=$1", [made.id],
  )).rows[0].n;
  assert.equal(auditCount, 7, "every state change audited");
});

// ---------------- 8. validation + actor ----------------

test("8. setGoalState rejects invalid state, missing actor and foreign goals", async () => {
  const a = `state-A-${uniq()}`;
  const b = `state-B-${uniq()}`;
  const made = await pg.recordGoalExtended({ project_id: a, title: `G ${uniq()}` });
  assert.equal((await pg.setGoalState({ project_id: a, goal_id: made.id, status: "bogus", actor: "t" })).ok, false);
  assert.equal((await pg.setGoalState({ project_id: a, goal_id: made.id, status: "active" })).ok, false, "actor required");
  assert.equal((await pg.setGoalState({ project_id: a, goal_id: made.id, status: "active", actor: "" })).ok, false);
  assert.equal((await pg.setGoalState({ project_id: b, goal_id: made.id, status: "active", actor: "t" })).ok, false);
  assert.equal((await pg.setGoalState({ project_id: a, goal_id: "missing", status: "active", actor: "t" })).ok, false);
  // base-only states are not accepted by the extended validator
  assert.equal((await pg.setGoalState({ project_id: a, goal_id: made.id, status: "completed", actor: "t" })).ok, false);
  const detail = await pg.getGoalDetail({ project_id: a, goal_id: made.id });
  assert.equal(detail.goal.status, "active", "rejected calls changed nothing");
});

// ---------------- 9. append-only evidence ----------------

test("9. setGoalState appends evidence and getGoalHistory preserves it", async () => {
  const project = `goal-ev-${uniq()}`;
  const made = await pg.recordGoalExtended({
    project_id: project, title: `E ${uniq()}`, evidence: [{ kind: "seed", text: "original" }],
  });
  await pg.setGoalState({
    project_id: project, goal_id: made.id, status: "active",
    evidence: [{ kind: "note", text: "first append" }], actor: "t",
  });
  await pg.setGoalState({
    project_id: project, goal_id: made.id, status: "paused",
    evidence: [{ kind: "note", text: "second append" }], actor: "t",
  });
  const hist = await pg.getGoalHistory({ project_id: project, goal_id: made.id });
  assert.equal(hist.ok, true);
  assert.equal(hist.count, 3);
  assert.equal(hist.history[0].text, "original");
  assert.equal(hist.history[2].text, "second append");

  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  const detailStr = JSON.stringify(detail.goal.evidence);
  assert.ok(detailStr.includes("original") && detailStr.includes("first append") && detailStr.includes("second append"));

  const auditDetail = (await core.dbQuery(
    "SELECT detail FROM audit_log WHERE action='p26.goal_state' AND detail->>'id'=$1 LIMIT 1", [made.id],
  )).rows[0].detail;
  assert.equal(JSON.stringify(auditDetail).includes("first append"), false, "audit is content-free");
});

// ---------------- 10. whitelisted detail patch ----------------

test("10. updateGoalDetails applies only whitelisted fields and requires actor", async () => {
  const project = `goal-patch-${uniq()}`;
  const made = await pg.recordGoalExtended({ project_id: project, title: `P ${uniq()}` });
  const blocked = await pg.updateGoalDetails({
    project_id: project, goal_id: made.id, patch: { description: "hack" },
  });
  assert.equal(blocked.ok, false, "actor required");
  const r = await pg.updateGoalDetails({
    project_id: project, goal_id: made.id, actor: "tester",
    patch: { description: "new description", priority: 9, goal_type: "vision",
      title: "OVERWRITE", status: "achieved", success_criteria: ["x"] },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, ["description", "priority", "success_criteria", "goal_type"]);
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  assert.equal(detail.goal.description, "new description");
  assert.equal(detail.goal.priority, 9);
  assert.equal(detail.goal.goal_type, "vision");
  assert.deepEqual(detail.goal.success_criteria, ["x"]);
  assert.notEqual(detail.goal.title, "OVERWRITE", "title not in whitelist");
  assert.equal(detail.goal.status, "active", "status not in whitelist");

  const bad = await pg.updateGoalDetails({
    project_id: project, goal_id: made.id, actor: "t", patch: { provenance: "guessed" },
  });
  assert.equal(bad.ok, false);
  const none = await pg.updateGoalDetails({
    project_id: project, goal_id: made.id, actor: "t", patch: { title: "x" },
  });
  assert.equal(none.ok, false, "no allowed fields");
});

// ---------------- 11. bounded history ----------------

test("11. getGoalHistory is bounded and getGoalDetail is project-scoped", async () => {
  const project = `goal-bound-${uniq()}`;
  const made = await pg.recordGoalExtended({ project_id: project, title: `B ${uniq()}` });
  for (let i = 0; i < 6; i++) {
    await pg.setGoalState({
      project_id: project, goal_id: made.id, status: pg.GOAL_STATES[i % pg.GOAL_STATES.length],
      evidence: [{ kind: "n", i }], actor: "t",
    });
  }
  const bounded = await pg.getGoalHistory({ project_id: project, goal_id: made.id, limit: 3 });
  assert.equal(bounded.history.length, 3);
  assert.equal(bounded.limit, 3);
  const huge = await pg.getGoalHistory({ project_id: project, goal_id: made.id, limit: 9999 });
  assert.ok(huge.history.length <= 500);
  assert.equal((await pg.getGoalDetail({ project_id: project, goal_id: "missing" })).found, false);
});

// ---------------- 12. milestone record + duplicate ----------------

test("12. recordMilestone creates a scoped milestone and dedupes without overwrite", async () => {
  const project = `ms-rec-${uniq()}`;
  const goal = await pg.recordGoalExtended({ project_id: project, title: `G ${uniq()}` });
  const key = `ms-${uniq()}`;
  const first = await pm.recordMilestone({
    project_id: project, milestone_key: key, title: "Ship feature",
    description: "original", goal_id: goal.id, success_criteria: ["tests green"],
    priority: 3, evidence: [{ kind: "plan" }], created_by: "tester",
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.ok(first.id);
  const second = await pm.recordMilestone({
    project_id: project, milestone_key: key, title: "OVERWRITE", description: "changed",
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const got = await pm.getMilestone({ project_id: project, milestone_key: key });
  assert.equal(got.milestone.title, "Ship feature");
  assert.equal(got.milestone.description, "original");
  assert.equal(got.milestone.status, "planned");
  assert.deepEqual(got.milestone.success_criteria, ["tests green"]);
});

// ---------------- 13. milestone validation ----------------

test("13. recordMilestone validates goal linkage and rejects invalid inputs", async () => {
  const a = `ms-A-${uniq()}`;
  const b = `ms-B-${uniq()}`;
  const goal = await pg.recordGoalExtended({ project_id: a, title: `G ${uniq()}` });
  const cross = await pm.recordMilestone({
    project_id: b, milestone_key: `x-${uniq()}`, title: "x", goal_id: goal.id,
  });
  assert.equal(cross.ok, false, "goal from another project rejected");
  const missing = await pm.recordMilestone({
    project_id: a, milestone_key: `y-${uniq()}`, title: "y", goal_id: "missing-goal",
  });
  assert.equal(missing.ok, false);
  assert.equal((await pm.recordMilestone({ project_id: a, milestone_key: "", title: "z" })).ok, false);
  assert.equal((await pm.recordMilestone({ project_id: a, milestone_key: "k", title: "" })).ok, false);
  assert.equal((await pm.recordMilestone({ project_id: a, milestone_key: "k2", title: "t", target_date: "bad" })).ok, false);
  // empty criteria are allowed but flagged
  const empty = await pm.recordMilestone({
    project_id: a, milestone_key: `empty-${uniq()}`, title: "no criteria",
  });
  assert.equal(empty.ok, true);
  assert.match(empty.note, /cannot be completed/);
});

// ---------------- 14. status transitions ----------------

test("14. setMilestoneStatus appends evidence across honest transitions", async () => {
  const project = `ms-state-${uniq()}`;
  const first = await pm.recordMilestone({
    project_id: project, milestone_key: `k-${uniq()}`, title: "T",
    evidence: [{ kind: "seed", text: "seed" }],
  });
  assert.ok(first.id);
  assert.equal((await pm.setMilestoneStatus({
    project_id: project, milestone_key: "", status: "active", actor: "t",
  })).ok, false, "empty key rejected");
  const key = (await pm.listMilestones({ project_id: project })).milestones[0].milestone_key;
  for (const st of ["active", "at_risk", "blocked", "delayed", "cancelled"]) {
    const r = await pm.setMilestoneStatus({
      project_id: project, milestone_key: key, status: st,
      evidence: [{ kind: "state", status: st }], actor: "tester",
    });
    assert.equal(r.ok, true, `status ${st}`);
  }
  const got = await pm.getMilestone({ project_id: project, milestone_key: key });
  assert.equal(got.milestone.status, "cancelled");
  assert.equal(got.milestone.evidence.length, 6, "seed + 5 transitions, nothing deleted");
  assert.equal((await pm.setMilestoneStatus({ project_id: project, milestone_key: key, status: "bogus", actor: "t" })).ok, false);
  assert.equal((await pm.setMilestoneStatus({ project_id: project, milestone_key: key, status: "active" })).ok, false, "actor required");
});

// ---------------- 15. completion gate ----------------

test("15. completed requires success_criteria AND explicit verification evidence", async () => {
  const project = `ms-complete-${uniq()}`;
  const noCriteria = await pm.recordMilestone({
    project_id: project, milestone_key: `nc-${uniq()}`, title: "no criteria",
  });
  const noKey = (await pm.listMilestones({ project_id: project })).milestones.find((m) => m.id === noCriteria.id).milestone_key;
  const r1 = await pm.setMilestoneStatus({
    project_id: project, milestone_key: noKey, status: "completed", evidence: verifyEv(), actor: "t",
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "insufficient_evidence");
  assert.ok(r1.missing.includes("success_criteria"));

  const withCriteria = await pm.recordMilestone({
    project_id: project, milestone_key: `wc-${uniq()}`, title: "with criteria",
    success_criteria: ["criterion"],
  });
  const wcKey = (await pm.listMilestones({ project_id: project })).milestones.find((m) => m.id === withCriteria.id).milestone_key;
  const r2 = await pm.setMilestoneStatus({
    project_id: project, milestone_key: wcKey, status: "completed", evidence: agentClaim(), actor: "agent",
  });
  assert.equal(r2.ok, false, "agent claim rejected");
  assert.ok(r2.missing.includes("verification_evidence"));
  const r3 = await pm.setMilestoneStatus({
    project_id: project, milestone_key: wcKey, status: "completed",
    evidence: [{ kind: "process_success", status: "success" }], actor: "agent",
  });
  assert.equal(r3.ok, false, "process success rejected");

  const r4 = await pm.setMilestoneStatus({
    project_id: project, milestone_key: wcKey, status: "completed", evidence: verifyEv(), actor: "runner",
  });
  assert.equal(r4.ok, true);
  const got = await pm.getMilestone({ project_id: project, milestone_key: wcKey });
  assert.equal(got.milestone.status, "completed");

  const rejectedAudit = (await core.dbQuery(
    "SELECT count(*)::int n FROM audit_log WHERE action='p26.milestone_complete_rejected' AND detail->>'milestone_key'=$1",
    [wcKey],
  )).rows[0].n;
  assert.ok(rejectedAudit >= 2, "rejected completion attempts audited");
});

// ---------------- 16. milestoneProgress enum ----------------

test("16. milestoneProgress returns counts + enum + reason, never a percentage", async () => {
  const project = `ms-progress-${uniq()}`;
  const goal = await pg.recordGoalExtended({ project_id: project, title: `G ${uniq()}` });

  const noGoal = await pm.recordMilestone({
    project_id: project, milestone_key: `ng-${uniq()}`, title: "no goal",
  });
  const ngKey = (await pm.listMilestones({ project_id: project })).milestones.find((m) => m.id === noGoal.id).milestone_key;
  const p0 = await pm.milestoneProgress({ project_id: project, milestone_key: ngKey });
  assert.equal(p0.ok, true);
  assert.equal(p0.completion, "not_applicable");

  const m1 = await pm.recordMilestone({
    project_id: project, milestone_key: `m1-${uniq()}`, title: "with goal",
    goal_id: goal.id, success_criteria: ["criterion"],
  });
  const m1Key = (await pm.listMilestones({ project_id: project })).milestones.find((m) => m.id === m1.id).milestone_key;
  const p1 = await pm.milestoneProgress({ project_id: project, milestone_key: m1Key });
  assert.equal(p1.completion, "not_applicable", "no linked tasks");
  assert.equal(p1.total, 0);

  await dg.recordTask({
    project_id: project, goal_id: goal.id, task_key: `t1-${uniq()}`, title: "unverified",
    evidence: agentClaim(),
  });
  const p2 = await pm.milestoneProgress({ project_id: project, milestone_key: m1Key });
  assert.equal(p2.total, 1);
  assert.equal(p2.verified_count, 0);
  assert.equal(p2.completion, "insufficient_evidence");
  assert.match(p2.reason, /verification/);

  await dg.recordTask({
    project_id: project, goal_id: goal.id, task_key: `t2-${uniq()}`, title: "verified",
    evidence: verifyEv(), status: "completed",
  });
  const p3 = await pm.milestoneProgress({ project_id: project, milestone_key: m1Key });
  assert.equal(p3.total, 2);
  assert.equal(p3.verified_count, 1);
  assert.equal(p3.completion, "insufficient_evidence");

  for (const r of [p0, p1, p2, p3]) {
    assert.ok(pm.COMPLETION.includes(r.completion));
    assert.equal("percentage" in r, false);
    assert.equal("percent" in r, false);
    assert.equal("progress_pct" in r, false);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
  const p4 = await pm.milestoneProgress({ project_id: project, milestone_key: "missing-key" });
  assert.equal(p4.ok, false);
  assert.equal(p4.completion, "unknown");
});

// ---------------- 17. cross-project isolation ----------------

test("17. goals and milestones are project-isolated on every path", async () => {
  const a = `iso-A-${uniq()}`;
  const b = `iso-B-${uniq()}`;
  const goal = await pg.recordGoalExtended({ project_id: a, title: `Secret ${uniq()}` });
  const msKey = `secret-${uniq()}`;
  const ms = await pm.recordMilestone({ project_id: a, milestone_key: msKey, title: "secret" });

  assert.equal((await pg.listGoals({ project_id: b })).goals.length, 0);
  assert.equal((await pg.getGoalDetail({ project_id: b, goal_id: goal.id })).found, false);
  assert.equal((await pg.getGoalHistory({ project_id: b, goal_id: goal.id })).found, false);
  assert.equal((await pg.setGoalState({ project_id: b, goal_id: goal.id, status: "active", actor: "t" })).ok, false);
  assert.equal((await pg.updateGoalDetails({ project_id: b, goal_id: goal.id, patch: { priority: 5 }, actor: "t" })).ok, false);
  assert.equal((await pm.listMilestones({ project_id: b })).milestones.length, 0);
  assert.ok(ms.id);
  assert.equal((await pm.getMilestone({ project_id: b, milestone_key: msKey })).found, false);
  assert.equal((await pm.setMilestoneStatus({ project_id: b, milestone_key: msKey, status: "active", actor: "t" })).ok, false);
});

// ---------------- 18. redaction ----------------

test("18. credential-shaped content is redacted on write", async () => {
  const project = `redact-${uniq()}`;
  const secret = `sk-${crypto.randomUUID().replace(/-/g, "")}`;
  const made = await pg.recordGoalExtended({
    project_id: project, title: `Goal ${secret}`, description: `token=${secret}`,
    owner: secret, success_criteria: [secret],
  });
  assert.equal(made.ok, true);
  const detail = await pg.getGoalDetail({ project_id: project, goal_id: made.id });
  const text = JSON.stringify(detail.goal);
  assert.equal(text.includes(secret), false);
  assert.match(text, /REDACTED/);
  const hist = await pg.getGoalHistory({ project_id: project, goal_id: made.id });
  assert.equal(JSON.stringify(hist.history).includes(secret), false);
});

// ---------------- 19. fail closed ----------------

test("19. invalid inputs fail closed without throwing", async () => {
  for (const p of ["", "   ", "_global", null, undefined]) {
    assert.equal((await pg.listGoals({ project_id: p })).ok, false);
    assert.equal((await pg.recordGoalExtended({ project_id: p, title: "x" })).ok, false);
    assert.equal((await pm.listMilestones({ project_id: p })).ok, false);
    assert.equal((await pm.recordMilestone({ project_id: p, milestone_key: "k", title: "t" })).ok, false);
    assert.equal((await pm.milestoneProgress({ project_id: p })).ok, false);
  }
  assert.equal((await pg.getGoalDetail({})).ok, false);
  assert.equal((await pg.getGoalHistory({ project_id: "p" })).ok, false);
  assert.equal((await pg.setGoalState({ project_id: "p", goal_id: "" })).ok, false);
  assert.equal((await pg.updateGoalDetails({ project_id: "p", goal_id: "g", actor: "t" })).ok, false);
  assert.equal((await pm.getMilestone({ project_id: "p" })).ok, false);
  assert.equal((await pm.setMilestoneStatus({ project_id: "p", milestone_key: "k", status: "completed" })).ok, false);
});

// ---------------- 20. FINAL DB-down degradation ----------------

test("20. DB-down degrades gracefully without throwing", async () => {
  await core.close(); // pool intentionally closed for the rest of this file
  const results = [];
  let threw = false;
  try {
    results.push(await pg.listGoals({ project_id: uniq() }));
    results.push(await pg.recordGoalExtended({ project_id: uniq(), title: `Down ${uniq()}` }));
    results.push(await pg.setGoalState({ project_id: uniq(), goal_id: "g", status: "active", actor: "t" }));
    results.push(await pm.recordMilestone({ project_id: uniq(), milestone_key: `k-${uniq()}`, title: "t" }));
    results.push(await pm.setMilestoneStatus({ project_id: uniq(), milestone_key: "k", status: "active", actor: "t" }));
    results.push(await pm.milestoneProgress({ project_id: uniq(), milestone_key: "k" }));
  } catch { threw = true; }
  assert.equal(threw, false, "no exceptions escape when the DB is down");
  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.degraded) && r.degraded.length > 0, "degradation is reported");
  }
  assert.equal(results[5].completion, "unknown");
});

// close pool exactly once at the very end (tolerant of the deliberate close in 20)
test("close pool", async () => { try { await core.close(); } catch { /* already closed */ } });
