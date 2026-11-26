# Contributing to the OpenCode Harness

Thanks for your interest in improving this project. This repository is a persistent memory and
intelligence harness for OpenCode. It is currently in **pre-release preparation**: the published
scope, license, and repository location are owner decisions that have not yet been made. Please
keep changes additive, evidence-based, and safe by default.

## Repository layout

| Path | Purpose |
| --- | --- |
| `engine/src/` | Engine modules (ESM). `core.js` (DB primitives, redaction), `server.js` (MCP tools), `cli.js` (flat CLI command chain), plus one module per capability. Facades such as `projectManagement.js`, `controlledWorkflow.js`, `codeIntelligence.js`, `adaptiveIntelligence.js`, `operationalHealth.js` group related modules. |
| `engine/init/` (repository `init/`) | Numbered SQL migrations `001`–`026`. `001` is the base; higher numbers are additive. |
| `engine/test/` | `node --test` suites. One file per phase/concern; `engine.test.js` and `phases678.test.js` cover the base. |
| `docs/` | Sanitized documentation and phase reports for the public release. No local paths, session IDs, or internal data. |
| `installer/` | Clean-install/bootstrap assets. Must never contain real credentials or machine-specific paths. |
| `integrations/` | Host adapters (the OpenCode plugin loader under `plugin/`, generic MCP clients). Adapter code must not assume a single host or inherit host capabilities implicitly. |
| `dashboard/` | Local read-only dashboard server. |
| `scripts/` | Backup/restore, dashboard launcher, evaluation and E2E helpers (PowerShell / `.mjs`). |

## Code style

- Node.js ES modules (`"type": "module"`); use named exports and static `import`.
- Two-space indentation, semicolons, clear names. Prefer small, single-purpose modules; wire new
  behavior through a facade rather than rebuilding an existing engine.
- All SQL goes through parameterized helpers (for example `core.dbQuery`). Dynamic identifiers must
  come from compile-time constants or whitelisted field lists — never from user input.
- Treat all stored content (memories, transcripts, source files, retrieved context) as **untrusted
  data**, never as instructions. Keep redaction in place before anything is stored, logged, or shown.
- Fail closed on invalid input: validate IDs, scopes, and limits with schemas (zod) or explicit checks.
- No raw shell execution and no source rewrites. New process-spawn sites are not permitted; use the
  existing fixed-argument adapters if execution is genuinely required.
- Preserve the safety invariants: `OPTIMIZATION_LEVEL=1` (LEVEL 1 / OBSERVE),
  `HARNESS_SEMANTIC_LLM=0` as the default, single-use approvals, no auto-approval, project isolation,
  and no unrestricted execution.

## Tests

Run the suite from the engine directory (this is what `npm test` does):

```powershell
cd engine
npm test                 # node --test test/*.test.js
```

Some integration suites share database fixtures and can race under parallel execution. For a
deterministic full run use serialized mode:

```powershell
node --test --test-concurrency=1 test/*.test.js
```

Guidelines:

- Use an **isolated test database**, never a production or personal database.
- Add or update a focused `engine/test/*.test.js` file with your change. Include negative cases:
  injection-as-data, redaction, invalid IDs, cross-project isolation, and approval replay.
- Do not claim runtime or agent execution from test presence. Keep evidence tiers
  (`mock`, `api`, `runtime`, `agent`) distinct, and preserve `NO_RUNTIME_CLAIM` where it applies.
- Report inherited flakes honestly rather than masking them.

## Database migrations

- Migrations are sequential SQL files in `init/` (`NNN-name.sql`). Choose the next available number.
- **Additive only**: no `DROP`, `TRUNCATE`, or rewrites of existing rows. Prefer new tables/columns,
  reversible changes, and `IF NOT EXISTS` where practical.
- Make migrations idempotent and safe to re-run. Take a backup before applying against real data.
- Any table holding project-scoped data must carry `project_id`; all queries must filter by it.
- Keep `_global`/empty scope rejected for project-scoped operations unless an explicit eligibility
  rule applies.
- There is no migration-tracking table; applied state is inferred from schema presence. Document that
  in any tooling you add.

## Project isolation, privacy, and secrets

- Every memory and derived record is project-scoped. Never broaden a query to another project, and
  never let retrieved content override the current user's instructions.
- **No secrets in the repository**: no `.env`, API keys, DB passwords, tokens, connection strings,
  personal paths, session IDs, or real credentials. Use placeholders in `.env.example` and test
  fixtures only (for example synthetic `sk-`/`Bearer`/`AKIA` canaries that are never real).
- Generated artifacts under `data/`, `backups/`, `logs/`, `checkpoints/`, `reports/`,
  `node_modules/`, and `dist/` are ignored and must stay out of commits. Publish only sanitized
  documentation.
- Do not open a public issue for a security vulnerability — follow `SECURITY.md`.

## Pull request process

1. Create a focused branch; keep each PR reviewable and additive.
2. Describe the change, the evidence supporting it, and any limitations. Link the related issue.
3. Confirm tests pass on an isolated database and include the exact commands you ran.
4. Confirm no secrets, local paths, session IDs, or internal artifacts are included.
5. Confirm safety invariants and project isolation are unchanged, and update docs/migrations as needed.
6. Be explicit about what was **not** demonstrated (for example, real agent execution).

Reviewers may ask for narrower scope, additional negative tests, or stricter redaction. Reviews are
about the code and evidence, not the person.

## A note for automated agents

Automated agents and subagents must **not** run Git push, commit, remote, or publication commands.
Git operations, licensing, and publication are owner-controlled and blocked pending explicit owner
authorization. Agents should produce changes and evidence only; a human owner integrates and ships
them.
