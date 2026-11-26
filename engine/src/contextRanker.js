// Phase 18 workstream C — knowledge-quality-aware relevance ranking and safe
// filtering for injected context.
//
// Pure module: no LLM, no network, no database reads/writes. The only source of
// nondeterminism (the current time used for freshness) is injectable via the
// optional `now` input, so identical inputs produce identical output.
//
// Design rules (deliberately strict, mirroring knowledgeQuality/memoryScope):
//   * Every score contribution comes from a documented rule in SCORING_RULES.
//     No unexplained magic numbers appear in the scoring logic.
//   * Verification status is explicit. INFERRED is never promoted to VERIFIED:
//     its weight is lower and it is reported verbatim in the breakdown.
//   * Project isolation is enforced before any scoring: a row that names a
//     different real project is dropped, and a `_global` row is kept only when
//     it is explicitly globally eligible.
//   * Superseded decisions are never presented as current. When the task asks
//     for history (documentation / decisions) they are retained as warnings.
//   * Contradicted items are never silently picked as the winner. They are
//     rejected and a concise conflict warning names both sides.
//   * Malformed items never throw; they are rejected with a reason.
import { VERIFICATION, qualityRank } from "./knowledgeQuality.js";
import { GLOBAL_PROJECT_ID, isGloballyEligible } from "./memoryScope.js";
import { redact } from "./core.js";

// ---- Safety bounds --------------------------------------------------------
const MAX_TEXT = 2000;
const MAX_ID = 120;
const MAX_LABEL = 160;
const MAX_SOURCE = 80;
const MAX_WARNINGS = 10;
const MAX_LIMIT = 50;
const MAX_KEYWORDS = 12;
const DAY_MS = 86400000;

const RULE_KEYS = Object.freeze([
  "verification", "projectMatch", "taskKeyword",
  "freshnessWithin30d", "relationship", "verifiedFix",
]);

// ---- Documented scoring rules --------------------------------------------
// Every number used by the scorer lives here. Callers may override any of them
// through the `weights` input to rankAndFilter; nothing is hardcoded in logic.
export const SCORING_RULES = Object.freeze({
  verification: Object.freeze({
    description: "Contribution from the item's explicit verification status. INFERRED is always below VERIFIED; negative values downweight contradicted/stale/superseded claims.",
    weights: Object.freeze({
      [VERIFICATION.VERIFIED]: 3,
      [VERIFICATION.OBSERVED]: 2,
      [VERIFICATION.INFERRED]: 1,
      [VERIFICATION.UNCERTAIN]: 0,
      [VERIFICATION.CONTRADICTED]: -2,
      [VERIFICATION.STALE]: -1,
      [VERIFICATION.SUPERSEDED]: -3,
    }),
  }),
  projectMatch: Object.freeze({
    description: "Added when an explicitly project-scoped item belongs to the requested project.",
    weight: 2,
  }),
  taskKeyword: Object.freeze({
    description: "Added once when at least one task keyword (from task.keywords/signals/query) appears in the item text.",
    weight: 2,
  }),
  freshnessWithin30d: Object.freeze({
    description: "Added when freshness_at is within 30 days of the reference time (or up to one day in the future).",
    weight: 1,
    days: 30,
  }),
  relationship: Object.freeze({
    description: "Added for relationship-type items so knowledge about connections is retained when relevant.",
    weight: 1,
  }),
  verifiedFix: Object.freeze({
    description: "Added for a verified fix/status fix item, so confirmed remediations outrank guesses during bugfix/debugging work.",
    weight: 2,
  }),
});

/** A fresh copy of the default weights, safe for callers to mutate. */
export function defaultWeights() {
  return {
    verification: { ...SCORING_RULES.verification.weights },
    projectMatch: SCORING_RULES.projectMatch.weight,
    taskKeyword: SCORING_RULES.taskKeyword.weight,
    freshnessWithin30d: SCORING_RULES.freshnessWithin30d.weight,
    relationship: SCORING_RULES.relationship.weight,
    verifiedFix: SCORING_RULES.verifiedFix.weight,
  };
}

function mergeWeights(input) {
  const w = defaultWeights();
  if (!input || typeof input !== "object") return w;
  if (input.verification && typeof input.verification === "object") {
    for (const key of Object.keys(w.verification)) {
      if (Number.isFinite(Number(input.verification[key]))) {
        w.verification[key] = Number(input.verification[key]);
      }
    }
  }
  for (const key of RULE_KEYS) {
    if (key === "verification") continue;
    if (input[key] !== undefined && Number.isFinite(Number(input[key]))) {
      w[key] = Number(input[key]);
    }
  }
  return w;
}

// ---- Status / verification normalization ----------------------------------
// Maps legacy lifecycle words onto verification statuses so a raw row's
// `status` can participate in quality-aware ranking without being guessed.
const STATUS_MAP = Object.freeze({
  active: VERIFICATION.OBSERVED,
  open: VERIFICATION.OBSERVED,
  candidate: VERIFICATION.INFERRED,
  supported: VERIFICATION.INFERRED,
  confirmed: VERIFICATION.VERIFIED,
  verified: VERIFICATION.VERIFIED,
  verified_fix: VERIFICATION.VERIFIED,
  strongly_supported: VERIFICATION.VERIFIED,
  hypothesis: VERIFICATION.UNCERTAIN,
  disputed: VERIFICATION.CONTRADICTED,
  contradicted: VERIFICATION.CONTRADICTED,
  stale: VERIFICATION.STALE,
  deprecated: VERIFICATION.SUPERSEDED,
  rejected: VERIFICATION.SUPERSEDED,
  superseded: VERIFICATION.SUPERSEDED,
});

const VALID_VERIFICATIONS = new Set(Object.values(VERIFICATION));

function normalizeVerification(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (VALID_VERIFICATIONS.has(s)) return s;
  return STATUS_MAP[s] || VERIFICATION.OBSERVED;
}

// ---- Small pure helpers ---------------------------------------------------
function safeString(value) {
  try {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  } catch {
    return "";
  }
}

function clean(value, limit) {
  return redact(safeString(value)).replace(/\s+/g, " ").trim().slice(0, limit);
}

function textOf(value) {
  if (Array.isArray(value)) return value.map(safeString).join(" ");
  return safeString(value);
}

function firstText(candidates) {
  for (const candidate of candidates) {
    const s = textOf(candidate).trim();
    if (s) return s;
  }
  return "";
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((x) => clean(x, MAX_ID)).filter(Boolean).slice(0, 5);
  }
  const s = clean(value, MAX_ID);
  return s ? [s] : [];
}

function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = Date.parse(safeString(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function requestedProject(project_id) {
  if (typeof project_id !== "string" || project_id.length === 0) return null;
  return project_id === GLOBAL_PROJECT_ID ? null : project_id;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function computeNow(value) {
  if (value !== undefined && value !== null) {
    const n = Number(value);
    if (Number.isFinite(n)) return n >= 1e11 ? n : n * 1000; // ms, or seconds
    const parsed = Date.parse(safeString(value));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "which", "what",
  "when", "where", "why", "how", "was", "were", "are", "has", "have", "had",
  "into", "about", "over", "under", "your", "our", "their", "its", "not",
  "can", "will", "would", "should", "could", "does", "did", "done", "use",
  "using", "used", "some", "any", "all", "out", "get", "set", "make", "new",
]);

/** Derive a bounded, deterministic keyword list from a task description. */
function taskKeywords(task) {
  const parts = [];
  if (Array.isArray(task.keywords)) parts.push(...task.keywords);
  if (Array.isArray(task.signals)) parts.push(...task.signals);
  if (typeof task.query === "string") parts.push(task.query);
  if (typeof task.text === "string") parts.push(task.text);

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const tokens = safeString(part).toLowerCase().split(/[^a-z0-9_+-]+/);
    for (const token of tokens) {
      if (token.length < 3 || STOP_WORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

function matchKeywords(text, keywords) {
  if (!keywords.length) return [];
  const lower = safeString(text).toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

function normalizedTextKey(text) {
  return safeString(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 240);
}

function shortId(raw) {
  if (raw && typeof raw === "object") {
    return clean(raw.id ?? raw.title ?? raw.fact_key ?? "unknown", MAX_ID);
  }
  return clean(raw, MAX_ID);
}

function isFresh(freshness_at, nowMs) {
  if (!freshness_at) return false;
  const t = Date.parse(freshness_at);
  if (Number.isNaN(t)) return false;
  const age = nowMs - t;
  // Up to one day in the future is tolerated (clock skew); older than 30d is not fresh.
  return age >= -DAY_MS && age <= SCORING_RULES.freshnessWithin30d.days * DAY_MS;
}

// ---- Normalization --------------------------------------------------------
/**
 * Convert a raw capability/DB row into a safe, explainable item.
 * Returns null when the row cannot yield an id or any text (never throws).
 */
export function normalizeItem(raw, project_id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    const explicitProject = typeof raw.project_id === "string" && raw.project_id.length > 0;
    const globallyEligible = raw.global_eligible === true
      || raw.global_approval === true
      || raw.globally_eligible === true
      || isGloballyEligible(raw) === true;

    const title = clean(textOf(raw.title), MAX_ID);
    const content = clean(firstText([raw.content, raw.text, raw.value,
      raw.description, raw.summary, raw.reasoning]), MAX_TEXT);
    const text = clean(firstText([raw.text, raw.content, raw.value,
      raw.description, raw.summary, raw.title]), MAX_TEXT);

    let id = clean(firstText([raw.id, raw.fact_key, raw.decision_id, raw.key, raw.title]), MAX_ID);
    if (!id) {
      // Deterministic synthetic id derived from the text; no random values.
      if (!text) return null;
      id = `auto:${text.slice(0, 40)}`;
    }

    const type = clean(firstText([raw.type, raw.kind]), 40) || "item";
    const status = clean(firstText([raw.status, raw.lifecycle]), 60) || null;
    const verification = normalizeVerification(
      raw.verification ?? raw.status ?? raw.lifecycle
      ?? (raw.verified === true ? VERIFICATION.VERIFIED : undefined),
    );
    const confidence = (raw.confidence !== null && raw.confidence !== undefined
      && Number.isFinite(Number(raw.confidence))) ? Number(raw.confidence) : null;
    const freshness_at = isoDate(raw.freshness_at ?? raw.updated_at ?? raw.created_at);
    const reason = clean(firstText([raw.reason, raw.retrieval_reason,
      raw.explanation, raw.ranking_explanation, raw.evidence]), MAX_LABEL);
    const source = clean(firstText([raw.source, raw.provenance?.source,
      raw.source_kind]), MAX_SOURCE);
    const session = clean(firstText([raw.source_session, raw.session_id,
      raw.session, raw.provenance?.session]), MAX_SOURCE) || null;

    const isFix = raw.verified_fix === true || raw.fix === true
      || raw.is_fix === true || type === "fix" || status === "verified_fix";
    const conflictsWith = asStringArray(raw.conflicts_with ?? raw.conflict_with
      ?? raw.contradicts ?? raw.conflicts);

    let projectId;
    if (explicitProject) projectId = clean(raw.project_id, MAX_ID);
    else if (globallyEligible) projectId = GLOBAL_PROJECT_ID;
    else projectId = (typeof project_id === "string" && project_id.length > 0)
      ? clean(project_id, MAX_ID) : GLOBAL_PROJECT_ID;

    return {
      type, id, title, content, text,
      verification, confidence, freshness_at,
      project_id: projectId,
      project_explicit: explicitProject,
      globally_eligible: globallyEligible,
      status, reason, source, session, isFix, conflictsWith,
    };
  } catch {
    return null;
  }
}

// ---- Conflict warnings ----------------------------------------------------
/**
 * Concise warnings about contradicted / explicitly conflicting facts.
 * Only ids and short redacted snippets are used. Callers must pass in-scope
 * items (rankAndFilter does); items explicitly marked cross-project are skipped
 * so a different project's data is never disclosed here.
 */
export function conflictWarnings(items = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.cross_project === true || raw._crossProject === true
      || raw.rejected_reason === "cross-project") continue;

    let item;
    try {
      item = (typeof raw.verification === "string" && "project_explicit" in raw)
        ? raw : normalizeItem(raw, null);
    } catch {
      continue;
    }
    if (!item) continue;

    const conflicts = Array.isArray(item.conflictsWith) ? item.conflictsWith : [];
    const contradicted = item.verification === VERIFICATION.CONTRADICTED;
    if (!contradicted && conflicts.length === 0) continue;

    const id = clean(item.id ?? "unknown", MAX_ID);
    let message;
    if (conflicts.length > 0) {
      const others = conflicts.map((c) => clean(c, 40)).join(", ");
      message = `Conflict between ${id} and ${others}: neither side auto-selected as current; verify before use.`;
    } else {
      const snippet = clean(item.text || item.title || "", 60);
      message = `Contradicted claim ${snippet ? `"${snippet}" ` : ""}(${id}): not treated as current; verify before use.`;
    }
    message = message.slice(0, 220);
    if (!seen.has(message)) {
      seen.add(message);
      out.push(message);
    }
    if (out.length >= MAX_WARNINGS) break;
  }
  return out;
}

// ---- Scoring --------------------------------------------------------------
function scoreItem(item, ctx) {
  const breakdown = {};
  for (const key of RULE_KEYS) breakdown[key] = 0;

  breakdown.verification = ctx.weights.verification[item.verification]
    ?? ctx.weights.verification[VERIFICATION.OBSERVED];

  if (ctx.requested && item.project_explicit && item.project_id === ctx.requested) {
    breakdown.projectMatch = ctx.weights.projectMatch;
  }

  const matchedKeywords = matchKeywords(item.text, ctx.keywords);
  if (matchedKeywords.length > 0) breakdown.taskKeyword = ctx.weights.taskKeyword;

  if (isFresh(item.freshness_at, ctx.nowMs)) {
    breakdown.freshnessWithin30d = ctx.weights.freshnessWithin30d;
  }

  if (item.type === "relationship") breakdown.relationship = ctx.weights.relationship;

  if (item.verification === VERIFICATION.VERIFIED && item.isFix === true) {
    breakdown.verifiedFix = ctx.weights.verifiedFix;
  }

  const score = RULE_KEYS.reduce((sum, key) => sum + breakdown[key], 0);
  return {
    ...item,
    score: Math.round(score * 1000) / 1000,
    score_breakdown: breakdown,
    matched_keywords: matchedKeywords,
    provenance: { source: item.source || null, session: item.session || null },
  };
}

// ---- Public ranking entry point -------------------------------------------
/**
 * Rank and filter candidate context for a task.
 *
 * @param {object} options
 * @param {Array}  [options.items]     raw or already-normalized candidate rows
 * @param {object} [options.task]      { category, keywords/signals/query, retrieve, now }
 * @param {string} [options.project_id] requested project (or '_global')
 * @param {object} [options.weights]   partial override of SCORING_RULES weights
 * @param {object} [options.limits]    { maxItems = 8, minScore = 0 }
 * @param {*}      [options.now]       injected reference time for deterministic tests
 * @returns {{ok: boolean, selected: Array, rejected: Array<{id:string,reason:string}>,
 *            warnings: string[], stats: {input:number,kept:number,rejected:number,deduped:number}}}
 */
export function rankAndFilter(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const rawItems = Array.isArray(opts.items) ? opts.items : [];
  const task = opts.task && typeof opts.task === "object" ? opts.task : {};
  const requested = requestedProject(opts.project_id);
  const weights = mergeWeights(opts.weights);
  const limits = opts.limits && typeof opts.limits === "object" ? opts.limits : {};
  const maxItems = clampInt(limits.maxItems, 8, 0, MAX_LIMIT);
  const minScore = Number.isFinite(Number(limits.minScore)) ? Number(limits.minScore) : 0;
  const nowMs = computeNow(opts.now ?? task.now);
  const keywords = taskKeywords(task);

  const rejected = [];
  const warnings = [];
  const inScope = [];
  const candidates = [];
  const seenKeys = new Set();
  const seenText = new Set();
  let deduped = 0;

  for (const raw of rawItems) {
    let item;
    try {
      item = normalizeItem(raw, opts.project_id);
    } catch {
      item = null;
    }
    if (!item) {
      rejected.push({ id: shortId(raw), reason: "malformed" });
      continue;
    }

    // 1. Project isolation — before any scoring.
    let allowed;
    if (item.project_explicit) {
      allowed = (requested && item.project_id === requested)
        || (item.project_id === GLOBAL_PROJECT_ID && item.globally_eligible === true);
    } else {
      // Unknown scope: only an explicitly globally eligible row may pass.
      allowed = item.globally_eligible === true;
    }
    if (!allowed) {
      rejected.push({ id: item.id, reason: "cross-project" });
      continue;
    }
    inScope.push(item);

    // 2. Dedupe by (type,id) and by near-identical normalized text.
    const key = `${item.type}:${item.id}`;
    const textKey = normalizedTextKey(item.text);
    if (seenKeys.has(key) || (textKey && seenText.has(textKey))) {
      deduped += 1;
      rejected.push({ id: item.id, reason: "duplicate" });
      continue;
    }
    seenKeys.add(key);
    if (textKey) seenText.add(textKey);

    // 3. Superseded decisions are never current, but are kept as history when
    //    the task asks for historical context.
    if (item.verification === VERIFICATION.SUPERSEDED) {
      rejected.push({ id: item.id, reason: "superseded" });
      if (task.category === "documentation" || task.retrieve?.decisions === true) {
        warnings.push(`Superseded ${item.type} ${item.id} retained as history only, not current.`);
      }
      continue;
    }

    // 4. Contradicted items are never silently selected as one side of a conflict.
    if (item.verification === VERIFICATION.CONTRADICTED) {
      rejected.push({ id: item.id, reason: "contradicted" });
      continue;
    }

    // 4b. Phase 20 lifecycle status (optional field). Archived/rejected memories
    // do not consume ordinary task context; stale ones remain eligible but are
    // explicitly labelled so the agent can verify them. Existing items without
    // lifecycle metadata are unaffected.
    const lifecycle = String(raw?.lifecycle || item.lifecycle || "").toUpperCase();
    if (lifecycle === "ARCHIVED" || lifecycle === "REJECTED") {
      rejected.push({ id: item.id, reason: "archived-lifecycle" });
      warnings.push(`${lifecycle} memory ${item.id} kept for history, excluded from ordinary context.`);
      continue;
    }
    if (lifecycle === "OUTDATED" || lifecycle === "STALE" || lifecycle === "SUPERSEDED") {
      item.lifecycle_status = lifecycle;
      warnings.push(`Potentially ${lifecycle.toLowerCase()} memory ${item.id} retained as reference only; verify against current project state.`);
    }

    // 5. Score everything that survives the safety filters.
    candidates.push(scoreItem(item, { weights, requested, keywords, nowMs }));
  }

  // Conflict warnings are produced from in-scope items only, so no other
  // project's data is disclosed.
  for (const warning of conflictWarnings(inScope)) warnings.push(warning);

  // 6. Minimum score, then deterministic ranking.
  const passing = [];
  for (const candidate of candidates) {
    if (candidate.score < minScore) rejected.push({ id: candidate.id, reason: "below-min-score" });
    else passing.push(candidate);
  }
  passing.sort((a, b) => b.score - a.score
    || qualityRank(b.verification) - qualityRank(a.verification)
    || (b.freshness_at ? Date.parse(b.freshness_at) : 0) - (a.freshness_at ? Date.parse(a.freshness_at) : 0)
    || String(a.id).localeCompare(String(b.id)));

  const selected = passing.slice(0, maxItems);
  for (const candidate of passing.slice(maxItems)) {
    rejected.push({ id: candidate.id, reason: "over-limit" });
  }

  // De-duplicate warnings, bounded and deterministic.
  const uniqueWarnings = [];
  for (const warning of warnings) {
    if (!uniqueWarnings.includes(warning)) uniqueWarnings.push(warning);
    if (uniqueWarnings.length >= MAX_WARNINGS) break;
  }

  return {
    ok: true,
    selected,
    rejected,
    warnings: uniqueWarnings,
    stats: {
      input: rawItems.length,
      kept: selected.length,
      rejected: rejected.length,
      deduped,
    },
  };
}

export default {
  SCORING_RULES,
  defaultWeights,
  rankAndFilter,
  conflictWarnings,
  normalizeItem,
};
