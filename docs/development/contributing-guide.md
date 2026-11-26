# Contributing guide

This guide describes the actual repository layout and the rules that keep changes safe and honest. Read `docs/configuration.md`, `docs/database.md`, and `docs/security.md` before making substantial changes.

## Repository layout

| Path | Contents |
|---|---|
| `engine/src/` | ~111 JavaScript ES modules: facades (`projectManagement.js`, `controlledWorkflow.js`, `codeIntelligence.js`, `adaptiveIntelligence.js`, `operationalHealth.js`), plus `cli.js`, `server.js`, `core.js`, and all phase modules |
| `engine/init/` | SQL migrations `001-init.sql` … `026-phase28-hardening.sql`, applied in order on a fresh volume |
| `engine/test/` | Node test files (`*.test.js`) — one per phase/module, discovered by `node --test` |
| `engine/scripts/` | Evaluation helpers (`evaluate.mjs`, `step5-perf.mjs`) |
| `scripts/` | PowerShell operational helpers: `backup.ps1`, `restore.ps1`, `start-dashboard.ps1`, `configure-harness-llm.ps1`, phase E2E scripts |
| `plugin/memory.ts` | OpenCode plugin: prompt-time retrieval and turn-end learning via supported V2 hooks |
| `dashboard/server.js`, `dashboard/index.html` | Local, loopback-only dashboard (`MEMORY_DASHBOARD_PORT`) |
| `logs/` | Internal reports, run logs, and `logs/public-release/*` sanitized release artifacts |
| `docs/` | Public documentation (this directory); per-client adapters live in `docs/integrations/` |
| `docker-compose.yml` | PostgreSQL 17 + pgvector and optional Ollama services |

The working tree is **not a Git repository**. Do not run Git commands, create remotes, commit, or push on behalf of the owner; repository creation, licensing, and publication are blocked pending owner decisions (`logs/public-release/release-audit.md`).

## Safety invariants (never weaken)

- Keep `OPTIMIZATION_LEVEL=1` and `HARNESS_SEMANTIC_LLM=0` unchanged unless the operator explicitly authorizes a change.
- Real workflows require explicit single-use approval; never bypass, auto-approve, or infer completion from exit codes/agent claims.
- No source rewriting, no dependency upgrades, no destructive database operations, no unrestricted process execution.
- Preserve project isolation and secret redaction. Never commit real values, tokens, personal paths, session ids, backups, checkpoints, or raw logs.
- Publish only sanitized artifacts and placeholder `.env.example`.

## Development workflow

1. Read the relevant existing module and its test before editing. Follow the local naming and structure; do not introduce a competing engine.
2. Make **additive** changes. For SQL, use `IF NOT EXISTS` and apply to the isolated test database first (`docs/development/migrations.md`).
3. Add or update tests under `engine/test/`. Run against the isolated database: set `MEMORY_DB_NAME` to the test database and use `--test-concurrency=1` (`docs/development/testing.md`).
4. Wire new commands into `engine/src/cli.js` (flat `if/else` chain) and tools into `engine/src/server.js` (`s.tool(name, zod, wrap(fn))`), and extend `pipelineAudit` checks where appropriate (`docs/development/adding-tools.md`).
5. Update the relevant `docs/` page and keep evidence at its true tier. Presence-only wiring checks are not runtime verification.
6. Run the regression in chunks and classify anomalies honestly (`docs/development/regression.md`).

## Strict file ownership

Work is split into independent, non-overlapping units. When you are assigned files, write **only** those files. Do not run destructive DB operations, full suites against production, or modify files outside your ownership. The parent workstream owns checkpoints, schema migrations, CLI/MCP wiring, integration, end-to-end sessions, and the final regression/report.

## Further reading

- `docs/development/adding-tools.md` — CLI/MCP wiring and pipeline audit checks
- `docs/development/adding-adapters.md` — client/adapter boundaries
- `docs/development/testing.md` — running tests safely
- `docs/development/migrations.md` — additive schema changes
- `docs/development/project-isolation.md` — project scoping rules
- `docs/development/regression.md` — chunked regression and known anomalies
