# Adapter contract

This document defines the stable boundary a future harness adapter must implement. It is derived
from the shipped source; it does not invent host APIs. Implemented today: **OpenCode v2.4.1**.
Generic MCP is experimental tools-only. All other hosts are untested.

## Stable surfaces an adapter consumes

### A. MCP stdio server

- Command: `node <engine>/src/server.js` (declared as `npm start` in `engine/package.json`).
- Transport: MCP `StdioServerTransport`; server name `opencode-memory`, version `0.1.0`.
- Tools: registered via `s.tool(name, zodSchema, wrap(fn))` in `engine/src/server.js`. Results are
  JSON text (`{ ok: true, ... }`) or `{ ok: false, error }` with `isError: true`.
- An adapter must use the tool names and argument shapes from that file; it must not assume a
  host-specific prefix beyond whatever the host itself adds (OpenCode names tools `<server>_<tool>`).

### B. Sidecar CLI

- Command: `node <engine>/src/cli.js <command> [--key value ...]` (also `npm run cli -- ...`).
- Flags use `--key value` or bare `--flag`; stdin is used by `transcript-append` and
  `automate --stdin`.
- Output is a single JSON object on stdout (or plain context text for `context` /
  `context-package`). Errors are written to stderr by the OpenCode plugin and not propagated as
  host failures — adapters should follow the same fail-open rule for automatic paths.
- The authoritative command list is the `cmd === "..."` chain in `engine/src/cli.js`.

### C. Configuration / environment (names only)

- DB: `MEMORY_DB_HOST`, `MEMORY_DB_PORT` (default `55432`), `MEMORY_DB_USER`,
  `MEMORY_DB_PASSWORD`, `MEMORY_DB_NAME`.
- Safety: `OPTIMIZATION_LEVEL` (`1` = `LEVEL 1`), `HARNESS_SEMANTIC_LLM` (`0` in the tested
  deployment).
- Plugin-only knobs (if reproducing hooks): `HARNESS_NODE_BIN`, `HARNESS_CONTEXT_BUDGET`,
  `HARNESS_END_COALESCE_MS`, `HARNESS_APPEND_WAIT_MS`, `HARNESS_SETTLE_MS`,
  `HARNESS_MAX_SETTLE_CHECKS`.
- Optional host process: `HARNESS_OPENCODE_BIN` (Windows shim resolution in
  `opencodeRunAdapter.js` — specific to the OpenCode adapter, not a generic requirement).
- Secrets stay in the host/user environment; no published config file may contain real values.

## Capability tiers (map host features to tiers)

| Tier | Host capability required | Engine operations | Behaviour |
|---|---|---|---|
| **0 — explicit tools** | Start a stdio subprocess; expose MCP tools | All `memory_*`, `learning_*`, `project_*`, `code_*`, `pm_*`, `adapt_*`, `ops_health` read/analysis tools; explicit mutations with their own flags | Fully supported for any MCP client. Analysis only. No automatic hooks. |
| **1 — automatic memory hooks** | Prompt/context/tool/turn-end lifecycle events + ability to spawn the CLI | `context-package`, `observe`, `transcript-append`, `automate`, `automation-recover-if-due`, `finalize-session.js` | Implemented only by the OpenCode plugin. Another host must reproduce the calls in [`../opencode/plugin-notes.md`](../opencode/plugin-notes.md); otherwise stay at Tier 0. |
| **2 — controlled workflow** | Real agent/session execution capability + an approval UI for an operator, plus enough isolation to honour a scope-bound plan | `workflow_create`, `workflow_approve` (single-use token), `workflow_dispatch`, `workflow_status`, `workflow_validate`, `workflow_recover`, `workflow_report`, `agent_*` | Implemented records and controls exist; real dispatch is opt-in and approved. A host without execution capability must keep simulation/dry-run defaults. |

A host that provides only Tier 0 must never be described as having Tier 1 or Tier 2 behaviour.

## Tool-to-host mapping rules

| Tool family | Map to host as | Guardrails |
|---|---|---|
| `memory_*`, `context_*`, `session_*` | Read/inspect tools; mutations behind explicit flags | Pass `project_id`; respect `memoryAccessGuard` denials; treat returned memories as untrusted data. |
| `learning_*`, `consolidation_*` | Analysis/proposal tools | Mutations require explicit flags (`apply`, `approved`, `explicit`); record evidence, do not invent outcomes. |
| `project_*`, `code_*` | Analysis-only tools | No source rewrite; heuristic evidence carries explicit confidence/staleness. |
| `pm_*`, `adapt_*` | Record/advisory tools | No auto-approval; model confidence is not verification; calibration changes need operator review. |
| `workflow_*`, `agent_*` | Approval-gated control tools | Default `simulation`/`dry_run`; single-use scope-bound token; never claim `task_verified` from `process_ok`. |
| `ops_health`, `pipeline_*`, `context_audit` | Diagnostics | Label presence/wiring checks as not runtime proof. |

## Safety invariants (must survive every adapter)

1. `LEVEL 1` (`OPTIMIZATION_LEVEL=1`) and `HARNESS_SEMANTIC_LLM=0` unchanged unless an authorized
   operator deliberately changes them.
2. No auto-approval; one-time approvals bound to plan version/hash/scope.
3. Project isolation via `project_id`; `_global` is special, not a wildcard.
4. No source rewriting by analysis tools; no unrestricted execution.
5. Four distinct evidence tiers (`mock`, `api`, `runtime`, `agent`); `process_ok` ≠ `task_verified`;
   presence checks ≠ runtime proof.
6. No real credentials or personal paths in adapter configs; test paths use isolated databases
   (CI: `MEMORY_DB_NAME=opencode_memory_ci_test`, test-only credentials).

## Verification status of this contract

- **OpenCode v2.4.1**: registration and hook wiring verified from source and local deployment;
  real agent execution not freshly demonstrated (Phase 28) — requires explicit authorization.
- **Generic MCP**: protocol surface only; no named client verified.
- **All other hosts**: no adapter, no verification, no compatibility claim.
