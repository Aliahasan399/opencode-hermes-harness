// Phase 19 workstream E — Reusable development-experience store.
//
// Additive-only layer over the `dev_experience` table (migration 017). It turns
// debugging sessions, patterns, procedures and other reusable work into durable,
// evidence-backed experience records that can be deduplicated and consolidated
// WITHOUT losing provenance.
//
// Invariants (all enforced here, no reliance on callers):
//   - No LLM calls and no network calls. Similarity is deterministic token overlap.
//   - No destructive SQL: no DELETE / TRUNCATE / DROP anywhere. Consolidation marks
//     a row `superseded` instead of deleting it, and both evidence sets survive.
//   - Every read is strictly project-scoped; there is no code path that queries a
//     row from another project by id or by title.
//   - Confidence is NEVER invented: it is clamped from the caller only, and stays
//     null when the caller supplies nothing.
//   - Credential-like content is redacted via core.redact before it is persisted;
//     raw secret values are never stored.
//   - A same-title duplicate is NEVER overwritten: its prior values are written
//     into the evidence history, its evidence array is merged (identical strings
//     deduped), freshness_at is bumped, and verification_status is only promoted
//     on strictly stronger, explicitly verified evidence.
//   - All queries are bounded by LIMIT.

import crypto from "node:crypto";
import * as core from "./core.js";
import { GLOBAL_PROJECT_ID } from "./memoryScope.js";

const FIELDS = `id, project_id, session_id, goal_id, task_id, kind, title, problem,
  environment, approach, result, verification_status, root_cause, root_cause_status,
  failed_approaches, evidence, confidence, reusability, status, freshness_at,
  created_at, updated_at`;

/** The complete, frozen set of reusable experience categories. */
export const EXPERIENCE_KINDS = Object.freeze({
  DEBUGGING: "debugging",
  PATTERN: "pattern",
  PROCEDURE: "procedure",
  INTEGRATION: "integration",
  CONFIGURATION: "configuration",
  TESTING: "testing",
  DEPLOYMENT: "deployment",
});

export const VERIFICATION_STATUS = Object.freeze({
  VERIFIED: "verified",
  OBSERVED: "observed",
  INFERRED: "inferred",
  UNCERTAIN: "uncertain",
  CONTRADICTED: "contradicted",
  STALE: "stale",
  SUPERSEDED: "superseded",
});

/**
 * Deterministic token-overlap similarity threshold (Jaccard over normalized word
 * tokens) used by findDuplicateExperiences to surface *candidate* duplicates.
 * Lower than CONSOLIDATE_SIMILARITY_THRESHOLD because candidate detection should
 * err toward recall; consolidation applies a stricter bar before merging.
 */
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * "Very high overlap" threshold required (in addition to an identical normalized
 * title) for consolidateExperiences to merge two distinct rows.
 */
export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.85;

const VALID_KINDS = new Set(Object.values(EXPERIENCE_KINDS));
const VALID_VERIFICATION = new Set(Object.values(VERIFICATION_STATUS));
const VALID_ROOT_CAUSE_STATUS = new Set(["hypothesis", "confirmed", "ruled_out", "refuted", "observed"]);
const VALID_REUSABILITY = new Set(["project", "team", "global"]);

// Sorting-only confidence-like ranks. NOT numeric confidence values.
const RANK = {
  [VERIFICATION_STATUS.VERIFIED]: 7,
  [VERIFICATION_STATUS.OBSERVED]: 6,
  [VERIFICATION_STATUS.INFERRED]: 5,
  [VERIFICATION_STATUS.UNCERTAIN]: 4,
  [VERIFICATION_STATUS.STALE]: 3,
  [VERIFICATION_STATUS.CONTRADICTED]: 2,
  [VERIFICATION_STATUS.SUPERSEDED]: 1,
};

const MAX_SCAN = 1000;
const MAX_SCAN_HARD = 2000;
const MAX_LIST_LIMIT = 200;
const MAX_EVIDENCE_STORED = 200;
const MAX_EVIDENCE_PER_ITEM = 50;
const MAX_TEXT = 20000;
const MAX_TITLE = 512;
const MAX_ID = 512;
const MAX_REASON = 2000;

// ---------------------------------------------------------------------------
// Small, pure helpers
// ---------------------------------------------------------------------------

function ok(fields) { return { ok: true, ...fields }; }
function fail(reason, fields = {}) { return { ok: false, created: false, id: null, reason, ...fields }; }

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// A real project is a non-empty string that is not the '_global' sentinel.
function validProjectId(project_id) {
  return nonEmptyString(project_id) && project_id.trim() !== GLOBAL_PROJECT_ID;
}

function text(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return "";
  return core.redact(String(v)).trim().slice(0, max);
}

function idText(v) {
  if (!nonEmptyString(v)) return null;
  return core.redact(String(v)).trim().slice(0, MAX_ID);
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

function allowedOr(value, set, fallback) {
  return typeof value === "string" && set.has(value) ? value : fallback;
}

function boundedLimit(value, fallback, hardMax) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, hardMax) : fallback;
}

// Evidence is stored as an array of plain strings plus appended history objects.
function evidenceString(value) {
  if (typeof value === "string") return core.redact(value).trim();
  if (value && typeof value === "object") {
    try { return core.redact(JSON.stringify(value, Object.keys(value).sort())); }
    catch { return core.redact(String(value)); }
  }
  return core.redact(String(value ?? "")).trim();
}

function normalizeEvidence(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input.slice(0, MAX_EVIDENCE_PER_ITEM)) {
    const s = evidenceString(item).slice(0, MAX_TEXT);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Merge several evidence arrays: identical strings appear once, object history
// entries are always preserved (they carry their own timestamp), order is stable.
function mergeEvidenceLists(lists) {
  const out = [];
  const seenStrings = new Set();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item === "string") {
        if (seenStrings.has(item)) continue;
        seenStrings.add(item);
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

// Explicit markers only — keyword overlap alone is never treated as a conflict.
const NEGATION_MARKER = /^\s*(contradicts?|negates?|refutes?|opposes?)\s*:/i;
const STALE_MARKER = /^\s*status\s*:\s*(stale|contradicted|outdated)\b/i;

function markerReason(entry) {
  const candidates = [];
  if (typeof entry === "string") candidates.push(entry);
  else if (entry && typeof entry === "object") {
    for (const value of Object.values(entry)) if (typeof value === "string") candidates.push(value);
    candidates.push(evidenceString(entry));
  }
  for (const textValue of candidates) {
    if (NEGATION_MARKER.test(textValue)) return `explicit negation: ${textValue.slice(0, 160)}`;
    if (STALE_MARKER.test(textValue)) return `explicit stale/contradicted marker: ${textValue.slice(0, 160)}`;
  }
  return null;
}

// A verification promotion to 'verified' requires an explicit verification marker
// in the NEW evidence, never a bare status string from the caller.
function isExplicitVerificationEvidence(entry) {
  if (typeof entry === "string") {
    return /^\s*verified\s*:/i.test(entry)
      || /"kind"\s*:\s*"verification"/i.test(entry)
      || /"type"\s*:\s*"verification"/i.test(entry)
      || /"verification"\s*:\s*"verified"/i.test(entry);
  }
  if (entry && typeof entry === "object") {
    return entry.kind === "verification" || entry.type === "verification"
      || entry.verification === VERIFICATION_STATUS.VERIFIED
      || entry.event === "experience.verified";
  }
  return false;
}

function decideVerification(oldStatus, incomingStatus, incomingEvidence) {
  const fallback = RANK[VERIFICATION_STATUS.OBSERVED];
  const oldRank = RANK[oldStatus] ?? fallback;
  const newRank = RANK[incomingStatus] ?? fallback;
  // No new evidence => no change. Never demote automatically, never "tie" promote.
  if (incomingEvidence.length === 0 || newRank <= oldRank) return oldStatus;
  // Never auto-promote inferred/observed (or anything else) to verified without
  // an explicit verification evidence marker.
  if (incomingStatus === VERIFICATION_STATUS.VERIFIED
      && !incomingEvidence.some(isExplicitVerificationEvidence)) {
    return oldStatus;
  }
  return incomingStatus;
}

// ---------------------------------------------------------------------------
// Deterministic token-overlap similarity
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "this", "that", "with", "from", "into",
  "when", "then", "than", "have", "has", "had", "are", "not", "but", "you",
  "your", "our", "its", "how", "why", "what", "which", "does", "did", "use",
  "using", "used", "fix", "about", "over", "after", "before",
]);

function tokenize(value) {
  const tokens = String(value ?? "").toLowerCase().split(/[^a-z0-9]+/);
  const set = new Set();
  for (const t of tokens) {
    if (t.length >= 2 && !STOPWORDS.has(t)) set.add(t);
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  if (!intersection) return 0;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

function documentTokens(row) {
  return tokenize([
    row.title, row.problem, row.environment, row.approach,
    row.result, row.root_cause,
  ].join(" "));
}

function normalizeTitle(title) {
  return String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

function publicRow(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    session_id: row.session_id ?? null,
    goal_id: row.goal_id ?? null,
    task_id: row.task_id ?? null,
    kind: row.kind,
    title: row.title,
    problem: row.problem ?? "",
    environment: row.environment ?? "",
    approach: row.approach ?? "",
    result: row.result ?? "",
    verification_status: row.verification_status,
    root_cause: row.root_cause ?? "",
    root_cause_status: row.root_cause_status,
    failed_approaches: Array.isArray(row.failed_approaches) ? row.failed_approaches : [],
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    confidence: row.confidence ?? null,
    reusability: row.reusability,
    status: row.status,
    freshness_at: isoDate(row.freshness_at),
    created_at: isoDate(row.created_at),
    updated_at: isoDate(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Transaction + audit helpers (audit never breaks the primary operation)
// ---------------------------------------------------------------------------

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
// 1. recordExperience
// ---------------------------------------------------------------------------

/**
 * Record a reusable experience. A same-title record in the same project is a
 * duplicate: it is never overwritten. Instead its prior values are appended to
 * the evidence history, evidence arrays are merged (identical strings deduped),
 * freshness_at is bumped, and verification_status is only promoted on strictly
 * stronger, explicitly verified evidence.
 */
export async function recordExperience({
  project_id,
  session_id,
  title,
  kind = "pattern",
  problem = "",
  environment = "",
  approach = "",
  result = "",
  verification_status = "observed",
  root_cause = "",
  root_cause_status = "hypothesis",
  failed_approaches = [],
  evidence = [],
  confidence = null,
  reusability = "project",
  goal_id,
  task_id,
  id,
} = {}) {
  if (!validProjectId(project_id)) return fail("invalid_project_id");
  if (!nonEmptyString(title)) return fail("invalid_title");
  if (!Array.isArray(evidence)) return fail("evidence must be an array");
  if (!Array.isArray(failed_approaches)) return fail("failed_approaches must be an array");

  const pid = project_id.trim();
  const cleanTitle = text(title, MAX_TITLE);
  if (!cleanTitle) return fail("invalid_title");

  const cleanKind = allowedOr(kind, VALID_KINDS, EXPERIENCE_KINDS.PATTERN);
  const cleanStatus = allowedOr(verification_status, VALID_VERIFICATION, VERIFICATION_STATUS.OBSERVED);
  const cleanRootCauseStatus = root_cause_status === undefined || root_cause_status === null
    ? "hypothesis"
    : (VALID_ROOT_CAUSE_STATUS.has(root_cause_status) ? root_cause_status : "hypothesis");
  const cleanReusability = allowedOr(reusability, VALID_REUSABILITY, "project");
  const incomingEvidence = normalizeEvidence(evidence);
  const incomingFailed = normalizeEvidence(failed_approaches);

  // Build the stored payload up front so a secret check can fail the whole write.
  const payload = {
    problem: text(problem),
    environment: text(environment),
    approach: text(approach),
    result: text(result),
    root_cause: text(root_cause),
  };
  const newId = idText(id) || crypto.randomUUID();
  const conf = clampConfidence(confidence);
  const callerSuppliedId = idText(id) !== null;

  try {
    const resultRow = await withTx(async (client) => {
      const dup = await client.query(
        `SELECT ${FIELDS} FROM dev_experience WHERE project_id=$1 AND title=$2 LIMIT 1`,
        [pid, cleanTitle],
      );
      const existing = dup.rows[0] || null;

      if (existing) {
        const oldEvidence = Array.isArray(existing.evidence) ? existing.evidence : [];
        const oldFailed = Array.isArray(existing.failed_approaches) ? existing.failed_approaches : [];
        const history = historyEntry("experience.record_duplicate", {
          previous: {
            verification_status: existing.verification_status,
            confidence: existing.confidence ?? null,
            result: String(existing.result ?? "").slice(0, 200),
            root_cause: String(existing.root_cause ?? "").slice(0, 200),
            reusability: existing.reusability,
          },
          incoming: {
            verification_status: cleanStatus,
            confidence: conf,
            reusability: cleanReusability,
            source_session: idText(session_id),
            evidence_count: incomingEvidence.length,
          },
        });
        const mergedEvidence = mergeEvidenceLists([oldEvidence, [history], incomingEvidence]);
        const mergedFailed = mergeEvidenceLists([oldFailed, incomingFailed]);
        const finalStatus = decideVerification(existing.verification_status, cleanStatus, incomingEvidence);

        await client.query(
          `UPDATE dev_experience
              SET evidence=$2::jsonb, failed_approaches=$3::jsonb,
                  verification_status=$4, freshness_at=now(), updated_at=now()
            WHERE id=$1 AND project_id=$5`,
          [existing.id, JSON.stringify(mergedEvidence), JSON.stringify(mergedFailed),
           finalStatus, pid],
        );
        return { id: existing.id, created: false, duplicate: true, promoted: finalStatus !== existing.verification_status };
      }

      // Caller-supplied primary key must not collide with another experience.
      if (callerSuppliedId) {
        const pk = await client.query("SELECT id FROM dev_experience WHERE id=$1 LIMIT 1", [newId]);
        if (pk.rowCount) return { collision: true, id: newId };
      }

      const evidence = mergeEvidenceLists([incomingEvidence, [
        historyEntry("experience.record_created", {
          kind: cleanKind, source_session: idText(session_id), reusability: cleanReusability,
        }),
      ]]);

      await client.query(
        `INSERT INTO dev_experience
           (id, project_id, session_id, goal_id, task_id, kind, title, problem,
            environment, approach, result, verification_status, root_cause,
            root_cause_status, failed_approaches, evidence, confidence, reusability,
            status, freshness_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,
                 $17::real,$18,'active',now())
         RETURNING id`,
        [newId, pid, idText(session_id), idText(goal_id), idText(task_id), cleanKind,
         cleanTitle, payload.problem, payload.environment, payload.approach, payload.result,
         cleanStatus, payload.root_cause, cleanRootCauseStatus,
         JSON.stringify(incomingFailed), JSON.stringify(evidence), conf, cleanReusability],
      );
      return { id: newId, created: true, duplicate: false, promoted: false };
    });

    if (resultRow.collision) return fail("experience id already exists", { id: newId, duplicate: true });

    await auditSafe(resultRow.created ? "experience.record" : "experience.merge_duplicate", pid, {
      id: resultRow.id, duplicate: resultRow.duplicate, promoted: resultRow.promoted,
      kind: cleanKind,
    });

    const out = ok({ id: resultRow.id, created: resultRow.created });
    if (resultRow.duplicate) out.duplicate = true;
    return out;
  } catch (e) {
    // Never leak SQL / stack traces / secrets to the caller.
    return fail("experience request could not be completed");
  }
}

// ---------------------------------------------------------------------------
// 2. findDuplicateExperiences
// ---------------------------------------------------------------------------

/**
 * Project-scoped, bounded duplicate candidate detection using deterministic
 * token-overlap (Jaccard) similarity. With a `signature`, ranks rows similar to
 * the signature. Without one, surfaces similar pairs among existing rows.
 * Never reads another project's rows.
 */
export async function findDuplicateExperiences({ project_id, signature = "", limit = 20 } = {}) {
  if (!validProjectId(project_id)) return { ok: false, items: [], reason: "invalid_project_id" };
  const pid = project_id.trim();
  const n = boundedLimit(limit, 20, MAX_LIST_LIMIT);
  const sig = text(signature, MAX_TEXT).toLowerCase();

  try {
    const rows = (await core.dbQuery(
      `SELECT ${FIELDS} FROM dev_experience
        WHERE project_id=$1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [pid, MAX_SCAN],
    )).rows;

    const items = [];
    if (sig) {
      const sigTokens = tokenize(sig);
      for (const row of rows) {
        const sim = jaccard(sigTokens, documentTokens(row));
        if (sim >= SIMILARITY_THRESHOLD) {
          items.push({ id: row.id, title: row.title, kind: row.kind, status: row.status,
            verification_status: row.verification_status, matched_with: null,
            similarity: Number(sim.toFixed(4)) });
        }
      }
      items.sort((a, b) => b.similarity - a.similarity || String(a.id).localeCompare(String(b.id)));
    } else {
      const prepared = rows.map((row) => ({ row, tokens: documentTokens(row) }));
      for (let i = 0; i < prepared.length; i += 1) {
        for (let j = i + 1; j < prepared.length; j += 1) {
          const sim = jaccard(prepared[i].tokens, prepared[j].tokens);
          if (sim < SIMILARITY_THRESHOLD) continue;
          const a = prepared[i].row;
          const b = prepared[j].row;
          items.push({ id: a.id, title: a.title, kind: a.kind, status: a.status,
            verification_status: a.verification_status, matched_with: b.id,
            similarity: Number(sim.toFixed(4)) });
          items.push({ id: b.id, title: b.title, kind: b.kind, status: b.status,
            verification_status: b.verification_status, matched_with: a.id,
            similarity: Number(sim.toFixed(4)) });
        }
      }
      items.sort((a, b) => b.similarity - a.similarity
        || String(a.id).localeCompare(String(b.id))
        || String(a.matched_with).localeCompare(String(b.matched_with)));
    }

    const seen = new Set();
    const deduped = [];
    for (const item of items) {
      const key = `${item.id}|${item.matched_with ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
      if (deduped.length >= n) break;
    }
    return ok({ items: deduped, threshold: SIMILARITY_THRESHOLD, count: deduped.length });
  } catch {
    return { ok: false, items: [], reason: "experience request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 3. consolidateExperiences
// ---------------------------------------------------------------------------

function evidenceConflicts(a, b) {
  for (const list of [a.evidence, b.evidence]) {
    for (const entry of Array.isArray(list) ? list : []) {
      const reason = markerReason(entry);
      if (reason) return reason;
    }
  }
  // Materially different, non-empty conclusions are also kept side by side.
  const resultA = String(a.result ?? "").trim();
  const resultB = String(b.result ?? "").trim();
  if (resultA && resultB && resultA !== resultB) {
    return "conclusions differ between duplicate experiences";
  }
  const causeA = String(a.root_cause ?? "").trim();
  const causeB = String(b.root_cause ?? "").trim();
  if (causeA && causeB && causeA !== causeB) {
    return "root causes differ between duplicate experiences";
  }
  return null;
}

/**
 * Merge only clearly compatible duplicate experiences (identical normalized
 * title OR very high token overlap). The oldest row becomes canonical; the other
 * rows are marked `superseded`, never deleted. Both evidence sets and all
 * provenance are preserved, and conflicting evidence is recorded as a
 * contradiction instead of one side being chosen. Idempotent: a second run sees
 * no active merge candidates and reports merged: 0.
 */
export async function consolidateExperiences({ project_id, limit = 50 } = {}) {
  if (!validProjectId(project_id)) {
    return { ok: false, merged: 0, contradictions: [], examined: 0, reason: "invalid_project_id" };
  }
  const pid = project_id.trim();
  const n = boundedLimit(limit, 50, MAX_SCAN_HARD);

  try {
    const outcome = await withTx(async (client) => {
      const r = await client.query(
        `SELECT ${FIELDS} FROM dev_experience
          WHERE project_id=$1 AND status='active'
          ORDER BY created_at ASC, id ASC
          LIMIT $2`,
        [pid, Math.max(n, 1)],
      );
      const rows = r.rows.map(publicRow);
      const examined = rows.length;
      const used = new Set();
      const contradictions = [];
      let merged = 0;

      for (let i = 0; i < rows.length; i += 1) {
        const canonical = rows[i];
        if (used.has(canonical.id)) continue;
        const canonicalNorm = normalizeTitle(canonical.title);
        const canonicalTokens = documentTokens(canonical);

        for (let j = i + 1; j < rows.length; j += 1) {
          const other = rows[j];
          if (used.has(other.id)) continue;

          const sameTitle = canonicalNorm.length > 0
            && canonicalNorm === normalizeTitle(other.title);
          const sim = jaccard(canonicalTokens, documentTokens(other));
          const compatible = sameTitle || sim >= CONSOLIDATE_SIMILARITY_THRESHOLD;
          if (!compatible) continue;

          const conflict = evidenceConflicts(canonical, other);
          const canonicalEvidence = Array.isArray(canonical.evidence) ? canonical.evidence : [];
          const otherEvidence = Array.isArray(other.evidence) ? other.evidence : [];

          const provenance = historyEntry("experience.consolidated", {
            role: "canonical", merged_from: other.id, merged_title: other.title,
            similarity: Number(sim.toFixed(4)),
            by_normalized_title: sameTitle,
          });
          const sourceEntry = historyEntry("experience.consolidated", {
            role: "source", merged_into: canonical.id, merged_title: canonical.title,
          });

          let canonicalEvents = [provenance];
          if (conflict) {
            const entry = historyEntry("experience.contradiction", {
              with: other.id, reason: conflict,
            });
            canonicalEvents = canonicalEvents.concat(entry);
            contradictions.push({
              canonical_id: canonical.id, source_id: other.id,
              reason: conflict, resolution: "kept both evidence sets",
            });
          }

          const newCanonicalEvidence = mergeEvidenceLists([
            canonicalEvidence, otherEvidence, canonicalEvents,
          ]);
          const newSourceEvidence = mergeEvidenceLists([otherEvidence, [sourceEntry]]);
          const mergedFailed = mergeEvidenceLists([
            canonical.failed_approaches, other.failed_approaches,
          ]);

          await client.query(
            `UPDATE dev_experience
                SET evidence=$2::jsonb, failed_approaches=$3::jsonb,
                    freshness_at=now(), updated_at=now()
              WHERE id=$1 AND project_id=$4`,
            [canonical.id, JSON.stringify(newCanonicalEvidence),
             JSON.stringify(mergedFailed), pid],
          );
          await client.query(
            `UPDATE dev_experience
                SET status='superseded', evidence=$2::jsonb, updated_at=now()
              WHERE id=$1 AND project_id=$3`,
            [other.id, JSON.stringify(newSourceEvidence), pid],
          );

          // Keep merging further compatible rows into this same canonical row.
          canonical.evidence = newCanonicalEvidence;
          canonical.failed_approaches = mergedFailed;
          used.add(other.id);
          merged += 1;
        }
        used.add(canonical.id);
      }
      return { merged, contradictions, examined };
    });

    await auditSafe("experience.consolidate", pid, {
      merged: outcome.merged, contradictions: outcome.contradictions.length,
      examined: outcome.examined,
    });
    return ok(outcome);
  } catch {
    return { ok: false, merged: 0, contradictions: [], examined: 0,
      reason: "experience request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 4. markExperienceStale
// ---------------------------------------------------------------------------

/** Mark an experience stale by id. Appends the reason to evidence; never deletes. */
export async function markExperienceStale({ id, reason, evidence = [] } = {}) {
  const cleanId = idText(id);
  if (!cleanId) return { ok: false, stale: false, reason: "invalid_id" };
  if (!Array.isArray(evidence)) return { ok: false, stale: false, reason: "evidence must be an array" };

  const reasonText = text(reason, MAX_REASON) || "marked stale";
  const incomingEvidence = normalizeEvidence(evidence);

  try {
    const outcome = await withTx(async (client) => {
      const cur = await client.query(
        `SELECT id, status, evidence FROM dev_experience WHERE id=$1 LIMIT 1`,
        [cleanId],
      );
      if (!cur.rowCount) return { found: false };
      const row = cur.rows[0];
      const oldEvidence = Array.isArray(row.evidence) ? row.evidence : [];
      const event = historyEntry("experience.stale", {
        reason: reasonText, previous_status: row.status, evidence: incomingEvidence,
      });
      const mergedEvidence = mergeEvidenceLists([oldEvidence, [event], incomingEvidence, [reasonText]]);
      await client.query(
        `UPDATE dev_experience
            SET status='stale', evidence=$2::jsonb, freshness_at=now(), updated_at=now()
          WHERE id=$1`,
        [row.id, JSON.stringify(mergedEvidence)],
      );
      return { found: true, project_id: row.project_id };
    });

    if (!outcome.found) return { ok: false, stale: false, reason: "experience not found" };
    await auditSafe("experience.stale", outcome.project_id, { id: cleanId });
    return { ok: true, stale: true, id: cleanId };
  } catch {
    return { ok: false, stale: false, reason: "experience request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 5. getExperiences
// ---------------------------------------------------------------------------

/** Bounded, project-scoped listing with optional kind and status filters. */
export async function getExperiences({ project_id, kind, status, limit = 50 } = {}) {
  if (!validProjectId(project_id)) return { ok: false, items: [], reason: "invalid_project_id" };
  const pid = project_id.trim();
  if (kind !== undefined && kind !== null && !VALID_KINDS.has(kind)) {
    return { ok: false, items: [], reason: "invalid_kind" };
  }
  if (status !== undefined && status !== null && typeof status !== "string") {
    return { ok: false, items: [], reason: "invalid_status" };
  }
  const n = boundedLimit(limit, 50, MAX_LIST_LIMIT);

  try {
    const r = await core.dbQuery(
      `SELECT ${FIELDS} FROM dev_experience
        WHERE project_id=$1
          AND ($2::text IS NULL OR kind=$2)
          AND ($3::text IS NULL OR status=$3)
        ORDER BY freshness_at DESC, id DESC
        LIMIT $4`,
      [pid, kind ?? null, status ?? null, n],
    );
    const items = r.rows.map(publicRow);
    return ok({ items, count: items.length });
  } catch {
    return { ok: false, items: [], reason: "experience request could not be completed" };
  }
}

// ---------------------------------------------------------------------------
// 6. experienceReport
// ---------------------------------------------------------------------------

/** Read-only, project-scoped aggregate report. Writes nothing. */
export async function experienceReport({ project_id } = {}) {
  const empty = {
    ok: false, total: 0, by_kind: {}, by_status: {},
    verified_count: 0, stale_count: 0, contradictions: 0,
    note: "invalid project_id",
  };
  if (!validProjectId(project_id)) return empty;
  const pid = project_id.trim();

  try {
    const r = await core.dbQuery(
      `SELECT kind, status, verification_status, evidence
         FROM dev_experience
        WHERE project_id=$1
        ORDER BY id
        LIMIT $2`,
      [pid, MAX_SCAN_HARD],
    );
    const by_kind = {};
    const by_status = {};
    let verified_count = 0;
    let stale_count = 0;
    let contradictions = 0;
    for (const row of r.rows) {
      by_kind[row.kind] = (by_kind[row.kind] || 0) + 1;
      by_status[row.status] = (by_status[row.status] || 0) + 1;
      if (row.verification_status === VERIFICATION_STATUS.VERIFIED) verified_count += 1;
      if (row.status === "stale") stale_count += 1;
      for (const entry of Array.isArray(row.evidence) ? row.evidence : []) {
        if (entry && typeof entry === "object" && entry.event === "experience.contradiction") {
          contradictions += 1;
        }
      }
    }
    return ok({
      total: r.rows.length,
      by_kind,
      by_status,
      verified_count,
      stale_count,
      contradictions,
      note: "read-only aggregate over this project's experiences; no rows were modified",
    });
  } catch {
    return { ...empty, note: "experience request could not be completed" };
  }
}
