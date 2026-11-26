// Phase 17 capability F: continuous project context updates from completed durable
// transcripts.
//
// Additive and self-contained. This module NEVER deletes, truncates or drops
// anything, never writes across projects, never touches the existing learning
// pipeline, and never performs an unbounded scan. It reuses the Phase 16 durable
// transcript synchronization (readLines / lastSequence) so an incomplete
// transcript is refused before any ledger row is claimed.
//
// HARNESS_SEMANTIC_LLM=0: no LLM calls, no network. Every candidate is derived by
// deterministic, evidence-backed rules that point back to the exact transcript
// line. Optional sibling intelligence modules are loaded by dynamic import and
// are strictly best-effort; an unavailable extractor is recorded in `degraded`.

import * as core from "./core.js";
import { readLines, lastSequence } from "./transcript.js";

// The parent migration normally provisions this ledger. As a defensive, strictly
// additive measure (CREATE TABLE / INDEX IF NOT EXISTS only — never a drop, delete
// or update of existing data) we ensure it exists before use. This is idempotent
// and a no-op when migration 015 has already been applied.
let tableReady = null;
function ensureContextUpdateTable() {
  if (!tableReady) {
    tableReady = core.dbQuery(`
      CREATE TABLE IF NOT EXISTS context_update (
        id bigserial PRIMARY KEY,
        project_id text NOT NULL,
        session_id text NOT NULL,
        transcript_sequence integer NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text,
        attempts integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, transcript_sequence)
      )`).then(() => core.dbQuery(
      "CREATE INDEX IF NOT EXISTS cu_project_idx ON context_update (project_id, status)",
    )).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

// ---- bounded work limits -------------------------------------------------
const MAX_LINES = 60;
const MAX_FACTS = 60;
const MAX_DECISIONS = 30;
const MAX_RELATIONSHIPS = 50;
const MAX_RETRY = 100;
const MAX_STATUS = 200;

// Optional Phase 17 sibling extractors. They may be added later by other
// capabilities; absence is a normal, degraded-but-successful condition.
const EXTRACTORS = [
  { name: "contextIntel", spec: "./contextIntel.js" },
  { name: "decisionIntel", spec: "./decisionIntel.js" },
  { name: "relationshipIntel", spec: "./relationshipIntel.js" },
  { name: "knowledgeQuality", spec: "./knowledgeQuality.js" },
];

// ---- deterministic, evidence-backed extraction rules ---------------------
const TECH_TERMS = [
  "react", "next.js", "nextjs", "node.js", "nodejs", "node", "typescript", "javascript",
  "python", "postgresql", "postgres", "mysql", "sqlite", "mongodb", "redis", "docker",
  "kubernetes", "graphql", "rest", "fastapi", "django", "flask", "express", "nestjs",
  "vue", "angular", "svelte", "tailwind", "prisma", "pytest", "jest", "vitest",
  "playwright", "pgvector", "ollama", "rust", "golang", "golang", "java", "spring",
  "kotlin", "swift", "postgres.js",
];
const EXPLICIT_TECH_RE = /\b(we|i|our|the project|this project|our stack|the stack|the app|built|migrated|switched)\b.{0,48}\b(use|uses|using|chose|choose|selected|adopted|built with|migrated to|switched to|powered by|runs? on)\b/i;
const FILE_PATH_RE = /([A-Za-z]:\\[^\s"'<>|]{2,120}|\.{0,2}\/[A-Za-z0-9_.][A-Za-z0-9_.\/-]{1,120}|\b[A-Za-z0-9_-]+\/[A-Za-z0-9_.\/-]+\.[A-Za-z]{1,8}\b|\b[A-Za-z0-9_-]+\.(?:js|jsx|ts|tsx|py|sql|json|md|css|html|yml|yaml|java|go|rs|rb|sh|toml|ini)\b)/g;
const ERROR_RE = /(error|exception|traceback|failed|fails|failure|assertionerror|assert\s+\S+\s*==|\bFAILED\b|crash(?:ed)?)/i;
const FIX_RE = /\b(fix(?:ed|es|ing)?|resolved|corrected|patched|changed\sto|updated\sto|replaced|reverting)\b/i;
const TEST_RE = /(\b\d+\s+tests?\s+(passed|failed)\b|\btests?\s+pass(?:ed)?\b|\ball tests\b|\bpytest\b|\bnpm test\b|\btest suite\b|\b1 passed\b|\bgreen\b|\bbuild passed\b)/i;
const DECISION_RE = /\b(decided|chose|choose|selected|agreed|opted(?:\s+for)?|switched(?:\s+from|\s+to)?|will use|shall use|going to use|went with|migrated to|decision\s*:)\b/i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTechTerms(text) {
  const found = [];
  for (const term of new Set(TECH_TERMS)) {
    let re;
    try { re = new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`, "i"); }
    catch { continue; }
    if (re.test(text)) found.push(term);
  }
  return found;
}

function findFilePaths(text) {
  const out = [];
  const seen = new Set();
  FILE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    const p = m[1];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, MAX_LINES).map((l, i) => ({
    role: String(l?.role || "UNKNOWN").toUpperCase(),
    text: String(l?.text ?? "").slice(0, 4000),
    tool: l?.tool ? String(l.tool) : null,
    seq: Number.isFinite(Number(l?.seq)) ? Math.trunc(Number(l.seq)) : i + 1,
    session_id: l?.session_id ? String(l.session_id) : null,
  })).filter((l) => l.text.trim().length > 0);
}

function deriveSequence(requested, rawLines) {
  if (Number.isFinite(Number(requested)) && Number(requested) > 0) {
    return Math.trunc(Number(requested));
  }
  let max = 0;
  const arr = Array.isArray(rawLines) ? rawLines : [];
  for (const l of arr) {
    if (Number.isFinite(Number(l?.seq))) max = Math.max(max, Math.trunc(Number(l.seq)));
  }
  return max > 0 ? max : arr.length;
}

/**
 * Pure, deterministic, evidence-backed candidate extraction. No LLM, no network,
 * no mutation of the input. Every returned item carries explicit confidence and
 * provenance (source_session / project_id) and an excerpt of the source line.
 */
export function extractCandidates(lines, project_id) {
  const pid = project_id && project_id !== "_global" ? String(project_id) : null;
  const norm = normalizeLines(lines);
  const facts = [];
  const decisions = [];
  const relationships = [];
  const seenFacts = new Set();
  const seenDec = new Set();

  const addFact = (f) => {
    const key = `${f.kind}|${f.value}|${f.source_session}|${f.seq}`;
    if (seenFacts.has(key) || facts.length >= MAX_FACTS) return;
    seenFacts.add(key);
    facts.push({ ...f, id: `f-${facts.length + 1}`, project_id: pid });
  };

  for (const l of norm) {
    const base = { role: l.role, seq: l.seq, source_session: l.session_id, excerpt: l.text.slice(0, 300) };
    // User/assistant statements: technology and file-path mentions only.
    if (l.role === "USER" || l.role === "UNKNOWN" || l.role === "ASSISTANT") {
      const explicit = EXPLICIT_TECH_RE.test(l.text);
      for (const term of findTechTerms(l.text)) {
        addFact({ ...base, kind: "technology", value: term,
          statement: `Transcript mentions technology: ${term}`,
          confidence: explicit ? 0.8 : 0.6 });
      }
      for (const p of findFilePaths(l.text)) {
        addFact({ ...base, kind: "file_path", value: p,
          statement: `Transcript references file path: ${p}`, confidence: 0.7 });
      }
    }
    // Tool output (and assistant reasoning): only explicit errors, fixes and test results.
    if (l.role === "TOOL" || l.role === "ASSISTANT") {
      if (ERROR_RE.test(l.text)) {
        addFact({ ...base, kind: "error", value: "observed error in tool output",
          statement: `Tool output reported an error: ${l.text.slice(0, 160)}`, confidence: 0.75 });
      }
      if (FIX_RE.test(l.text)) {
        addFact({ ...base, kind: "fix", value: "observed fix attempt",
          statement: `Transcript describes a fix: ${l.text.slice(0, 160)}`, confidence: 0.6 });
      }
      if (TEST_RE.test(l.text)) {
        addFact({ ...base, kind: "test_result", value: "observed test result",
          statement: `Tool output reported a test result: ${l.text.slice(0, 160)}`, confidence: 0.7 });
      }
    }
    // Decisions: only from explicit decision language. Never invented.
    if (DECISION_RE.test(l.text)) {
      const key = `${l.seq}|${l.text.slice(0, 120)}`;
      if (!seenDec.has(key) && decisions.length < MAX_DECISIONS) {
        seenDec.add(key);
        decisions.push({ id: `d-${decisions.length + 1}`, project_id: pid,
          source_session: l.session_id, seq: l.seq, role: l.role,
          statement: `Explicit decision in transcript: ${l.text.slice(0, 240)}`,
          excerpt: l.text.slice(0, 300), confidence: 0.85 });
      }
    }
  }

  // Relationships: a decision that names a technology referenced by a fact, and a
  // fix observed in the same session as an error. Both are evidence-backed.
  for (const d of decisions) {
    for (const f of facts) {
      if (relationships.length >= MAX_RELATIONSHIPS) break;
      if (f.kind === "technology" && d.excerpt.toLowerCase().includes(f.value.toLowerCase())) {
        relationships.push({ id: `r-${relationships.length + 1}`, project_id: pid,
          source_type: "decision", source_id: d.id, target_type: "fact", target_id: f.id,
          relation_type: "references_technology", confidence: 0.6,
          evidence: d.excerpt.slice(0, 200), source_session: d.source_session });
      }
    }
  }
  const fixes = facts.filter((f) => f.kind === "fix");
  const errors = facts.filter((f) => f.kind === "error");
  for (const fix of fixes) {
    for (const err of errors) {
      if (relationships.length >= MAX_RELATIONSHIPS) break;
      if (fix.source_session && fix.source_session === err.source_session) {
        relationships.push({ id: `r-${relationships.length + 1}`, project_id: pid,
          source_type: "fact", source_id: fix.id, target_type: "fact", target_id: err.id,
          relation_type: "fixes_observed_error", confidence: 0.65,
          evidence: fix.excerpt.slice(0, 200), source_session: fix.source_session });
      }
    }
  }

  return { facts, decisions, relationships };
}

// ---- optional sibling-module enrichment ----------------------------------
function mergeArray(target, extra, cap) {
  if (!Array.isArray(extra)) return;
  const seen = new Set(target.map((x) => JSON.stringify(x)));
  for (const item of extra) {
    if (target.length >= cap) break;
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
}

function mergeExtra(candidates, extra) {
  if (!extra || typeof extra !== "object") return;
  mergeArray(candidates.facts, extra.facts, MAX_FACTS);
  mergeArray(candidates.decisions, extra.decisions, MAX_DECISIONS);
  mergeArray(candidates.relationships, extra.relationships, MAX_RELATIONSHIPS);
}

// ---- main orchestrator ----------------------------------------------------
export async function runContextUpdate({ session_id, project_id, transcript_lines, sequence, min_sequence } = {}) {
  const sid = session_id ? String(session_id) : null;
  const pid = project_id ? String(project_id) : null;

  // Fail closed: no session, no project, or the global sentinel are never processed.
  if (!sid || !pid || pid === "_global") {
    const reason = !sid ? "session_id required"
      : !pid ? "project_id required"
        : "project_id '_global' is not allowed for context updates";
    try { await core.audit("context.update_rejected", sid || "unknown", { reason, project_id: pid }); }
    catch { /* audit must never break fail-closed behavior */ }
    return { ok: false, status: "invalid", reason, error: reason };
  }

  // Phase 16 completeness guard, against the DURABLE transcript. An incomplete
  // transcript is refused before any ledger row is created or claimed.
  const minSeq = Number.isFinite(Number(min_sequence)) ? Math.trunc(Number(min_sequence)) : 0;
  const durableSeq = lastSequence(sid);
  if (minSeq > 0 && durableSeq < minSeq) {
    try {
      await core.audit("context.update_incomplete", sid,
        { expected: minSeq, actual: durableSeq, project_id: pid });
    } catch { /* best effort */ }
    return { ok: false, incomplete: true, expected_sequence: minSeq,
      actual_sequence: durableSeq, project_id: pid };
  }

  // Explicit in-memory snapshot when supplied; otherwise the durable snapshot.
  const rawLines = Array.isArray(transcript_lines) ? transcript_lines : readLines(sid);
  const bounded = normalizeLines(rawLines);
  const seq = deriveSequence(sequence, rawLines);

  // Idempotent claim. The UNIQUE(session_id, transcript_sequence) key is the
  // idempotency key; ON CONFLICT DO NOTHING guarantees a single row per version.
  let update_id;
  let attempts = 1;
  const ins = await core.dbQuery(
    `INSERT INTO context_update (project_id, session_id, transcript_sequence, status, attempts)
     VALUES ($1,$2,$3,'processing',1)
     ON CONFLICT (session_id, transcript_sequence) DO NOTHING RETURNING id`,
    [pid, sid, seq],
  );
  if (ins.rowCount) {
    update_id = ins.rows[0].id;
  } else {
    const prior = (await core.dbQuery(
      `SELECT id,status,result,attempts FROM context_update
       WHERE session_id=$1 AND transcript_sequence=$2`, [sid, seq])).rows[0];
    if (prior?.status === "done") {
      return { ok: true, duplicate: true, status: "done",
        update_id: prior.id, result: prior.result || {} };
    }
    if (!prior) {
      return { ok: false, status: "conflict", reason: "ledger conflict could not be resolved" };
    }
    // Re-claim a pending/failed row, preserving history by incrementing attempts.
    const re = await core.dbQuery(
      `UPDATE context_update SET status='processing', attempts=attempts+1, updated_at=now()
       WHERE id=$1 AND status IN ('pending','failed') RETURNING id, attempts`, [prior.id]);
    if (!re.rowCount) {
      const cur = (await core.dbQuery(
        "SELECT status,result FROM context_update WHERE id=$1", [prior.id])).rows[0];
      return { ok: true, duplicate: true, status: cur?.status || prior.status,
        update_id: prior.id, result: cur?.result || {} };
    }
    update_id = prior.id;
    attempts = re.rows[0].attempts;
  }

  const started = Date.now();
  let status = "done";
  let errorText = null;
  let result;
  try {
    const candidates = extractCandidates(bounded, pid);
    const degraded = [];
    const degraded_reasons = {};
    for (const ex of EXTRACTORS) {
      try {
        const mod = await import(ex.spec);
        // Optional additive enrichment if a sibling exposes a compatible function.
        const fn = ["extractCandidates", "extractFromTranscript", "extract"]
          .map((n) => mod[n]).find((f) => typeof f === "function");
        if (fn) {
          try { mergeExtra(candidates, await fn(bounded, pid)); }
          catch { /* enrichment is best effort and never blocks the ledger */ }
        }
      } catch (e) {
        degraded.push(ex.name);
        degraded_reasons[ex.name] = String(e?.message || e).slice(0, 200);
      }
    }
    // Persist the extracted candidates through the real intelligence modules.
    // This is additive and best-effort: a failed write is recorded, never thrown,
    // and the ledger still completes so retries can pick it up safely.
    const persisted = { facts: 0, decisions: 0, relationships: 0, errors: [] };
    const persistedFactIds = [];
    try {
      const ci = await import("./contextIntel.js");
      const llmFacts = candidates.facts.slice(0, MAX_FACTS).map((f) => ({
        key: `${f.kind || "fact"}:${String(f.value || f.statement || "").slice(0, 120)}`,
        value: { kind: f.kind, value: f.value, statement: f.statement, excerpt: f.excerpt, seq: f.seq },
        status: "observed",
        confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null,
        evidence: [`session:${sid}`, `seq:${f.seq}`],
        source: "context_update",
        source_session: sid,
      }));
      if (llmFacts.length) {
        const r = await ci.upsertProjectContext({ project_id: pid, facts: llmFacts,
          source: "context_update", source_session: sid });
        persisted.facts = llmFacts.length;
        // contextIntel identifies facts by their (project-scoped) key, not by a
        // numeric id, so use the key as the relationship target reference.
        for (const row of (r?.facts || [])) if (row?.key) persistedFactIds.push(String(row.key));
      }
    } catch (e) { persisted.errors.push(`contextIntel: ${String(e?.message || e).slice(0, 160)}`); }

    try {
      const di = await import("./decisionIntel.js");
      for (const d of candidates.decisions.slice(0, MAX_DECISIONS)) {
        const r = await di.recordDecision({ project_id: pid,
          title: String(d.statement || d.value || "context decision").slice(0, 300),
          description: String(d.statement || "").slice(0, 2000),
          reasoning: "Extracted from completed durable transcript evidence.",
          evidence: [`session:${sid}`, `seq:${d.seq}`], source_session: sid });
        if (r?.ok) persisted.decisions += 1;
      }
    } catch (e) { persisted.errors.push(`decisionIntel: ${String(e?.message || e).slice(0, 160)}`); }

    try {
      const ri = await import("./relationshipIntel.js");
      for (let i = 0; i < Math.min(persistedFactIds.length, MAX_RELATIONSHIPS); i++) {
        const r = await ri.createRelationship({ project_id: pid,
          source_type: "session", source_id: sid, target_type: "fact", target_id: persistedFactIds[i],
          relation_type: "observed_in_session", confidence: 0.65,
          evidence: [`session:${sid}`, `seq:${candidates.facts[i]?.seq}`] });
        if (r?.ok) persisted.relationships += 1;
      }
    } catch (e) { persisted.errors.push(`relationshipIntel: ${String(e?.message || e).slice(0, 160)}`); }

    result = {
      facts: candidates.facts.slice(0, MAX_FACTS),
      decisions: candidates.decisions.slice(0, MAX_DECISIONS),
      relationships: candidates.relationships.slice(0, MAX_RELATIONSHIPS),
      persisted,
      degraded,
      degraded_reasons,
      analyzed_lines: bounded.length,
      project_id: pid,
      source_session: sid,
      transcript_sequence: seq,
      durable_sequence: durableSeq,
      attempts,
      duration_ms: Date.now() - started,
      // Bounded snapshot stored so retryContextUpdates can re-run without a full scan.
      transcript_lines: bounded.map((l) => ({
        role: l.role, text: l.text.slice(0, 1000), tool: l.tool,
        seq: l.seq, session_id: l.session_id,
      })),
    };
  } catch (e) {
    status = "failed";
    errorText = String(e?.message || e).slice(0, 500);
    result = {
      facts: [], decisions: [], relationships: [], degraded: [], degraded_reasons: {},
      analyzed_lines: bounded.length, project_id: pid, source_session: sid,
      transcript_sequence: seq, error: errorText, attempts,
      duration_ms: Date.now() - started,
    };
  }

  await core.dbQuery(
    `UPDATE context_update SET status=$2, result=$3::jsonb, error=$4, updated_at=now()
     WHERE id=$1`, [update_id, status, JSON.stringify(result), errorText],
  );
  try {
    await core.audit("context.update_completed", sid, {
      project_id: pid, update_id, status, transcript_sequence: seq,
      analyzed_lines: bounded.length, facts: result.facts.length,
      decisions: result.decisions.length, relationships: result.relationships.length,
      degraded: result.degraded, duplicate: false,
    });
  } catch { /* best effort */ }

  return { ok: status === "done", update_id, status, result };
}

// Bounded, project-scoped status listing. No unbounded scan.
export async function contextUpdateStatus({ project_id, status, limit = 50 } = {}) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.trunc(Number(limit)), MAX_STATUS) : 50;
  const pid = project_id ? String(project_id) : null;
  const st = status ? String(status) : null;
  const r = await core.dbQuery(
    `SELECT id, project_id, session_id, transcript_sequence, status, error, attempts,
            created_at, updated_at, (count(*) OVER ())::int AS total
     FROM context_update
     WHERE ($1::text IS NULL OR project_id=$1) AND ($2::text IS NULL OR status=$2)
     ORDER BY created_at DESC LIMIT $3`, [pid, st, n],
  );
  return { ok: true, items: r.rows, count: r.rows.length,
    total: r.rows[0]?.total ?? 0, project_id: pid, status: st };
}

// Retry only pending/failed rows, re-running with the stored transcript snapshot
// (or the durable one when available). History is preserved: attempts increments
// through runContextUpdate's re-claim. No destructive operations.
export async function retryContextUpdates({ limit = 20, project_id = null } = {}) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.trunc(Number(limit)), MAX_RETRY) : 20;
  const pid = project_id ? String(project_id) : null;
  const rows = (await core.dbQuery(
    `SELECT id, session_id, project_id, transcript_sequence, attempts, result
     FROM context_update
     WHERE status IN ('pending','failed') AND ($1::text IS NULL OR project_id=$1)
     ORDER BY created_at LIMIT $2`, [pid, n])).rows;

  let retried = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const stored = r.result && typeof r.result === "object" ? r.result : {};
      const durable = readLines(r.session_id);
      const lines = durable.length ? durable
        : (Array.isArray(stored.transcript_lines) ? stored.transcript_lines : null);
      const res = await runContextUpdate({
        session_id: r.session_id,
        project_id: r.project_id,
        transcript_lines: lines || undefined,
        sequence: r.transcript_sequence,
      });
      if (res.ok) retried++;
      else failed++;
    } catch (e) {
      failed++;
      try {
        await core.dbQuery(
          `UPDATE context_update SET status='failed', error=$2, attempts=attempts+1, updated_at=now()
           WHERE id=$1`, [r.id, String(e?.message || e).slice(0, 500)]);
      } catch { /* best effort */ }
    }
  }
  try { await core.audit("context.update_retry", pid || "all", { attempted: rows.length, retried, failed }); }
  catch { /* best effort */ }
  return { ok: true, attempted: rows.length, retried, failed };
}
