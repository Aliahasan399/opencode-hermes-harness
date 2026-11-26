// Phase 21 workstream C — learning consolidation and learning-aware retrieval.
//
// Additive-only layer over `learning_record` / `pattern` (migrations 019 / 002)
// and `knowledge_quality` / `knowledge_relationship` (migration 015).
//
// Invariants (all enforced here, never delegated to callers):
//   - No LLM calls and no network calls. Similarity is deterministic token overlap.
//   - No destructive SQL: no DELETE / TRUNCATE / DROP. Consolidation marks a row
//     `superseded` and records `superseded_by`; it never removes a row. Both
//     evidence sets and all provenance survive.
//   - Every read and write is strictly project-scoped. There is no code path that
//     touches another project's row by id or by signature.
//   - Confidence is never invented; it is only clamped from stored/quality values.
//   - Verification is preserved on consolidation (never silently promoted/demoted).
//   - Contradictions are surfaced, never resolved by picking one side.
//   - Everything is bounded (scan + result caps); all content is redacted via core.redact.
//
// The exported functions deliberately return items shaped for `contextRanker.rankAndFilter`
// so the parent integration can append them to its candidate list unchanged.

import * as core from "./core.js";
import { GLOBAL_PROJECT_ID } from "./memoryScope.js";
import { VERIFICATION, qualityRank } from "./knowledgeQuality.js";

const LEARNING_FIELDS = `id, project_id, session_id, signature, category, problem,
  approach, outcome, verification, confidence, confidence_breakdown, reusability,
  evidence, status, superseded_by, created_at, updated_at`;

const PATTERN_FIELDS = `id, kind, pattern_key, description, occurrences, sessions,
  projects, evidence, confidence, verified, first_observed, last_observed,
  created_at, updated_at`;

const MAX_SCAN = 2000;
const MAX_SCAN_LEARNING = 1000;
const MAX_EVIDENCE_STORED = 200;
const MAX_TEXT = 4000;
const MAX_SIGNATURE = 512;
const MAX_ID = 160;
const MAX_REASON = 400;
const MAX_SUPPORTS = 20;
const MAX_LABELS = 10;
const DAY_MS = 86400000;

// Statuses that make a learning record ineligible for ordinary context.
const INELIGIBLE_STATUS = new Set(["archived", "rejected", "deleted", "superseded"]);
const VALID_VERIFICATION = new Set(Object.values(VERIFICATION));

// Sorting-only verification weights used when producing learning item scores.
// These are NOT confidence values.
const VERIFICATION_SCORE = Object.freeze({
  [VERIFICATION.VERIFIED]: 0.25,
  [VERIFICATION.OBSERVED]: 0.15,
  [VERIFICATION.INFERRED]: 0.05,
  [VERIFICATION.UNCERTAIN]: -0.1,
  [VERIFICATION.CONTRADICTED]: -0.2,
  [VERIFICATION.STALE]: -0.15,
  [VERIFICATION.SUPERSEDED]: -0.3,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEGATION_MARKER = /^\s*(contradicts?|negates?|refutes?|opposes?)\s*:/i;
const STALE_MARKER = /^\s*status\s*:\s*(stale|contradicted|outdated)\b/i;

const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "this", "that", "with", "from", "into",
  "when", "then", "than", "have", "has", "had", "are", "not", "but", "you",
  "your", "our", "its", "how", "why", "what", "which", "does", "did", "use",
  "using", "used", "fix", "about", "over", "after", "before", "the", "a",
]);

// ---------------------------------------------------------------------------
// Small, pure helpers
// ---------------------------------------------------------------------------

function ok(fields) { return { ok: true, ...fields }; }

function fail(reason, fields = {}) {
  return { ok: false, merged: 0, contradictions: [], examined: 0, proposals: [], reason, ...fields };
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validProjectId(project_id) {
  return nonEmptyString(project_id) && project_id.trim() !== GLOBAL_PROJECT_ID;
}

function cleanText(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return "";
  return core.redact(String(v)).replace(/\s+/g, " ").trim().slice(0, max);
}

function short(value, n = 160) {
  return cleanText(value, n);
}

function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clampConfidence(c) {
  if (c === null || c === undefined || c === "") return null;
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function boundedInt(value, fallback, cap) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, cap) : fallback;
}

function normalizeVerification(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return VALID_VERIFICATION.has(s) ? s : VERIFICATION.OBSERVED;
}

function normalizeSignature(signature) {
  return String(signature ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, MAX_SIGNATURE);
}

function tokenize(value) {
  const out = new Set();
  for (const token of String(value ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 2 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

function evidenceString(value) {
  if (typeof value === "string") return core.redact(value).trim();
  if (value && typeof value === "object") {
    try { return core.redact(JSON.stringify(value, Object.keys(value).sort())); }
    catch { return core.redact(String(value)); }
  }
  return core.redact(String(value ?? "")).trim();
}

// Keep the original array (do not stringify objects): history entries carry their
// own timestamp/event and must survive consolidation intact.
function evidenceArray(value) {
  return Array.isArray(value) ? value : [];
}

// Dedupe identical strings, preserve object history entries, stable order, bounded.
function mergeEvidence(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item === "string") {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
      } else if (item && typeof item === "object") {
        out.push(item);
      }
    }
  }
  return out.length > MAX_EVIDENCE_STORED ? out.slice(out.length - MAX_EVIDENCE_STORED) : out;
}

function historyEntry(event, details) {
  return { event, at: new Date().toISOString(), ...details };
}

function markerReason(entry) {
  const candidates = [];
  if (typeof entry === "string") candidates.push(entry);
  else if (entry && typeof entry === "object") {
    for (const value of Object.values(entry)) if (typeof value === "string") candidates.push(value);
    candidates.push(evidenceString(entry));
  }
  for (const value of candidates) {
    if (NEGATION_MARKER.test(value)) return `explicit negation: ${short(value, 180)}`;
    if (STALE_MARKER.test(value)) return `explicit stale/contradicted marker: ${short(value, 180)}`;
  }
  return null;
}

// Only explicit markers or materially different outcomes count as conflicts.
// Keyword overlap alone never does.
function detectConflict(a, b) {
  for (const row of [a, b]) {
    for (const entry of evidenceArray(row.evidence)) {
      const reason = markerReason(entry);
      if (reason) return reason;
    }
  }
  const outcomeA = cleanText(a.outcome, 300);
  const outcomeB = cleanText(b.outcome, 300);
  if (outcomeA && outcomeB && outcomeA.toLowerCase() !== outcomeB.toLowerCase()) {
    return "outcomes differ between duplicate learning records";
  }
  return null;
}

function isFresh(freshness_at, nowMs = Date.now()) {
  if (!freshness_at) return false;
  const t = Date.parse(freshness_at);
  if (Number.isNaN(t)) return false;
  const age = nowMs - t;
  return age >= -DAY_MS && age <= 30 * DAY_MS;
}

async function withTx(fn) {
  return core.withDb(async (client) => {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  });
}

async function auditSafe(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* auditing must never break the primary operation */ }
}

// ---------------------------------------------------------------------------
// Relationship writing (best-effort, dynamic import — "if available")
// ---------------------------------------------------------------------------

async function relationshipWriter() {
  try {
    const mod = await import("./relationshipIntel.js");
    return typeof mod?.createRelationship === "function" ? mod.createRelationship : null;
  } catch {
    return null;
  }
}

async function writeRelationships(project_id, proposals) {
  const create = await relationshipWriter();
  if (!create) return 0;
  let written = 0;
  for (const proposal of proposals) {
    const stamp = new Date().toISOString();
    const derivedEvidence = [`learning.consolidate:${stamp} ${proposal.source_id} -> ${proposal.canonical_id}`];
    try {
      const r = await create({
        project_id,
        source_type: "learning_record",
        source_id: proposal.source_id,
        target_type: "learning_record",
        target_id: proposal.canonical_id,
        relation_type: "derived_from",
        confidence: 0.9,
        evidence: derivedEvidence,
      });
      if (r?.ok) written += 1;
    } catch { /* relationship write is advisory */ }

    if (proposal.contradiction) {
      try {
        const r = await create({
          project_id,
          source_type: "learning_record",
          source_id: proposal.canonical_id,
          target_type: "learning_record",
          target_id: proposal.source_id,
          relation_type: "contradicts",
          confidence: 0.8,
          evidence: [proposal.contradiction.reason],
        });
        if (r?.ok) written += 1;
      } catch { /* relationship write is advisory */ }
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// 1. consolidateLearning
// ---------------------------------------------------------------------------

/**
 * Find same-project learning records with an identical normalized signature and
 * consolidate them. In dry-run (the default) nothing is written: candidate pairs
 * are returned in `proposals`. With dry_run:false, evidence arrays are merged into
 * the canonical (oldest) record and duplicates are marked `superseded` with
 * `superseded_by` pointing at the canonical — never deleted. Verification and
 * project scope are preserved. Idempotent: a second run merges nothing.
 */
export async function consolidateLearning({ project_id, limit = 50, dry_run = true } = {}) {
  if (!validProjectId(project_id)) return fail("invalid_project_id");
  const pid = project_id.trim();
  const n = boundedInt(limit, 50, MAX_SCAN);
  const isDry = dry_run !== false;

  try {
    const rows = (await core.dbQuery(
      `SELECT ${LEARNING_FIELDS} FROM learning_record
        WHERE project_id=$1 AND status='active'
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [pid, n],
    )).rows;
    const examined = rows.length;

    const groups = new Map();
    for (const row of rows) {
      const key = normalizeSignature(row.signature);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const proposals = [];
    const contradictions = [];
    const writes = [];

    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const canonical = group[0];
      let canonicalEvidence = evidenceArray(canonical.evidence).slice();

      for (let i = 1; i < group.length; i += 1) {
        const other = group[i];
        const conflict = detectConflict(canonical, other);
        const proposal = {
          canonical_id: canonical.id,
          source_id: other.id,
          normalized_signature: key,
          source_signature: other.signature,
          evidence_count: evidenceArray(other.evidence).length,
          action: isDry ? "proposed" : "applied",
          contradiction: conflict
            ? { canonical_id: canonical.id, source_id: other.id, reason: conflict, resolution: "kept both evidence sets" }
            : null,
        };
        proposals.push(proposal);
        if (conflict) contradictions.push(proposal.contradiction);

        if (!isDry) {
          const provenance = historyEntry("learning.consolidated", {
            role: "canonical", merged_from: other.id, merged_signature: other.signature,
            by_normalized_signature: true,
          });
          const sourceEntry = historyEntry("learning.consolidated", {
            role: "source", merged_into: canonical.id, merged_signature: canonical.signature,
          });
          const otherEvidence = evidenceArray(other.evidence);
          const events = conflict
            ? [provenance, historyEntry("learning.contradiction", { with: other.id, reason: conflict })]
            : [provenance];
          canonicalEvidence = mergeEvidence([canonicalEvidence, otherEvidence, events]);
          const sourceEvidence = mergeEvidence([otherEvidence, [sourceEntry]]);
          writes.push({
            canonical_id: canonical.id,
            canonical_evidence: canonicalEvidence,
            source_id: other.id,
            source_evidence: sourceEvidence,
          });
        }
      }
    }

    if (!isDry && writes.length > 0) {
      await withTx(async (client) => {
        for (const w of writes) {
          await client.query(
            `UPDATE learning_record
                SET evidence=$2::jsonb, updated_at=now()
              WHERE id=$1 AND project_id=$3`,
            [w.canonical_id, JSON.stringify(w.canonical_evidence), pid],
          );
          await client.query(
            `UPDATE learning_record
                SET status='superseded', superseded_by=$2, evidence=$3::jsonb, updated_at=now()
              WHERE id=$1 AND project_id=$4 AND status='active'`,
            [w.source_id, w.canonical_id, JSON.stringify(w.source_evidence), pid],
          );
        }
      });
      // Advisory relationship writes never fail the consolidation itself.
      await writeRelationships(pid, proposals);
      await auditSafe("learning.consolidate", pid, {
        merged: writes.length, contradictions: contradictions.length, examined,
      });
    }

    const out = ok({
      merged: isDry ? 0 : writes.length,
      contradictions,
      examined,
      proposals,
      dry_run: isDry,
    });
    if (!isDry) out.relationships_considered = proposals.length;
    return out;
  } catch {
    return fail("learning request could not be completed");
  }
}

// ---------------------------------------------------------------------------
// 2. learningContextItems
// ---------------------------------------------------------------------------

function eligibleLearning(row) {
  const status = String(row.status ?? "").trim().toLowerCase();
  if (INELIGIBLE_STATUS.has(status)) return false;
  if (normalizeVerification(row.verification) === VERIFICATION.SUPERSEDED) return false;
  return true;
}

function learningText(row) {
  const parts = [row.problem, row.approach, row.outcome]
    .map((x) => cleanText(x, 800)).filter(Boolean);
  return parts.join(" — ") || cleanText(row.signature, MAX_TEXT);
}

function buildReason(type, verification, fresh, matched, lifecycle, extra) {
  const labels = [];
  if (verification === VERIFICATION.VERIFIED) labels.push("verified");
  if ([VERIFICATION.UNCERTAIN, VERIFICATION.CONTRADICTED, VERIFICATION.STALE].includes(verification)) {
    labels.push(verification);
  }
  if (fresh) labels.push("fresh");
  if (lifecycle) labels.push(`lifecycle:${lifecycle}`);
  const parts = [`${type} ${verification}`];
  if (labels.length) parts.push(`[${labels.slice(0, MAX_LABELS).join(",")}]`);
  if (extra) parts.push(short(extra, 120));
  if (matched && matched.length) parts.push(`matched:${matched.slice(0, 8).join(",")}`);
  return parts.join(" ").slice(0, MAX_REASON);
}

function scoreFor(qTokens, tokens, verification, freshness_at) {
  const matched = qTokens.length ? qTokens.filter((t) => tokens.has(t)) : [];
  const base = qTokens.length ? matched.length / qTokens.length : 0.1;
  const verificationBonus = VERIFICATION_SCORE[verification] ?? 0;
  const freshnessBonus = isFresh(freshness_at) ? 0.1 : 0;
  const raw = base + verificationBonus + freshnessBonus;
  const score = Math.round(Math.max(-1, Math.min(2, raw)) * 1000) / 1000;
  return { score, matched };
}

async function qualityMap(project_id, subject_ids) {
  if (!subject_ids.length) return new Map();
  try {
    const r = await core.dbQuery(
      `SELECT subject_type, subject_id, verification, confidence, evidence_sources, freshness_at
         FROM knowledge_quality
        WHERE project_id=$1 AND subject_id = ANY($2::text[])
        LIMIT $3`,
      [project_id, subject_ids, MAX_SCAN],
    );
    const map = new Map();
    for (const row of r.rows) {
      const key = `${row.subject_type}\u0000${row.subject_id}`;
      if (!map.has(key)) map.set(key, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function linkedLifecycleMap(project_id, keys) {
  if (!keys.length) return new Map();
  const map = new Map();
  try {
    const pairs = [];
    for (const key of keys) {
      const [type, id] = key.split("\u0000");
      pairs.push([type, id]);
    }
    // Bounded project-scoped lookup for links whose other side is a memory.
    for (const [type, id] of pairs.slice(0, 50)) {
      const rel = await core.dbQuery(
        `SELECT source_type, source_id, target_type, target_id
           FROM knowledge_relationship
          WHERE project_id=$1
            AND ((source_type=$2 AND source_id=$3 AND target_type='memory')
              OR (target_type=$2 AND target_id=$3 AND source_type='memory'))
          LIMIT 5`,
        [project_id, type, id],
      );
      for (const r of rel.rows) {
        const memoryId = r.source_type === "memory" ? r.source_id : r.target_id;
        const mem = await core.dbQuery(
          "SELECT lifecycle FROM memory WHERE id=$1 AND project_id=$2 LIMIT 1",
          [memoryId, project_id],
        );
        if (mem.rows[0]?.lifecycle) map.set(`${type}\u0000${id}`, mem.rows[0].lifecycle);
      }
    }
  } catch {
    /* link metadata is optional */
  }
  return map;
}

function preferredQuality(map, type, id) {
  for (const candidate of [type, type === "learning_record" ? "learning" : type]) {
    const found = map.get(`${candidate}\u0000${id}`);
    if (found) return found;
  }
  return null;
}

/**
 * Bounded, project-scoped, query-filtered learning/pattern items. Each item is
 * shaped for `contextRanker.rankAndFilter` (type, id, text, verification,
 * confidence, freshness_at, project_id, reason, source, lifecycle, score).
 * Verified+fresh items are preferred; uncertain/contradicted/stale items are
 * retained but labelled; archived/superseded/ineligible rows are excluded.
 */
export async function learningContextItems({ project_id, query = "", limit = 8 } = {}) {
  if (!validProjectId(project_id)) return { ok: false, items: [], reason: "invalid_project_id" };
  const pid = project_id.trim();
  const n = boundedInt(limit, 8, 50);
  // An array (not a Set) so .length/.some/.filter work; item tokens stay a Set
  // for O(1) membership tests.
  const qTokens = [...tokenize(query)];

  try {
    const [learningRes, patternRes] = await Promise.all([
      core.dbQuery(
        `SELECT ${LEARNING_FIELDS} FROM learning_record
          WHERE project_id=$1
          ORDER BY updated_at DESC, id DESC
          LIMIT $2`,
        [pid, MAX_SCAN_LEARNING],
      ),
      core.dbQuery(
        `SELECT ${PATTERN_FIELDS} FROM pattern
          WHERE projects @> ARRAY[$1]::text[]
          ORDER BY last_observed DESC, id DESC
          LIMIT $2`,
        [pid, MAX_SCAN],
      ),
    ]);

    const candidates = [];

    for (const row of learningRes.rows) {
      if (!eligibleLearning(row)) continue;
      const text = learningText(row);
      const tokens = tokenize(`${text} ${row.signature ?? ""} ${row.category ?? ""}`);
      if (qTokens.length && !qTokens.some((t) => tokens.has(t))) continue;
      const verification = normalizeVerification(row.verification);
      const freshness_at = isoDate(row.updated_at ?? row.created_at);
      const fresh = isFresh(freshness_at);
      const { score, matched } = scoreFor(qTokens, tokens, verification, freshness_at);
      candidates.push({
        type: "learning",
        id: short(row.id, MAX_ID),
        text,
        verification,
        confidence: clampConfidence(row.confidence),
        freshness_at,
        project_id: pid,
        reason: buildReason("learning", verification, fresh, matched, null,
          `${row.category ?? "pattern"} ${row.status ?? "active"}`),
        source: `learning_record:${short(row.session_id ?? "", 60)}`,
        score,
        _key: `learning_record\u0000${row.id}`,
        _verification: verification,
      });
    }

    for (const row of patternRes.rows) {
      const text = cleanText(row.description, MAX_TEXT);
      if (!text) continue;
      const tokens = tokenize(`${text} ${row.pattern_key ?? ""} ${row.kind ?? ""}`);
      if (qTokens.length && !qTokens.some((t) => tokens.has(t))) continue;
      const verification = row.verified === true ? VERIFICATION.VERIFIED : VERIFICATION.OBSERVED;
      const freshness_at = isoDate(row.last_observed ?? row.updated_at ?? row.created_at);
      const fresh = isFresh(freshness_at);
      const { score, matched } = scoreFor(qTokens, tokens, verification, freshness_at);
      candidates.push({
        type: "pattern",
        id: short(row.id, MAX_ID),
        text,
        verification,
        confidence: clampConfidence(row.confidence),
        freshness_at,
        project_id: pid,
        reason: buildReason("pattern", verification, fresh, matched, null,
          `${row.kind ?? "pattern"} occurrences=${Number(row.occurrences) || 1}`),
        source: "pattern",
        score,
        _key: `pattern\u0000${row.id}`,
        _verification: verification,
      });
    }

    const subjectIds = candidates.map((c) => c.id).filter(Boolean).slice(0, 100);
    const qmap = await qualityMap(pid, subjectIds);
    const lmap = await linkedLifecycleMap(pid, candidates.slice(0, 20).map((c) => c._key));

    for (const item of candidates) {
      const q = preferredQuality(qmap, item._key.split("\u0000")[0], item.id);
      if (q) {
        // An explicit quality record overrides the stored verification; the
        // default OBSERVED is never invented for an absent record.
        item.verification = normalizeVerification(q.verification);
        const qc = clampConfidence(q.confidence);
        if (qc !== null) item.confidence = qc;
        const qf = isoDate(q.freshness_at);
        if (qf) item.freshness_at = qf;
        item.reason = `${item.reason} [quality:${item.verification}]`.slice(0, MAX_REASON);
        item.score = scoreFor(qTokens, tokenize(`${item.text} ${item.reason}`),
          item.verification, item.freshness_at).score;
      }
      const lifecycle = lmap.get(item._key);
      if (lifecycle) item.lifecycle = lifecycle;
      delete item._key;
      delete item._verification;
    }

    candidates.sort((a, b) => b.score - a.score
      || qualityRank(b.verification) - qualityRank(a.verification)
      || (b.freshness_at ? Date.parse(b.freshness_at) : 0) - (a.freshness_at ? Date.parse(a.freshness_at) : 0)
      || String(a.id).localeCompare(String(b.id)));

    return ok({ items: candidates.slice(0, n), count: Math.min(candidates.length, n), query, project_id: pid });
  } catch {
    return { ok: false, items: [], reason: "learning request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 3. explainLearning
// ---------------------------------------------------------------------------

async function getLearningById(id, project_id) {
  if (!UUID_RE.test(String(id))) return null;
  const r = await core.dbQuery(
    `SELECT ${LEARNING_FIELDS} FROM learning_record WHERE id=$1 AND project_id=$2 LIMIT 1`,
    [id, project_id],
  );
  return r.rows[0] || null;
}

async function getPatternById(id, project_id) {
  if (!UUID_RE.test(String(id))) return null;
  const r = await core.dbQuery(
    `SELECT ${PATTERN_FIELDS} FROM pattern
      WHERE id=$1 AND projects @> ARRAY[$2]::text[] LIMIT 1`,
    [id, project_id],
  );
  return r.rows[0] || null;
}

async function relationshipContradictions(project_id, ids) {
  const found = [];
  if (!ids.length) return found;
  try {
    for (const id of ids.slice(0, 20)) {
      const r = await core.dbQuery(
        `SELECT source_id, target_id, relation_type, evidence
           FROM knowledge_relationship
          WHERE project_id=$1 AND relation_type='contradicts'
            AND ((source_type='learning_record' AND source_id=$2)
              OR (target_type='learning_record' AND target_id=$2))
          LIMIT 5`,
        [project_id, id],
      );
      for (const row of r.rows) {
        const reason = evidenceArray(row.evidence).map(evidenceString).filter(Boolean).join("; ").slice(0, 200);
        found.push({ with: row.source_id === id ? row.target_id : row.source_id, reason: reason || "contradicts relationship" });
      }
    }
  } catch { /* optional metadata */ }
  return found;
}

/**
 * Content-free, project-scoped, bounded explanation of a learning record and/or
 * pattern. `supports` identifies the bounded, redacted evidence sources; the
 * explanation never emits unbounded content and never picks a side of a conflict.
 */
export async function explainLearning({ project_id, learning_id, pattern_id } = {}) {
  const base = {
    ok: false, explanation: "", supports: [], verification: VERIFICATION.OBSERVED,
    confidence: null, breakdown: {}, scope: {}, contradictions: [], updated_at: null,
  };
  if (!validProjectId(project_id) || (!learning_id && !pattern_id)) {
    return { ...base, reason: "invalid_input" };
  }
  const pid = project_id.trim();

  try {
    const [learning, pattern] = await Promise.all([
      learning_id ? getLearningById(learning_id, pid) : Promise.resolve(null),
      pattern_id ? getPatternById(pattern_id, pid) : Promise.resolve(null),
    ]);
    if ((learning_id && !learning) || (pattern_id && !pattern)) {
      return { ...base, reason: "learning or pattern not found in project scope" };
    }

    const subjectIds = Array.from(new Set([
      learning?.id, pattern?.id,
    ].filter(Boolean))).slice(0, 10);
    const qmap = await qualityMap(pid, subjectIds);
    const learningQuality = learning ? preferredQuality(qmap, "learning_record", learning.id) : null;
    const patternQuality = pattern ? preferredQuality(qmap, "pattern", pattern.id) : null;
    const quality = learningQuality || patternQuality || null;

    const supports = [];
    const seen = new Set();
    function addSupport(value) {
      const s = evidenceString(value).slice(0, MAX_TEXT);
      if (!s || seen.has(s)) return;
      seen.add(s);
      if (supports.length < MAX_SUPPORTS) supports.push(s);
    }
    for (const entry of evidenceArray(learning?.evidence)) addSupport(entry);
    for (const entry of evidenceArray(learningQuality?.evidence_sources)) addSupport(entry);
    for (const entry of evidenceArray(patternQuality?.evidence_sources)) addSupport(entry);
    if (pattern) {
      try {
        const pe = await core.dbQuery(
          "SELECT excerpt FROM pattern_evidence WHERE pattern_id=$1 ORDER BY created_at DESC LIMIT 10",
          [pattern.id],
        );
        for (const row of pe.rows) addSupport(row.excerpt);
      } catch { /* optional evidence */ }
    }

    const contradictions = [];
    for (const row of [learning, pattern].filter(Boolean)) {
      for (const entry of evidenceArray(row.evidence)) {
        const reason = markerReason(entry);
        if (reason && contradictions.length < MAX_LABELS) {
          contradictions.push({ id: row.id, reason });
        }
      }
    }
    if (quality && normalizeVerification(quality.verification) === VERIFICATION.CONTRADICTED && contradictions.length < MAX_LABELS) {
      contradictions.push({ id: quality.subject_id, reason: "knowledge_quality marks subject contradicted" });
    }
    for (const c of await relationshipContradictions(pid, subjectIds)) {
      if (contradictions.length >= MAX_LABELS) break;
      contradictions.push(c);
    }

    let verification = VERIFICATION.OBSERVED;
    let confidence = null;
    let verificationSource = "record";
    if (quality) {
      verification = normalizeVerification(quality.verification);
      confidence = clampConfidence(quality.confidence);
      verificationSource = "knowledge_quality";
    } else if (learning) {
      verification = normalizeVerification(learning.verification);
      confidence = clampConfidence(learning.confidence);
    } else if (pattern) {
      verification = pattern.verified === true ? VERIFICATION.VERIFIED : VERIFICATION.OBSERVED;
      confidence = clampConfidence(pattern.confidence);
      verificationSource = "pattern";
    }

    let lifecycle = null;
    if (learning || pattern) {
      const lmap = await linkedLifecycleMap(pid, [
        ...(learning ? [`learning_record\u0000${learning.id}`] : []),
        ...(pattern ? [`pattern\u0000${pattern.id}`] : []),
      ]);
      lifecycle = lmap.get(learning ? `learning_record\u0000${learning.id}` : `pattern\u0000${pattern.id}`) || null;
    }

    const updatedAt = [learning?.updated_at, pattern?.updated_at, quality?.updated_at]
      .map(isoDate).filter(Boolean).sort().pop() || null;

    const parts = [`Explanation for project '${pid}'`];
    if (learning) {
      parts.push(`learning ${learning.id} (category ${short(learning.category, 60)}, status ${short(learning.status, 40)}, verification ${verification}, confidence ${confidence ?? "null"})`);
    }
    if (pattern) {
      parts.push(`pattern ${pattern.id} (${short(pattern.kind, 60)}, occurrences ${Number(pattern.occurrences) || 1})`);
    }
    parts.push(`supported by ${supports.length} evidence source(s)${supports.length ? `: ${supports.slice(0, 3).map((s) => `"${short(s, 80)}"`).join(", ")}` : ""}`);
    parts.push(`${contradictions.length} contradiction marker(s) preserved; no side chosen`);
    if (lifecycle) parts.push(`linked memory lifecycle ${short(lifecycle, 40)}`);
    parts.push(`scope strictly project ${pid}`);

    return ok({
      explanation: parts.join(". ").slice(0, 1200),
      supports,
      verification,
      confidence,
      breakdown: {
        verification_source: verificationSource,
        evidence_count: supports.length,
        learning_found: Boolean(learning),
        pattern_found: Boolean(pattern),
        quality_found: Boolean(quality),
        project_match: true,
        linked_memory_lifecycle: lifecycle,
        contradiction_count: contradictions.length,
      },
      scope: {
        project_id: pid,
        learning_id: learning?.id ?? null,
        pattern_id: pattern?.id ?? null,
        in_scope: true,
      },
      contradictions,
      updated_at: updatedAt,
    });
  } catch {
    return { ...base, reason: "learning request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 4. learningReport
// ---------------------------------------------------------------------------

/** Read-only, project-scoped aggregate. Writes nothing. */
export async function learningReport({ project_id } = {}) {
  const empty = {
    ok: false, total: 0, by_category: {}, by_status: {},
    verified_count: 0, pattern_count: 0, note: "invalid project_id",
  };
  if (!validProjectId(project_id)) return empty;
  const pid = project_id.trim();

  try {
    const [learningRes, patternRes] = await Promise.all([
      core.dbQuery(
        `SELECT category, status, verification FROM learning_record
          WHERE project_id=$1 ORDER BY id LIMIT $2`,
        [pid, MAX_SCAN],
      ),
      core.dbQuery(
        `SELECT count(*)::int AS n FROM pattern WHERE projects @> ARRAY[$1]::text[] LIMIT 1`,
        [pid],
      ),
    ]);
    const by_category = {};
    const by_status = {};
    let verified_count = 0;
    for (const row of learningRes.rows) {
      const category = String(row.category ?? "unknown");
      const status = String(row.status ?? "unknown");
      by_category[category] = (by_category[category] || 0) + 1;
      by_status[status] = (by_status[status] || 0) + 1;
      if (normalizeVerification(row.verification) === VERIFICATION.VERIFIED) verified_count += 1;
    }
    return ok({
      total: learningRes.rows.length,
      by_category,
      by_status,
      verified_count,
      pattern_count: patternRes.rows[0]?.n ?? 0,
      note: "read-only aggregate over this project's learning records and patterns; no rows were modified",
    });
  } catch {
    return { ...empty, note: "learning request could not be completed" };
  }
}

export default {
  consolidateLearning,
  learningContextItems,
  explainLearning,
  learningReport,
};
