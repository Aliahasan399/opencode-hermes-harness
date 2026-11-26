import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as core from "../src/core.js";
import * as patterns from "../src/patterns.js";
import * as consolidation from "../src/consolidation.js";

const uniq = () => `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DB_USER = "opencode_memory";

test("cross-session repeated failure and successful solution detection", async () => {
  const p = `pattern-${uniq()}`;
  const s1 = `s1-${uniq()}`, s2 = `s2-${uniq()}`;
  const summary = "USER: error: build failed with vite\nASSISTANT: fixed by clearing the vite cache and retrying";
  for (const id of [s1, s2]) {
    await core.dbQuery(
      `INSERT INTO session_index (id,project_id,title,summary,message_count,time_updated)
       VALUES ($1,$2,$3,$4,4,now())`, [id, p, "Build issue", summary],
    );
  }
  await core.dbQuery("DELETE FROM analysis_state WHERE session_id = ANY($1::text[])", [[s1, s2]]);
  const r = await patterns.analyzePatterns({ limit: 500, project_id: p, force: true });
  assert.ok(r.sessions_analyzed >= 2);
  const all = await patterns.listPatterns({ project_id: p, limit: 100 });
  const failure = all.find((x) => x.kind === "repeated_failure" && x.occurrences >= 2);
  const solution = all.find((x) => x.kind === "successful_solution" && x.occurrences >= 2);
  assert.ok(failure, "repeated failure pattern expected");
  assert.ok(solution, "successful solution pattern expected");
  assert.ok(failure.sessions.includes(s1) && failure.sessions.includes(s2));
});

test("incremental analysis skips unchanged sessions", async () => {
  // Isolate to this test's project so parallel test files cannot add new sessions.
  const p = `skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const sid of [`s1-${p}`, `s2-${p}`]) {
    await core.dbQuery(
      `INSERT INTO session_index (id,project_id,title,summary,message_count,time_updated)
       VALUES ($1,$2,'skip test','USER: incremental skip check',1,now()) ON CONFLICT (id) DO NOTHING`, [sid, p]);
  }
  await patterns.analyzePatterns({ project_id: p, limit: 500, force: true });
  const r = await patterns.analyzePatterns({ project_id: p, limit: 500, force: false });
  assert.ok(r.sessions_skipped >= 2);
});

test("analytics and learning activity", async () => {
  const a = await patterns.analytics();
  assert.ok(a.sessions >= 1 && a.memories >= 1 && a.patterns >= 1);
  const act = await patterns.learningActivity({ limit: 10 });
  assert.ok(Array.isArray(act) && act.length >= 1);
});

test("contradiction detection and manual resolution", async () => {
  const p = `contra-${uniq()}`;
  const a = await core.saveMemory({ layer: "user", project_id: p, title: "Use X", content: "Always use SET NX PX for the redis lock here.", source_kind: "verified", confidence: 0.9 });
  const b = await core.saveMemory({ layer: "user", project_id: p, title: "Avoid X", content: "Never use SET NX PX for the redis lock here; avoid it.", source_kind: "attempt", confidence: 0.4 });
  await consolidation.scanConsolidation();
  const s = (await consolidation.listSuggestions({ status: "pending", kind: "contradiction" })).find((x) => x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(s, "contradiction suggestion expected");
  assert.match(s.description, /A \(|B \(/);
  const r = await consolidation.resolveSuggestion(s.id, { status: "rejected", note: "test resolution" });
  assert.equal(r.status, "rejected");
  assert.notEqual(await core.getMemory(a.id), null, "conflicting memories must not be deleted");
  assert.notEqual(await core.getMemory(b.id), null);
});

test("merge approval keeps versions and soft-expires secondary", async () => {
  const p = `merge-${uniq()}`;
  const a = await core.saveMemory({ layer: "project", project_id: p, title: "Cache: redis", content: "Use redis caching with TTL for this project.", confidence: 0.8 });
  const b = await core.saveMemory({ layer: "project", project_id: p, title: "Redis cache", content: "Use redis caching with TTL for this project.", confidence: 0.6 });
  await consolidation.scanConsolidation();
  const s = (await consolidation.listSuggestions({ status: "pending", kind: "merge" })).find((x) => x.memory_ids.includes(a.id) && x.memory_ids.includes(b.id));
  assert.ok(s, "merge suggestion expected");
  const r = await consolidation.resolveSuggestion(s.id, { status: "approved", note: "test merge" });
  assert.ok(r.primary && r.secondary);
  const primary = await core.getMemory(r.primary);
  const secondary = await core.getMemory(r.secondary);
  assert.ok(primary.version >= 2);
  assert.ok(secondary.valid_until, "secondary should be soft-expired");
  const versions = await consolidation.memoryVersions(r.primary);
  assert.ok(versions.length >= 1);
});

test("session history browsing and project isolation", async () => {
  const p = `browse-${uniq()}`;
  const sid = `b-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO session_index (id,project_id,title,summary,message_count,time_updated)
     VALUES ($1,$2,$3,$4,3,now())`, [sid, p, "Browse me", "decided to use postgres"],
  );
  const m = await core.saveMemory({ layer: "session", project_id: p, title: "Decision", content: "decided to use postgres", source_session: sid });
  const list = await core.listSessions({ project_id: p });
  assert.ok(list.some((s) => s.id === sid));
  const detail = await core.sessionDetail(sid);
  assert.equal(detail.id, sid);
  assert.ok(detail.memories.some((x) => x.id === m.id));
  const other = await core.listSessions({ project_id: `other-${uniq()}` });
  assert.equal(other.some((s) => s.id === sid), false);
});

test("dashboard API search and filtering", async () => {
  const base = "http://127.0.0.1:8765";
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.pgvector, true);
  const a = await (await fetch(`${base}/api/analytics`)).json();
  assert.ok(a.sessions >= 1);
  const pats = await (await fetch(`${base}/api/patterns?kind=repeated_failure`)).json();
  assert.ok(Array.isArray(pats.patterns));
  const s = await (await fetch(`${base}/api/sessions?limit=5`)).json();
  assert.ok(Array.isArray(s.sessions));
  const search = await (await fetch(`${base}/api/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "redis cache", limit: 3 }),
  })).json();
  assert.ok(Array.isArray(search.results));
});

test("backup and restore into scratch database", async () => {
  const base = "http://127.0.0.1:8765";
  const b = await (await fetch(`${base}/api/backup`, { method: "POST" })).json();
  assert.equal(b.ok, true);
  assert.ok(fs.existsSync(b.file));
  assert.match(fs.readFileSync(b.file, "utf8"), /CREATE TABLE/);
  const scratch = "opencode_memory_verify";
  execFileSync("docker", ["exec", "opencode-memory-db", "dropdb", "--if-exists", "-U", DB_USER, scratch]);
  execFileSync("docker", ["exec", "opencode-memory-db", "createdb", "-U", DB_USER, scratch]);
  const sql = fs.readFileSync(b.file, "utf8");
  execFileSync("docker", ["exec", "-i", "opencode-memory-db", "psql", "-U", DB_USER, "-d", scratch, "-v", "ON_ERROR_STOP=1"], { input: sql, maxBuffer: 32 * 1024 * 1024 });
  const live = Number(execFileSync("docker", ["exec", "opencode-memory-db", "psql", "-U", DB_USER, "-d", "opencode_memory", "-tAc", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { encoding: "utf8" }).trim());
  const n = execFileSync("docker", ["exec", "opencode-memory-db", "psql", "-U", DB_USER, "-d", scratch, "-tAc", "SELECT count(*) FROM pg_tables WHERE schemaname='public'"], { encoding: "utf8" }).trim();
  assert.equal(Number(n), live, "restored database should have the same table count as live");
  execFileSync("docker", ["exec", "opencode-memory-db", "dropdb", "-U", DB_USER, scratch]);
});

test("close", async () => { await core.close(); });
