// Phase 23 workstream — integration, security, isolation and recovery tests for
// the proactive project-intelligence layer.
//
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), HARNESS_SEMANTIC_LLM=0.
// Unique project ids; no fixture row is deleted. Sibling modules are loaded with
// dynamic imports and t.skip guards so a module that is not written yet skips
// only the affected assertions. core.close() is called AT MOST once, in the
// FINAL test, and nothing runs after it.
//
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase23-security.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

const RUN = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const projectA = `p23sec-a-${RUN}`;
const projectB = `p23sec-b-${RUN}`;
const downProject = `p23sec-down-${RUN}`;

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

// Remove comments so "never exec/spawn" documentation cannot trip a static check.
const stripComments = (s) => String(s || "")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const firstArray = (obj, keys) => {
  for (const k of keys) if (Array.isArray(obj?.[k])) return obj[k];
  return [];
};
const blobOf = (v) => typeof v === "string" ? v : JSON.stringify(v ?? {});
// Affirmative certainty claims only. A field literally named `certainty_claim`
// with value "none", or a disclaimer saying "not certainties", is good practice
// and must not trip this check.
const CERTAINTY_RE = /certainly|definitely|guaranteed|100%|will always fail|proven cause|no doubt/i;
function assertNoCertainty(value, label) {
  assert.doesNotMatch(blobOf(value), CERTAINTY_RE, `${label} makes a certainty claim`);
}
function assertNoCanary(value, canaries, label) {
  const s = blobOf(value);
  for (const c of canaries) {
    assert.equal(s.includes(c), false, `${label} leaked ${c.slice(0, 16)}...`);
  }
}

const fx = {};

test.before(async () => {
  const core = await load("core");
  if (!core) throw new Error("core module unavailable; cannot run Phase 23 security tests");

  // Additive, idempotent schema guards (no-ops once migration 021 is applied).
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_assessment (
      id uuid PRIMARY KEY, project_id text NOT NULL, component text NOT NULL DEFAULT '_project',
      dimensions jsonb NOT NULL DEFAULT '{}'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      unknown_areas jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_finding (
      id uuid PRIMARY KEY, project_id text NOT NULL, component text NOT NULL DEFAULT '',
      category text NOT NULL, description text NOT NULL DEFAULT '',
      detection_method text NOT NULL DEFAULT 'deterministic', evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0, severity text NOT NULL DEFAULT 'low',
      impact text NOT NULL DEFAULT '', remediation text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'new', first_detected timestamptz NOT NULL DEFAULT now(),
      last_observed timestamptz NOT NULL DEFAULT now(), resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (project_id, component, category, description))`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_prediction (
      id uuid PRIMARY KEY, project_id text NOT NULL, component text NOT NULL DEFAULT '',
      risk_category text NOT NULL, signals jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, confidence real NOT NULL DEFAULT 0,
      severity text NOT NULL DEFAULT 'low', impact text NOT NULL DEFAULT '',
      preventive_action text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'observed',
      review_status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS engineering_recommendation (
      id uuid PRIMARY KEY, project_id text NOT NULL, category text NOT NULL,
      description text NOT NULL DEFAULT '', finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      learning_refs jsonb NOT NULL DEFAULT '[]'::jsonb, priority text NOT NULL DEFAULT 'medium',
      expected_benefit text NOT NULL DEFAULT '', effort text NOT NULL DEFAULT 'unknown',
      confidence real NOT NULL DEFAULT 0, steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      dependencies jsonb NOT NULL DEFAULT '[]'::jsonb, change_risk text NOT NULL DEFAULT 'unknown',
      status text NOT NULL DEFAULT 'proposed', decided_by text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_analysis_state (
      id bigserial PRIMARY KEY, project_id text NOT NULL, component text NOT NULL DEFAULT '_project',
      content_hash text NOT NULL, status text NOT NULL DEFAULT 'pending',
      result jsonb NOT NULL DEFAULT '{}'::jsonb, error text, attempts integer NOT NULL DEFAULT 1,
      analyzed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, component, content_hash))`);

  fx.comp = `p23sec-comp-${RUN}`;
  fx.archiveComp = `p23sec-archive-${RUN}`;
  fx.aCanary = `P23SEC_A_${RUN}`;
  fx.bCanary = `P23SEC_B_ONLY_${RUN}`;
  fx.archivedCanary = `P23SEC_ARCHIVED_${RUN}`;
  fx.supersededCanary = `P23SEC_SUPERSEDED_${RUN}`;

  fx.assessmentA = crypto.randomUUID();
  fx.assessmentB = crypto.randomUUID();
  fx.assessmentArchived = crypto.randomUUID();
  fx.assessmentCurrent = crypto.randomUUID();
  fx.findingA = crypto.randomUUID();
  fx.findingB = crypto.randomUUID();
  fx.findingResolved = crypto.randomUUID();
  fx.predictionA = crypto.randomUUID();
  fx.predictionB = crypto.randomUUID();
  fx.predictionSuperseded = crypto.randomUUID();
  fx.recommendationA = crypto.randomUUID();
  fx.recommendationB = crypto.randomUUID();
  fx.recommendationSuperseded = crypto.randomUUID();

  // Current, project-scoped assessment rows (A and B) used by test 1.
  await core.dbQuery(
    `INSERT INTO project_assessment (id,project_id,component,dimensions,evidence,unknown_areas,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,now(),now()) ON CONFLICT DO NOTHING`,
    [fx.assessmentA, projectA, fx.comp, JSON.stringify({ maintainability: "stable" }),
      JSON.stringify([{ marker: "positive", detail: fx.aCanary }]), JSON.stringify(["reliability"]), "active"]);
  await core.dbQuery(
    `INSERT INTO project_assessment (id,project_id,component,dimensions,evidence,unknown_areas,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,now(),now()) ON CONFLICT DO NOTHING`,
    [fx.assessmentB, projectB, fx.comp, JSON.stringify({ maintainability: "stable" }),
      JSON.stringify([{ marker: "positive", detail: fx.bCanary }]), JSON.stringify(["reliability"]), "active"]);

  // Archived (old) and current (new) assessments for the same component: the
  // current one must be the ordinary "assessment", the archived one only in history.
  await core.dbQuery(
    `INSERT INTO project_assessment (id,project_id,component,dimensions,evidence,unknown_areas,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,now() - interval '2 days',now() - interval '2 days')
     ON CONFLICT DO NOTHING`,
    [fx.assessmentArchived, projectA, fx.archiveComp, JSON.stringify({ maintainability: "at_risk" }),
      JSON.stringify([{ marker: "negative", detail: fx.archivedCanary }]), JSON.stringify([]), "archived"]);
  await core.dbQuery(
    `INSERT INTO project_assessment (id,project_id,component,dimensions,evidence,unknown_areas,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,now(),now()) ON CONFLICT DO NOTHING`,
    [fx.assessmentCurrent, projectA, fx.archiveComp, JSON.stringify({ maintainability: "stable" }),
      JSON.stringify([{ marker: "positive", detail: "current" }]), JSON.stringify([]), "active"]);

  const findingInsert = `
    INSERT INTO project_finding (id,project_id,component,category,description,detection_method,evidence,
      confidence,severity,impact,remediation,status,first_detected,last_observed,resolution)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,now(),now(),'{}'::jsonb)
    ON CONFLICT DO NOTHING`;
  await core.dbQuery(findingInsert, [fx.findingA, projectA, fx.comp, "repeated_workaround",
    `A finding ${fx.aCanary}`, "deterministic", JSON.stringify([{ marker: "workaround", detail: fx.aCanary }]),
    0.6, "medium", "impact", "remediation", "new"]);
  await core.dbQuery(findingInsert, [fx.findingB, projectB, fx.comp, "repeated_workaround",
    `B finding ${fx.bCanary}`, "deterministic", JSON.stringify([{ marker: "workaround", detail: fx.bCanary }]),
    0.6, "medium", "impact", "remediation", "new"]);
  await core.dbQuery(findingInsert, [fx.findingResolved, projectA, fx.archiveComp, "missing_error_handling",
    `resolved ${fx.archivedCanary}`, "deterministic",
    JSON.stringify([{ marker: "missing_error_handling", detail: fx.archivedCanary }]),
    0.5, "medium", "impact", "remediation", "resolved"]);

  const predictionInsert = `
    INSERT INTO project_prediction (id,project_id,component,risk_category,signals,evidence,confidence,
      severity,impact,preventive_action,status,review_status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,now(),now())
    ON CONFLICT DO NOTHING`;
  await core.dbQuery(predictionInsert, [fx.predictionA, projectA, fx.comp, "missing_tests",
    JSON.stringify([{ source: "marker", detail: fx.aCanary }]),
    JSON.stringify([{ marker: "missing_tests", detail: fx.aCanary }]),
    0.4, "medium", "impact", "add tests", "observed", "pending"]);
  await core.dbQuery(predictionInsert, [fx.predictionB, projectB, fx.comp, "missing_tests",
    JSON.stringify([{ source: "marker", detail: fx.bCanary }]),
    JSON.stringify([{ marker: "missing_tests", detail: fx.bCanary }]),
    0.4, "medium", "impact", "add tests", "observed", "pending"]);
  await core.dbQuery(predictionInsert, [fx.predictionSuperseded, projectA, fx.archiveComp,
    "dependency_concentration", JSON.stringify([{ source: "marker", detail: fx.supersededCanary }]),
    JSON.stringify([{ marker: "dependency_concentration", detail: fx.supersededCanary }]),
    0.45, "high", "impact", "pin dependency", "superseded", "dismissed"]);

  const recInsert = `
    INSERT INTO engineering_recommendation (id,project_id,category,description,finding_ids,learning_refs,
      priority,expected_benefit,effort,confidence,steps,dependencies,change_risk,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,now(),now())
    ON CONFLICT DO NOTHING`;
  await core.dbQuery(recInsert, [fx.recommendationA, projectA, "debt",
    `A recommendation ${fx.aCanary}`, JSON.stringify([]), JSON.stringify([]), "medium",
    "lower maintenance cost", "unknown", 0.6, JSON.stringify(["step"]), JSON.stringify([]),
    "unknown", "proposed"]);
  await core.dbQuery(recInsert, [fx.recommendationB, projectB, "debt",
    `B recommendation ${fx.bCanary}`, JSON.stringify([]), JSON.stringify([]), "medium",
    "lower maintenance cost", "unknown", 0.6, JSON.stringify(["step"]), JSON.stringify([]),
    "unknown", "proposed"]);
  await core.dbQuery(recInsert, [fx.recommendationSuperseded, projectA, "debt",
    `superseded ${fx.supersededCanary}`, JSON.stringify([]), JSON.stringify([]), "medium",
    "old benefit", "unknown", 0.6, JSON.stringify(["old step"]), JSON.stringify([]),
    "unknown", "superseded"]);

  // Credential-shaped canaries: recognized by core.redact, so write paths and
  // every read/report/audit path must strip them.
  fx.skCanary = `sk-${"a".repeat(32)}`;
  fx.bearerCanary = `Bearer sk-${"b".repeat(32)}`;
  fx.awsCanary = `AKIA${"C".repeat(16)}`;
  fx.canaries = [fx.skCanary, fx.bearerCanary, fx.awsCanary];
  fx.secretMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "phase23 secret holder", content: fx.canaries.join(" "),
    source_kind: "observed", noEmbed: true });

  fx.countTable = async (table) => (await core.dbQuery(
    `SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n || 0;
});

// ---------------------------------------------------------------------------
// 1. Project A cannot see or modify Project B's intelligence artifacts.
// ---------------------------------------------------------------------------
test("1. Project A cannot see or modify Project B assessments, findings, predictions or recommendations", async (t) => {
  const core = await load("core");
  const health = await load("projectHealth");
  const debt = await load("technicalDebt");
  const risk = await load("projectRisk");
  const facade = await load("projectIntelligence");
  const rec = await load("recommendationEngine");
  if (!core) return t.skip("core module unavailable");

  const bIds = [fx.assessmentB, fx.findingB, fx.predictionB, fx.recommendationB];
  const assertNoB = (value, label) => {
    const s = blobOf(value);
    assert.equal(s.includes(fx.bCanary), false, `${label} leaked project B's canary`);
    for (const id of bIds) {
      assert.equal(s.includes(id), false, `${label} leaked project B's row id`);
    }
  };

  // Direct DB reads/writes stay project-scoped regardless of module behaviour.
  const tables = [
    ["project_assessment", fx.assessmentB],
    ["project_finding", fx.findingB],
    ["project_prediction", fx.predictionB],
    ["engineering_recommendation", fx.recommendationB],
  ];
  for (const [table, id] of tables) {
    const rows = await core.dbQuery(`SELECT id FROM ${table} WHERE project_id=$1`, [projectA]);
    assert.equal(rows.rows.some((r) => r.id === id), false, `A must not list B's row in ${table}`);
    const upd = await core.dbQuery(
      `UPDATE ${table} SET status='hijacked' WHERE id=$1 AND project_id=$2`, [id, projectA]);
    assert.equal(upd.rowCount, 0, `A must not update B's row in ${table}`);
  }
  const bFinding = (await core.dbQuery(
    "SELECT status FROM project_finding WHERE id=$1", [fx.findingB])).rows[0];
  assert.equal(bFinding.status, "new", "B's finding status is unchanged");

  // Module reads.
  if (health?.getAssessment) assertNoB(await health.getAssessment({ project_id: projectA, limit: 200 }), "health.getAssessment");
  if (health?.getHealthHistory) assertNoB(await health.getHealthHistory({ project_id: projectA, limit: 200 }), "health.getHealthHistory");
  if (debt?.getFindings) assertNoB(await debt.getFindings({ project_id: projectA, limit: 200 }), "debt.getFindings");
  if (risk?.getPredictions) assertNoB(await risk.getPredictions({ project_id: projectA, limit: 200 }), "risk.getPredictions");
  if (facade?.projectReport) assertNoB(await facade.projectReport({ project_id: projectA, report_type: "all", limit: 200 }), "facade.projectReport");
  if (rec) {
    for (const fn of ["listRecommendations", "getRecommendations"]) {
      if (typeof rec[fn] === "function") {
        assertNoB(await rec[fn]({ project_id: projectA, limit: 200 }), `recommendationEngine.${fn}`);
      }
    }
  }

  // Module writes: an id belonging to B must be rejected, and B's rows unchanged.
  if (health?.recordAssessment) {
    const r = await health.recordAssessment({ project_id: projectA, component: fx.comp,
      dimensions: { maintainability: "healthy" }, id: fx.assessmentB });
    assert.equal(r.ok === true, false, "A must not re-record B's assessment id");
  }
  if (debt?.updateFindingStatus) {
    const r = await debt.updateFindingStatus({ id: fx.findingB, project_id: projectA, status: "resolved" });
    assert.equal(r.changed === true, false, "A must not resolve B's finding");
  }
  if (risk?.reviewPrediction) {
    const r = await risk.reviewPrediction({ id: fx.predictionB, project_id: projectA, review_status: "confirmed" });
    assert.equal(r.changed === true, false, "A must not review B's prediction");
  }
  if (rec) {
    for (const fn of ["updateRecommendationStatus", "decideRecommendation"]) {
      if (typeof rec[fn] === "function") {
        try {
          await rec[fn]({ project_id: projectA, id: fx.recommendationB,
            recommendation_id: fx.recommendationB, status: "accepted" });
        } catch { /* fail closed is fine */ }
      }
    }
  }
  const after = (await core.dbQuery(
    "SELECT status, review_status FROM project_prediction WHERE id=$1", [fx.predictionB])).rows[0];
  assert.equal(after.review_status, "pending", "B's prediction review is unchanged");
});

// ---------------------------------------------------------------------------
// 2. Archived/superseded knowledge is excluded from ordinary views but kept in history.
// ---------------------------------------------------------------------------
test("2. Archived/superseded knowledge is excluded from ordinary views but preserved in history", async (t) => {
  const core = await load("core");
  const health = await load("projectHealth");
  const debt = await load("technicalDebt");
  const risk = await load("projectRisk");
  const rec = await load("recommendationEngine");
  if (!core || !health || !debt || !risk) return t.skip("core phase-23 modules not yet available");

  // Superseded assessment: the "current" assessment is the newer active row;
  // the archived row must still be reachable through the history read.
  const current = await health.getAssessment({ project_id: projectA, component: fx.archiveComp, limit: 200 });
  assert.equal(current.assessment?.id, fx.assessmentCurrent, "ordinary assessment must be the active/newest row");
  // The single `assessment` is the ordinary/current view; the `assessments`
  // array is the history view checked below.
  assertNoCanary(current.assessment, [fx.archivedCanary], "current assessment");
  const history = await health.getHealthHistory({ project_id: projectA, component: fx.archiveComp, limit: 200 });
  const historyIds = firstArray(history, ["assessments"]).map((a) => a.id);
  assert.ok(historyIds.includes(fx.assessmentArchived), "archived assessment must be preserved in history");
  assert.ok(historyIds.includes(fx.assessmentCurrent), "current assessment must also be in history");

  // Resolved finding: an active-status read excludes it, but the row is retained.
  const activeFindings = await debt.getFindings({ project_id: projectA, status: "new", limit: 200 });
  assert.equal(firstArray(activeFindings, ["findings"]).some((f) => f.id === fx.findingResolved), false,
    "a resolved finding must not appear in an active-findings view");
  const preservedFinding = (await core.dbQuery(
    "SELECT id,status,resolution FROM project_finding WHERE id=$1", [fx.findingResolved])).rows[0];
  assert.equal(preservedFinding.id, fx.findingResolved, "resolved finding must not be deleted");
  assert.equal(preservedFinding.status, "resolved", "resolved finding must keep its lifecycle status");

  // Superseded prediction: an active-status read excludes it; review history stays.
  const activePredictions = await risk.getPredictions({ project_id: projectA, status: "observed", limit: 200 });
  assert.equal(firstArray(activePredictions, ["predictions"]).some((p) => p.id === fx.predictionSuperseded), false,
    "a superseded prediction must not appear in an active-predictions view");
  const preservedPrediction = (await core.dbQuery(
    "SELECT id,status,review_status FROM project_prediction WHERE id=$1", [fx.predictionSuperseded])).rows[0];
  assert.equal(preservedPrediction.status, "superseded", "superseded prediction is preserved");
  assert.equal(preservedPrediction.review_status, "dismissed", "review history is preserved");
  assertNoCanary(activePredictions, [fx.supersededCanary], "active predictions view");

  // Superseded recommendation: excluded from an active list, retained in the table.
  if (rec) {
    for (const fn of ["listRecommendations", "getRecommendations"]) {
      if (typeof rec[fn] === "function") {
        const list = await rec[fn]({ project_id: projectA, status: "proposed", limit: 200 });
        assert.equal(firstArray(list, ["recommendations", "items"]).some((r) => r.id === fx.recommendationSuperseded), false,
          `${fn} must not return a superseded recommendation in an active view`);
      }
    }
  }
  const preservedRec = (await core.dbQuery(
    "SELECT id,status FROM engineering_recommendation WHERE id=$1", [fx.recommendationSuperseded])).rows[0];
  assert.equal(preservedRec.status, "superseded", "superseded recommendation is preserved, not deleted");
});

// ---------------------------------------------------------------------------
// 3. Secret canaries are absent from findings, recommendations, reports and audits.
// ---------------------------------------------------------------------------
test("3. sk-/Bearer/AKIA canaries never appear in findings, recommendations, reports or audits", async (t) => {
  const core = await load("core");
  const health = await load("projectHealth");
  const debt = await load("technicalDebt");
  const risk = await load("projectRisk");
  const facade = await load("projectIntelligence");
  const rec = await load("recommendationEngine");
  if (!core) return t.skip("core module unavailable");
  const canaries = fx.canaries;
  const clean = (value, label) => assertNoCanary(value, canaries, label);

  assert.doesNotMatch(core.redact(`key ${fx.skCanary}`), /sk-aaa/);
  assert.doesNotMatch(core.redact(`key ${fx.awsCanary}`), /AKIACCC/);
  clean((await core.getMemory(fx.secretMem.id)).content, "stored memory");

  // Persist redacted artifacts through the real write paths.
  if (health?.recordAssessment) {
    const r = await health.recordAssessment({ project_id: projectA, component: fx.comp,
      dimensions: { maintainability: "stable" },
      evidence: [{ marker: "positive", detail: `token ${fx.skCanary} ${fx.awsCanary}` }] });
    clean(r, "recordAssessment result");
  }
  if (debt?.recordFinding) {
    const r = await debt.recordFinding({ project_id: projectA, component: fx.comp,
      category: "repeated_workaround",
      description: `probe ${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}`,
      evidence: [{ marker: "workaround", detail: fx.skCanary }] });
    clean(r, "recordFinding result");
  }
  if (risk?.recordPrediction) {
    const r = await risk.recordPrediction({ project_id: projectA, component: fx.comp,
      risk_category: "missing_tests", impact: `impact ${fx.skCanary}`,
      preventive_action: `use ${fx.bearerCanary}`, evidence: [{ marker: "missing_tests", detail: fx.awsCanary }] });
    clean(r, "recordPrediction result");
  }
  if (rec) {
    for (const fn of ["buildRecommendations", "recordRecommendation"]) {
      if (typeof rec[fn] === "function") {
        try {
          const r = await rec[fn]({ project_id: projectA,
            findings: [{ description: `probe ${fx.skCanary} ${fx.awsCanary}`, category: "repeated_workaround" }],
            description: `probe ${fx.skCanary}`, limit: 5 });
          clean(r, `recommendationEngine.${fn} result`);
        } catch { /* optional path */ }
      }
    }
  }

  // Every ordinary read and report path must be clean.
  if (health?.getAssessment) clean(await health.getAssessment({ project_id: projectA, limit: 200 }), "assessment read");
  if (debt?.getFindings) clean(await debt.getFindings({ project_id: projectA, limit: 200 }), "findings read");
  if (risk?.getPredictions) clean(await risk.getPredictions({ project_id: projectA, limit: 200 }), "predictions read");
  if (facade?.projectReport) clean(await facade.projectReport({ project_id: projectA, report_type: "all", limit: 200 }), "unified report");
  if (facade?.analyzeProject) {
    const r = await facade.analyzeProject({ project_id: projectA, components: [fx.comp],
      evidence: { [fx.comp]: [{ marker: "positive", detail: fx.skCanary }] } });
    clean(r, "analysis result");
  }

  for (const table of ["project_assessment", "project_finding", "project_prediction", "engineering_recommendation"]) {
    const { rows } = await core.dbQuery(`SELECT * FROM ${table} WHERE project_id=$1 LIMIT 200`, [projectA]);
    clean(rows, `${table} rows`);
  }
  const auditRows = await core.dbQuery(
    "SELECT * FROM audit_log WHERE resource LIKE $1 OR detail::text LIKE $1 LIMIT 200", [`%${RUN}%`]);
  clean(auditRows.rows, "audit_log");
  const intelRows = await core.dbQuery(
    "SELECT * FROM intelligence_audit_events WHERE resource LIKE $1 OR detail::text LIKE $1 LIMIT 200", [`%${RUN}%`]);
  clean(intelRows.rows, "intelligence_audit_events");
});

// ---------------------------------------------------------------------------
// 4. No automatic code changes: only static analysis / recommendation tooling.
// ---------------------------------------------------------------------------
test("4. Intelligence modules never call exec/spawn or write source files (static source check)", async (t) => {
  const required = ["recommendationEngine", "engineeringRoadmap"];
  if (!allSourcesPresent(required)) return t.skip("recommendation/roadmap sources not yet available");

  const names = ["recommendationEngine", "engineeringRoadmap", "projectIntelligence",
    "projectHealth", "technicalDebt", "projectRisk",
    "testQuality", "dependencyRisk"].filter((n) => fs.existsSync(srcFile(n)));
  for (const name of names) {
    const raw = readSource(name);
    if (!raw) continue;
    const src = stripComments(raw);
    assert.doesNotMatch(src, /node:child_process|require\(\s*["']child_process["']\s*\)|from\s+["']child_process["']/,
      `${name} must not import child_process`);
    assert.doesNotMatch(src, /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/,
      `${name} must not call exec/spawn`);
    assert.doesNotMatch(src, /\bshell\s*:\s*true/, `${name} must not enable a shell`);
    assert.doesNotMatch(src,
      /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|unlinkSync|unlink|rmSync|rm|renameSync|rename|copyFileSync|copyFile|truncateSync|truncate)\s*\(/,
      `${name} must not write/delete source files`);
  }
});

// ---------------------------------------------------------------------------
// 5. Unknown/insufficient evidence stays unknown; no invented numbers or certainty.
// ---------------------------------------------------------------------------
test("5. Unknown evidence stays unknown; no fake coverage, invented vulnerabilities or certainty", async (t) => {
  const facade = await load("projectIntelligence");
  const health = await load("projectHealth");
  const debt = await load("technicalDebt");
  const risk = await load("projectRisk");
  const tq = await load("testQuality");
  const deps = await load("dependencyRisk");
  if (!health || !debt || !risk) return t.skip("core analysis modules not yet available");

  // Health: all dimensions unknown with no evidence.
  const h = health.analyzeProjectHealth({ project_id: projectA, components: [fx.comp], evidence: {} });
  assert.equal(h.ok, true);
  assert.deepEqual(h.assessments[0].dimensions, Object.fromEntries(
    health.SCORING_RULES.dimensions.map((d) => [d, "unknown"])));
  assert.deepEqual(h.assessments[0].unknown_areas.sort(), [...health.SCORING_RULES.dimensions].sort());
  assert.equal(blobOf(h).includes("healthy"), false, "no dimension may default to healthy");
  assertNoCertainty(h, "health analysis");

  // Debt: no evidence -> no findings; explicit evidence -> bounded confidence.
  const emptyDebt = debt.detectDebt({ project_id: projectA, components: [fx.comp], evidence: {} });
  assert.equal(emptyDebt.ok, true);
  assert.deepEqual(emptyDebt.findings, [], "unusual-looking code alone is never debt");
  const oneDebt = debt.detectDebt({ project_id: projectA, components: [fx.comp],
    evidence: { [fx.comp]: [{ marker: "workaround", detail: "explicit marker" }] } });
  assert.ok(oneDebt.findings.length >= 1);
  assert.ok(oneDebt.findings.every((f) => f.confidence < 1 && f.confidence > 0),
    "confidence is bounded and never certainty");
  assertNoCertainty(oneDebt, "debt findings");

  // Risk: sparse history -> explicit insufficient_evidence, capped confidence.
  const sparse = risk.predictFragility({ project_id: projectA, findings: [], history: [], evidence: {} });
  assert.equal(sparse.ok, true);
  assert.equal(sparse.insufficient_evidence, true);
  assert.ok(sparse.predictions.some((p) => p.risk_category === "insufficient_evidence"));
  assert.ok(sparse.predictions.every((p) => p.confidence <= 1 && p.certainty_claim === "none"));
  assertNoCertainty(sparse, "risk predictions");

  // Test quality / dependency risk: no invented coverage percentages or CVEs.
  if (tq?.analyzeTestQuality) {
    const r = await tq.analyzeTestQuality({ project_id: projectA, modules: [fx.comp], tests: [], history: [], evidence: {} });
    assert.equal(r?.ok !== false, true);
    assert.doesNotMatch(blobOf(r), /\b\d{1,3}(\.\d+)?\s*%\s*coverage\b/i, "no invented coverage percentage");
    assert.doesNotMatch(blobOf(r), /\bCVE-\d{4}-\d+\b/i, "no invented vulnerability id");
    assertNoCertainty(r, "test quality analysis");
  }
  if (deps?.analyzeDependencies) {
    const r = await deps.analyzeDependencies({ project_id: projectA, edges: [], evidence: {} });
    assert.equal(r?.ok !== false, true);
    assert.doesNotMatch(blobOf(r), /\bCVE-\d{4}-\d+\b/i, "no invented vulnerability id");
    assertNoCertainty(r, "dependency analysis");
  }

  // Unified report on a project with no artifacts: unknown is explicit.
  if (facade?.projectReport) {
    const r = await facade.projectReport({ project_id: downProject, limit: 50 });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.unknown_areas));
    assert.match(blobOf(r), /unknown|insufficient evidence/i);
    assertNoCertainty(r, "unified report");
  }
});

// ---------------------------------------------------------------------------
// 6. Pipeline audit returns ok with all wiring checks present.
// ---------------------------------------------------------------------------
test("6. Pipeline audit returns ok with all wiring checks present", async (t) => {
  const pa = await load("pipelineAudit");
  if (!pa) return t.skip("pipelineAudit module not yet available");
  const needed = ["projectIntelligence", "projectHealth", "technicalDebt", "projectRisk",
    "testQuality", "dependencyRisk", "recommendationEngine", "engineeringRoadmap"];
  if (!allSourcesPresent(needed)) return t.skip("sibling Phase 23 source files not yet available");
  const a = pa.auditPipelineIntegrity();
  assert.equal(a.ok, true, `missing checks: ${(a.missing || []).join(", ")}`);
  assert.ok(a.summary.total > 0);
  assert.equal(a.summary.missing, 0);
  assert.equal(a.checks.length, a.summary.total);
  assert.equal(a.checks.filter((c) => c.ok === true && c.present === true && c.missing === false).length,
    a.checks.length, "every check is present");
  assert.deepEqual(a.missing, []);
  for (const id of ["p23.facade", "p23.health", "p23.debt-risk", "p23.prediction",
    "p23.quality-deps", "p23.recommendations", "p23.cli-integration", "p23.mcp-integration"]) {
    assert.ok(a.present.includes(id), `expected p23 wiring check ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Bounded listing / status functions respect their limits.
// ---------------------------------------------------------------------------
test("7. Bounded listing and status functions respect their limits", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const authz = await load("memoryAuthorization");
  const health = await load("projectHealth");
  const debt = await load("technicalDebt");
  const risk = await load("projectRisk");
  const rec = await load("recommendationEngine");
  const facade = await load("projectIntelligence");
  if (!core || !scope) return t.skip("core modules not yet available");

  const bounded = (r, keys, limit, label) => {
    assert.ok(!r || r.ok !== false, `${label} unexpectedly failed: ${r?.reason || ""}`);
    const arr = firstArray(r, keys);
    assert.ok(arr.length <= limit, `${label} returned ${arr.length} items, limit ${limit}`);
  };

  bounded(await scope.globalMisclassificationReport({ limit: 2 }), ["items"], 2, "globalMisclassificationReport");
  if (authz) bounded(await authz.securityAuditReport({ project_id: projectA, limit: 2 }), ["items"], 2, "securityAuditReport");
  assert.ok((await core.listMemories({ project_id: projectA, limit: 2 })).length <= 2);

  if (health) {
    bounded(await health.getAssessment({ project_id: projectA, limit: 2 }), ["assessments"], 2, "getAssessment");
    bounded(await health.getHealthHistory({ project_id: projectA, limit: 2 }), ["assessments"], 2, "getHealthHistory");
  }
  if (debt) bounded(await debt.getFindings({ project_id: projectA, limit: 2 }), ["findings"], 2, "getFindings");
  if (risk) bounded(await risk.getPredictions({ project_id: projectA, limit: 2 }), ["predictions"], 2, "getPredictions");
  if (rec) {
    for (const fn of ["listRecommendations", "getRecommendations"]) {
      if (typeof rec[fn] === "function") {
        bounded(await rec[fn]({ project_id: projectA, limit: 2 }), ["recommendations", "items"], 2, fn);
      }
    }
  }
  if (facade) {
    bounded(await facade.analysisStatus({ project_id: projectA, limit: 2 }), ["items"], 2, "analysisStatus");
    const report = await facade.projectReport({ project_id: projectA, limit: 2 });
    for (const key of ["assessments", "findings", "predictions", "recommendations"]) {
      assert.ok(Array.isArray(report[key]) && report[key].length <= 2, `${key} exceeded limit 2`);
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Incremental analysis idempotency and recovery via the parent facade.
// ---------------------------------------------------------------------------
test("8. Incremental analysis is idempotent and recoverable via projectIntelligence", async (t) => {
  const core = await load("core");
  const facade = await load("projectIntelligence");
  if (!core || !facade?.analyzeProject) return t.skip("projectIntelligence facade not yet available");

  const component = `p23sec-inc-${RUN}`;
  const evidence = { [component]: [{ marker: "positive", detail: "explicit evidence" }] };
  const first = await facade.analyzeProject({ project_id: projectA, components: [component], evidence });
  assert.equal(first.ok, true, `analyzeProject failed: ${first.reason || ""}`);
  assert.ok(first.analyzed >= 1, "first run must analyze the component");

  const stateOf = async () => (await core.dbQuery(
    "SELECT id,content_hash,status,attempts FROM project_analysis_state WHERE project_id=$1 AND component=$2",
    [projectA, component])).rows;
  const firstRows = await stateOf();
  assert.ok(firstRows.length >= 1, "an analysis ledger row must be written");
  const firstHash = firstRows[0].content_hash;

  // Identical input is skipped; no duplicate ledger row is created.
  const second = await facade.analyzeProject({ project_id: projectA, components: [component], evidence });
  assert.equal(second.ok, true);
  assert.ok(second.skipped >= 1, "an identical analysis must be skipped (idempotent)");
  const secondRows = await stateOf();
  assert.equal(secondRows.length, firstRows.length, "idempotency must not create duplicate state rows");
  assert.ok(secondRows.some((r) => r.content_hash === firstHash));

  // forced re-analysis is the recovery primitive and creates a fresh done row.
  const forced = await facade.analyzeProject({ project_id: projectA, components: [component], evidence, force: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.analyzed >= 1, "forced analysis must re-run");

  // Recovery: mark our state failed and exercise the facade's retry path.
  await core.dbQuery(
    "UPDATE project_analysis_state SET status='failed' WHERE project_id=$1 AND component=$2",
    [projectA, component]);
  const retry = await facade.retryAnalysis ? await facade.retryAnalysis({ limit: 100 }) : null;
  if (retry) {
    assert.equal(retry.ok, true);
    assert.ok(retry.retried >= 1, "retryAnalysis must retry at least one failed/pending row");
  }
  const rerun = await facade.analyzeProject({ project_id: projectA, components: [component], evidence, force: true });
  assert.equal(rerun.ok, true, "recovery re-analysis must succeed");
  const done = await facade.analysisStatus ? await facade.analysisStatus({ project_id: projectA, status: "done", limit: 200 }) : null;
  if (done) {
    assert.ok(firstArray(done, ["items"]).some((r) => r.component === component),
      "a done state row must exist for the recovered component");
  }
});

// ---------------------------------------------------------------------------
// 9. FINAL: single core.close(), graceful DB-down degradation. Nothing after.
// ---------------------------------------------------------------------------
test("9. FINAL: unified report degrades gracefully when the database is down", async () => {
  const core = await load("core");
  const facade = await load("projectIntelligence");
  await core.close(); // the ONLY close() call in this file

  assert.ok(facade?.projectReport, "projectIntelligence facade must be available");
  const r = await facade.projectReport({ project_id: downProject, report_type: "all", limit: 5 });
  assert.equal(r.ok, true, "reporting must never block a request when the DB is down");
  for (const key of ["assessments", "findings", "predictions", "recommendations", "unknown_areas"]) {
    assert.ok(Array.isArray(r[key]), `${key} must degrade to an empty array, not throw`);
  }
  assert.match(blobOf(r), /unknown|insufficient evidence/i);
  assertNoCertainty(r, "DB-down report");
});
