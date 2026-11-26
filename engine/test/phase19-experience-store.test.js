// Phase 19 workstream E — reusable development-experience store.
// Isolated DB only, no LLM/network, unique project ids per test, no deletion.
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase19-experience-store.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const store = await import("../src/experienceStore.js");

const uniq = () => `p19e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const {
  recordExperience,
  findDuplicateExperiences,
  consolidateExperiences,
  markExperienceStale,
  getExperiences,
  experienceReport,
  EXPERIENCE_KINDS,
  SIMILARITY_THRESHOLD,
  CONSOLIDATE_SIMILARITY_THRESHOLD,
} = store;

// The shipped migration 017 already creates this table. This idempotent guard is a
// no-op in the normal case and keeps the standalone test runnable on a fresh DB.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS dev_experience (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      session_id text,
      goal_id text,
      task_id text,
      kind text NOT NULL DEFAULT 'pattern',
      title text NOT NULL,
      problem text NOT NULL DEFAULT '',
      environment text NOT NULL DEFAULT '',
      approach text NOT NULL DEFAULT '',
      result text NOT NULL DEFAULT '',
      verification_status text NOT NULL DEFAULT 'observed',
      root_cause text NOT NULL DEFAULT '',
      root_cause_status text NOT NULL DEFAULT 'hypothesis',
      failed_approaches jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real,
      reusability text NOT NULL DEFAULT 'project',
      status text NOT NULL DEFAULT 'active',
      freshness_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, title)
    )`);
  await core.dbQuery("CREATE INDEX IF NOT EXISTS de_project_idx ON dev_experience (project_id, kind, updated_at DESC)");
  await core.dbQuery("CREATE INDEX IF NOT EXISTS de_goal_idx ON dev_experience (goal_id)");
});

async function rawRow(id) {
  return (await core.dbQuery("SELECT * FROM dev_experience WHERE id=$1 LIMIT 1", [id])).rows[0];
}

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports exist and EXPERIENCE_KINDS is frozen with all seven kinds", async () => {
  for (const name of ["recordExperience", "findDuplicateExperiences", "consolidateExperiences",
    "markExperienceStale", "getExperiences", "experienceReport"]) {
    assert.equal(typeof store[name], "function", `${name} must be exported as a function`);
  }
  assert.equal(Object.isFrozen(EXPERIENCE_KINDS), true, "EXPERIENCE_KINDS must be frozen");
  assert.deepEqual(Object.values(EXPERIENCE_KINDS).sort(), [
    "configuration", "debugging", "deployment", "integration", "pattern", "procedure", "testing",
  ]);
  assert.equal(typeof SIMILARITY_THRESHOLD, "number");
  assert.ok(CONSOLIDATE_SIMILARITY_THRESHOLD > SIMILARITY_THRESHOLD);
});

// ---------------------------------------------------------------------------
// 1. happy path + defaults + clamped confidence
// ---------------------------------------------------------------------------
test("1. recordExperience writes a scoped experience with bounded confidence and defaults", async () => {
  const project = `exp-create-${uniq()}`;
  const title = `Fix redirect loop ${uniq()}`;
  const r = await recordExperience({
    project_id: project, session_id: `s-${uniq()}`, title, kind: "debugging",
    problem: "login redirect loop", approach: "cleared stale cookie", result: "resolved",
    evidence: ["log-A", "log-B", "log-B"], confidence: 3, // clamped to 1
  });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.created, true);
  assert.equal(r.duplicate, undefined);
  assert.ok(r.id);

  const got = await getExperiences({ project_id: project });
  assert.equal(got.ok, true);
  const row = got.items.find((x) => x.id === r.id);
  assert.ok(row);
  assert.equal(row.title, title);
  assert.equal(row.kind, "debugging");
  assert.equal(row.confidence, 1, "confidence clamped to [0,1]");
  assert.equal(row.status, "active");
  assert.equal(row.verification_status, "observed");
  assert.equal(row.reusability, "project");
  assert.equal(row.root_cause_status, "hypothesis");
  assert.ok(row.evidence.includes("log-A"));
  assert.ok(row.evidence.includes("log-B"));
  assert.equal(row.evidence.filter((e) => e === "log-B").length, 1, "identical evidence deduped");
  assert.ok(row.evidence.some((e) => e && e.event === "experience.record_created"), "creation provenance recorded");
});

// ---------------------------------------------------------------------------
// 2. dedupe: no overwrite, evidence merge, prior values in history, freshness bump
// ---------------------------------------------------------------------------
test("2. same (project,title) is a duplicate that is never overwritten; evidence and history are merged", async () => {
  const project = `exp-dup-${uniq()}`;
  const title = `Dedupe target ${uniq()}`;
  const first = await recordExperience({
    project_id: project, title, approach: "ORIGINAL approach", result: "ORIGINAL result",
    root_cause: "original cause", verification_status: "inferred", confidence: 0.4,
    evidence: ["src-A"], session_id: "sess-A",
  });
  const second = await recordExperience({
    project_id: project, title, approach: "OVERWRITE attempt", result: "OVERWRITE result",
    root_cause: "replacement cause", verification_status: "inferred", confidence: 0.9,
    evidence: ["src-A", "src-B"], session_id: "sess-B",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const row = await rawRow(first.id);
  assert.equal(row.approach, "ORIGINAL approach", "approach must not be overwritten");
  assert.equal(row.result, "ORIGINAL result", "result must not be overwritten");
  assert.equal(row.root_cause, "original cause", "root cause must not be overwritten");
  assert.equal(Number(row.confidence), 0.4, "confidence must not be overwritten");
  assert.equal(row.verification_status, "inferred", "status unchanged when not strictly stronger");

  const ev = row.evidence;
  assert.ok(ev.includes("src-A"));
  assert.ok(ev.includes("src-B"), "new evidence merged in");
  assert.equal(ev.filter((e) => e === "src-A").length, 1, "identical string deduped");
  const hist = ev.find((e) => e && e.event === "experience.record_duplicate");
  assert.ok(hist, "prior values appended to evidence history");
  assert.equal(hist.previous.verification_status, "inferred");
  assert.equal(hist.previous.confidence, 0.4);
  assert.equal(hist.incoming.source_session, "sess-B");
  assert.ok(new Date(row.freshness_at).getTime() >= new Date(row.created_at).getTime());

  const count = (await core.dbQuery(
    "SELECT count(*)::int n FROM dev_experience WHERE project_id=$1 AND title=$2", [project, title],
  )).rows[0].n;
  assert.equal(count, 1, "still exactly one row for the title");
});

// ---------------------------------------------------------------------------
// 3. no auto-promotion to verified without explicit verification evidence
// ---------------------------------------------------------------------------
test("3. verification_status is not auto-promoted to verified without explicit verification evidence", async () => {
  const project = `exp-verify-${uniq()}`;
  const title = `Verification target ${uniq()}`;
  await recordExperience({ project_id: project, title, verification_status: "inferred", evidence: ["base"] });

  const plain = await recordExperience({
    project_id: project, title, verification_status: "verified", evidence: ["just another log"],
  });
  assert.equal(plain.duplicate, true);
  assert.equal((await rawRow(plain.id)).verification_status, "inferred", "plain evidence must not promote to verified");

  const explicit = await recordExperience({
    project_id: project, title, verification_status: "verified",
    evidence: ["verified: reproduced on clean environment, exit 0"],
  });
  assert.equal(explicit.duplicate, true);
  assert.equal((await rawRow(explicit.id)).verification_status, "verified", "explicit verification evidence allows promotion");
});

// ---------------------------------------------------------------------------
// 4. consolidation: contradiction preserved, both evidence sets kept, no delete
// ---------------------------------------------------------------------------
test("4. consolidation keeps both evidence sets and records a contradiction instead of choosing one", async () => {
  const project = `exp-contra-${uniq()}`;
  const base = `Handle timeout ${uniq()}`;
  const a = await recordExperience({
    project_id: project, title: base, result: "Retry with exponential backoff works",
    evidence: ["evidence-A"],
  });
  const b = await recordExperience({
    project_id: project, title: `${base.toUpperCase()} `, result: "Do not retry; fail fast instead",
    evidence: ["evidence-B"],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.id, b.id, "normalized-equal but raw-different titles coexist");

  const r = await consolidateExperiences({ project_id: project });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.examined, 2);
  assert.equal(r.merged, 1);
  assert.equal(r.contradictions.length, 1, "conflict recorded, not resolved by choosing one side");
  assert.match(r.contradictions[0].reason, /conclusions differ/);

  const rowA = await rawRow(a.id);
  const rowB = await rawRow(b.id);
  assert.ok(rowA, "canonical row still exists");
  assert.ok(rowB, "source row still exists (never deleted)");
  assert.equal(rowB.status, "superseded", "source marked superseded");
  assert.ok(rowA.evidence.includes("evidence-A"));
  assert.ok(rowA.evidence.includes("evidence-B"), "both evidence sets preserved on canonical");
  assert.ok(rowA.evidence.some((e) => e && e.event === "experience.contradiction"), "contradiction entry appended");
  assert.ok(rowB.evidence.some((e) => e && e.event === "experience.consolidated" && e.role === "source"), "source provenance recorded");

  const rep = await experienceReport({ project_id: project });
  assert.equal(rep.ok, true);
  assert.ok(rep.contradictions >= 1, "report surfaces the contradiction count");
});

// ---------------------------------------------------------------------------
// 5. consolidation: very-high-overlap merge + idempotency
// ---------------------------------------------------------------------------
test("5. consolidation merges very-high-overlap duplicates and is idempotent", async () => {
  const p2 = `exp-merge-${uniq()}`;
  const c = await recordExperience({ project_id: p2, title: "Resolve database connection pool exhaustion under load", evidence: ["c-1"] });
  const d = await recordExperience({ project_id: p2, title: "Resolve database connection pool exhaustion under heavy load", evidence: ["d-1"] });

  const first = await consolidateExperiences({ project_id: p2 });
  assert.equal(first.ok, true, `unexpected: ${first.reason}`);
  assert.equal(first.examined, 2);
  assert.equal(first.merged, 1, "very high overlap merges");
  assert.equal(first.contradictions.length, 0, "no conflict: empty results/root causes");

  const second = await consolidateExperiences({ project_id: p2 });
  assert.equal(second.merged, 0, "idempotent: second run merges nothing");
  const rowD = await rawRow(d.id);
  assert.equal(rowD.status, "superseded");
  assert.ok((await rawRow(c.id)).evidence.includes("d-1"));
  assert.equal((await getExperiences({ project_id: p2, status: "active" })).items.length, 1);
});

// ---------------------------------------------------------------------------
// 6. markExperienceStale
// ---------------------------------------------------------------------------
test("6. markExperienceStale sets status stale, appends reason to evidence, and does not delete", async () => {
  const project = `exp-stale-${uniq()}`;
  const made = await recordExperience({ project_id: project, title: `Stale me ${uniq()}`, evidence: ["orig"] });
  const r = await markExperienceStale({ id: made.id, reason: "superseded by new runtime", evidence: ["stale-note"] });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.stale, true);

  const row = await rawRow(made.id);
  assert.ok(row, "row still exists");
  assert.equal(row.status, "stale");
  assert.ok(row.evidence.includes("superseded by new runtime"), "reason appended to evidence");
  assert.ok(row.evidence.includes("stale-note"), "supplied evidence appended");
  assert.ok(row.evidence.some((e) => e && e.event === "experience.stale"), "history preserved");
});

// ---------------------------------------------------------------------------
// 7. experienceReport aggregates
// ---------------------------------------------------------------------------
test("7. experienceReport aggregates by kind/status and counts verified, stale, contradictions", async () => {
  const project = `exp-report-${uniq()}`;
  await recordExperience({
    project_id: project, title: `Verified one ${uniq()}`, kind: "debugging",
    verification_status: "verified", evidence: ["verified: CI green"],
  });
  const s = await recordExperience({ project_id: project, title: `Stale one ${uniq()}`, kind: "pattern" });
  await markExperienceStale({ id: s.id, reason: "outdated" });

  const rep = await experienceReport({ project_id: project });
  assert.equal(rep.ok, true);
  assert.equal(rep.total, 2);
  assert.equal(rep.by_kind.debugging, 1);
  assert.equal(rep.by_kind.pattern, 1);
  assert.equal(rep.by_status.active, 1);
  assert.equal(rep.by_status.stale, 1);
  assert.equal(rep.verified_count, 1);
  assert.equal(rep.stale_count, 1);
  assert.equal(rep.contradictions, 0);
  assert.equal(typeof rep.note, "string");
});

// ---------------------------------------------------------------------------
// 8. findDuplicateExperiences: signature, pairwise, threshold, bounds
// ---------------------------------------------------------------------------
test("8. findDuplicateExperiences is deterministic, thresholded, bounded and project-scoped", async () => {
  const project = `exp-find-${uniq()}`;
  await recordExperience({
    project_id: project, title: "Kubernetes rolling deploy rollback",
    problem: "deployment failing", approach: "check pods", result: "rolled back",
    evidence: ["k8s"],
  });

  const sig = await findDuplicateExperiences({
    project_id: project, signature: "kubernetes rolling deploy rollback check pods",
  });
  assert.equal(sig.ok, true, `unexpected: ${sig.reason}`);
  assert.equal(sig.threshold, SIMILARITY_THRESHOLD);
  assert.ok(sig.items.length >= 1, "signature matches a stored experience");
  assert.ok(sig.items[0].similarity >= SIMILARITY_THRESHOLD);

  const pairwise = await findDuplicateExperiences({ project_id: project });
  assert.equal(pairwise.ok, true);
  for (const item of pairwise.items) assert.ok(item.matched_with, "pairwise items carry matched_with");

  const bounded = await findDuplicateExperiences({ project_id: project, limit: 1 });
  assert.ok(bounded.items.length <= 1, "limit honored");

  const other = `exp-find-other-${uniq()}`;
  const cross = await findDuplicateExperiences({ project_id: other, signature: "kubernetes rolling deploy rollback check pods" });
  assert.equal(cross.items.length, 0, "no cross-project lookup");
});

// ---------------------------------------------------------------------------
// 9. getExperiences filters + bounded + project isolation
// ---------------------------------------------------------------------------
test("9. getExperiences filters by kind/status, is bounded and project-isolated", async () => {
  const a = `exp-iso-A-${uniq()}`;
  const b = `exp-iso-B-${uniq()}`;
  const sameTitle = `Shared title ${uniq()}`;
  const d1 = await recordExperience({ project_id: a, title: sameTitle, kind: "debugging" });
  await recordExperience({ project_id: a, title: `Pattern thing ${uniq()}`, kind: "pattern" });
  await recordExperience({ project_id: b, title: sameTitle, kind: "configuration" });
  await markExperienceStale({ id: d1.id, reason: "done" });

  const inA = await getExperiences({ project_id: a });
  assert.equal(inA.items.length, 2, "only project A rows");
  for (const item of inA.items) assert.equal(item.project_id, a);

  const debug = await getExperiences({ project_id: a, kind: "debugging" });
  assert.equal(debug.items.length, 1);
  assert.equal(debug.items[0].kind, "debugging");

  const stale = await getExperiences({ project_id: a, status: "stale" });
  assert.equal(stale.items.length, 1);
  assert.equal(stale.items[0].id, d1.id);

  const two = await getExperiences({ project_id: a, limit: 1 });
  assert.equal(two.items.length, 1, "limit honored");

  const inB = await getExperiences({ project_id: b });
  assert.equal(inB.items.length, 1, "same title allowed in another project; no cross-project rows");
  assert.equal(inB.items[0].kind, "configuration");

  const repB = await experienceReport({ project_id: b });
  assert.equal(repB.total, 1, "report project-scoped");
});

// ---------------------------------------------------------------------------
// 10. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("10. invalid inputs fail closed without throwing", async () => {
  const bad = [
    {}, { project_id: "", title: "x" }, { project_id: "   ", title: "x" },
    { project_id: "_global", title: "x" }, { project_id: 123, title: "x" },
    { project_id: "p", title: "" }, { project_id: "p", title: "   " },
    { project_id: "p", title: "x", evidence: "not-an-array" },
    { project_id: "p", title: "x", failed_approaches: {} },
  ];
  for (const input of bad) {
    const r = await recordExperience(input);
    assert.equal(r.ok, false, `expected fail-closed for ${JSON.stringify(input)}`);
    assert.equal(r.created, false);
  }
  assert.equal((await getExperiences({ project_id: "" })).ok, false);
  assert.equal((await findDuplicateExperiences({ project_id: "_global" })).ok, false);
  assert.equal((await consolidateExperiences({ project_id: "" })).ok, false);
  assert.equal((await experienceReport({ project_id: "" })).ok, false);
  assert.equal((await markExperienceStale({ id: "" })).ok, false);
  assert.equal((await markExperienceStale({ id: "missing-id" })).ok, false);
});

// ---------------------------------------------------------------------------
// 11. bounded limits (hard cap) on reads
// ---------------------------------------------------------------------------
test("11. getExperiences caps limit at 200 even when a larger value is requested", async () => {
  const project = `exp-limit-${uniq()}`;
  const tag = uniq();
  // One bounded insert (no DELETE / TRUNCATE) keeps this test fast while still
  // creating more than the 200-row read cap.
  await core.dbQuery(
    `INSERT INTO dev_experience (id, project_id, kind, title, evidence)
     SELECT 'bulk-' || g::text || '-' || $2::text, $1::text, 'pattern',
            'Bulk ' || g::text, '[]'::jsonb
     FROM generate_series(1, 202) AS g
     ON CONFLICT DO NOTHING`,
    [project, tag],
  );
  const huge = await getExperiences({ project_id: project, limit: 999 });
  assert.equal(huge.ok, true);
  assert.equal(huge.items.length, 200, "hard cap at 200");
  const exact = await getExperiences({ project_id: project, limit: 3 });
  assert.equal(exact.items.length, 3);
});

// ---------------------------------------------------------------------------
// 12. no secret leakage
// ---------------------------------------------------------------------------
test("12. credential-like content is redacted before persistence", async () => {
  const project = `exp-secret-${uniq()}`;
  const secret = `sk-${"a".repeat(32)}`;
  const r = await recordExperience({
    project_id: project, title: `Secret check ${uniq()}`,
    problem: `api_key=${secret}`, approach: `password=${secret}`,
    evidence: [`token ${secret}`],
  });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  const row = await rawRow(r.id);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(secret), false, "raw credential must not be stored");
  assert.ok(serialized.includes("[REDACTED"), "redaction marker present");
});

// ---------------------------------------------------------------------------
// close pool (exactly once, at the end)
// ---------------------------------------------------------------------------
test("close pool", async () => { await core.close(); });
