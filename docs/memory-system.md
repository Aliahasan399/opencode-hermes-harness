# Persistent Memory System

> Source of truth: `engine/src/*.js` (names below are verified exports). This document
> describes the implemented local engine only — it does not claim universal production
> readiness or capabilities that are not present in code. Example outputs are illustrative.

## One engine, not two

There is a **single** memory engine: `core.js`. Every other module — scopes, lifecycle,
retrieval, decisions, relationships, learning — is an **additive compositor** that calls
`core` (mostly `core.dbQuery`, `core.audit`, `core.redact`, `core.embed`). No phase added a
second memory store or a competing intelligence engine. The Phase 28 audit explicitly
records "no duplicated engine" and "no new intelligence engine" as acceptance criteria.

If you are extending the system, call the existing facades; do not stand up a parallel DB
or a parallel embedding path.

## Storage model

The primary table is `memory` (PostgreSQL). `core.js` projects these fields on every read:

```
id, layer, project_id, title, content, category, tags, source_session,
source_kind, confidence, importance, verified, created_at, updated_at,
valid_until, version, metadata, lifecycle, quality_score, useful_count,
provenance, global_eligible, quality_explanation
```

Companion tables used by the memory path:

- `memory_history` — previous content per `version` on every `updateMemory()`.
- `memory_lifecycle_event`, `memory_freshness_review`, `memory_importance_signal` — advisory lifecycle/importance/freshness records (migration 014).
- `memory_contradictions`, `knowledge_relationship` — explicit contradiction links and evidence-backed relationships (migration 015).
- `technical_decision` — decision records with evidence, status and supersession (migration 015).
- `session_index` — session ledger used by `sessionSearch()`, `listSessions()`, `sessionDetail()`.
- `audit_log` — content-free action records (`memory.update`, `memory.delete_soft`, `decision.record`, etc.).

Key implementation facts (verified):

- `saveMemory()` writes an **embedding vector** via pgvector when embeddings are available,
  and stores `source_kind` (default `observed`), `confidence`/`importance` (default `0.5`),
  `verified` (default `false`) and `provenance`.
- `provenance` is constrained to `production`, `test_fixture`, or `unknown`; anything else
  is coerced to `unknown`. Unknown provenance should be treated as untrusted evidence.
- Embeddings come from a **local** embeddings endpoint (`core.embed`, default Ollama
  `nomic-embed-text`, 768 dims). The call is fail-open with a 5-second cool-down: a transient
  timeout degrades semantic search but does not disable it for the rest of the process.
- `updateMemory()` bumps `version`, appends the previous content to `memory_history`,
  recomputes the embedding when content/title changes, and writes an audit entry.
- `deleteMemory(id, hard=false)` is a **soft delete** (`valid_until = now()`); `hard=true`
  deletes the row. Both are audited. Retrieval excludes rows whose `valid_until` has passed.
- `compactContext()` and retrieval use a bounded context budget (`maxContextChars: 6000`,
  `maxMemories: 8` in `config.budget`).

## Project scoping (isolation)

`memoryScope.js` is the isolation layer. A real project is any non-empty `project_id` that
is not the sentinel `_global` (`GLOBAL_PROJECT_ID = "_global"`).

- `scopeFilter({ project_id, allow_global, startIndex })` builds a SQL predicate that
  includes **only** the requested project plus globally-eligible rows. Other projects are
  never included. It is embedded into `listMemories()`, `searchMemory()` and retrieval.
- A `_global` row is visible across projects **only** when explicitly eligible:
  `global_eligible IS TRUE`, **or** (`source_kind='user'` AND `layer='user'` AND
  `verified IS TRUE` AND `metadata.global_approval === true`). See `GLOBAL_ELIGIBLE_SQL`
  and `isGloballyEligible()`. Nothing is auto-reclassified.
- `filterMemoryResults()` applies the same rules to already-fetched rows (returns a new
  array; never mutates input).
- `memoryAccessGuard({ tool, args, project_id })` gate-keeps MCP tool calls:
  - Retrieval tools (`memory_get`, `memory_list`, `memory_search`, `context_prepare`, …)
    **require an explicit project scope**; unscoped retrieval is denied by default.
  - Administrative/approved tools are allowed but flagged `audited_by_caller: true`.
- `globalMisclassificationReport()` is a **read-only** audit of `_global` rows that are not
  eligible. It performs no writes, deletes or reclassification.

Practical rule: always pass an explicit, real `project_id` on reads and writes. Omitting it
at the storage layer defaults new rows to `_global` (`core.saveMemory`), which is **not**
globally eligible and therefore not broadly visible.

## Context retrieval

`contextRetrieval.js` exposes `retrieveTaskContext()` (alias `retrieveContext`). It composes:

1. **Core hybrid retrieval** — `adaptiveRetrieve` over `core.searchMemory()`: full-text
   search (`ts_rank_cd` + `websearch_to_tsquery`) fused with vector search (cosine distance)
   via reciprocal-rank fusion (RRF). Results are capped (default 8, hard cap 30 for the
   composer, 20 for `searchMemory`).
2. **Project-context composer** — `prepareContext()` from `contextPackage.js`, best-effort
   and bounded to ≤1200 chars inside the composer.
3. **Optional capabilities** — `contextIntel`, `decisionIntel`, `relationshipIntel`,
   `knowledgeQuality`, loaded with dynamic import inside isolated `try/catch`. A missing or
   failing capability is reported in `degraded[]`; it does not break basic retrieval. If a
   caller injects its own retrieval adapter, the composer will **not** silently reach into
   the real DB for extra context.

Ranking and assembly (verified in `contextRetrieval.js`):

- Each item is normalized with `type`, `id`, `title`, `content`, `reason`, `project_id`,
  `verification`, `confidence`, `freshness_at`, `score`, `source`.
- Rows naming a different real project are dropped. This is an independent isolation check.
- `adjustedScore()` multiplies by a verification factor
  (`verified 1.25, observed 1, inferred .9, uncertain .75, stale .5, contradicted .3,
  superseded .2`), adds a small verification-rank signal, and applies a freshness
  adjustment (age >180d: −0.12; >30d: −0.06; fresh: +0.02). Verified/fresh items are
  preferred; contradicted/stale/superseded items are downweighted.
- Items are deduplicated by `(type, id)`, sorted by `final_score`, truncated to the limit,
  and assembled into a budget-aware block with a `[truncated to N chars]` marker.
- The return value includes `context`, `items`, `explanation`, `budget_used`, `degraded`
  and `project_id`. `explainSelection()` gives a deterministic explanation for one item.

> `contextRanker.js` holds the reusable scoring rules (`SCORING_RULES`, `defaultWeights`,
> `normalizeItem`, `conflictWarnings`, `rankAndFilter`) used by this path.

## Evidence and provenance

The system does not treat a bare assertion as proof. Evidence is attached at several levels:

- **Memory rows**: `source_session`, `source_kind`, `provenance`, `confidence`, `importance`,
  `verified`, and the full `memory_history` trail.
- **Decisions** (`decisionIntel.js`): `recordDecision()` stores `evidence`, `reasoning`,
  `alternatives`, `consequences`. Supersession **requires non-empty evidence** and is
  audited; same-title duplicates are reported and left untouched unless explicitly
  superseded. Old rows are archived, never deleted. `getDecisions()` does deterministic
  keyword-token matching (no LLM) and is project-scoped and bounded (≤10 for
  `decisionsForTask()`).
- **Relationships** (`relationshipIntel.js`): `validateRelationship()` rejects any link
  with empty `evidence` — "keyword-only" links are not stored. `createRelationship()` is
  idempotent via a UNIQUE constraint (`ON CONFLICT DO NOTHING`), never an overwrite.
  `getRelationships()`/`relatedContext()` are project-scoped and bounded (≤100).
- **Retrieved context**: each item carries a human-readable `reason`, `verification` and
  optional `source`, so callers can see *why* something was selected.

## Dedup

- `core.findDuplicate(title, content, project_id)` uses pg_trgm `similarity(content, …) > 0.86`
  within the project. The `memory_save` MCP tool calls it before saving and refuses a
  near-duplicate with `duplicate_of`.
- `experienceStore.js` uses deterministic token-overlap (Jaccard), **not** semantics:
  `SIMILARITY_THRESHOLD = 0.5` surfaces *candidate* duplicates;
  `CONSOLIDATE_SIMILARITY_THRESHOLD = 0.85` plus an identical normalized title is required
  to merge two rows. A same-title duplicate is never overwritten — prior values go into
  evidence history, evidence arrays are merged (identical strings deduped), and
  `verification_status` is promoted only on strictly stronger explicitly verified evidence.

## Contradictions

- `experienceStore.js` recognizes conflicts via **explicit markers only**:
  `^(contradicts?|negates?|refutes?|opposes?):` and
  `^status:\s*(stale|contradicted|outdated)\b`. Keyword overlap alone is never a conflict.
- `memoryConsolidation.js` provides `reviewContradictions()` (read-only, project-scoped),
  `recordContradiction()` (requires a description and evidence, refuses cross-project pairs
  and self-contradiction, de-duplicates by pair, defaults confidence to 0.5, never
  auto-resolves), and `findSimilarButUnrelated()` (flag for review, never merge).
- `contextRanker`/`contextRetrieval` downweight `contradicted`/`stale`/`superseded` items
  during retrieval.

## Lifecycle

`memoryLifecycle.js` is **advisory only** — LEVEL 1: it proposes and records; it never
auto-merges, auto-archives or deletes.

- `getLifecycleStatus({ project_id, memory_id })` is a read-only, project-scoped view of
  lifecycle state, recent events, freshness reviews and importance signals. Lifecycle state
  is DB-enforced (migration 014); importance/freshness are advisory and **separate from
  verification**.
- `runLifecycleMaintenance({ project_id, limit, dry_run=true, actor })` examines a bounded
  set of non-archived memories and records freshness verdicts, importance signals,
  consolidation proposals and contradiction counts. `dry_run` defaults to true; even with
  `dry_run:false` it performs **no destructive operation** — only advisory signals/reviews/
  proposals. Every sibling module failure is captured in `degraded[]`.
- `lifecycleMaintenanceStatus()` is a bounded read-only aggregate.
- Recovery helpers in `memoryRecovery.js` restore versions/archived rows only with explicit
  flags and actor/reason recorded in the audit log.

## Privacy and security

- **Redaction at write time**: `core.redact()` masks API keys, GitHub tokens, AWS keys,
  private-key blocks and `password|secret|token|api_key` assignments. `core.looksSensitive()`
  makes `saveMemory()`/`updateMemory()` **refuse** content that still looks like a credential.
  The same redactors are applied to retrieved text and audit details.
- **Project isolation**: enforced in SQL (`scopeFilter`), in post-filtering
  (`filterMemoryResults`) and in retrieval normalization. No code path queries another
  project's row by id or title.
- **Parameterized SQL**: user values are bound as parameters (`$1`, `$2`, …), never
  interpolated. The Phase 28 adversarial tests confirmed injection strings are stored as
  data and do not alter tables.
- **Bounded reads**: all list/search/report functions clamp `limit` (e.g. ≤200, ≤20 for
  search). This limits accidental bulk disclosure and runaway scans.
- **Audit trail**: content-free `audit_log` entries for writes, approvals, dispatches and
  validations. Audit writes are best-effort and never break the primary operation.

## Limitations (honest)

- This is a **local, single-deployment** engine (PostgreSQL 17 + pgvector + pg_trgm; optional
  local Ollama embeddings). A clean install needs a documented fresh migration path — no
  development data dump is shipped.
- Semantic/vector retrieval depends on a local embeddings service; when it is unavailable,
  retrieval degrades to full-text plus fail-open behavior, not to an error.
- Similarity is token-overlap/Jaccard and pg_trgm — **heuristic**, not true semantic
  understanding. No AST parser and no semantic LLM are used (`HARNESS_SEMANTIC_LLM=0`).
- "Conditionally ready with documented limitations" (Phase 28) applies to the tested local
  scope; passing tests alone do not establish universal production readiness.
- Presence-only audit checks are not runtime verification; real host execution requires
  explicit authorization (see `workflow-safety.md` and `multi-agent-orchestration.md`).
