# Troubleshooting

This guide maps common failures to bounded, read-first diagnostics. Commands are taken from the actual CLI (`engine/src/cli.js`) and MCP tool registry (`engine/src/server.js`); run them from the `engine/` directory unless noted.

## First: read-only health diagnostics

```powershell
cd <repo>/engine
node src/cli.js status                       # core health + pgvector status
node src/cli.js ops-health                   # Phase 28 operational health
node src/cli.js ops-health --project <id>    # scope to one project
node src/cli.js pipeline-audit               # wiring presence audit
node src/cli.js pipeline-map                 # dependency map
node src/cli.js pipeline-processing --limit 20
node src/cli.js pipeline-gaps
```

Equivalent MCP tools: `memory_status`, `ops_health({ project_id?, limit? })`, `pipeline_wiring_audit`, `pipeline_dependency_map`, `pipeline_processing_audit({ limit? })`, `pipeline_gap_report`.

Interpreting `ops-health` verdicts (`logs/phase28-operational-runbook.md`): `healthy | degraded | failed | unknown | insufficient_evidence`. Two important caveats:

- `database` is a **real runtime check**.
- `pipeline_wiring` is **presence-only** (`runtime_check:false`); it cannot prove runtime correctness. A healthy verdict on one component does **not** certify the whole system.

## Database down / Docker stopped

Symptoms: connection errors from any CLI command; `ops-health` reports `database: failed`; tools time out.

```powershell
docker compose -f <repo>/docker-compose.yml --project-directory <repo> ps
docker compose -f <repo>/docker-compose.yml --project-directory <repo> up -d
docker exec opencode-memory-db pg_isready -U <db-user> -d <db-name>
node src/cli.js status
node src/cli.js ops-health
```

Check that `MEMORY_DB_PORT` is free and that the container is healthy. Do not run a destructive reset; see `docs/database.md`. If you recently changed schema, verify migrations with the isolated database first.

## Dashboard not reachable

Symptoms: `http://127.0.0.1:<port>` refuses connections. The dashboard binds **only** to `127.0.0.1` on `MEMORY_DASHBOARD_PORT` (default 8765).

```powershell
Get-NetTCPConnection -LocalPort <port> -State Listen -ErrorAction SilentlyContinue
powershell -File <repo>/scripts/start-dashboard.ps1
```

The start script exits early with "Dashboard already running" if the port is already listening. If another process owns the port, either stop that process or change `MEMORY_DASHBOARD_PORT`.

## Provider / LLM timeouts

Symptoms: empty or slow semantic results, adapter timeouts, retries. Remember `HARNESS_SEMANTIC_LLM=0` is the default: automatic semantic LLM calls are off by design, and a real 200-char request historically took ~46 seconds.

```powershell
node src/cli.js llm-status
node src/cli.js llm-usage
node src/cli.js llm-test         # on-demand connection check, no credential printed
```

Or via MCP: `llm_status`, `llm_usage`, `llm_test`, `llm_redact`. Check `HARNESS_LLM_TRANSPORT`, `HARNESS_LLM_MODEL`, `HARNESS_LLM_TIMEOUT_MS`, and `HARNESS_LLM_ENABLED` (names only — never log values). With `opencode-cli` transport the Harness holds no API key. Do not "fix" a slow provider by enabling `HARNESS_SEMANTIC_LLM=1` globally; keep it opt-in.

## Missing MCP registration / tools not visible

Symptoms: the memory tool catalog is absent or stale inside OpenCode.

```powershell
opencode mcp list                            # expect "opencode-memory connected"
```

Registration is a local MCP entry of type `local` whose command runs `node <repo>/engine/src/server.js` (with a startup timeout). The server uses `StdioServerTransport` and registers zod-validated `s.tool(...)` handlers. After engine code changes, run `/reload` in OpenCode to refresh the tool catalog. The automatic plugin loader lives at `~/.config/opencode/plugins/memory.ts` and loads `plugin/memory.ts`; verify that path if automatic retrieval/turn-end learning stopped. Client-specific registration steps are maintained separately under `docs/integrations/`.

## Approval rejected / workflow will not resume

Symptoms: dispatch refused; `workflow_status` shows no progress.

```powershell
node src/cli.js workflow-approvals
node src/cli.js workflow-status --project <id>
node src/cli.js workflow-report --project <id>
```

Phase 24 approvals are **single-use** and bound to project, plan id/version/hash, scope, mode, and risk. A changed plan or a replayed token is rejected by design. Recovery rules: no approval → no resume (`can_resume:false`, `required_approval:true`, `never_auto_resume:true`). Never bypass approval or infer completion from exit code 0, an agent claim, model confidence, or a summary. See `docs/development/regression.md`.

## Stale index / stale claims

Symptoms: code search returns old symbols; turn-end events stuck in `processing`.

```powershell
node src/cli.js code-status --project <id>
node src/cli.js code-freshness --project <id>
node src/cli.js automation-status
node src/cli.js automation-recover-if-due
node src/cli.js automation-retry
```

Source indexing is content-hash incremental and bounded; re-index only when `code-freshness` reports stale state. Startup recovery resets stale `processing` claims and retries pending/failed events but never marks an event done without running it. `code-*` intelligence uses a deterministic heuristic extractor (no AST parser), so unsupported constructs remain `unknown`/unresolved — that is not a stale index.

## Known flaky / inherited regression anomalies

From `logs/phase28-final-report.md` and `logs/phase28-operational-runbook.md`. None is a Phase 28 assertion failure; **do not misclassify them as passes**.

1. `phase10` semantic duplicate — accumulated identical test memories push the new candidate out of a bounded top-30 (test-data pollution, confirmed by direct probe).
2. `phase15-pipeline` — concurrent-write count fluctuation.
3. `phase22-security` — concurrent-write count fluctuation.
4. `phases678.test.js` — lingering process handle after printing passing cases; terminate the child and report honestly (not confirmed in the Phase 28 run).

When the full suite is slow or unstable, run it against the isolated database in chunks (`--test-concurrency=1`, `MEMORY_DB_NAME=opencode_memory_test`). See `docs/development/testing.md` and `docs/development/regression.md`.

## Escalation checklist

- Capture the read-only outputs above before changing configuration.
- Verify `OPTIMIZATION_LEVEL=1` and `HARNESS_SEMANTIC_LLM=0` are unchanged.
- Take a backup before any migration; never restore over production (`docs/database.md`).
- If you suspect a security issue, follow `SECURITY.md` (reporting process) rather than posting details publicly.
- Report evidence at its true tier: presence-only wiring checks are not runtime verification, and real OpenCode agent execution is not demonstrated in the Phase 28 evidence.
