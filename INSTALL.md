# Installation

This document describes how to install the OpenCode Harness next to an existing coding agent. It covers the installer's modes, its safety contract, what it writes, and how the database is set up.

> **Read first:** Conditionally ready with documented limitations for the tested local deployment scope. Real Harness-dispatched OpenCode agent execution was not demonstrated in Phase 28. See [README.md](README.md#readiness--stated-plainly).

## 1. Prerequisites

Install and verify these before running the bootstrap:

- **Node.js** — v26.5.0 was used during validation. The engine is an ESM package (`opencode-memory-engine` v0.1.0).
- **Docker + Docker Compose** — for PostgreSQL 17 + `pgvector` + `pg_trgm` and optional local Ollama embeddings. `docker-compose.yml` binds services to loopback ports derived from environment variables.
- **OpenCode** — v2.4.1 was the tested host. The V2 plugin hooks and MCP registration are OpenCode-specific; generic MCP clients work as tool clients but do not inherit the host's autonomous capabilities.
- **A project directory** to install into. The installer writes configuration and reports there.

No dependency installation or Git operation is performed by the installer.

## 2. Installer location and status

The installer lives in `installer/bootstrap/`. The shared helper `common.mjs` defines the command contract, capability aliases, config merging, backup logic, and redaction. The executable entrypoint `install.mjs` is present and was tested in dry-run, apply, re-apply, uninstall and DB-guard modes against isolated temporary directories (see `logs/public-release/installation-test-report.md`). Verification performed here was **isolated and used a stub engine**; no production database, service startup, plugin loading or real OpenCode/MCP registration was exercised.

The installer is Node ESM, cross-platform, and deliberately conservative:

- It **never reads environment variable values** — only variable *names* are inspected (for reporting).
- It **never runs Git** and **never installs dependencies**.
- It **never rewrites your source**.

## 3. Modes

Capabilities are `memory`, `learning`, and `agents`. The recommended default is **all three**.

| Mode | Invocation | Effect |
|---|---|---|
| **full / all three** | `--mode full` (default), `--mode all`, `--mode all-three`, or `--capabilities memory,learning,agents` | Register all three capability families. |
| **memory-only** | `--mode memory-only` or `--capabilities memory` | Persistent Project Memory only. |
| **memory + learning** | `--mode memory+learning` or `--capabilities memory,learning` | Memory and learning; no agent workflow wiring. |
| **agents** | `--mode agents` or `--capabilities agents` | Multi-agent engineering wiring only (still LEVEL 1, approval-gated). |
| **diagnostics-only** | `--doctor` or `--mode diagnostics` | Runtime diagnostics; no writes. |
| **validate** | `--validate` or `--mode validate` | Prerequisite checks; no writes. |
| **uninstall / disable** | `--uninstall --apply --yes` or `--mode uninstall` | Remove only the harness-managed configuration and managed block. |

You can also select an explicit subset with `--capabilities memory,learning` (comma-separated). Unknown capability names are rejected.

## 4. Safety contract (always in force)

Setup is **non-destructive by design**:

- **Plan first.** The default mode is `--dry-run`: it prints the plan and writes nothing.
- **Confirmation required.** `--apply` writes only with `--yes` or an interactive `yes` confirmation.
- **Idempotent.** Re-running produces no duplicate entries and reports "already present (no change)".
- **Backs up configuration.** Every existing file it modifies is copied to `.opencode-harness/backups/<timestamp>/` before being changed.
- **Never overwrites unrelated files.** Only harness-owned keys are merged into OpenCode config; existing unrelated keys are preserved. Conflicts (for example a differently-configured `opencode-memory` MCP server) are reported and left untouched.
- **Managed block only.** If `--inject-agents` is used, the harness appends a bounded `<!-- BEGIN/END opencode-harness managed -->` block to `AGENTS.md` and never edits outside those markers.
- **Guarded database path.** Migrations are manual by default. The optional additive migration path requires an isolated DB name, an existing verified backup, and `--confirm-db-name` repeated exactly; production-looking names are refused.

## 5. Bootstrap procedure

```powershell
cd E:\OpenCodeData\memory

# 1. Validate prerequisites (read-only)
node installer/bootstrap/install.mjs --target <project-dir> --validate

# 2. Preview the plan (read-only; this is the default)
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --dry-run

# 3. Apply after reviewing the plan
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --apply --yes

# 4. Diagnostics (read-only)
node installer/bootstrap/install.mjs --target <project-dir> --doctor

# 5. Disable / uninstall (removes only harness-managed entries)
node installer/bootstrap/install.mjs --target <project-dir> --uninstall --apply --yes
```

Useful options (from `common.mjs` help text):

- `--engine <dir>` — engine directory containing `src/cli.js` and `src/server.js` (default: discovered).
- `--opencode-config <file>` — config file to update (default: discovered project/global config).
- `--inject-agents` — append the managed block to an existing `AGENTS.md`.
- `--node-bin <path>` — Node binary recorded in MCP config (default: current Node).
- `--report-dir <dir>` — where setup reports are written (default: `<target>/docs`).
- `--json` — machine-readable output.
- `--db`, `--db-user`, `--migration`, `--db-backup`, `--confirm-db-name`, `--apply-db-migrations` — the guarded, opt-in additive migration path.

The installer discovers OpenCode config candidates (project `opencode.json`/`opencode.jsonc`, `.opencode/`, and the user config directory) and registers the MCP server under the name `opencode-memory`. It records state in `.opencode-harness/install-state.json`, writes a setup report under `docs/`, and creates `.env.example` with **names only** — no values.

## 6. Database setup

The database is **not** shipped as a development dump. A clean install uses the migration chain in `init/`:

- `init/001-init.sql` is the base; migrations through `init/026-phase28-hardening.sql` are additive.
- `docker-compose.yml` mounts `./init` into the database container's init directory, so a fresh volume applies them on first start.
- `pgvector` provides vector search; `pg_trgm` supports trigram similarity; the engine also uses PostgreSQL full-text search.

If you choose the optional explicit migration path, the installer requires a verified backup and an isolated database name, and refuses production-looking names. No migration tracking table exists — track applied migrations yourself.

Environment variable **names** used by the runtime include `MEMORY_DB_HOST`, `MEMORY_DB_PORT`, `MEMORY_DB_USER`, `MEMORY_DB_PASSWORD`, `MEMORY_DB_NAME`, `MEMORY_EMBED_URL`, `MEMORY_EMBED_MODEL`, `MEMORY_EMBED_DIMS`, `MEMORY_EMBED_PORT`, `MEMORY_DASHBOARD_PORT`, `OPTIMIZATION_LEVEL`, `HARNESS_SEMANTIC_LLM`, `HARNESS_OPENCODE_BIN`, `HARNESS_OPENCODE_DB`, `HARNESS_NODE_BIN`, `HARNESS_CONTEXT_BUDGET`, `HARNESS_END_COALESCE_MS`, `SQLITE3`, and the optional `HARNESS_LLM_*` adapter settings. Copy `.env.example` to `.env` and fill values locally; **never commit `.env`**. Some source defaults are Windows-specific paths and should be overridden with the matching environment variables.

## 7. Verification after install

```powershell
cd E:\OpenCodeData\memory\engine
npm test
node src/cli.js status
node src/cli.js ops-health
```

In OpenCode, check that the MCP server is connected (`opencode mcp list` reports `opencode-memory`) and call `memory_status` (expect `pgvector: true`). After engine or plugin changes, run `/reload` in OpenCode to refresh the tool catalog.

## 8. Publication status

The repository at `E:\OpenCodeData\memory` is **not a Git repository**. No repository URL, owner decision, license, or publication authorization has been provided. Git initialization, commits, and publication are blocked pending those decisions. Do not silently choose a license or push code.
