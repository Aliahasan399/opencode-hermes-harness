import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { recordTask, recordAttempt, recordOutcome, linkOutcomesToExperiments,
  strategyLifecycle, selfImprovementReport, classifyOutcome, getOutcomes } from "../src/learning10.js";

const uniq = () => `p12c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedOutcome({ project, value = "true", metric = "test_pass", measurement = "observed" }) {
  const t = await recordTask({ description: `Fix issue ${uniq()}`, project_id: project, task_type: "debugging" });
  const a = await recordAttempt({ task_id: t.task_id, approach: "focused tests first", strategy_id: `strategy-${uniq()}` });
  await recordOutcome({ task_id: t.task_id, attempt_id: a.attempt_id, metric, value, measurement, evidence: { seeded: true } });
  return t.task_id;
}

test("1. automatic outcome linkage to strategy experiments", async () => {
  const p = `link-${uniq()}`;
  await seedOutcome({ project: p, value: "true" });
  const r = await linkOutcomesToExperiments({ project_id: p });
  assert.ok(r.linked >= 1);
  const n = (await core.dbQuery(
    `SELECT count(*)::int n FROM strategy_experiment_results r
     JOIN strategy_experiment e ON e.id=r.experiment_id WHERE e.project_id=$1 AND r.source_outcome_id IS NOT NULL`, [p])).rows[0].n;
  assert.ok(n >= 1);
});

test("1b. linkage is idempotent", async () => {
  const p = `idem-${uniq()}`;
  await seedOutcome({ project: p, value: "true" });
  const a = await linkOutcomesToExperiments({ project_id: p });
  const b = await linkOutcomesToExperiments({ project_id: p });
  assert.ok(a.linked >= 1);
  assert.equal(b.linked, 0);
});

test("2. estimated metrics are never linked as observed", async () => {
  const p = `est-${uniq()}`;
  await seedOutcome({ project: p, value: "probably", measurement: "estimated" });
  const before = (await core.dbQuery("SELECT count(*)::int n FROM strategy_experiment_results WHERE project_id=$1", [p])).rows[0].n;
  await linkOutcomesToExperiments({ project_id: p });
  const after = (await core.dbQuery("SELECT count(*)::int n FROM strategy_experiment_results WHERE project_id=$1", [p])).rows[0].n;
  assert.equal(after, before);
  assert.equal(classifyOutcome("probably", "estimated"), "not_measured");
});

test("3. repeated failure detection in improvement report", async () => {
  const p = `fail-${uniq()}`;
  await seedOutcome({ project: p, value: "false", metric: "test_pass" });
  await seedOutcome({ project: p, value: "false", metric: "test_pass" });
  const r = await selfImprovementReport({ project_id: p });
  assert.ok(Array.isArray(r.repeated_failures));
});

test("4. successful strategy detection with sample threshold", async () => {
  const key = `succ-${uniq()}`;
  for (let i = 0; i < 6; i++) {
    await core.dbQuery(
      `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
       VALUES ('00000000-0000-0000-0000-000000000000',$1,'success','observed',$2)`,
      [key, `p-${i % 2}`],
    ).catch(() => {}); // FK may reject sentinel; use a real experiment below instead
  }
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  assert.ok(exp);
  await core.dbQuery("DELETE FROM strategy_experiment_results WHERE strategy_key=$1", [key]);
  for (let i = 0; i < 6; i++) {
    await core.dbQuery(
      `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
       VALUES ($1,$2,'success','observed',$3)`, [exp.id, key, `p-${i % 2}`],
    );
  }
  const r = await strategyLifecycle({ strategy_key: key, min_samples: 5 });
  assert.equal(r.status, "supported");
  assert.notEqual(r.status, "confirmed");
});

test("5. project-specific strategy evaluation", async () => {
  const key = `proj-${uniq()}`;
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  await core.dbQuery(
    `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
     VALUES ($1,$2,'success','observed',$3)`, [exp.id, key, "projA"],
  );
  const r = await strategyLifecycle({ strategy_key: key, min_samples: 5 });
  assert.equal(r.projects, 1);
  assert.notEqual(r.status, "confirmed");
});

test("6. minimum sample threshold prevents promotion", async () => {
  const key = `small-${uniq()}`;
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  await core.dbQuery(
    `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
     VALUES ($1,$2,'success','observed','projX')`, [exp.id, key],
  );
  const r = await strategyLifecycle({ strategy_key: key, min_samples: 5 });
  assert.equal(r.samples, 1);
  assert.equal(r.status, "proposed");
});

test("7. confirmation requires explicit approval and cross-project evidence", async () => {
  const key = `conf-${uniq()}`;
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  for (let i = 0; i < 12; i++) {
    await core.dbQuery(
      `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
       VALUES ($1,$2,'success','observed',$3)`, [exp.id, key, i % 2 ? "projA" : "projB"],
    );
  }
  const without = await strategyLifecycle({ strategy_key: key, min_samples: 5, approval: false });
  assert.notEqual(without.status, "confirmed");
  const withApproval = await strategyLifecycle({ strategy_key: key, min_samples: 5, approval: true });
  assert.equal(withApproval.status, "confirmed");
  assert.equal(withApproval.auto_confirmed, false);
});

test("8. no fabricated improvements", async () => {
  const r = await selfImprovementReport({});
  assert.match(r.claim, /no improvement claimed/);
  const n = (await core.dbQuery("SELECT count(*)::int n FROM strategy_experiment WHERE outcome_confirmed")).rows[0].n;
  assert.equal(n, 0);
});

test("9. regression detection downgrades a strategy", async () => {
  const key = `reg-${uniq()}`;
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  for (let i = 0; i < 6; i++) {
    await core.dbQuery(
      `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id)
       VALUES ($1,$2,'failure','observed','projR')`, [exp.id, key],
    );
  }
  const r = await strategyLifecycle({ strategy_key: key, min_samples: 5 });
  assert.equal(r.status, "rejected");
});

test("10. improvement records persist and are queryable", async () => {
  const p = `persist-${uniq()}`;
  await selfImprovementReport({ project_id: p });
  const rows = (await core.dbQuery("SELECT summary FROM self_improvement_report WHERE project_id=$1 ORDER BY id DESC", [p])).rows;
  assert.ok(rows.length >= 1);
  const outcomes = await getOutcomes({ project_id: p });
  assert.ok(Array.isArray(outcomes.outcomes));
});

test("close", async () => { await core.close(); });
