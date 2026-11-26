# Compatibility

This matrix is **evidence-based**: every row is tied to a source file, report, or test artifact in the repository. Absence of evidence is reported as "unverified", never as "supported". Overall readiness is stated at the end and must be preserved verbatim.

## Status definitions

- **Fully supported** — tested in the local deployment scope with recorded evidence.
- **Partial** — works with caveats or in a reduced form.
- **Experimental** — interface exists and basic access is verified, but autonomy/runtime behavior is not proven.
- **Not supported / unverified** — no evidence, or explicitly out of scope. Do not assume it works.

## Matrix

| Component | Version / platform | Status | Evidence |
|---|---|---|---|
| Node.js | **v26.5.0** | Fully supported (tested scope) | `logs/phase25-audit.md`, `logs/phase24-runtime-probe-one.txt`, and repeated `Node.js v26.5.0` in run logs |
| PostgreSQL | **17** with `pgvector` + `pg_trgm` | Fully supported (tested scope) | `docker-compose.yml` (`pgvector/pgvector:pg17`); extensions in `init/001-init.sql`; `memory_status` reported `pgvector: true` |
| OpenCode | **v2.4.1** | Fully supported (tested local scope) | `logs/phase28-audit-report.md` and `logs/phase28-final-report.md`: `opencode run --help` still exposes the flags used by the Phase 24 adapter; `opencode mcp list` → `opencode-memory connected` |
| Docker | Docker Desktop on Windows (WSL-backed) | Fully supported (tested scope) | `README.md` (Docker VM disk on `F:` via WSL junction); compose lifecycle and backup/restore executed in Phase 28 |
| Operating system | **Windows** | Fully supported (tested scope) | All test/deployment paths, PowerShell scripts (`scripts/*.ps1`), Windows-specific binary shim in `opencodeRunAdapter.js` |
| Operating system | **Linux** | Not verified | No Linux test artifacts; Windows-specific paths and shims are documented in `logs/public-release/release-audit.md` §9 |
| Operating system | **macOS** | Not verified | No macOS test artifacts; same portability caveats as Linux |
| Embeddings | Ollama + `nomic-embed-text` (768 dims) | Partial / optional | `docker-compose.yml`, `core.js`; optional local embeddings, no paid API. Other models/dims not verified |
| LLM adapter | `opencode-cli` transport via OpenCode provider/auth | Partial / optional | `HARNESS_LLM_ENABLED` + `HARNESS_SEMANTIC_LLM=0` defaults; on-demand `llm_test` only; real network calls were rate-limited/timed out in historical probes |
| Generic MCP SDK clients | stdio, zod-validated tools | Experimental | `engine/src/server.js` (`McpServer`, `StdioServerTransport`); tool access ≠ autonomous capability |
| Source intelligence | Heuristic extractor (no AST parser) | Partial | `logs/phase25-final-report.md`: no AST dependency added; explicit confidence/evidence; unsupported constructs stay `unknown`/unresolved |
| Controlled workflow execution | Real OpenCode agent dispatch | Experimental / not demonstrated | Phase 28 verified approval/simulation control paths via tests; fresh process/agent execution not demonstrated (`logs/phase28-final-report.md` §G) |
| Schema migration tracking | Migration-tracking table | Not supported | No tracking table exists; applied state inferred from table/index presence (`docs/database.md`) |

## Compatibility caveats

- The tested scope is a **single local Windows deployment**. Node v26.5.0, OpenCode v2.4.1, PostgreSQL 17, and Docker Desktop were exercised together there; no matrix across combinations of versions/platforms was run.
- Non-portable items that require adapters or local configuration: the OpenCode plugin loader path (`~/.config/opencode/plugins/memory.ts`), `HARNESS_OPENCODE_BIN` Windows shim resolution, the dashboard's loopback port binding, and the `MEMORY_DB_*` local Docker setup.
- Only the placeholder `.env.example` is published; real values are never part of compatibility claims. The operator supplies all credentials and paths (see `docs/configuration.md`).
- Do not infer support for a version from "close to" a tested version. Verify with the diagnostics in `docs/troubleshooting.md`.

## Readiness statement

Preserved verbatim from `logs/phase28-final-report.md` §J and `logs/public-release/release-audit.md`:

> **Conditionally ready with documented limitations for the tested local deployment scope.**

Conditions attached to that statement:

1. Real OpenCode runtime/agent execution remains unverified and requires explicit operator authorization.
2. Presence-only audit checks are not runtime verification.
3. Four inherited regression anomalies remain documented (`docs/development/regression.md`).
4. No migration-tracking table exists.

`Production-ready` is **not** claimed merely because tests pass.
