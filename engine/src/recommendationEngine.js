// Phase 23 Features F + G — proactive engineering recommendations + architectural risk.
//
// Design rules (deliberately strict, deterministic, no LLM / no network):
//   * A recommendation is derived ONLY from explicit caller-supplied findings,
//     predictions, test gaps and learning refs. Related signals are consolidated
//     into one useful recommendation; duplicates are never emitted twice.
//   * PRIORITY_RULES is a frozen, versioned explanation of exactly how a priority
//     is produced. Every contributing factor (severity, impact, evidence,
//     confidence, recurrence, dependency criticality, effort) is additive and
//     bounded — no score is inflated without an explicit input.
//   * Persistence is append-only: a repeated (project_id, category, description)
//     is reported as a duplicate and its original content/history is preserved.
//   * Status changes are explicit operator decisions (decided_by is required).
//     Nothing here auto-applies a recommendation, changes a decision, or edits code.
//   * Architectural risk reuses decisionIntel/relationshipIntel via dynamic import,
//     distinguishes a confirmed violation (explicit evidence) from an advisory
//     recommendation, and NEVER silently supersedes a decision. Risks are stored
//     as project_finding rows with category 'architecture_risk' (direct upsert,
//     evidence merged, history preserved).
//   * Every free-text field is passed through core.redact(); every read/write is
//     project-scoped and bounded.
import crypto from "node:crypto";
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

// ---------------------------------------------------------------------------
// Frozen, explainable priority rules
// ---------------------------------------------------------------------------

export const PRIORITY_RULES = freeze({
  version: "1.0.0",
  priorities: freeze(["critical", "high", "medium", "low"]),
  // Ordered high -> low; `min` is the inclusive lower bound of the observed score.
  bands: freeze([
    freeze({ label: "critical", min: 5.5 }),
    freeze({ label: "high", min: 3.5 }),
    freeze({ label: "medium", min: 2 }),
    freeze({ label: "low", min: 0 }),
  ]),
  weights: freeze({
    // (1) severity — from an explicit finding/prediction severity only.
    severity: freeze({ critical: 4, high: 3, medium: 2, low: 1, unknown: 0 }),
    // (2) impact — explicit keyword markers found in the supplied impact text.
    impact: freeze({
      markers: freeze({
        "data loss": 1.5,
        outage: 1.5,
        cascade: 1,
        blocking: 1,
        security: 1,
        production: 0.75,
        widespread: 0.75,
        regression: 0.5,
      }),
      cap: 2,
    }),
    // (3) evidence — bounded count of distinct supporting evidence items.
    evidence: freeze({ per_item: 0.25, cap: 1 }),
    // (4) confidence — explicit confidence (0..1), never defaulted high.
    confidence: freeze({ weight: 2, default_with_evidence: 0.3, default_without_evidence: 0.2, cap: 0.9 }),
    // (5) recurrence — explicit occurrence count.
    recurrence: freeze({ per_occurrence: 0.2, cap: 1 }),
    // (6) dependency criticality — explicit marker in impact/dependencies/evidence.
    dependency: freeze({
      weight: 1,
      markers: freeze(["single_point", "single point", "shared", "core dependency", "cascade", "critical dependency"]),
    }),
    // (7) effort — a bounded tie-breaker; 'unknown' contributes zero.
    effort: freeze({ low: 0.5, medium: 0, high: -0.5, unknown: 0 }),
  }),
  // Confidence below this cannot be placed in an action bucket by the roadmap.
  thresholds: freeze({ low_confidence: 0.4 }),
  bounds: freeze({
    max_recommendations: 200,
    max_inputs: 500,
    max_evidence_per_recommendation: 50,
    max_steps: 20,
    max_learning_refs: 50,
    max_finding_ids: 100,
    max_dependencies: 50,
    max_explanation_chars: 2000,
    max_risk_rows: 50,
    max_risk_evidence: 50,
    max_history: 50,
  }),
  rules: freeze([
    "Every factor is additive and bounded; a missing input contributes zero (never a default-high score).",
    "Severity is read only from an explicit finding/prediction severity; unknown maps to zero.",
    "Impact contributes only via explicit keyword markers in the supplied impact text, capped at 2.",
    "Evidence contributes 0.25 per distinct item, capped at 1; evidence is never invented.",
    "Confidence contributes confidence*2 and is capped at 0.9; with no supplied value it stays low (0.3 with evidence, 0.2 without).",
    "Recurrence contributes 0.2 per explicit occurrence, capped at 1.",
    "Dependency criticality contributes 1 only when an explicit single_point/shared/core/cascade marker is present.",
    "Effort is a bounded tie-breaker: low +0.5, high -0.5, medium/unknown 0; it never inflates a priority on its own.",
    "priority = first band whose min <= total score; the full derivation is returned in `why`.",
    "Consolidation groups related signals into one recommendation; duplicates are merged, never emitted twice.",
    "Persisted recommendations are append-only; a repeated key is a duplicate and its history is preserved.",
    "Status changes require an explicit decided_by and never auto-apply code, findings or decisions.",
  ]),
});

export const RECOMMENDATION_STATUSES = freeze([
  "proposed", "reviewed", "accepted", "rejected", "in_progress",
  "completed", "deferred", "superseded",
]);

const VALID_EFFORTS = new Set(["low", "medium", "high", "unknown"]);
const VALID_CHANGE_RISKS = new Set(["low", "medium", "high", "unknown"]);
const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => nonEmptyString(v) && UUID_RE.test(String(v).trim());

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function finite(n, fallback) { const x = Number(n); return Number.isFinite(x) ? x : fallback; }
function round4(n) { return Math.round(finite(n, 0) * 10000) / 10000; }
function clamp01(n) { return Math.max(0, Math.min(1, finite(n, 0))); }
function clip(text, max) { return core.redact(String(text ?? "").replace(/\s+/g, " ")).slice(0, max); }
function boundedLimit(value, fallback, cap) {
  const n = Number.isInteger(value) ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, cap) : fallback;
}
function keyOf(x) {
  if (x && typeof x === "object") {
    try { return JSON.stringify(x, Object.keys(x).sort()); } catch { return String(x); }
  }
  return String(x ?? "");
}
function normText(x) {
  return String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}
function consolidationKey(category, description) {
  const cat = String(category ?? "quality").trim().toLowerCase().replace(/\s+/g, "_");
  return `${cat}|${normText(description).slice(0, 10).join(" ")}`;
}
function uniqueBy(items, cap) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}
function redactArray(value, cap, textMax = 400) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, cap).map((v) => {
    if (typeof v === "string") return clip(v, textMax);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v).slice(0, 20)) {
        out[String(k).slice(0, 60)] = typeof val === "string" ? clip(val, textMax) : val;
      }
      return out;
    }
    return v;
  });
}
function stepsFromRemediation(remediation, category, max) {
  const text = clip(remediation, 400);
  if (!text) return [];
  return [{ action: text, source: String(category ?? "quality").slice(0, 80) }].slice(0, max);
}
function severityRank(sev) { return ["low", "medium", "high", "critical"].indexOf(String(sev ?? "").toLowerCase()); }
function maxSeverity(severities) {
  let best = "unknown";
  for (const s of severities) if (severityRank(s) > severityRank(best)) best = String(s).toLowerCase();
  return best;
}
function occurrencesOf(x) {
  let n = finite(x?.occurrences, 0);
  for (const e of (Array.isArray(x?.evidence) ? x.evidence : [])) {
    n += finite(e?.occurrences, 0);
  }
  return Math.max(0, Math.floor(n));
}

// ---------------------------------------------------------------------------
// Explainable priority scoring (shared by roadmap ranking)
// ---------------------------------------------------------------------------

function impactContribution(text) {
  const lower = String(text ?? "").toLowerCase();
  const hits = [];
  let total = 0;
  for (const [marker, weight] of Object.entries(PRIORITY_RULES.weights.impact.markers)) {
    if (lower.includes(marker)) { total += weight; hits.push(marker); }
  }
  return { score: Math.min(total, PRIORITY_RULES.weights.impact.cap), hits };
}

function dependencyContribution(text) {
  const lower = String(text ?? "").toLowerCase();
  return PRIORITY_RULES.weights.dependency.markers.some((m) => lower.includes(m))
    ? PRIORITY_RULES.weights.dependency.weight : 0;
}

/** Produce {priority, score, factors, why} from explicit group-level signals. */
export function scorePriority({
  severity = "unknown", impact = "", evidenceCount = 0, confidence = null,
  recurrence = 0, dependencies = [], effort = "unknown",
} = {}) {
  const w = PRIORITY_RULES.weights;
  const sev = VALID_SEVERITIES.has(String(severity).toLowerCase()) ? String(severity).toLowerCase() : "unknown";
  const sevScore = w.severity[sev] ?? 0;
  const imp = impactContribution(impact);
  const evCount = Math.max(0, Math.floor(finite(evidenceCount, 0)));
  const evScore = Math.min(evCount * w.evidence.per_item, w.evidence.cap);
  const conf = confidence === null || confidence === undefined
    ? (evCount > 0 ? w.confidence.default_with_evidence : w.confidence.default_without_evidence)
    : clamp01(confidence);
  const confScore = round4(Math.min(conf, w.confidence.cap) * w.confidence.weight);
  const occ = Math.max(0, Math.floor(finite(recurrence, 0)));
  const recScore = Math.min(occ * w.recurrence.per_occurrence, w.recurrence.cap);
  const depText = `${impact} ${(Array.isArray(dependencies) ? dependencies : []).map(keyOf).join(" ")}`;
  const depScore = dependencyContribution(depText);
  const eff = VALID_EFFORTS.has(String(effort).toLowerCase()) ? String(effort).toLowerCase() : "unknown";
  const effScore = w.effort[eff];

  const score = round4(sevScore + imp.score + evScore + confScore + recScore + depScore + effScore);
  let priority = "low";
  for (const band of PRIORITY_RULES.bands) if (score >= band.min) { priority = band.label; break; }

  const factors = [
    { factor: "severity", contribution: sevScore, detail: `severity=${sev}` },
    { factor: "impact", contribution: imp.score, detail: imp.hits.length ? `markers=${imp.hits.join(",")}` : "no explicit impact markers" },
    { factor: "evidence", contribution: evScore, detail: `items=${evCount}` },
    { factor: "confidence", contribution: confScore, detail: `confidence=${round4(conf)}${confidence == null ? " (default, low)" : ""}` },
    { factor: "recurrence", contribution: recScore, detail: `occurrences=${occ}` },
    { factor: "dependency_criticality", contribution: depScore, detail: depScore ? "explicit critical dependency marker" : "none" },
    { factor: "effort", contribution: effScore, detail: `effort=${eff}` },
  ];
  const why = `priority=${priority} (score=${score}; ` +
    factors.map((f) => `${f.factor}=${round4(f.contribution)}(${f.detail})`).join("; ") + ")";
  return { priority, score, confidence: round4(conf), factors, why: why.slice(0, PRIORITY_RULES.bounds.max_explanation_chars) };
}

// ---------------------------------------------------------------------------
// 1. buildRecommendations — pure consolidation + ranking
// ---------------------------------------------------------------------------

function signalFromFinding(f) {
  if (!f || typeof f !== "object") return null;
  const category = nonEmptyString(f.category) ? f.category : "quality";
  const description = clip(f.description ?? f.title ?? `Explicit ${category} finding`, 400) || `Explicit ${category} finding`;
  return {
    source_kind: "finding",
    id: nonEmptyString(f.id) ? String(f.id) : null,
    category, description,
    component: nonEmptyString(f.component) ? String(f.component) : "_project",
    severity: f.severity ?? "unknown",
    confidence: f.confidence ?? null,
    impact: f.impact ?? "",
    remediation: f.remediation ?? "",
    evidence: Array.isArray(f.evidence) ? f.evidence : [],
    occurrences: occurrencesOf(f),
    dependencies: Array.isArray(f.dependencies) ? f.dependencies : [],
    learning_refs: Array.isArray(f.learning_refs) ? f.learning_refs : [],
    effort: f.effort ?? "unknown",
  };
}

function signalFromPrediction(p) {
  if (!p || typeof p !== "object") return null;
  const category = nonEmptyString(p.risk_category) ? p.risk_category : "fragility";
  const description = clip(p.impact ?? p.description ?? `Predicted ${category}`, 400) || `Predicted ${category}`;
  return {
    source_kind: "prediction",
    id: nonEmptyString(p.id) ? String(p.id) : null,
    category, description,
    component: nonEmptyString(p.component) ? String(p.component) : "_project",
    severity: p.severity ?? "unknown",
    confidence: p.confidence ?? null,
    impact: p.impact ?? "",
    remediation: p.preventive_action ?? p.remediation ?? "",
    evidence: Array.isArray(p.evidence) ? [...(p.signals ?? []), ...p.evidence] : (Array.isArray(p.signals) ? p.signals : []),
    occurrences: occurrencesOf(p),
    dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
    learning_refs: Array.isArray(p.learning_refs) ? p.learning_refs : [],
    effort: p.effort ?? "unknown",
  };
}

function signalFromGap(g) {
  if (!g || typeof g !== "object") return null;
  const category = "test_gap";
  const description = clip(g.description ?? g.gap ?? g.component ?? "test coverage gap", 400) || "test coverage gap";
  return {
    source_kind: "test_gap",
    id: nonEmptyString(g.id) ? String(g.id) : null,
    category, description,
    component: nonEmptyString(g.component) ? String(g.component) : "_project",
    severity: g.severity ?? "medium",
    // A caller-supplied gap is weak evidence; never defaulted high.
    confidence: g.confidence ?? null,
    impact: g.impact ?? "uncovered test coverage",
    remediation: g.remediation ?? g.suggestion ?? "",
    evidence: Array.isArray(g.evidence) ? g.evidence : [],
    occurrences: occurrencesOf(g),
    dependencies: Array.isArray(g.dependencies) ? g.dependencies : [],
    learning_refs: Array.isArray(g.learning_refs) ? g.learning_refs : [],
    effort: g.effort ?? "unknown",
  };
}

/**
 * Consolidate explicit signals into bounded, explainable recommendations.
 * No database access, no LLM, no network. Related findings are merged into one
 * recommendation; duplicate signals are never emitted twice.
 */
export function buildRecommendations({
  project_id, findings = [], predictions = [], test_gaps = [], learning_refs = [], limit = 50,
} = {}) {
  const degraded = [];
  if (!nonEmptyString(project_id)) {
    return { ok: false, recommendations: [], degraded: ["valid project_id required"], reason: "valid project_id required" };
  }
  const n = boundedLimit(limit, 50, PRIORITY_RULES.bounds.max_recommendations);
  const globalRefs = redactArray(learning_refs, PRIORITY_RULES.bounds.max_learning_refs);

  const signals = [];
  for (const f of (Array.isArray(findings) ? findings : []).slice(0, PRIORITY_RULES.bounds.max_inputs)) {
    const s = signalFromFinding(f);
    if (s) signals.push(s); else degraded.push("skipped invalid finding");
  }
  for (const p of (Array.isArray(predictions) ? predictions : []).slice(0, PRIORITY_RULES.bounds.max_inputs)) {
    const s = signalFromPrediction(p);
    if (s) signals.push(s); else degraded.push("skipped invalid prediction");
  }
  for (const g of (Array.isArray(test_gaps) ? test_gaps : []).slice(0, PRIORITY_RULES.bounds.max_inputs)) {
    const s = signalFromGap(g);
    if (s) signals.push(s); else degraded.push("skipped invalid test gap");
  }

  const groups = new Map();
  const seenFindingIds = new Set();
  for (const s of signals) {
    if (s.id && s.source_kind === "finding") {
      if (seenFindingIds.has(s.id)) continue;
      seenFindingIds.add(s.id);
    }
    const key = consolidationKey(s.category, s.description);
    let group = groups.get(key);
    if (!group) {
      group = {
        category: String(s.category).slice(0, 80),
        description: s.description,
        finding_ids: [], learning_refs: [], evidence: [], steps: [], dependencies: [],
        severities: [], confidences: [], impacts: [], remediations: [], occurrences: 0,
        components: [], efforts: [],
      };
      groups.set(key, group);
    }
    if (s.id && s.source_kind === "finding" && group.finding_ids.length < PRIORITY_RULES.bounds.max_finding_ids) {
      group.finding_ids.push(String(s.id).slice(0, 512));
    }
    for (const r of [...globalRefs, ...s.learning_refs]) {
      if (group.learning_refs.length < PRIORITY_RULES.bounds.max_learning_refs) group.learning_refs.push(r);
    }
    group.evidence.push(...s.evidence);
    group.severities.push(s.severity);
    if (s.confidence !== null && s.confidence !== undefined) group.confidences.push(clamp01(s.confidence));
    if (s.impact) group.impacts.push(String(s.impact));
    if (s.remediation) group.remediations.push(String(s.remediation));
    group.occurrences += s.occurrences;
    if (s.component && !group.components.includes(s.component)) group.components.push(s.component);
    group.dependencies.push(...s.dependencies);
    if (VALID_EFFORTS.has(String(s.effort).toLowerCase()) && String(s.effort).toLowerCase() !== "unknown") {
      group.efforts.push(String(s.effort).toLowerCase());
    }
    if (group.steps.length < PRIORITY_RULES.bounds.max_steps) {
      for (const st of stepsFromRemediation(s.remediation, s.category, PRIORITY_RULES.bounds.max_steps - group.steps.length)) {
        if (!group.steps.some((x) => keyOf(x) === keyOf(st))) group.steps.push(st);
      }
    }
  }

  const recommendations = [...groups.values()].slice(0, n).map((g) => {
    const evidence = redactArray(uniqueBy(g.evidence, PRIORITY_RULES.bounds.max_evidence_per_recommendation),
      PRIORITY_RULES.bounds.max_evidence_per_recommendation);
    const dependencies = redactArray(uniqueBy(g.dependencies, PRIORITY_RULES.bounds.max_dependencies),
      PRIORITY_RULES.bounds.max_dependencies);
    const learningRefs = uniqueBy(g.learning_refs, PRIORITY_RULES.bounds.max_learning_refs);
    const findingIds = uniqueBy(g.finding_ids, PRIORITY_RULES.bounds.max_finding_ids);
    const severity = maxSeverity(g.severities);
    const explicitConfidence = g.confidences.length
      ? round4(Math.max(...g.confidences)) : null;
    const impact = clip(g.impacts.filter(Boolean).join("; ") || `Explicit ${g.category} signal`, 400);
    // Effort comes only from explicit effort markers; never guessed from text.
    const effort = g.efforts.includes("high") ? "high" : g.efforts.includes("medium") ? "medium"
      : g.efforts.includes("low") && g.efforts.length === 1 ? "low" : "unknown";

    const scored = scorePriority({
      severity, impact, evidenceCount: evidence.length,
      confidence: explicitConfidence, recurrence: g.occurrences,
      dependencies, effort,
    });

    // Change risk is derived deterministically, never inflated beyond explicit signals.
    const depCritical = dependencyContribution(`${impact} ${dependencies.map(keyOf).join(" ")}`) > 0;
    const changeRisk = (severity === "critical" || (severity === "high" && effort === "high") || depCritical)
      ? "high" : severity === "high" || effort === "high" ? "medium" : "low";

    const steps = redactArray(uniqueBy(g.steps, PRIORITY_RULES.bounds.max_steps), PRIORITY_RULES.bounds.max_steps, 600);
    const why = `${scored.why}; consolidated ${findingIds.length} finding(s) across ${g.components.length} component(s); ` +
      `expected_benefit derived from explicit impact; change_risk=${changeRisk} (explicit severity/effort/dependency markers).`;

    return {
      id: null,
      project_id,
      category: g.category,
      description: g.description,
      finding_ids: findingIds,
      learning_refs: learningRefs,
      priority: scored.priority,
      expected_benefit: impact,
      effort,
      confidence: scored.confidence,
      steps,
      dependencies,
      change_risk: changeRisk,
      status: "proposed",
      decided_by: null,
      created_at: null,
      updated_at: null,
      // Explainability extras (not persisted columns but always returned).
      component: g.components[0] ?? "_project",
      components: g.components,
      evidence,
      score: scored.score,
      factors: scored.factors,
      why: why.slice(0, PRIORITY_RULES.bounds.max_explanation_chars),
    };
  }).sort((a, b) => (b.score - a.score) || a.category.localeCompare(b.category) || a.description.localeCompare(b.description));

  return {
    ok: true,
    project_id,
    recommendations,
    degraded,
    note: `Deterministic consolidation v${PRIORITY_RULES.version}; all priorities are explainable via PRIORITY_RULES and no score is inflated without explicit evidence.`,
  };
}

// ---------------------------------------------------------------------------
// 2. recordRecommendation — append-only upsert, history preserved
// ---------------------------------------------------------------------------

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    category: row.category,
    description: row.description,
    finding_ids: Array.isArray(row.finding_ids) ? row.finding_ids : [],
    learning_refs: Array.isArray(row.learning_refs) ? row.learning_refs : [],
    priority: row.priority,
    expected_benefit: row.expected_benefit,
    effort: row.effort,
    confidence: finite(row.confidence, 0),
    steps: Array.isArray(row.steps) ? row.steps : [],
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    change_risk: row.change_risk,
    status: row.status,
    decided_by: row.decided_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Persist a recommendation. Upsert key is (project_id, category, description).
 * A repeated key (or id) is a no-op duplicate: original content and history are
 * preserved. Returns { ok, id, duplicate? }.
 */
export async function recordRecommendation({
  project_id, category, description = "", finding_ids = [], learning_refs = [],
  priority = "medium", expected_benefit = "", effort = "unknown", confidence = 0,
  steps = [], dependencies = [], change_risk = "unknown", status = "proposed",
  decided_by = null, id,
} = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, id: id ?? null, reason: "valid project_id required" };
  if (!nonEmptyString(category)) return { ok: false, id: id ?? null, reason: "category is required" };
  if (id !== undefined && id !== null && !isUuid(id)) return { ok: false, id: id ?? null, reason: "id must be a uuid" };
  if (!nonEmptyString(description)) return { ok: false, id: id ?? null, reason: "description is required" };

  const cat = clip(category, 80);
  const desc = clip(description, 400);
  const pr = PRIORITY_RULES.priorities.includes(String(priority)) ? String(priority) : "medium";
  const st = RECOMMENDATION_STATUSES.includes(String(status)) ? String(status) : "proposed";
  const eff = VALID_EFFORTS.has(String(effort).toLowerCase()) ? String(effort).toLowerCase() : "unknown";
  const cr = VALID_CHANGE_RISKS.has(String(change_risk).toLowerCase()) ? String(change_risk).toLowerCase() : "unknown";
  const conf = round4(clamp01(confidence));
  const fids = redactArray(finding_ids, PRIORITY_RULES.bounds.max_finding_ids, 512);
  const lrefs = redactArray(learning_refs, PRIORITY_RULES.bounds.max_learning_refs);
  const stepList = redactArray(steps, PRIORITY_RULES.bounds.max_steps, 600);
  const deps = redactArray(dependencies, PRIORITY_RULES.bounds.max_dependencies);
  const benefit = clip(expected_benefit, 400);
  const decider = decided_by ? clip(decided_by, 120) : null;

  return core.withDb(async (client) => {
    if (nonEmptyString(id)) {
      const byId = await client.query(
        "SELECT id, project_id, category, description FROM engineering_recommendation WHERE id=$1",
        [String(id).slice(0, 512)],
      );
      if (byId.rowCount) {
        const row = byId.rows[0];
        if (row.project_id !== project_id) return { ok: false, id: row.id, reason: "id belongs to a different project" };
        return { ok: true, id: row.id, duplicate: true };
      }
    }

    const dup = await client.query(
      `SELECT id FROM engineering_recommendation
        WHERE project_id=$1 AND category=$2 AND description=$3 LIMIT 1`,
      [project_id, cat, desc],
    );
    if (dup.rowCount) {
      // Preserve the original row and its history; a duplicate attempt is audited but never overwrites.
      try {
        await core.audit("recommendation.duplicate", project_id, { id: dup.rows[0].id, category: cat, description: desc });
      } catch { /* best effort */ }
      return { ok: true, id: dup.rows[0].id, duplicate: true };
    }

    const newId = nonEmptyString(id) ? String(id) : crypto.randomUUID();
    await client.query(
      `INSERT INTO engineering_recommendation
        (id, project_id, category, description, finding_ids, learning_refs, priority,
         expected_benefit, effort, confidence, steps, dependencies, change_risk,
         status, decided_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,now(),now())`,
      [newId, project_id, cat, desc, JSON.stringify(fids), JSON.stringify(lrefs), pr,
        benefit, eff, conf, JSON.stringify(stepList), JSON.stringify(deps), cr, st, decider],
    );
    try {
      await core.audit("recommendation.record", project_id, {
        id: newId, category: cat, priority: pr, status: st, finding_count: fids.length,
      });
    } catch { /* best effort */ }
    return { ok: true, id: newId };
  });
}

// ---------------------------------------------------------------------------
// 3. updateRecommendationStatus — explicit, non-destructive, never auto-applied
// ---------------------------------------------------------------------------

/**
 * Record an operator decision on a recommendation. Requires an explicit
 * decided_by so a status can never be changed implicitly. Only status,
 * decided_by and updated_at are touched; no finding, decision or code is applied.
 */
export async function updateRecommendationStatus({ id, project_id, status, decided_by } = {}) {
  if (!isUuid(id) || !nonEmptyString(project_id)) {
    return { ok: false, changed: false, reason: "valid id and project_id are required" };
  }
  if (!RECOMMENDATION_STATUSES.includes(String(status))) {
    return { ok: false, changed: false, reason: `status must be one of ${RECOMMENDATION_STATUSES.join(", ")}` };
  }
  if (!nonEmptyString(decided_by)) {
    return { ok: false, changed: false, reason: "decided_by is required; status changes must be explicitly attributed (no auto-apply)" };
  }

  const actor = clip(decided_by, 120);
  return core.withDb(async (client) => {
    const cur = await client.query(
      `SELECT id, status, decided_by FROM engineering_recommendation WHERE id=$1 AND project_id=$2`,
      [String(id), project_id],
    );
    const row = cur.rows[0];
    if (!row) return { ok: false, changed: false, reason: "recommendation not found in project" };
    if (row.status === String(status)) {
      return { ok: true, changed: false, id: row.id, status: row.status, reason: "status unchanged" };
    }
    await client.query(
      `UPDATE engineering_recommendation SET status=$2, decided_by=$3, updated_at=now()
        WHERE id=$1 AND project_id=$4`,
      [row.id, String(status), actor, project_id],
    );
    try {
      await core.audit("recommendation.status", project_id, {
        id: row.id, from: row.status, to: String(status), decided_by: actor,
      });
    } catch { /* best effort */ }
    return {
      ok: true, changed: true, id: row.id, status: String(status), decided_by: actor,
      note: "Status recorded only; no code, finding or decision was applied automatically.",
    };
  });
}

// ---------------------------------------------------------------------------
// 4. getRecommendations / explainRecommendation — bounded, project-scoped reads
// ---------------------------------------------------------------------------

export async function getRecommendations({ project_id, category, status, priority, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, recommendations: [], reason: "valid project_id required" };
  const n = boundedLimit(limit, 50, PRIORITY_RULES.bounds.max_recommendations);
  const params = [project_id, category ? clip(category, 80) : null,
    status ? String(status) : null, priority ? String(priority) : null, n];
  const r = await core.dbQuery(
    `SELECT id, project_id, category, description, finding_ids, learning_refs, priority,
            expected_benefit, effort, confidence, steps, dependencies, change_risk,
            status, decided_by, created_at, updated_at
       FROM engineering_recommendation
      WHERE project_id=$1
        AND ($2::text IS NULL OR category=$2)
        AND ($3::text IS NULL OR status=$3)
        AND ($4::text IS NULL OR priority=$4)
      ORDER BY updated_at DESC, id::text ASC LIMIT $5`,
    params,
  );
  return { ok: true, project_id, recommendations: r.rows.map(normalizeRow), count: r.rows.length, limit: n };
}

/** Explain a recommendation with its supporting finding evidence and why/steps. */
export async function explainRecommendation({ id, project_id } = {}) {
  if (!isUuid(id) || !nonEmptyString(project_id)) {
    return { ok: false, reason: "valid id and project_id are required", evidence: [], steps: [] };
  }
  const r = await core.dbQuery(
    `SELECT id, project_id, category, description, finding_ids, learning_refs, priority,
            expected_benefit, effort, confidence, steps, dependencies, change_risk,
            status, decided_by, created_at, updated_at
       FROM engineering_recommendation WHERE id=$1 AND project_id=$2 LIMIT 1`,
    [String(id), project_id],
  );
  const row = normalizeRow(r.rows[0]);
  if (!row) return { ok: false, reason: "recommendation not found in project", evidence: [], steps: [] };

  let evidence = [];
  if (row.finding_ids.length) {
    try {
      const er = await core.dbQuery(
        `SELECT id, project_id, component, category, description, evidence, confidence,
                severity, impact, remediation, status
           FROM project_finding
          WHERE id = ANY($1::uuid[]) AND project_id=$2
          ORDER BY last_observed DESC LIMIT $3`,
        [row.finding_ids.slice(0, PRIORITY_RULES.bounds.max_finding_ids), project_id,
          PRIORITY_RULES.bounds.max_evidence_per_recommendation],
      );
      evidence = er.rows.map((f) => ({
        id: f.id, component: f.component, category: f.category,
        description: clip(f.description, 400), evidence: redactArray(f.evidence, 20),
        severity: f.severity, confidence: f.confidence, impact: clip(f.impact, 400),
        remediation: clip(f.remediation, 600), status: f.status,
      }));
    } catch { /* evidence lookup is optional; keep the recommendation explainable */ }
  }

  const rank = PRIORITY_RULES.priorities.indexOf(row.priority);
  const why = `priority=${row.priority} (rank ${rank >= 0 ? rank + 1 : "?"} of ${PRIORITY_RULES.priorities.length}); ` +
    `confidence=${round4(row.confidence)}; effort=${row.effort}; change_risk=${row.change_risk}; ` +
    `supporting findings=${row.finding_ids.length} (${evidence.length} resolved in project); ` +
    `learning refs=${row.learning_refs.length}; status=${row.status}; ` +
    `decided_by=${row.decided_by ?? "none"}. Expected benefit: ${row.expected_benefit || "not stated"}. ` +
    `Derivation follows PRIORITY_RULES v${PRIORITY_RULES.version} (severity, impact, evidence, confidence, recurrence, dependency criticality, effort).`;

  return {
    ok: true,
    id: row.id,
    project_id,
    recommendation: row,
    evidence,
    why: clip(why, PRIORITY_RULES.bounds.max_explanation_chars * 2),
    steps: row.steps,
    note: "Explanation is deterministic; no model call. Status changes require an explicit decided_by and are never auto-applied.",
  };
}

// ---------------------------------------------------------------------------
// 5. analyzeArchitecturalRisk — reuse decision/relationship intel, no supersede
// ---------------------------------------------------------------------------

const VIOLATION_MARKERS = ["violates_decision", "decision_violated", "violated_decision", "explicit_violation"];
const OUTDATED_MARKERS = ["outdated_decision", "outdated_pattern", "deprecated_decision", "stale_decision"];
const WORKAROUND_MARKERS = ["workaround", "repeated_fix", "temporary_fix", "repeated_workaround"];
const CONFLICT_MARKERS = ["conflicting_pattern", "conflicts_with", "contradicts", "incompatible", "conflict"];

function haystack(x) {
  if (x === null || x === undefined) return "";
  return JSON.stringify(x).toLowerCase();
}

async function loadModule(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

function riskUpsert({ project_id, component, category, description, evidence, confidence, severity, impact, remediation }) {
  return core.withDb(async (client) => {
    const desc = clip(description, 400);
    const dup = await client.query(
      `SELECT id, evidence, confidence, resolution, status, last_observed
         FROM project_finding
        WHERE project_id=$1 AND component=$2 AND category=$3 AND description=$4`,
      [project_id, component, category, desc],
    );
    const existing = dup.rows[0];
    if (existing) {
      const merged = uniqueBy([...(Array.isArray(existing.evidence) ? existing.evidence : []), ...evidence],
        PRIORITY_RULES.bounds.max_risk_evidence);
      const oldRes = existing.resolution && typeof existing.resolution === "object" ? existing.resolution : {};
      const history = Array.isArray(oldRes.history) ? oldRes.history.slice(-PRIORITY_RULES.bounds.max_history) : [];
      history.push({ at: new Date().toISOString(), evidence_count: merged.length, source: "architectural_risk" });
      const resolution = { ...oldRes, history: history.slice(-PRIORITY_RULES.bounds.max_history) };
      await client.query(
        `UPDATE project_finding SET evidence=$2::jsonb, confidence=$3, resolution=$4::jsonb, last_observed=now()
          WHERE id=$1 AND project_id=$5`,
        [existing.id, JSON.stringify(merged), round4(Math.max(finite(existing.confidence, 0), confidence)),
          JSON.stringify(resolution), project_id],
      );
      return { id: existing.id, duplicate: true };
    }
    const newId = crypto.randomUUID();
    const resolution = { history: [{ at: new Date().toISOString(), evidence_count: evidence.length, source: "architectural_risk" }] };
    await client.query(
      `INSERT INTO project_finding
        (id, project_id, component, category, description, detection_method, evidence,
         confidence, severity, impact, remediation, status, first_detected, last_observed, resolution)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'new',now(),now(),$12::jsonb)`,
      [newId, project_id, component, category, desc, "architectural_analysis", JSON.stringify(evidence),
        round4(confidence), severity, clip(impact, 400), clip(remediation, 600), JSON.stringify(resolution)],
    );
    return { id: newId, duplicate: false };
  });
}

function makeRisk({ category, description, classification, decision_id = null, finding_ids = [], evidence = [],
  severity = "medium", confidence = 0.3, remediation = "", note = "" }) {
  return {
    category,
    description: clip(description, 400),
    classification, // "confirmed_violation" | "recommendation"
    decision_id: decision_id ? String(decision_id).slice(0, 512) : null,
    finding_ids: uniqueBy(finding_ids, PRIORITY_RULES.bounds.max_finding_ids),
    evidence: redactArray(uniqueBy(evidence, PRIORITY_RULES.bounds.max_risk_evidence), PRIORITY_RULES.bounds.max_risk_evidence),
    severity: VALID_SEVERITIES.has(String(severity).toLowerCase()) ? String(severity).toLowerCase() : "medium",
    confidence: round4(clamp01(confidence)),
    remediation: clip(remediation, 600),
    note: clip(note, 500),
  };
}

/**
 * Identify outdated/superseded decisions causing problems, repeated workarounds,
 * conflicting patterns, and violations confirmed by explicit evidence. Reuses
 * decisionIntel/relationshipIntel via dynamic import (degrades if unavailable).
 * NEVER supersedes a decision. Risks are stored as project_finding rows with
 * category 'architecture_risk' (direct upsert with history).
 */
export async function analyzeArchitecturalRisk({
  project_id, decisions = [], findings = [], evidence = {}, limit = 50,
} = {}) {
  const degraded = [];
  if (!nonEmptyString(project_id)) {
    return { ok: false, risks: [], note: "valid project_id required" };
  }
  const n = boundedLimit(limit, 50, PRIORITY_RULES.bounds.max_risk_rows);

  const [decisionIntel, relationshipIntel] = await Promise.all([
    loadModule("decisionIntel"), loadModule("relationshipIntel"),
  ]);

  // Reuse decisionIntel for project-scoped stored decisions.
  const allDecisions = [];
  const seenDecisions = new Set();
  for (const d of (Array.isArray(decisions) ? decisions : []).slice(0, PRIORITY_RULES.bounds.max_inputs)) {
    if (!d || typeof d !== "object") { degraded.push("skipped invalid decision"); continue; }
    const id = nonEmptyString(d.id) ? String(d.id) : null;
    if (id && seenDecisions.has(id)) continue;
    if (id) seenDecisions.add(id);
    allDecisions.push(d);
  }
  if (decisionIntel?.getDecisions) {
    try {
      const stored = await decisionIntel.getDecisions({ project_id, limit: Math.min(n, 50) });
      if (stored.ok) {
        for (const d of (stored.decisions || [])) {
          if (nonEmptyString(d.id) && !seenDecisions.has(String(d.id))) {
            seenDecisions.add(String(d.id));
            allDecisions.push(d);
          }
        }
      }
    } catch (e) { degraded.push(`decisionIntel: ${String(e?.message || e).slice(0, 100)}`); }
  } else degraded.push("decisionIntel unavailable");

  // Reuse relationshipIntel for conflict signals, bounded per decision.
  const relationships = [];
  if (relationshipIntel?.getRelationships) {
    for (const d of allDecisions.filter((x) => nonEmptyString(x.id)).slice(0, 10)) {
      try {
        const rel = await relationshipIntel.getRelationships({
          project_id, subject_type: "decision", subject_id: String(d.id), limit: 20,
        });
        if (rel.ok) relationships.push(...(rel.relationships || []));
      } catch (e) { degraded.push(`relationshipIntel: ${String(e?.message || e).slice(0, 100)}`); }
    }
  } else degraded.push("relationshipIntel unavailable");

  const signals = (Array.isArray(findings) ? findings : [])
    .filter((f) => f && typeof f === "object")
    .slice(0, PRIORITY_RULES.bounds.max_inputs);
  for (const f of signals) {
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
      // Explicit evidence is required before any finding-backed claim is made.
      continue;
    }
  }
  const evidenced = signals.filter((f) => Array.isArray(f.evidence) && f.evidence.length > 0);
  if (signals.length !== evidenced.length) degraded.push("ignored findings without explicit evidence");

  const risks = [];
  const riskKeys = new Set();
  const addRisk = (risk) => {
    const key = `${risk.category}|${risk.decision_id ?? ""}|${risk.description}`;
    if (riskKeys.has(key)) return;
    riskKeys.add(key);
    if (risks.length < n) risks.push(risk);
  };
  const findingText = (f) => haystack(f);

  // (A) Outdated / superseded decisions still referenced in current findings.
  for (const d of allDecisions) {
    const status = String(d.status ?? "").toLowerCase();
    if (status !== "superseded" && status !== "archived") continue;
    const refs = evidenced.filter((f) => {
      const t = findingText(f);
      return (nonEmptyString(d.id) && t.includes(String(d.id).toLowerCase()))
        || (nonEmptyString(d.title) && t.includes(String(d.title).toLowerCase()))
        || OUTDATED_MARKERS.some((m) => t.includes(m));
    });
    if (!refs.length) continue;
    const ev = refs.flatMap((f) => f.evidence);
    addRisk(makeRisk({
      category: "outdated_decision_in_use",
      description: `Superseded/archived decision "${d.title ?? d.id ?? "unknown"}" is still referenced by current findings`,
      classification: "recommendation",
      decision_id: d.id,
      finding_ids: refs.map((f) => f.id).filter(Boolean),
      evidence: ev,
      severity: maxSeverity(refs.map((f) => f.severity)),
      confidence: Math.max(0.3, ...refs.map((f) => clamp01(f.confidence))),
      remediation: "Confirm the current decision with an operator before relying on or replacing the old one; this analysis never supersedes it.",
      note: "Advisory only: the decision remains unchanged and is not superseded automatically.",
    }));
  }

  // (B) Repeated workarounds (count from explicit occurrence markers only).
  const workarounds = evidenced.filter((f) =>
    String(f.category ?? "").toLowerCase() === "repeated_workaround"
    || WORKAROUND_MARKERS.some((m) => findingText(f).includes(m)));
  if (workarounds.length) {
    const count = workarounds.reduce((sum, f) => sum + Math.max(1, occurrencesOf(f)), 0);
    if (count >= 2 || workarounds.length >= 2) {
      addRisk(makeRisk({
        category: "repeated_workaround",
        description: `Repeated manual workarounds observed ${count} time(s); underlying defect is unresolved`,
        classification: "recommendation",
        finding_ids: workarounds.map((f) => f.id).filter(Boolean),
        evidence: workarounds.flatMap((f) => f.evidence),
        severity: maxSeverity(workarounds.map((f) => f.severity)),
        confidence: Math.max(0.3, ...workarounds.map((f) => clamp01(f.confidence))),
        remediation: "Track a single fix for the repeated workaround instead of applying it again per occurrence.",
        note: "Advisory only: occurrence counts come from explicit evidence, not from code-shape guesses.",
      }));
    }
  }

  // (C) Conflicting patterns from relationship intel or explicit finding markers.
  const conflictRels = relationships.filter((r) => CONFLICT_MARKERS.includes(String(r?.relation_type ?? "").toLowerCase()));
  const conflictFindings = evidenced.filter((f) =>
    CONFLICT_MARKERS.some((m) => findingText(f).includes(m)));
  if (conflictRels.length || conflictFindings.length) {
    addRisk(makeRisk({
      category: "conflicting_pattern",
      description: `Conflicting patterns detected (${conflictRels.length} relationship(s), ${conflictFindings.length} finding(s))`,
      classification: "recommendation",
      finding_ids: conflictFindings.map((f) => f.id).filter(Boolean),
      evidence: [
        ...conflictRels.map((r) => ({ relation_type: r.relation_type, confidence: r.confidence, evidence: r.evidence })),
        ...conflictFindings.flatMap((f) => f.evidence),
      ],
      severity: maxSeverity(conflictFindings.map((f) => f.severity)),
      confidence: Math.max(0.3, ...conflictFindings.map((f) => clamp01(f.confidence))),
      remediation: "Reconcile the conflicting patterns with the owning decision; do not change a decision implicitly.",
      note: "Advisory only: a relationship or marker is a lead, not proof; no decision is altered.",
    }));
  }

  // (D) Confirmed violation — requires explicit evidence tied to an ACTIVE decision.
  for (const f of evidenced) {
    const t = findingText(f);
    if (!VIOLATION_MARKERS.some((m) => t.includes(m))) continue;
    let ref = nonEmptyString(f.decision_id) ? String(f.decision_id) : null;
    if (!ref) {
      for (const d of allDecisions) {
        if (nonEmptyString(d.id) && t.includes(String(d.id).toLowerCase())) { ref = String(d.id); break; }
        if (nonEmptyString(d.title) && t.includes(String(d.title).toLowerCase())) { ref = String(d.id); break; }
      }
    }
    if (!ref) continue;
    const decision = allDecisions.find((d) => String(d.id) === ref);
    if (!decision || ["superseded", "archived"].includes(String(decision.status ?? "").toLowerCase())) continue;
    addRisk(makeRisk({
      category: "decision_violation",
      description: `Explicit evidence reports a violation of active decision "${decision.title ?? ref}"`,
      classification: "confirmed_violation",
      decision_id: ref,
      finding_ids: [f.id].filter(Boolean),
      evidence: f.evidence,
      severity: maxSeverity([f.severity, "high"]),
      confidence: Math.max(0.5, clamp01(f.confidence)),
      remediation: "Escalate to the decision owner; a confirmed violation is reported, never auto-corrected.",
      note: "Confirmed violation: explicit evidence ties the finding to an active decision. No decision is superseded here.",
    }));
  }

  // Persist each risk as project_finding(category='architecture_risk') with history.
  let stored = 0;
  for (const risk of risks) {
    try {
      const saved = await riskUpsert({
        project_id,
        component: "_project",
        category: "architecture_risk",
        description: `[${risk.classification}] ${risk.category}: ${risk.description}`,
        evidence: risk.evidence,
        confidence: risk.confidence,
        severity: risk.severity,
        impact: risk.description,
        remediation: risk.remediation,
      });
      risk.finding_id = saved.id;
      risk.stored_duplicate = saved.duplicate;
      stored++;
      try {
        await core.audit("architecture.risk_recorded", project_id, {
          id: saved.id, category: risk.category, classification: risk.classification,
          decision_id: risk.decision_id,
        });
      } catch { /* best effort */ }
    } catch (e) {
      degraded.push(`persist ${risk.category}: ${String(e?.message || e).slice(0, 100)}`);
    }
  }

  return {
    ok: true,
    project_id,
    risks,
    stored,
    degraded,
    note: "A confirmed violation requires explicit evidence tied to an active decision; all other risks are advisory recommendations. " +
      "Risks are stored as project_finding rows (category='architecture_risk') with preserved history. " +
      "This analysis NEVER silently supersedes a decision.",
  };
}

export default {
  PRIORITY_RULES,
  RECOMMENDATION_STATUSES,
  scorePriority,
  buildRecommendations,
  recordRecommendation,
  updateRecommendationStatus,
  getRecommendations,
  explainRecommendation,
  analyzeArchitecturalRisk,
};
