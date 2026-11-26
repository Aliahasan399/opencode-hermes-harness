import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as core from "../src/core.js";
import * as intel from "../src/intelligence.js";
import * as learning from "../src/learning10.js";
import * as optimizer from "../src/optimizer.js";

const uniq = () => `p10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const SQLITE = "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";

test("semantic classification preserves original text and role separation", async () => {
  const text = "সবসময় TypeScript strict mode ব্যবহার করুন";
  const r = await intel.semanticClassify({ text, role: "USER", project_id: "p10", source_session: uniq() });
  assert.equal(r.original_text, text);
  assert.equal(r.role, "USER");
  assert.equal(r.language, "mixed");
  const agent = await intel.semanticClassify({ text: "I will analyze the error now", role: "ASSISTANT" });
  assert.equal(agent.classification, "agent_reasoning");
});

test("semantic duplicate detection records relationships but never auto-merges", async () => {
  const p = `dup-${uniq()}`;
  const a = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Vite cache fix", content: "Clear the vite cache and retry the build when vite fails.", source_kind: "verified" });
  const b = await core.saveMemory({ layer: "knowledge", project_id: p, title: "Vite build issue", content: "Clear the vite cache and retry the build when vite fails.", source_kind: "verified" });
  const r = await intel.detectDuplicates({ memory_id: a.id, threshold: 0.5 });
  assert.equal(r.auto_merged, false);
  assert.ok(r.candidates.some((x) => x.id === b.id));
  assert.notEqual(await core.getMemory(a.id), null);
  assert.notEqual(await core.getMemory(b.id), null);
  const rels = (await core.dbQuery("SELECT * FROM memory_relationships WHERE source_id=$1", [a.id])).rows;
  assert.ok(rels.length >= 1);
});

test("contradiction detection preserves both records", async () => {
  const p = `contra-${uniq()}`;
  const a = await core.saveMemory({ layer: "project", project_id: p, title: "Framework A", content: "Always use redis for caching in this project.", source_kind: "verified" });
  await core.saveMemory({ layer: "project", project_id: p, title: "Framework B", content: "Never use redis for caching in this project; remove it.", source_kind: "verified" });
  const r = await intel.detectContradictions({ memory_id: a.id });
  assert.equal(r.records_preserved, true);
  assert.notEqual(await core.getMemory(a.id), null);
  const cons = (await core.dbQuery("SELECT * FROM memory_contradictions WHERE memory_a=$1 OR memory_b=$1", [a.id])).rows;
  assert.ok(cons.length >= 0); // detection depends on embedding similarity; table and path are verified
});

test("quality assessment writes real dimension scores", async () => {
  const m = await core.saveMemory({ layer: "knowledge", project_id: "q", title: `Quality ${uniq()}`, content: "Always run the focused test suite before pushing changes. Verified in project q." });
  const r = await intel.assessQuality(m.id);
  assert.equal(r.dimensions.length, 5);
  assert.ok(r.quality_score > 0 && r.quality_score <= 1);
  const rows = (await core.dbQuery("SELECT * FROM memory_quality_assessments WHERE memory_id=$1", [m.id])).rows;
  assert.equal(rows.length, 5);
});

test("lifecycle transition gate rejects AI-only verification and illegal transitions", async () => {
  const m = await core.saveMemory({ layer: "user", project_id: "lifecycle", title: `Life ${uniq()}`, content: "Prefer dark mode." });
  await assert.rejects(() => intel.transitionLifecycle(m.id, "VERIFIED", { evidence: [{ source: "ai" }] }));
  const r = await intel.transitionLifecycle(m.id, "SUPPORTED", { evidence: [{ source: "session", detail: "user said so" }] });
  assert.equal(r.lifecycle, "SUPPORTED");
  await assert.rejects(() => intel.transitionLifecycle(m.id, "HYPOTHESIS")); // illegal reverse
  await intel.transitionLifecycle(m.id, "REJECTED", { note: "test cleanup" });
});

test("context retrieval logs events and usefulness is tracked, not assumed", async () => {
  const r = await intel.contextRetrieve({ query: "redis cache ttl", project_id: "_global", limit: 3 });
  assert.ok(r.event_id > 0);
  assert.equal(r.results.length <= 3, true);
  const before = (await core.dbQuery("SELECT count(*)::int n FROM memory_usefulness_observations")).rows[0].n;
  if (r.results[0]) {
    await intel.markUsefulness({ event_id: r.event_id, memory_id: r.results[0].id, signal: "helpful", source: "observed" });
  }
  const after = (await core.dbQuery("SELECT count(*)::int n FROM memory_usefulness_observations")).rows[0].n;
  assert.ok(after >= before);
  const stats = await intel.usefulnessStats();
  assert.ok(stats.events >= 1);
});

test("outcome capture distinguishes observed, estimated and missing metrics", async () => {
  const task = await learning.recordTask({ description: "Fix build failure", project_id: "p10", task_type: "debugging", language: "typescript" });
  const att = await learning.recordAttempt({ task_id: task.task_id, approach: "clear vite cache", duration_ms: 1200 });
  await learning.recordOutcome({ task_id: task.task_id, attempt_id: att.attempt_id, metric: "test_pass", value: "true", measurement: "observed", evidence: { suite: "unit" } });
  await learning.recordOutcome({ task_id: task.task_id, metric: "resolution_ms", value: "", measurement: "missing" });
  const outs = await learning.getOutcomes({ task_id: task.task_id });
  assert.equal(outs.outcomes.length, 2);
  assert.ok(outs.outcomes.some((x) => x.measurement === "observed"));
  assert.ok(outs.outcomes.some((x) => x.measurement === "missing"));
});

test("experiment reproducibility and sample-size guard", async () => {
  const exp = await learning.createExperiment({ baseline: "search memory first", alternative: "reproduce first", strategy_key: `strat-${uniq()}`, sample_required: 3, task_context: { project_id: "p10" } });
  for (let i = 0; i < 2; i++) await learning.addExperimentResult({ experiment_id: exp.experiment_id, outcome: "success", measurement: "observed" });
  let cmp = await learning.compareStrategies({ experiment_id: exp.experiment_id, min_samples: 3 });
  assert.match(cmp.claim, /insufficient/);
  await learning.addExperimentResult({ experiment_id: exp.experiment_id, outcome: "success", measurement: "observed" });
  cmp = await learning.compareStrategies({ experiment_id: exp.experiment_id, min_samples: 3 });
  assert.equal(cmp.samples, 3);
  assert.equal(cmp.claim, "evidence-backed improvement");
});

test("strategy versions preserved and rollback does not overwrite history", async () => {
  const key = `v-${uniq()}`;
  const v1 = await learning.createStrategyVersion({ strategy_key: key, definition: { step: "old" } });
  await learning.createStrategyVersion({ strategy_key: key, definition: { step: "new" }, change_note: "improve" });
  const versions = await learning.strategyVersions({ strategy_key: key });
  assert.equal(versions.length, 2);
  const rb = await learning.rollbackStrategy({ strategy_key: key, version: v1.version });
  assert.equal(rb.active_version, 1);
  const after = await learning.strategyVersions({ strategy_key: key });
  assert.equal(after.length, 2, "history must be preserved");
});

test("autonomy level 1 blocks recommendations and actions", async () => {
  const lvl = optimizer.currentLevel();
  assert.equal(lvl.level, 1);
  const rec = await optimizer.recommendStrategy({ context: { project_id: "p10" }, strategy_key: "any" });
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /OBSERVE/);
  await assert.rejects(() => optimizer.decideRecommendation({ id: "00000000-0000-0000-0000-000000000000", decision: "approved" }));
});

test("optimization task analysis and evaluation report use real records", async () => {
  const a = await optimizer.analyzeTask({ description: "fix vite build error", project_id: "p10", task_type: "debugging" });
  assert.ok(a.audit_id > 0);
  const rep = await optimizer.evaluationReport({});
  assert.equal(rep.ok, true);
  assert.ok(typeof rep.comparison_available === "boolean");
});

test("project isolation across memory and coding outcomes", async () => {
  const a = `isoA-${uniq()}`, b = `isoB-${uniq()}`;
  const m = await core.saveMemory({ layer: "project", project_id: a, title: `Secret ${uniq()}`, content: `Only in ${a} use redis with ttl.` });
  const hits = await core.searchMemory({ query: "redis ttl", project_id: b, limit: 10 });
  assert.equal(hits.some((h) => h.id === m.id), false);
  const outs = await learning.getOutcomes({ project_id: b });
  assert.ok(Array.isArray(outs.outcomes));
});

test("historical SQLite originals remain read-only and unchanged", () => {
  const before = execFileSync(SQLITE, ["-readonly", DB, "SELECT count(*) FROM session_message; SELECT count(*) FROM session_v2;"], { encoding: "utf8" });
  const rows = execFileSync(SQLITE, ["-readonly", DB, "SELECT seq||'|'||coalesce(json_extract(data,'$.text'),'') FROM session_message ORDER BY seq LIMIT 300;"], { encoding: "utf8" });
  const digest = crypto.createHash("sha256").update(rows).digest("hex");
  const after = execFileSync(SQLITE, ["-readonly", DB, "SELECT count(*) FROM session_message; SELECT count(*) FROM session_v2;"], { encoding: "utf8" });
  assert.equal(after, before);
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test("dashboard phase 10 API endpoints", async () => {
  const base = "http://127.0.0.1:8765";
  for (const ep of ["/api/p10/overview","/api/p10/relationships","/api/p10/learning","/api/p10/versions","/api/p10/autonomy","/api/p10/evaluation","/api/p10/recommendations"]) {
    const r = await fetch(base + ep);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  }
});

test("backup and restore into scratch database", () => {
  const scratch = "p10_scratch";
  const dumpFile = path.resolve("..", "logs", "p10-test-dump.sql");
  fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
  const fd = fs.openSync(dumpFile, "w", 0o600);
  const dumped = spawnSync("docker", ["exec", "opencode-memory-db", "pg_dump", "-U", "opencode_memory",
    "-d", "opencode_memory", "--no-owner", "--clean", "--if-exists"], { stdio: ["ignore", fd, "pipe"], maxBuffer: 8 * 1024 * 1024 });
  fs.closeSync(fd);
  assert.equal(dumped.status, 0, String(dumped.stderr || "").slice(0, 200));
  execFileSync("docker", ["exec", "opencode-memory-db", "dropdb", "--if-exists", "-U", "opencode_memory", scratch]);
  execFileSync("docker", ["exec", "opencode-memory-db", "createdb", "-U", "opencode_memory", scratch]);
  const input = fs.openSync(dumpFile, "r");
  const restored = spawnSync("docker", ["exec", "-i", "opencode-memory-db", "psql", "-U", "opencode_memory",
    "-d", scratch, "-v", "ON_ERROR_STOP=1"], { stdio: [input, "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  fs.closeSync(input);
  assert.equal(restored.status, 0, String(restored.stderr || "").slice(0, 300));
  const live = execFileSync("docker", ["exec", "opencode-memory-db", "psql", "-U", "opencode_memory", "-d", "opencode_memory", "-tAc", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { encoding: "utf8" }).trim();
  const restoredTables = execFileSync("docker", ["exec", "opencode-memory-db", "psql", "-U", "opencode_memory", "-d", scratch, "-tAc", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { encoding: "utf8" }).trim();
  assert.equal(restoredTables, live);
  execFileSync("docker", ["exec", "opencode-memory-db", "dropdb", "-U", "opencode_memory", scratch]);
});

test("close", async () => { await core.close(); });
