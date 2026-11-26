# Installation Test Report — Public Release

Date: 2026-11-26. Evidence: `test/public-release/installer.test.js` (Node `node:test`), run from
`test/public-release/` with `node --test *.test.js`. No Git commands, no network, no dependency
installs, and no writes to `E:\OpenCodeData\memory` outside `test/public-release/` and an isolated
OS temp directory.

## Modes actually tested

**Dry-run only.** The contract command was executed via `child_process.spawnSync(process.execPath,
[...])`:

```
node installer/bootstrap/install.mjs --target <unique-temp-dir> --capabilities memory --dry-run
```

- `cwd` for the child was the repository root; `--target` was a fresh `fs.mkdtempSync` directory
  under `os.tmpdir()`, removed afterwards via `t.after()`.
- The command was run **twice against the same temp target** to check idempotency.
- No `--apply`, no confirmation flag, no real install was performed.

## Results (final run)

| Assertion | Result |
|---|---|
| Installer present and dry-run exit code | PASS — `status=0` both runs |
| No writes to `--target` | PASS — target directory remained empty after both runs |
| No writes to production repo | PASS — fingerprint (size + mtime) of `.env`, `.gitignore`, `engine/package.json`, `engine/src/server.js`, `engine/src/cli.js`, `init/001-init.sql`, `docker-compose.yml` unchanged |
| Capabilities selection | PASS — `capabilities = ["memory"]` |
| Actions list | PASS — 7 planned actions |
| Idempotent plan shape | PASS — capabilities + actions identical across runs |
| Installer source contains no Git operations | PASS — 9 installer files scanned |

Full suite at final run: **25 tests, 24 pass, 0 fail, 1 skip** (the skip is an unrelated DB-name
check in the safety scan).

### Defect found and resolved during testing

An intermediate run failed because `installer/bootstrap/apply.mjs` referenced `fileURLToPath`
without importing it (`ReferenceError` at module load, exit 1). This was a genuine defect in a
sibling-owned file, not a test defect. The owning agent added
`import { fileURLToPath } from "node:url";`; the final re-run passed. No file outside my ownership
was modified by me.

## Additional installer-owner verification (isolated temp dirs, stub engine)

The installer's owning agent ran a separate, broader isolated test pass after the dry-run suite
above. All targets were unique OS temp directories; the production repository and its `.env`
values were never touched. Results reported by that pass:

- `--apply --yes` with no engine → APPLIED; created `.env.example`, merged `opencode.json`, created
  a dedicated instructions file, setup report and diagnostics (`healthy`).
- Re-run of the same apply → `Backups: 1`, config `no-op`/already registered; no duplicate MCP or
  instructions entries (counts verified = 1/1). **Idempotent apply confirmed.**
- Apply to a temp project with pre-existing `opencode.json` + `AGENTS.md` and `--inject-agents` →
  2 backups created; existing custom `model`/`permissions` and original AGENTS text preserved;
  managed block appended only.
- `node scripts/maintenance/uninstall.mjs --target <applied-dir> --apply --yes` → removed only our
  MCP/instructions entries and managed block; user content preserved; uninstall report written.
- `--apply` without `--yes` → refused, exit 1, no files changed.
- DB guard with `--db opencode_memory` → refused ("production-looking database"); no docker executed.
- `scripts/setup/setup.ps1 -DryRun` and `scripts/setup/setup.sh --dry-run` → both worked.
- `node --check` passed for all eight `.mjs` files.

These are **real file operations in isolated directories**, not merely dry-run plans — but they
used a stub engine and did not apply database migrations or start OpenCode/PostgreSQL.

## Explicitly NOT tested

- **Database creation / migrations `001`–`026`** — not executed. The installer refuses
  production-looking DB names and leaves migrations manual by default; the DB guard was tested,
  migration application was not.
- **Service startup** (`docker compose up`, PostgreSQL, pgvector/pg_trgm, Ollama) — not executed.
- **Plugin loading / real OpenCode MCP registration** — not exercised; no `opencode` process was
  started; registration with a stub engine was exercised only as file/config merging.
- **Non-Windows targets** — no Linux/macOS run was attempted; see `compatibility-matrix.md`.
- **`--json` machine-readable mode** — the tests deliberately use the contract command without
  `--json`; the parser accepts both the human-readable and JSON renderings.

## Distinction

The first suite is a **simulated/dry-run plan check**; the additional installer-owner suite
performed **real file operations in isolated temp directories** with a stub engine (apply,
idempotent re-apply, uninstall, confirmation refusal, DB-name guard). Neither suite demonstrates a
real database migration, PostgreSQL/OpenCode startup, or real host registration. Preserve the
Phase 28 conditional-readiness statement: these are packaging/installation checks, not runtime
verification.
