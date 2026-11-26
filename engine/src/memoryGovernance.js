// Phase 14 governance: reversible scope-review workflow + explainable quality.
//
// Design rules (every function below obeys them):
//   - Classification and reporting are READ-ONLY. They never UPDATE/DELETE memory.
//   - Scope changes are PROPOSALS until an explicit approval is supplied.
//   - Every applied change records the previous values so it can be rolled back.
//   - A private/project memory is NEVER proposed for global scope automatically.
//   - No claim of "accuracy" is made without observed evidence.
import * as core from "./core.js";
import { isGloballyEligible, GLOBAL_PROJECT_ID } from "./memoryScope.js";

const DAY = 86400000;

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const bounded = (n, fallback, max) => (Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback);
const observed = (value, source, measurement = "observed") => ({ value, measurement, source });

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

// A concrete project/project-path reference in a session id or content body.
// Used only as a *signal* for classification/evidence, never to auto-apply scope.
const PROJECT_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>]{2,}|(?:https?:\/\/)?(?:github|gitlab|bitbucket)\.com[:/][^\s"'<>]+|\/(?:home|Users|workspace|workspaces|repos|src|srv|opt|var)\/[^\s"'<>]+)/i;

function projectSignals(m) {
  const reasons = [];
  const snippets = {};
  let project_id = null;
  const md = parseJson(m.metadata, {}) || {};
  if (typeof md.project_id === "string" && md.project_id.length && md.project_id !== GLOBAL_PROJECT_ID) {
    project_id = md.project_id;
    reasons.push("metadata.project_id");
    snippets.project_id = md.project_id;
  }
  const session = String(m.source_session || "");
  const content = String(m.content || "");
  const pathMatch = `${session} ${content}`.match(PROJECT_PATH_RE);
  if (pathMatch) {
    reasons.push("project path/reference in source_session or content");
    snippets.path = pathMatch[0].slice(0, 160);
  }
  if (/[\\/]/.test(session) && session.length > 3) {
    reasons.push("source_session contains a path-like token");
    snippets.source_session = session.slice(0, 160);
  }
  return { matched: reasons.length > 0, reasons, snippets, project_id };
}

// Pure classification of one memory row. Row must come from `loadGlobalMemories`
// (or carry the same fields). No side effects.
function classifyMemory(m) {
  if (isGloballyEligible(m)) {
    return {
      category: "proven_global",
      reason: m.global_eligible === true
        ? "explicit global_eligible flag"
        : "verified user fact with explicit global_approval metadata",
      evidence: {
        global_eligible: !!m.global_eligible,
        source_kind: m.source_kind,
        layer: m.layer,
        verified: !!m.verified,
      },
    };
  }
  if (["OUTDATED", "ARCHIVED", "REJECTED"].includes(m.lifecycle) || m.valid_until) {
    return {
      category: "historical_record",
      reason: m.valid_until ? "memory has a valid_until expiry" : `lifecycle is ${m.lifecycle}`,
      evidence: { lifecycle: m.lifecycle, valid_until: m.valid_until || null },
    };
  }
  const sig = projectSignals(m);
  if (sig.matched) {
    return {
      category: "project_private_candidate",
      reason: `concrete project context: ${sig.reasons.join("; ")}`,
      evidence: { signals: sig.reasons, snippets: sig.snippets, project_id: sig.project_id },
    };
  }
  return {
    category: "uncertain_origin",
    reason: "no explicit global approval and no concrete project signal",
    evidence: { source_kind: m.source_kind, layer: m.layer, verified: !!m.verified },
  };
}

async function loadGlobalMemories({ memory_id = null, project_id = null } = {}) {
  const r = await core.dbQuery(
    `SELECT id, title, project_id, source_session, source_kind, layer, verified, confidence,
            lifecycle, valid_until, provenance, global_eligible, metadata, quality_score,
            useful_count, retrieved_count, created_at, updated_at
     FROM memory
     WHERE project_id = $1
       AND ($2::uuid IS NULL OR id = $2)
       AND ($3::text IS NULL OR project_id = $3)
     ORDER BY created_at DESC`,
    [GLOBAL_PROJECT_ID, memory_id || null, project_id || null],
  );
  return r.rows;
}

/**
 * READ-ONLY classification of every `_global` memory into four buckets.
 * Counts cover ALL matching rows; `items` is bounded by `limit`.
 */
export async function classifyGlobalMemories({ limit = 500, memory_id = null } = {}) {
  const n = bounded(limit, 500, 500);
  const rows = await loadGlobalMemories({ memory_id });
  const counts = { proven_global: 0, project_private_candidate: 0, uncertain_origin: 0, historical_record: 0 };
  const items = [];
  for (const m of rows) {
    const c = classifyMemory(m);
    counts[c.category] += 1;
    if (items.length < n) {
      items.push({
        id: m.id,
        title: m.title,
        project_id: m.project_id,
        source_kind: m.source_kind,
        layer: m.layer,
        verified: !!m.verified,
        category: c.category,
        reason: c.reason,
        evidence: c.evidence,
      });
    }
  }
  return {
    ok: true,
    total: rows.length,
    counts,
    items,
    auto_applied: 0,
    destructive_operations: 0,
    note: "Read-only classification audit. No memory row is read with intent to change, and none is changed.",
  };
}

/**
 * Build scope-correction PROPOSALS for ineligible `_global` memories.
 * Rows are inserted ONLY when dry_run === false. Idempotent against pending reviews.
 * Never proposes 'global' and never touches the memory table.
 */
export async function proposeScopeCorrections({ limit = 200, dry_run = true, memory_id = null } = {}) {
  const n = bounded(limit, 200, 500);
  const rows = await loadGlobalMemories({ memory_id });
  const pending = new Set(
    (await core.dbQuery("SELECT memory_id FROM scope_review WHERE status='pending'")).rows.map((r) => r.memory_id),
  );

  const proposals = [];
  let skipped_existing = 0;
  for (const m of rows) {
    if (pending.has(m.id)) { skipped_existing += 1; continue; }
    const c = classifyMemory(m);
    // Proven-global and historical records need no corrective proposal.
    if (c.category === "proven_global" || c.category === "historical_record") continue;

    const target = c.evidence?.project_id || null;
    // Conservative default: never 'global'. A concrete metadata project -> 'project',
    // everything else -> 'private'.
    const proposed_scope = target ? "project" : "private";
    const reason = `${c.category}: ${c.reason}`;
    const evidence = {
      category: c.category,
      reason: c.reason,
      signals: c.evidence?.signals || [],
      snippets: c.evidence?.snippets || {},
      target_project_id: target,
      source_kind: m.source_kind,
      layer: m.layer,
      verified: !!m.verified,
    };
    const proposal = {
      memory_id: m.id,
      proposed_scope,
      reason,
      evidence,
      original_scope: "global",
      original_global_eligible: !!m.global_eligible,
      original_metadata: parseJson(m.metadata, {}) || {},
    };
    proposals.push(proposal);
    pending.add(m.id); // guard against duplicates within the same run
    if (proposals.length >= n) break;
  }

  let created = 0;
  if (dry_run === false) {
    for (const p of proposals) {
      const r = await core.dbQuery(
        `INSERT INTO scope_review
           (memory_id, proposed_scope, reason, evidence, original_scope, original_global_eligible, original_metadata)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)`,
        [p.memory_id, p.proposed_scope, p.reason, JSON.stringify(p.evidence),
          p.original_scope, p.original_global_eligible, JSON.stringify(p.original_metadata)],
      );
      created += r.rowCount;
    }
    await core.audit("governance.proposals_created", "all", { created, dry_run: false });
  }

  return {
    ok: true,
    dry_run: dry_run === true,
    created,
    skipped_existing,
    proposals,
    auto_applied: 0,
    destructive_operations: 0,
    note: "Read-only proposal generation unless dry_run=false; only scope_review rows are inserted. Memory rows are never modified here.",
  };
}

export async function listScopeReviews({ status = null, limit = 200 } = {}) {
  const n = bounded(limit, 200, 500);
  const rows = (await core.dbQuery(
    `SELECT * FROM scope_review
     WHERE ($1::text IS NULL OR status=$1)
     ORDER BY created_at DESC LIMIT $2`, [status || null, n],
  )).rows;
  return { ok: true, total: rows.length, reviews: rows, note: "read-only" };
}

async function getReview(id) {
  const r = (await core.dbQuery("SELECT * FROM scope_review WHERE id=$1", [id])).rows[0];
  if (!r) throw new Error("scope review not found");
  return r;
}

function hasExplicitApproval({ approved, reviewer } = {}) {
  return approved === true || (typeof reviewer === "string" && reviewer.trim().length > 0);
}

// Apply ONLY the proposed scope plus its rollback snapshot. Returns rollback data.
async function applyProposedScope(memory, review, reviewer) {
  const scope = review.proposed_scope;
  // Always snapshot the full original scope state so any change is reversible
  // and the original values are preserved for audit, regardless of scope type.
  const rollback = {
    previous: {
      project_id: memory.project_id,
      global_eligible: !!memory.global_eligible,
      metadata: parseJson(memory.metadata, {}) || {},
    },
    proposed_scope: scope,
    reviewer: reviewer || null,
    applied_at: new Date().toISOString(),
  };
  const fields = [];
  const values = [];
  const nextParam = () => `$${values.length + 1}`;

  if (scope === "project") {
    const target = parseJson(review.evidence, {})?.target_project_id;
    if (typeof target !== "string" || !target.length || target === GLOBAL_PROJECT_ID) {
      throw new Error("cannot apply project scope without a concrete target project");
    }
    rollback.previous.project_id = memory.project_id;
    rollback.previous.global_eligible = !!memory.global_eligible;
    fields.push(`project_id=${nextParam()}`); values.push(target);
    fields.push("global_eligible=false");
  } else if (scope === "global") {
    // Only reachable for a manually-authored review with explicit approval; the
    // proposal generator never emits 'global'.
    rollback.previous.project_id = memory.project_id;
    rollback.previous.global_eligible = !!memory.global_eligible;
    fields.push("project_id=$1"); values.push(GLOBAL_PROJECT_ID);
    fields.push("global_eligible=true");
  } else if (scope === "private") {
    rollback.previous.global_eligible = !!memory.global_eligible;
    rollback.previous.metadata = parseJson(memory.metadata, {}) || {};
    fields.push("global_eligible=false");
    fields.push("metadata = metadata || '{\"private_scope\": true}'::jsonb");
  } else {
    rollback.noop = true; // 'unchanged'
  }

  if (fields.length) {
    values.push(memory.id);
    await core.dbQuery(`UPDATE memory SET ${fields.join(", ")} WHERE id=$${values.length}`, values);
  }
  return rollback;
}

export async function approveScopeReview({ id, approved, reviewer = "", note = "" } = {}) {
  if (!hasExplicitApproval({ approved, reviewer })) {
    throw new Error("explicit approval required: pass approved:true or a non-empty reviewer");
  }
  const review = await getReview(id);
  if (review.status !== "pending") throw new Error(`review is ${review.status}, not pending`);
  const memory = (await core.dbQuery("SELECT * FROM memory WHERE id=$1", [review.memory_id])).rows[0];
  if (!memory) throw new Error("memory not found");
  const rollback = await applyProposedScope(memory, review, reviewer);
  await core.dbQuery(
    `UPDATE scope_review SET status='approved', reviewer=$2, review_note=$3, rollback=$4::jsonb, decided_at=now()
     WHERE id=$1`, [id, reviewer || null, note || null, JSON.stringify(rollback)],
  );
  await core.audit("governance.scope_approved", id, { memory_id: review.memory_id, proposed_scope: review.proposed_scope, reviewer });
  return { ok: true, id, status: "approved", proposed_scope: review.proposed_scope, rollback };
}

export async function rejectScopeReview({ id, rejected, reviewer = "", note = "" } = {}) {
  if (!(rejected === true || (typeof reviewer === "string" && reviewer.trim().length > 0))) {
    throw new Error("explicit rejection required: pass rejected:true or a non-empty reviewer");
  }
  const review = await getReview(id);
  if (review.status !== "pending") throw new Error(`review is ${review.status}, not pending`);
  await core.dbQuery(
    `UPDATE scope_review SET status='rejected', reviewer=$2, review_note=$3, decided_at=now() WHERE id=$1`,
    [id, reviewer || null, note || null],
  );
  await core.audit("governance.scope_rejected", id, { memory_id: review.memory_id, reviewer });
  return { ok: true, id, status: "rejected", memory_changed: false };
}

export async function rollbackScopeReview({ id, reviewer = "" } = {}) {
  const review = await getReview(id);
  if (review.status !== "approved") throw new Error(`review is ${review.status}, not approved`);
  const previous = parseJson(review.rollback, {})?.previous || {};
  const fields = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(previous, "project_id")) {
    fields.push(`project_id=$${values.length + 1}`); values.push(previous.project_id);
  }
  if (Object.prototype.hasOwnProperty.call(previous, "global_eligible")) {
    fields.push(`global_eligible=$${values.length + 1}`); values.push(!!previous.global_eligible);
  }
  if (Object.prototype.hasOwnProperty.call(previous, "metadata")) {
    fields.push(`metadata=$${values.length + 1}::jsonb`); values.push(JSON.stringify(previous.metadata || {}));
  }
  if (fields.length) {
    values.push(review.memory_id);
    await core.dbQuery(`UPDATE memory SET ${fields.join(", ")} WHERE id=$${values.length}`, values);
  }
  await core.dbQuery(
    `UPDATE scope_review SET status='rolled_back', reviewer=$2, decided_at=now() WHERE id=$1`,
    [id, reviewer || review.reviewer || null],
  );
  await core.audit("governance.scope_rolled_back", id, { memory_id: review.memory_id, reviewer });
  return { ok: true, id, status: "rolled_back", memory_id: review.memory_id };
}

/**
 * READ-ONLY maintenance report: stale / duplicate / contradiction / suggestion
 * signals, project-scoped, with bounded items. Makes no changes.
 */
export async function staleDuplicateContradictionReport({ project_id, limit = 100 } = {}) {
  const n = bounded(limit, 100, 500);
  const memories = (await core.dbQuery(
    `SELECT id, title, project_id, lifecycle, valid_until, updated_at, quality_score, retrieved_count, useful_count, provenance
     FROM memory WHERE ($1::text IS NULL OR project_id=$1)
     ORDER BY updated_at DESC LIMIT $2`, [project_id || null, n],
  )).rows;
  const stale = memories.filter((m) =>
    m.valid_until || ["OUTDATED", "ARCHIVED"].includes(m.lifecycle)
    || (Date.now() - new Date(m.updated_at).getTime()) > 180 * DAY);
  const unused = memories.filter((m) => Number(m.retrieved_count || 0) === 0);
  const low_quality = memories.filter((m) => Number(m.quality_score || 0) < 0.35);

  const dupes = (await core.dbQuery(
    `SELECT r.source_id, r.target_id, r.relation, r.score, r.status, a.project_id
     FROM memory_relationships r JOIN memory a ON a.id=r.source_id
     WHERE r.relation IN ('duplicate','near_duplicate','semantic_equivalent')
       AND ($1::text IS NULL OR a.project_id=$1)
     ORDER BY r.score DESC LIMIT $2`, [project_id || null, n],
  )).rows;
  const contradictions = (await core.dbQuery(
    `SELECT c.memory_a, c.memory_b, c.description, c.status, c.confidence, a.project_id
     FROM memory_contradictions c JOIN memory a ON a.id=c.memory_a
     WHERE c.status IN ('open','reviewing') AND ($1::text IS NULL OR a.project_id=$1)
     ORDER BY c.detected_at DESC LIMIT $2`, [project_id || null, n],
  )).rows;
  const suggestions = (await core.dbQuery(
    `SELECT id, kind, status, title, confidence, created_at
     FROM consolidation_suggestion WHERE status='pending'
     ORDER BY created_at DESC LIMIT $1`, [n],
  )).rows;

  return {
    ok: true,
    project_id: project_id || null,
    counts: {
      scanned: memories.length,
      stale: stale.length,
      unused: unused.length,
      low_quality: low_quality.length,
      duplicate_relations: dupes.length,
      contradictions: contradictions.length,
      pending_suggestions: suggestions.length,
    },
    stale: stale.slice(0, 20),
    unused: unused.slice(0, 20),
    low_quality: low_quality.slice(0, 20),
    duplicate_relations: dupes.slice(0, 20),
    contradictions: contradictions.slice(0, 20),
    suggestions: suggestions.slice(0, 20),
    changes_applied: 0,
    destructive_operations: 0,
    note: "Read-only report. No deletion, promotion, or auto-merge; every metric comes from observed rows.",
  };
}

/**
 * Explainable, READ-ONLY quality breakdown over real rows. Reports measured
 * values and a transparent computed score. Makes no accuracy claim.
 */
export async function memoryQualityExplainability({ memory_id } = {}) {
  const m = await core.getMemory(memory_id);
  if (!m) throw new Error("memory not found");
  const contradictions = (await core.dbQuery(
    `SELECT count(*)::int n FROM memory_contradictions WHERE status='open' AND (memory_a=$1 OR memory_b=$1)`, [memory_id],
  )).rows[0].n;
  const signals = (await core.dbQuery(
    `SELECT signal,count(*)::int n FROM memory_usefulness_observations WHERE memory_id=$1 GROUP BY 1`, [memory_id],
  )).rows;
  const helpful = signals.filter((s) => ["helpful", "observed_usage", "used"].includes(s.signal)).reduce((a, s) => a + s.n, 0);
  const unhelpful = signals.filter((s) => ["unhelpful", "not_used"].includes(s.signal)).reduce((a, s) => a + s.n, 0);
  const ageDays = (Date.now() - new Date(m.updated_at).getTime()) / DAY;

  const provValue = m.provenance === "production" ? 0.9 : m.provenance === "test_fixture" ? 0.2 : 0.4;
  const usefulnessValue = clamp(0.5 + helpful * 0.1 - unhelpful * 0.15 + Number(m.useful_count || 0) * 0.02);
  const recencyValue = clamp(1 - Math.max(0, ageDays) / 365);

  const components = {
    provenance: observed(provValue, "memory.provenance"),
    confidence: observed(clamp(m.confidence), "memory.confidence"),
    usefulness: observed(usefulnessValue, "memory_usefulness_observations + memory.useful_count"),
    retrieval_count: observed(Number(m.retrieved_count || 0), "memory.retrieved_count"),
    verification: observed(m.verified ? 1 : 0, "memory.verified"),
    contradictions: observed(contradictions, "memory_contradictions"),
    recency: observed(recencyValue, "memory.updated_at"),
  };

  const contradictionPenalty = -Math.min(0.3, contradictions * 0.1);
  const score = clamp(
    0.15 * components.provenance.value
    + 0.20 * components.confidence.value
    + 0.20 * components.usefulness.value
    + 0.10 * Math.min(1, components.retrieval_count.value / 10)
    + 0.15 * components.verification.value
    + 0.10 * components.recency.value
    + contradictionPenalty,
  );

  return {
    ok: true,
    memory_id,
    components,
    computed_score: Number(score.toFixed(3)),
    score_formula: "0.15*provenance + 0.20*confidence + 0.20*usefulness + 0.10*min(1,retrieval_count/10) + 0.15*verification + 0.10*recency - min(0.30,contradictions*0.10)",
    accuracy_claim: "not assessed",
    note: "Transparent heuristic over observed fields. Retrieval counts and AI interpretations never establish accuracy; no accuracy is claimed without evidence.",
    calculated_at: new Date().toISOString(),
  };
}
