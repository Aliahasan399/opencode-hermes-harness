// Phase 26 §2.3-2.4 — progress snapshots, completion classification and
// reference-only continuity briefings. Unique project ids per test; no source
// writes, no dispatch, no approval, no cross-project access.
// Run: cd E:\OpenCodeData\memory\engine && node --test test/phase26-continuity.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const progress = await import("../src/projectProgress.js");
const continuity = await import("../src/projectContinuity.js");
const dg = await import("../src/developmentGoal.js");

const uniq = () => `p26-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const verifyEvidence = [{ test_pass: true, output: "green" }];
const claimEvidence = [{ kind: "note", text: "the agent says it is done" }];
const allKeys = (r) => JSON.stringify(r).toLowerCase();

before(async () => {
  // Defensive DDL: migration 024 is applied by the parent; these are no-ops then.
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS dev_goal (
      id text PRIMARY KEY, project_id text NOT NULL, title text NOT NULL,
      description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
      requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, source_session text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, title))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS dev_task (
      id text PRIMARY KEY, project_id text NOT NULL, goal_id text, task_key text NOT NULL,
      title text NOT NULL, status text NOT NULL DEFAULT 'not_started', parent_task_id text,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, source_session text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, task_key))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_progress_snapshot (
      id bigserial PRIMARY KEY, project_id text NOT NULL, snapshot_key text NOT NULL,
      goal_id text NOT NULL DEFAULT '', milestone_id text NOT NULL DEFAULT '',
      task_id text NOT NULL DEFAULT '', session_id text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'partial', evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb, source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, snapshot_key))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_continuity_snapshot (
      id uuid PRIMARY KEY, project_id text NOT NULL, briefing jsonb NOT NULL DEFAULT '{}'::jsonb,
      freshness jsonb NOT NULL DEFAULT '{}'::jsonb, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_milestone (
      id uuid PRIMARY KEY, project_id text NOT NULL, milestone_key text NOT NULL,
      goal_id text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
      success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb, priority integer NOT NULL DEFAULT 0,
      target_date timestamptz, status text NOT NULL DEFAULT 'planned',
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
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS workflow_approval (
      id uuid PRIMARY KEY, project_id text NOT NULL, plan_id text NOT NULL DEFAULT '',
      plan_version text NOT NULL DEFAULT '', plan_hash text NOT NULL DEFAULT '',
      scope_key text NOT NULL DEFAULT '', scope jsonb NOT NULL DEFAULT '{}'::jsonb,
      mode text NOT NULL DEFAULT 'simulation', risk text NOT NULL DEFAULT 'low',
      approved_by text NOT NULL DEFAULT '', token_hash text NOT NULL,
      status text NOT NULL DEFAULT 'active', expires_at timestamptz, consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS workflow_task (
      id uuid PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, task_key text NOT NULL,
      title text NOT NULL DEFAULT '', dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
      file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb, assigned_agent text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '', risk text NOT NULL DEFAULT 'low',
      status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      result_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, task_key))`);
});

async function insertTask(project_id, goal_id, task_key, status, evidence) {
  const id = crypto.randomUUID();
  await core.dbQuery(
    `INSERT INTO dev_task (id, project_id, goal_id, task_key, title, status, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [id, project_id, goal_id || null, task_key, `title for ${task_key}`, status, JSON.stringify(evidence)],
  );
  return id;
}

function assertNoPercentage(value) {
  // A documented note may say "no percentage"; the object must not expose a
  // percentage field or any computed numeric percentage value.
  assert.equal(Object.keys(value).some((k) => /percent|pct|ratio/i.test(k)), false, "no percentage field");
  assert.equal(/\d+(?:\.\d+)?\s*%/.test(JSON.stringify(value)), false, "no numeric percentage value");
}

// ---------------------------------------------------------------------------
test("0. exports: frozen enums, capabilities and default exports", () => {
  assert.ok(Object.isFrozen(progress.SNAPSHOT_STATUSES));
  assert.deepEqual([...progress.SNAPSHOT_STATUSES], [
    "complete", "verified", "partial", "in_progress", "blocked", "unverified"]);
  assert.ok(Object.isFrozen(progress.COMPLETION));
  assert.deepEqual([...progress.COMPLETION], ["unknown", "insufficient_evidence", "not_applicable"]);
  for (const k of ["recordSnapshot", "getProgress", "progressHistory", "computeProgress"]) {
    assert.equal(typeof progress[k], "function", `${k} exported`);
    assert.equal(typeof progress.default[k], "function", `${k} on default export`);
  }
  assert.ok(Object.isFrozen(continuity.SECTIONS));
  assert.deepEqual([...continuity.SECTIONS], [
    "project_overview", "verified_progress", "current_work", "blockers_risks",
    "project_drift", "recovery", "recommended_actions", "evidence_confidence"]);
  assert.deepEqual([...continuity.EVIDENCE_CLASSES], ["confirmed", "inferred", "recommendation", "unknown"]);
  for (const k of ["buildBriefing", "saveBriefing", "getLatestBriefing"]) {
    assert.equal(typeof continuity[k], "function", `${k} exported`);
    assert.equal(typeof continuity.default[k], "function", `${k} on default export`);
  }
});

test("1. recordSnapshot: 'verified' requires explicit verification evidence", async () => {
  const p = uniq();
  const ok = await progress.recordSnapshot({ project_id: p, snapshot_key: "v1", status: "verified", evidence: verifyEvidence });
  assert.equal(ok.ok, true);
  assert.ok(ok.id != null);
  assert.equal(ok.duplicate, false);
  const bad = await progress.recordSnapshot({ project_id: p, snapshot_key: "v2", status: "verified", evidence: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "insufficient_evidence");
  assert.equal(bad.id, null);
});

test("2. unverified agent claim is rejected; invalid status fails closed", async () => {
  const p = uniq();
  for (const claim of [claimEvidence, ["done", "implemented", "completed"], { bad: "shape" }, "not-an-array"]) {
    const r = await progress.recordSnapshot({ project_id: p, snapshot_key: `claim-${crypto.randomUUID()}`,
      status: "verified", evidence: claim });
    assert.equal(r.ok, false, `claim ${JSON.stringify(claim)} rejected`);
    assert.equal(r.reason, "insufficient_evidence");
  }
  const invalid = await progress.recordSnapshot({ project_id: p, snapshot_key: "s-invalid", status: "definitely_done" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /invalid status/i);
  const partial = await progress.recordSnapshot({ project_id: p, snapshot_key: "s-partial" });
  assert.equal(partial.ok, true, "default status is partial");
});

test("3. recordSnapshot is idempotent by (project_id, snapshot_key)", async () => {
  const p = uniq();
  const a = await progress.recordSnapshot({ project_id: p, snapshot_key: "same", status: "partial", summary: { step: "first" } });
  const b = await progress.recordSnapshot({ project_id: p, snapshot_key: "same", status: "verified", evidence: verifyEvidence });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(String(b.id), String(a.id), "existing id returned, no overwrite");
  const list = await progress.getProgress({ project_id: p });
  assert.equal(list.count, 1);
  assert.equal(list.snapshots[0].status, "partial", "original row untouched");
});

test("4. getProgress / progressHistory are bounded and project-scoped", async () => {
  const p = uniq();
  for (let i = 0; i < 3; i++) {
    const r = await progress.recordSnapshot({ project_id: p, snapshot_key: `k-${i}`, goal_id: `g-${i}`,
      status: "partial" });
    assert.equal(r.ok, true);
    await core.dbQuery("UPDATE pm_progress_snapshot SET created_at = now() - ($3 || ' seconds')::interval WHERE id = $1 AND project_id = $2",
      [r.id, p, (3 - i) * 10]);
  }
  const desc = await progress.getProgress({ project_id: p, limit: 2 });
  assert.equal(desc.ok, true);
  assert.equal(desc.count, 2, "bounded to 2");
  assert.equal(desc.limit, 2);
  assert.deepEqual(desc.items, desc.snapshots);
  const asc = await progress.progressHistory({ project_id: p, limit: 3 });
  assert.equal(asc.count, 3);
  assert.equal(asc.snapshots[0].snapshot_key, "k-0", "history is oldest-first");
  const filtered = await progress.getProgress({ project_id: p, goal_id: "g-2" });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.snapshots[0].goal_id, "g-2");
  const huge = await progress.getProgress({ project_id: p, limit: 99999 });
  assert.ok(huge.limit <= 200, "limits are capped");
});

test("5. computeProgress: 'not_applicable' with reason and no percentage", async () => {
  const p = uniq();
  const r = await progress.computeProgress({ project_id: p });
  assert.equal(r.ok, true);
  assert.equal(r.completion, "not_applicable");
  assert.equal(r.status, "not_applicable");
  assert.equal(r.total, 0);
  assert.equal(r.verified_count, 0);
  assert.match(r.reason, /not applicable/i);
  assert.ok(Array.isArray(r.evidence));
  assertNoPercentage(r);
});

test("6. computeProgress: 'insufficient_evidence' for unverified work with a reason", async () => {
  const p = uniq();
  const g = crypto.randomUUID();
  await core.dbQuery(`INSERT INTO dev_goal (id, project_id, title) VALUES ($1,$2,$3)`,
    [g, p, "goal for progress"]);
  await insertTask(p, g, "t-unverified", "completed", claimEvidence);
  const r = await progress.computeProgress({ project_id: p, goal_id: g });
  assert.equal(r.ok, true);
  assert.equal(r.completion, "insufficient_evidence");
  assert.equal(r.total, 1);
  assert.equal(r.verified_count, 0);
  assert.match(r.reason, /verification evidence/i);
  assertNoPercentage(r);
});

test("7. computeProgress counts explicit verification and still never claims completion", async () => {
  const p = uniq();
  const g = crypto.randomUUID();
  await core.dbQuery(`INSERT INTO dev_goal (id, project_id, title) VALUES ($1,$2,$3)`,
    [g, p, "goal for verified progress"]);
  const t1 = await insertTask(p, g, "t-verified", "completed", verifyEvidence);
  const t2 = await insertTask(p, g, "t-pending", "in_progress", claimEvidence);
  const partial = await progress.computeProgress({ project_id: p, goal_id: g });
  assert.equal(partial.ok, true);
  assert.equal(partial.total, 2);
  assert.equal(partial.verified_count, 1);
  assert.equal(partial.completion, "insufficient_evidence");
  assert.match(partial.reason, /1 of 2/);
  await core.dbQuery("UPDATE dev_task SET status='completed', evidence=$2::jsonb WHERE id=$1 AND project_id=$3",
    [t2, JSON.stringify(verifyEvidence), p]);
  void t1;
  const full = await progress.computeProgress({ project_id: p, goal_id: g });
  assert.equal(full.total, 2);
  assert.equal(full.verified_count, 2);
  assert.equal(full.status, "verified");
  assert.equal(full.completion, "insufficient_evidence", "no enum value asserts completion");
  assert.match(full.reason, /never asserts project completion/i);
  assertNoPercentage(full);
});

test("8. buildBriefing: all eight sections with the four evidence classes", async () => {
  const p = uniq();
  const r = await continuity.buildBriefing({ project_id: p, limit: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.briefing).sort(), [...continuity.SECTIONS].sort());
  for (const key of continuity.SECTIONS) {
    assert.deepEqual(Object.keys(r.briefing[key]).sort(), [...continuity.EVIDENCE_CLASSES].sort(),
      `${key} has exactly four evidence classes`);
    for (const cls of continuity.EVIDENCE_CLASSES) assert.ok(Array.isArray(r.briefing[key][cls]));
  }
  assert.ok(r.briefing.recommended_actions.recommendation.length > 0);
  assert.ok(r.briefing.evidence_confidence.confirmed.some((x) => x.kind === "authoritative_source"));
  assert.ok(typeof r.note === "string" && /reference-only/i.test(r.note));
  assert.ok(r.freshness && typeof r.freshness.as_of === (r.freshness.as_of ? "string" : "object"));
  assertNoPercentage(r);
});

test("9. buildBriefing uses references only, never transcript text", async () => {
  const p = uniq();
  const marker = "TRANSCRIPT_SECRET_PHRASE_DO_NOT_COPY_9f3a2b";
  await core.dbQuery(`INSERT INTO dev_goal (id, project_id, title, description) VALUES ($1,$2,$3,$4)`,
    [crypto.randomUUID(), p, `Goal ${marker}`, `Description ${marker}`]);
  await insertTask(p, "", "t-marker", "in_progress", [{ kind: "note", text: marker }]);
  await core.dbQuery(`INSERT INTO pm_blocker (id, project_id, blocker_key, title, description, severity, status)
    VALUES ($1,$2,$3,$4,$5,'high','identified')`,
    [crypto.randomUUID(), p, "b-marker", `Blocker ${marker}`, marker]);
  const r = await continuity.buildBriefing({ project_id: p });
  assert.equal(r.ok, true);
  assert.equal(allKeys(r.briefing).includes(marker.toLowerCase()), false, "no transcript text copied");
  const refs = Object.values(r.briefing).flatMap((s) => Object.values(s).flat());
  for (const x of refs) assert.equal(typeof x.kind, "string", "every entry is a typed reference");
});

test("10. degraded diagnostics recorded for unavailable/unrecognized inputs", async () => {
  const p = uniq();
  const r = await continuity.buildBriefing({ project_id: p, sections: ["not_a_real_section", 123] });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.degraded));
  assert.ok(r.degraded.some((d) => /sections/i.test(d)), "unrecognized sections are degraded, not silently accepted");
  for (const d of r.degraded) assert.equal(typeof d, "string");
  assert.deepEqual(Object.keys(r.briefing).sort(), [...continuity.SECTIONS].sort(),
    "degradation never removes section keys");
  const unknownEntries = Object.values(r.briefing).flatMap((s) => s.unknown);
  assert.ok(unknownEntries.length > 0, "missing data is labelled unknown");
});

test("11. outstanding approvals and interrupted workflows are represented honestly", async () => {
  const p = uniq();
  const approvalId = crypto.randomUUID();
  await core.dbQuery(
    `INSERT INTO workflow_approval (id, project_id, plan_id, plan_version, plan_hash, token_hash, status)
     VALUES ($1,$2,'plan-11','v1','hash-11',$3,'active')`,
    [approvalId, p, `hash-${crypto.randomUUID()}`]);
  const runId = `run-${crypto.randomUUID()}`;
  await core.dbQuery(
    `INSERT INTO workflow_task (id, run_id, project_id, task_key, status, updated_at)
     VALUES ($1,$2,$3,'stale-task','running', now() - interval '1 day')`,
    [crypto.randomUUID(), runId, p]);
  const r = await continuity.buildBriefing({ project_id: p });
  assert.equal(r.ok, true);
  const confirmed = r.briefing.recovery.confirmed;
  assert.ok(confirmed.some((x) => x.kind === "approval" && x.id === approvalId), "outstanding approval referenced");
  assert.ok(confirmed.some((x) => x.kind === "interrupted_workflow" && x.run_id === runId),
    "interrupted workflow referenced");
  assert.ok(r.briefing.recovery.recommendation.some((x) => /approval/i.test(x.text)));
  assert.equal(allKeys(r.briefing).includes("token_hash"), false, "no approval token material leaks");
});

test("12. saveBriefing + getLatestBriefing persist bounded, project-scoped snapshots", async () => {
  const p = uniq();
  const built = await continuity.buildBriefing({ project_id: p });
  const first = await continuity.saveBriefing({ project_id: p, briefing: built.briefing,
    freshness: built.freshness, evidence_refs: [{ kind: "goal", id: "g1" }] });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const second = await continuity.saveBriefing({ project_id: p, briefing: built.briefing, freshness: built.freshness });
  assert.equal(second.ok, true);
  const latest = await continuity.getLatestBriefing({ project_id: p, limit: 1 });
  assert.equal(latest.ok, true);
  assert.equal(String(latest.id), String(second.id), "newest snapshot returned");
  assert.equal(latest.count, 1);
  assert.deepEqual(Object.keys(latest.briefing).sort(), [...continuity.SECTIONS].sort());
  assert.deepEqual(latest.evidence_refs, []);
  const none = await continuity.getLatestBriefing({ project_id: uniq() });
  assert.equal(none.ok, true);
  assert.equal(none.briefing, null);
  assert.match(none.reason, /no briefing/i);
});

test("13. cross-project isolation for progress and briefings", async () => {
  const a = uniq();
  const b = uniq();
  await progress.recordSnapshot({ project_id: a, snapshot_key: "shared", status: "partial" });
  await progress.recordSnapshot({ project_id: b, snapshot_key: "shared", status: "partial" });
  const la = await progress.getProgress({ project_id: a });
  const lb = await progress.getProgress({ project_id: b });
  assert.equal(la.count, 1);
  assert.equal(lb.count, 1);
  assert.notEqual(String(la.snapshots[0].id), String(lb.snapshots[0].id));
  await continuity.saveBriefing({ project_id: a, briefing: { project_overview: sectionShape() } });
  const ga = await continuity.getLatestBriefing({ project_id: a });
  const gb = await continuity.getLatestBriefing({ project_id: b });
  assert.equal(ga.ok, true);
  assert.ok(ga.briefing);
  assert.equal(gb.briefing, null, "project B cannot read project A's briefing");
});
function sectionShape() {
  return { confirmed: [], inferred: [], recommendation: [], unknown: [] };
}

test("14. credentials are redacted in snapshots and saved briefings", async () => {
  const p = uniq();
  const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const token = "token=supersecretvalue12345";
  const r = await progress.recordSnapshot({ project_id: p, snapshot_key: "redact",
    status: "partial", evidence: [{ kind: "note", text: `key ${key}` }], summary: { text: token } });
  assert.equal(r.ok, true);
  const list = await progress.getProgress({ project_id: p });
  const s = JSON.stringify(list);
  assert.equal(s.includes(key), false);
  assert.equal(s.includes("supersecretvalue12345"), false);
  assert.ok(/REDACTED/.test(s));
  const save = await continuity.saveBriefing({ project_id: p,
    briefing: { project_overview: { ...sectionShape(), confirmed: [{ kind: "note", text: `Bearer ${key}` }] } } });
  assert.equal(save.ok, true);
  const latest = await continuity.getLatestBriefing({ project_id: p });
  const bs = JSON.stringify(latest);
  assert.equal(bs.includes(key), false);
  assert.ok(/REDACTED/.test(bs));
});

test("15. invalid inputs fail closed across every capability", async () => {
  for (const bad of [undefined, null, "", "   ", "_global", 123, {}]) {
    assert.equal((await progress.recordSnapshot({ project_id: bad, snapshot_key: "x" })).ok, false);
    assert.equal((await progress.getProgress({ project_id: bad })).ok, false);
    assert.equal((await progress.progressHistory({ project_id: bad })).ok, false);
    const cp = await progress.computeProgress({ project_id: bad });
    assert.equal(cp.ok, false);
    assert.equal(cp.completion, "unknown");
    assert.equal((await continuity.buildBriefing({ project_id: bad })).ok, false);
    assert.equal((await continuity.saveBriefing({ project_id: bad, briefing: {} })).ok, false);
    assert.equal((await continuity.getLatestBriefing({ project_id: bad })).ok, false);
  }
  const p = uniq();
  assert.equal((await progress.recordSnapshot({ project_id: p })).ok, false, "snapshot_key required");
  assert.equal((await continuity.saveBriefing({ project_id: p, briefing: [] })).ok, false, "briefing object required");
});

test("16. FINAL: every capability degrades gracefully when the database is down", async () => {
  await core.close(); // the ONLY authoritative close() call in this file

  const rec = await progress.recordSnapshot({ project_id: "p26-down", snapshot_key: "k", status: "partial" });
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /failed|unavailable/i);
  const list = await progress.getProgress({ project_id: "p26-down" });
  assert.equal(list.ok, false);
  assert.deepEqual(list.snapshots, []);
  const cp = await progress.computeProgress({ project_id: "p26-down" });
  assert.equal(cp.ok, false);
  assert.equal(cp.completion, "unknown");
  assert.match(cp.reason, /unavailable/i);
  assertNoPercentage(cp);
  const br = await continuity.buildBriefing({ project_id: "p26-down" });
  assert.equal(br.ok, true, "briefing never blocks a request");
  assert.deepEqual(Object.keys(br.briefing).sort(), [...continuity.SECTIONS].sort());
  assert.ok(Array.isArray(br.degraded) && br.degraded.length > 0, "unavailable sources are recorded");
  assert.equal(br.freshness.stale, true);
  assert.equal(br.freshness.as_of, null);
  assert.match(br.note, /no session transcripts|reference-only/i);
  const save = await continuity.saveBriefing({ project_id: "p26-down", briefing: br.briefing });
  assert.equal(save.ok, false);
  const latest = await continuity.getLatestBriefing({ project_id: "p26-down" });
  assert.equal(latest.ok, false);
  assert.equal(latest.briefing, null);
  void dg;
});

test("17. close pool (idempotent final test; nothing follows)", async () => {
  await core.close().catch(() => { /* pool already ended by the FINAL test */ });
});
