// Phase 25 Capabilities E + F — test-to-code mapping and test selection.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), deterministic heuristics,
// no test execution / no spawn / no source writes / no destructive SQL.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase25-tests.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const tm = await import("../src/testMap.js");
const ts = await import("../src/testSelector.js");

const { LINK_RULES, buildTestMap, getTestsFor } = tm;
const { TEST_SELECTION, recommendTests } = ts;

const uniq = (p = "p25t") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const blob = (v) => JSON.stringify(v ?? {});
const COVERAGE_RE = /\b\d{1,3}(\.\d+)?\s*%\s*coverage\b/i;
const CERTAINTY_RE = /certainly|definitely|guaranteed|100%|will always|proven cause|no doubt/i;

let fixtureRoot;
const secret = `sk-${"a".repeat(28)}`;

// Idempotent defensive DDL (migration 023 is additive; these are no-ops when present).
test.before(async () => {
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS code_test_map (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      test_path text NOT NULL,
      test_name text NOT NULL DEFAULT '',
      source_path text NOT NULL DEFAULT '',
      source_key text NOT NULL DEFAULT '',
      link_type text NOT NULL DEFAULT 'unmapped',
      confidence real NOT NULL DEFAULT 0,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      version_hash text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, test_path, test_name, source_key, version_hash)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS code_symbol (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      file_path text NOT NULL,
      symbol_key text NOT NULL,
      name text NOT NULL DEFAULT '',
      symbol_type text NOT NULL DEFAULT 'unknown',
      scope text NOT NULL DEFAULT 'module',
      visibility text NOT NULL DEFAULT 'internal',
      start_line integer NOT NULL DEFAULT 0,
      end_line integer NOT NULL DEFAULT 0,
      parent_key text NOT NULL DEFAULT '',
      is_export boolean NOT NULL DEFAULT false,
      language text NOT NULL DEFAULT 'unknown',
      content_hash text NOT NULL DEFAULT '',
      version_hash text NOT NULL DEFAULT '',
      extraction_method text NOT NULL DEFAULT 'heuristic',
      confidence real NOT NULL DEFAULT 0,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'active',
      indexed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, file_path, symbol_key, content_hash)
    )`);

  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p25-tests-"));
  const write = (rel, content) => {
    const abs = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  write("src/foo.js", [
    "export function computeTotal(a, b) {",
    "  return a + b;",
    "}",
    "export const LABEL = 'total';",
    "",
  ].join("\n"));
  write("src/calc.py", ["def add(a, b):", "    return a + b", ""].join("\n"));
  write("test/foo.test.js", [
    'import { computeTotal } from "../src/foo.js";',
    'test("computeTotal adds two numbers", () => {',
    "  assert.equal(computeTotal(1, 2), 3);",
    "});",
    "",
  ].join("\n"));
  write("test/naming.test.js", [
    "// no imports: candidate link only",
    'test("computeTotal is exported from the module", () => {',
    "  assert.ok(true);",
    "});",
    "",
  ].join("\n"));
  write("test/indirect.test.js", [
    "// bare specifier: basename 'foo' matches src/foo.js without a resolved path",
    'import { computeTotal } from "lib/foo";',
    'test("indirect link case", () => {',
    "  assert.ok(computeTotal);",
    "});",
    "",
  ].join("\n"));
  write("test/orphan.test.js", [
    'test("placeholder orphan case", () => {',
    "  assert.ok(true);",
    "});",
    "",
  ].join("\n"));
  write("test/secret.test.js", [
    `test("handles token ${secret} value", () => {`,
    "  assert.ok(true);",
    "});",
    "",
  ].join("\n"));
  write("tests/test_calc.py", [
    "from src.calc import add",
    "",
    "def test_add_numbers():",
    "    assert add(1, 2) == 3",
    "",
  ].join("\n"));
});

test.after(() => {
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports and frozen rule tables", () => {
  assert.equal(typeof buildTestMap, "function");
  assert.equal(typeof getTestsFor, "function");
  assert.equal(typeof recommendTests, "function");
  assert.equal(typeof tm.default.buildTestMap, "function");
  assert.equal(typeof ts.default.recommendTests, "function");
  assert.equal(Object.isFrozen(LINK_RULES), true);
  assert.equal(Object.isFrozen(LINK_RULES.link_types), true);
  assert.equal(Object.isFrozen(LINK_RULES.bounds), true);
  assert.equal(Object.isFrozen(TEST_SELECTION), true);
  assert.equal(Object.isFrozen(TEST_SELECTION.must_not_skip), true);
});

// ---------------------------------------------------------------------------
// 1. discovery
// ---------------------------------------------------------------------------
test("1. buildTestMap discovers bounded test files and extracts test cases", async () => {
  const r = await buildTestMap({ project_id: uniq("discover"), root: fixtureRoot });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.test_files) && r.test_files.length >= 5, "discovers fixture test files");
  assert.ok(r.test_files.includes("test/foo.test.js"));
  assert.ok(r.test_files.includes("tests/test_calc.py"));
  assert.ok(r.test_cases >= 5, `expected test cases, got ${r.test_cases}`);
  assert.ok(r.mappings.every((m) => m.source_path && m.version_hash && Array.isArray(m.evidence)));
});

// ---------------------------------------------------------------------------
// 2. direct mapping
// ---------------------------------------------------------------------------
test("2. a resolved import produces a high-confidence direct mapping", async () => {
  const r = await buildTestMap({ project_id: uniq("direct"), root: fixtureRoot });
  const direct = r.mappings.find((m) => m.link_type === "direct" && m.source_path === "src/foo.js");
  assert.ok(direct, "direct mapping to src/foo.js exists");
  assert.equal(direct.confidence, LINK_RULES.link_types.direct.confidence);
  assert.ok(direct.confidence >= 0.9);
  assert.equal(direct.test_path, "test/foo.test.js");
  assert.ok(direct.evidence.length > 0 && direct.evidence[0].excerpt.includes("import"));
  assert.match(direct.version_hash, /^[a-f0-9]{24}$/);
});

// ---------------------------------------------------------------------------
// 3. candidate mapping
// ---------------------------------------------------------------------------
test("3. a name mention without an import produces a low-confidence candidate mapping", async () => {
  const r = await buildTestMap({ project_id: uniq("candidate"), root: fixtureRoot });
  const cand = r.mappings.find((m) => m.link_type === "candidate" && m.test_path === "test/naming.test.js");
  assert.ok(cand, "candidate mapping exists");
  assert.equal(cand.confidence, LINK_RULES.link_types.candidate.confidence);
  assert.ok(cand.confidence <= 0.3);
  assert.equal(cand.source_path, "src/foo.js");
  assert.ok(cand.evidence.some((e) => e.kind === "name_mention"));
});

// ---------------------------------------------------------------------------
// 3b. indirect mapping
// ---------------------------------------------------------------------------
test("3b. an unresolved import basename match produces an indirect mapping", async () => {
  const r = await buildTestMap({ project_id: uniq("indirect"), root: fixtureRoot });
  const ind = r.mappings.find((m) => m.link_type === "indirect" && m.test_path === "test/indirect.test.js");
  assert.ok(ind, "indirect mapping exists");
  assert.equal(ind.confidence, LINK_RULES.link_types.indirect.confidence);
  assert.ok(ind.confidence >= 0.6 && ind.confidence < 0.9);
  assert.equal(ind.source_path, "src/foo.js");
  assert.ok(ind.evidence.some((e) => e.kind === "import_basename"));
  assert.equal(r.mappings.some((m) => m.test_path === "test/indirect.test.js" && m.link_type === "direct"), false,
    "no direct/coverage claim from a basename match");
});

// ---------------------------------------------------------------------------
// 4. no coverage percentages
// ---------------------------------------------------------------------------
test("4. no coverage percentage is emitted", async () => {
  const r = await buildTestMap({ project_id: uniq("coverage"), root: fixtureRoot });
  assert.equal(Object.hasOwn(r, "coverage"), false);
  assert.doesNotMatch(blob(r), COVERAGE_RE);
  assert.doesNotMatch(blob(r), CERTAINTY_RE);
  assert.match(r.note, /no coverage percentage/i);
});

// ---------------------------------------------------------------------------
// 5. unmapped tests
// ---------------------------------------------------------------------------
test("5. tests with no evidence-backed link are listed as unmapped", async () => {
  const r = await buildTestMap({ project_id: uniq("unmapped"), root: fixtureRoot });
  const orphan = r.unmapped.find((u) => u.test_path === "test/orphan.test.js");
  assert.ok(orphan, "orphan test is unmapped");
  assert.match(orphan.reason, /no import or symbol-name link/i);
  assert.equal(r.mappings.some((m) => m.test_path === "test/orphan.test.js"), false);
});

// ---------------------------------------------------------------------------
// 6. idempotent persistence
// ---------------------------------------------------------------------------
test("6. repeated builds persist no duplicate rows", async () => {
  const project = uniq("idem");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const a = await core.dbQuery("SELECT count(*)::int AS n FROM code_test_map WHERE project_id=$1", [project]);
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const b = await core.dbQuery("SELECT count(*)::int AS n FROM code_test_map WHERE project_id=$1", [project]);
  assert.equal(a.rows[0].n, b.rows[0].n);
  assert.ok(b.rows[0].n > 0);
});

// ---------------------------------------------------------------------------
// 7. getTestsFor by path
// ---------------------------------------------------------------------------
test("7. getTestsFor filters by path, sorts by confidence and is bounded", async () => {
  const project = uniq("bypath");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const r = await getTestsFor({ project_id: project, path: "src/foo.js", limit: 10 });
  assert.equal(r.ok, true);
  assert.ok(r.items.length >= 1);
  assert.ok(r.items.every((i) => i.source_path === "src/foo.js"));
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i - 1].confidence >= r.items[i].confidence, "sorted by confidence desc");
  }
  const none = await getTestsFor({ project_id: project, path: "src/no-such-file.js" });
  assert.deepEqual(none.items, []);
});

// ---------------------------------------------------------------------------
// 8. getTestsFor by symbol_key
// ---------------------------------------------------------------------------
test("8. getTestsFor resolves a symbol_key through code_symbol", async () => {
  const project = uniq("bysym");
  const symbolKey = uniq("sym");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  await core.dbQuery(
    `INSERT INTO code_symbol
       (id, project_id, file_path, symbol_key, name, symbol_type, content_hash, version_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), project, "src/foo.js", symbolKey, "computeTotal", "function", "h1", "v1"],
  );
  const r = await getTestsFor({ project_id: project, symbol_key: symbolKey });
  assert.equal(r.ok, true);
  assert.ok(r.items.length >= 1, "symbol lookup returns tests mapped to the symbol's file");
  assert.ok(r.items.some((i) => i.source_path === "src/foo.js"));
});

// ---------------------------------------------------------------------------
// 9. recommendTests basics
// ---------------------------------------------------------------------------
test("9. recommendTests explains every recommendation with reason and evidence", async () => {
  const project = uniq("recommend");
  const symbolKey = uniq("sym");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  await core.dbQuery(
    `INSERT INTO code_symbol
       (id, project_id, file_path, symbol_key, name, symbol_type, content_hash, version_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), project, "src/foo.js", symbolKey, "computeTotal", "function", "h1", "v1"],
  );
  const analyzeChange = async () => ({
    ok: true,
    direct: [{ symbol_key: symbolKey, name: "computeTotal", path: "src/foo.js" }],
    transitive: [], possible: [], unknown: [],
  });
  const r = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange });
  assert.equal(r.ok, true);
  assert.ok(r.recommended.length >= 1);
  for (const rec of r.recommended) {
    assert.ok(rec.reason && rec.reason.length > 10, "human-readable reason present");
    assert.ok(Array.isArray(rec.evidence) && rec.evidence.length > 0, "evidence present");
    assert.ok(rec.path && rec.test_name && rec.link_type);
    assert.ok(rec.confidence > 0 && rec.confidence <= 1);
  }
  assert.ok(r.recommended.some((x) => x.link_type === "direct" && /direct import of changed module src\/foo\.js/.test(x.reason)));
  assert.match(r.note, /never executes tests/i);
  assert.match(r.note, /Phase 24 approval/i);
  assert.doesNotMatch(blob(r), CERTAINTY_RE);
});

// ---------------------------------------------------------------------------
// 10. dedup and bound
// ---------------------------------------------------------------------------
test("10. recommendations are deduplicated and bounded", async () => {
  const project = uniq("dedup");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const analyzeChange = async () => ({
    ok: true,
    direct: [{ path: "src/foo.js" }, { path: "src/foo.js" }],
    files: ["src/foo.js"],
    transitive: [], possible: [], unknown: [],
  });
  const full = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange });
  const keys = full.recommended.map((x) => `${x.path}\u0000${x.test_name}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate (path,test_name)");

  const one = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange, limit: 1 });
  assert.ok(one.recommended.length <= 1);
  assert.equal(one.limit, 1);
  const big = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange, limit: 500 });
  assert.equal(big.limit, TEST_SELECTION.bounds.max_limit);
  assert.ok(big.recommended.length <= TEST_SELECTION.bounds.max_limit);
});

// ---------------------------------------------------------------------------
// 11. must_not_skip
// ---------------------------------------------------------------------------
test("11. must_not_skip contains only high-confidence direct/indirect links", async () => {
  const project = uniq("mustskip");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const analyzeChange = async () => ({ ok: true, direct: [{ path: "src/foo.js" }], transitive: [], possible: [], unknown: [] });
  const r = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange });
  assert.ok(r.must_not_skip.length >= 1);
  for (const rec of r.must_not_skip) {
    assert.ok(TEST_SELECTION.must_not_skip.types.includes(rec.link_type));
    assert.ok(rec.confidence >= TEST_SELECTION.must_not_skip.min_confidence);
  }
  assert.equal(r.must_not_skip.some((x) => x.link_type === "candidate"), false, "low-confidence candidates excluded");
});

// ---------------------------------------------------------------------------
// 12. missing_relations
// ---------------------------------------------------------------------------
test("12. affected symbols without a test mapping are reported", async () => {
  const project = uniq("missing");
  await buildTestMap({ project_id: project, root: fixtureRoot });
  const missingKey = uniq("nosuch");
  const analyzeChange = async () => ({
    ok: true,
    direct: [{ path: "src/foo.js" }],
    transitive: [{ symbol_key: missingKey, name: "orphanSymbol", path: "src/none.js" }],
    possible: [], unknown: [],
  });
  const r = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange });
  const missing = r.missing_relations.find((x) => x.symbol_key === missingKey);
  assert.ok(missing, "unmapped affected symbol recorded");
  assert.match(missing.reason, /no test mapping/i);
});

// ---------------------------------------------------------------------------
// 13. no spawn
// ---------------------------------------------------------------------------
test("13. neither module imports child_process nor spawns processes", () => {
  const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:");
  for (const file of ["testMap.js", "testSelector.js"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", file), "utf8");
    assert.equal(src.includes("child_process"), false, `${file} must not import child_process`);
    assert.equal(/\bspawn\s*\(/.test(src), false, `${file} must not spawn`);
    assert.equal(/\bexecSync\s*\(|\bexecFile\s*\(/.test(src), false, `${file} must not shell-exec`);
  }
  const selectorSrc = fs.readFileSync(path.join(here, "..", "src", "testSelector.js"), "utf8");
  assert.equal(selectorSrc.includes("Phase 24"), true, "selector carries the no-approval-bypass note");
});

// ---------------------------------------------------------------------------
// 14. cross-project isolation
// ---------------------------------------------------------------------------
test("14. results are project-scoped", async () => {
  const projectA = uniq("isoA");
  const projectB = uniq("isoB");
  await buildTestMap({ project_id: projectA, root: fixtureRoot });
  const a = await getTestsFor({ project_id: projectA, path: "src/foo.js" });
  assert.ok(a.items.length >= 1);
  const b = await getTestsFor({ project_id: projectB, path: "src/foo.js" });
  assert.deepEqual(b.items, [], "other project has no mappings");

  const analyzeChange = async () => ({ ok: true, direct: [{ path: "src/foo.js" }], transitive: [], possible: [], unknown: [] });
  const rec = await recommendTests({
    project_id: projectB, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange,
    getTestsFor: (args) => getTestsFor(args),
  });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.recommended, [], "no cross-project recommendations");
});

// ---------------------------------------------------------------------------
// 15. redaction
// ---------------------------------------------------------------------------
test("15. credential-like content is redacted", async () => {
  const r = await buildTestMap({ project_id: uniq("redact"), root: fixtureRoot });
  assert.equal(blob(r).includes(secret), false, "secret is not present in output");
  assert.match(blob(r), /REDACTED/i);
});

// ---------------------------------------------------------------------------
// 16. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("16. invalid inputs fail closed without throwing", async () => {
  assert.equal((await buildTestMap()).ok, false);
  assert.equal((await buildTestMap({ project_id: "_global", root: fixtureRoot })).ok, false);
  assert.equal((await buildTestMap({ project_id: uniq(), root: path.join(fixtureRoot, "missing") })).ok, false);
  assert.equal((await getTestsFor()).ok, false);
  assert.equal((await getTestsFor({ project_id: "_global" })).ok, false);
  assert.equal((await recommendTests()).ok, false);
  assert.equal((await recommendTests({ project_id: "_global" })).ok, false);
  const empty = await recommendTests({ project_id: uniq() });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.recommended, []);
});

// ---------------------------------------------------------------------------
// 17. FINAL: database-down graceful degradation. Nothing after except close.
// ---------------------------------------------------------------------------
test("17. FINAL: degrades gracefully when the database is down", async () => {
  await core.close(); // the ONLY close() call that ends the pool
  const project = uniq("down");

  const built = await buildTestMap({ project_id: project, root: fixtureRoot });
  assert.equal(built.ok, true, "analysis still returns when persistence fails");
  assert.ok(Array.isArray(built.mappings));
  assert.ok(built.errors.some((e) => /persist code_test_map/i.test(e)));

  const got = await getTestsFor({ project_id: project, path: "src/foo.js" });
  assert.equal(got.ok, true);
  assert.deepEqual(got.items, []);
  assert.ok(Array.isArray(got.degraded));

  const analyzeChange = async () => ({ ok: true, direct: [{ path: "src/foo.js" }], transitive: [], possible: [], unknown: [] });
  const rec = await recommendTests({ project_id: project, root: fixtureRoot, change: { path: "src/foo.js" }, analyzeChange });
  assert.equal(rec.ok, true);
  for (const key of ["recommended", "must_not_skip", "missing_relations", "degraded"]) {
    assert.ok(Array.isArray(rec[key]), `${key} degrades to an array, not a throw`);
  }
  assert.match(rec.note, /never executes tests/i);
  assert.doesNotMatch(blob(rec), CERTAINTY_RE);
});

// close pool (idempotent: the pool may already be closed by the degradation test)
test("close pool", async () => { try { await core.close(); } catch { /* already closed */ } });
