# FAQ

Honest answers about what the OpenCode Harness does and does not do.

## Is this production-ready?

Conditionally ready with documented limitations for the tested local deployment scope. Functional, security, integrity, isolation, recovery, and regression evidence supports operational use in that scope, but "production-ready" is not claimed merely because tests pass. Conditions include:

- Real OpenCode runtime and Harness-dispatched agent execution remain unverified and require explicit operator authorization. **Real Harness-dispatched agent execution was not demonstrated in Phase 28.**
- Presence-only wiring audits are not runtime verification.
- Four inherited regression anomalies remain documented (semantic duplicate push-out from bounded test data, two concurrent-write count fluctuations, and a lingering process handle in one legacy test file).
- No migration tracking table exists.

## Does it replace or equal Hermes?

No. These are **Hermes-inspired capabilities for existing AI coding-agent harnesses**. The host agent remains the execution environment; the Harness extends it, does not replace it, and does not modify the agent's source, security policy, or system prompt.

## Can it run agents by itself?

It can **plan, coordinate, supply context, validate, and learn** about multi-agent work, but execution is handed to the host agent's supported interfaces (for example OpenCode's `run`/subagent capabilities). Nothing is dispatched without an explicit, single-use approval bound to the project, plan id/version/hash, scope, mode, and risk. `workflow-dispatch` defaults to `dry-run: true`, and `process_ok` never implies `task_verified`. Generic MCP clients can call the tools but do not inherit the host agent's autonomous capabilities.

## Is approval ever automatic? Can I turn it off?

No. There is no auto-approval. Approvals are single-use, replay- and rebinding-resistant, and consumed atomically. Autonomy stays at LEVEL 1 (`OPTIMIZATION_LEVEL=1`) and semantic LLM interpretation is off (`HARNESS_SEMANTIC_LLM=0`) by default. Raising autonomy or enabling model-backed interpretation is an explicit operator decision, not a side effect of using the tools.

## Is my data shared with other projects or the internet?

No. Memories, experiences, and workflows are project-scoped; query filters and MCP access guards enforce isolation. Global memory reuse requires explicit eligibility. The system syncs nothing externally and keeps no shared memory with other agents. Optional LLM transport uses the host agent's own provider/auth path or a user-configured adapter; no credential is stored in code, logs, the database, or the dashboard.

## Does it parse my source code with an AST?

No. The source-intelligence layer uses a bounded, deterministic heuristic extractor that records explicit confidence, evidence, and extraction method. Unsupported constructs remain unknown/unresolved. There is **no AST parser** and no added parsing dependency.

## Are retrieved memories trustworthy instructions?

No. Retrieved memories and past transcripts are treated as **untrusted historical reference data**, never as instructions. They are wrapped in an untrusted-data banner, budgeted, and cannot override your current request, grant authority, approve a workflow, change a safety setting, or execute code/SQL. Secrets are redacted before storage; injection strings are bound as query data; filesystem paths are containment-checked.

## Can I export or back up the data?

Yes. Backup scripts (`scripts/backup.ps1`, `scripts/restore.ps1`) produce SQL dumps; an isolated restore was demonstrated in Phase 28 with record counts matching the source. Deletion is soft by default. Migrations are additive. There is no migration tracking table, so record which migrations you have applied.

## Which platforms are supported?

OpenCode is the primary tested host (v2.4.1). Node.js v26.5.0 and PostgreSQL 17 + pgvector + pg_trgm were used in testing; Docker Compose is provided; local Ollama embeddings are optional. Some source defaults are Windows-specific paths and must be overridden with environment variables (`HARNESS_OPENCODE_DB`, `SQLITE3`, `HARNESS_OPENCODE_BIN`). The plugin loader path `~/.config/opencode/plugins/memory.ts` is OpenCode-specific.

## How do I install or remove it?

Use `installer/bootstrap/`. It plans first, requires confirmation, supports `--dry-run`, is idempotent, backs up files it modifies, and never overwrites unrelated config. Diagnostics use `--doctor`; removal uses `--uninstall --apply --yes` and only removes harness-managed entries. See [INSTALL.md](../INSTALL.md).

## Is the repository published?

No. The repository at `E:\OpenCodeData\memory` is not a Git repository, and no license, owner, repository URL, or publication authorization has been decided. Git initialization, commits, and publication are blocked pending those decisions. Source visibility is not reuse permission.
