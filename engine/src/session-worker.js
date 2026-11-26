// Automatic session learning worker.
// Incremental, cached, batched. Uses the secure LLM adapter only when enabled;
// otherwise it uses the existing deterministic role/pattern path (no behavior change).
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import * as core from "./core.js";
import * as llm from "./llm-provider.js";
import { extractSession } from "./roles.js";

const OPENCODE_DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const BATCH = Math.max(1, Math.min(50, Number(process.env.HARNESS_WORKER_BATCH || 12)));

function keyFor(task, sessionId, hash) { return crypto.createHash("sha256").update(`${task}:${sessionId}:${hash}`).digest("hex"); }

async function cached(task, cacheKey) {
  const r = await core.dbQuery("SELECT result,model FROM ai_analysis_cache WHERE cache_key=$1", [cacheKey]);
  if (r.rowCount) {
    await core.dbQuery("UPDATE ai_analysis_cache SET hits=hits+1 WHERE cache_key=$1", [cacheKey]);
    const model = r.rows[0].model || "deterministic";
    return { ok: true, cached: true, deterministic: model === "deterministic",
      llm_used: model !== "deterministic", data: r.rows[0].result, model };
  }
  return null;
}

async function saveCache(task, cacheKey, result, model) {
  await core.dbQuery(
    `INSERT INTO ai_analysis_cache (cache_key,task,model,result) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (cache_key) DO NOTHING`, [cacheKey, task, model || "deterministic", JSON.stringify(result)],
  );
}

export async function processSession({ session_id, force = false } = {}) {
  if (!session_id) throw new Error("session_id required");
  const meta = await core.dbQuery("SELECT id,title,summary,summary_roles,time_updated FROM session_index WHERE id=$1", [session_id]);
  if (!meta.rowCount) return { ok: false, reason: "session not indexed" };
  const s = meta.rows[0];
  const hash = crypto.createHash("sha256").update(`${s.title}|${s.summary}|${s.summary_roles}|${s.time_updated}`).digest("hex");
  const task = "session_understanding";
  const cacheKey = keyFor(task, session_id, hash);

  if (!force) {
    const hit = await cached(task, cacheKey);
    if (hit) return { ok: true, ...hit, session_id };
  }
  let lines = [];
  try { lines = extractSession(OPENCODE_DB, session_id, BATCH); } catch (e) {
    return { ok: false, reason: "read-only extraction failed", message: String(e?.message || e).slice(0, 200) };
  }
  const payload = {
    session_id, title: s.title,
    lines: lines.slice(0, BATCH).map((x) => ({ role: x.role, text: x.text.slice(0, 600), kind: x.kind, language: x.language })),
  };

  // Genuine deterministic fallback: works fully without any chat model.
  if (!llm.status().enabled) {
    const roles = {};
    for (const l of payload.lines) roles[l.kind || "other"] = (roles[l.kind || "other"] || 0) + 1;
    const deterministic = {
      objective: s.title || "Session understanding",
      reasoning: payload.lines.filter((x) => x.kind === "agent_reasoning").slice(0, 8).map((x) => x.text.slice(0, 300)),
      tool_activity: payload.lines.filter((x) => x.role === "TOOL").slice(0, 8).map((x) => x.text.slice(0, 300)),
      decisions: payload.lines.filter((x) => x.kind === "historical_decision" || x.kind === "project_decision").slice(0, 8).map((x) => x.text.slice(0, 300)),
      errors: payload.lines.filter((x) => x.kind === "repeated_failure").slice(0, 8).map((x) => x.text.slice(0, 300)),
      outcomes: payload.lines.filter((x) => x.kind === "successful_solution").slice(0, 8).map((x) => x.text.slice(0, 300)),
      role_counts: roles,
    };
    await saveCache(task, cacheKey, deterministic, "deterministic");
    await core.dbQuery(
      `INSERT INTO ai_task_queue (cache_key,task,payload,status) VALUES ($1,$2,$3::jsonb,'done')
       ON CONFLICT (cache_key) DO NOTHING`, [cacheKey, task, JSON.stringify(payload)],
    );
    await core.audit("worker.session_processed", session_id, { task, mode: "deterministic", lines: lines.length });
    return { ok: true, session_id, cached: false, deterministic: true, llm_used: false,
      data: deterministic, lines: lines.length, usage: null };
  }

  const result = await llm.runTask(task, payload);
  if (!result.ok) {
    await core.dbQuery(
      `INSERT INTO ai_task_queue (cache_key,task,payload,status,attempts,last_error)
       VALUES ($1,$2,$3::jsonb,CASE WHEN $4 IN ('rate_limit','budget_exhausted') THEN 'paused' ELSE 'failed' END,1,$5)
       ON CONFLICT (cache_key) DO UPDATE SET status=EXCLUDED.status,attempts=ai_task_queue.attempts+1,
       last_error=EXCLUDED.last_error,updated_at=now()`,
      [cacheKey, task, JSON.stringify(payload), result.kind || "error", String(result.message || result.kind || "error").slice(0, 300)],
    );
    // Preserve queued work; do not process it while limits are active.
    return { ok: false, session_id, deferred: true, kind: result.kind, paused: result.paused === true };
  }
  await saveCache(task, cacheKey, result.data, result.model);
  await core.dbQuery("INSERT INTO ai_task_queue (cache_key,task,payload,status) VALUES ($1,$2,$3::jsonb,'done') ON CONFLICT (cache_key) DO NOTHING",
    [cacheKey, task, JSON.stringify(payload)]);
  await core.audit("worker.session_processed", session_id, { task, model: result.model, lines: lines.length });
  return { ok: true, session_id, cached: false, data: result.data, lines: lines.length, usage: result.usage };
}

export async function processIncremental({ limit = 10, batch = BATCH, force = false } = {}) {
  const c = llm.status();
  const sessions = (await core.dbQuery(
    `SELECT s.id FROM session_index s LEFT JOIN analysis_state a ON a.session_id=s.id
     ORDER BY s.time_updated DESC NULLS LAST LIMIT $1`, [Math.min(limit, 100)])).rows;
  let processed = 0, deferred = 0, cached = 0, errors = 0;
  for (const s of sessions) {
    const r = await processSession({ session_id: s.id, force });
    if (r.ok && r.cached) cached++;
    else if (r.ok) processed++;
    else if (r.deferred) deferred++;
    else errors++;
    if (r.deferred && (r.kind === "rate_limit" || r.paused)) break; // pause the worker, keep queue
  }
  return { ok: true, sessions: sessions.length, processed, cached, deferred, errors,
    mode: c.enabled ? "llm" : "deterministic" };
}

export async function queueStatus() {
  const rows = (await core.dbQuery("SELECT status, count(*)::int n FROM ai_task_queue GROUP BY 1 ORDER BY 1")).rows;
  const cache = (await core.dbQuery("SELECT count(*)::int entries, COALESCE(sum(hits),0)::int hits FROM ai_analysis_cache")).rows[0];
  const recent = (await core.dbQuery("SELECT task,status,attempts,last_error,updated_at FROM ai_task_queue ORDER BY updated_at DESC LIMIT 10")).rows;
  return { ok: true, queue: rows, cache, recent };
}

export async function retryPaused({ limit = 5 } = {}) {
  const llmStatus = llm.status();
  if (!llmStatus.enabled) return { ok: false, reason: "adapter disabled" };
  const usage = llm.usage();
  if (usage.total >= usage.budget) return { ok: false, reason: "budget exhausted — queue paused" };
  const rows = (await core.dbQuery("SELECT cache_key,task,payload FROM ai_task_queue WHERE status IN ('paused','failed') ORDER BY updated_at LIMIT $1", [limit])).rows;
  let retried = 0;
  for (const r of rows) {
    const res = await llm.runTask(r.task, r.payload || {});
    if (res.ok) {
      await core.dbQuery("UPDATE ai_task_queue SET status='done',last_error=NULL,updated_at=now() WHERE cache_key=$1", [r.cache_key]);
      retried++;
    }
  }
  return { ok: true, attempted: rows.length, retried };
}
