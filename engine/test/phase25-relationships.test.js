// Phase 25 capabilities B + C — symbol relationships + deterministic code understanding.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test). No source reads/writes,
// no spawn, no git, no LLM/network. Unique project ids per test; DB-down is tested
// via an injected failing query seam. No destructive SQL assertions.
//
// Run with:
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase25-relationships.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const core = await import("../src/core.js");
const sg = await import("../src/symbolGraph.js");
const cu = await import("../src/codeUnderstanding.js");

const uniq = (p = "p25") => `${p}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

// Idempotent schema guards: no-ops when migration 023 is already applied.
test.before(async () => {
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
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS code_relationship (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      source_key text NOT NULL,
      target_key text NOT NULL,
      relationship_type text NOT NULL,
      source_file text NOT NULL DEFAULT '',
      source_line integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'inferred',
      confidence real NOT NULL DEFAULT 0,
      extraction_method text NOT NULL DEFAULT 'heuristic',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      version_hash text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, source_key, target_key, relationship_type, version_hash)
    )`);
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
});

async function seed(project, defs, version = "v1") {
  for (const d of defs) {
    await core.dbQuery(
      `INSERT INTO code_symbol
         (id, project_id, file_path, symbol_key, name, symbol_type, scope, start_line, end_line,
          is_export, confidence, evidence, version_hash, status, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'active',$14)
       ON CONFLICT (project_id, file_path, symbol_key, content_hash) DO NOTHING`,
      [crypto.randomUUID(), project, d.file || "src/mod.js", d.key, d.name || "",
        d.type || "function", d.scope || "module", d.line || 1, d.end || (d.line || 1) + 2,
        !!d.is_export, d.confidence ?? 0.6, JSON.stringify(d.evidence || []), version,
        `h-${d.key}-${version}`],
    );
  }
}

// ---------------------------------------------------------------------------
// 0. exports
// ---------------------------------------------------------------------------
test("0. exact exports exist as functions", () => {
  for (const name of ["buildRelationships", "getRelationships", "traverse"]) {
    assert.equal(typeof sg[name], "function", `symbolGraph.${name}`);
  }
  for (const name of ["describeSymbol", "moduleUnderstanding"]) {
    assert.equal(typeof cu[name], "function", `codeUnderstanding.${name}`);
  }
  assert.equal(typeof sg.default.buildRelationships, "function");
  assert.equal(typeof cu.default.describeSymbol, "function");
});

// ---------------------------------------------------------------------------
// 1. import edge is confirmed
// ---------------------------------------------------------------------------
test("1. buildRelationships derives a confirmed import edge from an explicit import", async () => {
  const p = uniq("p25-import");
  const A = { key: "app", name: "app", file: "src/app.js", line: 1,
    evidence: ["import { helper } from './helper.js'"] };
  const B = { key: "helper", name: "helper", file: "src/helper.js", line: 1,
    evidence: ["export function helper() {}"] };
  await seed(p, [A, B]);
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  assert.equal(r.ok, true);
  const edge = r.relationships.find((e) => e.relationship_type === "import" &&
    e.source_key === A.key && e.target_key === B.key);
  assert.ok(edge, "import edge present");
  assert.equal(edge.status, "confirmed");
  assert.ok(edge.confidence > 0.8 && edge.confidence < 1);
  assert.equal(edge.extraction_method, "heuristic:import");
  assert.ok(edge.evidence.length >= 1);
  assert.equal(r.counts.confirmed >= 1, true);
});

// ---------------------------------------------------------------------------
// 2. call edge is inferred with low confidence
// ---------------------------------------------------------------------------
test("2. call token resolved to a same-file symbol becomes an inferred low-confidence edge", async () => {
  const p = uniq("p25-call");
  const A = { key: "run", name: "run", file: "src/app.js", line: 5,
    evidence: ["export function run(){ return helper(); }"] };
  const B = { key: "helper", name: "helper", file: "src/app.js", line: 1,
    evidence: ["export function helper() {}"] };
  await seed(p, [A, B]);
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const edge = r.relationships.find((e) => e.relationship_type === "call" &&
    e.source_key === A.key && e.target_key === B.key);
  assert.ok(edge, "call edge present");
  assert.equal(edge.status, "inferred");
  assert.ok(edge.confidence >= 0.3 && edge.confidence <= 0.6, "low confidence range");
  assert.equal(edge.extraction_method, "heuristic:call");
  assert.ok(edge.evidence.length >= 1);
  assert.equal(r.counts.inferred >= 1, true);
});

// ---------------------------------------------------------------------------
// 3. similar names alone never create an edge
// ---------------------------------------------------------------------------
test("3. no edge is invented for merely similar names", async () => {
  const p = uniq("p25-similar");
  const caller = { key: "caller", name: "caller", file: "src/app.js", line: 1,
    evidence: ["function caller(){ return getUser(); }"] };
  const get = { key: "get", name: "get", file: "src/app.js", line: 2,
    evidence: ["function get() {}"] };
  await seed(p, [caller, get]);
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  assert.equal(r.relationships.some((e) => e.target_key === get.key), false,
    "getUser must not resolve to get by similarity");
});

// ---------------------------------------------------------------------------
// 4. unresolved status requires evidence
// ---------------------------------------------------------------------------
test("4. unresolved edges carry evidence; no evidence means no edges", async () => {
  const p = uniq("p25-unresolved");
  await seed(p, [{ key: "app", name: "app", file: "src/app.js", line: 1,
    evidence: ["import { mystery } from './unknown.js'"] }]);
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const unres = r.relationships.filter((e) => e.status === "unresolved");
  assert.ok(unres.length >= 1, "unresolved edge exists");
  for (const e of unres) {
    assert.ok(Array.isArray(e.evidence) && e.evidence.length >= 1);
    assert.ok(e.target_key.startsWith("unresolved:"));
  }
  const offline = await sg.buildRelationships({ project_id: p, version_hash: "v1",
    symbols: [{ symbol_key: "empty", name: "empty", file_path: "src/x.js", evidence: [] }] });
  assert.equal(offline.relationships.length, 0, "no evidence => no edges");
});

// ---------------------------------------------------------------------------
// 5. confidence ordering/range
// ---------------------------------------------------------------------------
test("5. confidences are bounded and ordered confirmed > inferred > unresolved", async () => {
  const p = uniq("p25-conf");
  const defs = [
    { key: "app", name: "app", file: "src/app.js", line: 1,
      evidence: ["import { helper } from './helper.js'", "import { ghost } from './ghost.js'",
        "function app(){ return helper(); }"] },
    { key: "helper", name: "helper", file: "src/app.js", line: 2, evidence: ["function helper() {}"] },
  ];
  await seed(p, defs);
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const byStatus = (s) => r.relationships.filter((e) => e.status === s);
  for (const e of r.relationships) {
    assert.ok(e.confidence >= 0 && e.confidence < 1);
  }
  const confirmed = byStatus("confirmed");
  const inferred = byStatus("inferred");
  const unresolved = byStatus("unresolved");
  assert.ok(confirmed.length && inferred.length && unresolved.length);
  assert.ok(Math.min(...confirmed.map((e) => e.confidence)) >
    Math.max(...inferred.map((e) => e.confidence)));
  assert.ok(Math.min(...inferred.map((e) => e.confidence)) >= 0.3);
  assert.ok(Math.max(...unresolved.map((e) => e.confidence)) < 0.3);
});

// ---------------------------------------------------------------------------
// 6. idempotent persistence
// ---------------------------------------------------------------------------
test("6. relationships persist idempotently (ON CONFLICT DO NOTHING)", async () => {
  const p = uniq("p25-idem");
  await seed(p, [
    { key: "app", name: "app", file: "src/app.js", line: 1,
      evidence: ["import { helper } from './helper.js'"] },
    { key: "helper", name: "helper", file: "src/helper.js", line: 1, evidence: ["function helper() {}"] },
  ]);
  const r1 = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  assert.ok(r1.relationships.length >= 1);
  const c1 = await core.dbQuery(
    "SELECT count(*)::int AS n FROM code_relationship WHERE project_id=$1 AND version_hash='v1'", [p]);
  const r2 = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const c2 = await core.dbQuery(
    "SELECT count(*)::int AS n FROM code_relationship WHERE project_id=$1 AND version_hash='v1'", [p]);
  assert.equal(c2.rows[0].n, c1.rows[0].n, "no duplicate rows on rebuild");
  assert.equal(c1.rows[0].n, r1.relationships.length);
  assert.equal(r2.relationships.length, r1.relationships.length);
});

// ---------------------------------------------------------------------------
// 7. getRelationships in/out/type filters
// ---------------------------------------------------------------------------
test("7. getRelationships filters direction and type", async () => {
  const p = uniq("p25-read");
  await seed(p, [
    { key: "app", name: "app", file: "src/app.js", line: 1,
      evidence: ["import { helper } from './helper.js'", "function app(){ return helper(); }"] },
    { key: "helper", name: "helper", file: "src/app.js", line: 2, evidence: ["function helper() {}"] },
  ]);
  await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const out = await sg.getRelationships({ project_id: p, symbol_key: "app", direction: "out" });
  assert.equal(out.ok, true);
  assert.ok(out.items.length >= 2);
  assert.ok(out.items.every((i) => i.source_key === "app"));
  assert.ok(out.items.some((i) => i.relationship_type === "import"));
  assert.ok(out.items.some((i) => i.relationship_type === "call"));
  const inbound = await sg.getRelationships({ project_id: p, symbol_key: "helper", direction: "in" });
  assert.ok(inbound.items.length >= 2);
  assert.ok(inbound.items.every((i) => i.target_key === "helper"));
  const typed = await sg.getRelationships({ project_id: p, symbol_key: "app", type: "import" });
  assert.ok(typed.items.length >= 1);
  assert.ok(typed.items.every((i) => i.relationship_type === "import"));
});

// ---------------------------------------------------------------------------
// 8. traverse bounds
// ---------------------------------------------------------------------------
test("8. traverse enforces max_depth and max_nodes and sets truncated", async () => {
  const p = uniq("p25-traverse");
  await seed(p, [
    { key: "a", name: "a", file: "src/chain.js", line: 1, evidence: ["function a(){ return b(); }"] },
    { key: "b", name: "b", file: "src/chain.js", line: 2, evidence: ["function b(){ return c(); }"] },
    { key: "c", name: "c", file: "src/chain.js", line: 3, evidence: ["function c(){ return d(); }"] },
    { key: "d", name: "d", file: "src/chain.js", line: 4, evidence: ["function d(){}"] },
  ]);
  await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const depth = await sg.traverse({ project_id: p, symbol_key: "a", max_depth: 2, max_nodes: 100 });
  assert.equal(depth.ok, true);
  assert.equal(depth.truncated, true, "depth cut sets truncated");
  assert.ok(depth.nodes.length <= 3);
  assert.ok(depth.nodes.every((n) => n.depth <= 2));
  assert.ok(depth.edges.length >= 1);
  const nodes = await sg.traverse({ project_id: p, symbol_key: "a", max_depth: 6, max_nodes: 2 });
  assert.equal(nodes.truncated, true, "node budget cut sets truncated");
  assert.ok(nodes.nodes.length <= 2);
});

// ---------------------------------------------------------------------------
// 9. traverse note admits incomplete coverage with unresolved edges
// ---------------------------------------------------------------------------
test("9. traverse note states coverage is incomplete when unresolved edges exist", async () => {
  const p = uniq("p25-note");
  await seed(p, [
    { key: "a", name: "a", file: "src/app.js", line: 1,
      evidence: ["import { ghost } from './ghost.js'", "function a(){ return b(); }"] },
    { key: "b", name: "b", file: "src/app.js", line: 2, evidence: ["function b(){}"] },
  ]);
  await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  const r = await sg.traverse({ project_id: p, symbol_key: "a", max_depth: 3, max_nodes: 50 });
  assert.equal(r.ok, true);
  assert.match(r.note, /incomplete/i);
  assert.match(r.note, /unresolved/i);
});

// ---------------------------------------------------------------------------
// 10. describeSymbol deterministic signals
// ---------------------------------------------------------------------------
test("10. describeSymbol extracts params, calls, db/error/side-effect signals", async () => {
  const p = uniq("p25-describe");
  await seed(p, [{ key: "proc", name: "processOrder", file: "src/orders.js", line: 4, type: "function",
    evidence: [
      "function processOrder(userId, config) {",
      "  const res = await dbQuery('SELECT 1');",
      "  try { fs.writeFileSync(path, res); } catch (err) { emit('error', err); }",
      "  helper(res);",
      "}",
    ] }]);
  const r = await cu.describeSymbol({ project_id: p, symbol_key: "proc" });
  assert.equal(r.ok, true);
  assert.ok(r.params.includes("userId") && r.params.includes("config"));
  assert.ok(r.calls.includes("helper"));
  assert.ok(r.calls.includes("dbQuery"));
  assert.equal(r.db_access, true);
  assert.equal(r.error_handling, true);
  assert.equal(r.side_effects, true);
  assert.ok(r.summary.includes("processOrder"));
  assert.ok(r.confidence > 0 && r.confidence < 1);
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1);
});

// ---------------------------------------------------------------------------
// 11. unknowns are explicit
// ---------------------------------------------------------------------------
test("11. describeSymbol lists unsupported/absent signals as explicit unknowns", async () => {
  const p = uniq("p25-unknown");
  await seed(p, [{ key: "x", name: "x", file: "src/x.js", line: 1, evidence: ["const x = 1;"] }]);
  const r = await cu.describeSymbol({ project_id: p, symbol_key: "x" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, []);
  assert.deepEqual(r.calls, []);
  assert.equal(r.db_access, false);
  assert.ok(r.unknowns.includes("params") && r.unknowns.includes("calls"));
  assert.ok(r.unknowns.includes("db_access"));
  assert.match(r.note, /unknowns/i);
});

// ---------------------------------------------------------------------------
// 12. moduleUnderstanding aggregates
// ---------------------------------------------------------------------------
test("12. moduleUnderstanding aggregates symbols, imports, exports, responsibilities", async () => {
  const p = uniq("p25-module");
  await seed(p, [
    { key: "alpha", name: "alpha", file: "src/mod.js", line: 1, is_export: true,
      evidence: ["import { beta } from './beta.js'", "export function alpha() { return beta(); }"] },
    { key: "beta", name: "beta", file: "src/mod.js", line: 5, is_export: true,
      evidence: ["export function beta() {}"] },
    { key: "db", name: "db", file: "src/mod.js", line: 9,
      evidence: ["const rows = await dbQuery('SELECT 1');", "try {} catch (e) {}"] },
  ]);
  const r = await cu.moduleUnderstanding({ project_id: p, path: "src/mod.js" });
  assert.equal(r.ok, true);
  assert.equal(r.symbols.length, 3);
  assert.ok(r.imports.some((i) => i.name === "beta" && i.module === "./beta.js"));
  assert.ok(r.exports.some((e) => e.name === "alpha"));
  assert.ok(r.responsibilities.includes("database_access"));
  assert.ok(r.responsibilities.includes("export_surface"));
  assert.ok(r.evidence.length >= 1);
});

// ---------------------------------------------------------------------------
// 13. cross-project isolation
// ---------------------------------------------------------------------------
test("13. relationships and symbol descriptions are project-scoped", async () => {
  const a = uniq("p25-iso-a");
  const b = uniq("p25-iso-b");
  const defs = [
    { key: "app", name: "app", file: "src/app.js", line: 1,
      evidence: ["import { helper } from './helper.js'"] },
    { key: "helper", name: "helper", file: "src/helper.js", line: 1, evidence: ["function helper() {}"] },
  ];
  await seed(a, defs);
  await seed(b, defs);
  await sg.buildRelationships({ project_id: a, version_hash: "v1" });
  await sg.buildRelationships({ project_id: b, version_hash: "v1" });
  const ra = await sg.getRelationships({ project_id: a, symbol_key: "app" });
  const rb = await sg.getRelationships({ project_id: b, symbol_key: "app" });
  assert.ok(ra.items.length >= 1 && rb.items.length >= 1);
  assert.ok(ra.items.every((i) => i.project_id === a));
  assert.ok(rb.items.every((i) => i.project_id === b));
  assert.equal((await cu.describeSymbol({ project_id: b, symbol_key: "missing-key" })).ok, false);
});

// ---------------------------------------------------------------------------
// 14. bounded limits
// ---------------------------------------------------------------------------
test("14. limits and depth/node clamps are enforced without throwing", async () => {
  const p = uniq("p25-bounds");
  const r = await sg.buildRelationships({ project_id: p, version_hash: "v1", limit: 1,
    symbols: [
      { symbol_key: "a", name: "a", file_path: "f.js", start_line: 1,
        evidence: ["import { b } from './b'", "import { c } from './c'"] },
      { symbol_key: "b", name: "b", file_path: "f.js", start_line: 2, evidence: ["function b(){}"] },
      { symbol_key: "c", name: "c", file_path: "f.js", start_line: 3, evidence: ["function c(){}"] },
    ] });
  assert.ok(r.relationships.length <= 1);
  const t = await sg.traverse({ project_id: p, symbol_key: "a", max_depth: 99, max_nodes: 99999 });
  assert.match(t.note, /depth<=6/);
  assert.match(t.note, /nodes<=500/);
  const fallback = await sg.getRelationships({ project_id: p, limit: 0 });
  assert.equal(fallback.ok, true, "invalid limit falls back, no throw");
});

// ---------------------------------------------------------------------------
// 15. redaction
// ---------------------------------------------------------------------------
test("15. credential-like content is redacted everywhere", async () => {
  const p = uniq("p25-redact");
  const secret = `sk-${"a".repeat(32)}`;
  const defs = [
    { key: "app", name: "app", file: "src/app.js", line: 1,
      evidence: [`const token = '${secret}'; import { helper } from './helper.js'`] },
    { key: "helper", name: "helper", file: "src/app.js", line: 2, evidence: ["function helper(){}"] },
  ];
  await seed(p, defs);
  const built = await sg.buildRelationships({ project_id: p, version_hash: "v1" });
  assert.equal(JSON.stringify(built).includes(secret), false, "buildRelationships redacts");
  const desc = await cu.describeSymbol({ project_id: p, symbol_key: "app" });
  assert.equal(JSON.stringify(desc).includes(secret), false, "describeSymbol redacts");
  assert.ok(JSON.stringify(desc).includes("[REDACTED"));
});

// ---------------------------------------------------------------------------
// 16. invalid inputs fail closed
// ---------------------------------------------------------------------------
test("16. invalid inputs fail closed without throwing", async () => {
  assert.equal((await sg.buildRelationships()).ok, false);
  assert.equal((await sg.buildRelationships({ project_id: "_global" })).ok, false);
  assert.equal((await sg.getRelationships()).ok, false);
  assert.equal((await sg.getRelationships({ project_id: "p", type: "bogus" })).ok, false);
  assert.equal((await sg.traverse({ project_id: "p" })).ok, false);
  assert.equal((await cu.describeSymbol()).ok, false);
  assert.equal((await cu.moduleUnderstanding({ project_id: "p" })).ok, false);
});

// ---------------------------------------------------------------------------
// 17. DB-down degradation (injected failing query seam)
// ---------------------------------------------------------------------------
test("17. DB-down degrades gracefully and fails closed", async () => {
  const boom = async () => { throw new Error("db down"); };
  const built = await sg.buildRelationships({ project_id: "p25-down", version_hash: "v1", dbQuery: boom,
    symbols: [
      { symbol_key: "a", name: "a", file_path: "f.js", start_line: 1,
        evidence: ["import { b } from './b'"] },
      { symbol_key: "b", name: "b", file_path: "f.js", start_line: 2, evidence: ["function b(){}"] },
    ] });
  // Derivation is offline-capable; persistence failure is reported, not thrown.
  assert.equal(built.ok, true);
  assert.ok(built.relationships.length >= 1);
  assert.ok(built.errors.some((e) => /persist/.test(e)));

  const got = await sg.getRelationships({ project_id: "p25-down", dbQuery: boom });
  assert.equal(got.ok, false);
  assert.deepEqual(got.items, []);

  const walked = await sg.traverse({ project_id: "p25-down", symbol_key: "a", dbQuery: boom });
  assert.equal(walked.ok, false);
  assert.ok(Array.isArray(walked.nodes));

  const desc = await cu.describeSymbol({ project_id: "p25-down", symbol_key: "a", dbQuery: boom });
  assert.equal(desc.ok, false);
  const mod = await cu.moduleUnderstanding({ project_id: "p25-down", path: "f.js", dbQuery: boom });
  assert.equal(mod.ok, false);
});

// close pool (exactly once, at the end)
test("close pool", async () => { await core.close(); });
