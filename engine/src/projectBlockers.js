// Phase 26 — project-scoped blocker lifecycle + risk-assessment facade.
//
// pm_blocker (migration 024) is the only blocker store. Evidence is appended,
// never deleted. 'resolved' requires explicit verification evidence via
// Phase 19 developmentGoal.canMarkComplete; status changes require an actor.
// assessRisks is a FACADE over Phase 23 engines (technicalDebt, dependencyRisk,
// projectRisk, recommendationEngine) loaded via load() best-effort. It never
// duplicates a risk/debt engine and never manufactures a probability or score.
// No source writes, no dispatch, no auto-approval.
import crypto from "node:crypto";
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const BLOCKER_SEVERITIES = freeze(["low", "medium", "high", "critical"]);
export const BLOCKER_CATEGORIES = freeze([
  "schedule", "dependency", "technical", "quality", "ownership", "scope",
  "architecture", "operational",
]);
export const BLOCKER_STATUSES = freeze(["identified", "active", "resolved", "accepted", "false_positive"]);
export const DELEGATE_SOURCES = freeze({
  tech_debt: "technicalDebt.detectDebt",
  dependency_risk: "dependencyRisk.analyzeDependencies",
  fragility: "projectRisk.predictFragility",
  recommendations: "recommendationEngine.buildRecommendations",
});
export const RISK_CLAIM = "Static/record-based evidence only; not runtime proof; no execution performed.";
export const RISK_NOTE =
  "Facade over Phase 23 evidence engines only; no second risk/debt engine. No probability, percentage " +
  "or risk score is manufactured here — any confidence is passed through from the delegate. Status " +
  "discipline: observed (explicit-marker/edge derived), confirmed (caller-declared only), inferred " +
  "(delegate predictions), potential (potential-failure classes / recommendations), insufficient_evidence " +
  "(sparse or degraded). Nothing is auto-confirmed, approved or remediated.";
export const BLOCKER_BOUNDS = freeze({
  items_default: 100, items_max: 200, risk_default: 100, risk_max: 500,
  evidence_max: 20, refs_max: 50, text_max: 400, key_max: 512, history_max: 50,
});

const BLOCKER_FIELDS =
  "id, project_id, blocker_key, title, description, severity, category, status, " +
  "affected_goals, affected_milestones, affected_tasks, evidence, owner, resolution, created_at, updated_at";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmptyString(p) && p.trim() !== "_global"; }
function short(v) { return String(v ?? "").replace(/\s+/g, " ").slice(0, BLOCKER_BOUNDS.key_max); }
function clip(text, max = BLOCKER_BOUNDS.text_max) {
  return core.redact(String(text ?? "")).replace(/\s+/g, " ").slice(0, max);
}
function clampLimit(value, fallback, max) {
  const n = Number.isInteger(value) && value > 0 ? value : fallback;
  return Math.min(n, max);
}
function shortError(e) { return String(e?.message || e).replace(/\s+/g, " ").slice(0, 160); }

function boundEvidence(value, cap = BLOCKER_BOUNDS.evidence_max) {
  const arr = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return arr.slice(0, cap).map((e) => {
    if (typeof e === "string") return clip(e);
    if (e && typeof e === "object") {
      const out = {};
      for (const [k, v] of Object.entries(e).slice(0, 20)) {
        out[String(k).slice(0, 60)] = typeof v === "string" ? clip(v) : v;
      }
      return out;
    }
    return e;
  });
}

function boundRefs(value, cap = BLOCKER_BOUNDS.refs_max) {
  const arr = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return arr.slice(0, cap).map((v) => (typeof v === "string" ? clip(v, 200) : v));
}

function mergeEvidence(prev, incoming, cap = BLOCKER_BOUNDS.refs_max) {
  const seen = new Set();
  const out = [];
  for (const e of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (e === null || e === undefined) continue;
    const key = typeof e === "object" ? JSON.stringify(e, Object.keys(e).sort()) : String(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* best effort */ }
}

function normalizeBlocker(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    blocker_key: row.blocker_key,
    title: row.title,
    description: row.description,
    severity: row.severity,
    category: row.category,
    status: row.status,
    affected_goals: Array.isArray(row.affected_goals) ? row.affected_goals : [],
    affected_milestones: Array.isArray(row.affected_milestones) ? row.affected_milestones : [],
    affected_tasks: Array.isArray(row.affected_tasks) ? row.affected_tasks : [],
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    owner: row.owner ?? "",
    resolution: row.resolution && typeof row.resolution === "object" ? row.resolution : {},
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. recordBlocker
// ---------------------------------------------------------------------------

/** Insert a blocker. Idempotent by UNIQUE(project_id, blocker_key); no overwrite. */
export async function recordBlocker({
  project_id, blocker_key, title = "", description = "", severity = "medium",
  category = "technical", affected_goals = [], affected_milestones = [],
  affected_tasks = [], evidence = [], owner = "",
} = {}) {
  const degraded = [];
  if (!validProject(project_id)) {
    return { ok: false, id: null, duplicate: false, reason: "a valid project_id is required", degraded };
  }
  if (!nonEmptyString(blocker_key)) {
    return { ok: false, id: null, duplicate: false, reason: "blocker_key is required", degraded };
  }
  const sev = String(severity ?? "medium");
  if (!BLOCKER_SEVERITIES.includes(sev)) {
    return { ok: false, id: null, duplicate: false, reason: `severity must be one of ${BLOCKER_SEVERITIES.join(", ")}`, degraded };
  }
  const cat = String(category ?? "technical");
  if (!BLOCKER_CATEGORIES.includes(cat)) {
    return { ok: false, id: null, duplicate: false, reason: `category must be one of ${BLOCKER_CATEGORIES.join(", ")}`, degraded };
  }
  const pid = short(project_id);
  const key = short(blocker_key);

  try {
    return await core.withDb(async (client) => {
      const ins = await client.query(
        `INSERT INTO pm_blocker
          (id, project_id, blocker_key, title, description, severity, category, status,
           affected_goals, affected_milestones, affected_tasks, evidence, owner, resolution)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'identified',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,'{}'::jsonb)
         ON CONFLICT (project_id, blocker_key) DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), pid, key, clip(title || key), clip(description), sev, cat,
          JSON.stringify(boundRefs(affected_goals)),
          JSON.stringify(boundRefs(affected_milestones)),
          JSON.stringify(boundRefs(affected_tasks)),
          JSON.stringify(boundEvidence(evidence)),
          clip(owner ?? "", 120)],
      );
      if (ins.rowCount === 0) {
        const ex = await client.query(
          "SELECT id FROM pm_blocker WHERE project_id=$1 AND blocker_key=$2 LIMIT 1",
          [pid, key],
        );
        return { ok: true, id: ex.rows[0]?.id ?? null, duplicate: true };
      }
      const id = ins.rows[0].id;
      await audit("blocker.record", pid, { id, blocker_key: key, severity: sev, category: cat });
      return { ok: true, id, duplicate: false };
    });
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, id: null, duplicate: false, reason, degraded: [`db: ${reason}`] };
  }
}

// ---------------------------------------------------------------------------
// 2. listBlockers
// ---------------------------------------------------------------------------

/** Bounded, filtered, project-scoped blocker read. */
export async function listBlockers({
  project_id, status, severity, limit = BLOCKER_BOUNDS.items_default,
} = {}) {
  const degraded = [];
  if (!validProject(project_id)) {
    return { ok: false, items: [], reason: "a valid project_id is required", degraded };
  }
  if (status !== undefined && status !== null && status !== "" && !BLOCKER_STATUSES.includes(String(status))) {
    return { ok: false, items: [], reason: `status must be one of ${BLOCKER_STATUSES.join(", ")}`, degraded };
  }
  if (severity !== undefined && severity !== null && severity !== "" && !BLOCKER_SEVERITIES.includes(String(severity))) {
    return { ok: false, items: [], reason: `severity must be one of ${BLOCKER_SEVERITIES.join(", ")}`, degraded };
  }
  const n = clampLimit(limit, BLOCKER_BOUNDS.items_default, BLOCKER_BOUNDS.items_max);
  const params = [short(project_id), status ? String(status) : null, severity ? String(severity) : null, n];
  try {
    const r = await core.dbQuery(
      `SELECT ${BLOCKER_FIELDS} FROM pm_blocker
        WHERE project_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::text IS NULL OR severity=$3)
        ORDER BY updated_at DESC, blocker_key ASC LIMIT $4`,
      params,
    );
    return {
      ok: true,
      items: r.rows.map(normalizeBlocker),
      count: r.rows.length,
      limit: n,
      degraded,
    };
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, items: [], reason, degraded: [`db: ${reason}`] };
  }
}

// ---------------------------------------------------------------------------
// 3. setBlockerStatus
// ---------------------------------------------------------------------------

async function verificationFn(loaders) {
  if (loaders && Object.prototype.hasOwnProperty.call(loaders, "developmentGoal")) {
    const entry = loaders.developmentGoal;
    const mod = typeof entry === "function" ? await entry() : entry;
    return typeof mod?.canMarkComplete === "function" ? mod.canMarkComplete : null;
  }
  const mod = await load("developmentGoal");
  return typeof mod?.canMarkComplete === "function" ? mod.canMarkComplete : null;
}

/**
 * Record a status transition. 'resolved' requires explicit verification evidence
 * (Phase 19 canMarkComplete). Evidence is appended; the actor is required.
 */
export async function setBlockerStatus({
  project_id, blocker_key, status, evidence = [], actor, loaders,
} = {}) {
  const degraded = [];
  if (!validProject(project_id) || !nonEmptyString(blocker_key)) {
    return { ok: false, changed: false, reason: "a valid project_id and blocker_key are required", degraded };
  }
  if (!BLOCKER_STATUSES.includes(String(status))) {
    return { ok: false, changed: false, reason: `status must be one of ${BLOCKER_STATUSES.join(", ")}`, degraded };
  }
  if (!nonEmptyString(actor)) {
    return { ok: false, changed: false, reason: "actor is required; status changes must be explicitly attributed", degraded };
  }
  const nextStatus = String(status);
  const ev = boundEvidence(evidence);

  if (nextStatus === "resolved") {
    let canMarkComplete = null;
    try { canMarkComplete = await verificationFn(loaders); }
    catch (e) { degraded.push(`developmentGoal: ${shortError(e)}`); }
    if (!canMarkComplete) {
      return {
        ok: false, changed: false, reason: "insufficient_evidence",
        note: "resolution verification unavailable; no status change made",
        degraded,
      };
    }
    let verified = false;
    try { verified = canMarkComplete(ev) === true; }
    catch (e) { degraded.push(`canMarkComplete: ${shortError(e)}`); }
    if (!verified) {
      return {
        ok: false, changed: false, reason: "insufficient_evidence",
        note: "resolution requires explicit verification evidence (test_pass/verification_result/tool_result/test_result); an agent assertion is not sufficient",
        degraded,
      };
    }
  }

  const pid = short(project_id);
  const key = short(blocker_key);
  const who = clip(actor, 120);

  try {
    return await core.withDb(async (client) => {
      const cur = await client.query(
        "SELECT id, status, evidence, resolution FROM pm_blocker WHERE project_id=$1 AND blocker_key=$2",
        [pid, key],
      );
      const row = cur.rows[0];
      if (!row) return { ok: false, changed: false, reason: "blocker not found in project", degraded };

      const merged = mergeEvidence(row.evidence, ev);
      const oldRes = row.resolution && typeof row.resolution === "object" ? row.resolution : {};
      const history = Array.isArray(oldRes.history) ? oldRes.history.slice(-BLOCKER_BOUNDS.history_max) : [];
      if (oldRes.status) {
        history.push({
          status: oldRes.status,
          at: oldRes.at ?? null,
          actor: oldRes.actor ?? null,
          evidence_count: oldRes.evidence_count ?? null,
        });
      }
      const resolution = {
        ...oldRes,
        status: nextStatus,
        at: new Date().toISOString(),
        actor: who,
        previous_status: row.status,
        evidence_count: merged.length,
        history: history.slice(-BLOCKER_BOUNDS.history_max),
      };
      for (const k of Object.keys(resolution)) {
        if (typeof resolution[k] === "string") resolution[k] = clip(resolution[k]);
      }

      const changed = row.status !== nextStatus || merged.length !== (Array.isArray(row.evidence) ? row.evidence.length : 0);
      if (!changed) {
        return { ok: true, changed: false, id: row.id, status: row.status, reason: "no status or evidence change", degraded };
      }
      await client.query(
        `UPDATE pm_blocker SET status=$2, evidence=$3::jsonb, resolution=$4::jsonb, updated_at=now()
          WHERE id=$1 AND project_id=$5`,
        [row.id, nextStatus, JSON.stringify(merged), JSON.stringify(resolution), pid],
      );
      await audit("blocker.status", pid, {
        id: row.id, from: row.status, to: nextStatus, actor: who, evidence_count: merged.length,
      });
      return {
        ok: true, changed: true, id: row.id, status: nextStatus,
        note: "Status recorded only; no code, task or decision was changed automatically.",
        degraded,
      };
    });
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, changed: false, reason, degraded: [`db: ${reason}`] };
  }
}

// ---------------------------------------------------------------------------
// 4. assessRisks — facade over Phase 23
// ---------------------------------------------------------------------------

function normalizeEvidence(evidence) {
  if (Array.isArray(evidence)) return { array: evidence, object: {} };
  if (evidence && typeof evidence === "object") return { array: [], object: evidence };
  return { array: [], object: {} };
}

function makeRef(source, item) {
  const obj = item && typeof item === "object" ? item : { description: String(item ?? "") };
  return {
    source,
    category: obj.category ?? obj.risk_category ?? "unknown",
    description: clip(obj.description ?? obj.impact ?? "explicit risk signal", 300),
    severity: obj.severity ?? "unknown",
    // Pass-through confidence only; this facade computes no score of its own.
    confidence: obj.confidence ?? null,
    evidence_class: obj.evidence_class ?? null,
    detection_method: obj.detection_method ?? null,
    status: obj.status ?? null,
    finding_id: obj.id ?? null,
  };
}

function classify(ref, distinctions) {
  let bucket = "inferred";
  if (ref.source === "caller_confirmed") bucket = "confirmed";
  else if (ref.evidence_class === "insufficient_evidence" || ref.category === "insufficient_evidence") {
    bucket = "insufficient_evidence";
  } else if (ref.evidence_class === "potential_failure" || ref.source === "recommendations") {
    bucket = "potential";
  } else if (ref.source === "dependency_risk" || ref.source === "tech_debt"
             || ref.detection_method === "deterministic") {
    bucket = "observed";
  }
  distinctions[bucket].push(ref);
}

/** Delegate to the frozen Phase 23 engines; aggregate bounded references only. */
export async function assessRisks({
  project_id, evidence = {}, limit = BLOCKER_BOUNDS.risk_default, loaders,
} = {}) {
  const degraded = [];
  const distinctions = {
    observed: [], confirmed: [], inferred: [], potential: [], insufficient_evidence: [],
  };
  const delegated = {
    tech_debt: { ok: false, source: DELEGATE_SOURCES.tech_debt, findings: [], degraded: [] },
    dependency_risk: { ok: false, source: DELEGATE_SOURCES.dependency_risk, risks: [], degraded: [] },
    fragility: { ok: false, source: DELEGATE_SOURCES.fragility, predictions: [], degraded: [] },
    recommendations: { ok: false, source: DELEGATE_SOURCES.recommendations, recommendations: [], degraded: [] },
  };
  const base = () => ({
    ok: false, risks: [], delegated, distinctions, degraded,
    claim: RISK_CLAIM, note: RISK_NOTE,
  });
  if (!validProject(project_id)) return { ...base(), reason: "a valid project_id is required" };

  const n = clampLimit(limit, BLOCKER_BOUNDS.risk_default, BLOCKER_BOUNDS.risk_max);
  const pid = short(project_id);
  const ev = normalizeEvidence(evidence);
  const getModule = async (name) => {
    if (loaders && Object.prototype.hasOwnProperty.call(loaders, name)) {
      const entry = loaders[name];
      return typeof entry === "function" ? await entry() : entry;
    }
    return await load(name);
  };
  const call = async (key, moduleName, method, args) => {
    try {
      const mod = await getModule(moduleName);
      if (!mod || typeof mod[method] !== "function") throw new Error(`${moduleName}.${method} unavailable`);
      const res = await mod[method](args);
      if (!res || res.ok === false) {
        const reason = String(res?.reason || `${key} returned not ok`);
        delegated[key].degraded.push(reason);
        degraded.push(`${key}: ${reason}`);
        return null;
      }
      delegated[key].ok = true;
      if (Array.isArray(res.degraded)) {
        for (const d of res.degraded.slice(0, 20)) {
          const msg = `${key}: ${String(d)}`;
          delegated[key].degraded.push(String(d));
          degraded.push(msg);
        }
      }
      return res;
    } catch (e) {
      const reason = `${moduleName}: ${shortError(e)}`;
      delegated[key].degraded.push(reason);
      degraded.push(reason);
      return null;
    }
  };

  // 1) technical debt
  const debt = await call("tech_debt", "technicalDebt", "detectDebt", {
    project_id: pid,
    components: Array.isArray(ev.object.components) ? ev.object.components : [],
    evidence: Array.isArray(ev.object.debt_evidence) ? ev.object.debt_evidence : ev.array,
    limit: n,
  });
  if (debt) delegated.tech_debt.findings = (Array.isArray(debt.findings) ? debt.findings : []).slice(0, n);

  // 2) dependency risk (caller-supplied edges/markers only)
  const dep = await call("dependency_risk", "dependencyRisk", "analyzeDependencies", {
    project_id: pid,
    edges: Array.isArray(ev.object.edges) ? ev.object.edges
      : (Array.isArray(ev.object.dependencies) ? ev.object.dependencies : []),
    evidence: Array.isArray(ev.object.dependency_evidence) ? ev.object.dependency_evidence : ev.object,
    limit: n,
  });
  if (dep) delegated.dependency_risk.risks = (Array.isArray(dep.risks) ? dep.risks : []).slice(0, n);

  // 3) fragility: debt findings + caller history/markers feed the delegate
  const frag = await call("fragility", "projectRisk", "predictFragility", {
    project_id: pid,
    findings: delegated.tech_debt.findings,
    history: Array.isArray(ev.object.history) ? ev.object.history : [],
    evidence: Array.isArray(ev.object.fragility_evidence) ? ev.object.fragility_evidence : ev.object,
    limit: n,
  });
  if (frag) delegated.fragility.predictions = (Array.isArray(frag.predictions) ? frag.predictions : []).slice(0, n);

  // 4) recommendations: consolidate delegate output, never apply it
  const recs = await call("recommendations", "recommendationEngine", "buildRecommendations", {
    project_id: pid,
    findings: delegated.tech_debt.findings,
    predictions: delegated.fragility.predictions,
    test_gaps: Array.isArray(ev.object.test_gaps) ? ev.object.test_gaps : [],
    learning_refs: Array.isArray(ev.object.learning_refs) ? ev.object.learning_refs : [],
    limit: n,
  });
  if (recs) delegated.recommendations.recommendations = (Array.isArray(recs.recommendations) ? recs.recommendations : []).slice(0, n);

  const risks = [];
  for (const item of delegated.tech_debt.findings) {
    const ref = makeRef("tech_debt", item); risks.push(ref); classify(ref, distinctions);
  }
  for (const item of delegated.dependency_risk.risks) {
    const ref = makeRef("dependency_risk", item); risks.push(ref); classify(ref, distinctions);
  }
  for (const item of delegated.fragility.predictions) {
    const ref = makeRef("fragility", item); risks.push(ref); classify(ref, distinctions);
  }
  for (const item of delegated.recommendations.recommendations) {
    const ref = makeRef("recommendations", item); risks.push(ref); classify(ref, distinctions);
  }
  // Caller-declared confirmations are the ONLY source for the confirmed bucket.
  for (const item of (Array.isArray(ev.object.confirmed) ? ev.object.confirmed : []).slice(0, n)) {
    const ref = makeRef("caller_confirmed", item); risks.push(ref); classify(ref, distinctions);
  }
  for (const reason of degraded) {
    distinctions.insufficient_evidence.push({ source: "degraded", reason: clip(reason, 300) });
  }

  return {
    ok: true,
    risks: risks.slice(0, BLOCKER_BOUNDS.risk_max),
    delegated,
    distinctions,
    degraded,
    callers_evidence_class: Array.isArray(ev.array) ? "array" : "object",
    claim: RISK_CLAIM,
    note: RISK_NOTE,
  };
}

export default {
  BLOCKER_SEVERITIES, BLOCKER_CATEGORIES, BLOCKER_STATUSES, DELEGATE_SOURCES,
  RISK_CLAIM, RISK_NOTE, BLOCKER_BOUNDS,
  recordBlocker, listBlockers, setBlockerStatus, assessRisks,
};
