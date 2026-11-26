// Phase 25 Capability A — source discovery, heuristic symbol extraction and
// bounded incremental indexing. Uses only the isolated test DB and a temporary
// fixture directory; no source rewriting, no spawn, no network, no parser install.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase25-indexing.test.js
import test, { before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const si = await import("../src/sourceIndexer.js");

const uniq = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const PA = uniq("p25a"), PB = uniq("p25b"), PC = uniq("p25c"), PD = uniq("p25d"), PE = uniq("p25e");
const blob = (v) => JSON.stringify(v ?? {});
const secret = `sk-${"a".repeat(32)}`;

const fx = fs.mkdtempSync(path.join(os.tmpdir(), "p25-index-"));
const fxBounded = fs.mkdtempSync(path.join(os.tmpdir(), "p25-bound-"));
const fxRename = fs.mkdtempSync(path.join(os.tmpdir(), "p25-rename-"));
let appHashInitial = "";

const APP_JS = [
  'import fs from "node:fs";',
  "export const limit = 10;",
  "function compute(a, b) { return a + b; }",
  "export class Widget {",
  "  constructor(v) { this.v = v; }",
  "  run(x) { return compute(this.v, x); }",
  "}",
  "export const arrow = (x) => x * 2;",
  "export { compute };",
  "export default 42;",
  `const apiKey = "${secret}";`,
].join("\n");

const SQL = [
  "CREATE TABLE users (",
  "  id integer PRIMARY KEY,",
  "  email text",
  ");",
  "CREATE INDEX idx_users_email ON users (email);",
].join("\n");

const PY = [
  "class Helper:",
  "    def __init__(self, x):",
  "        self.x = x",
  "    def value(self):",
  "        return self.x",
  "",
  "def top(a):",
  "    return a",
].join("\n");

before(async () => {
  try {
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_index_state (
      id uuid PRIMARY KEY, project_id text NOT NULL, root_path text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'running', files_seen integer NOT NULL DEFAULT 0,
      files_indexed integer NOT NULL DEFAULT 0, files_skipped integer NOT NULL DEFAULT 0,
      files_failed integer NOT NULL DEFAULT 0, symbols_extracted integer NOT NULL DEFAULT 0,
      version_hash text NOT NULL DEFAULT '', error text,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`);
    await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_source_file (
      id uuid PRIMARY KEY, project_id text NOT NULL, path text NOT NULL,
      language text NOT NULL DEFAULT 'unknown', content_hash text NOT NULL DEFAULT '',
      size_bytes integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'indexed',
      extractor text NOT NULL DEFAULT 'heuristic', last_indexed_run uuid, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, path))`);
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
  } catch { /* migration 023 normally already applied */ }

  fs.mkdirSync(path.join(fx, "src"), { recursive: true });
  fs.mkdirSync(path.join(fx, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(fx, ".git"), { recursive: true });
  fs.writeFileSync(path.join(fx, "src", "app.js"), APP_JS);
  fs.writeFileSync(path.join(fx, "src", "types.ts"),
    "export function typed(x: number): number { return x; }\nexport interface Thing { id: number; }\n");
  fs.writeFileSync(path.join(fx, "src", "schema.sql"), SQL);
  fs.writeFileSync(path.join(fx, "src", "util.py"), PY);
  fs.writeFileSync(path.join(fx, "node_modules", "dep.js"), "export const ignored = 1;\n");
  fs.writeFileSync(path.join(fx, ".git", "config"), "[core]\n");

  fs.mkdirSync(path.join(fxBounded, "deep"), { recursive: true });
  fs.writeFileSync(path.join(fxBounded, "a.js"), "export const a=1;\n");
  fs.writeFileSync(path.join(fxBounded, "deep", "b.js"), "export const b=2;\n");
  fs.writeFileSync(path.join(fxBounded, "big.js"), "x".repeat(400));

  fs.writeFileSync(path.join(fxRename, "old.js"), "export const stable = 1;\n");
});

// ---------------------------------------------------------------------------
test("0. exact exports exist", async () => {
  assert.deepEqual(Object.keys(si.default).sort(),
    ["discoverFiles", "extractSymbols", "getSymbol", "indexProject", "indexStatus", "searchSymbols"]);
  for (const k of Object.keys(si.default)) assert.equal(typeof si[k], "function", k);
});

// ---------------------------------------------------------------------------
test("1. discoverFiles classifies .js/.ts/.sql/.py and hashes content", async () => {
  const d = await si.discoverFiles({ project_id: PA, root: fx });
  assert.equal(d.ok, true);
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.equal(by["src/app.js"].language, "javascript");
  assert.equal(by["src/types.ts"].language, "typescript");
  assert.equal(by["src/schema.sql"].language, "sql");
  assert.equal(by["src/util.py"].language, "python");
  assert.equal(by["src/app.js"].ext, ".js");
  assert.equal(by["src/app.js"].hash.length, 64);
  assert.equal(by["src/app.js"].size, Buffer.byteLength(APP_JS));
  assert.equal(by["src/app.js"].hash, crypto.createHash("sha256").update(APP_JS).digest("hex"));
  appHashInitial = by["src/app.js"].hash;
  assert.ok(d.files.every((f) => f.abs && path.isAbsolute(f.abs)));
});

// ---------------------------------------------------------------------------
test("2. ignored directories are skipped and paths cannot escape root", async () => {
  const d = await si.discoverFiles({ project_id: PA, root: fx });
  const paths = d.files.map((f) => f.path);
  assert.equal(paths.some((p) => p.startsWith("node_modules/")), false);
  assert.equal(paths.some((p) => p.startsWith(".git/")), false);
  assert.ok(d.skipped >= 1);
  const escaped = await si.extractSymbols({ project_id: PA, root: fx, path: "../outside.js" });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.symbols.length, 0);
});

// ---------------------------------------------------------------------------
test("3. discoverFiles clamps and enforces file/depth bounds", async () => {
  const one = await si.discoverFiles({ project_id: PA, root: fxBounded,
    options: { maxFiles: 1, maxBytes: 32, maxDepth: 1 } });
  assert.equal(one.ok, true);
  assert.equal(one.limits.maxFiles, 1);
  assert.equal(one.limits.maxBytes, 32);
  assert.equal(one.files.length, 1);
  assert.equal(one.truncated, true);
  const depth = await si.discoverFiles({ project_id: PA, root: fxBounded,
    options: { maxDepth: 1 } });
  assert.ok(depth.skip_reasons.depth >= 1);
  assert.equal(depth.files.some((f) => f.path === "deep/b.js"), false);
  const size = await si.discoverFiles({ project_id: PA, root: fxBounded,
    options: { maxBytes: 32 } });
  assert.ok(size.skip_reasons.size >= 1);
  assert.equal(size.files.some((f) => f.path === "big.js"), false);
  const huge = await si.discoverFiles({ project_id: PA, root: fxBounded,
    options: { maxFiles: 99999, maxBytes: 9999999, maxDepth: 999 } });
  assert.equal(huge.limits.maxFiles, 3000);
  assert.equal(huge.limits.maxBytes, 256 * 1024);
  assert.equal(huge.limits.maxDepth, 12);
});

// ---------------------------------------------------------------------------
test("4. extractSymbols finds JS functions/classes/methods/arrows/imports/exports", async () => {
  const r = await si.extractSymbols({ project_id: PA, path: "src/app.js",
    source: APP_JS, language: "javascript" });
  assert.equal(r.ok, true);
  const types = new Set(r.symbols.map((s) => s.symbol_type));
  for (const t of ["function", "class", "method", "arrow", "constant", "import", "export"]) {
    assert.ok(types.has(t), `expected symbol type ${t}`);
  }
  const byName = Object.fromEntries(r.symbols.map((s) => [s.name, s]));
  assert.ok(byName.compute && byName.Widget && byName.arrow && byName.limit);
  const computeFn = r.symbols.find((s) => s.symbol_type === "function" && s.name === "compute");
  assert.equal(computeFn.is_export, false);
  assert.equal(byName.limit.is_export, true);
  const widget = byName.Widget;
  assert.ok(r.symbols.some((s) => s.name === "run" && s.parent_key === widget.symbol_key));
});

// ---------------------------------------------------------------------------
test("5. symbol_key is stable for repeated extraction and line-sensitive", async () => {
  const args = { project_id: PA, path: "src/app.js", source: APP_JS, language: "javascript" };
  const a = await si.extractSymbols(args);
  const b = await si.extractSymbols(args);
  assert.deepEqual(a.symbols.map((s) => s.symbol_key), b.symbols.map((s) => s.symbol_key));
  assert.ok(a.symbols.every((s) => s.symbol_key.length === 24));
  const shifted = await si.extractSymbols({ ...args, source: "\n\n" + APP_JS });
  const k1 = a.symbols.find((s) => s.name === "compute").symbol_key;
  const k2 = shifted.symbols.find((s) => s.name === "compute").symbol_key;
  assert.notEqual(k1, k2);
});

// ---------------------------------------------------------------------------
test("6. SQL table/index and Python def/class detection", async () => {
  const sql = await si.extractSymbols({ project_id: PA, path: "src/schema.sql", source: SQL, language: "sql" });
  assert.equal(sql.ok, true);
  assert.ok(sql.symbols.some((s) => s.symbol_type === "table" && s.name === "users"));
  assert.ok(sql.symbols.some((s) => s.symbol_type === "index" && s.name === "idx_users_email"));
  const py = await si.extractSymbols({ project_id: PA, path: "src/util.py", source: PY, language: "python" });
  assert.equal(py.ok, true);
  assert.ok(py.symbols.some((s) => s.symbol_type === "class" && s.name === "Helper"));
  assert.ok(py.symbols.some((s) => s.symbol_type === "method" && s.name === "value"));
  assert.ok(py.symbols.some((s) => s.symbol_type === "function" && s.name === "top"));
});

// ---------------------------------------------------------------------------
test("7. evidence is redacted, bounded and confidence is in range", async () => {
  const r = await si.extractSymbols({ project_id: PA, path: "src/app.js", source: APP_JS, language: "javascript" });
  assert.equal(blob(r).includes(secret), false);
  const key = r.symbols.find((s) => s.name === "apiKey");
  assert.ok(key);
  assert.equal(blob(key.evidence).includes(secret), false);
  for (const s of r.symbols) {
    assert.ok(s.confidence >= 0 && s.confidence <= 1, "confidence bounded");
    assert.equal(s.extraction_method, "heuristic");
    assert.ok(Array.isArray(s.evidence));
    for (const e of s.evidence) assert.ok(typeof e === "string" && e.length <= 200);
  }
});

// ---------------------------------------------------------------------------
test("8. unsupported constructs are recorded explicitly", async () => {
  const odd = [
    "function broken( {",
    "const {a,b} = obj;",
    "const p = import('./x.js');",
    "export weird = 1;",
  ].join("\n");
  const r = await si.extractSymbols({ project_id: PA, path: "odd.js", source: odd, language: "javascript" });
  assert.equal(r.ok, true);
  assert.ok(r.unsupported.length > 0);
  const unknown = await si.extractSymbols({ project_id: PA, path: "x.rb", source: "def x; end", language: "ruby" });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.symbols, []);
  assert.ok(unknown.unsupported.some((u) => u.includes("unsupported_language")));
});

// ---------------------------------------------------------------------------
test("9. first indexProject run is complete and persists symbols", async () => {
  const r = await si.indexProject({ project_id: PA, root: fx });
  assert.equal(r.ok, true);
  assert.equal(r.status, "complete");
  assert.ok(r.run_id);
  assert.equal(r.files_indexed, 4);
  assert.equal(r.files_seen, 4);
  assert.ok(r.symbols_extracted > 0);
  assert.equal(r.version_hash.length, 64);
  const sr = await si.searchSymbols({ project_id: PA, query: "compute" });
  assert.ok(sr.items.some((s) => s.name === "compute"));
});

// ---------------------------------------------------------------------------
test("10. second run skips unchanged files", async () => {
  const r = await si.indexProject({ project_id: PA, root: fx });
  assert.equal(r.status, "complete");
  assert.equal(r.files_indexed, 0);
  assert.equal(r.files_skipped, 4);
  assert.equal(r.symbols_extracted, 0);
});

// ---------------------------------------------------------------------------
test("11. modified file is reindexed with a new content hash", async () => {
  fs.appendFileSync(path.join(fx, "src", "app.js"), "\nexport function addedLater() { return 7; }\n");
  const r = await si.indexProject({ project_id: PA, root: fx });
  assert.equal(r.status, "complete");
  assert.equal(r.files_indexed, 1);
  assert.equal(r.files_skipped, 3);
  const row = (await core.dbQuery(
    "SELECT content_hash FROM code_source_file WHERE project_id=$1 AND path='src/app.js'", [PA])).rows[0];
  assert.notEqual(row.content_hash, appHashInitial);
  const found = await si.searchSymbols({ project_id: PA, query: "addedLater" });
  assert.equal(found.count, 1);
  const compute = await si.searchSymbols({ project_id: PA, query: "compute" });
  assert.ok(compute.count >= 1);
  assert.equal(compute.items.every((s) => s.content_hash === row.content_hash), true,
    "stale symbol versions are superseded, not returned alongside the new version");
});

// ---------------------------------------------------------------------------
test("12. deleted file is marked deleted and never hard-deleted", async () => {
  fs.unlinkSync(path.join(fx, "src", "types.ts"));
  const r = await si.indexProject({ project_id: PA, root: fx });
  assert.equal(r.status, "complete");
  const row = (await core.dbQuery(
    "SELECT status FROM code_source_file WHERE project_id=$1 AND path='src/types.ts'", [PA]));
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].status, "deleted");
});

// ---------------------------------------------------------------------------
test("13. rename is inferred from matching content hash", async () => {
  const first = await si.indexProject({ project_id: PC, root: fxRename });
  assert.equal(first.status, "complete");
  fs.renameSync(path.join(fxRename, "old.js"), path.join(fxRename, "new.js"));
  const second = await si.indexProject({ project_id: PC, root: fxRename });
  assert.equal(second.status, "complete");
  assert.match(second.note, /inferred rename/);
  const oldRow = (await core.dbQuery(
    "SELECT status FROM code_source_file WHERE project_id=$1 AND path='old.js'", [PC])).rows[0];
  const newRow = (await core.dbQuery(
    "SELECT status FROM code_source_file WHERE project_id=$1 AND path='new.js'", [PC])).rows[0];
  assert.equal(oldRow.status, "deleted");
  assert.equal(newRow.status, "indexed");
});

// ---------------------------------------------------------------------------
test("14. partial run is never reported complete", async () => {
  const r = await si.indexProject({ project_id: PD, root: fxBounded,
    options: { maxBytes: 32, maxDepth: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.status, "partial");
  assert.equal(r.files_seen, 1);
  assert.match(r.note, /partial/);
  const st = await si.indexStatus({ project_id: PD, root: fxBounded });
  assert.equal(st.items[0].status, "partial");
});

// ---------------------------------------------------------------------------
test("15. indexStatus is bounded and project-scoped", async () => {
  const a = await si.indexStatus({ project_id: PA, limit: 0 });
  assert.equal(a.limit, 1);
  assert.ok(a.items.length <= 1);
  const b = await si.indexStatus({ project_id: PA, limit: 999 });
  assert.equal(b.limit, 200);
  assert.ok(b.items.length <= 200);
  const other = await si.indexStatus({ project_id: uniq("p25none") });
  assert.equal(other.count, 0);
});

// ---------------------------------------------------------------------------
test("16. searchSymbols filters by type/path and clamps limit", async () => {
  const fn = await si.searchSymbols({ project_id: PA, query: "",
    symbol_type: "function", path: "src/app.js", limit: 200 });
  assert.equal(fn.ok, true);
  assert.ok(fn.count > 0);
  assert.equal(fn.items.every((s) => s.symbol_type === "function" && s.file_path === "src/app.js"), true);
  const none = await si.searchSymbols({ project_id: PA, query: "zzz-not-found-xyz" });
  assert.equal(none.count, 0);
  const capped = await si.searchSymbols({ project_id: PA, query: "", limit: 999 });
  assert.equal(capped.limit, 200);
});

// ---------------------------------------------------------------------------
test("17. getSymbol works in scope; cross-project access fails", async () => {
  const hit = (await si.searchSymbols({ project_id: PA, query: "compute" })).items[0];
  const got = await si.getSymbol({ project_id: PA, symbol_key: hit.symbol_key });
  assert.equal(got.ok, true);
  assert.equal(got.symbol.symbol_key, hit.symbol_key);
  assert.equal((await si.getSymbol({ project_id: PB, symbol_key: hit.symbol_key })).ok, false);
  const pbIndex = await si.indexProject({ project_id: PB, root: fx });
  assert.equal(pbIndex.status, "complete");
  const pbHit = (await si.searchSymbols({ project_id: PB, query: "compute" })).items[0];
  assert.ok(pbHit);
  assert.notEqual(pbHit.symbol_key, hit.symbol_key, "symbol_key is project-bound");
  const paAgain = await si.searchSymbols({ project_id: PA, query: "compute" });
  assert.equal(paAgain.items.every((s) => s.symbol_key !== pbHit.symbol_key), true);
});

// ---------------------------------------------------------------------------
test("18. invalid inputs fail closed without throwing", async () => {
  for (const name of Object.keys(si.default)) {
    assert.equal((await si[name]()).ok, false, `${name} no args`);
    assert.equal((await si[name]({ project_id: "" })).ok, false, `${name} empty project`);
    assert.equal((await si[name]({ project_id: "_global" })).ok, false, `${name} _global`);
  }
  assert.equal((await si.discoverFiles({ project_id: PA, root: path.join(fx, "missing") })).ok, false);
  assert.equal((await si.discoverFiles({ project_id: PA, root: path.join(fx, "src", "app.js") })).ok, false);
});

// ---------------------------------------------------------------------------
test("19. DB-down degradation after core.close()", async () => {
  await core.close();
  const idx = await si.indexProject({ project_id: PE, root: fx });
  assert.equal(idx.ok, false);
  assert.equal(idx.status, "failed");
  assert.equal((await si.indexStatus({ project_id: PE })).ok, false);
  assert.equal((await si.searchSymbols({ project_id: PE })).ok, false);
  assert.equal((await si.getSymbol({ project_id: PE, symbol_key: "x" })).ok, false);
  // Pure filesystem capabilities keep working with no database.
  assert.equal((await si.discoverFiles({ project_id: PE, root: fx })).ok, true);
  assert.equal((await si.extractSymbols({ project_id: PE, path: "a.js", source: "const a=1;", language: "javascript" })).ok, true);
});

// ---------------------------------------------------------------------------
test("20. source wiring tokens are present", () => {
  const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:");
  const src = fs.readFileSync(path.join(here, "..", "src", "sourceIndexer.js"), "utf8");
  for (const token of ["discoverFiles", "extractSymbols", "indexProject", "indexStatus",
    "searchSymbols", "getSymbol", "ON CONFLICT", "extraction_method", "underRoot"]) {
    assert.ok(src.includes(token), `token ${token} must be present for pipeline wiring audit`);
  }
});

// close pool (exactly once, at the end)
test("close pool", async () => {
  try { await core.close(); } catch { /* already closed by the DB-down case */ }
  for (const dir of [fx, fxBounded, fxRename]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
