// Phase 24 workstream — approval artifact tests: one-time token, hash-only
// persistence, exact binding verification, atomic single-use consumption, replay
// protection, cross-project isolation, bounded reads and secret redaction.
//
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), HARNESS_SEMANTIC_LLM=0.
// Unique project ids; no fixture row is deleted. This module GATES a future
// dispatch but performs NO dispatch, spawns NO process and writes NO source file.
// core.close() is called in the FINAL degradation test and (idempotently) in the
// closing `close pool` test; nothing meaningful runs after that.
//
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase24-approval.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

const RUN = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const projectA = `p24appr-a-${RUN}`;
const projectB = `p24appr-b-${RUN}`;
const listProject = `p24appr-list-${RUN}`;
const redactProject = `p24appr-redact-${RUN}`;

async function load(name) {
  try { return await import(`../src/${name}.js`); }
  catch (e) { throw new Error(`module ${name} unavailable: ${e?.message || e}`); }
}
const srcFile = (name) => path.join(import.meta.dirname, "..", "src",
  name.endsWith(".js") ? name : `${name}.js`);
const stripComments = (s) => String(s || "")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
const blobOf = (v) => typeof v === "string" ? v : JSON.stringify(v ?? {});
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const assertNoCanary = (value, canaries, label) => {
  const s = blobOf(value);
  for (const c of canaries) assert.equal(s.includes(c), false, `${label} leaked ${c.slice(0, 12)}...`);
};

// Fresh binding set per call so tests never share mutable state.
const binding = (over = {}) => ({
  plan_id: `plan-${RUN}`,
  plan_version: "v1",
  plan_hash: `hash-${RUN}`,
  scope: { files: ["src/a.js"], tags: ["p24"] },
  mode: "simulation",
  risk: "medium",
  ...over,
});
const make = async (wa, project_id, over = {}) => {
  const b = binding(over);
  const r = await wa.createApproval({ project_id, ...b });
  assert.equal(r.ok, true, `createApproval failed: ${r.reason || ""}`);
  return { b, r };
};

const fx = {};

test.before(async () => {
  const core = await load("core");
  // Defensive, idempotent schema guard (no-op once migration 022 is applied).
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS workflow_approval (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      plan_id text NOT NULL DEFAULT '',
      plan_version text NOT NULL DEFAULT '',
      plan_hash text NOT NULL DEFAULT '',
      scope_key text NOT NULL DEFAULT '',
      scope jsonb NOT NULL DEFAULT '{}'::jsonb,
      mode text NOT NULL DEFAULT 'simulation',
      risk text NOT NULL DEFAULT 'low',
      approved_by text NOT NULL DEFAULT '',
      token_hash text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      expires_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
  await core.dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS wa_token_idx ON workflow_approval (token_hash)`);
  await core.dbQuery(`CREATE INDEX IF NOT EXISTS wa_project_idx ON workflow_approval (project_id, status, created_at DESC)`);

  fx.sk = `sk-${"a".repeat(32)}`;
  fx.bearer = `Bearer sk-${"b".repeat(32)}`;
  fx.aws = `AKIA${"C".repeat(16)}`;
  fx.canaries = [fx.sk, fx.bearer, fx.aws];
});

// ---------------------------------------------------------------------------
// 1. Exact named exports + default export object.
// ---------------------------------------------------------------------------
test("1. workflowApproval exports exactly the required capabilities", async () => {
  const wa = await load("workflowApproval");
  const names = ["createApproval", "verifyApproval", "consumeApproval", "listApprovals", "revokeApproval"];
  for (const n of names) assert.equal(typeof wa[n], "function", `missing named export ${n}`);
  assert.ok(wa.default && typeof wa.default === "object", "missing default export object");
  for (const n of names) assert.equal(typeof wa.default[n], "function", `missing default.${n}`);
});

// ---------------------------------------------------------------------------
// 2. create returns token once, persists only sha256(token), redacts approval.
// ---------------------------------------------------------------------------
test("2. create returns the token once and stores only its sha256", async (t) => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);

  assert.match(r.token, /^[0-9a-f]{64}$/, "token is 32 random bytes in hex");
  assert.ok(r.approval && typeof r.approval === "object");
  assert.equal(Object.hasOwn(r.approval, "token_hash"), false, "approval must not expose token_hash");
  assert.equal(Object.hasOwn(r.approval, "token"), false, "approval must not expose the token");

  const rows = (await core.dbQuery(
    "SELECT token_hash, scope_key, scope, plan_id, plan_version, plan_hash, mode, risk, status FROM workflow_approval WHERE id=$1",
    [r.approval_id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha(r.token), "persisted token_hash equals sha256(token)");
  assert.equal(rows[0].scope_key, sha(JSON.stringify(b.scope)), "scope_key is sha256 of canonical scope JSON");
  assert.equal(rows[0].plan_id, b.plan_id);
  assert.equal(rows[0].plan_version, b.plan_version);
  assert.equal(rows[0].plan_hash, b.plan_hash);
  assert.equal(rows[0].mode, "simulation");
  assert.equal(rows[0].risk, "medium");
  assert.equal(rows[0].status, "active");
  assert.equal(blobOf(rows).includes(r.token), false, "plaintext token must never be persisted");
});

// ---------------------------------------------------------------------------
// 3. verify succeeds on exact binding match.
// ---------------------------------------------------------------------------
test("3. verifyApproval accepts an exact binding match", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(v.ok, true, `verify failed: ${v.reason || ""}`);
  assert.equal(v.approval.id, r.approval_id);
  assert.equal(Object.hasOwn(v.approval, "token_hash"), false);
  assert.equal(Object.hasOwn(v.approval, "token"), false);
});

// ---------------------------------------------------------------------------
// 4. Every binding field must match exactly.
// ---------------------------------------------------------------------------
test("4. verifyApproval rejects wrong plan/version/hash/scope/mode/risk", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  const badCases = [
    { ...b, plan_id: b.plan_id + "-wrong" },
    { ...b, plan_version: b.plan_version + "-wrong" },
    { ...b, plan_hash: b.plan_hash + "-wrong" },
    { ...b, scope: { files: ["src/other.js"] } },
    { ...b, mode: "real" },
    { ...b, risk: "high" },
  ];
  for (const bad of badCases) {
    const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...bad });
    assert.equal(v.ok, false, `a wrong binding must be rejected: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Wrong token / approval id / project are rejected.
// ---------------------------------------------------------------------------
test("5. verifyApproval rejects wrong token, approval id and project", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  const badToken = await wa.verifyApproval({
    project_id: projectA, approval_id: r.approval_id, token: "f".repeat(64), ...b });
  assert.equal(badToken.ok, false);
  assert.match(badToken.reason, /token/i);
  const badId = await wa.verifyApproval({
    project_id: projectA, approval_id: crypto.randomUUID(), token: r.token, ...b });
  assert.equal(badId.ok, false);
  const badProject = await wa.verifyApproval({
    project_id: projectB, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(badProject.ok, false);
  assert.match(badProject.reason, /not found/i);
});

// ---------------------------------------------------------------------------
// 6. Expired approvals are rejected (verify and consume).
// ---------------------------------------------------------------------------
test("6. expired approval is rejected by verify and consume", async () => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  await core.dbQuery(
    "UPDATE workflow_approval SET expires_at=now() - interval '1 hour' WHERE id=$1", [r.approval_id]);
  const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(v.ok, false);
  assert.match(v.reason, /expired/i);
  const c = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(c.ok, false);
  assert.equal(c.consumed, false);
});

// ---------------------------------------------------------------------------
// 7. Revoke is project-scoped and blocks verification/consumption.
// ---------------------------------------------------------------------------
test("7. revokeApproval blocks use and is idempotent", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  const rv = await wa.revokeApproval({ project_id: projectA, approval_id: r.approval_id, reason: "operator" });
  assert.equal(rv.ok, true);
  assert.equal(rv.revoked, true);
  const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(v.ok, false);
  assert.match(v.reason, /revoked/i);
  const rv2 = await wa.revokeApproval({ project_id: projectA, approval_id: r.approval_id });
  assert.equal(rv2.revoked, false, "revoking twice must not report a second revoke");
  const c = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(c.consumed, false);
});

// ---------------------------------------------------------------------------
// 8. Atomic single-use consumption flips status and timestamps.
// ---------------------------------------------------------------------------
test("8. consumeApproval is single-use and persists consumed state", async (t) => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  const first = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(first.ok, true, `consume failed: ${first.reason || ""}`);
  assert.equal(first.consumed, true);
  const rows = (await core.dbQuery(
    "SELECT status, consumed_at FROM workflow_approval WHERE id=$1", [r.approval_id])).rows;
  assert.equal(rows[0].status, "consumed");
  assert.ok(rows[0].consumed_at, "consumed_at must be set");
  const second = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(second.ok, false);
  assert.equal(second.consumed, false, "a second consume must fail");
});

// ---------------------------------------------------------------------------
// 9. Replay of a consumed approval cannot verify or consume again.
// ---------------------------------------------------------------------------
test("9. replay protection: consumed token cannot verify or consume again", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  assert.equal((await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b })).consumed, true);
  const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(v.ok, false);
  assert.match(v.reason, /consumed/i);
  const replay = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(replay.ok, false);
  assert.equal(replay.consumed, false);
});

// ---------------------------------------------------------------------------
// 10. Project A cannot verify, consume, revoke or list project B's approval.
// ---------------------------------------------------------------------------
test("10. cross-project isolation for verify/consume/revoke/list", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectB);
  const v = await wa.verifyApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(v.ok, false);
  const c = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(c.consumed, false);
  const rv = await wa.revokeApproval({ project_id: projectA, approval_id: r.approval_id });
  assert.equal(rv.revoked, false);
  const list = await wa.listApprovals({ project_id: projectA, limit: 200 });
  assert.equal(list.items.some((x) => x.id === r.approval_id), false, "A must not list B's approval");
  const ownerVerify = await wa.verifyApproval({ project_id: projectB, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(ownerVerify.ok, true, "B's approval must be unaffected by A's attempts");
});

// ---------------------------------------------------------------------------
// 11. Bounded, redacted listing.
// ---------------------------------------------------------------------------
test("11. listApprovals is bounded and redacted", async () => {
  const wa = await load("workflowApproval");
  for (let i = 0; i < 4; i += 1) await make(wa, listProject, { plan_hash: `h-${RUN}-${i}` });
  const two = await wa.listApprovals({ project_id: listProject, limit: 2 });
  assert.equal(two.ok, true);
  assert.ok(two.items.length <= 2, `limit 2 returned ${two.items.length}`);
  const many = await wa.listApprovals({ project_id: listProject, limit: 1000 });
  assert.ok(many.items.length <= 200, "limit must be clamped to 200");
  for (const item of many.items) {
    assert.equal(Object.hasOwn(item, "token"), false);
    assert.equal(Object.hasOwn(item, "token_hash"), false);
  }
  const empty = await wa.listApprovals({ project_id: `p24appr-empty-${RUN}` });
  assert.deepEqual(empty.items, []);
});

// ---------------------------------------------------------------------------
// 12. sk-/Bearer/AKIA canaries never appear in results, DB or audits.
// ---------------------------------------------------------------------------
test("12. credential-like strings are redacted everywhere", async (t) => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  assert.doesNotMatch(core.redact(fx.sk), /sk-aaa/);
  assert.doesNotMatch(core.redact(fx.aws), /AKIACCC/);

  const scope = { files: ["src/a.js"], note: `${fx.sk} ${fx.aws}` };
  const r = await wa.createApproval({
    project_id: redactProject,
    plan_id: `p-${RUN}`,
    plan_version: "v1",
    plan_hash: `h-${RUN}`,
    scope,
    mode: "simulation",
    risk: "low",
    approved_by: fx.bearer,
    request: fx.sk,
  });
  assert.equal(r.ok, true, r.reason);
  assertNoCanary(r, fx.canaries, "create result");

  const rows = (await core.dbQuery("SELECT * FROM workflow_approval WHERE id=$1", [r.approval_id])).rows;
  assertNoCanary(rows, fx.canaries, "stored approval row");
  const list = await wa.listApprovals({ project_id: redactProject, limit: 50 });
  assertNoCanary(list, fx.canaries, "listed approvals");
  const audits = (await core.dbQuery(
    "SELECT * FROM audit_log WHERE resource=$1 LIMIT 50", [redactProject])).rows;
  assertNoCanary(audits, fx.canaries, "audit_log");
  const v = await wa.verifyApproval({
    project_id: redactProject, approval_id: r.approval_id, token: r.token,
    plan_id: `p-${RUN}`, plan_version: "v1", plan_hash: `h-${RUN}`,
    scope, mode: "simulation", risk: "low",
  });
  assertNoCanary(v, fx.canaries, "verify result");
});

// ---------------------------------------------------------------------------
// 13. Invalid inputs fail closed without throwing.
// ---------------------------------------------------------------------------
test("13. invalid inputs fail closed without throwing", async () => {
  const wa = await load("workflowApproval");
  const closed = async (fn, label) => {
    let r;
    try { r = await fn(); }
    catch (e) { assert.fail(`${label} must not throw: ${e?.message || e}`); }
    assert.equal(r?.ok, false, `${label} must return ok:false`);
    return r;
  };
  const b = binding();
  await closed(() => wa.createApproval(), "create() with no args");
  await closed(() => wa.createApproval({ project_id: "_global", ...b }), "create(_global)");
  await closed(() => wa.createApproval({ project_id: "", ...b }), "create(empty project)");
  await closed(() => wa.createApproval({ project_id: projectA, ...b, plan_hash: "" }), "create(empty hash)");
  await closed(() => wa.createApproval({ project_id: projectA, ...b, mode: "bogus" }), "create(bad mode)");
  await closed(() => wa.createApproval({ project_id: projectA, ...b, risk: "critical" }), "create(bad risk)");
  await closed(() => wa.createApproval({ project_id: projectA, ...b, scope: ["x"] }), "create(array scope)");
  await closed(() => wa.verifyApproval(), "verify() with no args");
  const c = await wa.consumeApproval();
  assert.equal(c.ok, false);
  assert.equal(c.consumed, false);
  await closed(() => wa.listApprovals({ project_id: "_global" }), "list(_global)");
  const rv = await wa.revokeApproval({ project_id: "_global", approval_id: "x" });
  assert.equal(rv.ok, false);
  assert.equal(rv.revoked, false);
});

// ---------------------------------------------------------------------------
// 14. Explicit gate-only note/claim (no dispatch).
// ---------------------------------------------------------------------------
test("14. results carry an explicit gate-only note and NO_RUNTIME_CLAIM", async () => {
  const wa = await load("workflowApproval");
  const { b, r } = await make(wa, projectA);
  assert.match(r.note, /no dispatch|gates a future dispatch/i);
  assert.equal(r.claim, "NO_RUNTIME_CLAIM");
  const c = await wa.consumeApproval({ project_id: projectA, approval_id: r.approval_id, token: r.token, ...b });
  assert.equal(c.claim, "NO_RUNTIME_CLAIM");
});

// ---------------------------------------------------------------------------
// 15. Static safety check: no spawn/exec, source writes, git or destructive ops.
// ---------------------------------------------------------------------------
test("15. source is LEVEL 1 safe (no spawn/exec/writes/git/destructive SQL)", () => {
  const src = stripComments(fs.readFileSync(srcFile("workflowApproval"), "utf8"));
  assert.doesNotMatch(src, /node:child_process|require\(\s*["']child_process["']\s*\)|from\s+["']child_process["']/);
  assert.doesNotMatch(src, /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/);
  assert.doesNotMatch(src, /\bshell\s*:\s*true/);
  assert.doesNotMatch(src,
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|unlinkSync|unlink|rmSync|rm|renameSync|rename|copyFileSync|copyFile|truncateSync|truncate)\s*\(/);
  assert.doesNotMatch(src, /\bgit\s+(?:push|commit|reset|checkout|clean)\b/);
  assert.doesNotMatch(src, /\b(?:DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.match(src, /createHash\(\s*["']sha256["']\s*\)/, "hash-only token storage expected");
  assert.match(src, /randomBytes\s*\(/, "random token generation expected");
});

// ---------------------------------------------------------------------------
// 16. Expiry bounds and 24h default.
// ---------------------------------------------------------------------------
test("16. expiry is clamped and defaults to 24h", async () => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  const b = binding();
  const def = await wa.createApproval({ project_id: projectA, ...b });
  const defRow = (await core.dbQuery("SELECT expires_at FROM workflow_approval WHERE id=$1", [def.approval_id])).rows[0];
  const defMs = new Date(defRow.expires_at).getTime() - Date.now();
  assert.ok(defMs > 24 * 3600 * 1000 - 10000 && defMs <= 24 * 3600 * 1000 + 1000, `default expiry was ${defMs}ms`);

  const huge = await wa.createApproval({ project_id: projectA, ...b, expires_in_ms: 400 * 24 * 3600 * 1000 });
  const hugeRow = (await core.dbQuery("SELECT expires_at FROM workflow_approval WHERE id=$1", [huge.approval_id])).rows[0];
  const hugeMs = new Date(hugeRow.expires_at).getTime() - Date.now();
  assert.ok(hugeMs <= 30 * 24 * 3600 * 1000 + 1000, "expiry must be clamped to 30 days");

  const beforeTiny = Date.now();
  const tiny = await wa.createApproval({ project_id: projectA, ...b, expires_in_ms: 1 });
  const tinyRow = (await core.dbQuery("SELECT expires_at FROM workflow_approval WHERE id=$1", [tiny.approval_id])).rows[0];
  const tinyMs = new Date(tinyRow.expires_at).getTime() - beforeTiny;
  assert.ok(tinyMs >= 900, `expiry must be clamped up to at least ~1s (was ${tinyMs}ms)`);
});

// ---------------------------------------------------------------------------
// 17. Default mode is simulation; real-mode approvals still work when declared.
// ---------------------------------------------------------------------------
test("17. default mode is simulation and cannot be used as real", async () => {
  const wa = await load("workflowApproval");
  const b = binding();
  const def = await wa.createApproval({ project_id: projectA, plan_id: b.plan_id,
    plan_version: b.plan_version, plan_hash: b.plan_hash, scope: b.scope, risk: b.risk });
  assert.equal(def.ok, true, def.reason);
  const asReal = await wa.verifyApproval({ project_id: projectA, approval_id: def.approval_id,
    token: def.token, plan_id: b.plan_id, plan_version: b.plan_version,
    plan_hash: b.plan_hash, scope: b.scope, mode: "real", risk: b.risk });
  assert.equal(asReal.ok, false, "a simulation approval must not verify as real");
  const asSim = await wa.verifyApproval({ project_id: projectA, approval_id: def.approval_id,
    token: def.token, plan_id: b.plan_id, plan_version: b.plan_version,
    plan_hash: b.plan_hash, scope: b.scope, mode: "simulation", risk: b.risk });
  assert.equal(asSim.ok, true);

  const real = await wa.createApproval({ project_id: projectA, ...b, mode: "real", risk: "high" });
  const realVerify = await wa.verifyApproval({ project_id: projectA, approval_id: real.approval_id,
    token: real.token, ...b, mode: "real", risk: "high" });
  assert.equal(realVerify.ok, true, "a declared real approval verifies with matching mode/risk");
});

// ---------------------------------------------------------------------------
// 18. FINAL: graceful degradation when the database is down. No throw.
// ---------------------------------------------------------------------------
test("18. FINAL: verify/list/consume/revoke degrade gracefully after core.close()", async () => {
  const core = await load("core");
  const wa = await load("workflowApproval");
  await core.close(); // the authoritative close for this file

  const v = await wa.verifyApproval({ project_id: projectA, approval_id: "x", token: "x", ...binding() });
  assert.equal(v.ok, false);
  assert.ok(typeof v.reason === "string");
  const list = await wa.listApprovals({ project_id: projectA, limit: 5 });
  assert.ok(Array.isArray(list.items), "list must degrade to an array, not throw");
  const c = await wa.consumeApproval({ project_id: projectA, approval_id: "x", token: "x", ...binding() });
  assert.equal(c.ok, false);
  assert.equal(c.consumed, false);
  const rv = await wa.revokeApproval({ project_id: projectA, approval_id: "x" });
  assert.equal(rv.ok, false);
  assert.equal(rv.revoked, false);
});

// ---------------------------------------------------------------------------
// Closing pool test (idempotent): nothing meaningful runs after this.
// ---------------------------------------------------------------------------
test("close pool", async () => {
  const core = await load("core");
  try { await core.close(); } catch { /* already closed by the FINAL test */ }
});
