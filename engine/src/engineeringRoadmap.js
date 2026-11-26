// Phase 23 Feature H — deterministic engineering roadmap + read-only history.
//
// Design rules (deliberately strict, deterministic, no LLM / no network):
//   * A roadmap is a pure projection of explicit recommendations. Nothing is
//     created, updated or applied; every item carries a deterministic `why`.
//   * Each recommendation lands in exactly one bucket. Low-confidence items are
//     diverted first so an unsupported "critical" claim cannot masquerade as an
//     actionable critical item. Low/effort-high/deferred items are long_term.
//   * Ranking reuses the frozen PRIORITY_RULES vocabulary from recommendationEngine
//     so the ordering is explainable and stable (score, then stable key).
//   * roadmapHistory is a bounded, project-scoped, read-only view over
//     project_assessment snapshots and engineering_recommendation status changes.
import { PRIORITY_RULES, scorePriority } from "./recommendationEngine.js";
import * as core from "./core.js";

const BUCKETS = Object.freeze(["critical", "high", "medium", "long_term", "low_confidence"]);

export const ROADMAP_RULES = Object.freeze({
  version: "1.0.0",
  buckets: BUCKETS,
  threshold: Object.freeze({
    low_confidence: PRIORITY_RULES.thresholds.low_confidence,
  }),
  bounds: Object.freeze({
    max_recommendations: 200,
    max_history_rows: 200,
    max_explanation_chars: 2000,
  }),
  rules: Object.freeze([
    "Low-confidence recommendations (confidence < 0.4) are placed in low_confidence first, regardless of stated priority.",
    "Otherwise priority critical/high/medium maps to its same-named bucket.",
    "Priority low, effort high, or status deferred maps to long_term.",
    "Each bucket is ranked by an explainable score (PRIORITY_RULES factors), then by a stable key; no randomness.",
    "A roadmap is read-only: no finding, decision, recommendation or code is modified.",
    "History is bounded and strictly project-scoped; a failed read degrades without inventing events.",
  ]),
});

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function finite(n, fallback) { const x = Number(n); return Number.isFinite(x) ? x : fallback; }
function boundedLimit(value, fallback, cap) {
  const n = Number.isInteger(value) ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, cap) : fallback;
}
function clip(text, max) { return core.redact(String(text ?? "").replace(/\s+/g, " ")).slice(0, max); }
function stableKey(item) {
  return `${item.id ?? ""}|${item.category ?? ""}|${item.description ?? ""}`;
}

function normalizeRecommendation(r) {
  if (!r || typeof r !== "object") return null;
  const priority = PRIORITY_RULES.priorities.includes(String(r.priority)) ? String(r.priority) : "medium";
  const effort = ["low", "medium", "high", "unknown"].includes(String(r.effort ?? "").toLowerCase())
    ? String(r.effort).toLowerCase() : "unknown";
  const status = [
    "proposed", "reviewed", "accepted", "rejected", "in_progress", "completed", "deferred", "superseded",
  ].includes(String(r.status ?? "")) ? String(r.status) : "proposed";
  return {
    id: nonEmptyString(r.id) ? String(r.id) : null,
    project_id: r.project_id ?? null,
    category: clip(r.category ?? "quality", 80) || "quality",
    description: clip(r.description ?? "Untitled recommendation", 400),
    priority,
    expected_benefit: clip(r.expected_benefit ?? "", 400),
    effort,
    confidence: Math.max(0, Math.min(1, finite(r.confidence, 0))),
    status,
    change_risk: clip(r.change_risk ?? "unknown", 40) || "unknown",
    steps: Array.isArray(r.steps) ? r.steps.slice(0, 20) : [],
    finding_ids: Array.isArray(r.finding_ids) ? r.finding_ids.slice(0, 100) : [],
    learning_refs: Array.isArray(r.learning_refs) ? r.learning_refs.slice(0, 50) : [],
    dependencies: Array.isArray(r.dependencies) ? r.dependencies.slice(0, 50) : [],
  };
}

function bucketFor(rec) {
  if (rec.confidence < ROADMAP_RULES.threshold.low_confidence) return "low_confidence";
  // A low priority, high effort or a deferred decision belongs to the long-term
  // horizon even when the stated priority is higher (explicit rule, deterministic).
  if (rec.priority === "low" || rec.effort === "high" || rec.status === "deferred") return "long_term";
  if (rec.priority === "critical") return "critical";
  if (rec.priority === "high") return "high";
  if (rec.priority === "medium") return "medium";
  return "long_term";
}

/**
 * Build a bounded, deterministic roadmap. Pure projection: no database writes.
 * Every item is decorated with an explicit `why` explaining its bucket and rank.
 */
export function buildRoadmap({ project_id, recommendations = [], limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) {
    return {
      ok: false,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, []])),
      explanation: "valid project_id required",
      total: 0,
      reason: "valid project_id required",
    };
  }
  const n = boundedLimit(limit, 50, ROADMAP_RULES.bounds.max_recommendations);
  const items = [];
  const seen = new Set();
  for (const raw of (Array.isArray(recommendations) ? recommendations : []).slice(0, ROADMAP_RULES.bounds.max_recommendations)) {
    const rec = normalizeRecommendation(raw);
    if (!rec) continue;
    const key = stableKey(rec);
    if (seen.has(key)) continue;
    seen.add(key);

    const scored = scorePriority({
      severity: (raw && raw.severity) || "unknown",
      impact: rec.expected_benefit,
      evidenceCount: rec.finding_ids.length,
      confidence: rec.confidence,
      recurrence: (raw && Number(raw.recurrence)) || 0,
      dependencies: rec.dependencies,
      effort: rec.effort,
    });
    const bucket = bucketFor(rec);
    const rankScore = finite(scored.score, 0) + PRIORITY_RULES.priorities.length - PRIORITY_RULES.priorities.indexOf(rec.priority);
    const why = `${bucket}: priority=${rec.priority}, confidence=${rec.confidence.toFixed(2)}, ` +
      `effort=${rec.effort}, status=${rec.status}, findings=${rec.finding_ids.length}, ` +
      `score=${finite(scored.score, 0).toFixed(2)} (${scored.factors.map((f) => `${f.factor}=${finite(f.contribution, 0).toFixed(2)}`).join(", ")}); ` +
      `bucket rule=${bucket === "low_confidence" ? "confidence<0.4" : bucket === "long_term" ? "low/high-effort/deferred" : `priority=${rec.priority}`}.`;

    items.push({ ...rec, bucket, rank_score: finite(rankScore, 0), why: clip(why, ROADMAP_RULES.bounds.max_explanation_chars) });
  }

  // Deterministic global order: score desc, then priority rank, then stable key.
  items.sort((a, b) =>
    (b.rank_score - a.rank_score)
    || (PRIORITY_RULES.priorities.indexOf(a.priority) - PRIORITY_RULES.priorities.indexOf(b.priority))
    || stableKey(a).localeCompare(stableKey(b)));

  const selected = items.slice(0, n);
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const item of selected) buckets[item.bucket].push(item);

  const explanation = `Deterministic roadmap v${ROADMAP_RULES.version}. ` +
    `Bucket precedence: low_confidence (confidence<${ROADMAP_RULES.threshold.low_confidence}) first, then ` +
    `long_term (low priority, high effort or deferred), then critical/high/medium by priority. ` +
    `Within each bucket items are ranked by an explainable PRIORITY_RULES score (severity, impact, evidence, ` +
    `confidence, recurrence, dependency criticality, effort) and then a stable key. ` +
    `Each item's \`why\` documents its own derivation. This is a read-only projection: nothing is applied.`;

  return { ok: true, project_id, buckets, explanation, total: selected.length, limit: n };
}

/**
 * Read-only, bounded view of assessment snapshots and recommendation status
 * changes for a project. No mutations; a failed read degrades without inventing data.
 */
export async function roadmapHistory({ project_id, limit = 50 } = {}) {
  if (!nonEmptyString(project_id)) return { ok: false, history: [], reason: "valid project_id required", count: 0 };
  const n = boundedLimit(limit, 50, ROADMAP_RULES.bounds.max_history_rows);
  const q = async (sql, params) => {
    try { return (await core.dbQuery(sql, params)).rows; }
    catch { return []; }
  };
  const degraded = [];
  const [assessments, recommendations] = await Promise.all([
    q(
      `SELECT id, component, dimensions, status, created_at, updated_at
         FROM project_assessment WHERE project_id=$1
        ORDER BY updated_at DESC, id::text ASC LIMIT $2`,
      [project_id, n],
    ),
    q(
      `SELECT id, category, description, priority, status, decided_by, created_at, updated_at
         FROM engineering_recommendation WHERE project_id=$1
        ORDER BY updated_at DESC, id::text ASC LIMIT $2`,
      [project_id, n],
    ),
  ]);

  const history = [];
  for (const a of assessments) {
    history.push({
      source: "project_assessment",
      id: a.id,
      at: a.updated_at ?? a.created_at ?? null,
      summary: `assessment ${a.component ?? "_project"} (${a.status ?? "active"}): ${Object.keys(a.dimensions || {}).length} dimensions`,
      detail: { component: a.component ?? "_project", status: a.status ?? "active" },
    });
  }
  for (const r of recommendations) {
    history.push({
      source: "engineering_recommendation",
      id: r.id,
      at: r.updated_at ?? r.created_at ?? null,
      summary: `recommendation [${r.category}] ${clip(r.description, 120)} -> ${r.status ?? "proposed"}`,
      detail: { category: r.category, priority: r.priority, status: r.status, decided_by: r.decided_by ?? null },
    });
  }
  history.sort((x, y) => String(y.at ?? "").localeCompare(String(x.at ?? "")) || String(x.id).localeCompare(String(y.id)));
  const selected = history.slice(0, n);
  if (!assessments.length && !recommendations.length) degraded.push("no assessment or recommendation rows found in project");

  return {
    ok: true,
    project_id,
    history: selected,
    count: selected.length,
    limit: n,
    degraded,
    note: "Read-only: this view never modifies an assessment, recommendation, finding or decision. " +
      "Recommendation history is derived from current status/timestamps; content changes are append-only.",
  };
}

export default { ROADMAP_RULES, buildRoadmap, roadmapHistory };
