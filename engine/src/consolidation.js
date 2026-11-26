// Phase 7: duplicate / contradiction / outdated detection and approval-gated resolution.
import * as core from "./core.js";

const POLARITY_POS = /\b(always|must|use|prefer|enabled|true|yes|keep)\b/i;
const POLARITY_NEG = /\b(never|do not|don't|avoid|disable|false|no|remove|stop)\b/i;

function salient(text) {
  return new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []);
}
function overlap(a, b) {
  const A = salient(a), B = salient(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

async function insertSuggestion(s) {
  const exists = await core.dbQuery(
    `SELECT 1 FROM consolidation_suggestion
     WHERE kind=$1 AND memory_ids=$2::uuid[] AND status='pending'`,
    [s.kind, s.memory_ids],
  );
  if (exists.rowCount) return false;
  await core.dbQuery(
    `INSERT INTO consolidation_suggestion (kind, memory_ids, title, description, confidence)
     VALUES ($1,$2::uuid[],$3,$4,$5)`,
    [s.kind, s.memory_ids, s.title, s.description, s.confidence],
  );
  await core.audit("consolidation.suggested", s.memory_ids[0] || null, { kind: s.kind });
  return true;
}

export async function scanConsolidation() {
  const run = await core.dbQuery(`INSERT INTO consolidation_run DEFAULT VALUES RETURNING id`);
  const runId = run.rows[0].id;
  const all = (await core.dbQuery(
    `SELECT id, project_id, layer, title, content, confidence, importance, verified,
            created_at, updated_at, valid_until, source_kind, source_session
     FROM memory WHERE valid_until IS NULL OR valid_until > now()`,
  )).rows;

  let duplicates = 0, contradictions = 0, outdated = 0, merges = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.project_id !== b.project_id) continue;
      const sim = overlap(a.content, b.content);
      const sameTopic = overlap(a.title, b.title) > 0.4;
      if (sim > 0.8 || sameTopic) {
        if (await insertSuggestion({
          kind: "duplicate", memory_ids: [a.id, b.id], title: `Possible duplicate: ${a.title}`,
          description: `Similarity ${sim.toFixed(2)}. A: ${a.title} (${a.source_session || "unknown source"}, ${a.created_at}). B: ${b.title} (${b.source_session || "unknown source"}, ${b.created_at}).`,
          confidence: Math.min(0.95, 0.5 + sim * 0.5),
        })) duplicates++;
        if (await insertSuggestion({
          kind: "merge", memory_ids: [a.id, b.id], title: `Suggested merge: ${a.title} + ${b.title}`,
          description: `Both memories cover the same topic in project ${a.project_id}. Merging keeps the primary version and expires the secondary (its history is preserved).`,
          confidence: Math.min(0.9, 0.45 + sim * 0.5),
        })) merges++;
      }
      const polarityClash = (POLARITY_POS.test(a.content) && POLARITY_NEG.test(b.content)) ||
        (POLARITY_NEG.test(a.content) && POLARITY_POS.test(b.content));
      if (polarityClash && sim > 0.45) {
        if (await insertSuggestion({
          kind: "contradiction", memory_ids: [a.id, b.id], title: `Contradiction: ${a.title} vs ${b.title}`,
          description: `A (${a.source_kind}, confidence ${a.confidence}, ${a.created_at}): ${a.content.slice(0, 220)}\nB (${b.source_kind}, confidence ${b.confidence}, ${b.created_at}): ${b.content.slice(0, 220)}\nThe statements use opposing guidance on a similar topic. Nothing was deleted; review and resolve manually.`,
          confidence: Math.min(0.9, 0.5 + sim * 0.4),
        })) contradictions++;
      }
    }
  }
  const expired = (await core.dbQuery(
    `SELECT count(*)::int AS n FROM memory WHERE valid_until IS NOT NULL AND valid_until <= now()`,
  )).rows[0].n;
  if (expired > 0) {
    await insertSuggestion({
      kind: "review", memory_ids: [], title: `${expired} expired memories retained`,
      description: `These memories were safely expired (not deleted) and their versions remain available for review.`,
      confidence: 1,
    });
    outdated = expired;
  }
  const stats = { duplicates, contradictions, outdated, merges, memories_scanned: all.length };
  await core.dbQuery("UPDATE consolidation_run SET finished_at=now(), stats=$2::jsonb WHERE id=$1", [runId, stats]);
  await core.audit("consolidation.scan", "all", stats);
  return { ok: true, ...stats };
}

export async function listSuggestions({ status = "pending", kind, limit = 50 } = {}) {
  return (await core.dbQuery(
    `SELECT * FROM consolidation_suggestion
     WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR kind=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [status || null, kind || null, Math.min(limit, 200)],
  )).rows;
}

export async function resolveSuggestion(id, { status, note = "", actor = "user" }) {
  if (!["approved", "rejected", "resolved"].includes(status)) throw new Error("status must be approved|rejected|resolved");
  const r = await core.dbQuery("SELECT * FROM consolidation_suggestion WHERE id=$1", [id]);
  if (!r.rowCount) throw new Error("suggestion not found");
  const s = r.rows[0];
  let detail = {};
  if (status === "approved" && (s.kind === "duplicate" || s.kind === "merge") && s.memory_ids.length === 2) {
    const [a, b] = s.memory_ids;
    const primary = (await core.getMemory(a))?.confidence >= (await core.getMemory(b))?.confidence ? a : b;
    const secondary = primary === a ? b : a;
    const pm = await core.getMemory(primary), sm = await core.getMemory(secondary);
    if (pm && sm) {
      await core.updateMemory(primary, {
        content: `${pm.content}\n\n[Consolidated from ${sm.title}] ${sm.content}`,
        confidence: Math.max(pm.confidence, sm.confidence),
        tags: [...new Set([...(pm.tags || []), ...(sm.tags || [])])],
      }, `consolidation:${s.kind}`);
      await core.deleteMemory(secondary, false); // soft expire; history preserved
      detail = { primary, secondary, action: "merged_and_expired_secondary" };
    }
  }
  await core.dbQuery(
    `UPDATE consolidation_suggestion SET status=$2, resolution_note=$3, resolved_at=now(), resolved_by=$4 WHERE id=$1`,
    [id, status, note, actor],
  );
  await core.audit(`consolidation.${status}`, id, { kind: s.kind, note, ...detail });
  return { ok: true, status, ...detail };
}

export async function memoryVersions(id) {
  return (await core.dbQuery(
    `SELECT version, content, changed_at, reason FROM memory_history WHERE memory_id=$1 ORDER BY version DESC`, [id],
  )).rows;
}

export async function contradictions() { return listSuggestions({ status: "pending", kind: "contradiction" }); }
export async function duplicates() { return listSuggestions({ status: "pending", kind: "duplicate" }); }
export async function outdated() { return listSuggestions({ status: "pending", kind: "review" }); }

// ---- Phase 12.2: safe, bounded, idempotent triage ----
const THRESHOLDS = {
  duplicate: Number(process.env.HARNESS_TRIAGE_DUPLICATE || 0.99),
  near_duplicate: Number(process.env.HARNESS_TRIAGE_NEAR || 0.95),
  merge: Number(process.env.HARNESS_TRIAGE_MERGE || 0.95),
  contradiction: 1.1, // always requires independent human review
  review: 1.1,
};

export async function triageSuggestions({ batch = 200, project_id } = {}) {
  const rows = (await core.dbQuery(
    `SELECT cs.*, m.project_id FROM consolidation_suggestion cs
     LEFT JOIN memory m ON m.id = cs.memory_ids[1]
     WHERE cs.triage_status='pending' AND ($1::text IS NULL OR m.project_id=$1)
     ORDER BY cs.confidence DESC, cs.created_at DESC LIMIT $2`,
    [project_id || null, Math.min(batch, 500)])).rows;
  const stats = { seen: rows.length, ready: 0, deferred: 0, review: 0 };
  const groups = { ready_for_review: [], deferred: [], review_required: [] };
  for (const s of rows) {
    const threshold = THRESHOLDS[s.kind] ?? 0.95;
    const status = threshold > 1 ? "review_required" : (Number(s.confidence) >= threshold ? "ready_for_review" : "deferred");
    if (status === "ready_for_review") stats.ready++;
    else if (status === "review_required") stats.review++;
    else stats.deferred++;
    groups[status].push(s.id);
  }
  // Bulk updates: avoid one round-trip per suggestion on a large backlog.
  for (const [status, ids] of Object.entries(groups)) {
    if (!ids.length) continue;
    await core.dbQuery(
      `UPDATE consolidation_suggestion SET triage_status=$2, triage_reason=$3, triaged_at=now()
       WHERE id = ANY($1::uuid[]) AND triage_status='pending'`,
      [ids, status, `threshold policy for ${status}`],
    );
  }
  await core.audit("consolidation.triage", "all", stats);
  return { ok: true, ...stats };
}

export async function qualityReport({ project_id } = {}) {
  const one = async (sql, p = []) => (await core.dbQuery(sql, p)).rows[0];
  const r = await one(
    `SELECT
      (SELECT count(*)::int FROM memory WHERE ($1::text IS NULL OR project_id=$1)) AS memories,
      (SELECT count(*)::int FROM memory WHERE verified AND ($1::text IS NULL OR project_id=$1)) AS verified,
      (SELECT count(*)::int FROM memory WHERE confidence<0.5 AND ($1::text IS NULL OR project_id=$1)) AS low_confidence,
      (SELECT count(*)::int FROM memory WHERE retrieved_count=0 AND ($1::text IS NULL OR project_id=$1)) AS unused,
      (SELECT count(*)::int FROM memory WHERE retrieved_count>=5 AND ($1::text IS NULL OR project_id=$1)) AS frequently_retrieved,
      (SELECT count(*)::int FROM memory WHERE valid_until IS NOT NULL AND ($1::text IS NULL OR project_id=$1)) AS outdated,
      (SELECT count(*)::int FROM memory_relationships WHERE ($1::text IS NULL OR $1 = ANY(ARRAY[]::text[]))) AS relationships,
      (SELECT count(*)::int FROM memory_contradictions) AS contradictions`,
    [project_id || null],
  );
  const suggestions = (await core.dbQuery(
    `SELECT kind,triage_status,count(*)::int n FROM consolidation_suggestion GROUP BY 1,2 ORDER BY n DESC`)).rows;
  return { ok: true, ...r, suggestions };
}

// Requires explicit approval. Creates a DERIVED memory; every source remains untouched.
export async function applyApprovedConsolidation({ suggestion_id, approved, actor = "user", note = "" } = {}) {
  if (approved !== true) throw new Error("explicit approval required");
  const s = (await core.dbQuery("SELECT * FROM consolidation_suggestion WHERE id=$1", [suggestion_id])).rows[0];
  if (!s) throw new Error("suggestion not found");
  if (s.triage_status !== "ready_for_review") throw new Error("suggestion is not triaged for review");
  const sources = [];
  for (const id of s.memory_ids || []) {
    const m = await core.getMemory(id);
    if (!m) throw new Error("source memory missing");
    sources.push(m);
  }
  if (!sources.length) throw new Error("no source memories");
  const projects = [...new Set(sources.map((m) => m.project_id))];
  if (projects.length !== 1) throw new Error("refusing cross-project consolidation");
  const primary = sources.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  const derived = await core.saveMemory({
    layer: primary.layer, project_id: projects[0],
    title: `Consolidated: ${primary.title}`,
    content: sources.map((m) => `[source ${m.id}] ${m.content}`).join("\n\n"),
    category: primary.category, source_kind: "observed", confidence: primary.confidence,
    importance: primary.importance, verified: false,
    metadata: { derived_from: sources.map((m) => m.id), approval: actor, note },
  });
  await core.dbQuery(
    `INSERT INTO consolidation_rollback (suggestion_id,derived_id,source_ids,operation,detail)
     VALUES ($1,$2,$3::uuid[],$4,$5::jsonb)`,
    [suggestion_id, derived.id, sources.map((m) => m.id), s.kind, JSON.stringify({ actor, note, project_id: projects[0] })],
  );
  await core.dbQuery("UPDATE consolidation_suggestion SET status='approved',triage_status='resolved',resolved_by=$2,resolved_at=now() WHERE id=$1", [suggestion_id, actor]);
  await core.audit("consolidation.applied", suggestion_id, { derived: derived.id, sources: sources.length, actor });
  return { ok: true, derived_id: derived.id, source_ids: sources.map((m) => m.id), verified: false };
}

export async function rollbackConsolidation({ rollback_id, actor = "user" }) {
  const r = (await core.dbQuery("SELECT * FROM consolidation_rollback WHERE id=$1", [rollback_id])).rows[0];
  if (!r) throw new Error("rollback record not found");
  if (r.applied) return { ok: true, already_applied: true };
  if (r.derived_id) await core.deleteMemory(r.derived_id, false); // soft expiry only
  await core.dbQuery("UPDATE consolidation_rollback SET applied=true WHERE id=$1", [rollback_id]);
  await core.audit("consolidation.rollback", rollback_id, { actor, derived: r.derived_id });
  return { ok: true, expired_derived: r.derived_id, sources_preserved: r.source_ids.length };
}
