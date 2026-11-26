# Database

The OpenCode Harness stores all structured state in PostgreSQL. Vector and full-text search are provided by two PostgreSQL extensions. This document describes the required components, the fresh-install migration path, isolation, and backup/restore. It is written for the **public release**, which ships **no development data dump** — a new install is created from SQL migrations only.

## Required components

| Component | Evidence | Purpose |
|---|---|---|
| PostgreSQL **17** | `docker-compose.yml` uses `pgvector/pgvector:pg17` | relational store for all memory/intelligence tables |
| `pgvector` | `CREATE EXTENSION IF NOT EXISTS vector` in `init/001-init.sql` | cosine similarity over 768-dim embeddings (`vector(768)`, HNSW index) |
| `pg_trgm` | `CREATE EXTENSION IF NOT EXISTS pg_trgm` in `init/001-init.sql` | trigram similarity for duplicate/near-duplicate detection |
| Optional: Ollama + `nomic-embed-text` (768 dims) | `docker-compose.yml` service `memory-embed` | local embeddings; no paid embedding API required |

Runtime dependencies in `engine/package.json`: `pg`, `@modelcontextprotocol/sdk`, `zod`. No AST parser is bundled.

## Docker topology (`docker-compose.yml`)

- Project name: `opencode-memory`.
- Service `memory-db` → container `opencode-memory-db`, image `pgvector/pgvector:pg17`, `restart: unless-stopped`.
  - Credentials come from `.env` via `env_file` and `${MEMORY_DB_USER}` / `${MEMORY_DB_PASSWORD}` / `${MEMORY_DB_NAME}` (values are never stored in the compose file).
  - Published on `127.0.0.1:${MEMORY_DB_PORT}:5432` — loopback only.
  - Volumes: `./data/postgres:/var/lib/postgresql/data` and `./init:/docker-entrypoint-initdb.d:ro`.
  - Healthcheck: `pg_isready -U ${MEMORY_DB_USER} -d ${MEMORY_DB_NAME}`.
- Service `memory-embed` → container `opencode-memory-embed`, image `ollama/ollama:latest`, loopback on `127.0.0.1:${MEMORY_EMBED_PORT}:11434`, volume `./data/ollama:/root/.ollama`.
- Both services share the bridge network `memory-net`.

Start / inspect (adjust the path to your own install location):

```powershell
docker compose -f <repo>/docker-compose.yml --project-directory <repo> up -d
docker compose -f <repo>/docker-compose.yml --project-directory <repo> ps
```

## Fresh-install migration path (001 → 026)

On a fresh PostgreSQL data volume, the official entrypoint executes every `*.sql` file under `/docker-entrypoint-initdb.d` in lexicographic order. The repository's `init/` directory is mounted there read-only, so a clean install applies migrations **001 through 026** automatically, in order. There is no shipped data dump and no manual seed step.

- `init/001-init.sql` is the base: creates the two extensions and the core tables (`memory`, `memory_history`, `session_index`, `import_state`, `audit_log`) plus full-text, GIN and HNSW indexes.
- Every later migration is **additive** — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, or constraint additions. No existing row, table, constraint, or index is removed or rewritten.
- `init/026-phase28-hardening.sql` is the latest: eight additive, reversible `project_id` indexes (`p28_agent_execution_project_idx`, `p28_agent_review_project_idx`, `p28_workflow_verification_project_idx`, `p28_workflow_dispatch_project_idx`, `p28_learning_runs_project_idx`, `p28_memory_retrieval_events_project_idx`, `p28_optimization_recommendations_project_idx`, `p28_learning_activity_project_idx`). Rollback is `DROP INDEX IF EXISTS p28_*`.
- Migration 014 (`lifecycle-restore`) is a `CREATE OR REPLACE FUNCTION` only; migrations 010, 012, 016 alter constraints/columns additively; none are destructive.

Because everything is `IF NOT EXISTS`, re-applying a migration is safe and idempotent. **Never perform a destructive reset** (no `DROP DATABASE`, `DROP SCHEMA`, or `TRUNCATE` against a real database). The system has **no migration-tracking table** — applied state is inferred from table/index presence. This is a documented residual risk, not a reason to force re-application.

## Real table categories

Table names below are taken directly from `init/*.sql` (001–026). This is a category map, not an exhaustive column reference.

| Category | Tables (selected, real names) | Introduced |
|---|---|---|
| Core memory & audit | `memory`, `memory_history`, `session_index`, `import_state`, `audit_log` | 001 |
| Patterns, consolidation & quality | `pattern`, `pattern_evidence`, `strategy_experiment`, `learning_activity`, `analysis_state`, `consolidation_suggestion`, `consolidation_run`, `pattern_feedback`, `session_raw_lines`, `strategy_observation` | 002–003 |
| Memory intelligence & retrieval | `memory_relationships`, `memory_contradictions`, `memory_quality_assessments`, `memory_retrieval_events`, `memory_usefulness_observations`, `coding_tasks`, `coding_attempts`, `coding_outcomes`, `strategy_versions`, `strategy_experiment_results`, `optimization_recommendations`, `optimization_actions`, `intelligence_audit_events` | 004 |
| LLM adapter & automation | `ai_analysis_cache`, `ai_task_queue`, `learning_runs`, `automation_events`, `harness_state` | 005–008 |
| Consolidation & self-improvement | `consolidation_rollback`, `self_improvement_report` | 009 |
| Semantic, errors & scope governance | `semantic_observation`, `fix_evidence`, `scope_review` | 011, 013 |
| Context & knowledge | `project_context`, `project_context_fact`, `technical_decision`, `knowledge_relationship`, `knowledge_quality`, `context_update` | 015 |
| Session understanding, lifecycle & learning | `session_understanding`, `dev_goal`, `dev_task`, `dev_experience`, `memory_lifecycle_event`, `memory_importance_signal`, `memory_freshness_review`, `memory_recovery_event`, `learning_record`, `learning_feedback`, `learning_pipeline_run` | 017–019 |
| Agent orchestration | `agent_plan`, `agent_execution`, `agent_context_ledger`, `agent_review` | 020 |
| Project intelligence | `project_assessment`, `project_finding`, `project_prediction`, `engineering_recommendation`, `project_analysis_state` | 021 |
| Controlled workflow | `workflow_approval`, `workflow_run`, `workflow_task`, `workflow_dispatch`, `workflow_verification`, `workflow_feedback` | 022 |
| Code intelligence | `code_index_state`, `code_source_file`, `code_symbol`, `code_relationship`, `code_test_map`, `code_analysis` | 023 |
| Project management | `pm_milestone`, `pm_progress_snapshot`, `pm_dependency`, `pm_blocker`, `pm_drift_finding`, `pm_continuity_snapshot`, `pm_ownership` | 024 |
| Adaptive intelligence | `ai_outcome_evaluation`, `ai_recommendation_evaluation`, `ai_prediction_evaluation`, `ai_decomposition_evaluation`, `ai_calibration_proposal` | 025 |

A fresh install produces 89 public tables (verified in the Phase 28 final report).

## Isolation

- Nearly every table carries a `project_id`; the memory layer also has `layer IN ('user','project','session','knowledge')` and a `_global` sentinel.
- Project-scoped operations reject `_global` and empty ids (`validProject`). Global visibility is explicit: `memory.global_eligible` plus verified user-fact approval (`012-phase138.sql`, `memoryScope.js`).
- All reads/writes filter by `project_id`; retrieval combines the requested project with explicitly eligible globals. Direct-ID access and relationship/version traversal require explicit authorization.
- The standard database is `opencode_memory`. An isolated database `opencode_memory_test` is used for tests and for verifying migrations first; select it by overriding `MEMORY_DB_NAME` in the process environment (see `docs/development/testing.md` and `docs/development/project-isolation.md`).

## Backup and restore procedure

Taken from `logs/phase28-operational-runbook.md` and `scripts/backup.ps1` / `scripts/restore.ps1`.

### Backup

```powershell
docker exec opencode-memory-db pg_dump -U <db-user> -d <db-name> > <backup>.sql 2> <backup>.err
```

- The scripted equivalent uses `pg_dump --no-owner --clean --if-exists` so dumps restore into a fresh database.
- Verify: backup file size > 0 and the `.err` file is empty.
- **Never delete earlier backups.** A pre-migration backup is taken before each additive migration.

### Restore — isolated only

1. Create a scratch database:
   `docker exec opencode-memory-db psql -U <db-user> -d postgres -c "CREATE DATABASE <scratch>"`
2. Load the dump into the scratch database:
   `Get-Content <backup>.sql -Raw | docker exec -i opencode-memory-db psql -U <db-user> -d <scratch> -v ON_ERROR_STOP=1`
3. Compare table count and representative record counts against production. Phase 28 verified an exact match for `memory`, `learning_record`, `dev_goal`, `workflow_verification`, and `ai_outcome_evaluation` (89 tables).
4. Drop **only** the scratch database you created:
   `docker exec opencode-memory-db psql -U <db-user> -d postgres -c "DROP DATABASE <scratch>"`

**Never restore over production.** The `scripts/restore.ps1` helper requires an explicit `-File` and `-Force` because it replaces current data; prefer the isolated procedure above.

## Environment variables

Database- and embedding-related variable **names** are listed in `docs/configuration.md`. That document contains names and safe placeholders only — no real credentials or values are published.

## Honest limitations

- No migration-tracking table; applied state is inferred from presence.
- Presence-only pipeline/wiring audits do not prove runtime correctness.
- "Conditionally ready for tested local scope" — a clean-install migration path is documented, but no fresh fresh-install from the public release has been certified beyond the local tested deployment.
