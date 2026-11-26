# Generic MCP integration — limitations

These limitations are properties of the engine's design and of what was actually tested. They are
not temporary bugs to be assumed away by a client implementation.

1. **No plugin-equivalent behaviour.** Automatic prompt retrieval, system-context injection,
   tool-observation recording, durable transcripts, and turn-end learning are implemented in the
   OpenCode plugin (`plugin/memory.ts`), not in the MCP tools. A generic client that only connects
   over MCP gets none of them automatically; it must call the relevant tools/CLI itself and accept
   responsibility for transcript durability.

2. **Tool access ≠ autonomous capability.** The tools are data/analysis operations on the engine's
   DB. They do not grant shell access, worktree creation, session execution, agent dispatch, or
   approval authority. Real execution requires a host with those capabilities and an explicit
   Phase 24 single-use approval token. Calling `workflow_dispatch` does not make an agent run.

3. **Simulation is the default.** `workflow_create`, `workflow_dispatch`, `workflow_recover` and
   `workflow_test` default to `mode: "simulation"` and `dry_run: true`. Do not report simulated
   activity as real.

4. **`process_ok` is not `task_verified`.** The engine keeps four evidence tiers (`mock`, `api`,
   `runtime`, `agent`) distinct. A successful process exit does not establish that task
   postconditions passed.

5. **Presence checks are not runtime proof.** `pipeline_wiring_audit`, `pipeline_dependency_map`,
   `context_audit` and parts of `ops_health` report wiring/presence and are explicitly marked with
   `verifiedBehavior: false` / `NO_RUNTIME_CLAIM`. Treat them as inventory, not verification.

6. **Heuristic source intelligence.** `code_*` tools use static/heuristic analysis with no AST
   parser. They carry explicit confidence and staleness fields; do not present their output as
   compiler-verified truth. They never rewrite source.

7. **Model confidence is not verification.** `adapt_*` and several `learning_*` tools produce
   advisory proposals and evaluation records. A confidence score or a model's own claim does not
   approve a change or verify an outcome.

8. **Project isolation depends on `project_id`.** Most tools accept a `project_id`; the client must
   pass the correct scope. Scope guards exist (`memoryAccessGuard`, authorization helpers), but a
   client that omits or misuses scope can still read the wrong context. `_global` is a special
   scope, not a wildcard for private data.

9. **Database is required.** The MCP server needs a reachable PostgreSQL 17 + pgvector + pg_trgm
   database with migrations `001`–`026` applied. There is no shipped development dump; a fresh
   install is a fresh migration path. Test clients must use an isolated DB (for CI:
   `MEMORY_DB_NAME=opencode_memory_ci_test`) — never a production database.

10. **Not verified on any named client.** Only the MCP protocol surface and OpenCode v2.4.1 have
    been exercised. `config-example.json` is an illustrative shape; key names vary by client, and
    no claim is made about Claude Desktop, Cursor, Windsurf, or any other specific product.

11. **Known regression anomalies (from Phase 28).** The historical suite had four classified
    anomalies: a bounded-top-30 semantic duplicate effect from accumulated test data, two
    concurrent-write count fluctuations, and a `phases678` lingering process handle. They are
    documented, not resolved by this integration. Real OpenCode agent execution was not freshly
    demonstrated and remains gated on explicit operator authorization.

12. **Large tool catalog costs context.** Every registered tool is described to the model. Add only
    the servers/tools you need; a generic client may prefer to expose a subset rather than the
    entire catalog.
