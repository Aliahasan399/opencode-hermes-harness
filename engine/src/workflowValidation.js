// Phase 24 workflow validation: evidence-gated post-condition verification.
// SAFETY / LEVEL 1: verification is project-scoped, fail-closed on empty or
// `_global` project_id, and never treats a bare `process_ok` or a `mock`/`api`
// evidence tier as proof. Certainty / percentage / CVE language is detected,
// flagged into `claims[]` and stripped from every emitted field; it is never
// emitted as fact. Reads are bounded, writes are best-effort and audited
// content-free. No source is rewritten and no process is spawned here.
import * as core from "./core.js";

const short = (v, n = 220) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
const bound = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(Math.trunc(n), hi)) : dflt;
};
const fail = (reason) => ({ ok: false, verified: false, checks: [], claims: [], reason });

// Flag codes are intentionally generic: they must not themselves contain the
// banned literals (so a flag can never re-introduce an overclaim into output).
const CLAIM_RULES = Object.freeze([
  Object.freeze({ code: "ABSOLUTE_PERCENT", re: /\b100\s*%/gi }),
  Object.freeze({ code: "GUARANTEE_TERM", re: /\bguarantee(?:d|s)?\b/gi }),
  Object.freeze({ code: "CVE_ID", re: /\bCVE-\d{4}-\d+\b/gi }),
  Object.freeze({ code: "UNIVERSAL_QUANTIFIER", re: /\balways\b|\bnever\s+fails?\b/gi }),
  Object.freeze({ code: "INVENTED_PERCENTAGE", re: /\b\d{1,3}(?:\.\d+)?\s*%/g }),
  Object.freeze({ code: "CERTAINTY_TERM", re: /\bcertainly\b|\bdefinitely\b|\bno\s+doubt\b|\bproven\s+cause\b/gi }),
]);

const VALID_EVIDENCE = Object.freeze(["runtime", "agent"]);

/** Scan text for overclaim language. Returns flag codes + a cleaned string. */
function scanClaims(text) {
  const s = short(text, 4000);
  const codes = [];
  for (const { code, re } of CLAIM_RULES) {
    re.lastIndex = 0;
    if (re.test(s)) codes.push(code);
  }
  let cleaned = s;
  for (const { re } of CLAIM_RULES) {
    re.lastIndex = 0;
    cleaned = cleaned.replace(new RegExp(re.source, "gi"), "[REDACTED_CLAIM]");
  }
  cleaned = short(cleaned, 400).trim();
  return { flagged: [...new Set(codes)].map((flag) => ({ flag })), cleaned };
}

/**
 * Helper: assert that a piece of text contains no certainty / percentage /
 * CVE overclaims. `ok` is true only when nothing was flagged. `cleaned` is
 * always safe to emit.
 */
export function assertNoOverclaim({ text } = {}) {
  const { flagged, cleaned } = scanClaims(text);
  return { ok: flagged.length === 0, flagged, cleaned };
}

/**
 * Verify explicit post-conditions for one task and persist a verification row.
 * `verified` becomes true ONLY when checks is a non-empty array whose every
 * entry has pass === true AND evidence_class is 'runtime' or 'agent'.
 * `process_ok` is accepted for transparency but can never set `verified`.
 */
export async function validateTask({ project_id, run_id, task_key, checks, evidence_class,
  process_ok, evidence_refs, limit, query } = {}) {
  if (!project_id || project_id === "_global") return fail("valid project_id required");
  if (!run_id) return fail("run_id required");
  if (!task_key) return fail("task_key required");

  const degraded = [];
  const q = typeof query === "function" ? query : core.dbQuery;
  const ec = typeof evidence_class === "string" ? evidence_class.toLowerCase() : "";
  const evidenceOk = VALID_EVIDENCE.includes(ec);

  // Post-conditions: must be a non-empty (bounded) array of explicit passes.
  const arr = Array.isArray(checks) ? checks.slice(0, bound(limit, 1, 100, 100)) : [];
  const claims = [];
  let allPass = arr.length > 0;
  const normalized = arr.map((c, i) => {
    const item = c && typeof c === "object" ? c : { name: String(c ?? ""), pass: false };
    const text = [item.name, item.description, item.detail, item.note, item.evidence]
      .filter((v) => v !== undefined && v !== null).join(" ");
    const oc = scanClaims(text);
    for (const f of oc.flagged) claims.push({ ...f, field: `checks[${i}]` });
    const passed = item.pass === true; // strict: truthy values do not count
    if (!passed) allPass = false;
    return { name: short(item.name ?? `check_${i}`, 120), pass: passed,
      detail: core.redact(oc.cleaned).slice(0, 400) };
  });

  // Evidence references are recorded redacted and bounded, never trusted as fact.
  const refs = Array.isArray(evidence_refs)
    ? evidence_refs.slice(0, 50).map((r) => short(core.redact(typeof r === "string" ? r : JSON.stringify(r ?? {})), 300))
    : [];

  const verified = allPass && evidenceOk;
  const reason = !allPass ? "checks_missing_or_failing"
    : !evidenceOk ? "evidence_class_not_eligible"
      : "postconditions_passed_with_eligible_evidence";

  try {
    await q(
      `INSERT INTO workflow_verification (run_id,task_key,project_id,checks,verified,claims,evidence_refs)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb)`,
      [String(run_id), String(task_key), project_id, JSON.stringify(normalized), verified,
        JSON.stringify(claims), JSON.stringify(refs)],
    );
  } catch (e) { degraded.push(`persist: ${short(e?.message || e, 100)}`); }

  try {
    await core.audit("p24.validate_task", project_id, {
      run_id: short(run_id, 60), task_key: short(task_key, 60),
      verified, checks: normalized.length, claims: claims.length,
      evidence_class: ec, process_ok: process_ok === true, degraded: degraded.slice(0, 5),
    });
  } catch { /* best effort */ }

  return {
    ok: true, verified, checks: normalized, claims, reason,
    process_ok: process_ok === true, degraded,
    note: verified
      ? "Post-conditions passed with eligible evidence. No certainty claim was emitted."
      : "Verification withheld. process_ok and ineligible evidence can never verify a task.",
  };
}

/** Bounded, project-scoped aggregate of persisted verifications for a run. */
export async function validateRun({ project_id, run_id, limit = 50, query } = {}) {
  if (!project_id || project_id === "_global") return { ok: false, verified_count: 0, total: 0, items: [], reason: "valid project_id required" };
  if (!run_id) return { ok: false, verified_count: 0, total: 0, items: [], reason: "run_id required" };
  const q = typeof query === "function" ? query : core.dbQuery;
  const n = bound(limit, 1, 200, 50);
  const degraded = [];
  let rows = [];
  try {
    const r = await q(
      `SELECT id,task_key,checks,verified,claims,evidence_refs,created_at
       FROM workflow_verification WHERE project_id=$1 AND run_id=$2
       ORDER BY created_at DESC LIMIT $3`,
      [project_id, String(run_id), n],
    );
    rows = r?.rows ?? [];
  } catch (e) { degraded.push(`read: ${short(e?.message || e, 100)}`); }

  const items = rows.map((row) => {
    const rawClaims = Array.isArray(row.claims) ? row.claims : [];
    const safeClaims = rawClaims.slice(0, 50).map((c) => ({ flag: short(c?.flag ?? "UNSPECIFIED", 60) }));
    return {
      id: row.id, task_key: short(row.task_key, 120),
      verified: row.verified === true,
      checks: (Array.isArray(row.checks) ? row.checks : []).slice(0, 50)
        .map((c) => ({ name: short(c?.name ?? "", 120), pass: c?.pass === true })),
      claims: safeClaims,
      evidence_refs: (Array.isArray(row.evidence_refs) ? row.evidence_refs : []).slice(0, 20)
        .map((v) => short(core.redact(String(v)), 200)),
      created_at: row.created_at,
    };
  });

  return {
    ok: true,
    verified_count: items.filter((i) => i.verified).length,
    total: items.length,
    items, degraded,
    note: "Read-only aggregate. Unknown means insufficient evidence, not failure.",
  };
}

export default { validateTask, validateRun, assertNoOverclaim };
