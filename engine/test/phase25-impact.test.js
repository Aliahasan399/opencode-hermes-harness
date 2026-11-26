// Phase 25 capability D — change impact / freshness / version-aware persistence.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), no LLM/network/git/spawn,
// unique project ids per test, defensive DDL, project-scoped, no destructive asserts.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase25-impact.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const ci = await import("../src/changeImpact.js");
const decisionIntel = await import("../src/decisionIntel.js");

const uniq = (p = "p25") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const TMP = fs.existsSync("D:\\ra-temp\\tmp\\opencode") ? "D:\\ra-temp\\tmp\\opencode" : os.tmpdir();

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(TMP, "p25-impact-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

// Idempotent schema guards: no-ops when migration 023 (and 015) are already applied.
test.before(async () => {
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
    id uuid PRIMARY KEY, project_id text NOT NULL, file_path text NOT NULL, symbol_key text NOT NULL,
    name text NOT NULL DEFAULT '', symbol_type text NOT NULL DEFAULT 'unknown',
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
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_test_map (
    id bigserial PRIMARY KEY, project_id text NOT NULL, test_path text NOT NULL,
    test_name text NOT NULL DEFAULT '', source_path text NOT NULL DEFAULT '',
    source_key text NOT NULL DEFAULT '', link_type text NOT NULL DEFAULT 'unmapped',
    confidence real NOT NULL DEFAULT 0, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    version_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, test_path, test_name, source_key, version_hash))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS code_analysis (
    id uuid PRIMARY KEY, project_id text NOT NULL, analysis_type text NOT NULL,
    change_ref text NOT NULL DEFAULT '', version_hash text NOT NULL DEFAULT '',
    result jsonb NOT NULL DEFAULT '{}'::jsonb, confidence real NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'complete', error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, analysis_type, change_ref, version_hash))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS technical_decision (
    id uuid PRIMARY KEY, project_id text NOT NULL, title text NOT NULL,
    description text NOT NULL DEFAULT '', reasoning text NOT NULL DEFAULT '',
    alternatives jsonb NOT NULL DEFAULT '[]'::jsonb, consequences jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'active',
    confidence real, superseded_by text, source_session text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, title))`);
  await core.dbQuery(`CREATE TABLE IF NOT EXISTS audit_log (
    id bigserial PRIMARY KEY, action text, resource text, detail jsonb, at timestamptz NOT NULL DEFAULT now())`);
});

async function seedIndex(project_id, version_hash, status = "complete") {
  await core.dbQuery(
    `INSERT INTO code_index_state (id, project_id, root_path, status, version_hash)
     VALUES ($1,$2,'', $3, $4)`,
    [crypto.randomUUID(), project_id, status, version_hash],
  );
}
async function seedSourceFile(project_id, p, hash) {
  await core.dbQuery(
    `INSERT INTO code_source_file (id, project_id, path, content_hash, status)
     VALUES ($1,$2,$3,$4,'indexed')
     ON CONFLICT (project_id, path) DO UPDATE SET content_hash=EXCLUDED.content_hash, status='indexed'`,
    [crypto.randomUUID(), project_id, p, hash],
  );
}
async function seedSymbol(project_id, { path: fp, symbol_key, name, confidence = 0.7, evidence = [], version = "v1" }) {
  await core.dbQuery(
    `INSERT INTO code_symbol (id, project_id, file_path, symbol_key, name, symbol_type, confidence, evidence, version_hash, status, content_hash)
     VALUES ($1,$2,$3,$4,$5,'function',$6,$7::jsonb,$8,'active',$9)
     ON CONFLICT (project_id, file_path, symbol_key, content_hash) DO NOTHING`,
    [crypto.randomUUID(), project_id, fp, symbol_key, name, confidence, JSON.stringify(evidence), version, `${symbol_key}-h`],
  );
}
async function seedRel(project_id, source_key, target_key, {
  status = "inferred", confidence = 0.6, evidence = [], type = "call", source_file = "", version = "v1",
} = {}) {
  await core.dbQuery(
    `INSERT INTO code_relationship (project_id, source_key, target_key, relationship_type, source_file, status, confidence, evidence, version_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (project_id, source_key, target_key, relationship_type, version_hash) DO NOTHING`,
    [project_id, source_key, target_key, type, source_file, status, confidence, JSON.stringify(evidence), version],
  );
}

// ---------------------------------------------------------------------------
// 0. exports + frozen rules + required safety note
// ---------------------------------------------------------------------------
test("0. exact exports are functions; rules frozen; safety note present", () => {
  for (const name of ["compareIndexFreshness", "analyzeChange", "getImpact"]) {
    assert.equal(typeof ci[name], "function", `${name} must be a function`);
  }
  assert.equal(typeof ci.default.compareIndexFreshness, "function");
  assert.equal(typeof ci.default.analyzeChange, "function");
  assert.ok(Object.isFrozen(ci.IMPACT_RULES), "IMPACT_RULES frozen");
  assert.ok(Object.isFrozen(ci.IMPACT_RULES.bounds), "nested bounds frozen");
  assert.equal(ci.IMPACT_RULES.bounds.maxTraverseNodes, 100);
  assert.equal(ci.IMPACT_RULES.bounds.maxTraverseDepth, 4);
  assert.match(ci.SAFETY_NOTE, /NOT proof of safety/i);
  assert.match(ci.SAFETY_NOTE, /stale indexes cannot silently support recommendations/i);
});

// ---------------------------------------------------------------------------
// 1. no index -> stale true, discovered files listed
// ---------------------------------------------------------------------------
test("1. compareIndexFreshness with no index reports stale and lists discovered files", async () => {
  const dir = makeFixture({ "a.js": "export const a = 1;\n" });
  const r = await ci.compareIndexFreshness({ project_id: uniq("p25-noindex"), root: dir });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.indexed_version_hash, null);
  assert.ok(r.current_version_hash && /^[0-9a-f]{64}$/.test(r.current_version_hash));
  assert.equal(r.changed_files.length, 1);
  assert.equal(r.changed_files[0].path, "a.js");
  assert.equal(r.changed_files[0].status, "added");
});

// ---------------------------------------------------------------------------
// 2. matching on-disk index -> stale false
// ---------------------------------------------------------------------------
test("2. matching index hash and ledger -> stale false, no changed files", async () => {
  const project = uniq("p25-fresh");
  const dir = makeFixture({ "a.js": "export const a = 1;\n", "b.js": "export const b = 2;\n" });
  const probe = await ci.compareIndexFreshness({ project_id: project, root: dir });
  assert.equal(probe.changed_files.length, 2);
  await seedIndex(project, probe.current_version_hash);
  for (const f of probe.changed_files) await seedSourceFile(project, f.path, f.current_hash);
  const r = await ci.compareIndexFreshness({ project_id: project, root: dir });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.indexed_version_hash, probe.current_version_hash);
  assert.equal(r.changed_files.length, 0);
});

// ---------------------------------------------------------------------------
// 3. modified file -> stale true + changed_files
// ---------------------------------------------------------------------------
test("3. a modified file flips freshness to stale and appears in changed_files", async () => {
  const project = uniq("p25-mod");
  const dir = makeFixture({ "a.js": "v1\n" });
  const probe = await ci.compareIndexFreshness({ project_id: project, root: dir });
  await seedIndex(project, probe.current_version_hash);
  await seedSourceFile(project, "a.js", probe.changed_files[0].current_hash);
  fs.writeFileSync(path.join(dir, "a.js"), "v2 changed\n");
  const r = await ci.compareIndexFreshness({ project_id: project, root: dir });
  assert.equal(r.stale, true);
  assert.equal(r.changed_files.length, 1);
  assert.equal(r.changed_files[0].path, "a.js");
  assert.equal(r.changed_files[0].status, "modified");
});

// ---------------------------------------------------------------------------
// 4. analyzeChange by path -> direct symbols
// ---------------------------------------------------------------------------
test("4. analyzeChange with path resolves direct symbols with evidence and confidence", async () => {
  const project = uniq("p25-direct");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/auth.js", symbol_key: "k_auth", name: "authenticate", confidence: 0.8 });
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { path: "src/auth.js" }, limit: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.direct.length, 1);
  assert.equal(r.direct[0].symbol_key, "k_auth");
  assert.equal(r.direct[0].category, "direct");
  assert.ok(r.direct[0].evidence.length > 0);
  assert.ok(r.direct[0].confidence > 0 && r.direct[0].confidence < 1);
  assert.ok(r.change_ref && r.version_hash);
});

// ---------------------------------------------------------------------------
// 5. inbound relationship -> transitive
// ---------------------------------------------------------------------------
test("5. an inbound relationship produces a bounded transitive entry", async () => {
  const project = uniq("p25-trans");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_a", name: "a" });
  await seedSymbol(project, { path: "src/b.js", symbol_key: "k_b", name: "b" });
  await seedRel(project, "k_b", "k_a", { type: "call", confidence: 0.6, source_file: "src/b.js", evidence: ["calls a"] });
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { symbol_key: "k_a" } });
  assert.equal(r.direct.length, 1);
  const t = r.transitive.find((x) => x.symbol_key === "k_b");
  assert.ok(t, "transitive entry for inbound dependent");
  assert.equal(t.depth, 1);
  assert.equal(t.relationship_type, "call");
  assert.ok(t.evidence.length > 0);
  assert.ok(t.confidence < 1);
});

// ---------------------------------------------------------------------------
// 6. unresolved edge -> unknown
// ---------------------------------------------------------------------------
test("6. an unresolved relationship touching a direct key is reported as unknown", async () => {
  const project = uniq("p25-unknown");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_a", name: "a" });
  await seedRel(project, "k_unk", "k_a", { status: "unresolved", confidence: 0.1 });
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { symbol_key: "k_a" } });
  assert.ok(r.unknown.length >= 1);
  assert.ok(r.unknown.some((u) => u.source_key === "k_unk" && u.target_key === "k_a"));
  assert.ok(r.unknown.every((u) => u.confidence < 1 && u.evidence.length > 0));
});

// ---------------------------------------------------------------------------
// 7. possible same-module entries (low confidence)
// ---------------------------------------------------------------------------
test("7. other symbols in a changed file appear as low-confidence possible entries", async () => {
  const project = uniq("p25-possible");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_a", name: "a" });
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_c", name: "c", confidence: 0.5 });
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { symbol_key: "k_a" } });
  const p = r.possible.find((x) => x.symbol_key === "k_c");
  assert.ok(p, "co-located symbol reported as possible");
  assert.ok(p.confidence <= 0.2, "possible confidence is low");
  assert.ok(p.evidence.length > 0);
});

// ---------------------------------------------------------------------------
// 8. tests from code_test_map
// ---------------------------------------------------------------------------
test("8. indexed test-to-code links are surfaced in tests[]", async () => {
  const project = uniq("p25-tests");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_a", name: "a" });
  await core.dbQuery(
    `INSERT INTO code_test_map (project_id, test_path, test_name, source_path, source_key, link_type, confidence, evidence, version_hash)
     VALUES ($1,$2,$3,$4,$5,'direct',0.8,$6::jsonb,'v1')
     ON CONFLICT (project_id, test_path, test_name, source_key, version_hash) DO NOTHING`,
    [project, "test/a.test.js", "works", "src/a.js", "k_a", JSON.stringify(["imports src/a.js"])],
  );
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { symbol_key: "k_a" } });
  const t = r.tests.find((x) => x.test_path === "test/a.test.js");
  assert.ok(t, "test link surfaced");
  assert.equal(t.link_type, "direct");
  assert.ok(t.evidence.length > 0 && t.confidence < 1);
});

// ---------------------------------------------------------------------------
// 9. decisions best-effort
// ---------------------------------------------------------------------------
test("9. decisions are a best-effort lookup and do not fail the analysis", async () => {
  const project = uniq("p25-dec");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/auth.js", symbol_key: "k_auth", name: "authenticate" });
  await decisionIntel.recordDecision({ project_id: project, title: "auth token handling", description: "chosen approach" });
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { path: "src/auth.js" } });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.decisions));
  assert.ok(r.decisions.some((d) => /auth/i.test(d.title)), "matching decision included");
  assert.ok(r.decisions.every((d) => d.confidence < 1 && d.evidence.length > 0));
});

// ---------------------------------------------------------------------------
// 10. version-aware persistence (upsert, no duplicate) + getImpact
// ---------------------------------------------------------------------------
test("10. same change+version updates one row; getImpact returns the persisted result", async () => {
  const project = uniq("p25-persist");
  const dir = makeFixture({ "x.js": "1\n" });
  const change = { path: "src/x.js", symbol_key: "kx" };
  const r1 = await ci.analyzeChange({ project_id: project, root: dir, change });
  const r2 = await ci.analyzeChange({ project_id: project, root: dir, change });
  assert.equal(r1.change_ref, r2.change_ref);
  assert.equal(r1.version_hash, r2.version_hash);
  assert.equal(r1.persisted, true);
  const cnt = await core.dbQuery(
    `SELECT count(*)::int AS n FROM code_analysis
     WHERE project_id=$1 AND analysis_type='impact' AND change_ref=$2 AND version_hash=$3`,
    [project, r1.change_ref, r1.version_hash],
  );
  assert.equal(cnt.rows[0].n, 1, "no duplicate row");
  const got = await ci.getImpact({ project_id: project, change_ref: r1.change_ref, version_hash: r1.version_hash });
  assert.equal(got.found, true);
  assert.equal(got.change_ref, r1.change_ref);
  assert.equal(got.version_hash, r1.version_hash);
});

// ---------------------------------------------------------------------------
// 11. stale / no-dependency result does not claim safety
// ---------------------------------------------------------------------------
test("11. a no-dependency result never claims safety and flags staleness", async () => {
  const project = uniq("p25-safe");
  const dir = makeFixture({});
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { path: "does/not/exist.js" } });
  assert.equal(r.direct.length, 0);
  assert.equal(r.transitive.length, 0);
  assert.equal(r.stale, true);
  assert.match(r.note, /NOT proof of safety/i);
  assert.match(r.note, /stale indexes cannot silently support recommendations/i);
  const text = JSON.stringify(r).toLowerCase();
  assert.equal(text.includes("safe to change"), false);
  assert.equal(text.includes("100% safe"), false);
});

// ---------------------------------------------------------------------------
// 12. bounded traversal (depth 4, max 100 nodes)
// ---------------------------------------------------------------------------
test("12. inbound traversal is bounded by depth 4 and 100 nodes", async () => {
  const project = uniq("p25-bound");
  const dir = makeFixture({});
  await seedSymbol(project, { path: "s0.js", symbol_key: "kb0", name: "root" });
  // depth chain kb1->kb0 ... kb6->kb5 (6 levels deep)
  for (let i = 1; i <= 6; i++) await seedSymbol(project, { path: `s${i}.js`, symbol_key: `kb${i}`, name: `n${i}` });
  for (let i = 1; i <= 6; i++) await seedRel(project, `kb${i}`, `kb${i - 1}`, { type: "call" });
  // plus 105 direct inbound dependents to exercise the node cap (single batched insert)
  const rows = [];
  const vals = [];
  for (let i = 0; i < 105; i++) {
    vals.push(project, `star${i}`, "kb0", "import", "", "inferred", 0.6, JSON.stringify([]), "v1");
    rows.push(`($${i * 9 + 1},$${i * 9 + 2},$${i * 9 + 3},$${i * 9 + 4},$${i * 9 + 5},$${i * 9 + 6},$${i * 9 + 7},$${i * 9 + 8}::jsonb,$${i * 9 + 9})`);
  }
  await core.dbQuery(
    `INSERT INTO code_relationship (project_id, source_key, target_key, relationship_type, source_file, status, confidence, evidence, version_hash)
     VALUES ${rows.join(",")} ON CONFLICT (project_id, source_key, target_key, relationship_type, version_hash) DO NOTHING`,
    vals,
  );
  const r = await ci.analyzeChange({ project_id: project, root: dir, change: { symbol_key: "kb0" }, limit: 200 });
  assert.ok(r.transitive.length <= ci.IMPACT_RULES.bounds.maxTraverseNodes, "node cap respected");
  assert.ok(r.transitive.every((t) => t.depth <= 4), "depth cap respected");
  assert.equal(r.transitive.some((t) => t.symbol_key === "kb6"), false, "depth>4 node not reached");
});

// ---------------------------------------------------------------------------
// 13. cross-project isolation
// ---------------------------------------------------------------------------
test("13. symbols and impacts are isolated per project", async () => {
  const a = uniq("p25-iso-a");
  const b = uniq("p25-iso-b");
  const dir = makeFixture({});
  await seedSymbol(a, { path: "src/a.js", symbol_key: "k_iso", name: "iso" });
  await seedRel(a, "k_iso_other", "k_iso", { type: "call" });
  const rb = await ci.analyzeChange({ project_id: b, root: dir, change: { symbol_key: "k_iso" } });
  assert.equal(rb.direct.length, 0, "other project sees no symbols");
  assert.equal(rb.transitive.length, 0);
  assert.equal(rb.unknown.length, 0);
});

// ---------------------------------------------------------------------------
// 14. redaction of diff content
// ---------------------------------------------------------------------------
test("14. credential-like diff content is never stored or returned", async () => {
  const project = uniq("p25-redact");
  const secret = `sk-${"a".repeat(32)}`;
  const dir = makeFixture({});
  await seedSymbol(project, { path: "src/a.js", symbol_key: "k_red", name: "red" });
  const r = await ci.analyzeChange({
    project_id: project, root: dir,
    change: { path: "src/a.js", diff: `api_key=${secret}\n- old\n+ new` }, limit: 20,
  });
  assert.equal(JSON.stringify(r).includes(secret), false, "returned result is redacted");
  const got = await ci.getImpact({ project_id: project, change_ref: r.change_ref, version_hash: r.version_hash });
  assert.equal(JSON.stringify(got).includes(secret), false, "persisted result is redacted");
});

// ---------------------------------------------------------------------------
// 15. invalid inputs fail closed without throwing
// ---------------------------------------------------------------------------
test("15. invalid inputs fail closed", async () => {
  assert.equal((await ci.compareIndexFreshness()).ok, false);
  assert.equal((await ci.compareIndexFreshness({ project_id: "_global", root: makeFixture({}) })).ok, false);
  assert.equal((await ci.analyzeChange()).ok, false);
  assert.equal((await ci.analyzeChange({ project_id: "" })).ok, false);
  assert.equal((await ci.analyzeChange({ project_id: "_global" })).ok, false);
  assert.equal((await ci.getImpact()).ok, false);
  assert.equal((await ci.getImpact({ project_id: "p" })).ok, false);
});

// ---------------------------------------------------------------------------
// 16. FINAL DB-down degradation -- close the pool, then verify graceful failure
// ---------------------------------------------------------------------------
test("16. DB-down degrades gracefully without throwing", async () => {
  await core.close(); // pool intentionally closed for the rest of this file
  const dir = makeFixture({ "a.js": "1\n" });
  let r1 = null; let r2 = null; let threw = false;
  try { r1 = await ci.compareIndexFreshness({ project_id: uniq("p25-down"), root: dir }); } catch { threw = true; }
  try { r2 = await ci.analyzeChange({ project_id: uniq("p25-down"), root: dir, change: { path: "a.js" } }); } catch { threw = true; }
  assert.equal(threw, false, "no exceptions escape");
  assert.ok(r1 && typeof r1.ok === "boolean");
  assert.equal(r1.stale, true, "cannot verify freshness -> stale");
  assert.ok(r1.degraded.length > 0 || r1.errors.length > 0);
  assert.ok(r2 && typeof r2.ok === "boolean");
  assert.ok(r2.degraded.length > 0 || r2.errors.length > 0);
  assert.match(r1.note, /NOT proof of safety/i);
  assert.match(r2.note, /NOT proof of safety/i);
});

// close pool (exactly once at the very end; tolerant of the deliberate close in 16)
test("close pool", async () => { try { await core.close(); } catch { /* already closed */ } });
