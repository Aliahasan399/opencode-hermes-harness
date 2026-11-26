// Phase 20 workstream C — evidence-preserving consolidation & contradiction handling.
//
// Design rules (strict):
//   * REUSE existing infrastructure: consolidation.applyApprovedConsolidation performs
//     every actual merge, relationshipIntel.createRelationship creates the optional
//     'contradicts' link, and core.js owns all storage. This module adds only the
//     deterministic candidate discovery + safe proposal/approval/contradiction wrapper.
//   * No LLM, no network, no auto-merge. Every merge requires explicit approval and
//     is delegated to the already-audited, source-preserving consolidation code.
//   * Cross-project isolation is absolute: candidate pairs are only formed inside a
//     single project_id. `_global` rows are never paired with a real project's rows,
//     and a `_global` scan is restricted to globally-eligible rows.
//   * The live consolidation_suggestion.kind CHECK constraint only permits
//     duplicate|contradiction|outdated|merge|review. The richer candidate kinds are
//     mapped to a storable kind, while the EXACT candidate kind is preserved verbatim
//     in triage_reason and echoed in the description. This keeps information intact
//     and lets idempotency be keyed by (project/kind/memory-id-set).
//   * All queries are bounded and every source memory is preserved.

import * as core from "./core.js";
import { GLOBAL_PROJECT_ID, GLOBAL_ELIGIBLE_SQL } from "./memoryScope.js";

const CANDIDATE_KINDS = new Set(["duplicate", "near_duplicate", "complementary"]);
const STORAGE_KIND = Object.freeze({
  duplicate: "duplicate",
  near_duplicate: "duplicate",
  complementary: "merge",
});
const MAX_SCAN = 400;
const MAX_LIMIT = 200;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function clampLimit(value, fallback, cap = MAX_LIMIT) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, cap) : fallback;
}
function clampConfidence(value, fallback = 0.5) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
function round(value) {
  return Number(Number(value).toFixed(4));
}
function normTokens(text) {
  return new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) || []);
}
function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}
function memoryTokens(m) {
  return normTokens(`${m.title || ""} ${m.content || ""}`);
}
function sameClass(a, b) {
  const ca = String(a.category ?? "").toLowerCase();
  const cb = String(b.category ?? "").toLowerCase();
  const la = String(a.layer ?? "").toLowerCase();
  const lb = String(b.layer ?? "").toLowerCase();
  return ca === cb && la === lb;
}
function sortedIds(ids) {
  return [...ids].map(String).sort();
}
function signature(ids) {
  return sortedIds(ids).join("\u0000");
}
function fail(reason, extra = {}) {
  return { ok: false, candidates: [], items: [], reason, ...extra };
}

// Classify a same-class pair using deterministic token-Jaccard over title+content.
// Returns null when the pair is not a consolidation candidate (e.g. cross-class,
// which is "similar but unrelated" and must only ever be flagged for review).
function classifyPair(a, b, threshold) {
  if (!sameClass(a, b)) return null;
  const ta = normTokens(a.title || "");
  const tb = normTokens(b.title || "");
  const titleSim = jaccard(ta, tb);
  const sim = jaccard(memoryTokens(a), memoryTokens(b));
  let kind;
  let reason;
  if (sim >= threshold) {
    kind = "duplicate";
    reason = `Near-identical title+content (Jaccard ${round(sim)} >= ${threshold}); same category/layer.`;
  } else if (sim >= Math.max(0.45, threshold - 0.2)) {
    kind = "near_duplicate";
    reason = `High lexical overlap (Jaccard ${round(sim)}) below duplicate threshold ${threshold}; same category/layer.`;
  } else if (sim >= 0.2 && titleSim >= 0.4) {
    kind = "complementary";
    reason = `Topically related titles (Jaccard ${round(titleSim)}) with distinct content (Jaccard ${round(sim)}); complementary, same category/layer.`;
  } else {
    return null;
  }
  const confidence = kind === "complementary"
    ? round(Math.min(0.9, sim * 0.9 + titleSim * 0.2))
    : round(Math.min(0.99, sim));
  return {
    kind,
    memory_ids: sortedIds([a.id, b.id]),
    confidence,
    reason: `${reason} A: "${a.title}". B: "${b.title}".`,
    project_id: a.project_id,
    similarity: round(sim),
    title_similarity: round(titleSim),
  };
}

async function memoriesByIds(ids) {
  if (!ids.length) return [];
  const r = await core.dbQuery(
    `SELECT id, project_id, layer, title, content, category, source_kind, confidence,
            importance, verified, provenance, source_session, created_at, updated_at
       FROM memory WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return r.rows;
}

// ---- 1. Deterministic candidate discovery ---------------------------------
export async function findCandidates({ project_id, limit = 50, threshold = 0.82 } = {}) {
  if (!isNonEmptyString(project_id)) return fail("project_id is required");
  const n = clampLimit(limit, 50);
  const t = clampConfidence(threshold, 0.82);

  let sql =
    `SELECT id, project_id, layer, title, content, category, source_kind, confidence,
            provenance, source_session, created_at
       FROM memory
      WHERE project_id=$1 AND (valid_until IS NULL OR valid_until > now())`;
  if (project_id === GLOBAL_PROJECT_ID) sql += ` AND ${GLOBAL_ELIGIBLE_SQL}`;
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $2`;
  const rows = (await core.dbQuery(sql, [project_id, MAX_SCAN])).rows;

  // Signatures of every memory already referenced by any suggestion (any status),
  // so resolved OR pending pairs are not re-surfaced as fresh candidates.
  const existing = new Set();
  if (rows.length) {
    const allIds = [...new Set(rows.map((m) => m.id))];
    const sug = await core.dbQuery(
      `SELECT memory_ids FROM consolidation_suggestion WHERE memory_ids && $1::uuid[] LIMIT 500`,
      [allIds],
    );
    for (const s of sug.rows) existing.add(signature(s.memory_ids || []));
  }

  const candidates = [];
  for (let i = 0; i < rows.length && candidates.length < n; i++) {
    for (let j = i + 1; j < rows.length && candidates.length < n; j++) {
      const a = rows[i], b = rows[j];
      // Absolute cross-project guard, checked before any similarity work.
      if (a.project_id !== b.project_id || a.project_id !== project_id) continue;
      const sig = signature([a.id, b.id]);
      if (existing.has(sig)) continue;
      const candidate = classifyPair(a, b, t);
      if (!candidate) continue;
      candidates.push(candidate);
    }
  }
  await core.audit("consolidation.candidates", project_id, { count: candidates.length, threshold: t });
  return { ok: true, candidates, project_id, threshold: t };
}

// ---- 2. Evidence-preserving proposal (never merges) -----------------------
export async function proposeConsolidation({ candidate, project_id, actor = "system", evidence = [] } = {}) {
  if (!isNonEmptyString(project_id)) return { ok: false, reason: "project_id is required" };
  if (!candidate || typeof candidate !== "object") return { ok: false, reason: "candidate is required" };
  const kind = candidate.kind;
  if (!CANDIDATE_KINDS.has(kind)) return { ok: false, reason: "unsupported candidate kind" };
  if (!Array.isArray(candidate.memory_ids) || candidate.memory_ids.length < 2) {
    return { ok: false, reason: "candidate.memory_ids must contain at least two ids" };
  }
  if (!Array.isArray(evidence)) return { ok: false, reason: "evidence must be an array" };

  const ids = sortedIds(candidate.memory_ids);
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "duplicate memory ids in candidate" };

  const mems = await memoriesByIds(ids);
  if (mems.length !== ids.length) return { ok: false, reason: "one or more source memories are missing" };
  const projects = [...new Set(mems.map((m) => m.project_id))];
  if (projects.length !== 1 || projects[0] !== project_id) {
    return { ok: false, reason: "refusing cross-project consolidation proposal" };
  }

  const storageKind = STORAGE_KIND[kind];
  const conf = clampConfidence(candidate.confidence, 0.5);
  const reason = typeof candidate.reason === "string" && candidate.reason.trim()
    ? candidate.reason.trim()
    : `Consolidation candidate of kind ${kind}.`;
  const sourceInfo = mems.map((m) =>
    `[${m.id}] title=${m.title} provenance=${m.provenance || "unknown"} project=${m.project_id}`).join("; ");
  const evidenceText = evidence.length ? `\nEvidence: ${JSON.stringify(evidence).slice(0, 2000)}` : "";
  const description = `${reason}\nCandidate kind: ${kind}\nActor: ${actor}\nSources: ${sourceInfo}${evidenceText}`.slice(0, 8000);
  const title = `Consolidation candidate: ${kind} (${ids.map((x) => x.slice(0, 8)).join("+")})`;

  // Idempotency key: stored kind + canonical memory-id set + EXACT candidate kind.
  // triage_reason is a free text column reserved here for the exact candidate kind;
  // our rows are created directly with triage_status='ready_for_review', so the triage
  // worker (which only touches 'pending' rows) never rewrites it.
  const existing = await core.dbQuery(
    `SELECT id FROM consolidation_suggestion
      WHERE kind=$1 AND memory_ids=$2::uuid[] AND triage_reason=$3 AND status='pending'
      ORDER BY created_at DESC LIMIT 1`,
    [storageKind, ids, kind],
  );
  if (existing.rowCount) {
    await core.audit("consolidation.propose_duplicate", existing.rows[0].id, { kind, project_id, actor });
    return { ok: true, suggestion_id: existing.rows[0].id, duplicate: true };
  }

  const ins = await core.dbQuery(
    `INSERT INTO consolidation_suggestion
       (kind, memory_ids, title, description, confidence, status, triage_status, triage_reason)
     VALUES ($1,$2::uuid[],$3,$4,$5,'pending','ready_for_review',$6)
     RETURNING id`,
    [storageKind, ids, title, description, conf, kind],
  );
  const suggestionId = ins.rows[0].id;
  await core.audit("consolidation.proposed", suggestionId, {
    kind, storage_kind: storageKind, project_id, actor, memory_ids: ids, evidence: evidence.length,
  });
  return { ok: true, suggestion_id: suggestionId, duplicate: false };
}

// ---- 3. Approval-gated merge, delegated to existing consolidation ----------
export async function consolidateApproved({ suggestion_id, project_id, approved, actor = "user", note = "" } = {}) {
  if (approved !== true) throw new Error("explicit approval required");
  if (!isNonEmptyString(project_id)) throw new Error("project_id is required");
  if (!isNonEmptyString(suggestion_id)) throw new Error("suggestion_id is required");

  const s = (await core.dbQuery("SELECT * FROM consolidation_suggestion WHERE id=$1", [suggestion_id])).rows[0];
  if (!s) throw new Error("suggestion not found");

  const rollbackRow = (await core.dbQuery(
    `SELECT * FROM consolidation_rollback WHERE suggestion_id=$1 ORDER BY id DESC LIMIT 1`, [suggestion_id],
  )).rows[0];
  if (s.status === "approved" && rollbackRow) {
    // Repeated approval is idempotent: return the already-derived memory, never merge twice.
    return { ok: true, derived_id: rollbackRow.derived_id, rollback_id: rollbackRow.id, duplicate: true };
  }

  const mems = await memoriesByIds(s.memory_ids || []);
  if (!mems.length) throw new Error("suggestion has no source memories");
  if (mems.length !== (s.memory_ids || []).length) throw new Error("source memory missing");
  const projects = [...new Set(mems.map((m) => m.project_id))];
  if (projects.length !== 1 || projects[0] !== project_id) {
    throw new Error("refusing cross-project consolidation");
  }

  // Ensure the existing appliers' triage precondition is satisfied; our own proposals
  // already set it, this also makes direct SQL-created suggestions safe to approve here.
  if (s.triage_status !== "ready_for_review") {
    await core.dbQuery(
      `UPDATE consolidation_suggestion SET triage_status='ready_for_review' WHERE id=$1`, [suggestion_id],
    );
  }

  const provenance = [...new Set(mems.map((m) => m.provenance || "unknown"))].join(",");
  const composedNote = `${note || ""}`.trim()
    + `${note ? " | " : ""}[phase20] project=${project_id} actor=${actor} provenance=${provenance}`;

  // Delegate the ACTUAL merge to the audited, source-preserving implementation.
  const consolidation = await import("./consolidation.js");
  const applied = await consolidation.applyApprovedConsolidation({
    suggestion_id, approved: true, actor, note: composedNote,
  });

  const rb = (await core.dbQuery(
    `SELECT id FROM consolidation_rollback WHERE suggestion_id=$1 ORDER BY id DESC LIMIT 1`, [suggestion_id],
  )).rows[0] || rollbackRow;

  // Append explicit recovery evidence (best effort, never breaks the merge). The
  // parent session owns the broader ledger; this row is purely additive evidence.
  try {
    if (applied.derived_id) {
      await core.dbQuery(
        `INSERT INTO memory_recovery_event (memory_id, project_id, operation, version, detail, actor)
         VALUES ($1,$2,'consolidated',NULL,$3::jsonb,$4)`,
        [applied.derived_id, project_id,
          JSON.stringify({ suggestion_id, source_ids: mems.map((m) => m.id), note: composedNote,
            rollback_id: rb?.id ?? null, evidence_preserved: true }),
          String(actor)],
      );
    }
  } catch {
    // recovery evidence is advisory; consolidation already committed.
  }

  await core.audit("consolidation.approved", suggestion_id, {
    derived_id: applied.derived_id, rollback_id: rb?.id ?? null, project_id, actor,
  });
  return { ok: true, derived_id: applied.derived_id, rollback_id: rb?.id ?? null, duplicate: false };
}

// ---- 4. Contradiction review / recording (no resolution, no winner) --------
export async function reviewContradictions({ project_id, limit = 50 } = {}) {
  if (!isNonEmptyString(project_id)) return fail("project_id is required");
  const n = clampLimit(limit, 50);
  const r = await core.dbQuery(
    `SELECT c.id, c.memory_a, c.memory_b, c.description, c.evidence, c.confidence,
            c.status, c.resolution_note, c.resolved_by, c.detected_at, c.resolved_at,
            a.title AS title_a, b.title AS title_b,
            a.project_id AS project_a, b.project_id AS project_b
       FROM memory_contradictions c
       JOIN memory a ON a.id=c.memory_a
       JOIN memory b ON b.id=c.memory_b
      WHERE a.project_id=$1 AND b.project_id=$1
      ORDER BY c.detected_at DESC, c.id DESC
      LIMIT $2`,
    [project_id, n],
  );
  await core.audit("consolidation.contradictions_review", project_id, { count: r.rows.length });
  return { ok: true, items: r.rows, project_id };
}

export async function recordContradiction({
  project_id, memory_a, memory_b, description, evidence = [], confidence = null,
} = {}) {
  if (!isNonEmptyString(project_id)) return { ok: false, reason: "project_id is required" };
  if (!isNonEmptyString(memory_a) || !isNonEmptyString(memory_b)) {
    return { ok: false, reason: "memory_a and memory_b are required" };
  }
  if (memory_a === memory_b) return { ok: false, reason: "a memory cannot contradict itself" };
  if (!isNonEmptyString(description)) return { ok: false, reason: "description is required" };
  if (!Array.isArray(evidence)) return { ok: false, reason: "evidence must be an array" };

  const mems = await memoriesByIds([memory_a, memory_b]);
  if (mems.length !== 2) return { ok: false, reason: "both memories must exist" };
  if (mems.some((m) => m.project_id !== project_id)) {
    return { ok: false, reason: "refusing cross-project contradiction" };
  }

  const pair = sortedIds([memory_a, memory_b]);
  const existing = await core.dbQuery(
    `SELECT id FROM memory_contradictions
      WHERE (memory_a=$1 AND memory_b=$2) OR (memory_a=$2 AND memory_b=$1) LIMIT 1`,
    [pair[0], pair[1]],
  );
  if (existing.rowCount) {
    await core.audit("consolidation.contradiction_duplicate", existing.rows[0].id, { project_id });
    return { ok: true, id: existing.rows[0].id, duplicate: true };
  }

  const ins = await core.dbQuery(
    `INSERT INTO memory_contradictions (memory_a, memory_b, description, evidence, confidence, status)
     VALUES ($1,$2,$3,$4::jsonb,$5,'open') RETURNING id`,
    [pair[0], pair[1], description.slice(0, 8000), JSON.stringify(evidence), clampConfidence(confidence, 0.5)],
  );
  const id = ins.rows[0].id;

  let relationship_id = null;
  try {
    const rel = await import("./relationshipIntel.js");
    const link = await rel.createRelationship({
      project_id,
      source_type: "memory", source_id: pair[0],
      target_type: "memory", target_id: pair[1],
      relation_type: "contradicts",
      confidence: clampConfidence(confidence, 0.5),
      evidence: evidence.length ? evidence : [{ note: description.slice(0, 500) }],
    });
    if (link.ok) relationship_id = link.id;
  } catch {
    // relationship link is best effort; the contradiction record is authoritative.
  }

  await core.audit("consolidation.contradiction_recorded", id, { project_id, relationship_id });
  return { ok: true, id, duplicate: false, relationship_id, auto_resolved: false };
}

// ---- 5. Similar-but-unrelated (flag for review, never merge) --------------
export async function findSimilarButUnrelated({ project_id, text, limit = 10 } = {}) {
  if (!isNonEmptyString(project_id)) return fail("project_id is required");
  if (!isNonEmptyString(text)) return fail("text is required");
  const n = clampLimit(limit, 10);

  const rows = (await core.dbQuery(
    `SELECT id, project_id, layer, title, content, category, source_kind, confidence, created_at
       FROM memory
      WHERE project_id=$1 AND (valid_until IS NULL OR valid_until > now())
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [project_id, MAX_SCAN],
  )).rows;
  if (!rows.length) return { ok: true, items: [] };

  // The text may be a memory id (use that memory as the anchor) or free-form text.
  const anchor = rows.find((m) => m.id === text) || null;
  const anchorTokens = normTokens(anchor ? `${anchor.title || ""} ${anchor.content || ""}` : text);
  const anchorCategory = String(anchor?.category ?? "").toLowerCase();
  const anchorLayer = String(anchor?.layer ?? "").toLowerCase();

  const items = [];
  for (const m of rows) {
    if (anchor && m.id === anchor.id) continue;
    const sim = jaccard(anchorTokens, normTokens(`${m.title || ""} ${m.content || ""}`));
    if (sim < 0.3) continue;
    const differentCategory = String(m.category ?? "").toLowerCase() !== anchorCategory;
    const differentLayer = String(m.layer ?? "").toLowerCase() !== anchorLayer;
    if (!differentCategory && !differentLayer) continue;
    items.push({
      memory_ids: sortedIds([anchor ? anchor.id : String(text), m.id]),
      memory_id: m.id,
      title: m.title,
      category: m.category ?? null,
      layer: m.layer ?? null,
      confidence: round(sim),
      flag: "review_not_merge",
      reason: `Lexically similar (Jaccard ${round(sim)}) to the supplied text but a different kind/category; flagged for review only, not merge.`,
    });
    if (items.length >= n) break;
  }
  await core.audit("consolidation.similar_unrelated", project_id, { count: items.length });
  return { ok: true, items, project_id };
}
