// Phase 26 — project dependencies + blockers facade.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network,
// unique project ids per test, no destructive SQL assertions.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase26-blockers.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const dep = await import("../src/projectDependencies.js");
const blk = await import("../src/projectBlockers.js");

const {
  DEPENDENCY_TYPES, AUTHORITATIVE_TYPE, INCOMPLETE_EVIDENCE_NOTE,
  recordDependency, getDependencies, analyzeDependencies, detectCycles,
} = dep;
const {
  BLOCKER_SEVERITIES, BLOCKER_CATEGORIES, BLOCKER_STATUSES,
  recordBlocker, listBlockers, setBlockerStatus, assessRisks,
} = blk;

const uniq = (p = "p26") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const EV = [{ source: "test", excerpt: "explicit evidence" }];
const STUB_LOADERS = {
  relationshipIntel: { getRelationships: async () => ({ ok: true, relationships: [] }) },
  changeImpact: { compareIndexFreshness: async () => ({ ok: true, stale: false, changed_files: [] }) },
};

// Idempotent schema guards — no-ops when migration 024 / 017 / 020 are applied.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_dependency (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      from_type text NOT NULL,
      from_id text NOT NULL,
      to_type text NOT NULL,
      to_id text NOT NULL,
      dependency_type text NOT NULL DEFAULT 'inferred',
      confidence real NOT NULL DEFAULT 0,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, from_type, from_id, to_type, to_id, dependency_type)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS pm_blocker (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      blocker_key text NOT NULL,
      title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      severity text NOT NULL DEFAULT 'medium',
      category text NOT NULL DEFAULT 'technical',
      status text NOT NULL DEFAULT 'identified',
      affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
      affected_milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
      affected_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      owner text NOT NULL DEFAULT '',
      resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, blocker_key)
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
  await core.dbQuery(`ALTER TABLE dev_task ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]'::jsonb`);
});

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports exist and vocabularies are frozen", () => {
  for (const name of ["recordDependency", "getDependencies", "analyzeDependencies", "detectCycles"]) {
    assert.equal(typeof dep[name], "function", `${name} must be a function`);
    assert.equal(typeof dep.default[name], "function", `default.${name}`);
  }
  for (const name of ["recordBlocker", "listBlockers", "setBlockerStatus", "assessRisks"]) {
    assert.equal(typeof blk[name], "function", `${name} must be a function`);
    assert.equal(typeof blk.default[name], "function", `default.${name}`);
  }
  assert.deepEqual([...DEPENDENCY_TYPES].sort(), ["confirmed", "inferred", "proposed", "unresolved"]);
  assert.equal(AUTHORITATIVE_TYPE, "confirmed");
  assert.equal(Object.isFrozen(DEPENDENCY_TYPES), true);
  assert.equal(Object.isFrozen(BLOCKER_SEVERITIES), true);
  assert.equal(Object.isFrozen(BLOCKER_CATEGORIES), true);
  assert.equal(Object.isFrozen(BLOCKER_STATUSES), true);
  assert.deepEqual([...BLOCKER_STATUSES].sort(),
    ["accepted", "active", "false_positive", "identified", "resolved"]);
  assert.ok(BLOCKER_CATEGORIES.includes("architecture"));
});

// ---------------------------------------------------------------------------
// 1. dependency types + only confirmed authoritative
// ---------------------------------------------------------------------------
test("1. recordDependency types; only confirmed is authoritative", async () => {
  const project = uniq("p26-types");
  const base = { project_id: project, from_type: "task", to_type: "task" };
  const c = await recordDependency({ ...base, from_id: "a", to_id: "b", dependency_type: "confirmed", evidence: EV });
  const i = await recordDependency({ ...base, from_id: "a", to_id: "c", dependency_type: "inferred", evidence: EV });
  const p = await recordDependency({ ...base, from_id: "b", to_id: "d", dependency_type: "proposed", evidence: EV });
  const u = await recordDependency({ ...base, from_id: "b", to_id: "e", dependency_type: "unresolved", evidence: EV });
  for (const r of [c, i, p, u]) assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(c.authoritative, true);
  assert.equal(i.authoritative, false);
  assert.match(i.note, /informational only; not execution constraints/);
  assert.match(p.note, /not execution constraints/);
  assert.match(u.note, /not execution constraints/);
  const def = await recordDependency({ ...base, from_id: "x", to_id: "y", evidence: EV });
  assert.equal(def.ok, true);
  const listed = (await getDependencies({ project_id: project, node_type: "task", node_id: "x", direction: "from" })).items;
  assert.equal(listed.find((x) => x.to_id === "y").dependency_type, "inferred", "default type is inferred");
});

// ---------------------------------------------------------------------------
// 2. idempotent record
// ---------------------------------------------------------------------------
test("2. recordDependency is idempotent by UNIQUE key", async () => {
  const project = uniq("p26-dedupe");
  const args = { project_id: project, from_type: "task", from_id: "a", to_id: "b", to_type: "task",
    dependency_type: "confirmed", evidence: EV };
  const first = await recordDependency(args);
  const second = await recordDependency(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  const items = (await getDependencies({ project_id: project, node_type: "task", node_id: "a", direction: "from" })).items;
  assert.equal(items.length, 1, "no duplicate row");
});

// ---------------------------------------------------------------------------
// 3. getDependencies direction filters + bounded
// ---------------------------------------------------------------------------
test("3. getDependencies is direction-filtered and bounded", async () => {
  const project = uniq("p26-read");
  await recordDependency({ project_id: project, from_type: "task", from_id: "A", to_type: "task", to_id: "B", evidence: EV });
  await recordDependency({ project_id: project, from_type: "task", from_id: "C", to_type: "task", to_id: "A", evidence: EV });
  const from = await getDependencies({ project_id: project, node_type: "task", node_id: "A", direction: "from" });
  const to = await getDependencies({ project_id: project, node_type: "task", node_id: "A", direction: "to" });
  const both = await getDependencies({ project_id: project, node_type: "task", node_id: "A", direction: "both" });
  assert.deepEqual(from.items.map((x) => x.to_id), ["B"]);
  assert.deepEqual(to.items.map((x) => x.from_id), ["C"]);
  assert.equal(both.items.length, 2);
  const limited = await getDependencies({ project_id: project, limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.limit, 1);
});

// ---------------------------------------------------------------------------
// 4. task node also reads dev_task.dependencies (informational only)
// ---------------------------------------------------------------------------
test("4. getDependencies supplements task nodes from dev_task.dependencies", async () => {
  const project = uniq("p26-devtask");
  const tid = `t-${crypto.randomUUID().slice(0, 8)}`;
  await core.dbQuery(
    `INSERT INTO dev_task (id, project_id, task_key, title, dependencies)
     VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (project_id, task_key) DO NOTHING`,
    [`dt-${crypto.randomUUID().slice(0, 8)}`, project, tid, "task one", JSON.stringify(["dep-x", "dep-y", tid])],
  );
  const r = await getDependencies({ project_id: project, node_type: "task", node_id: tid, direction: "from", limit: 10 });
  assert.equal(r.ok, true);
  const synth = r.items.filter((x) => x.source === "dev_task");
  assert.equal(synth.length, 2, "two declared dependencies, self-link skipped");
  assert.ok(synth.every((x) => x.dependency_type === "inferred" && x.authoritative === false));
  assert.match(synth[0].note, /informational only, not an authoritative constraint/);
});

// ---------------------------------------------------------------------------
// 5. analyzeDependencies: blocked / downstream / bottlenecks (confirmed only)
// ---------------------------------------------------------------------------
test("5. analyzeDependencies derives blocked/downstream/bottlenecks from confirmed edges", async () => {
  const project = uniq("p26-analyze");
  const mk = (from, to) => recordDependency({ project_id: project, from_type: "task", from_id: from,
    to_type: "task", to_id: to, dependency_type: "confirmed", evidence: EV });
  for (const e of [["A", "B"], ["B", "C"], ["B", "D"], ["E", "B"]]) await mk(e[0], e[1]);

  const r = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "A", loaders: STUB_LOADERS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.blocked.map((x) => x.node.id).sort(), ["B", "C", "D"]);
  assert.equal(r.downstream.length, 0, "nothing depends on A");
  assert.equal(r.cycles.length, 0);
  assert.equal(r.unknown.length, 0, "all edges confirmed with evidence");
  assert.equal(r.note.includes(INCOMPLETE_EVIDENCE_NOTE), false, "no incomplete-evidence claim when evidence is complete");
  const bottleneck = r.bottlenecks.find((x) => x.node.id === "B");
  assert.ok(bottleneck, "B is a convergence point");
  assert.equal(bottleneck.dependent_count, 2);
  assert.equal(r.claim, "Static/record-based evidence only; not runtime proof; no execution performed.");

  const atB = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "B", loaders: STUB_LOADERS });
  assert.deepEqual(atB.downstream.map((x) => x.node.id).sort(), ["A", "E"]);
});

// ---------------------------------------------------------------------------
// 6. inferred edge is not authoritative
// ---------------------------------------------------------------------------
test("6. inferred edge does not block; it is reported as unknown", async () => {
  const project = uniq("p26-inferred");
  await recordDependency({ project_id: project, from_type: "task", from_id: "A", to_type: "task", to_id: "B",
    dependency_type: "confirmed", evidence: EV });
  await recordDependency({ project_id: project, from_type: "task", from_id: "B", to_type: "task", to_id: "C",
    dependency_type: "inferred", evidence: EV });
  const r = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "A", loaders: STUB_LOADERS });
  assert.deepEqual(r.blocked.map((x) => x.node.id), ["B"], "C excluded: not authoritative");
  assert.ok(r.unknown.some((u) => u.kind === "non_authoritative_edge" && u.dependency_type === "inferred"));
  assert.ok(r.note.includes(INCOMPLETE_EVIDENCE_NOTE));
});

// ---------------------------------------------------------------------------
// 7. incomplete evidence -> unknown, no critical path claimed
// ---------------------------------------------------------------------------
test("7. confirmed edge with no evidence is unknown; no critical path claimed", async () => {
  const project = uniq("p26-noevidence");
  await recordDependency({ project_id: project, from_type: "task", from_id: "A", to_type: "task", to_id: "B",
    dependency_type: "confirmed", evidence: [] });
  const r = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "A", loaders: STUB_LOADERS });
  assert.deepEqual(r.blocked.map((x) => x.node.id), ["B"], "still traversable but flagged");
  assert.ok(r.unknown.some((u) => u.kind === "missing_evidence"));
  assert.ok(r.note.includes("incomplete dependency evidence; no critical path claimed"));
});

// ---------------------------------------------------------------------------
// 8. bounded traversal + clamps
// ---------------------------------------------------------------------------
test("8. analyzeDependencies traversal is depth/node bounded and clamped", async () => {
  const project = uniq("p26-bound");
  for (let i = 0; i < 10; i++) {
    await recordDependency({ project_id: project, from_type: "task", from_id: `t${i}`, to_type: "task",
      to_id: `t${i + 1}`, dependency_type: "confirmed", evidence: EV });
  }
  const shallow = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "t0",
    max_depth: 2, loaders: STUB_LOADERS });
  assert.equal(shallow.blocked.length, 2);
  const clampedDepth = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "t0",
    max_depth: 99, loaders: STUB_LOADERS });
  assert.equal(clampedDepth.depth, 6);
  assert.equal(clampedDepth.blocked.length, 6);
  const clampedNodes = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "t0",
    max_depth: 6, max_nodes: 2, loaders: STUB_LOADERS });
  assert.equal(clampedNodes.max_nodes, 2);
  assert.equal(clampedNodes.blocked.length, 2);
  assert.equal(clampedNodes.truncated, true);
  const clampMin = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "t0",
    max_depth: 0, max_nodes: 0, loaders: STUB_LOADERS });
  assert.equal(clampMin.depth, 1);
  assert.equal(clampMin.max_nodes, 1);
});

// ---------------------------------------------------------------------------
// 9. cycles in analyzeDependencies
// ---------------------------------------------------------------------------
test("9. analyzeDependencies detects cycles among confirmed edges", async () => {
  const project = uniq("p26-cycle");
  for (const [a, b] of [["A", "B"], ["B", "C"], ["C", "A"]]) {
    await recordDependency({ project_id: project, from_type: "task", from_id: a, to_type: "task", to_id: b,
      dependency_type: "confirmed", evidence: EV });
  }
  const r = await analyzeDependencies({ project_id: project, node_type: "task", node_id: "A", loaders: STUB_LOADERS });
  assert.ok(r.cycles.length >= 1, "cycle found");
  const ids = r.cycles[0].map((n) => n.id).sort();
  assert.deepEqual(ids, ["A", "B", "C"]);
});

// ---------------------------------------------------------------------------
// 10. detectCycles bounded
// ---------------------------------------------------------------------------
test("10. detectCycles is bounded and project-scoped", async () => {
  const project = uniq("p26-detectcycle");
  for (const [a, b] of [["A", "B"], ["B", "C"], ["C", "A"], ["X", "Y"]]) {
    await recordDependency({ project_id: project, from_type: "task", from_id: a, to_type: "task", to_id: b,
      dependency_type: "confirmed", evidence: EV });
  }
  const all = await detectCycles({ project_id: project });
  assert.equal(all.ok, true);
  assert.ok(all.count >= 1);
  assert.ok(all.edges_examined >= 4);
  const one = await detectCycles({ project_id: project, limit: 1 });
  assert.equal(one.count, 1, "bounded to one cycle");
  const other = await detectCycles({ project_id: uniq("p26-nocycle") });
  assert.equal(other.count, 0);
});

// ---------------------------------------------------------------------------
// 11. blocker record + validation + idempotency
// ---------------------------------------------------------------------------
test("11. recordBlocker validates severity/category and is idempotent", async () => {
  const project = uniq("p26-blk-record");
  const base = { project_id: project, blocker_key: "b1", title: "Blocked on API", evidence: EV };
  const first = await recordBlocker(base);
  const second = await recordBlocker(base);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal((await recordBlocker({ ...base, severity: "bogus" })).ok, false);
  assert.equal((await recordBlocker({ ...base, category: "bogus" })).ok, false);
  assert.equal((await recordBlocker({ ...base, blocker_key: "" })).ok, false);
  assert.ok(BLOCKER_SEVERITIES.includes("critical"));
  assert.ok(BLOCKER_CATEGORIES.includes("operational"));
});

// ---------------------------------------------------------------------------
// 12. resolve requires verification evidence
// ---------------------------------------------------------------------------
test("12. setBlockerStatus('resolved') requires verification evidence", async () => {
  const project = uniq("p26-resolve");
  await recordBlocker({ project_id: project, blocker_key: "b1", title: "B", evidence: EV });
  const weak = await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "resolved",
    evidence: ["agent says done"], actor: "alice" });
  assert.equal(weak.ok, false);
  assert.equal(weak.reason, "insufficient_evidence");
  const active = await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "active",
    evidence: ["observed"], actor: "alice" });
  assert.equal(active.ok, true);
  const good = await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "resolved",
    evidence: [{ type: "test_pass", result: "passed" }], actor: "alice" });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.status, "resolved");
});

// ---------------------------------------------------------------------------
// 13. status history + actor required
// ---------------------------------------------------------------------------
test("13. setBlockerStatus appends evidence/history and requires actor", async () => {
  const project = uniq("p26-history");
  await recordBlocker({ project_id: project, blocker_key: "b1", title: "B", evidence: ["initial"] });
  assert.equal((await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "active" })).ok, false,
    "actor required");
  assert.equal((await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "bogus", actor: "a" })).ok, false);
  await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "active", evidence: ["ev-active"], actor: "alice" });
  await setBlockerStatus({ project_id: project, blocker_key: "b1", status: "accepted", evidence: ["ev-accepted"], actor: "bob" });
  const row = (await listBlockers({ project_id: project })).items[0];
  assert.equal(row.status, "accepted");
  assert.ok(row.evidence.includes("initial") && row.evidence.includes("ev-active") && row.evidence.includes("ev-accepted"));
  assert.ok(Array.isArray(row.resolution.history) && row.resolution.history.length >= 1);
  assert.ok(row.resolution.history.some((h) => h.status === "active" && h.actor === "alice"));
  assert.equal(row.resolution.actor, "bob");
});

// ---------------------------------------------------------------------------
// 14. listBlockers filters + bounded
// ---------------------------------------------------------------------------
test("14. listBlockers filters by status/severity and is bounded", async () => {
  const project = uniq("p26-list");
  await recordBlocker({ project_id: project, blocker_key: "b1", title: "b1", severity: "high" });
  await recordBlocker({ project_id: project, blocker_key: "b2", title: "b2", severity: "low" });
  await setBlockerStatus({ project_id: project, blocker_key: "b2", status: "active", actor: "alice" });
  assert.equal((await listBlockers({ project_id: project })).items.length, 2);
  const high = await listBlockers({ project_id: project, severity: "high" });
  assert.deepEqual(high.items.map((x) => x.blocker_key), ["b1"]);
  const active = await listBlockers({ project_id: project, status: "active" });
  assert.deepEqual(active.items.map((x) => x.blocker_key), ["b2"]);
  const one = await listBlockers({ project_id: project, limit: 1 });
  assert.equal(one.items.length, 1);
  assert.equal((await listBlockers({ project_id: project, status: "bogus" })).ok, false);
});

// ---------------------------------------------------------------------------
// 15. assessRisks delegates via injectable loaders
// ---------------------------------------------------------------------------
test("15. assessRisks delegates to Phase 23 engines with caller evidence", async () => {
  const project = uniq("p26-delegate");
  const loaders = {
    technicalDebt: { detectDebt: async () => ({ ok: true, findings: [
      { id: "d1", category: "fragile_dependency", description: "single redis", severity: "high",
        confidence: 0.5, detection_method: "deterministic", evidence: [EV[0]] },
    ] }) },
    dependencyRisk: { analyzeDependencies: async () => ({ ok: true, risks: [
      { category: "circular_dependency", description: "explicit cycle", severity: "high",
        confidence: 0.55, detection_method: "explicit_edge" },
    ] }) },
    projectRisk: { predictFragility: async () => ({ ok: true, predictions: [
      { risk_category: "missing_tests", description: "gap", severity: "medium",
        confidence: 0.4, evidence_class: "potential_failure" },
    ] }) },
    recommendationEngine: { buildRecommendations: async () => ({ ok: true, recommendations: [
      { category: "quality", description: "add a test", severity: "low", confidence: 0.3 },
    ] }) },
  };
  const r = await assessRisks({ project_id: project, loaders,
    evidence: { confirmed: [{ description: "operator confirmed" }], edges: [] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const key of ["tech_debt", "dependency_risk", "fragility", "recommendations"]) {
    assert.equal(r.delegated[key].ok, true, `${key} delegated`);
  }
  assert.equal(r.degraded.length, 0);
  assert.equal(r.distinctions.confirmed.length, 1);
  assert.equal(r.distinctions.confirmed[0].source, "caller_confirmed");
  assert.ok(r.distinctions.observed.some((x) => x.source === "tech_debt"));
  assert.ok(r.distinctions.observed.some((x) => x.source === "dependency_risk"));
  assert.ok(r.distinctions.potential.some((x) => x.source === "fragility"));
  assert.ok(r.distinctions.potential.some((x) => x.source === "recommendations"));
  assert.ok(r.risks.length >= 5);
});

// ---------------------------------------------------------------------------
// 16. assessRisks records degraded reasons when a delegate fails
// ---------------------------------------------------------------------------
test("16. assessRisks degrades gracefully when a delegate is unavailable", async () => {
  const project = uniq("p26-degraded");
  const loaders = {
    technicalDebt: async () => { throw new Error("tech down"); },
    dependencyRisk: { analyzeDependencies: async () => ({ ok: false, reason: "no edges" }) },
    projectRisk: { predictFragility: async () => ({ ok: true, predictions: [] }) },
    recommendationEngine: { buildRecommendations: async () => ({ ok: true, recommendations: [] }) },
  };
  const r = await assessRisks({ project_id: project, loaders, evidence: {} });
  assert.equal(r.ok, true, "facade still returns a result");
  assert.equal(r.delegated.tech_debt.ok, false);
  assert.ok(r.delegated.tech_debt.degraded.some((d) => /tech down/.test(d)));
  assert.equal(r.delegated.dependency_risk.ok, false);
  assert.ok(r.degraded.some((d) => /no edges/.test(d)));
  assert.ok(r.distinctions.insufficient_evidence.length > 0, "degraded reasons recorded");
});

// ---------------------------------------------------------------------------
// 17. real Phase 23 engines, no manufactured scores
// ---------------------------------------------------------------------------
test("17. assessRisks uses real engines and manufactures no probability/score", async () => {
  const project = uniq("p26-score");
  const r = await assessRisks({ project_id: project,
    evidence: { markers: ["workaround: manual retry"], edges: ["A -> B"] }, limit: 20 });
  assert.equal(r.ok, true);
  for (const key of ["tech_debt", "dependency_risk", "fragility", "recommendations"]) {
    assert.equal(r.delegated[key].ok, true, `${key} real engine responded ok`);
  }
  assert.ok(r.risks.length > 0);
  const forbidden = ["score", "probability", "risk_score", "completion_percent", "completion_percentage"];
  for (const key of forbidden) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, key), false, `top-level ${key}`);
    for (const risk of r.risks) {
      assert.equal(Object.prototype.hasOwnProperty.call(risk, key), false, `risk ${key}`);
    }
  }
  assert.match(r.note, /No probability, percentage or risk score is manufactured here/);
  assert.equal(r.claim, "Static/record-based evidence only; not runtime proof; no execution performed.");
  assert.ok(r.risks.every((x) => x.confidence === null || (x.confidence <= 1 && x.confidence >= 0)),
    "confidence is a bounded pass-through, if present");
});

// ---------------------------------------------------------------------------
// 18. cross-project isolation
// ---------------------------------------------------------------------------
test("18. dependencies and blockers are project-scoped", async () => {
  const a = uniq("p26-iso-a");
  const b = uniq("p26-iso-b");
  await recordDependency({ project_id: a, from_type: "task", from_id: "A", to_type: "task", to_id: "B", evidence: EV });
  await recordBlocker({ project_id: a, blocker_key: "b1", title: "B" });
  assert.equal((await getDependencies({ project_id: b })).items.length, 0);
  assert.equal((await listBlockers({ project_id: b })).items.length, 0);
  assert.equal((await detectCycles({ project_id: b })).count, 0);
  const cross = await setBlockerStatus({ project_id: b, blocker_key: "b1", status: "active", actor: "eve" });
  assert.equal(cross.ok, false, "cannot change another project's blocker");
});

// ---------------------------------------------------------------------------
// 19. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("19. invalid inputs fail closed without throwing", async () => {
  assert.equal((await recordDependency()).ok, false);
  assert.equal((await recordDependency({ project_id: "_global", from_type: "t", from_id: "a", to_type: "t", to_id: "b" })).ok, false);
  assert.equal((await recordDependency({ project_id: "p", from_type: "t", from_id: "a", to_type: "t", to_id: "b",
    dependency_type: "bogus" })).ok, false);
  assert.equal((await getDependencies()).ok, false);
  assert.equal((await getDependencies({ project_id: "p", direction: "sideways" })).ok, false);
  assert.equal((await analyzeDependencies()).ok, false);
  assert.equal((await detectCycles()).ok, false);
  assert.equal((await recordBlocker()).ok, false);
  assert.equal((await listBlockers()).ok, false);
  assert.equal((await setBlockerStatus({ project_id: "p", blocker_key: "b1", status: "active" })).ok, false);
  assert.equal((await assessRisks()).ok, false);
});

// ---------------------------------------------------------------------------
// 20. redaction before persistence/return
// ---------------------------------------------------------------------------
test("20. credential-like content is redacted in dependencies and blockers", async () => {
  const project = uniq("p26-secret");
  const secret = `sk-${"a".repeat(32)}`;
  await recordDependency({ project_id: project, from_type: "task", from_id: "A", to_type: "task", to_id: "B",
    evidence: [`token ${secret}`] });
  await recordBlocker({ project_id: project, blocker_key: "b1", title: `api_key=${secret} blocked`,
    evidence: [`secret=${secret}`] });
  const deps = (await getDependencies({ project_id: project })).items;
  assert.equal(JSON.stringify(deps).includes(secret), false, "dependency never leaks secret");
  const blockers = (await listBlockers({ project_id: project })).items;
  assert.equal(JSON.stringify(blockers).includes(secret), false, "blocker never leaks secret");
  assert.ok(JSON.stringify(blockers).includes("[REDACTED"));
});

// ---------------------------------------------------------------------------
// 21. FINAL: DB-down graceful degradation. Nothing meaningful runs after this.
// ---------------------------------------------------------------------------
test("21. FINAL: all capabilities degrade gracefully after core.close()", async () => {
  await core.close(); // authoritative close for this file
  const p = "p26-db-down";
  const cases = [
    await recordDependency({ project_id: p, from_type: "task", from_id: "A", to_type: "task", to_id: "B" }),
    await getDependencies({ project_id: p }),
    await analyzeDependencies({ project_id: p, node_type: "task", node_id: "A", loaders: STUB_LOADERS }),
    await detectCycles({ project_id: p }),
    await recordBlocker({ project_id: p, blocker_key: "b1", title: "B" }),
    await listBlockers({ project_id: p }),
    await setBlockerStatus({ project_id: p, blocker_key: "b1", status: "active", actor: "alice" }),
  ];
  for (const r of cases) {
    assert.equal(r.ok, false, "DB-down fails closed");
    assert.ok(Array.isArray(r.degraded) && r.degraded.length > 0, "degraded reason recorded");
  }
  const risks = await assessRisks({ project_id: p, evidence: {}, loaders: STUB_LOADERS });
  assert.equal(typeof risks.ok, "boolean", "assessRisks does not throw when DB is down");
});

// Closing pool test (idempotent): nothing meaningful runs after this.
test("close pool", async () => { try { await core.close(); } catch { /* already closed */ } });
