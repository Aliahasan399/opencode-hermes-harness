# OpenCode integration (primary, supported)

This is the **only host integration that has been exercised end to end** for the OpenCode
Harness. It was tested against **OpenCode v2.4.1** on **Node.js v26.5.0**. Other hosts are
experimental or untested — see [`../generic-mcp/README.md`](../generic-mcp/README.md) and
[`../adapters/README.md`](../adapters/README.md).

> Honesty note: "supported" means the registration path below is real and was verified against
> the source and the local deployment. It does **not** mean a fresh real agent run was performed.
> The Phase 28 final report records that real OpenCode agent execution was **not** re-demonstrated
> and remains gated on explicit operator authorization. Presence/wiring checks are never presented
> as runtime proof.

## What is actually registered

There is **no competing runtime** in this project. The engine is a sidecar: a stdio MCP server,
a sidecar CLI, and (only on OpenCode) a hook-bearing plugin. All autonomous behaviour belongs to
the **OpenCode host**, not to the engine.

### 1. MCP server — via the package `start` script

`engine/package.json` declares:

```json
"scripts": {
  "start": "node src/server.js",
  "cli": "node src/cli.js",
  "test": "node --test test/*.test.js"
}
```

`engine/src/server.js` creates an `McpServer` named `opencode-memory` (version `0.1.0`) and
connects it over `StdioServerTransport`. Tools are registered with `s.tool(name, schema, wrap(fn))`.
OpenCode starts that command itself when you register it under `mcp.servers` in your
`opencode.json(c)`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "opencode-memory": {
        "type": "local",
        "command": ["node", "<ABSOLUTE_PATH_TO_ENGINE>/src/server.js"],
        "cwd": "<ABSOLUTE_PATH_TO_ENGINE>"
      }
    }
  }
}
```

On OpenCode **v2**, server names live under `mcp.servers` (not directly under `mcp`), and a local
server is a `type: "local"` command array. See [`config-template.json`](config-template.json) for a
fill-in template and [`install-guide.md`](install-guide.md) for the full sequence. If tools are
hidden behind Code Mode, set `"codemode": false` on the server entry to expose them directly.

Source for the config shape: <https://opencode.ai/docs/mcp-servers/> and
<https://opencode.ai/docs/config/>.

### 2. Plugin loader — `~/.config/opencode/plugins/memory.ts`

The repository file `plugin/memory.ts` is a default-exported OpenCode V2 plugin
(`{ id: "opencode-memory", setup }`). OpenCode auto-discovers direct `.ts`/`.js` files in the global
plugin directory `~/.config/opencode/plugins/` (and in a project's `.opencode/plugins/`); a file
beside a project-root `opencode.json` is **not** auto-discovered. See
<https://opencode.ai/docs/plugins/>.

The plugin is the automatic-memory layer: on each prompt it calls the CLI `context-package` and
injects a compact context block; on tool completion it records observations and appends to a
durable transcript; at turn end it calls the CLI `automate` pipeline. It **fails open** — errors are
logged, never surfaced as a host failure.

Important portability caveat: the shipped `plugin/memory.ts` contains **hard-coded Windows paths**
from the original author's machine (`E:\OpenCodeData\memory\...`) for the CLI, finalizer and log
directory. You **must** edit those constants for your own checkout before the plugin will work.
See [`plugin-notes.md`](plugin-notes.md).

### 3. CLI commands — `node src/cli.js ...`

The sidecar CLI (`engine/src/cli.js`, also `npm run cli -- ...`) is a flat command chain. Command
groups, matching the MCP tool categories:

| Group | Example commands |
|---|---|
| Core / transcript | `status`, `context`, `context-package`, `transcript-append`, `transcript-read` |
| Automation | `automate`, `automation-status`, `automation-retry`, `automation-recover`, `automation-recover-if-due`, `automation-recover-events` |
| Learning | `learn`, `learning-status`, `learning-run`, `learning-explain`, `learning-advice`, `learning-maintenance`, `learning-feedback`, `learning-patterns`, `learning-records`, `learning-pipeline-status` |
| Source intelligence | `code-index`, `code-status`, `code-search`, `code-symbol`, `code-relationships`, `code-graph`, `code-module`, `code-impact`, `code-freshness`, `code-tests`, `code-test-recommend`, `code-review`, `code-contracts`, `code-report` |
| Project / PM | `project-status`, `project-goals`, `project-milestones`, `project-progress`, `project-dependencies`, `project-blockers`, `project-briefing`, `project-drift`, `project-ownership`, `project-recovery`, `project-next-actions`, `project-report` |
| Agent / workflow | `agent-plan`, `agent-plan-status`, `agent-report`, `agent-resume`, `agent-discover`, `agent-claim`, `agent-complete`, `agent-fail`, `agent-context`, `agent-conflicts`, `agent-validate`, `agent-integrate`, `workflow-templates`, `workflow-create`, `workflow-approve`, `workflow-approvals`, `workflow-dispatch`, `workflow-status`, `workflow-validate`, `workflow-recover`, `workflow-test`, `workflow-feedback`, `workflow-report` |
| Adaptive | `adapt-outcome`, `adapt-recommendation`, `adapt-prediction`, `adapt-decomposition`, `adapt-agent`, `adapt-retrieval`, `adapt-failures`, `adapt-quality`, `adapt-propose`, `adapt-review-calibration`, `adapt-apply-calibration`, `adapt-rollback-calibration`, `adapt-proposals`, `adapt-report` |
| Diagnostics | `pipeline-map`, `pipeline-audit`, `pipeline-processing`, `pipeline-gaps`, `ops-health`, `llm-status`, `llm-usage`, `intelligence-report`, `consolidation-backlog`, `consolidation-coverage` |

Run `node src/cli.js status` as a smoke check; it prints health without side effects.

## Capability and authority boundary (read this before using workflow tools)

- **Real agent execution is not granted by installing this integration.** It requires (a) a host
  that actually exposes agent/session execution capabilities — OpenCode is the tested host — and
  (b) an **explicit Phase 24 approval**: a single-use, scope-bound approval token produced by
  `workflow_approve` and consumed by `workflow_dispatch`.
- Workflows default to **`mode: "simulation"`** and `dry_run: true`. Real dispatch is opt-in and
  must be approved by an operator for a specific plan hash/version/scope. There is no auto-approval.
- **`process_ok` never implies `task_verified`.** The engine keeps four evidence tiers distinct
  (`mock`, `api`, `runtime`, `agent`), and presence/wiring audits are explicitly labelled
  `verifiedBehavior: false` / `NO_RUNTIME_CLAIM`.
- Safety defaults observed in the tested deployment: `OPTIMIZATION_LEVEL=1` (`LEVEL 1`) and
  `HARNESS_SEMANTIC_LLM=0`. Preserve these unless you deliberately change them; do not weaken
  approval, project isolation, or the no-source-rewrite rule.
- Historical evidence at its true tier: a Phase 24 real process exited `process_ok:true` with
  `task_verified:false`; an agent reply of "OK" was **not** attributed to a Harness task. Phase 28
  demonstrated only the approval/simulation control paths via tests. No fresh real execution was
  demonstrated.

## Tool categories exposed over MCP

`memory_*`, `learning_*`, `project_*`, `workflow_*`, `code_*`, `pm_*`, `adapt_*`, `ops_health`,
plus `agent_*`, `automation_*`, `optimizer_*`, `session_*`, `context_*`, `consolidation_*`,
`error_*`, `scope_*`, `pipeline_*`, `data_quality_*`, `llm_*` and `worker_*`. The full inventory is
read directly from `engine/src/server.js`; see
[`../generic-mcp/README.md`](../generic-mcp/README.md#tool-categories) for a category summary.

## Environment variables (names only — no values)

`OPTIMIZATION_LEVEL`, `HARNESS_SEMANTIC_LLM`, `HARNESS_LLM_*`, `HARNESS_OPENCODE_BIN`,
`HARNESS_NODE_BIN`, `HARNESS_CONTEXT_BUDGET`, `HARNESS_END_COALESCE_MS`, `HARNESS_APPEND_WAIT_MS`,
`HARNESS_SETTLE_MS`, `HARNESS_MAX_SETTLE_CHECKS`, `MEMORY_DB_*` (including `MEMORY_DB_PASSWORD`),
`MEMORY_EMBED_*`, `MEMORY_RETRIEVAL_LIMIT`, `MEMORY_CLASSIFY_MODEL`,
`MEMORY_CONFIDENCE_THRESHOLD`, `MEMORY_DASHBOARD_PORT`, `EXPERIMENT_MIN_SAMPLES`.

Values live only in your untracked `.env`. Publish only a placeholder `.env.example`.

## Non-portable pieces to adapt

- `plugin/memory.ts` hard-coded `E:\OpenCodeData\memory\...` paths.
- `HARNESS_OPENCODE_BIN` Windows shim resolution in `opencodeRunAdapter.js`.
- Dashboard bound to a local port and `MEMORY_DB_*` local Docker setup (`docker-compose.yml`).
- An OpenCode v1 config puts servers directly under `mcp` and uses `enabled`; v2 uses
  `mcp.servers` and `disabled`. The template targets v2.4.1.

## Historical verification (from the source project)

- `opencode mcp list` → `opencode-memory connected`.
- `memory_status` → `pgvector: true`.
- Save → semantic search → update → version history → hard-delete round trip.
- 20 historical OpenCode sessions imported read-only.
- Reload the tool catalog with `/reload` in OpenCode after engine code changes.
