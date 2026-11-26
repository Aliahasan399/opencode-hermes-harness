// Phase 15: read-only audit of the automatic session-understanding pipeline.
// These tests never insert, update or delete files or DB rows. DB-dependent
// assertions degrade gracefully when the DB is unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as pa from "../src/pipelineAudit.js";

const EXPECTED_NODES = [
  "transcript", "understanding", "knowledge_extraction", "memory",
  "learning", "retrieval", "future_decisions",
];
const EXPECTED_STAGES = [
  "learning", "understanding", "patterns", "strategy", "semantic_understanding",
  "error_learning", "outcome_capture", "retrieval_feedback", "consolidation_triage",
  "outcome_link", "improvement_report", "intelligence_report",
];

test("1. dependency map contains expected nodes and verified modules", () => {
  const map = pa.pipelineDependencyMap();
  assert.deepEqual(map.chain, EXPECTED_NODES);
  for (const id of EXPECTED_NODES) {
    assert.ok(map.nodes[id], `dependency map missing node: ${id}`);
  }
  const transcript = map.nodes.transcript;
  assert.ok(transcript.modules.some((m) => m.file === "src/transcript.js"));
  const appendLine = transcript.modules.find((m) => m.file === "src/transcript.js")
    .functions.find((f) => f.name === "appendLine");
  assert.equal(appendLine.present, true);
  assert.ok(
    Object.values(map.nodes).every((n) => n.allVerified === true),
    "every documented module/function must be verified against source",
  );
  assert.ok(map.edges.length >= 7, "dependency chain edges must be present");
  assert.ok(map.orchestrator.functions.some((f) => f.name === "runTurnEnd" && f.present));
  assert.match(map.claim, /does not prove/i);
});

test("2. wiring audit finds plugin hooks and automation stages", () => {
  const w = pa.auditPipelineIntegrity();
  assert.equal(w.scope, "wiring-presence-only");
  assert.equal(w.verifiedBehavior, false);
  assert.ok(w.ok, `missing wiring: ${w.missing.join(", ")}`);
  for (const id of [
    "plugin.prompt-hook", "plugin.context-hook", "plugin.tool-before-hook",
    "plugin.tool-after-hook", "plugin.event-subscription", "plugin.turn-end-coalescing",
    "plugin.durable-append", "plugin.turn-end-automate", "plugin.startup-recovery",
    "automation.claim-dedupe", "automation.startup-recovery", "automation.recover-events",
    "automation.audit-trail",
  ]) {
    assert.ok(w.present.includes(id), `wiring audit missing check: ${id}`);
  }
  for (const stage of EXPECTED_STAGES) {
    assert.ok(w.present.includes(`automation.stage-${stage}`), `missing stage: ${stage}`);
  }
  assert.ok(w.checks.every((c) => typeof c.ok === "boolean" && c.missing === !c.ok));
});

test("3. wiring audit never claims runtime verification", () => {
  const w = pa.auditPipelineIntegrity();
  assert.equal(w.verifiedBehavior, false);
  assert.match(w.claim, /does not prove/i);
  assert.match(w.claim, /runtime/i);
  for (const c of w.checks.filter((c) => c.ok)) {
    assert.match(c.detail, /presence only/i);
  }
  assert.equal(Object.values(w).includes("verified"), false);
});

test("4. DB audit is read-only (counts unchanged)", async (t) => {
  const countSql =
    "SELECT (SELECT count(*) FROM automation_events)::text AS a, " +
    "(SELECT count(*) FROM semantic_observation)::text AS b, " +
    "(SELECT count(*) FROM learning_runs)::text AS c";
  let before = null;
  try {
    before = (await core.dbQuery(countSql)).rows[0];
  } catch (e) {
    t.diagnostic(`DB unavailable for baseline: ${String(e?.message || e).slice(0, 120)}`);
  }

  const p = await pa.auditRecentProcessing({ limit: 5 });
  assert.equal(p.readOnly, true);
  assert.ok(p.statements.length >= 9, "all expected read queries must be issued");
  assert.ok(
    p.statements.every((s) => /^\s*(SELECT|WITH)\b/i.test(s)),
    "audit must issue SELECT-only statements",
  );
  assert.ok(Array.isArray(p.errors));

  if (!before) {
    // DB unavailable: verify graceful, read-only failure rather than a false pass.
    assert.equal(p.ok, false);
    assert.ok(p.errors.length > 0);
    t.diagnostic("DB unavailable; verified SELECT-only statements and error reporting.");
    return;
  }

  assert.equal(p.ok, true, JSON.stringify(p.errors));
  const after = (await core.dbQuery(countSql)).rows[0];
  assert.deepEqual(after, before, "audit must not change table counts");
});

test("5. gap report includes pending-event gaps", async () => {
  const now = new Date().toISOString();
  const fakeProcessing = {
    ok: true,
    errors: [],
    automation_events: {
      by_status: [{ status: "done", n: 2 }, { status: "pending", n: 1 }, { status: "processing", n: 1 }],
      processed_sessions: 2,
      recent: [],
      duplicates: [],
      pending_or_processing: [
        { session_id: "s-pending", event_id: "e1", status: "pending", attempts: 1, sequence: 1, created_at: now },
        { session_id: "s-stuck", event_id: "e2", status: "processing", attempts: 2, sequence: 2, created_at: now },
      ],
    },
    stage_availability: [{ stage: "learning", n: 2 }, { stage: "understanding", n: 2 }],
    expected_stages: ["learning", "understanding", "patterns"],
    semantic_observation: { sessions: 1, observations: 3, breakdown: [] },
    learning_runs: { sessions: 1, runs: 2, saved: 4 },
  };
  const report = await pa.understandingGapReport({ processing: fakeProcessing });
  const ids = report.gaps.map((g) => g.id);
  assert.ok(ids.includes("pending-events"), "pending events must produce a gap");
  assert.ok(ids.includes("processing-stuck"), "stuck processing events must produce a gap");
  const pendingGap = report.gaps.find((g) => g.id === "pending-events");
  assert.equal(pendingGap.severity, "medium");
  assert.equal(pendingGap.evidence.source, "db");
  assert.ok(report.summary.medium >= 1);
  assert.ok(report.summary.high >= 1);
  assert.equal(report.ok, false);
});

test("6. no feature is claimed verified solely by wiring", async () => {
  const wiring = pa.auditPipelineIntegrity();
  const emptyProcessing = {
    ok: true,
    errors: [],
    automation_events: {
      by_status: [], processed_sessions: 0, recent: [], duplicates: [], pending_or_processing: [],
    },
    stage_availability: [],
    expected_stages: wiring.stages,
    semantic_observation: { sessions: 0, observations: 0, breakdown: [] },
    learning_runs: { sessions: 0, runs: 0, saved: 0 },
  };
  const report = await pa.understandingGapReport({ wiring, processing: emptyProcessing });
  assert.equal(report.runtimeVerified, false);
  assert.equal(report.wiringOnlyVerified, false);
  assert.match(report.claim, /does not prove/i);
  assert.match(report.note, /Neither proves feature correctness/i);
  // Fully wired + zero DB evidence => the report is NOT a pass.
  assert.equal(wiring.ok, true);
  assert.equal(report.ok, false);
  assert.ok(report.gaps.some((g) => g.id === "no-processed-sessions"));
});

test("close pool", async () => { await core.close(); });
