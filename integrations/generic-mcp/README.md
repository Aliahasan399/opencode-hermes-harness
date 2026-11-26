# Generic MCP client integration — EXPERIMENTAL

> **EXPERIMENTAL.** Any MCP client that speaks the standard stdio transport can start
> `node engine/src/server.js` and call its tools. That is **all** this integration provides.
> Tool access does **not** grant the same autonomous capabilities as the OpenCode integration.
> No host APIs are invented here: the engine exposes only its own MCP tools, its sidecar CLI, and
> PostgreSQL — nothing else.

The supported integration is [`../opencode/README.md`](../opencode/README.md). OpenCode v2.4.1 is
the **only** host that has been exercised end to end. No other MCP client has been verified against
this engine beyond the MCP protocol surface itself.

## What a generic client gets

- A stdio MCP server named `opencode-memory`, version `0.1.0`, from `engine/src/server.js`.
- The full registered tool catalog (see [Tool categories](#tool-categories)), all wrapped to return
  JSON text results with an `ok` flag and `isError` on failure.
- Access to the engine's PostgreSQL database (with `pgvector` / `pg_trgm`), **only if** the client
  supplies a reachable DB via `MEMORY_DB_*` environment variables.

## What a generic client does NOT get

- **No automatic prompt-time context injection.** That lives in the OpenCode plugin's `prompt` and
  `context` hooks, not in the MCP tools. A generic client must call `context_inject` /
  `context_prepare` itself if it wants context.
- **No automatic turn-end learning.** The plugin's `execute.after` / `session.idle` hooks drive
  `observe`, `transcript-append` and `automate`. A generic client must call those tools/CLI commands
  itself and is responsible for its own transcript durability.
- **No autonomous agent execution.** Workflow tools are planning/record tools. Real dispatch
  requires a supported host capability plus a single-use, scope-bound Phase 24 approval token.
  Installing/calling these tools never grants that authority.
- **No approval UI, no host lifecycle events, no shell/worktree capabilities** beyond what the
  client itself implements. Do not assume `opencode run` flags or plugin semantics exist anywhere
  but OpenCode.
- **No runtime proof from presence checks.** `pipeline_*` and `ops_health` reports distinguish
  wiring/presence from runtime behaviour; presence is not verification.

See [`limitations.md`](limitations.md) for the complete list.

## Required configuration

1. **Node.js** 20+ (tested 26.5.0) with `engine/node_modules` installed:
   `cd engine && npm install --no-audit --no-fund`.
2. **Environment** supplied to the server process (names only — values are yours, never in a
   published config):
   - `MEMORY_DB_HOST`, `MEMORY_DB_PORT` (default `55432`), `MEMORY_DB_USER`,
     `MEMORY_DB_PASSWORD`, `MEMORY_DB_NAME`.
   - Optional: `MEMORY_EMBED_*`, `HARNESS_SEMANTIC_LLM`, `OPTIMIZATION_LEVEL`.
3. **Database migrated** — migrations `init/001`–`026` must be applied to the target DB. Use an
   isolated database; never point a test client at production data. For CI this is the documented
   isolated var `MEMORY_DB_NAME=opencode_memory_ci_test`.
4. **Client MCP config** pointing at the server command. A minimal, vendor-neutral example is in
   [`config-example.json`](config-example.json). The exact key names differ per client; that file
   is an illustrative shape, not a verified integration with any named product.

Start the server manually only for debugging — it speaks MCP over stdin/stdout, so a terminal is a
poor client:

```powershell
node engine/src/server.js        # waits for MCP initialize on stdin
```

## Tool categories

Registered directly in `engine/src/server.js` (names are the tool IDs passed to `s.tool`):

| Category | Representative tools | Notes |
|---|---|---|
| `memory_*` | `memory_status`, `memory_search`, `memory_save`, `memory_get`, `memory_update`, `memory_delete`, `memory_semantic_search`, `memory_lifecycle`, `memory_quality_score`, `memory_retrieval_explain` | Core persistence, hybrid retrieval, lifecycle and quality. `memory_*` also spans `learning_*`, `session_*`, `context_*`, `consolidation_*`, `error_*`, `scope_*`, `pipeline_*`, `data_quality_*`, `llm_*`, `worker_*`, `optimizer_*`, `automation_*` sub-families in the same server. |
| `learning_*` | `learning_record_task`, `learning_record_outcome`, `learning_run_experiment`, `learning_status`, `learning_run`, `learning_feedback_record`, `learning_self_improvement_report` | Evidence-based experiments and learning pipeline; requires explicit flags for mutations. |
| `project_*` | `project_analyze`, `project_intelligence_report`, `project_engineering_tasks` | Project intelligence. Analysis/recommendations only; never applies changes. |
| `workflow_*` | `workflow_templates`, `workflow_create`, `workflow_approve`, `workflow_dispatch`, `workflow_status`, `workflow_validate`, `workflow_report` | Controlled workflow. Simulation by default; real dispatch needs a single-use approval token. `process_ok` ≠ `task_verified`. |
| `code_*` | `code_index`, `code_symbol_search`, `code_relationships`, `code_change_impact`, `code_test_map`, `code_review` | Source intelligence. Static/heuristic evidence (no AST parser), explicit confidence/staleness, no source rewriting. |
| `pm_*` | `pm_status`, `pm_goals`, `pm_milestones`, `pm_progress`, `pm_blockers`, `pm_next_actions`, `pm_report` | Long-term project management records. No auto-approval or dispatch. |
| `adapt_*` | `adapt_outcome_ingest`, `adapt_recommendation_evaluate`, `adapt_calibration_propose`, `adapt_calibration_apply`, `adapt_report` | Adaptive intelligence. Advisory proposals; model confidence is not verification. |
| `ops_health` | `ops_health` | Composed operational-health facade (DB runtime check + presence-only wiring checks). |
| `agent_*` | `agent_plan_create`, `agent_task_claim`, `agent_task_complete`, `agent_result_validate`, `agent_integrate` | Orchestration records. Requires real host execution capability; see authority boundary. |

This is a summary, not a substitute for reading `engine/src/server.js`; the exact schema for each
tool is its Zod definition there.

## Evidence tiers to preserve when calling these tools

- Wiring/presence checks (`pipeline_wiring_audit`, part of `ops_health`) are explicitly labelled
  **not runtime proof** (`verifiedBehavior: false` / `NO_RUNTIME_CLAIM`).
- `process_ok` (a process ran) is a different claim from `task_verified` (the task's postconditions
  passed). Report them separately.
- Do not describe mock or simulated dispatch as real host-agent execution.

## See also

- [`limitations.md`](limitations.md)
- [`../opencode/README.md`](../opencode/README.md) — the supported host integration.
- [`../adapters/README.md`](../adapters/README.md) — the boundary for future harness adapters.
