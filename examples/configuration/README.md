# Minimal configuration example

`minimal.opencode.json` shows the only settings the installer adds to OpenCode:

- `mcp.servers["opencode-memory"]` — a local stdio server launched with
  `node <engine>/src/server.js` (the real MCP entrypoint in this release).
- `instructions` — a dedicated generated instructions file. The installer never
  edits an existing `AGENTS.md` unless you explicitly pass `--inject-agents`.

Replace `<absolute-path-to-release>` with the directory that contains `engine/`.
The installer computes these paths for you from `--target` / `--engine`.

Verify with:

```sh
opencode mcp list
```

No credentials belong in this file. The server reads its configuration from the
operator-managed `.env`; the installer only reads variable NAMES from it.
