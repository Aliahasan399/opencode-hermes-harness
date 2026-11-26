# Public Release Audit — OpenCode Harness

Date: 2026-11-26. Read-only audit before publication. Phase 28 readiness reference: `logs/phase28-final-report.md`.

## 1. Git / publication state (verified)
- `E:\OpenCodeData\memory` is **not a Git repository** (`git rev-parse` → fatal, exit 128). No `.git`, no remotes, no branch.
- `gh` CLI 2.89.0 is available and authenticated to github.com as account `Aliahasan399`.
- **No repository URL, owner decision, or publication authorization has been given.** No remote will be created, no push will occur, and no license will be chosen on the owner's behalf.
- No `LICENSE` / `LICENSE.md` exists. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `.env.example` do not exist. `.gitignore` exists.

## 2. Available capabilities (verified from source + tests)
| Capability | Implementation | Status |
|---|---|---|
| Persistent project memory | `core.js`, `memoryScope.js`, `memoryLifecycle.js`, `contextRetrieval.js`, `contextRanker.js`, Phase 18 decision/relationship modules | implemented, tested |
| Session understanding & learning | `sessionUnderstanding.js`, `experienceStore.js`, `learningExperience.js`, `learningIntelligence.js`, `learningPipeline.js`, Phase 27 evaluation modules | implemented, tested |
| Controlled multi-agent engineering | `agentOrchestrator.js`, `taskDecomposition.js`, `agentCoordination.js`, `workflowApproval.js`, `workflowDispatcher.js`, `opencodeRunAdapter.js`, `workflowValidation.js`, Phase 25/26 modules | implemented; real dispatch requires explicit approval |
| Source intelligence | Phase 25 modules (heuristic, no AST parser) | implemented with documented confidence limits |
| Operational health / hardening | `operationalHealth.js`, migration 026 | implemented |
| Phase 28 readiness | `logs/phase28-final-report.md` | **Conditionally ready with documented limitations for the tested local deployment scope** |

## 3. Public interfaces (inventory)
- **CLI**: `engine/src/cli.js` flat if/else chain — memory, context, learning, agent/workflow, project (Phase 24–26), `code-*` (Phase 25), `adapt-*` (Phase 27), `ops-health` (Phase 28) commands.
- **MCP**: `engine/src/server.js` `s.tool(name, zod, wrap(fn))` — `memory_*`, `learning_*`, `project_*`, `workflow_*`, `code_*`, `pm_*`, `adapt_*`, `ops_health`, `agent_*`.
- **Engine API**: named exports from 111 `engine/src/*.js` modules (facades: `projectManagement.js`, `controlledWorkflow.js`, `codeIntelligence.js`, `adaptiveIntelligence.js`, `operationalHealth.js`).
- **DB**: migrations `init/001`–`026`; 89 production tables; project-scoped tables.

## 4. Required database components
PostgreSQL 17 + pgvector + pg_trgm (`docker-compose.yml`); engine depends on `pg`, `@modelcontextprotocol/sdk`, `zod`; optional local Ollama embeddings. Migration 001 is the base; 026 is latest additive. **A clean install requires a documented fresh migration path** — no development dump will be shipped.

## 5. Environment variables (names only — no values)
`OPTIMIZATION_LEVEL`, `HARNESS_SEMANTIC_LLM`, `HARNESS_LLM_*`, `HARNESS_OPENCODE_BIN`, `HARNESS_CONTEXT_BUDGET`, `HARNESS_END_COALESCE_MS`, `MEMORY_DB_*` (including **MEMORY_DB_PASSWORD**), `MEMORY_EMBED_*`, `MEMORY_RETRIEVAL_LIMIT`, `MEMORY_CLASSIFY_MODEL`, `MEMORY_CONFIDENCE_THRESHOLD`, `MEMORY_DASHBOARD_PORT`, `EXPERIMENT_MIN_SAMPLES`. Only a placeholder `.env.example` may be published.

## 6. External platform dependencies
OpenCode (primary host, v2.4.1 tested), MCP SDK clients (generic, experimental), Docker/PostgreSQL (optional but standard), Ollama (optional embeddings), Node.js (v26.5.0 tested).

## 7. Security restrictions to preserve
`LEVEL 1`, `HARNESS_SEMANTIC_LLM=0`, single-use approvals, project isolation, no source rewrite, no auto-approval, no unrestricted execution. Document, do not weaken.

## 8. Sensitive / non-portable files to EXCLUDE
- `.env` (real values, including DB password) — already in `.gitignore`; publish only `.env.example`.
- `backups/` (166 files, ~13.98 GB of DB dumps) — already ignored.
- `checkpoints/` (18 dirs containing source snapshots + phase docs with local Windows paths) — **must be added to `.gitignore`**.
- `logs/` (311 internal logs with local paths, session ids, raw outputs) — already ignored; publish only sanitized `logs/public-release/*`.
- `data/` (Docker volumes) — already ignored.
- `node_modules/`, `dist/`, `__pycache__/`, `.pytest_cache/` — ignore.
- `calc.py`, `test_add.py`, `test_multiply.py` (development scratch files) — exclude from public inventory.
- Internal reports containing local Windows paths or session IDs — publish sanitized versions only.
- No real credentials, tokens, connection strings, or personal paths in any public file.

## 9. Not portable without adapters
- `plugin/memory.ts` loader path `~/.config/opencode/plugins/memory.ts` (OpenCode-specific).
- `HARNESS_OPENCODE_BIN` Windows shim resolution in `opencodeRunAdapter.js`.
- Dashboard bound to local port; `MEMORY_DB_*` local Docker setup.
- Generic MCP clients can call tools but do **not** inherit OpenCode's autonomous capabilities — document explicitly.

## 10. Licensing
No license file exists. Per instructions, do not silently choose one. Prepare `LICENSE.decision.md` explaining MIT/Apache-2.0/private options and request the owner's decision before public release. Source visibility ≠ reuse permission.

## 11. Conclusion
Safe preparation work (docs, installer, adapters, governance templates, sanitized reports, tests, CI) can proceed. Git initialization, commits, and publication are **blocked** pending: repository URL/owner, license decision, and explicit publication authorization.
