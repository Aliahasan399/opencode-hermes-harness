import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as core from "../src/core.js";
import * as transcript from "../src/transcript.js";
import * as sem from "../src/semanticUnderstanding.js";

const uniq = () => `p13a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const KEYS = ["HARNESS_LLM_ENABLED","HARNESS_LLM_BASE_URL","HARNESS_LLM_MODEL","HARNESS_LLM_PROTOCOL",
  "HARNESS_LLM_KEY_ENV","HARNESS_LLM_API_KEY","HARNESS_LLM_TIMEOUT_MS","HARNESS_LLM_MAX_RETRIES","HARNESS_LLM_DAILY_TOKEN_BUDGET"];
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let server, port, mode = "good";
test.before(async () => {
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => b += d);
    req.on("end", () => {
      if (mode === "fail") { res.writeHead(500); return res.end("boom"); }
      if (mode === "bad") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: "not json" } }], usage: {} })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [
        { kind: "objective", text: "Add a focused test for the calculator", confidence: 0.9, evidence: "USER line" },
        { kind: "error_cause", text: "Missing dependency caused the failure", confidence: 0.8, evidence: "TOOL line" },
      ] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});
function enable() {
  Object.assign(process.env, { HARNESS_LLM_ENABLED: "1", HARNESS_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    HARNESS_LLM_MODEL: "test-model", HARNESS_LLM_PROTOCOL: "chat-completions", HARNESS_LLM_KEY_ENV: "HARNESS_LLM_API_KEY",
    HARNESS_LLM_API_KEY: "sk-test", HARNESS_LLM_TIMEOUT_MS: "2000", HARNESS_LLM_MAX_RETRIES: "0", HARNESS_LLM_DAILY_TOKEN_BUDGET: "100000",
    HARNESS_LLM_TRANSPORT: "http", HARNESS_SEMANTIC_LLM: "1" });
}
function disable() { process.env.HARNESS_LLM_ENABLED = "0"; process.env.HARNESS_SEMANTIC_LLM = "0"; }

function seed(sid) {
  transcript.resetSequenceCache();
  transcript.appendLine({ session_id: sid, role: "USER", text: `Add a focused test for the calculator in ${sid}` });
  transcript.appendLine({ session_id: sid, role: "ASSISTANT", text: `fixed the missing dependency in ${sid}` });
}

test("1. semantic analysis with a working API stores interpretations only", async () => {
  enable(); mode = "good";
  const sid = `good-${uniq()}`; seed(sid);
  const r = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  assert.equal(r.mode, "llm");
  const rows = (await core.dbQuery("SELECT attribution,source,confidence FROM semantic_observation WHERE session_id=$1", [sid])).rows;
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((x) => x.attribution === "interpreted" && x.source === "llm"));
  assert.ok(rows.every((x) => x.confidence <= 0.7));
});

test("2. API failure falls back to deterministic without losing data", async () => {
  enable(); mode = "fail";
  const sid = `fail-${uniq()}`; seed(sid);
  const r = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  assert.equal(r.mode, "deterministic_fallback");
  const rows = (await core.dbQuery("SELECT source,attribution FROM semantic_observation WHERE session_id=$1", [sid])).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.source === "deterministic"));
});

test("3. invalid structured output falls back safely", async () => {
  enable(); mode = "bad";
  const sid = `bad-${uniq()}`; seed(sid);
  const r = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  assert.ok(["deterministic_fallback", "deterministic"].includes(r.mode));
  assert.ok(r.ok);
});

test("4-5. incremental idempotency and cache", async () => {
  disable();
  const sid = `idem-${uniq()}`; seed(sid);
  const a = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  const b = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  assert.equal(b.cached, true);
  const n = (await core.dbQuery("SELECT count(*)::int n FROM semantic_observation WHERE session_id=$1", [sid])).rows[0].n;
  assert.equal(n, a.observations);
});

test("6. deterministic mode remains operational with adapter disabled", async () => {
  disable();
  const sid = `off-${uniq()}`; seed(sid);
  const r = await sem.analyzeSession({ session_id: sid, project_id: "p13" });
  assert.equal(r.mode, "deterministic");
  const rows = (await core.dbQuery("SELECT attribution FROM semantic_observation WHERE session_id=$1", [sid])).rows;
  assert.ok(rows.every((x) => x.attribution === "observed"));
});

test("7. project isolation of semantic observations", async () => {
  disable();
  const sid = `iso-${uniq()}`; seed(sid);
  await sem.analyzeSession({ session_id: sid, project_id: "p13-iso-a" });
  const list = await sem.listObservations({ project_id: "p13-iso-b", limit: 100 });
  assert.equal(list.observations.some((x) => x.session_id === sid), false);
});

test("8. coverage report uses real counts", async () => {
  const c = await sem.semanticCoverage({});
  assert.equal(c.ok, true);
  assert.ok(Array.isArray(c.breakdown));
});

test("close", async () => { await core.close(); });
