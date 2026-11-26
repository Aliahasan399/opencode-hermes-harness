import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.MEMORY_DB_NAME = "opencode_memory_test";
const core = await import("../src/core.js");
const ci = await import("../src/codeIntelligence.js");
const pipelineAudit = await import("../src/pipelineAudit.js");

const projectA = `p25int-a-${crypto.randomUUID().slice(0, 8)}`;
const projectB = `p25int-b-${crypto.randomUUID().slice(0, 8)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "p25-fixture-"));
const srcDir = path.join(root, "src");
const testDir = path.join(root, "test");
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "math.js"), [
  "export const LIMIT = 10;",
  "export function add(a, b) { return a + b; }",
  "export class Calculator {",
  "  multiply(a, b) { return add(a, b) * LIMIT; }",
  "}",
  "export default add;",
].join("\n"), "utf8");
fs.writeFileSync(path.join(srcDir, "service.js"), [
  "import { add, Calculator } from './math.js';",
  "export function compute(a, b) {",
  "  try { const c = new Calculator(); return c.multiply(a, b) + add(a, b); }",
  "  catch (e) { return 0; }",
  "}",
].join("\n"), "utf8");
fs.writeFileSync(path.join(testDir, "math.test.js"), [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.js';",
  "test('add combines numbers', () => { assert.equal(add(1, 2), 3); });",
].join("\n"), "utf8");
const FIXTURE = { math: path.join(srcDir, "math.js").replace(/\\/g, "/"),
  service: path.join(srcDir, "service.js").replace(/\\/g, "/"),
  test: path.join(testDir, "math.test.js").replace(/\\/g, "/") };

const DDL = [
  `CREATE TABLE IF NOT EXISTS code_index_state (id uuid PRIMARY KEY, project_id text NOT NULL, root_path text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'running', files_seen integer NOT NULL DEFAULT 0, files_indexed integer NOT NULL DEFAULT 0, files_skipped integer NOT NULL DEFAULT 0, files_failed integer NOT NULL DEFAULT 0, symbols_extracted integer NOT NULL DEFAULT 0, version_hash text NOT NULL DEFAULT '', error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS code_source_file (id uuid PRIMARY KEY, project_id text NOT NULL, path text NOT NULL, language text NOT NULL DEFAULT 'unknown', content_hash text NOT NULL DEFAULT '', size_bytes integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'indexed', extractor text NOT NULL DEFAULT 'heuristic', last_indexed_run uuid, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, path))`,
  `CREATE TABLE IF NOT EXISTS code_symbol (id uuid PRIMARY KEY, project_id text NOT NULL, file_path text NOT NULL, symbol_key text NOT NULL, name text NOT NULL DEFAULT '', symbol_type text NOT NULL DEFAULT 'unknown', scope text NOT NULL DEFAULT 'module', visibility text NOT NULL DEFAULT 'internal', start_line integer NOT NULL DEFAULT 0, end_line integer NOT NULL DEFAULT 0, parent_key text NOT NULL DEFAULT '', is_export boolean NOT NULL DEFAULT false, language text NOT NULL DEFAULT 'unknown', content_hash text NOT NULL DEFAULT '', version_hash text NOT NULL DEFAULT '', extraction_method text NOT NULL DEFAULT 'heuristic', confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'active', indexed_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, file_path, symbol_key, content_hash))`,
  `CREATE TABLE IF NOT EXISTS code_relationship (id bigserial PRIMARY KEY, project_id text NOT NULL, source_key text NOT NULL, target_key text NOT NULL, relationship_type text NOT NULL, source_file text NOT NULL DEFAULT '', source_line integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'inferred', confidence real NOT NULL DEFAULT 0, extraction_method text NOT NULL DEFAULT 'heuristic', evidence jsonb NOT NULL DEFAULT '[]'::jsonb, version_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, source_key, target_key, relationship_type, version_hash))`,
  `CREATE TABLE IF NOT EXISTS code_test_map (id bigserial PRIMARY KEY, project_id text NOT NULL, test_path text NOT NULL, test_name text NOT NULL DEFAULT '', source_path text NOT NULL DEFAULT '', source_key text NOT NULL DEFAULT '', link_type text NOT NULL DEFAULT 'unmapped', confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb, version_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, test_path, test_name, source_key, version_hash))`,
  `CREATE TABLE IF NOT EXISTS code_analysis (id uuid PRIMARY KEY, project_id text NOT NULL, analysis_type text NOT NULL, change_ref text NOT NULL DEFAULT '', version_hash text NOT NULL DEFAULT '', result jsonb NOT NULL DEFAULT '{}'::jsonb, confidence real NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'complete', error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, analysis_type, change_ref, version_hash))`,
];
before(async () => { for (const d of DDL) { try { await core.dbQuery(d); } catch { /* migration 023 normally applied */ } } });
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

test("0. facade exports the full code-intelligence surface", () => {
  assert.deepEqual(Object.keys(ci.default).sort(),
    ["contracts", "freshness", "graph", "impact", "indexProject", "indexStatus", "module",
      "recommendTests", "relationships", "report", "review", "searchSymbols", "symbol", "tests"]);
});

test("1. real repository indexing discovers files and symbols", async () => {
  const r = await ci.indexProject({ project_id: projectA, root });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.status, "complete");
  assert.ok(r.files_indexed >= 3);
  assert.ok(r.symbols_extracted >= 6);
  assert.ok(r.run_id);
  globalThis.__idx = r;
});

test("2. symbol search returns deterministic, stable identities", async () => {
  const s = await ci.searchSymbols({ project_id: projectA, query: "add", limit: 50 });
  assert.equal(s.ok, true);
  assert.ok((s.items || []).some((x) => x.name === "add"));
  const again = await ci.searchSymbols({ project_id: projectA, query: "add", limit: 50 });
  const k1 = (s.items || []).filter((x) => x.name === "add").map((x) => x.symbol_key).sort();
  const k2 = (again.items || []).filter((x) => x.name === "add").map((x) => x.symbol_key).sort();
  assert.deepEqual(k1, k2);
  globalThis.__addKey = k1[0];
});

test("3. incremental re-index skips unchanged files", async () => {
  const r = await ci.indexProject({ project_id: projectA, root });
  assert.equal(r.ok, true);
  assert.equal(r.files_indexed, 0);
});

test("4. freshness detects no change, then a real change", async () => {
  const f1 = await ci.freshness({ project_id: projectA, root });
  assert.equal(f1.ok, true);
  assert.equal(f1.stale, false);
  const p = FIXTURE.math;
  const before = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, before + "\nexport const CHANGED = true;\n", "utf8");
  const f2 = await ci.freshness({ project_id: projectA, root });
  assert.equal(f2.ok, true);
  assert.equal(f2.stale, true);
  assert.ok((f2.changed_files || []).some((x) => String(x?.path ?? x).includes("math.js")));
  globalThis.__changedPath = p;
});

test("5. relationships are derived with evidence and confidence", async () => {
  const r = await ci.relationships({ project_id: projectA, root, build: true, version_hash: globalThis.__idx.version_hash });
  assert.equal(r.ok, true);
  assert.ok((r.relationships || []).length > 0);
  assert.ok(r.relationships.every((e) => e.confidence >= 0 && e.confidence <= 1 && Array.isArray(e.evidence)));
});

test("6. change impact identifies direct/transitive symbols and stale state", async () => {
  const r = await ci.impact({ project_id: projectA, root, change: { path: globalThis.__changedPath } });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.ok(Array.isArray(r.direct));
  assert.ok(Array.isArray(r.transitive));
  assert.ok(Array.isArray(r.unknown));
  assert.match(r.note, /not.*safe|no.dependency/i);
  globalThis.__impact = r;
});

test("7. test map links a real test to its imported source", async () => {
  const r = await ci.tests({ project_id: projectA, root, build: true });
  assert.equal(r.ok, true);
  assert.ok((r.mappings || []).some((m) => m.link_type === "direct" && String(m.source_path).includes("math.js")));
  assert.ok(!JSON.stringify(r).match(/\d+(\.\d+)?\s*%.*coverage/i));
});

test("8. test recommendations are explainable and never execute", async () => {
  const r = await ci.recommendTests({ project_id: projectA, root, change: { path: globalThis.__changedPath } });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.recommended));
  assert.ok(r.recommended.every((t) => t.reason && t.evidence !== undefined));
  assert.match(r.note, /never executes|approval|recommend/i);
  globalThis.__rec = r;
});

test("9. review findings are evidence-backed and delegate to Phase 23", async () => {
  const r = await ci.review({ project_id: projectA, root, change: { path: globalThis.__changedPath } });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.findings.every((f) => f.finding_id && f.evidence !== undefined && f.status));
  assert.ok(r.delegated && typeof r.delegated === "object");
  assert.match(r.note, /no source|rewrite|evidence/i);
});

test("10. contract check produces findings without auto-rewriting", async () => {
  const r = await ci.contracts({ project_id: projectA, root });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.findings));
  assert.match(r.note, /not automatic proof|discrepancy/i);
});

test("11. unified report exposes all required states explicitly", async () => {
  const r = await ci.report({ project_id: projectA, root, change: { path: globalThis.__changedPath } });
  assert.equal(r.ok, true);
  for (const key of ["repository_analysis_status", "index_freshness", "supported_language_coverage",
    "file_and_symbol_inventory", "relationship_analysis", "change_impact", "test_to_code",
    "code_risk_findings", "architecture_discrepancies", "unresolved_relationships",
    "insufficient_evidence", "analysis_errors", "recommendations"]) {
    assert.ok(key in r, `report must include ${key}`);
  }
  assert.equal(r.index_freshness.stale, true);
  assert.equal(r.verifiedBehavior, undefined);
  assert.match(r.claim, /not runtime proof/);
});

test("12. source was never rewritten by analysis", () => {
  const text = fs.readFileSync(FIXTURE.math, "utf8");
  assert.match(text, /CHANGED = true/); // only the operator's deliberate change from test 4
  const idxText = fs.readFileSync(new URL("../src/sourceIndexer.js", import.meta.url), "utf8");
  assert.doesNotMatch(idxText, /writeFileSync|appendFileSync/);
});

test("13. project isolation: project B sees none of project A's index", async () => {
  const s = await ci.searchSymbols({ project_id: projectB, query: "add", limit: 50 });
  assert.equal(s.ok, true);
  assert.equal((s.items || []).length, 0);
  const imp = await ci.impact({ project_id: projectB, root, change: { path: globalThis.__changedPath } });
  assert.equal(imp.ok, true);
  assert.deepEqual(imp.direct, []);
});

test("14. indexing fails closed on a missing root (traversal/safety covered in indexing suite)", async () => {
  const r = await ci.indexProject({ project_id: projectA, root: path.join(root, "__does_not_exist__") });
  assert.equal(r.ok, false);
});

test("15. pipeline audit covers Phase 25 wiring without runtime claims", () => {
  const a = pipelineAudit.auditPipelineIntegrity();
  assert.equal(a.ok, true);
  assert.ok(Object.keys(a.sources.phase25).length >= 9);
  assert.equal(a.verifiedBehavior, false);
  assert.ok(a.checks.filter((c) => c.id.startsWith("p25.")).length >= 11);
});

test("16. invalid inputs fail closed without throwing", async () => {
  for (const op of ["indexProject", "indexStatus", "searchSymbols", "symbol", "relationships",
    "graph", "module", "impact", "freshness", "tests", "recommendTests", "review", "contracts", "report"]) {
    let r;
    try { r = await ci[op]({ project_id: "_global", root, path: "x", symbol_key: "x" }); }
    catch (e) { assert.fail(`${op} must not throw: ${e?.message}`); }
    assert.equal(r?.ok, false, `${op} must reject _global`);
  }
});

test("17. LEVEL 1 and HARNESS_SEMANTIC_LLM unchanged; no source writing in modules", () => {
  const files = ["codeIntelligence.js", "sourceIndexer.js", "symbolGraph.js", "codeUnderstanding.js",
    "changeImpact.js", "testMap.js", "testSelector.js", "codeReviewRisk.js", "contractCheck.js"];
  for (const f of files) {
    let s = "";
    try { s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"); } catch { continue; }
    assert.doesNotMatch(s, /process\.env\.(OPTIMIZATION_LEVEL|HARNESS_SEMANTIC_LLM)\s*=/);
    assert.doesNotMatch(s, /auto_execute\s*:\s*true/);
    assert.doesNotMatch(s, /writeFileSync|unlinkSync|rmSync|git\s+(reset|merge|push)/);
  }
  assert.notEqual(process.env.OPTIMIZATION_LEVEL, "3");
  assert.notEqual(process.env.HARNESS_SEMANTIC_LLM, "1");
});

test("18. FINAL degradation after database close", async () => {
  await core.close();
  const r = await ci.report({ project_id: projectA, root });
  assert.equal(r.ok, true); // degrades to empty sections, never throws
  assert.ok(Array.isArray(r.analysis_errors));
  const s = await ci.searchSymbols({ project_id: projectA, query: "add" });
  assert.equal(s.ok, false);
});
