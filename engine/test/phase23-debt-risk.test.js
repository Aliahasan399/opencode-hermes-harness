// Phase 23 features B + C — technical debt detection + conservative risk prediction.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network,
// unique project ids per test, no destructive SQL assertions.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase23-debt-risk.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const debt = await import("../src/technicalDebt.js");
const risk = await import("../src/projectRisk.js");

const {
  DEBT_RULES, FINDING_STATUSES, detectDebt, recordFinding, updateFindingStatus, getFindings,
} = debt;
const {
  RISK_RULES, EVIDENCE_CLASSES, REVIEW_STATUSES, predictFragility,
  recordPrediction, getPredictions, reviewPrediction,
} = risk;

const uniq = (p = "p23") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// Idempotent schema guards: no-ops when migration 021 is already applied.
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_finding (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      component text NOT NULL DEFAULT '',
      category text NOT NULL,
      description text NOT NULL DEFAULT '',
      detection_method text NOT NULL DEFAULT 'deterministic',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0,
      severity text NOT NULL DEFAULT 'low',
      impact text NOT NULL DEFAULT '',
      remediation text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'new',
      first_detected timestamptz NOT NULL DEFAULT now(),
      last_observed timestamptz NOT NULL DEFAULT now(),
      resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (project_id, component, category, description)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS project_prediction (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      component text NOT NULL DEFAULT '',
      risk_category text NOT NULL,
      signals jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0,
      severity text NOT NULL DEFAULT 'low',
      impact text NOT NULL DEFAULT '',
      preventive_action text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'observed',
      review_status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
});

// ---------------------------------------------------------------------------
// 0. exports + frozen rule vocabulary
// ---------------------------------------------------------------------------
test("0. exact exports exist as functions and rule tables are frozen", () => {
  for (const name of ["detectDebt", "recordFinding", "updateFindingStatus", "getFindings"]) {
    assert.equal(typeof debt[name], "function", `${name} must be a function`);
  }
  for (const name of ["predictFragility", "recordPrediction", "getPredictions", "reviewPrediction"]) {
    assert.equal(typeof risk[name], "function", `${name} must be a function`);
  }
  assert.equal(typeof debt.default.detectDebt, "function");
  assert.equal(typeof risk.default.predictFragility, "function");
  for (const cat of ["repeated_workaround", "fragile_dependency", "missing_error_handling",
    "unstable_component", "duplicated_logic", "outdated_pattern"]) {
    assert.ok(DEBT_RULES[cat], `DEBT_RULES.${cat}`);
    assert.ok(DEBT_RULES[cat].severity && Number.isFinite(DEBT_RULES[cat].confidence));
  }
  assert.equal(Object.isFrozen(DEBT_RULES), true, "DEBT_RULES frozen");
  assert.equal(Object.isFrozen(DEBT_RULES.repeated_workaround), true, "nested rule frozen");
  assert.equal(Object.isFrozen(RISK_RULES), true, "RISK_RULES frozen");
  assert.deepEqual([...FINDING_STATUSES].sort(),
    ["accepted", "existing", "false_positive", "new", "reopened", "resolved"]);
  for (const c of EVIDENCE_CLASSES) assert.ok(typeof c === "string");
  assert.ok(EVIDENCE_CLASSES.includes("insufficient_evidence"));
  assert.ok(REVIEW_STATUSES.includes("pending"));
});

// ---------------------------------------------------------------------------
// 1. detection only from explicit markers; rule-driven severity/confidence
// ---------------------------------------------------------------------------
test("1. detectDebt emits deterministic findings from explicit evidence markers", () => {
  const project = uniq("p23-detect");
  const r = detectDebt({
    project_id: project,
    components: ["auth", "db", "api"],
    evidence: {
      auth: ["workaround: manual retry on login"],
      db: [{ marker: "fragile_dependency", detail: "single redis primary", component: "db", occurrences: 3 }],
      api: ["missing_error_handling: unhandled rejection in handler", { marker: "duplicated_logic", detail: "copy of parser" }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 4);
  assert.equal(typeof r.degraded, "boolean");
  const byCat = Object.fromEntries(r.findings.map((f) => [f.category, f]));
  assert.ok(byCat.repeated_workaround && byCat.fragile_dependency && byCat.missing_error_handling && byCat.duplicated_logic);
  assert.equal(byCat.repeated_workaround.severity, DEBT_RULES.repeated_workaround.severity);
  assert.equal(byCat.fragile_dependency.severity, DEBT_RULES.fragile_dependency.severity);
  assert.equal(byCat.fragile_dependency.confidence > DEBT_RULES.fragile_dependency.confidence, true, "occurrence bump");
  assert.ok(r.findings.every((f) => f.project_id === project && f.detection_method === "deterministic"));
  assert.ok(r.findings.every((f) => f.confidence < 1), "never certainty");
  assert.ok(r.findings.every((f) => f.evidence.length >= 1 && f.remediation && f.impact));
});

// ---------------------------------------------------------------------------
// 2. unusual-looking code is NOT debt
// ---------------------------------------------------------------------------
test("2. unusual-looking code without an explicit marker is not flagged", () => {
  const project = uniq("p23-unusual");
  const clean = detectDebt({ project_id: project, evidence: {} });
  assert.equal(clean.ok, true);
  assert.equal(clean.findings.length, 0);
  assert.equal(clean.degraded, false);

  const odd = detectDebt({
    project_id: project,
    components: ["mystery"],
    evidence: {
      mystery: [
        "function f(x){ return !!(x && x.y ^ ~x.z); }",
        "this module is oddly structured and looks surprising",
        "TODO: maybe revisit someday",
      ],
    },
  });
  assert.equal(odd.ok, true);
  assert.equal(odd.findings.length, 0, "no debt from code shape alone");
  assert.equal(odd.skipped, 3, "unparseable entries counted as skipped");
  assert.equal(odd.degraded, true);
});

// ---------------------------------------------------------------------------
// 3. detection is bounded and component-scoped
// ---------------------------------------------------------------------------
test("3. detection honours component scope and limit", () => {
  const project = uniq("p23-bound");
  const scoped = detectDebt({
    project_id: project,
    components: ["keep"],
    evidence: {
      keep: ["workaround: keep me"],
      drop: ["workaround: drop me"],
    },
  });
  assert.deepEqual(scoped.findings.map((f) => f.component), ["keep"]);
  assert.equal(scoped.skipped, 1, "out-of-scope marker skipped");

  const markers = Array.from({ length: 6 }, (_, i) => `workaround: item ${i}`);
  const limited = detectDebt({ project_id: project, evidence: { x: markers }, limit: 2 });
  assert.equal(limited.findings.length, 2);
  assert.equal(limited.degraded, true, "truncation degrades");
});

// ---------------------------------------------------------------------------
// 4. recordFinding dedupe / append-only history
// ---------------------------------------------------------------------------
test("4. recordFinding upserts on unique key, appends evidence, preserves status", async () => {
  const project = uniq("p23-dedupe");
  const base = { project_id: project, component: "auth", category: "repeated_workaround",
    description: "retry login three times" };
  const first = await recordFinding({ ...base, evidence: ["ev-a"] });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);

  // Set a non-default status first; a later duplicate must NOT overwrite it.
  await updateFindingStatus({ id: first.id, project_id: project, status: "accepted", evidence: ["ev-accepted"] });
  const second = await recordFinding({ ...base, evidence: ["ev-b", "ev-a"], confidence: 0.9 });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id, "same row reused");

  const rows = (await getFindings({ project_id: project })).findings;
  assert.equal(rows.length, 1, "no duplicate row created");
  const row = rows[0];
  assert.equal(row.status, "accepted", "status preserved on repeat detection");
  assert.ok(row.evidence.includes("ev-a") && row.evidence.includes("ev-b") && row.evidence.includes("ev-accepted"));
  assert.equal(row.evidence.filter((e) => e === "ev-a").length, 1, "evidence deduped");
  assert.ok(new Date(row.last_observed) >= new Date(row.first_detected));
  assert.ok(row.confidence <= 0.85, "confidence bounded on update");
});

// ---------------------------------------------------------------------------
// 5. status lifecycle; false_positive keeps the row; history preserved
// ---------------------------------------------------------------------------
test("5. finding status lifecycle preserves the row, including false_positive", async () => {
  const project = uniq("p23-status");
  const id = (await recordFinding({ project_id: project, component: "api",
    category: "missing_error_handling", description: "unhandled rejection" })).id;

  for (const status of ["existing", "reopened", "resolved", "false_positive"]) {
    const r = await updateFindingStatus({ id, project_id: project, status,
      resolution: { reason: `review ${status}` }, evidence: [`evidence-${status}`] });
    assert.equal(r.ok, true, `update to ${status}`);
    assert.equal(r.changed, true, `change to ${status}`);
  }
  const idempotent = await updateFindingStatus({ id, project_id: project, status: "false_positive" });
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.changed, false, "repeating the same status with no evidence is a no-op");

  const row = (await getFindings({ project_id: project })).findings[0];
  assert.ok(row, "false_positive row still exists (never deleted)");
  assert.equal(row.status, "false_positive");
  assert.ok(Array.isArray(row.resolution.history) && row.resolution.history.length >= 3, "history preserved");
  assert.equal(row.resolution.status, "false_positive");
  for (const s of ["existing", "reopened", "resolved", "false_positive"]) {
    assert.ok(row.evidence.includes(`evidence-${s}`));
  }
});

// ---------------------------------------------------------------------------
// 6. getFindings filters and is bounded
// ---------------------------------------------------------------------------
test("6. getFindings is filtered, bounded and project-scoped", async () => {
  const project = uniq("p23-read");
  await recordFinding({ project_id: project, component: "a", category: "outdated_pattern", description: "legacy x" });
  await recordFinding({ project_id: project, component: "b", category: "fragile_dependency", description: "single y" });
  const r = await getFindings({ project_id: project, category: "fragile_dependency", limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].category, "fragile_dependency");
  assert.ok(r.limit <= 200);
  const none = await getFindings({ project_id: uniq("p23-empty") });
  assert.equal(none.findings.length, 0);
});

// ---------------------------------------------------------------------------
// 7. sparse history => explicit insufficient_evidence, capped confidence
// ---------------------------------------------------------------------------
test("7. sparse history produces an insufficient_evidence prediction with capped confidence", () => {
  const project = uniq("p23-sparse");
  const r = predictFragility({ project_id: project });
  assert.equal(r.ok, true);
  assert.equal(r.sparse_history, true);
  assert.equal(r.insufficient_evidence, true);
  const ins = r.predictions.find((p) => p.risk_category === "insufficient_evidence");
  assert.ok(ins, "explicit insufficient_evidence prediction present");
  assert.equal(ins.evidence_class, "insufficient_evidence");
  assert.ok(ins.confidence <= 0.45, "confidence capped when evidence insufficient");
  assert.ok(r.predictions.every((p) => p.confidence <= 0.45), "all confidences capped on sparse history");
  assert.equal(ins.certainty_claim, "none");
  assert.equal(ins.causation_claim, "none");
});

// ---------------------------------------------------------------------------
// 8. rich evidence: categories, evidence_class, confidence ceilings
// ---------------------------------------------------------------------------
test("8. predictFragility maps evidence classes and respects ceilings", () => {
  const project = uniq("p23-rich");
  const r = predictFragility({
    project_id: project,
    findings: [
      { id: "f1", category: "fragile_dependency", component: "db", description: "redis single", status: "new" },
      { id: "f2", category: "fragile_dependency", component: "db", description: "redis no fallback", status: "new" },
      { id: "f3", category: "outdated_pattern", component: "api", description: "legacy adapter", status: "existing" },
    ],
    history: [
      { id: "h1", marker: "regressed", component: "auth", detail: "login regressed" },
      { id: "h2", marker: "repeated_failure", component: "worker", detail: "job failed twice" },
      { id: "h3", marker: "repeated_failure", component: "worker", detail: "job failed again" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.sparse_history, false, "two distinct history entries are sufficient");
  const cats = r.predictions.map((p) => p.risk_category);
  assert.ok(cats.includes("dependency_concentration"));
  assert.ok(cats.includes("regression_risk"));
  assert.ok(cats.includes("repeated_failure"));
  const dep = r.predictions.find((p) => p.risk_category === "dependency_concentration");
  assert.equal(dep.evidence_class, "detected_risk");
  assert.ok(dep.confidence <= RISK_RULES.dependency_concentration.max_confidence);
  const reg = r.predictions.find((p) => p.risk_category === "regression_risk");
  assert.equal(reg.evidence_class, "historical_pattern");
  assert.ok(r.predictions.every((p) => p.confidence < 1));
});

// ---------------------------------------------------------------------------
// 9. no certainty / causation claims anywhere
// ---------------------------------------------------------------------------
test("9. predictions never claim certainty or proven causation", () => {
  const project = uniq("p23-claims");
  const r = predictFragility({
    project_id: project,
    findings: [{ id: "f1", category: "missing_error_handling", component: "api", description: "gap", status: "new" }],
    history: [{ id: "h1", marker: "regressed" }, { id: "h2", marker: "regressed", detail: "again" }],
  });
  assert.ok(r.predictions.length > 0);
  for (const p of r.predictions) {
    assert.equal(p.certainty_claim, "none");
    assert.equal(p.causation_claim, "none");
    assert.ok(EVIDENCE_CLASSES.includes(p.evidence_class), "labelled evidence class");
    assert.ok(p.evidence_class !== "insufficient_evidence" || p.risk_category === "insufficient_evidence");
  }
  assert.match(r.note, /not certainties/i);
  assert.match(r.note, /No proven causation/i);
  const text = JSON.stringify(r).toLowerCase();
  assert.equal(text.includes("100% certain"), false);
  assert.equal(text.includes("definitely causes"), false);
});

// ---------------------------------------------------------------------------
// 10. recordPrediction upsert + getPredictions bounded/scoped
// ---------------------------------------------------------------------------
test("10. recordPrediction upserts and getPredictions is bounded and project-scoped", async () => {
  const project = uniq("p23-pred-write");
  const first = await recordPrediction({ project_id: project, component: "db",
    risk_category: "dependency_concentration", evidence: ["p-a"], confidence: 0.4 });
  assert.equal(first.ok, true);
  const second = await recordPrediction({ project_id: project, component: "db",
    risk_category: "dependency_concentration", evidence: ["p-b", "p-a"], confidence: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const all = await getPredictions({ project_id: project });
  assert.equal(all.predictions.length, 1, "upsert, not duplicate row");
  const row = all.predictions[0];
  assert.ok(row.evidence.includes("p-a") && row.evidence.includes("p-b"));
  assert.equal(row.evidence.filter((e) => e === "p-a").length, 1, "evidence deduped");
  assert.equal(row.review_status, "pending");
  assert.ok(row.confidence <= 0.75, "confidence clamped below certainty");

  const filtered = await getPredictions({ project_id: project, component: "db", status: "observed", limit: 1 });
  assert.equal(filtered.predictions.length, 1);
  assert.ok(filtered.limit <= 200);
});

// ---------------------------------------------------------------------------
// 11. reviewPrediction is append-only and project-scoped
// ---------------------------------------------------------------------------
test("11. reviewPrediction preserves history and is project-scoped", async () => {
  const project = uniq("p23-review");
  const id = (await recordPrediction({ project_id: project, risk_category: "missing_tests",
    component: "api", evidence: ["initial"] })).id;

  const r1 = await reviewPrediction({ id, project_id: project, review_status: "confirmed", evidence: ["review-1"] });
  assert.equal(r1.ok, true);
  const r2 = await reviewPrediction({ id, project_id: project, review_status: "dismissed", evidence: ["review-2"] });
  assert.equal(r2.ok, true);

  const row = (await getPredictions({ project_id: project })).predictions[0];
  assert.equal(row.review_status, "dismissed");
  assert.ok(row.signals.some((s) => s && s.marker === "review" && s.from === "confirmed" && s.to === "dismissed"),
    "review transition preserved in signals history");
  assert.ok(row.evidence.includes("initial"));
  assert.ok(row.evidence.some((e) => e && e.excerpt === "review-2"));

  const cross = await reviewPrediction({ id, project_id: uniq("p23-other"), review_status: "confirmed" });
  assert.equal(cross.ok, false, "cannot review another project's prediction");
});

// ---------------------------------------------------------------------------
// 12. project isolation
// ---------------------------------------------------------------------------
test("12. findings and predictions are isolated per project", async () => {
  const a = uniq("p23-iso-a");
  const b = uniq("p23-iso-b");
  const fid = (await recordFinding({ project_id: a, component: "c", category: "duplicated_logic", description: "dup" })).id;
  const pid = (await recordPrediction({ project_id: a, component: "c", risk_category: "missing_tests" })).id;

  assert.equal((await getFindings({ project_id: b })).findings.length, 0);
  assert.equal((await getPredictions({ project_id: b })).predictions.length, 0);
  assert.equal((await updateFindingStatus({ id: fid, project_id: b, status: "resolved" })).ok, false);
  assert.equal((await reviewPrediction({ id: pid, project_id: b, review_status: "confirmed" })).ok, false);
});

// ---------------------------------------------------------------------------
// 13. invalid inputs fail closed without throwing
// ---------------------------------------------------------------------------
test("13. invalid inputs fail closed without throwing", async () => {
  assert.equal(detectDebt().ok, false);
  assert.equal(detectDebt({ project_id: "" }).ok, false);
  assert.equal(predictFragility().ok, false);
  assert.equal(predictFragility({ project_id: "" }).ok, false);

  assert.equal((await recordFinding({ project_id: "p", category: "not_a_category", description: "x" })).ok, false);
  assert.equal((await recordFinding({ project_id: "p", category: "duplicated_logic", description: "" })).ok, false);
  assert.equal((await updateFindingStatus({ id: "nope", project_id: "p", status: "new" })).ok, false);
  assert.equal((await updateFindingStatus({ id: crypto.randomUUID(), project_id: "p", status: "bogus" })).ok, false);
  assert.equal((await getFindings()).ok, false);

  assert.equal((await recordPrediction({ project_id: "p", risk_category: "bogus" })).ok, false);
  assert.equal((await getPredictions()).ok, false);
  assert.equal((await reviewPrediction({ id: "nope", project_id: "p", review_status: "confirmed" })).ok, false);
  assert.equal((await reviewPrediction({ id: crypto.randomUUID(), project_id: "p", review_status: "bogus" })).ok, false);
});

// ---------------------------------------------------------------------------
// 14. redaction before persistence/return
// ---------------------------------------------------------------------------
test("14. credential-like content is redacted in findings and predictions", async () => {
  const project = uniq("p23-secret");
  const secret = `sk-${"a".repeat(32)}`;

  const det = detectDebt({ project_id: project, evidence: { svc: [`workaround: api_key=${secret} manual step`] } });
  assert.equal(det.findings.length, 1);
  assert.equal(JSON.stringify(det.findings).includes(secret), false, "detection redacts");
  assert.ok(det.findings[0].description.includes("[REDACTED"));

  const id = (await recordFinding({ project_id: project, component: "svc",
    category: "repeated_workaround", description: `workaround api_key=${secret}`,
    evidence: [`token ${secret}`] })).id;
  const row = (await getFindings({ project_id: project })).findings.find((f) => f.id === id);
  assert.ok(row, "row still stored");
  assert.equal(JSON.stringify(row).includes(secret), false, "finding never leaks secret");

  const pid = (await recordPrediction({ project_id: project, risk_category: "missing_tests",
    component: "svc", evidence: [`token ${secret}`], impact: `secret ${secret}` })).id;
  const prows = (await getPredictions({ project_id: project })).predictions;
  assert.ok(prows.some((p) => p.id === pid));
  assert.equal(JSON.stringify(prows).includes(secret), false, "prediction never leaks secret");
});

// ---------------------------------------------------------------------------
// 15. confidence caps are documented and enforced
// ---------------------------------------------------------------------------
test("15. confidence caps are enforced and documented by the rule tables", () => {
  for (const r of Object.values(RISK_RULES)) assert.ok(r.max_confidence < 1, "risk ceilings below certainty");
  for (const r of Object.values(DEBT_RULES)) assert.ok(r.confidence < 1, "debt confidences below certainty");
  const project = uniq("p23-cap");
  const r = predictFragility({
    project_id: project,
    findings: [
      { id: "a", category: "fragile_dependency", component: "db", description: "x", status: "new" },
      { id: "b", category: "fragile_dependency", component: "db", description: "y", status: "new" },
    ],
    // no history => sparse => global 0.45 cap even though findings exist
  });
  const dep = r.predictions.find((p) => p.risk_category === "dependency_concentration");
  assert.ok(dep, "risk still emitted from findings");
  assert.ok(dep.confidence <= 0.45, "sparse-history cap applied to real prediction");
  assert.match(dep.confidence_cap_reason || "", /sparse history/);
  assert.ok(r.predictions.some((p) => p.risk_category === "insufficient_evidence"));
});

// close pool (exactly once, at the end)
test("close pool", async () => { await core.close(); });
