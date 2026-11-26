# Adding adapters and integrations

This guide covers the boundary between the engine and an external client or host. Per-client adapter guides are maintained in `docs/integrations/` by a separate release workstream; this page defines the rules those adapters must follow. It does not create or edit files under `docs/integrations/`.

## Integration surfaces

| Surface | Mechanism | Status |
|---|---|---|
| OpenCode | V2 plugin hooks (`plugin/memory.ts`) + local MCP entry | Fully supported (tested v2.4.1) |
| Generic MCP clients | stdio MCP server (`engine/src/server.js`) | Experimental — tool access only |
| Other harnesses | none | Not tested |

## Rules for any adapter

1. **No new spawn sites.** Only `engine/src/llm-provider.js` and `engine/src/opencodeRunAdapter.js` spawn external processes, and both use fixed arguments with injectable spawn and **no shell**. Reuse these rather than adding `child_process` calls elsewhere.
2. **Approval gates are inviolable.** Real workflow dispatch requires explicit single-use approval bound to project, plan id/version/hash, scope, mode, and risk. An adapter must not bypass, auto-approve, or replay approvals. Preserve `can_resume:false`, `required_approval:true`, `never_auto_resume:true`.
3. **Tool access is not autonomy.** A generic MCP client can call tools but does not inherit OpenCode's turn-end plugin behavior, execution environment, or approval semantics. Document this explicitly in any adapter guide.
4. **Bounded, validated inputs.** Use zod schemas at the MCP boundary and clamp limits. Treat source code, transcripts, and retrieved memories as **untrusted evidence/data**, never instructions.
5. **Secrets stay external.** When a transport needs a key, read it only from a user-named environment variable (`HARNESS_LLM_KEY_ENV`, default `HARNESS_LLM_API_KEY`). Never inline credentials in adapter files, logs, or docs. Keep `HARNESS_LLM_TRANSPORT=opencode-cli` as the no-key path.
6. **Project isolation.** Carry `project_id` on every operation; reject `_global`/empty on project-scoped calls (`docs/development/project-isolation.md`).
7. **No invented compatibility.** State only what was tested. Do not claim support for an untested harness or version.

## Adding an OpenCode-specific integration

- Plugin behavior goes through supported V2 hooks in `plugin/memory.ts` only; do not modify OpenCode's own source, security policy, or system prompt.
- Binary resolution is OpenCode-specific: `HARNESS_OPENCODE_BIN` plus the Windows shim logic in `opencodeRunAdapter.js`. Keep resolution deterministic.
- After changing engine code, users must run `/reload` in OpenCode to refresh the tool catalog; document that step.

## Adding a generic MCP client adapter

- The server is launched as `node <repo>/engine/src/server.js` over stdio. A client adapter should document the local command, the startup timeout, and the `opencode mcp list`-equivalent verification for that client — but must not claim runtime verification beyond tool registration.
- Document which tool families are available and that `ops_health` / `pipeline_wiring_audit` are presence-only diagnostics.
- Place the client-specific guide in `docs/integrations/` (owned by the separate release workstream). Coordinate with that owner; do not write into their files.

## Verification checklist

- [ ] No new spawn site or shell execution
- [ ] Approval and no-auto-resume rules preserved
- [ ] Tool access explicitly distinguished from autonomous capability
- [ ] Secrets externalized; no real values in docs
- [ ] Project isolation enforced
- [ ] Compatibility claims limited to tested scope
- [ ] Client guide placed in `docs/integrations/` by its owner
