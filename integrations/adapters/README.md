# Harness adapters — boundary and status

An **adapter** is the thin mapping layer between a host's capabilities (tool registration,
lifecycle hooks, approval UI, process/session execution) and the engine's two stable surfaces:

- the **stdio MCP server** `engine/src/server.js`, and
- the **sidecar CLI** `engine/src/cli.js` (JSON on stdout, flags via `--key value`).

The engine itself has no competing runtime and no host-specific APIs. Everything host-specific
lives in an adapter. The precise mapping rules are in [`adapter-contract.md`](adapter-contract.md).

## Implementation status (honest)

| Adapter | Status | What is actually implemented / tested |
|---|---|---|
| **OpenCode v2.4.1** | **Implemented, tested** | MCP server registered under `mcp.servers` with `node src/server.js` (the package `start` script); plugin copied to `~/.config/opencode/plugins/memory.ts` wiring prompt/context/tool/turn-end hooks to CLI commands; approval-gated workflow tools. See [`../opencode/README.md`](../opencode/README.md). Real agent execution still requires explicit authorization and was not freshly demonstrated in Phase 28. |
| **Generic MCP** | **Experimental, not host-verified** | Any stdio MCP client can call the tools. No plugin hooks, no host capabilities granted. See [`../generic-mcp/README.md`](../generic-mcp/README.md). |
| **Other hosts (Cursor, Windsurf, Claude Code, IDEs, custom agents)** | **Not implemented, not tested** | No adapter exists. Do not claim compatibility. A future adapter would implement the contract in `adapter-contract.md`. |

## What an adapter is responsible for

1. **Process/config mapping** — start the server command from the host config, pass `MEMORY_DB_*`
   and safety env vars, set the working directory.
2. **Tool mapping** — expose MCP tools to the host's tool catalog (respecting any host prefix such
   as `<server>_<tool>`) and avoid fabricating tools the engine does not register.
3. **Hook mapping (optional)** — if the host exposes prompt/context/tool/turn-end lifecycle events,
   reproduce the OpenCode plugin's CLI calls; if it does not, degrade to explicit tool calls.
4. **Approval mapping (optional)** — present single-use, scope-bound Phase 24 approval requests to
   an operator; never auto-approve; keep `process_ok` and `task_verified` distinct.
5. **Safety mapping** — preserve `LEVEL 1`, `HARNESS_SEMANTIC_LLM=0`, project isolation, no source
   rewrite, and the evidence-tier labels.

Hosts that cannot provide hooks or approval UI are still useful at **Tier 0** (explicit read and
analysis tool calls); they must not be described as having autonomous agent capability.

## Non-goals

- No host is given powers it does not already have merely by connecting the MCP server.
- No adapter reimplements the engine's analysis, learning, or workflow logic in host code.
- No adapter writes to a production database from an installer or test path.

See [`adapter-contract.md`](adapter-contract.md) for the implementable contract.
