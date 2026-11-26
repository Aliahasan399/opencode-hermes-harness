import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import * as core from "../src/core.js";
import * as roles from "../src/roles.js";
import * as q from "../src/patterns-v2.js";
import * as strategy from "../src/strategy.js";

const uniq = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const SQLITE = "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";

test("role extraction separates user, assistant and tool text", () => {
  assert.equal(roles.classifyText("Always use TypeScript strict mode", "USER"), "user_preference");
  assert.equal(roles.classifyText("আমি সবসময় strict mode ব্যবহার করি", "USER"), "user_preference");
  assert.equal(roles.classifyText("that does not work, use X instead", "USER"), "user_correction");
  assert.equal(roles.classifyText("I'll search the web for the latest docs", "ASSISTANT"), "agent_reasoning");
  assert.equal(roles.classifyText("tool output: error ENOENT", "TOOL"), null);
});

test("bengali and mixed clustering produces non-placeholder tokens", () => {
  const en = q.clusterKey("repeated_failure", "error: build failed with vite");
  const bn = q.clusterKey("user_preference", "সবসময় TypeScript strict mode ব্যবহার করুন");
  const mixed = q.clusterKey("successful_solution", "error fixed by clearing vite cache");
  assert.ok(en.split(":")[1].split("|").length >= 3);
  assert.ok(bn.split(":")[1].split("|").length >= 2);
  assert.ok(mixed.split(":")[1].split("|").length >= 3);
  assert.notEqual(bn, en);
});

test("unverified hypothesis is never auto-promoted from a single session", async () => {
  const sid = `single-${uniq()}`;
  await core.dbQuery(
    `INSERT INTO session_index (id,project_id,title,summary,summary_roles,message_count,time_updated)
     VALUES ($1,$2,$3,$4,$5,1,now())`,
    [sid, "qproj", "single", "", `USER: always use pnpm in this project`],
  );
  const r = await q.analyzeQuality({ limit: 500, force: true });
  assert.ok(r.sessions_analyzed >= 1);
  const rows = (await core.dbQuery(
    `SELECT status, verified, distinct_sessions FROM pattern WHERE $1 = ANY(sessions)`, [sid],
  )).rows;
  assert.ok(rows.length >= 1);
  for (const x of rows) {
    if (x.distinct_sessions < 2) {
      assert.equal(x.verified, false, "single-session pattern must not be verified");
      assert.equal(x.status, "hypothesis");
    }
  }
});

test("verification requires multiple distinct sessions and an outcome marker", async () => {
  const p = `verify-${uniq()}`;
  const a = `v1-${uniq()}`, b = `v2-${uniq()}`;
  for (const id of [a, b]) {
    await core.dbQuery(
      `INSERT INTO session_index (id,project_id,title,summary,summary_roles,message_count,time_updated)
       VALUES ($1,$2,$3,$4,$5,1,now())`,
      [id, p, "outcome", "", `ASSISTANT: fixed by clearing the vite cache`],
    );
  }
  await q.analyzeQuality({ limit: 500, force: true });
  const rows = (await core.dbQuery(
    `SELECT status, verified, distinct_sessions, description FROM pattern
     WHERE kind='successful_solution' AND ($1::text = ANY(sessions) OR $2::text = ANY(sessions))`, [a, b],
  )).rows;
  const match = rows.find((x) => x.distinct_sessions >= 2);
  assert.ok(match, "multi-session success pattern expected");
  assert.equal(match.verified, true);
  assert.equal(match.status, "verified_fact");
});

test("false-positive feedback rejects a pattern without deleting it", async () => {
  const p = (await core.dbQuery("SELECT id FROM pattern LIMIT 1")).rows[0];
  const r = await q.feedback(p.id, "not_useful", "agent reasoning, not a user preference");
  assert.equal(r.verdict, "not_useful");
  const after = await core.getMemory(p.id).catch(() => null);
  const row = (await core.dbQuery("SELECT status,verified FROM pattern WHERE id=$1", [p.id])).rows[0];
  assert.equal(row.status, "rejected_false_positive");
  assert.equal(row.verified, false);
  assert.ok(after === null); // patterns are not memories; memory table untouched
});

test("strategy observation stores measured values only", async () => {
  const sid = `obs-${uniq()}`;
  await strategy.recordObservation({ session_id: sid, project_id: "p", tool_name: "shell", duration_ms: 1234, exit_code: 0, is_error: false });
  await strategy.recordObservation({ session_id: sid, project_id: "p", tool_name: "shell", duration_ms: 900, exit_code: 1, is_error: true, retry_of: "shell:{}" });
  const s = await strategy.observationStats({ session_id: sid });
  assert.equal(s.observations, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.retries, 1);
  assert.ok(s.avg_ms > 0);
});

test("strategy evaluation claims confirmation only with evidence", async () => {
  const r = await strategy.evaluateStrategies({});
  assert.ok(r.ok);
  assert.ok(["evidence-backed", "no confirmed improvement"].includes(r.claim));
  const rows = await strategy.strategyList({});
  for (const x of rows) {
    if (!x.outcome_confirmed) assert.equal(x.successful, false);
  }
});

test("retrieval across sessions and project isolation", async () => {
  const p1 = `iso-a-${uniq()}`, p2 = `iso-b-${uniq()}`;
  const m1 = await core.saveMemory({ layer: "project", project_id: p1, title: "Cache policy", content: `Use redis cache in ${p1} with ttl.` });
  const m2 = await core.saveMemory({ layer: "project", project_id: p2, title: "Cache policy", content: `Use memory cache in ${p2} with ttl.` });
  const hits = await core.searchMemory({ query: "redis cache ttl", project_id: p1, limit: 5 });
  assert.ok(hits.some((h) => h.id === m1.id));
  assert.equal(hits.some((h) => h.id === m2.id), false);
  await core.deleteMemory(m1.id, true);
  await core.deleteMemory(m2.id, true);
});

test("historical originals preserved: sqlite read-only counts and digest stable", () => {
  const q1 = "SELECT count(*) FROM session_message; SELECT count(*) FROM session_v2;";
  const q2 = "SELECT seq||'|'||coalesce(json_extract(data,'$.text'),'') FROM session_message ORDER BY seq LIMIT 500;";
  const digest = () => {
    const rows = execFileSync(SQLITE, ["-readonly", DB, q2], { encoding: "utf8" });
    return crypto.createHash("sha256").update(rows).digest("hex");
  };
  const before = execFileSync(SQLITE, ["-readonly", DB, q1], { encoding: "utf8" });
  const digestBefore = digest();
  const s = (() => { try { return roles.extractSession(DB, "ses_e0c5dc96affea9FVdcLqAbXq8K", 10); } catch { return []; } })();
  assert.ok(Array.isArray(s));
  const after = execFileSync(SQLITE, ["-readonly", DB, q1], { encoding: "utf8" });
  assert.equal(after, before);
  assert.equal(digest(), digestBefore);
});

test("dashboard phase 9 API behavior", async () => {
  const base = "http://127.0.0.1:8765";
  for (const ep of ["/api/quality", "/api/strategy", "/api/strategy/stats", "/api/coverage"]) {
    const r = await fetch(base + ep);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  }
  const raw = await (await fetch(`${base}/api/sessions/ses_e0c5dc96affea9FVdcLqAbXq8K/raw?limit=2`)).json();
  assert.equal(raw.ok, true);
  assert.ok(raw.returned <= 2);
  assert.ok(raw.total >= raw.returned);
});

test("existing functionality: save, search, backup endpoint", async () => {
  const m = await core.saveMemory({ layer: "knowledge", project_id: "regress", title: `Regression ${uniq()}`, content: "Regression check for hybrid retrieval with pgvector." });
  const hits = await core.searchMemory({ query: "hybrid retrieval pgvector", project_id: "regress", limit: 5 });
  assert.ok(hits.some((h) => h.id === m.id));
  const b = await (await fetch("http://127.0.0.1:8765/api/backup", { method: "POST" })).json();
  assert.equal(b.ok, true);
  await core.deleteMemory(m.id, true);
});

test("close", async () => { await core.close(); });
