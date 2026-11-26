// Phase 20, workstream D: version history, explicit restoration and reversible
// archive, all audited. Additive only: no row is ever deleted, no original is
// overwritten, and restoration never promotes verification status.
//
// Design rules (mirrors memoryAuthorization.js and memoryIntelligence.js):
//   - every id-backed operation is resolved against an explicit project scope;
//     a row from another project is never returned or mutated;
//   - audit rows (memory_recovery_event / memory_lifecycle_event) carry ids,
//     states and short reasons only -- never memory content or titles;
//   - recovery creates a NEW memory row (source_kind='observed', verified=false)
//     and keeps the original's verification/quality values as inert metadata.
import * as core from "./core.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

function textOrNull(value, max = 512) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, max);
}

function fail(reason) { return { ok: false, reason: String(reason || "operation refused").slice(0, 300) }; }
function json(value) { return JSON.stringify(value ?? {}); }

function normalizedEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : (evidence == null ? [] : [evidence]);
  return list.slice(0, 20).map((e) => {
    if (e && typeof e === "object") {
      const out = {};
      for (const [k, v] of Object.entries(e).slice(0, 8)) out[String(k).slice(0, 64)] = String(v).slice(0, 200);
      return out;
    }
    return String(e).slice(0, 200);
  });
}

// Strict scope: only an exact project_id match is visible here. Global
// eligibility is deliberately NOT reused for mutating recovery operations.
async function scopedMemory(memory_id, project_id) {
  if (!isUuid(memory_id) || typeof project_id !== "string" || project_id.length === 0) return null;
  const r = await core.dbQuery(
    `SELECT id, project_id, layer, title, category, tags, source_session, source_kind,
            confidence, importance, verified, valid_until, version, metadata, lifecycle, quality_score
       FROM memory WHERE id=$1 LIMIT 1`,
    [memory_id],
  );
  const row = r.rows[0];
  return row && row.project_id === project_id ? row : null;
}

async function writeLifecycleEvent({ memory_id, project_id, from_state = null, to_state, reason = "", evidence = [], actor = "user" }) {
  const r = await core.dbQuery(
    `INSERT INTO memory_lifecycle_event (memory_id, project_id, from_state, to_state, reason, evidence, actor)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
    [memory_id, project_id, from_state, to_state, textOrNull(reason, 1000) || "", json(normalizedEvidence(evidence)), textOrNull(actor) || "user"],
  );
  return r.rows[0]?.id ?? null;
}

async function writeRecoveryEvent({ memory_id, project_id, operation, version = null, detail = {}, actor = "user" }) {
  const r = await core.dbQuery(
    `INSERT INTO memory_recovery_event (memory_id, project_id, operation, version, detail, actor)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
    [memory_id, project_id, operation, Number.isInteger(version) ? version : null, json(detail), textOrNull(actor) || "user"],
  );
  return r.rows[0]?.id ?? null;
}

// The protection rule for archiving: high importance, verified status, a
// VERIFIED lifecycle, constraint categories and explicit user marks are all
// "do not quietly archive" signals.
function protectionReasons(m) {
  const out = [];
  if (Number(m.importance) >= 0.8) out.push("importance>=0.8");
  if (m.verified === true) out.push("verified=true");
  if (m.lifecycle === "VERIFIED") out.push("lifecycle=VERIFIED");
  if (typeof m.category === "string" && /constraint/i.test(m.category)) out.push("category contains constraint");
  if (m.metadata && m.metadata.user_explicit === true) out.push("user_explicit=true");
  return out;
}

/**
 * Version metadata for one in-scope memory. Content is intentionally omitted:
 * the authorization layer for memory_versions also returns metadata only, and
 * audit/report paths must stay content-free.
 */
export async function getVersionHistory({ memory_id, project_id } = {}) {
  try {
    const m = await scopedMemory(memory_id, project_id);
    if (!m) return { ...fail("memory not found in project scope"), versions: [], count: 0 };
    const r = await core.dbQuery(
      `SELECT id, version, changed_at, reason FROM memory_history
        WHERE memory_id=$1 ORDER BY version DESC`,
      [memory_id],
    );
    const versions = r.rows.map((v) => ({
      id: String(v.id), version: v.version, changed_at: v.changed_at, reason: v.reason ?? "",
    }));
    return { ok: true, versions, count: versions.length };
  } catch (e) {
    return { ...fail(e.message), versions: [], count: 0 };
  }
}

/**
 * Restore a historical version as a NEW memory row. Requires explicit=true.
 * The original is left byte-for-byte intact; the copy is never marked verified.
 * Idempotent on (memory_id, version, operation='restore_version').
 */
export async function restoreVersion({
  memory_id, project_id, version, actor = "user", explicit = false, reason = "",
} = {}) {
  if (explicit !== true) return fail("explicit authorization required");
  if (!isUuid(memory_id)) return fail("invalid memory_id");
  if (typeof project_id !== "string" || project_id.length === 0) return fail("project_id required");
  if (!Number.isInteger(version) || version < 1) return fail("invalid version");
  const who = textOrNull(actor) || "user";
  const why = textOrNull(reason, 1000) || "";

  try {
    return await core.withDb(async (c) => {
      await c.query("BEGIN");
      try {
        // Serialize concurrent restores of the same memory so the check-then-
        // insert idempotency key cannot race.
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1), 0)", [`restore-version:${memory_id}`]);

        const cur = await c.query(
          `SELECT id, project_id, layer, title, category, tags, source_session, source_kind,
                  confidence, importance, verified, valid_until, version, metadata, lifecycle, quality_score
             FROM memory WHERE id=$1 LIMIT 1`,
          [memory_id],
        );
        const m = cur.rows[0];
        if (!m || m.project_id !== project_id) {
          await c.query("ROLLBACK");
          return fail("memory not found in project scope");
        }

        const prior = await c.query(
          `SELECT id, detail FROM memory_recovery_event
            WHERE memory_id=$1 AND operation='restore_version' AND version=$2
            ORDER BY id LIMIT 1`,
          [memory_id, version],
        );
        if (prior.rowCount) {
          await c.query("COMMIT");
          return {
            ok: true,
            duplicate: true,
            new_memory_id: prior.rows[0].detail?.new_memory_id ?? null,
            event_id: String(prior.rows[0].id),
          };
        }

        const hist = await c.query(
          `SELECT content FROM memory_history WHERE memory_id=$1 AND version=$2 LIMIT 1`,
          [memory_id, version],
        );
        if (!hist.rowCount) {
          await c.query("ROLLBACK");
          return fail("version not found in history");
        }

        const restored = await core.saveMemory({
          layer: m.layer,
          project_id: m.project_id,
          title: m.title,
          content: hist.rows[0].content,
          category: m.category,
          tags: m.tags || [],
          source_session: m.source_session,
          source_kind: "observed",
          confidence: m.confidence,
          importance: m.importance,
          verified: false,
          valid_until: m.valid_until,
          noEmbed: true,
          provenance: "unknown",
          metadata: {
            restored_from: { memory_id, version },
            restoration_reason: why,
            original_project_id: m.project_id,
            historical: {
              verified: m.verified,
              quality_score: m.quality_score ?? null,
              lifecycle: m.lifecycle,
              source_kind: m.source_kind,
              importance: m.importance,
            },
          },
        });

        const recoveryId = await writeRecoveryEvent({
          memory_id, project_id, operation: "restore_version", version,
          detail: { new_memory_id: restored.id, original_memory_id: memory_id, version, reason: why },
          actor: who,
        });
        const lifecycleId = await writeLifecycleEvent({
          memory_id: restored.id, project_id,
          from_state: null, to_state: restored.lifecycle || "HYPOTHESIS",
          reason: `restored version ${version}`, evidence: [], actor: who,
        });
        await core.audit("recovery.restore_version", memory_id, {
          new_memory_id: restored.id, version, lifecycle_event_id: lifecycleId, actor: who,
        });
        await c.query("COMMIT");
        return { ok: true, new_memory_id: restored.id, event_id: String(recoveryId) };
      } catch (e) {
        await c.query("ROLLBACK");
        return fail(e.message);
      }
    });
  } catch (e) {
    return fail(e.message);
  }
}

/**
 * Archive with an explicit protection screen. Protected memories refuse the
 * state change unless override===true AND non-empty evidence is supplied.
 * The real transition is delegated to memoryIntelligence.archiveMemory.
 */
export async function archiveMemorySafe({
  memory_id, project_id, actor = "user", reason = "", evidence = [], override = false,
} = {}) {
  const denied = { ok: false, archived: false };
  if (!isUuid(memory_id)) return { ...denied, reason: "invalid memory_id" };
  if (typeof project_id !== "string" || project_id.length === 0) return { ...denied, reason: "project_id required" };
  const who = textOrNull(actor) || "user";
  const why = textOrNull(reason, 1000) || "";
  const ev = normalizedEvidence(evidence);

  try {
    const m = await scopedMemory(memory_id, project_id);
    if (!m) return { ...denied, reason: "memory not found in project scope" };
    if (m.lifecycle === "ARCHIVED") return { ok: true, archived: false, reason: "already archived" };

    const protectedBy = protectionReasons(m);
    if (protectedBy.length > 0 && !(override === true && ev.length > 0)) {
      return {
        ...denied, protected: true,
        reason: `protected memory requires override=true with non-empty evidence (${protectedBy.join(", ")})`,
      };
    }

    const intel = await import("./memoryIntelligence.js");
    const result = await intel.archiveMemory({ memory_id, actor: who, note: why });

    const recoveryId = await writeRecoveryEvent({
      memory_id, project_id, operation: "archive", version: null,
      detail: {
        archived: result.status, from: m.lifecycle, protected: protectedBy.length > 0,
        evidence_count: ev.length, reason: why,
      },
      actor: who,
    });
    const lifecycleId = await writeLifecycleEvent({
      memory_id, project_id, from_state: m.lifecycle, to_state: result.status,
      reason: why || "explicit archive", evidence: ev, actor: who,
    });
    await core.audit("recovery.archive_safe", memory_id, {
      from: m.lifecycle, to: result.status, protected: protectedBy.length > 0, actor: who,
    });
    return { ok: true, archived: true, lifecycle_event_id: lifecycleId, recovery_event_id: recoveryId };
  } catch (e) {
    return { ...denied, reason: e.message };
  }
}

/**
 * Reversible archive restoration. Delegates to memoryIntelligence.restoreMemory
 * and is idempotent on a prior 'restore_archive' recovery event.
 */
export async function restoreArchived({ memory_id, project_id, actor = "user" } = {}) {
  if (!isUuid(memory_id)) return fail("invalid memory_id");
  if (typeof project_id !== "string" || project_id.length === 0) return fail("project_id required");
  const who = textOrNull(actor) || "user";
  try {
    const m = await scopedMemory(memory_id, project_id);
    if (!m) return fail("memory not found in project scope");

    const prior = await core.dbQuery(
      `SELECT id, detail FROM memory_recovery_event
        WHERE memory_id=$1 AND operation='restore_archive' ORDER BY id DESC LIMIT 1`,
      [memory_id],
    );
    if (prior.rowCount) {
      return {
        ok: true, duplicate: true,
        restored_to: prior.rows[0].detail?.restored_to ?? null,
        event_id: String(prior.rows[0].id),
      };
    }
    if (m.lifecycle !== "ARCHIVED") return fail("memory is not archived");

    const intel = await import("./memoryIntelligence.js");
    const result = await intel.restoreMemory({ memory_id, actor: who });
    const recoveryId = await writeRecoveryEvent({
      memory_id, project_id, operation: "restore_archive", version: null,
      detail: { restored_to: result.status, previous_lifecycle: "ARCHIVED" }, actor: who,
    });
    const lifecycleId = await writeLifecycleEvent({
      memory_id, project_id, from_state: "ARCHIVED", to_state: result.status,
      reason: "explicit archive restore", evidence: [], actor: who,
    });
    await core.audit("recovery.restore_archived", memory_id, {
      restored_to: result.status, lifecycle_event_id: lifecycleId, actor: who,
    });
    return { ok: true, restored_to: result.status, event_id: String(recoveryId) };
  } catch (e) {
    return fail(e.message);
  }
}

/** Read-only, bounded, project-scoped lifecycle and recovery summary. */
export async function lifecycleReport({ project_id, limit = 100 } = {}) {
  const empty = { ok: false, reason: "project_id required", by_lifecycle: {}, events: [], recoveries: [] };
  if (typeof project_id !== "string" || project_id.length === 0) return empty;
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  try {
    const counts = await core.dbQuery(
      `SELECT lifecycle, count(*)::int AS n FROM memory WHERE project_id=$1 GROUP BY lifecycle ORDER BY n DESC`,
      [project_id],
    );
    const by_lifecycle = {};
    for (const r of counts.rows) by_lifecycle[r.lifecycle || "(none)"] = r.n;

    const events = await core.dbQuery(
      `SELECT id, memory_id, from_state, to_state, reason, actor, created_at
         FROM memory_lifecycle_event WHERE project_id=$1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [project_id, n],
    );
    const recoveries = await core.dbQuery(
      `SELECT id, memory_id, operation, version, detail, actor, created_at
         FROM memory_recovery_event WHERE project_id=$1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [project_id, n],
    );
    return {
      ok: true, by_lifecycle, events: events.rows, recoveries: recoveries.rows, limit: n,
      note: "read-only; project-scoped; audit rows carry metadata only, never memory content",
    };
  } catch (e) {
    return { ...empty, reason: e.message };
  }
}
