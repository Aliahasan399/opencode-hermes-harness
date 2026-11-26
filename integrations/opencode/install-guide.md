# Install guide — OpenCode integration

Scope: fresh local install of the OpenCode Harness with OpenCode **v2.4.1** and Node
**v26.5.0** (Node 20 and 22 are used in CI syntax checks; 26.5.0 is the tested runtime).
Paths below are **placeholders** — substitute your own checkout directory. No real credentials
appear here; the only database password is read from your own untracked `.env`.

## 0. Prerequisites

- Node.js 20, 22 or 26 (tested: 26.5.0) and npm.
- Docker with Docker Compose.
- OpenCode v2.4.1 on PATH (`opencode --version`).
- Optional: local Ollama for embeddings (`MEMORY_EMBED_*`); the engine degrades without it.

## 1. Obtain the source

No repository URL or license decision has been published for this snapshot. Place the source at a
path you control, for example:

```powershell
$ENGINE = "<YOUR_CHECKOUT>\engine"
```

The directory layout used by the code is:

```
<checkout>/
  engine/            # package.json, src/server.js, src/cli.js, test/
  init/              # migrations 001..026 (applied by Docker entrypoint / psql)
  plugin/memory.ts   # copy to your OpenCode global plugins dir
  docker-compose.yml
```

## 2. Create `.env` from placeholders only

Create `.env` at the checkout root (it is git-ignored — do **not** commit it). Use placeholder
values and replace them locally:

```dotenv
MEMORY_DB_USER=<your-local-db-user>
MEMORY_DB_PASSWORD=<generate-a-local-random-password>
MEMORY_DB_NAME=opencode_memory
MEMORY_DB_PORT=55432
MEMORY_EMBED_PORT=11434
```

Only ever publish a `.env.example` containing keys with empty/placeholder values. The published
snapshot has no `.env.example`; one may be added by the release-prep owner.

DB connection names read by `engine/src/core.js`: `MEMORY_DB_HOST`, `MEMORY_DB_PORT` (default
`55432`), `MEMORY_DB_USER` (default `opencode_memory`), `MEMORY_DB_PASSWORD` (default empty),
`MEMORY_DB_NAME` (default `opencode_memory`).

## 3. Start and migrate the database

`docker-compose.yml` runs `pgvector/pgvector:pg17` bound to `127.0.0.1` and mounts `./init` into
`/docker-entrypoint-initdb.d`, so migrations `001`–`026` run automatically on a **fresh** volume.
Migration `001` is the base; `026` is the latest additive hardening migration (8 reversible
`project_id` indexes). There is no production dump to import — a clean install is a fresh
migration path.

```powershell
docker compose --project-directory <checkout> up -d
docker compose --project-directory <checkout> ps
```

For an existing volume, apply new migrations additively in filename order with your local client
(never against a production DB from an installer):

```powershell
Get-ChildItem <checkout>\init\*.sql | Sort-Object Name | ForEach-Object {
  # use your own local credentials from .env
  psql "host=127.0.0.1 port=55432 dbname=$env:MEMORY_DB_NAME user=$env:MEMORY_DB_USER" -f $_.FullName
}
```

## 4. Install engine dependencies and smoke-check

```powershell
cd $ENGINE
npm install --no-audit --no-fund
node --check src/server.js
node src/cli.js status          # prints health JSON, no side effects
node --test test/*.test.js      # full suite requires the DB above; see CI notes
```

CI runs syntax checks only on Node 20/22/26 and validates migrations against an **isolated** test
database (documented env var `MEMORY_DB_NAME=opencode_memory_ci_test`) with test-only credentials.
The full historical suite has local-environment dependencies and a known lingering-handle test
(`phases678`); treat it as operator-run evidence, not a silent release gate.

## 5. Register the MCP server with OpenCode

Edit `~/.config/opencode/opencode.json` (or `.jsonc`) and add the server under `mcp.servers`.
Start from [`config-template.json`](config-template.json) and replace both
`<ABSOLUTE_PATH_TO_ENGINE>` placeholders with the absolute path to `engine`. On v2, local servers
use `"type": "local"` and a command array; `disabled: false` is the default. Use `"codemode": false`
if the tools are otherwise hidden behind Code Mode.

```powershell
opencode mcp list     # expect: opencode-memory connected
```

If you prefer the CLI:

```powershell
opencode mcp add opencode-memory -- node "<ABSOLUTE_PATH_TO_ENGINE>\src\server.js"
```

Config sources: <https://opencode.ai/docs/mcp-servers/> and <https://opencode.ai/docs/config/>.

## 6. Install the plugin

1. Copy the repository plugin to the global discovery directory:

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.config\opencode\plugins" | Out-Null
   Copy-Item <checkout>\plugin\memory.ts "$HOME\.config\opencode\plugins\memory.ts"
   ```

2. **Edit the copied file.** Replace the three hard-coded constants at the top of `memory.ts`:

   - `CLI` → absolute path to `engine/src/cli.js`
   - `FINALIZER` → absolute path to `engine/src/finalize-session.js`
   - `LOG_DIR` → absolute path to a writable session-logs directory

   The original values point at the author's `E:\OpenCodeData\memory\...` tree and will not work
   elsewhere. See [`plugin-notes.md`](plugin-notes.md).

3. If OpenCode's process is `opencode.exe`, the plugin resolves a real `node` binary; override with
   `HARNESS_NODE_BIN` if auto-resolution is wrong.

4. Reload after any engine or plugin change: `/reload` in OpenCode (or restart the OpenCode
   service). Global plugins load from `~/.config/opencode/plugins/` — a plugin file placed beside
   a project-root `opencode.json` is not auto-discovered. Source: <https://opencode.ai/docs/plugins/>.

## 7. Verify

- `opencode mcp list` shows `opencode-memory connected`.
- In a session, a prompt triggers a `context-package` call and (optionally) a retrieved-memory
  system block.
- `node src/cli.js status` returns health with `pgvector: true` on a correctly migrated DB.

## 8. Preserve the safety defaults

Keep `OPTIMIZATION_LEVEL=1` and `HARNESS_SEMANTIC_LLM=0` unless you intentionally change them.
Workflows stay in `simulation` mode with `dry_run: true` until an operator creates a single-use,
scope-bound approval token. **Installing the tools does not authorize real agent execution**, and
no process-exit success should be reported as a verified task.
