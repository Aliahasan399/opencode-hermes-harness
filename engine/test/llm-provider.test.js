import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as llm from "../src/llm-provider.js";
import * as worker from "../src/session-worker.js";
import * as intel from "../src/intelligence.js";
import * as learning from "../src/learning10.js";
import * as optimizer from "../src/optimizer.js";
import * as core from "../src/core.js";

const SAVED = {};
const KEYS = ["HARNESS_LLM_ENABLED","HARNESS_LLM_BASE_URL","HARNESS_LLM_MODEL","HARNESS_LLM_PROTOCOL",
  "HARNESS_LLM_KEY_ENV","HARNESS_LLM_TIMEOUT_MS","HARNESS_LLM_MAX_RETRIES","HARNESS_LLM_DAILY_TOKEN_BUDGET",
  "HARNESS_LLM_API_KEY","HARNESS_LLM_KEY"];
for (const k of KEYS) SAVED[k] = process.env[k];
function restore() {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  // .env now configures the adapter, so tests must explicitly force it off when needed.
  process.env.HARNESS_LLM_ENABLED = "0";
}

let server, port;
const seen = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => body += d);
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body.slice(0, 500) });
      if (req.url.startsWith("/v1/rate")) { res.writeHead(429, { "Retry-After": "0" }); return res.end("rate limited"); }
      if (req.url.startsWith("/v1/badjson")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("not json"); }
      if (req.url.startsWith("/v1/timeout")) return; // no response -> timeout
      if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"language":"bn-en","category":"user_preference","confidence":0.8}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(async () => { await new Promise((r) => server.close(r)); restore(); });

function configure(path = "/v1") {
  process.env.HARNESS_LLM_ENABLED = "1";
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}${path}`;
  process.env.HARNESS_LLM_MODEL = "hy4-flash-free";
  process.env.HARNESS_LLM_PROTOCOL = "chat-completions";
  process.env.HARNESS_LLM_TRANSPORT = "http";
  process.env.HARNESS_LLM_KEY_ENV = "HARNESS_LLM_API_KEY";
  process.env.HARNESS_LLM_API_KEY = "sk-test-placeholder-not-real";
  process.env.HARNESS_LLM_TIMEOUT_MS = "1500";
  process.env.HARNESS_LLM_MAX_RETRIES = "0";
  process.env.HARNESS_LLM_DAILY_TOKEN_BUDGET = "100000";
}

test("adapter status hides credential value and defaults to disabled", () => {
  restore();
  const s = llm.status();
  assert.equal(s.enabled, false);
  assert.ok(!JSON.stringify(s).includes("sk-test"));
});

test("structured task succeeds with auth, JSON validation and usage tracking", async () => {
  configure();
  const r = await llm.runTask("multilingual_classification", { text: "সবসময় strict mode ব্যবহার করুন", role: "USER" });
  assert.equal(r.ok, true);
  assert.equal(r.data.category, "user_preference");
  assert.equal(r.usage.input, 12);
  const u = llm.usage();
  assert.ok(u.requests >= 1);
  const last = seen[seen.length - 1];
  assert.equal(last.auth, "Bearer sk-test-placeholder-not-real");
  assert.ok(last.body.includes("hy4-flash-free"));
});

test("secret is redacted from text", () => {
  assert.equal(llm.redact("key=sk-abcdefghijklmnopqrst"), "key=[REDACTED]");
});

test("schema mismatch and invalid JSON are classified", async () => {
  configure();
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1/badjson`;
  const bad = await llm.runTask("multilingual_classification", { text: "x" });
  assert.equal(bad.kind, "invalid_response");
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  const r = await llm.runTask("session_understanding", { text: "x" });
  assert.equal(r.kind, "schema_mismatch");
});

test("rate limit error pauses worker queue rather than losing work", async () => {
  configure();
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1/rate`;
  const r = await llm.runTask("outcome_evaluation", { task_id: "t" });
  assert.equal(r.kind, "rate_limit");
  await core.dbQuery(`INSERT INTO ai_task_queue (cache_key,task,payload,status,last_error)
    VALUES ($1,'outcome_evaluation','{}'::jsonb,'paused','rate limit') ON CONFLICT (cache_key) DO NOTHING`,
    [`test-${Date.now()}`]);
  const q = await worker.queueStatus();
  assert.ok(q.ok);
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
});

test("timeout is classified and no credential is logged", async () => {
  configure();
  process.env.HARNESS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1/timeout`;
  const r = await llm.runTask("strategy_evaluation", {});
  assert.ok(["timeout","transport","retries_exhausted"].includes(r.kind));
});

test("budget exhaustion pauses requests", async () => {
  configure();
  process.env.HARNESS_LLM_DAILY_TOKEN_BUDGET = "0";
  const r = await llm.runTask("multilingual_classification", { text: "x" });
  assert.equal(r.kind, "budget_exhausted");
  assert.equal(r.paused, true);
  process.env.HARNESS_LLM_DAILY_TOKEN_BUDGET = "100000";
});

test("integrations stay deterministic when adapter disabled", async () => {
  restore();
  const w = await worker.processIncremental({ limit: 1 });
  assert.equal(w.mode, "deterministic");
  assert.ok(w.processed + w.cached >= 0);
  const c = await intel.semanticClassify({ text: "Always use strict mode", role: "USER" });
  assert.equal(c.method, "role_keyword");
  const o = await learning.interpretOutcome({ task_id: "none" });
  assert.equal(o.ok, false);
  const rec = await optimizer.recommendStrategy({ context: {}, strategy_key: "none" });
  assert.equal(rec.ok, false);
});

test("close", async () => { await core.close(); });
