// Phase 25 capabilities G + H — code review risk & contract checks.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test). No LLM/network,
// unique project ids per test, no destructive assertions, no source rewriting.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase25-review.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const reviewMod = await import("../src/codeReviewRisk.js");
const contractsMod = await import("../src/contractCheck.js");

const { reviewChange, getReview, RULES, FINDING_STATUSES } = reviewMod;
const { checkContracts } = contractsMod;
const uniq = (p = "p25") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const fixtureDirs = [];
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p25-review-"));
  fixtureDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}
function hashes(dir) {
  const out = {};
  const walk = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out[r] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

test.before(async () => {
  // Defensive DDL — no-ops when migration 023 is already applied.
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_analysis (
    id uuid PRIMARY KEY, project_id text NOT NULL, analysis_type text NOT NULL,
    change_ref text NOT NULL DEFAULT '', version_hash text NOT NULL DEFAULT '',
    result jsonb NOT NULL DEFAULT '{}'::jsonb, confidence real NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'complete', error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, analysis_type, change_ref, version_hash))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_symbol (
    id uuid PRIMARY KEY, project_id text NOT NULL, file_path text NOT NULL,
    symbol_key text NOT NULL, name text NOT NULL DEFAULT '', symbol_type text NOT NULL DEFAULT 'unknown',
    scope text NOT NULL DEFAULT 'module', visibility text NOT NULL DEFAULT 'internal',
    start_line integer NOT NULL DEFAULT 0, end_line integer NOT NULL DEFAULT 0,
    parent_key text NOT NULL DEFAULT '', is_export boolean NOT NULL DEFAULT false,
    language text NOT NULL DEFAULT 'unknown', content_hash text NOT NULL DEFAULT '',
    version_hash text NOT NULL DEFAULT '', extraction_method text NOT NULL DEFAULT 'heuristic',
    confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'active', indexed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, file_path, symbol_key, content_hash))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_relationship (
    id bigserial PRIMARY KEY, project_id text NOT NULL, source_key text NOT NULL,
    target_key text NOT NULL, relationship_type text NOT NULL, source_file text NOT NULL DEFAULT '',
    source_line integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'inferred',
    confidence real NOT NULL DEFAULT 0, extraction_method text NOT NULL DEFAULT 'heuristic',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb, version_hash text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, source_key, target_key, relationship_type, version_hash))`);
});

test.after(async () => {
  for (const dir of fixtureDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports exist and rule vocabulary is frozen", () => {
  assert.equal(typeof reviewChange, "function");
  assert.equal(typeof getReview, "function");
  assert.equal(typeof checkContracts, "function");
  assert.equal(typeof reviewMod.default.reviewChange, "function");
  assert.equal(typeof contractsMod.default.checkContracts, "function");
  assert.equal(Object.isFrozen(RULES), true);
  assert.equal(Object.isFrozen(FINDING_STATUSES), true);
  assert.deepEqual([...FINDING_STATUSES].sort(),
    ["confirmed", "informational", "insufficient_evidence", "potential"]);
  for (const cat of ["export_removal", "import_cycle", "async_handling", "error_handling",
    "scope_leak", "security_pattern", "test_gap"]) {
    assert.ok(RULES[cat], `RULES.${cat}`);
    assert.ok(FINDING_STATUSES.includes(RULES[cat].status));
  }
  assert.equal(RULES.security_pattern.status, "insufficient_evidence", "security pattern is never confirmed");
});

// ---------------------------------------------------------------------------
// 1. export-removal fixture produces a finding with all required fields
// ---------------------------------------------------------------------------
test("1. export-removal diff evidence produces a finding with every required field", async () => {
  const project = uniq("p25-remove");
  const r = await reviewChange({
    project_id: project,
    change: { path: "src/api.js", diff: "-export function oldApi() { return 1; }\n+export function newApi() { return 2; }" },
    limit: 20,
  });
  assert.equal(r.ok, true);
  const f = r.findings.find((x) => x.category === "export_removal");
  assert.ok(f, "export_removal finding present");
  for (const key of ["finding_id", "severity", "confidence", "category", "location", "evidence",
    "explanation", "consequence", "action", "related_tests", "status"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, key), `finding.${key}`);
  }
  assert.equal(typeof f.finding_id, "string");
  assert.ok(f.evidence.length >= 1);
  assert.ok(f.confidence < 1);
  assert.ok(FINDING_STATUSES.includes(f.status));
});

// ---------------------------------------------------------------------------
// 2. suspicious pattern is potential/insufficient_evidence, never confirmed
// ---------------------------------------------------------------------------
test("2. a security-shaped pattern is not reported as a confirmed vulnerability", async () => {
  const project = uniq("p25-pattern");
  const r = await reviewChange({
    project_id: project,
    change: { path: "src/unsafe.js", diff: "+const result = eval(userInput);\n+try { run(); } catch (e) {}" },
    limit: 20,
  });
  const sec = r.findings.find((x) => x.category === "security_pattern");
  assert.ok(sec, "security pattern finding present");
  assert.ok(["potential", "insufficient_evidence"].includes(sec.status), `status=${sec.status}`);
  assert.notEqual(sec.status, "confirmed");
  assert.match(sec.explanation, /not proof of a vulnerability/i);
  assert.match(sec.note, /insufficient evidence/i);
  assert.equal(RULES.security_pattern.status, "insufficient_evidence");
  const catchFinding = r.findings.find((x) => x.category === "error_handling");
  assert.ok(catchFinding, "broad/empty catch finding present");
  assert.notEqual(catchFinding.status, "confirmed");
});

// ---------------------------------------------------------------------------
// 3. explicit evidence markers upgrade findings to confirmed; counts classify
// ---------------------------------------------------------------------------
test("3. counts classify every status bucket and sum to findings length", async () => {
  const project = uniq("p25-counts");
  const r = await reviewChange({
    project_id: project,
    change: { path: "src/mix.js", diff: "-export function x() {}\n+const y = eval(z);\n+try { go(); } catch (e) {}" },
    evidence: { markers: ["export_removal: public API removed"], test_gaps: ["no test for x"] },
    limit: 30,
  });
  assert.equal(r.ok, true);
  const c = r.counts;
  for (const k of FINDING_STATUSES) assert.equal(typeof c[k], "number");
  assert.equal(c.confirmed + c.potential + c.informational + c.insufficient_evidence, r.findings.length,
    "counts partition findings");
  assert.ok(c.confirmed >= 1, "explicit marker => confirmed");
  assert.ok(c.potential >= 1, "broad catch => potential");
  assert.ok(c.informational >= 1, "test gap => informational");
  assert.ok(c.insufficient_evidence >= 1, "security pattern => insufficient_evidence");
  assert.ok(r.findings.some((f) => f.status === "confirmed" && f.category === "export_removal"));
});

// ---------------------------------------------------------------------------
// 4. delegation attempts Phase 23 modules and captures bounded results
// ---------------------------------------------------------------------------
test("4. delegation calls all four Phase 23 engines via injected loaders", async () => {
  const project = uniq("p25-delegate");
  const calls = [];
  const loaders = {
    technicalDebt: { detectDebt: async (a) => { calls.push(["tech_debt", a]); return { ok: true, findings: [{ category: "x" }], note: "stub" }; } },
    dependencyRisk: { analyzeDependencies: async (a) => { calls.push(["dep", a]); return { ok: true, risks: [], note: "stub" }; } },
    projectRisk: { predictFragility: async (a) => { calls.push(["frag", a]); return { ok: true, predictions: [], note: "stub" }; } },
    recommendationEngine: { buildRecommendations: async (a) => { calls.push(["rec", a]); return { ok: true, recommendations: [], note: "stub" }; } },
  };
  const r = await reviewChange({
    project_id: project, change: { path: "src/a.js", diff: "-export function a() {}" },
    evidence: { markers: ["export_removal: a"] }, limit: 20, loaders,
  });
  assert.equal(calls.length, 4, "all four engines invoked");
  for (const [, args] of calls) assert.equal(args.project_id, project);
  for (const key of ["tech_debt", "dependency_risk", "fragility", "recommendations"]) {
    assert.equal(r.delegated[key].ok, true, `${key} ok`);
    assert.equal(r.delegated[key].module != null, true);
    assert.equal(r.delegated[key].fn != null, true);
  }
  assert.equal(r.delegated.tech_debt.count, 1);
  assert.ok(r.delegated.tech_debt.result, "full result captured but bounded summary also present");
});

// ---------------------------------------------------------------------------
// 5. unavailable Phase 23 modules are recorded as degraded, not reimplemented
// ---------------------------------------------------------------------------
test("5. unavailable/delegation failures are recorded with reasons", async () => {
  const project = uniq("p25-degrade-deleg");
  const loaders = {
    technicalDebt: () => null,                       // unavailable
    dependencyRisk: { analyzeDependencies: async () => { throw new Error("boom"); } },
    projectRisk: () => null,
    recommendationEngine: () => null,
  };
  const r = await reviewChange({ project_id: project, change: { path: "src/a.js", diff: "-export function a() {}" }, loaders });
  assert.equal(r.ok, true);
  assert.equal(r.delegated.tech_debt.ok, false);
  assert.match(r.delegated.tech_debt.reason, /unavailable/i);
  assert.equal(r.delegated.dependency_risk.ok, false);
  assert.match(r.delegated.dependency_risk.reason, /boom/);
  assert.equal(r.delegated.fragility.ok, false);
  assert.equal(r.delegated.recommendations.ok, false);
  assert.equal(r.degraded, true);
  assert.ok(Array.isArray(r.findings), "local findings still produced without delegation");
});

// ---------------------------------------------------------------------------
// 6. persistence is idempotent and getReview reads it back
// ---------------------------------------------------------------------------
test("6. review persistence is idempotent on (project, change_ref, version_hash)", async () => {
  const project = uniq("p25-persist");
  const args = { project_id: project, change_ref: "chg-idem",
    change: { path: "src/api.js", diff: "-export function oldApi() {}" },
    evidence: { change_ref: "chg-idem", markers: ["export_removal: removed"] }, limit: 20 };
  const a = await reviewChange(args);
  const b = await reviewChange({ ...args });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.persisted, true);
  assert.equal(b.persisted, true);
  assert.equal(a.change_ref, b.change_ref);
  assert.equal(a.version_hash, b.version_hash);

  const rows = await core.dbQuery(
    "SELECT id FROM code_analysis WHERE project_id=$1 AND analysis_type='review' AND change_ref=$2 AND version_hash=$3",
    [project, a.change_ref, a.version_hash]);
  assert.equal(rows.rows.length, 1, "one row after two identical reviews");

  const read = await getReview({ project_id: project, change_ref: "chg-idem" });
  assert.equal(read.ok, true);
  assert.equal(read.items.length, 1);
  assert.ok(Array.isArray(read.items[0].result.findings));
  assert.ok(read.items[0].result.counts);
});

// ---------------------------------------------------------------------------
// 7. no source rewriting by either module
// ---------------------------------------------------------------------------
test("7. review and contract checks never rewrite fixture source", async () => {
  const project = uniq("p25-nowrite");
  const dir = makeFixture({
    "src/a.js": "import { b } from './b.js';\nexport function a(){ return b(); }\n",
    "src/b.js": "export function b(){ return 1; }\n",
    "README.md": "# Fixture\np25.review\n",
    "cli.js": "// p25.review\n",
  });
  const before = hashes(dir);
  await reviewChange({ project_id: project, root: dir, change: { files: ["src/a.js", "src/b.js"] } });
  await checkContracts({ project_id: project, root: dir });
  const after = hashes(dir);
  assert.deepEqual(after, before, "fixture bytes unchanged");
});

// ---------------------------------------------------------------------------
// 8. contract check detects a bounded import cycle
// ---------------------------------------------------------------------------
test("8. checkContracts detects an import cycle via bounded DFS", async () => {
  const project = uniq("p25-cycle");
  const dir = makeFixture({
    "src/a.js": "import { b } from './b.js';\nexport function a(){ return b(); }\n",
    "src/b.js": "import { a } from './a.js';\nexport function b(){ return a(); }\n",
  });
  const r = await checkContracts({ project_id: project, root: dir, limit: 100 });
  assert.equal(r.ok, true);
  const cyc = r.cycles.find((c) => c.nodes.includes("src/a.js") && c.nodes.includes("src/b.js"));
  assert.ok(cyc, "a<->b cycle detected");
  assert.ok(cyc.nodes.length >= 2);
  assert.ok(cyc.evidence.length >= 1, "cycle carries evidence");
  assert.ok(r.findings.some((f) => f.category === "import_cycle"));
  assert.ok(r.cycles.length <= 20, "cycles bounded");
});

// ---------------------------------------------------------------------------
// 9. boundary violations are findings
// ---------------------------------------------------------------------------
test("9. checkContracts flags directory boundary violations", async () => {
  const project = uniq("p25-boundary");
  const dir = makeFixture({
    "src/service.js": "import { helper } from '../test/helper.js';\nexport function run(){ return helper(); }\n",
    "test/helper.js": "export function helper(){ return 1; }\n",
    "engine/core.js": "import { ui } from '../dashboard/ui.js';\nexport function core(){ return ui(); }\n",
    "dashboard/ui.js": "export function ui(){ return 2; }\n",
  });
  const r = await checkContracts({ project_id: project, root: dir, limit: 100 });
  assert.ok(r.findings.some((f) => f.category === "src_imports_test"), "src -> test flagged");
  assert.ok(r.findings.some((f) => f.category === "engine_imports_dashboard"), "engine -> dashboard flagged");
  for (const f of r.findings) {
    assert.ok(f.evidence.length >= 1);
    assert.ok(f.confidence < 1);
    assert.ok(FINDING_STATUSES.includes(f.status));
    assert.match(f.note, /never automatic proof/i);
  }
  assert.match(r.note, /never automatic proof of a defect/i);
});

// ---------------------------------------------------------------------------
// 10. documented contract tokens are compared to cli/server source
// ---------------------------------------------------------------------------
test("10. contract tokens documented in README but absent in entry points are informational", async () => {
  const project = uniq("p25-contract-token");
  const dir = makeFixture({
    "src/a.js": "export function a(){ return 1; }\n",
    "README.md": "# Fixture\np25.review p25.contracts p25.ghost\n",
    "cli.js": "// wires p25.review and p25.contracts\n",
    "server.js": "// no extra tools\n",
  });
  const r = await checkContracts({ project_id: project, root: dir, limit: 100 });
  const missing = r.findings.find((f) => f.category === "documented_contract_missing");
  assert.ok(missing, "documented token drift flagged");
  assert.ok(missing.evidence.some((e) => e.includes("p25.ghost")));
  assert.equal(missing.status, "informational");
});

// ---------------------------------------------------------------------------
// 11. bounded findings/cycles/discrepancies
// ---------------------------------------------------------------------------
test("11. results are bounded by limit", async () => {
  const project = uniq("p25-bounded");
  const dir = makeFixture({
    "src/a.js": "export function a(){ return 1; }\nexport function b(){ return 2; }\n",
    "README.md": "# Fixture\n",
  });
  const r = await checkContracts({ project_id: project, root: dir, limit: 1 });
  assert.ok(r.findings.length <= 1, "findings bounded by limit");
  assert.equal(r.discrepancies.length, r.findings.length);
  assert.ok(r.imports.length <= 1);
  assert.ok(r.exports.length <= 1);

  const rev = await reviewChange({ project_id: project, root: dir,
    change: { path: "src/a.js", diff: "-export function a(){}\n-export function b(){}\n+eval(x)\n+eval(y)" }, limit: 1 });
  assert.ok(rev.findings.length <= 1, "review findings bounded by limit");
});

// ---------------------------------------------------------------------------
// 12. project isolation
// ---------------------------------------------------------------------------
test("12. reviews and contract evidence are isolated per project", async () => {
  const a = uniq("p25-iso-a");
  const b = uniq("p25-iso-b");
  await reviewChange({ project_id: a,
    evidence: { change_ref: "iso", markers: ["export_removal: a"] },
    change: { path: "src/a.js", diff: "-export function a() {}" } });

  assert.equal((await getReview({ project_id: b })).items.length, 0, "other project sees no review");
  assert.equal((await getReview({ project_id: a })).items.length, 1);

  // An indexed edge belonging to project A must not appear in project B.
  await core.dbQuery(`INSERT INTO code_relationship
    (project_id, source_key, target_key, relationship_type, source_file, status, confidence, version_hash)
    VALUES ($1,'iso-src','iso-target','import','src/iso.js','confirmed',0.9,$2)`, [a, "iso-v1"]);
  const rb = await checkContracts({ project_id: b, limit: 100 });
  assert.equal(rb.imports.some((e) => e.from === "iso-src" || e.to === "iso-target"), false,
    "no cross-project relationship leak");
});

// ---------------------------------------------------------------------------
// 13. secret redaction
// ---------------------------------------------------------------------------
test("13. credential-like content is redacted in findings and persisted results", async () => {
  const project = uniq("p25-secret");
  const secret = `sk-${"a".repeat(32)}`;
  const r = await reviewChange({
    project_id: project,
    change: { path: "src/key.js", diff: `+const api_key = "${secret}";\n+eval(input);` },
    evidence: { change_ref: "secret-run" },
    loaders: {
      technicalDebt: { detectDebt: async () => ({ ok: true, findings: [], note: "" }) },
      dependencyRisk: { analyzeDependencies: async () => ({ ok: true, risks: [] }) },
      projectRisk: { predictFragility: async () => ({ ok: true, predictions: [] }) },
      recommendationEngine: { buildRecommendations: async () => ({ ok: true, recommendations: [] }) },
    },
  });
  assert.ok(r.findings.length >= 1);
  assert.equal(JSON.stringify(r.findings).includes(secret), false, "findings never leak secret");
  const read = await getReview({ project_id: project, change_ref: "secret-run" });
  assert.equal(JSON.stringify(read.items).includes(secret), false, "persisted result never leaks secret");
});

// ---------------------------------------------------------------------------
// 14. invalid inputs fail closed without throwing
// ---------------------------------------------------------------------------
test("14. invalid inputs fail closed", async () => {
  for (const bad of [undefined, {}, { project_id: "" }, { project_id: "  " }, { project_id: "_global" }]) {
    const r = await reviewChange(bad);
    assert.equal(r.ok, false);
    assert.equal(Array.isArray(r.findings), true);
    const c = await checkContracts(bad);
    assert.equal(c.ok, false);
    const g = await getReview(bad);
    assert.equal(g.ok, false);
  }
});

// ---------------------------------------------------------------------------
// 15. FINAL: DB-down degradation (no throw, analysis preserved, errors recorded)
// ---------------------------------------------------------------------------
test("15. DB-down degrades gracefully on both modules", async () => {
  const project = uniq("p25-dbdown");
  const deadDb = async () => { throw new Error("connection refused"); };
  const r = await reviewChange({
    project_id: project, root: null,
    change: { path: "src/a.js", diff: "-export function a() {}\n+eval(x)" },
    dbQuery: deadDb,
  });
  assert.equal(r.ok, true, "analysis survives DB outage");
  assert.ok(r.findings.some((f) => f.category === "export_removal"));
  assert.equal(r.persisted, false);
  assert.equal(r.degraded, true);
  assert.ok(r.errors.some((e) => /persistence unavailable/i.test(e)));

  const c = await checkContracts({ project_id: project, root: null, dbQuery: deadDb });
  assert.equal(c.ok, true);
  assert.ok(c.errors.some((e) => /code_symbol read failed/i.test(e)));
  assert.ok(c.degraded.includes("indexed evidence unavailable"));
  assert.deepEqual(c.findings, []);
});

// close pool (exactly once, at the end)
test("close pool", async () => { await core.close(); });
