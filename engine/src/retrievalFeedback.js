// Evidence-based retrieval usefulness. Never fabricates a helpful verdict.
import * as core from "./core.js";
import { markUsefulness } from "./intelligence.js";
import { readLines } from "./transcript.js";

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// A distinctive snippet is required: short generic phrases are not evidence.
function snippets(memory) {
  const title = norm(memory.title).replace(/^[^a-z0-9\u0980-\u09ff]+/, "");
  const body = norm(memory.content);
  const out = [];
  if (title.length >= 20) out.push(title.slice(0, 120));
  if (body.length >= 24) out.push(body.slice(0, 140));
  return [...new Set(out)];
}

export async function observeUsage({ event_id, session_id } = {}) {
  if (!event_id || !session_id) return { ok: false, reason: "event_id and session_id required" };
  const ev = (await core.dbQuery(
    "SELECT id,memory_ids,created_at,query FROM memory_retrieval_events WHERE id=$1", [event_id])).rows[0];
  if (!ev) return { ok: false, reason: "retrieval event not found" };
  const lines = readLines(session_id).filter((l) => new Date(l.ts) > new Date(ev.created_at));
  if (!lines.length) return { ok: true, observed: 0, reason: "no later transcript lines" };
  const haystack = lines.map((l) => norm(l.text)).join("\n");
  let observed = 0;
  for (const mid of ev.memory_ids || []) {
    const m = await core.getMemory(mid);
    if (!m) continue;
    const already = (await core.dbQuery(
      "SELECT 1 FROM memory_usefulness_observations WHERE event_id=$1 AND memory_id=$2 AND signal='observed_usage'",
      [event_id, mid])).rowCount;
    if (already) continue;
    const match = snippets(m).find((s) => haystack.includes(s));
    if (!match) continue; // absence of evidence is NOT evidence of uselessness
    await core.dbQuery(
      `INSERT INTO memory_usefulness_observations (event_id,memory_id,signal,evidence,source)
       VALUES ($1,$2,'observed_usage',$3::jsonb,'deterministic')`,
      [event_id, mid, JSON.stringify({ matched: match.slice(0, 140), session_id, later_lines: lines.length })],
    );
    await core.dbQuery("UPDATE memory SET useful_count=useful_count+1 WHERE id=$1", [mid]);
    observed++;
  }
  await core.audit("retrieval.usefulness_observed", session_id, { event_id, observed });
  return { ok: true, observed, later_lines: lines.length, claim: "observed usage only — no helpfulness claim" };
}

export async function explicitFeedback({ event_id, memory_id, verdict, reason = "" }) {
  if (!["helpful","unhelpful"].includes(verdict)) throw new Error("verdict must be helpful|unhelpful");
  return markUsefulness({ event_id, memory_id, signal: verdict, evidence: { reason }, source: "user" });
}

export async function usefulnessSummary({ project_id } = {}) {
  const rows = (await core.dbQuery(
    `SELECT u.signal, u.source, count(*)::int n
     FROM memory_usefulness_observations u LEFT JOIN memory m ON m.id=u.memory_id
     WHERE ($1::text IS NULL OR m.project_id=$1)
     GROUP BY 1,2 ORDER BY n DESC`, [project_id || null])).rows;
  const retrieved = (await core.dbQuery(
    `SELECT count(*)::int n FROM memory_retrieval_events WHERE ($1::text IS NULL OR project_id=$1)`, [project_id || null])).rows[0].n;
  const buckets = { explicit_helpful: 0, explicit_unhelpful: 0, observed_usage: 0,
    possibly_useful: 0, not_enough_evidence: 0, unused_or_irrelevant: 0 };
  for (const r of rows) {
    if (r.signal === "helpful") buckets.explicit_helpful += r.n;
    else if (r.signal === "unhelpful") buckets.explicit_unhelpful += r.n;
    else if (r.signal === "observed_usage") buckets.observed_usage += r.n;
    else if (r.signal === "used") buckets.possibly_useful += r.n;
  }
  const evidenced = buckets.explicit_helpful + buckets.explicit_unhelpful + buckets.observed_usage + buckets.possibly_useful;
  buckets.not_enough_evidence = Math.max(0, retrieved - evidenced);
  return { ok: true, retrieval_events: retrieved, buckets, note: "no fabricated usefulness" };
}
