// Stage 10.2: semantic memory intelligence. Built on existing pgvector/Ollama; no new services.
import * as core from "./core.js";
import { classifyText, languageOf } from "./roles.js";

const LIFECYCLE = ['HYPOTHESIS','SUPPORTED','VERIFIED','OUTDATED','DISPUTED','REJECTED','ARCHIVED'];

// Optional LLM-assisted classification through the single secure adapter.
// The deterministic role/keyword path remains the default and never changes.
const AI_CATEGORIES = new Set(["user_preference","user_correction","verified_fact","project_decision",
  "technical_knowledge","successful_solution","failed_approach","debugging_pattern","workflow_pattern",
  "architecture_decision","environment_config","temporary_observation","agent_reasoning"]);

async function llmClassify(text, role) {
  try {
    const llm = await import("./llm-provider.js");
    const r = await llm.runTask("multilingual_classification", { role, text: String(text).slice(0, 1500) });
    if (!r.ok) return null;
    const cat = String(r.data.category || "").toLowerCase();
    return AI_CATEGORIES.has(cat) ? cat : null;
  } catch { return null; }
}

export async function semanticClassify({ text, role = "USER", source_session, project_id }) {
  const original = String(text || "");
  const base = classifyText(original, role);
  const lang = languageOf(original);
  const llm = await llmClassify(original, role);
  const classification = llm || base || "temporary_observation";
  const method = llm ? "llm_assisted" : "role_keyword";
  await core.audit("intelligence.classify", source_session || null, { method, classification, lang });
  return { ok: true, classification, method, language: lang, original_text: original, role, source_session, project_id };
}

function cosineScore(row) {
  return typeof row.score === "number" ? row.score : Number(row.score || 0);
}

export async function detectDuplicates({ memory_id, limit = 20, threshold = 0.88 } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const vec = m.embedding ? String(m.embedding) : null;
  const candidates = [];
  if (vec) {
    const r = await core.dbQuery(
      `SELECT id, title, content, 1-(embedding <=> $1::vector) AS sim FROM memory
       WHERE id <> $2 AND embedding IS NOT NULL AND (valid_until IS NULL OR valid_until>now())
       ORDER BY embedding <=> $1::vector LIMIT $3`, [vec, memory_id, limit]);
    candidates.push(...r.rows.map((x) => ({ ...x, method: "embedding", score: Number(x.sim.toFixed(4)) })));
  }
  const fts = await core.dbQuery(
    `SELECT id, title, content, ts_rank_cd(to_tsvector('english',title||' '||content), websearch_to_tsquery('english',$1)) AS sim
     FROM memory WHERE id<>$2 AND to_tsvector('english',title||' '||content) @@ websearch_to_tsquery('english',$1) LIMIT $3`,
    [m.title, memory_id, limit]);
  candidates.push(...fts.rows.map((x) => ({ ...x, method: "fts", score: Number(x.sim.toFixed(4)) })));
  const trgm = await core.dbQuery(
    `SELECT id, title, content, similarity(content,$1) AS sim FROM memory
     WHERE id<>$2 AND similarity(content,$1) > 0.5 ORDER BY sim DESC LIMIT $3`,
    [m.content, memory_id, limit]);
  candidates.push(...trgm.rows.map((x) => ({ ...x, method: "trgm", score: Number(x.sim.toFixed(4)) })));

  const seen = new Set(); const out = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.method === "embedding" && c.score < threshold) continue;
    const relation = c.method === "embedding" ? "semantic_equivalent" : c.score > 0.9 ? "duplicate" : "near_duplicate";
    await core.dbQuery(
      `INSERT INTO memory_relationships (source_id,target_id,relation,score,method,evidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (source_id,target_id,relation) DO NOTHING`,
      [memory_id, c.id, relation, c.score, c.method, JSON.stringify({ title: c.title, excerpt: String(c.content).slice(0, 200) })],
    );
    out.push({ id: c.id, title: c.title, score: c.score, method: c.method, relation });
  }
  await core.audit("intelligence.duplicates", memory_id, { found: out.length });
  return { ok: true, source: memory_id, candidates: out, auto_merged: false };
}

const POS = /\b(always|use|prefer|keep|enabled|must|chose|selected)\b/i;
const NEG = /\b(never|avoid|remove|disable|do not|don't|rejected|stopped)\b/i;

export async function detectContradictions({ memory_id, limit = 15 } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const vec = m.embedding ? String(m.embedding) : null;
  const rows = vec ? (await core.dbQuery(
    `SELECT id, title, content, 1-(embedding <=> $1::vector) AS sim FROM memory
     WHERE id<>$2 AND embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $3`, [vec, memory_id, limit])).rows : [];
  const found = [];
  for (const c of rows) {
    const clash = (POS.test(m.content) && NEG.test(c.content)) || (NEG.test(m.content) && POS.test(c.content));
    const topical = Number(c.sim) > 0.55 || (m.title || "").toLowerCase() === (c.title || "").toLowerCase();
    if (!clash || !topical) continue;
    await core.dbQuery(
      `INSERT INTO memory_contradictions (memory_a,memory_b,description,evidence,confidence)
       VALUES (LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid),$3,$4::jsonb,$5)
       ON CONFLICT (memory_a,memory_b) DO NOTHING`,
      [memory_id, c.id, `Potential conflict: ${m.title} vs ${c.title}`,
       JSON.stringify({ a: String(m.content).slice(0, 300), b: String(c.content).slice(0, 300), similarity: Number(c.sim.toFixed(4)) }),
       Math.min(0.9, 0.5 + Number(c.sim || 0) * 0.4)],
    );
    found.push({ id: c.id, title: c.title, similarity: Number(c.sim.toFixed(4)) });
  }
  await core.audit("intelligence.contradictions", memory_id, { found: found.length });
  return { ok: true, source: memory_id, contradictions: found, records_preserved: true };
}

// Optional AI contradiction assessment. Output is a candidate only: it never resolves,
// deletes or edits either memory, and deterministic polarity checks remain authoritative.
export async function assessContradiction({ memory_a, memory_b } = {}) {
  const a = await core.getMemory(memory_a), b = await core.getMemory(memory_b);
  if (!a || !b) throw new Error("both memories must exist");
  try {
    const llm = await import("./llm-provider.js");
    const r = await llm.runTask("contradiction_analysis", {
      a: { title: a.title, content: String(a.content).slice(0, 800) },
      b: { title: b.title, content: String(b.content).slice(0, 800) },
    });
    if (!r.ok) return { ok: false, kind: r.kind || "error" };
    await core.dbQuery(
      `UPDATE memory_contradictions SET evidence = evidence || $3::jsonb WHERE
        (memory_a=$1 AND memory_b=$2) OR (memory_a=$2 AND memory_b=$1)`,
      [memory_a, memory_b, JSON.stringify({ ai_candidate: r.data, note: "candidate only; not auto-resolved" })],
    );
    return { ok: true, candidate: r.data, usage: r.usage, auto_resolved: false };
  } catch (e) { return { ok: false, kind: "error", message: String(e?.message || e).slice(0, 200) }; }
}

export async function assessQuality(memory_id) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const text = String(m.content || "");
  const dims = [
    ["clarity", Math.min(1, 0.3 + Math.min(text.length, 500) / 700)],
    ["specificity", Math.min(1, (text.match(/\b\d+|specific|exact|always|never|must\b/gi) || []).length / 5)],
    ["evidence", m.source_session || m.verified ? 0.8 : 0.3],
    ["reliability", m.verified ? 0.9 : m.confidence],
    ["relevance", Math.min(1, m.importance + 0.2)],
  ];
  for (const [dimension, score] of dims) {
    await core.dbQuery(
      `INSERT INTO memory_quality_assessments (memory_id,dimension,score,method,detail)
       VALUES ($1,$2,$3,'heuristic',$4::jsonb)`, [memory_id, dimension, Number(score.toFixed(3)), JSON.stringify({ length: text.length })],
    );
  }
  const avg = dims.reduce((a, x) => a + x[1], 0) / dims.length;
  await core.dbQuery("UPDATE memory SET quality_score=$2 WHERE id=$1", [memory_id, Number(avg.toFixed(3))]);
  return { ok: true, memory_id, quality_score: Number(avg.toFixed(3)), dimensions: dims.map(([d, s]) => ({ dimension: d, score: Number(s.toFixed(3)) })) };
}

export async function transitionLifecycle(memory_id, target, { evidence = [], actor = "user", note = "" } = {}) {
  if (!LIFECYCLE.includes(target)) throw new Error("invalid lifecycle state");
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  if (target === "VERIFIED") {
    const independent = evidence.filter((e) => e?.source && e.source !== "ai" && e.source !== "agent");
    if (independent.length < 1) throw new Error("VERIFIED requires independent non-AI evidence");
  }
  const r = await core.dbQuery(
    "UPDATE memory SET lifecycle=$2, verified=CASE WHEN $2='VERIFIED' THEN true ELSE verified END WHERE id=$1 RETURNING lifecycle,verified",
    [memory_id, target],
  );
  await core.dbQuery("INSERT INTO intelligence_audit_events (track,action,resource,detail) VALUES ('memory','lifecycle_transition',$1,$2::jsonb)",
    [memory_id, JSON.stringify({ from: m.lifecycle, to: target, evidence, actor, note })]);
  return { ok: true, ...r.rows[0] };
}

// Context-aware retrieval with reliability/recency/usefulness reranking.
export async function contextRetrieve({ query, project_id, session_id, task_type, language, limit = 8 } = {}) {
  const baseResults = await core.searchMemory({ query, project_id, limit: Math.min(limit * 3, 30) });
  const now = Date.now();
  const scored = baseResults.map((m) => {
    let boost = 0;
    const why = [];
    const add = (delta, reason) => { boost += delta; if (delta) why.push(`${reason}:${delta > 0 ? "+" : ""}${delta.toFixed(3)}`); };
    if (m.project_id === project_id) add(0.08, "project");
    else if (m.project_id === "_global") add(0.03, "global");
    if (m.verified) add(0.10, "verified");
    if (m.lifecycle === "VERIFIED") add(0.04, "lifecycle");
    if (m.lifecycle === "DISPUTED" || m.lifecycle === "REJECTED") add(-0.20, "disputed");
    const ageDays = (now - new Date(m.updated_at).getTime()) / 86400000;
    // Recency is capped well below verification so a fresh unverified candidate cannot
    // outrank reliable verified knowledge on recency alone.
    add(Math.max(-0.05, Math.min(0.04, 0.04 - ageDays / 200)), "recency");
    add(Math.min(0.05, Number(m.useful_count || 0) * 0.008), "usefulness");
    add(Math.min(0.03, Number(m.quality_score || 0) * 0.03), "quality");
    const text = `${m.title} ${m.content}`.toLowerCase();
    if (language && text.includes(String(language).toLowerCase())) add(0.02, "language");
    if (task_type && text.includes(String(task_type).toLowerCase())) add(0.02, "task");
    return { ...m, rerank_score: Number(Math.max(0, (m.score || 0) + boost).toFixed(6)),
      ranking_explanation: why };
  }).sort((a, b) => b.rerank_score - a.rerank_score).slice(0, limit);

  const ev = await core.dbQuery(
    `INSERT INTO memory_retrieval_events (session_id,project_id,session_project_id,query,memory_ids,context,ranking_source,scores)
     VALUES ($1,$2,$3,$4,$5::uuid[],$6::jsonb,$7,$8::jsonb) RETURNING id`,
    [session_id || null, project_id || null, project_id || null, String(query).slice(0, 1000),
     scored.map((x) => x.id), JSON.stringify({ task_type, language, limit }),
     "hybrid+rerank", JSON.stringify(Object.fromEntries(scored.map((x) => [x.id, { base: x.score, final: x.rerank_score, why: x.ranking_explanation }])) )],
  );
  for (const m of scored) {
    await core.dbQuery("UPDATE memory SET retrieved_count=retrieved_count+1, last_retrieved_at=now() WHERE id=$1", [m.id]);
  }
  await core.audit("intelligence.retrieval", "context", { event: ev.rows[0].id, count: scored.length });
  return { ok: true, event_id: ev.rows[0].id, results: scored, context: core.compactContext(scored) };
}

export async function markUsefulness({ event_id, memory_id, signal, evidence = {}, source = "observed" }) {
  if (!["used","not_used","helpful","unhelpful","unknown"].includes(signal)) throw new Error("invalid signal");
  await core.dbQuery(
    `INSERT INTO memory_usefulness_observations (event_id,memory_id,signal,evidence,source)
     VALUES ($1,$2,$3,$4::jsonb,$5)`, [event_id, memory_id, signal, JSON.stringify(evidence), source],
  );
  if (signal === "used" || signal === "helpful") {
    await core.dbQuery("UPDATE memory SET useful_count=useful_count+1 WHERE id=$1", [memory_id]);
  }
  await core.audit("intelligence.usefulness", memory_id, { signal, event_id, source });
  return { ok: true, signal };
}

export async function usefulnessStats() {
  const r = await core.dbQuery(
    `SELECT signal, count(*)::int AS n FROM memory_usefulness_observations GROUP BY 1 ORDER BY n DESC`);
  const ev = await core.dbQuery("SELECT count(*)::int AS events FROM memory_retrieval_events");
  return { ok: true, events: ev.rows[0].events, signals: r.rows };
}
