import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { strategyLifecycle, strategyValidationReport } from "../src/learning10.js";

const uniq = () => `p13d-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

async function makeVersion(key, min = 3) {
  await core.dbQuery(
    `INSERT INTO strategy_versions (strategy_key,version,definition,lifecycle_status,min_samples)
     VALUES ($1,1,'{}'::jsonb,'proposed',$2) ON CONFLICT DO NOTHING`, [key, min]);
}
async function addResult(key, outcome, project, daysAgo = 0) {
  const exp = (await core.dbQuery("SELECT id FROM strategy_experiment LIMIT 1")).rows[0];
  await core.dbQuery(
    `INSERT INTO strategy_experiment_results (experiment_id,strategy_key,outcome,measurement,project_id,created_at)
     VALUES ($1,$2,$3,'observed',$4,now() - ($5::int || ' days')::interval)`, [exp.id, key, outcome, project, daysAgo]);
}

test("1. strategy cannot be confirmed without approval and cross-project evidence", async () => {
  const key = `no-${uniq()}`;
  await makeVersion(key, 3);
  for (let i = 0; i < 8; i++) await addResult(key, "success", "projA");
  const r = await strategyLifecycle({ strategy_key: key, min_samples: 3, approval: false });
  assert.notEqual(r.status, "confirmed");
  assert.equal(r.auto_confirmed, false);
});

test("2. regressed state is recorded after recent failures", async () => {
  const key = `reg-${uniq()}`;
  await makeVersion(key, 3);
  for (let i = 0; i < 6; i++) await addResult(key, "success", "projA", 60);
  let r = await strategyLifecycle({ strategy_key: key, min_samples: 3 });
  assert.equal(r.status, "supported");
  for (let i = 0; i < 4; i++) await addResult(key, "failure", "projA", 0);
  r = await strategyLifecycle({ strategy_key: key, min_samples: 3 });
  assert.equal(r.status, "regressed");
  const v = (await core.dbQuery("SELECT regressed_at,regression_reason FROM strategy_versions WHERE strategy_key=$1", [key])).rows[0];
  assert.ok(v.regressed_at);
  assert.match(v.regression_reason, /failure rate/);
});

test("3. insufficient evidence is reported separately from measured evidence", async () => {
  const key = `ins-${uniq()}`;
  await makeVersion(key, 5);
  await addResult(key, "success", "projA");
  const rep = await strategyValidationReport({});
  const row = rep.strategies.find((s) => s.strategy_key === key);
  assert.ok(row);
  assert.equal(row.observed_samples, 1);
  assert.equal(row.claim, "insufficient observed evidence");
});

test("4. validation report counts effective, regressed and insufficient strategies", async () => {
  const rep = await strategyValidationReport({});
  assert.ok(rep.summary.effective >= 0);
  assert.ok(rep.summary.regressed >= 1);
  assert.ok(rep.summary.insufficient >= 1);
});

test("5. project-scoped validation does not mix unrelated projects", async () => {
  const key = `proj-${uniq()}`;
  await makeVersion(key, 2);
  await addResult(key, "success", "projX");
  await addResult(key, "failure", "projY");
  const scoped = await strategyValidationReport({ project_id: "projX" });
  const row = scoped.strategies.find((s) => s.strategy_key === key);
  assert.ok(row);
  assert.ok(row.observed_samples <= 1);
});

test("close", async () => { await core.close(); });
