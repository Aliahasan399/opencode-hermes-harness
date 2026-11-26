// Phase 26 — project-scoped dependency graph intelligence.
//
// One facade over pm_dependency (migration 024) plus dev_task.dependencies
// (migration 020). Evidence-only, project-scoped, bounded, redacted, best-effort
// audit. Only dependency_type='confirmed' is an authoritative execution
// constraint; inferred/proposed/unresolved edges are informational and reported
// under `unknown`. Phase 18 relationshipIntel / Phase 25 changeImpact are reused
// via load() best-effort and never treated as authoritative. No source is
// written, no task dispatched, no change approved, no critical path invented.
import * as core from "./core.js";

const freeze = (o) => Object.freeze(o);

export const DEPENDENCY_TYPES = freeze(["confirmed", "inferred", "proposed", "unresolved"]);
export const AUTHORITATIVE_TYPE = "confirmed";
export const NON_AUTHORITATIVE_NOTE =
  "inferred/proposed/unresolved dependencies are informational only; not execution constraints";
export const INCOMPLETE_EVIDENCE_NOTE =
  "incomplete dependency evidence; no critical path claimed";
export const SAFETY_NOTE =
  "Static, project-scoped, bounded evidence only. Only confirmed edges block execution; " +
  "no critical path or runtime outcome is claimed. No source was rewritten, no task dispatched, no change approved.";
export const DEPENDENCY_BOUNDS = freeze({
  depth_default: 3, depth_min: 1, depth_max: 6,
  nodes_default: 100, nodes_min: 1, nodes_max: 500,
  items_default: 100, items_max: 200,
  edges_max: 500, cycles_max: 50, bottlenecks_max: 20,
  evidence_max: 20, text_max: 400, key_max: 512,
});

const DEP_FIELDS =
  "id, project_id, from_type, from_id, to_type, to_id, dependency_type, confidence, evidence, created_by, created_at";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function validProject(p) { return nonEmptyString(p) && p.trim() !== "_global"; }
function short(v) { return String(v ?? "").replace(/\s+/g, " ").slice(0, DEPENDENCY_BOUNDS.key_max); }
function clip(text, max = DEPENDENCY_BOUNDS.text_max) {
  return core.redact(String(text ?? "")).replace(/\s+/g, " ").slice(0, max);
}
function clampInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.max(min, Math.min(n, max));
}
function clampLimit(value, fallback, max) {
  const n = Number.isInteger(value) && value > 0 ? value : fallback;
  return Math.min(n, max);
}
function clampConfidence(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
function shortError(e) { return String(e?.message || e).replace(/\s+/g, " ").slice(0, 160); }
function isTaskType(t) { return ["task", "dev_task", "devtask"].includes(String(t ?? "").toLowerCase()); }
function isCodeType(t) {
  return ["symbol", "code_symbol", "file", "code", "module"].includes(String(t ?? "").toLowerCase());
}
function nodeKey(type, id) { return `${String(type)}\u0000${String(id)}`; }
function parseKey(key) {
  const i = String(key).indexOf("\u0000");
  return i < 0 ? { type: "", id: String(key) } : { type: key.slice(0, i), id: key.slice(i + 1) };
}

function boundEvidence(value, cap = DEPENDENCY_BOUNDS.evidence_max) {
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

async function load(name) {
  try { return await import(`./${name}.js`); }
  catch { return null; }
}

async function audit(action, project_id, detail) {
  try { await core.audit(action, project_id, detail); }
  catch { /* best effort */ }
}

function normalizeDependency(row) {
  const authoritative = row.dependency_type === AUTHORITATIVE_TYPE;
  return {
    id: row.id,
    project_id: row.project_id,
    from_type: row.from_type,
    from_id: row.from_id,
    to_type: row.to_type,
    to_id: row.to_id,
    dependency_type: row.dependency_type,
    confidence: row.confidence ?? null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    created_by: row.created_by ?? "",
    created_at: row.created_at ?? null,
    authoritative,
    note: authoritative ? "confirmed dependency; authoritative execution constraint" : NON_AUTHORITATIVE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// 1. recordDependency
// ---------------------------------------------------------------------------

/**
 * Insert a typed dependency. Idempotent by the table UNIQUE key; a duplicate is
 * a no-op (never an overwrite). Only 'confirmed' is authoritative.
 */
export async function recordDependency({
  project_id, from_type, from_id, to_type, to_id,
  dependency_type = "inferred", evidence = [], confidence = 0, created_by = "",
} = {}) {
  const degraded = [];
  if (!validProject(project_id)) {
    return { ok: false, id: null, duplicate: false, reason: "a valid project_id is required", degraded };
  }
  if (!nonEmptyString(from_type) || !nonEmptyString(from_id)
      || !nonEmptyString(to_type) || !nonEmptyString(to_id)) {
    return { ok: false, id: null, duplicate: false, reason: "from_type/from_id/to_type/to_id are required", degraded };
  }
  const dtype = String(dependency_type || "inferred");
  if (!DEPENDENCY_TYPES.includes(dtype)) {
    return { ok: false, id: null, duplicate: false, reason: `dependency_type must be one of ${DEPENDENCY_TYPES.join(", ")}`, degraded };
  }
  const pid = short(project_id);
  const ev = boundEvidence(evidence);
  const authoritative = dtype === AUTHORITATIVE_TYPE;
  const note = authoritative
    ? "confirmed dependency; authoritative execution constraint"
    : NON_AUTHORITATIVE_NOTE;

  try {
    return await core.withDb(async (client) => {
      const values = [pid, short(from_type), short(from_id), short(to_type), short(to_id),
        dtype, clampConfidence(confidence), JSON.stringify(ev), clip(created_by ?? "", 120)];
      const ins = await client.query(
        `INSERT INTO pm_dependency
          (project_id, from_type, from_id, to_type, to_id, dependency_type, confidence, evidence, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (project_id, from_type, from_id, to_type, to_id, dependency_type) DO NOTHING
         RETURNING id`,
        values,
      );
      if (ins.rowCount === 0) {
        const ex = await client.query(
          `SELECT id FROM pm_dependency WHERE project_id=$1 AND from_type=$2 AND from_id=$3
             AND to_type=$4 AND to_id=$5 AND dependency_type=$6 LIMIT 1`,
          values.slice(0, 6),
        );
        return { ok: true, id: ex.rows[0]?.id ?? null, duplicate: true, authoritative, note };
      }
      const id = ins.rows[0].id;
      await audit("dependency.record", pid, {
        id, from_type: short(from_type), to_type: short(to_type), dependency_type: dtype,
        evidence_count: ev.length, authoritative,
      });
      return { ok: true, id, duplicate: false, authoritative, note };
    });
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, id: null, duplicate: false, reason, degraded: [`db: ${reason}`], note: SAFETY_NOTE };
  }
}

// ---------------------------------------------------------------------------
// 2. getDependencies
// ---------------------------------------------------------------------------

/** Bounded, project-scoped dependency read. Task nodes also read dev_task.dependencies. */
export async function getDependencies({
  project_id, node_type, node_id, direction = "both", limit = DEPENDENCY_BOUNDS.items_default,
} = {}) {
  const degraded = [];
  if (!validProject(project_id)) {
    return { ok: false, items: [], reason: "a valid project_id is required", degraded };
  }
  const dirMap = { both: "both", out: "from", from: "from", source: "from",
    in: "to", to: "to", target: "to" };
  const dir = dirMap[String(direction ?? "both").toLowerCase()] ?? null;
  if (!dir) {
    return { ok: false, items: [], reason: "direction must be both|from|to", degraded };
  }
  const hasType = nonEmptyString(node_type);
  const hasId = nonEmptyString(node_id);
  if (hasType !== hasId) {
    return { ok: false, items: [], reason: "node_type and node_id must be supplied together", degraded };
  }
  const n = clampLimit(limit, DEPENDENCY_BOUNDS.items_default, DEPENDENCY_BOUNDS.items_max);
  const pid = short(project_id);

  try {
    const params = [pid];
    let sql = `SELECT ${DEP_FIELDS} FROM pm_dependency WHERE project_id=$1`;
    if (hasType && hasId) {
      if (dir === "from") sql += " AND from_type=$2 AND from_id=$3";
      else if (dir === "to") sql += " AND to_type=$2 AND to_id=$3";
      else sql += " AND ((from_type=$2 AND from_id=$3) OR (to_type=$2 AND to_id=$3))";
      params.push(short(node_type), short(node_id));
    }
    params.push(n);
    sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const r = await core.dbQuery(sql, params);
    const items = r.rows.map(normalizeDependency);

    // Task nodes: supplement with caller-declared dev_task.dependencies (never authoritative).
    if (hasType && hasId && isTaskType(node_type) && items.length < n) {
      try {
        const remaining = n - items.length;
        const tr = await core.dbQuery(
          `SELECT id, task_key, dependencies FROM dev_task
            WHERE project_id=$1 AND (id=$2 OR task_key=$2) LIMIT 1`,
          [pid, short(node_id)],
        );
        const row = tr.rows[0];
        if (row) {
          const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
          for (const d of deps.slice(0, remaining)) {
            const toId = typeof d === "string" ? d
              : (d && typeof d === "object" ? (d.task_key ?? d.id ?? d.to_id ?? d.to) : null);
            if (!nonEmptyString(toId) || String(toId) === String(node_id)) continue;
            items.push({
              id: null,
              project_id: pid,
              from_type: "task",
              from_id: String(node_id),
              to_type: "task",
              to_id: short(toId),
              dependency_type: "inferred",
              confidence: null,
              evidence: [{ source: "dev_task.dependencies", excerpt: clip(String(toId), 200) }],
              created_by: "dev_task",
              created_at: null,
              authoritative: false,
              source: "dev_task",
              note: "declared on dev_task.dependencies; informational only, not an authoritative constraint",
            });
          }
        }
      } catch (e) { degraded.push(`dev_task.dependencies: ${shortError(e)}`); }
    }

    return {
      ok: true,
      items: items.slice(0, n),
      count: Math.min(items.length, n),
      limit: n,
      degraded,
      note: `${SAFETY_NOTE} ${NON_AUTHORITATIVE_NOTE}`,
    };
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, items: [], reason, degraded: [`db: ${reason}`], note: SAFETY_NOTE };
  }
}

// ---------------------------------------------------------------------------
// 3. Traversal helpers
// ---------------------------------------------------------------------------

function buildAdjacency(edges) {
  const out = new Map();
  const incoming = new Map();
  const nodes = new Set();
  for (const e of edges) {
    const a = nodeKey(e.from_type, e.from_id);
    const b = nodeKey(e.to_type, e.to_id);
    nodes.add(a); nodes.add(b);
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ key: b, edge: e });
    if (!incoming.has(b)) incoming.set(b, []);
    incoming.get(b).push({ key: a, edge: e });
  }
  return { out, incoming, nodes };
}

function traverse(root, adjacency, depth, cap) {
  const items = [];
  const seen = new Set([root]);
  let frontier = [{ key: root, depth: 0 }];
  let truncated = false;
  while (frontier.length && !truncated) {
    const next = [];
    for (const cur of frontier) {
      if (cur.depth >= depth) continue;
      for (const link of adjacency.get(cur.key) || []) {
        if (seen.has(link.key)) continue;
        if (items.length >= cap) { truncated = true; break; }
        seen.add(link.key);
        items.push({
          node: parseKey(link.key),
          depth: cur.depth + 1,
          via: link.edge?.id ?? null,
          dependency_type: link.edge?.dependency_type ?? null,
        });
        next.push({ key: link.key, depth: cur.depth + 1 });
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { items, truncated };
}

function findCycles(edges, allowedNodes) {
  const adj = new Map();
  for (const e of edges) {
    const a = nodeKey(e.from_type, e.from_id);
    const b = nodeKey(e.to_type, e.to_id);
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  const cycles = [];
  const seen = new Set();
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "active") {
      const at = stack.indexOf(n);
      const cyc = (at >= 0 ? stack.slice(at) : stack.slice()).concat(n);
      const unique = [...new Set(cyc)];
      const canon = unique.sort().join("|");
      if (!seen.has(canon)) { seen.add(canon); cycles.push(unique.map(parseKey)); }
      return;
    }
    state.set(n, "active");
    stack.push(n);
    for (const nx of adj.get(n) || []) if (allowedNodes.has(nx)) visit(nx);
    stack.pop();
    state.set(n, "done");
  };
  for (const n of [...allowedNodes].sort()) if (state.get(n) !== "done") visit(n);
  return cycles;
}

async function reuseExternal({ project_id, node_type, node_id, loaders, limit }) {
  const external = { relationshipIntel: null, changeImpact: null };
  const degraded = [];
  const getModule = async (name) => {
    if (loaders && Object.prototype.hasOwnProperty.call(loaders, name)) {
      const entry = loaders[name];
      return typeof entry === "function" ? await entry() : entry;
    }
    return await load(name);
  };
  if (!nonEmptyString(node_type) || !nonEmptyString(node_id)) return { external, degraded };

  try {
    const ri = await getModule("relationshipIntel");
    if (ri?.getRelationships) {
      const r = await ri.getRelationships({
        project_id, subject_type: short(node_type), subject_id: short(node_id),
        direction: "both", limit: Math.min(limit, 20),
      });
      const rels = Array.isArray(r?.relationships) ? r.relationships : [];
      external.relationshipIntel = {
        ok: r?.ok !== false,
        count: rels.length,
        signals: rels.slice(0, 10).map((x) => ({ relation_type: x.relation_type, confidence: x.confidence ?? null })),
        note: "supplementary relationship signals; never authoritative dependency evidence",
      };
    } else {
      external.relationshipIntel = { ok: false, reason: "unavailable" };
      degraded.push("relationshipIntel unavailable");
    }
  } catch (e) {
    external.relationshipIntel = { ok: false, reason: shortError(e) };
    degraded.push(`relationshipIntel: ${shortError(e)}`);
  }

  // Freshness is only meaningful for code-like nodes; skip for task/goal nodes.
  if (isCodeType(node_type)) {
    try {
      const ci = await getModule("changeImpact");
      if (ci?.compareIndexFreshness) {
        const r = await ci.compareIndexFreshness({ project_id, root: short(node_id) });
        external.changeImpact = {
          ok: r?.ok !== false,
          stale: r?.stale ?? null,
          changed_files: Array.isArray(r?.changed_files) ? r.changed_files.length : 0,
          note: "supplementary freshness signal; never authoritative dependency evidence",
        };
      } else {
        external.changeImpact = { ok: false, reason: "unavailable" };
        degraded.push("changeImpact unavailable");
      }
    } catch (e) {
      external.changeImpact = { ok: false, reason: shortError(e) };
      degraded.push(`changeImpact: ${shortError(e)}`);
    }
  }

  return { external, degraded };
}

// ---------------------------------------------------------------------------
// 4. analyzeDependencies
// ---------------------------------------------------------------------------

/** Bounded, confirmed-edge-only dependency analysis plus explicit unknowns. */
export async function analyzeDependencies({
  project_id, node_type, node_id, max_depth, max_nodes, loaders,
} = {}) {
  const degraded = [];
  const empty = () => ({
    ok: false, blocked: [], downstream: [], bottlenecks: [], cycles: [], unknown: [],
    degraded, note: SAFETY_NOTE,
  });
  if (!validProject(project_id)) return { ...empty(), reason: "a valid project_id is required" };

  const hasType = nonEmptyString(node_type);
  const hasId = nonEmptyString(node_id);
  if (hasType !== hasId) return { ...empty(), reason: "node_type and node_id must be supplied together" };

  const depth = clampInt(max_depth, DEPENDENCY_BOUNDS.depth_default,
    DEPENDENCY_BOUNDS.depth_min, DEPENDENCY_BOUNDS.depth_max);
  const nodesCap = clampInt(max_nodes, DEPENDENCY_BOUNDS.nodes_default,
    DEPENDENCY_BOUNDS.nodes_min, DEPENDENCY_BOUNDS.nodes_max);
  const pid = short(project_id);
  const rootKey = hasType && hasId ? nodeKey(short(node_type), short(node_id)) : null;

  try {
    const er = await core.dbQuery(
      `SELECT id, from_type, from_id, to_type, to_id, dependency_type, confidence, evidence
         FROM pm_dependency WHERE project_id=$1 ORDER BY id ASC LIMIT $2`,
      [pid, DEPENDENCY_BOUNDS.edges_max + 1],
    );
    if (er.rows.length > DEPENDENCY_BOUNDS.edges_max) degraded.push("dependency_edge_cap_reached");
    const all = er.rows.slice(0, DEPENDENCY_BOUNDS.edges_max);
    const confirmed = all.filter((r) => r.dependency_type === AUTHORITATIVE_TYPE);
    const nonConfirmed = all.filter((r) => r.dependency_type !== AUTHORITATIVE_TYPE);

    const { out, incoming, nodes } = buildAdjacency(confirmed);
    let blocked = [];
    let downstream = [];
    let truncated = false;
    if (rootKey) {
      const b = traverse(rootKey, out, depth, nodesCap);
      const d = traverse(rootKey, incoming, depth, nodesCap);
      blocked = b.items;
      downstream = d.items;
      truncated = b.truncated || d.truncated;
      if (truncated) degraded.push("traversal_node_cap_reached");
    }

    const indeg = new Map();
    for (const e of confirmed) {
      const k = nodeKey(e.to_type, e.to_id);
      indeg.set(k, (indeg.get(k) || 0) + 1);
    }
    const bottlenecks = [...indeg.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, DEPENDENCY_BOUNDS.bottlenecks_max)
      .map(([key, count]) => ({
        node: parseKey(key),
        dependent_count: count,
        note: "converged dependents from confirmed edges; a structural concentration, not an observed failure",
      }));

    const allowedNodes = new Set([...nodes].slice(0, nodesCap));
    const cycles = findCycles(confirmed, allowedNodes).slice(0, DEPENDENCY_BOUNDS.cycles_max);

    // Unknown = non-authoritative edges in scope + confirmed edges lacking evidence.
    const scope = new Set([rootKey]);
    for (const item of [...blocked, ...downstream]) scope.add(nodeKey(item.node.type, item.node.id));
    const touches = (e) => !rootKey
      || scope.has(nodeKey(e.from_type, e.from_id))
      || scope.has(nodeKey(e.to_type, e.to_id));
    const unknown = [];
    for (const e of nonConfirmed) {
      if (!touches(e)) continue;
      unknown.push({
        kind: "non_authoritative_edge",
        from: { type: e.from_type, id: e.from_id },
        to: { type: e.to_type, id: e.to_id },
        dependency_type: e.dependency_type,
        evidence_count: Array.isArray(e.evidence) ? e.evidence.length : 0,
        note: NON_AUTHORITATIVE_NOTE,
      });
    }
    for (const e of confirmed) {
      const hasEvidence = Array.isArray(e.evidence) && e.evidence.length > 0;
      if (hasEvidence || !touches(e)) continue;
      unknown.push({
        kind: "missing_evidence",
        from: { type: e.from_type, id: e.from_id },
        to: { type: e.to_type, id: e.to_id },
        dependency_type: e.dependency_type,
        evidence_count: 0,
        note: "confirmed edge has no explicit evidence; not usable as a verified constraint",
      });
    }

    const reused = await reuseExternal({
      project_id: pid, node_type: hasType ? short(node_type) : null,
      node_id: hasId ? short(node_id) : null, loaders, limit: nodesCap,
    });
    degraded.push(...reused.degraded);

    const note = unknown.length
      ? `${SAFETY_NOTE} ${INCOMPLETE_EVIDENCE_NOTE}`
      : `${SAFETY_NOTE} All edges in scope are confirmed with explicit evidence; this remains bounded static evidence, not runtime proof.`;

    return {
      ok: true,
      blocked,
      downstream,
      bottlenecks,
      cycles,
      unknown,
      note,
      external: reused.external,
      degraded,
      root: rootKey ? parseKey(rootKey) : null,
      depth,
      max_nodes: nodesCap,
      truncated,
      confirmed_edges: confirmed.length,
      non_authoritative_edges: nonConfirmed.length,
      claim: "Static/record-based evidence only; not runtime proof; no execution performed.",
    };
  } catch (e) {
    const reason = shortError(e);
    return { ...empty(), reason, degraded: [`db: ${reason}`] };
  }
}

// ---------------------------------------------------------------------------
// 5. detectCycles
// ---------------------------------------------------------------------------

/** Bounded, project-scoped cycle detection over confirmed edges only. */
export async function detectCycles({ project_id, limit = DEPENDENCY_BOUNDS.cycles_max } = {}) {
  const degraded = [];
  if (!validProject(project_id)) {
    return { ok: false, cycles: [], count: 0, reason: "a valid project_id is required", degraded };
  }
  const n = clampLimit(limit, DEPENDENCY_BOUNDS.cycles_max, DEPENDENCY_BOUNDS.edges_max);
  const edgeCap = Math.min(DEPENDENCY_BOUNDS.edges_max, Math.max(50, n * 10));
  try {
    const r = await core.dbQuery(
      `SELECT from_type, from_id, to_type, to_id FROM pm_dependency
        WHERE project_id=$1 AND dependency_type=$2 ORDER BY id ASC LIMIT $3`,
      [short(project_id), AUTHORITATIVE_TYPE, edgeCap + 1],
    );
    if (r.rows.length > edgeCap) degraded.push("edge_scan_truncated");
    const edges = r.rows.slice(0, edgeCap);
    const nodes = new Set();
    for (const e of edges) {
      nodes.add(nodeKey(e.from_type, e.from_id));
      nodes.add(nodeKey(e.to_type, e.to_id));
    }
    const cycles = findCycles(edges, new Set([...nodes].slice(0, DEPENDENCY_BOUNDS.nodes_max)))
      .slice(0, n);
    return {
      ok: true,
      cycles,
      count: cycles.length,
      edges_examined: edges.length,
      degraded,
      note: `${SAFETY_NOTE} Cycles are derived only from explicitly confirmed edges.`,
    };
  } catch (e) {
    const reason = shortError(e);
    return { ok: false, cycles: [], count: 0, reason, degraded: [`db: ${reason}`], note: SAFETY_NOTE };
  }
}

export default {
  DEPENDENCY_TYPES, AUTHORITATIVE_TYPE, NON_AUTHORITATIVE_NOTE,
  INCOMPLETE_EVIDENCE_NOTE, SAFETY_NOTE, DEPENDENCY_BOUNDS,
  recordDependency, getDependencies, analyzeDependencies, detectCycles,
};
