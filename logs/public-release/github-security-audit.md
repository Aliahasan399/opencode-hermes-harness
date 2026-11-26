# GitHub Publication — File-by-File Security Audit

**Role:** `github-security-auditor` (subagent, GitHub publication stage)
**Repo root inspected:** `E:\OpenCodeData\memory` (documented repo root; no other root used)
**Mode:** READ-ONLY inspection. No `git init`, `add`, `commit`, `push`, repo creation, or file modification was performed except this report.
**Date:** 2026-11-26
**Publication decision:** **NOT PUBLISHED.** This is a read-only assessment; remediation items below are described, not applied.

---

## 0. Commands executed (exact)

| # | Command (PowerShell, Windows) | Purpose |
|---|---|---|
| 1 | `git -C "E:\OpenCodeData\memory" rev-parse --is-inside-work-tree` | Verify no Git history exists |
| 2 | `Get-Content "E:\OpenCodeData\memory\.gitignore"` | Verify exclusion rules |
| 3 | `Get-ChildItem -LiteralPath <dir> -File -Recurse -Force` + `Measure-Object` count/size | Count candidate & excluded files |
| 4 | `Get-ChildItem -LiteralPath "$root" -Filter '*.md' -File` | Count root Markdown files |
| 5 | `Get-Content <candidate> | foreach line | [regex]::Match(...)` over 8 secret regexes | Secret scan (values suppressed in output) |
| 6 | `Get-ChildItem -LiteralPath "$root\.github" -File -Recurse -Force` + content grep | CI/workflow inspection |
| 7 | `Get-Content "$root\.env.example"` / `Get-Content "$root\docker-compose.yml"` | Template inspection |
| 8 | `Select-String`-equivalent regex over `init/*.sql` for `INSERT INTO|COPY FROM` | Dump-vs-migration check |
| 9 | Regex scan for `[A-Z]:\Users\`, `/home/`, `/Users/`, `ses[hex]{8,}`, private IPs | Personal path / session ID / internal host check |

Secret-scan output emitted **only** `file:line` and a match category — matched values were never printed. Personal paths in this report are masked as `<operator>`.

---

## 1. Git history verification (task item 7)

```
git rev-parse --is-inside-work-tree
→ fatal: not a git repository (or any of the parent directories): .git
→ EXIT 128
```

**Result:** No `.git` directory, no commits, no branches, no remotes, no Git history to audit. Nothing can be pushed from this workspace as-is; a publish operation would require a fresh `git init` by the parent session (explicitly out of scope for this auditor).

---

## 2. `.gitignore` verification (task item 1)

`.gitignore` is present at the repo root. Every required exclusion is verified:

| Required exclusion | Rule present | Verified |
|---|---|---|
| `.env` | `.env` | ✅ |
| `.env.*` except `.env.example` | `.env.*` + `!.env.example` | ✅ |
| `data/` | `data/` | ✅ |
| `backups/` | `backups/` | ✅ |
| `logs/` | `logs/` | ✅ |
| `checkpoints/` | `checkpoints/` | ✅ |
| `reports/` | `reports/` | ✅ |
| `node_modules/` | `node_modules/`, `engine/node_modules/` | ✅ |
| `dist/` | `dist/` | ✅ |
| caches | `__pycache__/`, `.pytest_cache/`, `*.pyc` | ✅ |
| `*.sql.err` | `*.sql.err` | ✅ |
| extra OS metadata | `.DS_Store` | ✅ |

**Conclusion:** The ignore file is complete for the stated policy. Note: it contains **no negation for `logs/public-release/`** (see Finding F-2).

---

## 3. Candidate public surface — file counts (task item 2)

Total **unique candidate files assembled: 302** (plus `engine/init/**` → see note).

| Category | Files | Dirs | Notes |
|---|---:|---:|---|
| root `*.md` | 8 | — | CHANGELOG, CODE_OF_CONDUCT, CONTRIBUTING, INSTALL, LICENSE.decision, QUICKSTART, README, SECURITY |
| `docs/**` | 24 | 2 | |
| `installer/**` | 9 | 3 | bootstrap (5), templates (3), validation (1) |
| `integrations/**` | 9 | 3 | |
| `examples/**` | 4 | 3 | |
| `scripts/setup/**` | 2 | 0 | |
| `scripts/diagnostics/**` | 1 | 0 | |
| `scripts/maintenance/**` | 1 | 0 | |
| `.github/**` | 9 | 2 | 3 workflows, dependabot, FUNDING, PR template, 3 issue templates |
| `test/public-release/**` | 4 | 0 | includes `safety-scan.test.js` |
| `engine/src/**` | 112 | 0 | |
| `engine/init/**` | — | — | **MISSING** — no such path |
| `engine/test/**` | 90 | 0 | |
| `plugin/**` | 1 | 0 | |
| `docker-compose.yml` | 1 | — | audited |
| `.env.example` | 1 | — | audited as template |
| (actual) root `init/**` | 26 | 0 | SQL migrations 001–026; audited as substitute for missing `engine/init/**` |

Sum of the enumerated categories = 302 unique files.

**Path discrepancy (informational):** the task names `engine/init/**`, but the repository has `init/**` at the root (26 SQL migration files). These 26 files were included in the audit; `docker-compose.yml` correctly mounts `./init`.

---

## 4. Excluded categories with evidence (task item 3)

| Category | Count | Size | Ignore rule | Evidence / reason |
|---|---:|---:|---|---|
| `backups/` | 166 files | **13.98 GB** | `backups/` | DB backup dumps (~14 GB) — never publishable |
| `checkpoints/` | 20 immediate dirs (131 recursive dirs, 3411 files) | 0.04 GB | `checkpoints/` | Source snapshots / phase docs with local paths & session IDs |
| `logs/` | **311 immediate files** (2465 recursive files, 101 dirs) | 0.37 GB | `logs/` | Raw run logs; only `logs/public-release/*.md` are sanitized candidates (see F-2) |
| `data/` | 2894 files, 43 dirs | 0.85 GB | `data/` | Live/derived data, includes Postgres volume |
| `reports/` | 1 file | — | `reports/` | Generated evaluation report with internal paths |
| `engine/node_modules/` | 3535 files, 585 dirs | 0.01 GB | `engine/node_modules/` | Dependencies |
| `__pycache__/` | 5 files | — | `__pycache__/` | Python bytecode |
| `.pytest_cache/` | 5 files, 2 dirs | — | `.pytest_cache/` | Test cache |
| raw `.env` | 986 bytes | — | `.env`, `.env.*` | Real local credentials — never print or stage |
| `dashboard/` | 2 files | — | **NOT ignored** | Outside declared surface; scanned for secret shapes (no hits) — see F-3 |

The `backups/` (166 files / 13.98 GB), `checkpoints/` (20 immediate dirs), and `logs/` (311 immediate files) figures match the task's stated evidence.

---

## 5. Secret scan results (task item 4)

Regexes: `sk-` keys, Anthropic `sk-ant-`, AWS `AKIA`, GitHub `gh[pousr]_`, `Bearer <token>`, PEM private-key headers, DB/conn URIs (`mongodb|postgres|mysql|redis|amqp|mssql://`), and `password|token|api_key|secret` assignments with non-placeholder values.

**115 raw hits** across the 302 candidate files, classified as follows:

| Location | Raw hits | Classification |
|---|---:|---|
| `engine/src/**` (13 lines in cli.js, core.js, server.js, codeUnderstanding.js, injectionAudit.js, projectRecovery.js, workflowApproval.js, workflowRecovery.js, workflowTemplates.js) | 13 | **False positives** — variable references (`args.token`, `ap.token`), schema calls (`z.string()`), `crypto.randomBytes(32)`, and env lookups with empty defaults (e.g. `env.MEMORY_DB_PASSWORD \|\| ""`). No literal secret values. |
| `test/public-release/safety-scan.test.js` | 7 | **Synthetic canaries, explicitly labeled** — `const CANARIES = [...]`, comment states they are "not real credentials", plus placeholder strings (`sk-test-placeholder-not-real`, `hunter2secret`, `P20SEC_CANARY_`). |
| `engine/test/*.test.js` (~30 files, phases 9–28) | 95 | **Synthetic test canaries / fixtures** — `const CANARY`, `CANARIES`, `sk-test-*`, `AKIA...` fakes, `Bearer` fakes used to assert redaction/audit behavior. |
| **Total** | **115** | **0 verified real secrets** |

**Negative findings (important):**
- No PEM private-key block in any candidate file.
- No real OpenAI/Anthropic key, no real AWS `AKIA` key, no real GitHub PAT.
- No connection string with an embedded credential; `docker-compose.yml` uses `env_file: .env` and `${MEMORY_DB_PASSWORD}` only.
- No `sk-`/`Bearer`/`AKIA` hit in `docs/`, `installer/`, `integrations/`, `examples/`, `init/`, root `.md`, or `plugin/`.
- Session-ID / internal-IP scan: **0 hits** in candidate surface.

---

## 6. Manual inspection of suspicious files (task item 5)

- **`.env.example`** — placeholders only. All values empty except `MEMORY_DB_PASSWORD=<set-locally-never-commit>`. Header states "TEMPLATE (placeholders only) … NO real values are included here." API key is deliberately *not* stored here; adapter reads key name from `HARNESS_LLM_KEY_ENV`. ✅ Publishable.
- **CI workflows** — `.github/workflows/ci.yml`, `docs-check.yml`, `secret-scan.yml` all declare `permissions: contents: read`. Credentials are `ci-only-not-a-secret` only. `on: push` is an event trigger, not a `git push` command; `out.push(...)` is JS array `push`. **No publish/deploy/registry-push job, no real credentials, no host agent launch.** ✅
- **`dependabot.yml`** — npm + github-actions weekly updates only. ✅
- **`FUNDING.yml`** — all sponsor entries commented placeholders; no invented accounts. ✅
- **Installer scripts** — `installer/bootstrap/*.mjs` explicitly log "Git was not invoked; dependencies were not installed; production DB was never selected by default." `guardedDbMigration()` is opt-in (`--apply-db-migrations`), requires `--db/--db-user/--migration/--db-backup/--confirm-db-name`, refuses `NEVER_MIGRATE_DB_NAMES` (`prod`, `production`, `live`, `main`, …), and permits only strictly additive `CREATE INDEX IF NOT EXISTS` migrations. **No `git push`, no automatic production migration, no `rm -rf`/`Invoke-Expression`/`curl | iex`.** ✅
- **`scripts/maintenance/uninstall.mjs`** — no DB rollback, warns "Never restore over production." ✅
- **Top-level `scripts/*.ps1`, `scripts/phase*.mjs`, root `*.py`, `dashboard/`** (outside declared surface) — secret-shape scan produced **no hits**. ✅ (scope caveat in F-3)

---

## 7. Database dumps / transcripts / private memory records (task item 6)

- `init/*.sql` are **26 schema migrations** (`CREATE TABLE`/`ALTER`/index DDL), not data dumps.
- Only one `INSERT INTO` statement exists (`init/002-phases-6-8.sql:93`): an idempotent bootstrap `INSERT … SELECT … FROM audit_log … AND NOT EXISTS (SELECT 1 FROM learning_activity)`. It contains **no literal private records or personal data**.
- No `*.sql.err` file exists outside the ignored `backups/`/`logs/` trees.
- No transcript, `*.dump`, `*.db`, `*.sqlite`, `*.pem`, `*.key`, or `*.pfx` file exists in the candidate surface.
- The real `.env` (986 bytes) and all `data/`, `backups/`, `checkpoints/`, `logs/`, `reports/` content are excluded by `.gitignore`.

**Conclusion:** No database dump, transcript, or private memory record would be staged from the declared candidate surface. ✅

---

## 8. Findings requiring remediation (not applied — read-only)

**F-1 — Hardcoded personal Windows user-home path in 9 candidate files (MEDIUM).**
Nine files embed a real operator-specific path (`C:\Users\<operator>\...`) as a default DB/config location:
- `engine/src/agentRegistry.js:19` (path built from `"Users", "<operator>", ".config", "opencode", "opencode.json"`)
- `engine/src/automation.js:21`, `engine/src/importer.js:14`, `engine/src/projectIdentity.js:11`, `engine/src/roles.js:77`, `engine/src/session-worker.js:9` (default `HARNESS_OPENCODE_DB` / `opencode_db` = `C:\Users\<operator>\.local\share\opencode\opencode.db`)
- `engine/test/phase9.test.js:11`, `engine/test/phase10.test.js:13`, `engine/test/reliability.test.js:10` (hardcoded `DB` constant)

*Needed remediation:* replace with an environment-variable-only lookup and a portable/generic fallback (e.g. `process.env.HARNESS_OPENCODE_DB` with no personal default, or a clearly synthetic placeholder), in both `engine/src` and the three tests. This removes the operator name and personal path from the public surface.

**F-2 — Sanitized `logs/public-release/*.md` are currently unpublishable (LOW / process).**
`logs/public-release/` contains 7 sanitized Markdown candidates (`compatibility-matrix.md`, `final-release-report.md`, `github-publication-report.md`, `installation-test-report.md`, `release-audit.md`, `security-review.md`, `staging-plan.md`) plus `checkpoint-ts.txt` and `tests-output.txt`. Because `.gitignore` has a blanket `logs/` rule with no negation, **these files would NOT be staged** by `git add .`.
*Needed remediation:* if these sanitized reports are intended for publication, copy them to a non-ignored public docs path or add a narrow negation (`!logs/public-release/*.md` plus `!logs/` parent re-inclusion) after re-scanning them. Do not publish raw `logs/` content.

**F-3 — Scope gap: unignored files outside the declared candidate surface (LOW).**
`scripts/*.ps1` (backup/restore/configure-harness-llm/start-dashboard), `scripts/phase20–23*.mjs`, root `calc.py`/`test_add.py`/`test_multiply.py`, and `dashboard/` are **not** in `.gitignore` and would be included by a broad `git add .`. They were secret-shape scanned (no hits) but were not semantically reviewed as part of the declared surface.
*Needed remediation:* parent session should explicitly decide include/exclude for these files before staging; prefer explicit file selection over `git add .`.

---

## 9. Remediation performed

**Applied by the parent session after this audit (2026-11-26):**

- **F-1 REMEDIATED.** Replaced the hardcoded operator home path with portable `os.homedir()`-derived defaults in all 9 files: `engine/src/{agentRegistry,automation,importer,projectIdentity,roles,session-worker}.js` and `engine/test/{phase9,phase10,reliability}.test.js`. These now use `process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")` (agent config uses `path.join(os.homedir(), ".config", "opencode", "opencode.json")`). A full candidate-surface rescan found **0** remaining operator-specific home-path occurrences. Syntax checks pass on all 9 files.
- **F-2 REMEDIATED.** `.gitignore` now un-ignores `logs/public-release/` and `logs/public-release/*.md` while keeping all other logs ignored, so sanitized reports can be staged explicitly.
- **F-3 ADDRESSED BY PROCEDURE.** `logs/public-release/staging-plan.md` stages by explicit path list (never `git add .`); `scripts/*.ps1`, `phase*.mjs`, root `*.py` and `dashboard/` are excluded from the public set.
- CI hardening: `ci.yml` now dry-runs the real `installer/bootstrap/install.mjs`, runs the public-release suite as a gate, and syntax-checks installer/uninstaller `.mjs` files. `INSTALL.md` stale "being completed" text corrected.

No real credentials were found or introduced by these edits.

---

## 10. Final staging security result

| Check | Result |
|---|---|
| `.gitignore` completeness | PASS |
| Secret scan (real secrets) | **PASS** — 0 verified real secrets; 115 hits explained as false positives / labeled synthetic canaries |
| `.env.example` placeholders only | PASS |
| CI workflows (no creds / no publish jobs) | PASS |
| Installer (no git push / no prod migration) | PASS |
| No dumps / transcripts / private memory staged | PASS |
| No Git history to audit | CONFIRMED (none) |
| Personal path leakage | **PASS — F-1 remediated (0 remaining occurrences)** |
| Sanitized report publish path | **PASS — F-2 remediated (explicit .gitignore negation)** |
| Scope coverage | **PASS — F-3 addressed by explicit staging plan** |
| Final staging security result (post-remediation) | **PASS — no verified real secrets, no personal paths, no private data in the candidate set** |

**Staging security verdict: CONDITIONAL / HOLD for publication.** The candidate surface contains **no real credentials** and no database dumps, but **F-1 (hardcoded operator path in 9 files) must be remediated before public staging**, and F-2/F-3 decisions must be made by the parent session. This auditor did not publish, stage, or commit anything.

---

## 11. Unresolved risks

1. **F-1** remains open — operator name/path still present in 9 files until parent session edits them.
2. **F-2** — intended publication status of `logs/public-release/*.md` is unresolved; blanket ignore currently blocks them.
3. **F-3** — semantic review of unignored non-candidate scripts and `dashboard/` is incomplete.
4. Regex secret scanning cannot prove absence of novel/obfuscated secret formats; a stricter local `gitleaks` run is recommended before the actual publish commit (the repo's own `secret-scan.yml` notes this).
5. Because no Git repository exists, there is no history scan; a fresh `git init` would create a brand-new history whose first commit must be re-audited at staging time.

---

## 12. Phase 28 conditional-readiness statement (preserved)

This audit does **not** assert universal production readiness. Publication readiness remains **conditional** on the Phase 28 hardening gates and the remediation items above. The engine is deterministic by default (`HARNESS_SEMANTIC_LLM=0`, `OPTIMIZATION_LEVEL=1`), CI keeps `permissions: contents: read`, and the legacy full test suite is explicitly informational rather than a fabricated release gate. Any claim of general production readiness must be re-verified against the isolated staging database and the parent session's final checklist; nothing in this report should be read as a blanket "ready for production" certification.
