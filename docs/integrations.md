# Integrations

The Harness is designed around one primary host — **OpenCode** — and exposes a generic MCP surface for other clients. Support levels below are evidence-based and deliberately conservative.

## Support matrix

| Client / surface | Level | Evidence |
|---|---|---|
| OpenCode v2.4.1 | **Fully supported** (tested local scope) | Phase 28 audit: `opencode run --help` still exposes `--agent`, `--model`, `--session`, `--continue`, `--fork`, `--worktree`, `--format`, `--title`; `opencode mcp list` reported `opencode-memory connected` |
| Generic MCP SDK clients | **Experimental** | `engine/src/server.js` uses `McpServer` + `StdioServerTransport` with zod-validated `s.tool(...)` handlers; tool access is verified, autonomous behavior is not |
| Other agent harnesses | **Not tested** | No compatibility evidence exists; do not assume parity with OpenCode |

## OpenCode (primary, fully supported)

- Automatic behavior is implemented only through supported V2 plugin hooks. The plugin loader is at `~/.config/opencode/plugins/memory.ts` and loads `plugin/memory.ts`; it provides automatic retrieval on prompt and learning on turn end.
- MCP registration is a local entry of type `local` whose command runs `node <repo>/engine/src/server.js` (startup timeout configured in the host's MCP config). After engine code changes, run `/reload` in OpenCode to refresh the tool catalog.
- The engine exposes the tool families `memory_*`, `learning_*`, `project_*`, `workflow_*`, `code_*`, `pm_*`, `adapt_*`, `ops_health`, and `agent_*`.
- The controlled-workflow adapter (`opencodeRunAdapter.js`) invokes fixed-argument `opencode run` with injectable spawn and **no shell**. It resolves the OpenCode binary deterministically (including a Windows shim via `HARNESS_OPENCODE_BIN`).
- Honest evidence tier: Phase 28 verified the approval/simulation **control paths** via tests. Real process spawn, agent reply, Harness dispatch, task completion, postcondition pass, and task verification were **not** demonstrated with fresh execution in Phase 28. A historical Phase 24 real process exited 0 with `process_ok:true` / `task_verified:false`; a direct agent reply "OK" was not attributed to a Harness task. Real execution remains unverified and requires explicit operator authorization.

## Generic MCP clients (experimental)

The server is a standard MCP stdio server. Any MCP client that can launch a subprocess and speak stdio can call the registered tools, and zod schemas validate inputs.

What this **does** give you:
- Access to the read/write memory, learning, project, workflow, code, PM, adaptation, agent, and `ops_health` tool families.
- Parameterized, project-scoped database operations with fail-closed input validation.

What this **does not** give you:
- **Tool access is not autonomous capability.** Calling `workflow_*` tools from a generic client does not inherit OpenCode's execution environment, approval semantics, or turn-end plugin hooks. Dispatch still requires explicit single-use approval; no client can bypass it by merely calling a tool.
- No automatic prompt-time retrieval or turn-end learning. Those come from the OpenCode plugin, not from the MCP server.
- No claim of compatibility with any specific non-OpenCode agent runtime. Presence of a tool is not runtime verification.

Use `opencode mcp list` for the OpenCode registration check and the diagnostics in `docs/troubleshooting.md` for other clients.

## Other harnesses (not tested)

No other agent harness has been verified against the engine. Paths that assume OpenCode — the plugin loader, `HARNESS_OPENCODE_BIN` shim resolution, the `opencode-cli` LLM transport, and the read-only OpenCode SQLite import — are OpenCode-specific and will not transfer unchanged. Treat any integration outside OpenCode as experimental and validate it yourself.

## Adapter guides

Per-client adapter guides and their registration snippets are maintained in **`docs/integrations/`** by a separate release workstream. This document is the overview only; it does not define those adapter files. When adding or changing an adapter, follow the contributor guidance in `docs/development/adding-adapters.md` and keep fixed-argument, no-shell execution and approval gates intact.

## Honest limitations

- "Fully supported" applies to the tested OpenCode v2.4.1 local Windows scope only (`docs/compatibility.md`).
- Presence-only wiring checks and tool registration do not prove runtime correctness.
- No client is authorized to bypass single-use workflow approval or to auto-approve work.
