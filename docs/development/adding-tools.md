# Adding tools and CLI commands

The engine has three public surfaces that must stay in sync: the CLI, the MCP tool registry, and the pipeline-audit wiring checks. A new capability is not wired until all relevant surfaces and a test exist.

## 1. CLI — `engine/src/cli.js`

`cli.js` is a flat `if/else` chain over `cmd` (the second CLI argument), with a single `try/catch/finally` that always calls `core.close()`. Verified command shapes include `status`, `context`, `ops-health`, `pipeline-audit`, `workflow-*`, `code-*`, `project-*`, `adapt-*`, and `agent-*`.

To add a command:

1. Add an `else if (cmd === "your-command") { ... }` branch. Parse flags off the existing `args` object (e.g. `--project`, `--limit`, `--window`).
2. Call a named export from one module under `engine/src/` — prefer an existing facade over a new engine.
3. Print `JSON.stringify(...)` to stdout so output is machine-readable, consistent with existing commands.
4. Bound any limit you accept (clamp to a reasonable maximum) and treat untrusted input as data.
5. Keep destructive or state-changing commands behind explicit flags. Inspection commands should remain read-only by default.

Example shape (verified pattern from `ops-health` and `pipeline-audit`):

```js
} else if (cmd === "pipeline-audit") {
  console.log(JSON.stringify(pipelineAudit.auditPipelineIntegrity()));
} else if (cmd === "ops-health") {
  const m = await import("./operationalHealth.js");
  console.log(JSON.stringify(await m.operationalHealth({ project_id: args.project, limit: Number(args.limit || 20) })));
}
```

Unknown commands fall through to `unknown command: ...` with `process.exitCode = 2`; thrown errors print a message and set exit code 1.

## 2. MCP — `engine/src/server.js`

The server constructs `const s = new McpServer({ name: "opencode-memory", version: "0.1.0" })`, registers tools with `s.tool(name, zodSchema, wrap(fn))`, then connects `new StdioServerTransport()`.

To add a tool:

1. Choose a name in an existing family (`memory_*`, `learning_*`, `project_*`, `workflow_*`, `code_*`, `pm_*`, `adapt_*`, `ops_health`, `agent_*`).
2. Define a **zod schema** for every argument: use `.optional()`, `.default()`, `.min()/.max()`, and `z.enum()` where applicable. Bounded limits (e.g. `.min(1).max(50).default(20)`) are the norm.
3. Wrap the handler with `wrap(...)`, which handles errors consistently.
4. Keep the implementation read-only unless the tool name explicitly implies a mutation, and require an explicit flag/actor for state changes. Mutations must be audited.
5. Use dynamic import for heavy/optional modules, matching existing patterns (`await import("./operationalHealth.js")`).

Verified example:

```js
s.tool("ops_health", {
  project_id: z.string().optional(), limit: z.number().int().min(1).max(50).default(20),
}, wrap(async (a) => (await import("./operationalHealth.js")).operationalHealth(a)));
```

## 3. Pipeline audit wiring checks

`engine/src/pipelineAudit.js` records presence/wiring checks across phases (28 legacy → 44 → 50 → 56 → 63 → 73 → 81 → 94 → 106 → ~121 → 137 in Phase 28). When you add a module that participates in a pipeline stage:

1. Add a check to `pipelineAudit.js` so the new wiring is visible in `pipeline-audit` / `pipeline_wiring_audit`.
2. Keep the **no-runtime-claim** marker: wiring checks are presence-only (`verifiedBehavior:false`). Never turn a presence check into a runtime verification claim.
3. Update the dependency map only if a genuine new edge exists.

## 4. Tests and docs

- Add a test in `engine/test/` that exercises the new command/tool against the **isolated** database (`docs/development/testing.md`).
- Update the relevant `docs/` page. If the change touches safety, preserve the invariants in `docs/configuration.md` and `docs/security.md`.
- Do not add a new spawn site or a new dependency without explicit authorization; only `llm-provider.js` and `opencodeRunAdapter.js` spawn, both fixed-argument and shell-free.

## Verification checklist

- [ ] CLI branch added and output is JSON
- [ ] MCP tool has a bounded zod schema and uses `wrap`
- [ ] Pipeline audit check added (presence-only, no runtime claim)
- [ ] Test added; suite passes on `opencode_memory_test`, serialized
- [ ] Docs updated; no secrets, real values, or invented compatibility claims introduced
