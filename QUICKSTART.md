# Quickstart

A first working session with the OpenCode Harness. All CLI commands below exist in `engine/src/cli.js`; all MCP tool names exist in `engine/src/server.js`. Work from the repository root unless stated otherwise.

> Conditionally ready with documented limitations for the tested local deployment scope. Real Harness-dispatched OpenCode agent execution was not demonstrated in Phase 28. Approval-gated simulation and control paths were tested; fresh agent execution was not.

## 0. Check prerequisites

```powershell
node --version
docker --version
docker compose version
```

Use the installer from [INSTALL.md](INSTALL.md) first: validate, preview with `--dry-run`, then apply. Bring up the database and check health:

```powershell
docker compose -f E:\OpenCodeData\memory\docker-compose.yml --project-directory E:\OpenCodeData\memory up -d
docker compose -f E:\OpenCodeData\memory\docker-compose.yml --project-directory E:\OpenCodeData\memory ps
cd E:\OpenCodeData\memory\engine
node src/cli.js status
```

`status` returns engine health including database and `pgvector` state.

## 1. Choose capabilities

The recommended selection is all three. For a memory-only start:

```powershell
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory --dry-run
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory --apply --yes
```

Other documented modes: `--mode full|all|memory-only|memory+learning|agents|diagnostics|uninstall|validate`, `--doctor`, `--uninstall`. The installer plans first, requires `--yes`, is idempotent, backs up files it modifies, and never overwrites unrelated config.

## 2. Database setup

A fresh Docker volume applies migrations `init/001`–`init/026` automatically. Fill `.env` from `.env.example` with local values (names only in the example; never commit real values). Some defaults in source are Windows-specific paths — override them with `HARNESS_OPENCODE_DB`, `SQLITE3`, and `HARNESS_OPENCODE_BIN` as needed.

Optional read-only history import (does not modify OpenCode's own database):

```powershell
cd E:\OpenCodeData\memory\engine
node src/cli.js import --limit 50
```

## 3. OpenCode integration

The installer registers the MCP server `opencode-memory` and can add a managed block to `AGENTS.md` with `--inject-agents`. The automatic plugin hook uses `plugin/memory.ts`, whose OpenCode loader path is `~/.config/opencode/plugins/memory.ts`.

**Single copy-paste instruction (host shell):**

```powershell
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --dry-run; node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --apply --yes
```

Be honest about the manual steps this does not perform for you:

- It does not install Docker, Node.js, or OpenCode, and does not install npm dependencies.
- It does not start containers or run migrations against an existing database automatically (the optional guarded migration path is opt-in).
- It does not copy the plugin loader file into OpenCode's plugin directory; if you want automatic prompt-time retrieval and turn-end learning, place/verify the loader yourself.
- It does not run a real agent task. Run `/reload` in OpenCode after engine or plugin changes.

Verify integration:

```powershell
cd E:\OpenCodeData\memory\engine
npm test
node src/cli.js status
node src/cli.js ops-health
node src/cli.js pipeline-audit
```

In OpenCode: confirm `opencode mcp list` shows `opencode-memory` connected, then call `memory_status` (expect `pgvector: true`). Pipeline wiring checks are presence-only; they are **not** runtime verification.

## 4. First-use examples

All `--project` values below mean the absolute path of your project directory; the engine resolves it to a stable project id.

### Remember a decision

Using the CLI's structured decision recorder:

```powershell
node src/cli.js context-decision-record --project <project-dir> --title "Use snake_case for Python test files" --reasoning "Matches existing suite" --alternatives "camelCase|PascalCase" --consequences "Consistent file naming"
```

Or ask your host agent to call the MCP tool `memory_save` with `layer=project`, a `title`, `content`, and `project_id`.

### Recall that context later

```powershell
node src/cli.js context --project <project-dir> --prompt "What naming convention do we use for Python tests?"
node src/cli.js context-retrieve --project <project-dir> --prompt "Python test naming" --budget 4000
```

The harness automatically prepares budgeted context on prompts when the plugin hook is active. Retrieved memories are marked untrusted historical reference data.

### Learn from a debugging session

After a real failure → fix → verified pass, run the turn-end pipeline explicitly (normally the plugin does this):

```powershell
node src/cli.js automate --project <project-dir> --session <session-id> --durable
node src/cli.js learning-status --project <project-dir>
node src/cli.js learning-explain --project <project-dir> --id <learning-id>
node src/cli.js learning-advice --project <project-dir> --prompt "How did we fix the previous test failure?"
```

Assistant claims are never treated as verified; only tool evidence can promote a fix toward verified.

### Prepare a multi-agent plan

```powershell
node src/cli.js agent-discover
node src/cli.js agent-plan --project <project-dir> --prompt "Split into: update parser, add tests, review impact" --max-tasks 12
node src/cli.js agent-plan-status --project <project-dir> --plan <plan-id>
node src/cli.js agent-explain --project <project-dir> --plan <plan-id> --task <task-id>
node src/cli.js agent-conflicts --project <project-dir> --plan <plan-id>
```

This only **plans and coordinates**. Execution stays with the host agent.

### Execute only after approval

```powershell
node src/cli.js workflow-templates
node src/cli.js workflow-create --project <project-dir> --template <name> --prompt "<objective>" --scope '{"files":["src/"]}' --risk low --mode simulation
node src/cli.js workflow-approvals --project <project-dir>
```

Create an approval with `workflow-approve` (returns a single-use token), then attempt a dry dispatch first — `workflow-dispatch` defaults to `dry-run: true`:

```powershell
node src/cli.js workflow-dispatch --project <project-dir> --run <run-id> --approval <approval-id> --token <token>
```

Only with explicit operator authorization would a live dispatch be considered, and even then `process_ok` never means `task_verified`.

### Verify the outcome

```powershell
node src/cli.js workflow-validate --project <project-dir> --run <run-id> --checks <checks.json> --evidence runtime
node src/cli.js workflow-report --project <project-dir> --run <run-id>
node src/cli.js ops-health --project <project-dir>
```

`workflow-validate` requires evidence; a successful process exit alone cannot set `task_verified`. Keep the evidence tiers (`mock`, `api`, `runtime`, `agent`) distinct in any report you publish.

## 5. Where to go next

- [INSTALL.md](INSTALL.md) — all installer modes and database details.
- [Getting started](docs/getting-started.md) — concepts and terminology.
- [Capabilities](docs/capabilities.md) — module-to-command mapping.
- [Architecture](docs/architecture.md) — how the layers compose.
- [FAQ](docs/faq.md) — limitations and common questions.
