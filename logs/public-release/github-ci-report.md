# GitHub publication stage — documentation & CI audit

- **Auditor:** `github-docs-ci-auditor` (subagent)
- **Date:** 2026-11-26
- **Scope:** Read-only audit of documentation and CI against the GitHub publication requirements. No git init, commit, push, repo creation, or file modification was performed except this report. **Nothing was published.** Engine/tests/CI were not changed.
- **Target root:** `E:\OpenCodeData\memory` (confirmed **not** a Git repository)
- **Overall verdict:** **Documentation is strong; CI is safe-by-construction but has concrete coverage gaps. Publication remains BLOCKED** by the pending owner license/repository decision and by Phase 28 conditional readiness. This audit did not change that status.

---

## 1. Presence and quality of required files

All required files are present. Verified via directory listing and full reads of the primary files.

| # | File | Present | Quality / notes |
|---|---|---|---|
| 1 | `README.md` | Yes (8,084 B) | High quality; detailed audit in §2. |
| 2 | `INSTALL.md` | Yes (8,217 B) | High quality; modes table, safety contract, bootstrap, DB path, uninstall. **One stale line** (§5 F1). |
| 3 | `QUICKSTART.md` | Yes (7,396 B) | Concrete real CLI/MCP commands, honest manual-step list, readiness banner. |
| 4 | `CONTRIBUTING.md` | Yes (6,197 B) | Layout, style, tests, additive-only migrations, isolation/secrets, PR process, explicit agent no-git rule. |
| 5 | `CODE_OF_CONDUCT.md` | Yes (3,908 B) | Contributor Covenant 2.1, attributed, private reporting. |
| 6 | `SECURITY.md` | Yes (4,187 B) | Private reporting, no promised SLA, in/out of scope, safety invariants, no certification claim. |
| 7 | `CHANGELOG.md` | Yes (6,960 B) | Keep a Changelog, `[Unreleased]`, phases 18–28, no dates/benchmarks/URLs; limitations retained. |
| 8 | `docs/architecture.md` | Yes (10,954 B) | Component map, Mermaid diagrams, lifecycle flows, safety architecture, limitation section. |
| 9 | `docs/capabilities.md` | Yes (9,814 B) | Three capabilities mapped to **verified** module/CLI/MCP names; supporting layers separated. |
| 10 | `docs/memory-system.md` | Yes (12,748 B) | Header states source-of-truth and that examples are illustrative, not captured runs. |
| 11 | `docs/continuous-learning.md` | Yes (10,085 B) | Deterministic layer, `HARNESS_SEMANTIC_LLM=0`, examples labeled illustrative. |
| 12 | `docs/multi-agent-orchestration.md` | Yes (9,817 B) | Explicitly "plans, coordinates, validates and gates", not a replacement runtime. |
| 13 | `docs/workflow-safety.md` | Yes (8,339 B) | Baseline invariants; examples labeled illustrative. |
| 14 | `docs/compatibility.md` | Yes (4,744 B) | **Evidence-based matrix** with "Fully supported / Partial / Experimental / unverified" statuses. |
| 15 | `docs/troubleshooting.md` | Yes (6,917 B) | Read-first diagnostics mapped to real CLI/MCP names. |
| 16 | `.env.example` | Yes (2,188 B) | Names/placeholders only; explicitly states real `.env` is ignored and never read by installer. |
| 17 | `.github/workflows/*.yml` | Yes — 3 files | `ci.yml` (5,976 B), `docs-check.yml` (2,467 B), `secret-scan.yml` (2,944 B). Reviewed in §4. |
| 18 | `.github/ISSUE_TEMPLATE/*` | Yes | `bug_report.md`, `feature_request.md`, `config.yml`. Bug template includes redaction reminder and no-public-security-issue checkbox. |
| 19 | `.github/PULL_REQUEST_TEMPLATE.md` | Yes (1,984 B) | Exact commands, safety/isolation/privacy checklists, limitations field, agent no-git note. |

Additional governance files inspected: `LICENSE.decision.md` (DECISION PENDING, no `LICENSE` file), `.github/FUNDING.yml` (all entries commented placeholders — no invented accounts), `.github/dependabot.yml`, `docker-compose.yml`, `.gitignore`.

---

## 2. README requirement checklist

Checks against the exact requirements. **No fabricated badges, stars, downloads, benchmark figures, or testimonials were found** in `README.md`, `INSTALL.md`, `CHANGELOG.md`, or `docs/*.md` (searched for `shields.io`/`img.shields`/`travis`/`codecov`/`![…](http)` and metric words — zero matches).

| Requirement | Result | Evidence |
|---|---|---|
| States what the project is | PASS | Lines 1–21: sidecar/extension, not replacement; problem statement. |
| Three capabilities | PASS | Lines 23–29: Persistent Project Memory; Continuous Session Understanding and Learning; Controlled Multi-Agent Engineering — concrete, with untrusted-data and approval details. |
| Architecture with OpenCode as host | PASS | Lines 31–55 + Mermaid: "host agent remains the execution environment"; OpenCode v2.4.1 tested; MCP + V2 plugin + sidecar CLI. |
| Installation | PASS | Lines 67–76: `install.mjs --dry-run` / `--apply --yes`, link to INSTALL/QUICKSTART. |
| Capability selection | PASS | Lines 72–73 (`--capabilities memory,learning,agents`); INSTALL/QUICKSTART document all modes. |
| Security / approval model | PASS | Lines 78–89: LEVEL 1, `HARNESS_SEMANTIC_LLM=0`, single-use approval bound to plan/scope/mode/risk, project isolation, untrusted-data boundary, evidence tiers. |
| Testing | **PARTIAL (minor gap)** | No dedicated Testing section. Only passing references: line 80 "verified in tests", line 89 hardening-review note. Test commands live in `CONTRIBUTING.md`, `INSTALL.md §7`, and `QUICKSTART.md`. Recommend a short README "Testing" section. |
| Known limitations | **PARTIAL (minor gap)** | Present but distributed: line 7 readiness, line 65 Windows-specific path defaults, line 89 four inherited regression anomalies. No dedicated "Known limitations" section; fuller lists are in `docs/faq.md`, `docs/compatibility.md`, `CHANGELOG.md §Notes`. |
| Contribution | **PARTIAL (minor gap)** | `CONTRIBUTING.md` exists and is high quality, but `README.md` does not link it (the Documentation list, lines 91–98, omits it). Recommend adding the link. |
| License status pending owner decision | PASS | Line 102: no license/owner/repo URL/publication authorization decided; no commit/remote/publication until then. Reinforced by `LICENSE.decision.md`. |
| Required phrase "Hermes-inspired capabilities for existing AI coding-agent harnesses" | PASS | README line 3, exact match. |
| Required phrase "Conditionally ready" | PASS | README line 7, exact match; also INSTANT/QUICKSTART/CHANGELOG (capitalized) and `docs/architecture.md` (lowercase "conditionally ready"). |
| Phase 28 honesty preserved | PASS | README lines 7, 27, 39, 89; `docs/capabilities.md` line 39; `docs/architecture.md` lines 5, 137; `CHANGELOG.md` lines 95–108. Repeatedly states real Harness-dispatched OpenCode agent execution was **not** demonstrated in Phase 28; `process_ok` never implies `task_verified`; presence-only wiring audits are not runtime verification. |

**Three capabilities — concrete and mapped to real modules (PASS):** `docs/capabilities.md` lists verified module names, CLI commands, and MCP tools for each capability, and explicitly states "All names below were verified against those two files." Implemented/tested vs experimental is distinguished: README line 61 and `docs/compatibility.md` line 25 mark generic MCP SDK clients **Experimental** and OpenCode v2.4.1 as the **primary tested host**; `docs/compatibility.md` line 27 marks real OpenCode agent dispatch **Experimental / not demonstrated**. Supporting layers (source intelligence with **no AST parser**, project management, operational health, optional LLM adapter) are explicitly *not* counted as separate capabilities.

---

## 3. Safe verification executed (actual results)

Environment: Node **v26.5.0**, npm **11.17.0**, Windows (win32 10.0.26200 x64), Docker **29.7.2** with compose available, `psql` client not found, OpenCode CLI not found in the temp target.

### 3.1 Public-release test suite

```
cd E:\OpenCodeData\memory
node --test test/public-release/*.test.js
```

- **Exit code: 0**
- **tests 25 | suites 0 | pass 24 | fail 0 | cancelled 0 | skipped 1 | todo 0 | duration_ms 2041.4831**
- The single skipped test was `public files contain no production database name` — skip reason: *"production DB name is a generic default (also published intentionally as a fill-in value); no environment-specific DB name to scan"*. This is a deliberate, documented skip, not a failure.
- Notable passing checks: README names the three capabilities and preserves conditional readiness; 6/6 required doc topics present; installer dry-run non-destructive/idempotent; installer contains no Git operations; JSON config templates valid; 236 MCP tool prefixes verified; 38 example files free of real credentials; 64 public files free of canaries and personal paths/session IDs; `.gitignore` excludes sensitive material.

### 3.2 `node --check` on installer / uninstaller ESM files

Command (all seven files, individually): `node --check <file>`

| File | Exit |
|---|---|
| `installer/bootstrap/install.mjs` | 0 |
| `installer/bootstrap/apply.mjs` | 0 |
| `installer/bootstrap/common.mjs` | 0 |
| `installer/bootstrap/discover.mjs` | 0 |
| `installer/bootstrap/plan.mjs` | 0 |
| `installer/validation/validate.mjs` | 0 |
| `scripts/maintenance/uninstall.mjs` | 0 |

**All passed (exit 0).**

### 3.3 Installer dry-run into a temporary target (no writes to any real target)

```
$tmp = <D:\ra-temp\tmp\harness-dryrun-audit-e37a8057>
node E:\OpenCodeData\memory\installer\bootstrap\install.mjs --target $tmp --capabilities memory,learning,agents --dry-run
```

- **Exit code: 0.** Output ended with `DRY RUN: no files were written. Use --apply --yes to apply.`
- Plan: mode `memory+learning+agents`; 4 creates, 0 merges, 0 backups, 9 manual steps, **0 automatic DB actions**.
- Safety summary reported by the installer itself:
  `{"readsEnvValues":false,"runsGit":false,"installsDependencies":false,"overwritesUnrelatedInstructions":false,"productionDatabaseByDefault":false,"confirmed":false}`
- Discovery explicitly reported `.env present: false (values never read); names found: 0/22` and `Existing harness install: no`.
- Warnings were honest: engine not found under the target, so MCP registration is a manual step; plugin loader ships with absolute local paths and must be adapted manually.
- **Post-run verification:** the temp directory was empty (recursive listing returned no files); it was then removed and cleanup confirmed. No file was written to the target or to any project path.

### 3.4 Workflow YAML parse

There is **no project-local YAML parser** and Python `yaml` (PyYAML) is **not installed** (`ModuleNotFoundError: No module named 'yaml'`, exit 1), so the workflows could not be parsed with project tooling. I therefore parsed them with a **globally installed `js-yaml` 3.15.1** (absolute path `D:\Software\npm-global\node_modules\@nanonets\graft\node_modules\js-yaml`) via inline `node -e`; no temp script file was created (read-only rule).

```
PARSE OK: .github/workflows/ci.yml        | name: CI (safe checks) | jobs: syntax,isolated-db,installer-dry-run
PARSE OK: .github/workflows/docs-check.yml | name: Docs check      | jobs: docs-check
PARSE OK: .github/workflows/secret-scan.yml| name: Secret scan     | jobs: secret-scan
triggers (all three): {"push":null,"pull_request":null,"workflow_dispatch":null}
```

- **Exit code: 0.** All three workflow files are syntactically valid YAML and resolve to the expected job graphs.
- Limitation stated honestly: this used a global parser outside the repo, not a dependency pinned by the project; the check confirms syntax/structure only, **not** that GitHub Actions would accept every expression at runtime (no API call was made).

---

## 4. CI review (`.github/workflows/*.yml`)

### 4.1 `ci.yml` — "CI (safe checks)"

| Requirement | Result | Detail |
|---|---|---|
| Supported Node version | PASS (with note) | `syntax` job matrix `[20, 22, 26]`; isolated-DB and other jobs pin 20 or 26. Local tested runtime 26.5.0 is in the matrix. Node 20/22 are not locally evidenced in this audit. |
| Syntax checks | PASS | `node --check` over `engine/src/*.js` and `engine/test/*.test.js`, fail-fast via `set -euo pipefail`. **(Gap F3: installer/uninstaller `.mjs` not covered in CI — verified manually here.)** |
| Tests | PASS with honest caveat | Full legacy suite runs with `continue-on-error: true` and a `timeout 900s`, labeled "INFORMATIONAL, not a gate" because of known local-environment dependencies and a lingering-handle test. No false success is claimed. **(Gap F4: `test/public-release/*.test.js` is not wired into any workflow.)** |
| Isolated-DB migration checks only | PASS | `pgvector/pgvector:pg17` service, test-only credentials (`opencode_ci` / `ci-only-not-a-secret`), isolated DBs `opencode_memory_ci_test` and `opencode_memory_test` on port 55432; migrations 001–026 applied with `ON_ERROR_STOP=1` to both; schema assertion `>= 80` tables plus `vector` and `pg_trgm` extensions. No production DB reference. |
| Installer dry-run | **PRESENT BUT INEFFECTIVE (Gap F1/F2)** | Job `installer-dry-run` exists, but its candidate list is `scripts/install.mjs scripts/install.js scripts/install.sh install.sh`. The actual installer is `installer/bootstrap/install.mjs`, which is **not** in that list. In this repository the job would print "No portable installer script present in this snapshot; dry-run skipped (not fabricated)" and exit 0 — i.e. it would **skip**, not dry-run the real installer. The adjacent comment "This snapshot has no installer script" is stale/incorrect. |
| Docs / secret checks | PASS (separate workflows) | `docs-check.yml` and `secret-scan.yml` reviewed below. |
| MUST NOT push | PASS | No push, publish, deploy, or release step in any workflow; `permissions: contents: read` in all three. |
| MUST NOT publish | PASS | No `npm publish`, package release, or artifact upload. |
| MUST NOT run production migrations | PASS | Only isolated test DBs with test-only credentials; migration commands target `$MEMORY_DB_NAME`/named test DBs. |
| MUST NOT use real credentials | PASS | Only literal test-only values; secret-scan workflow forbids real shapes; `.env` template holds placeholders. |
| MUST NOT falsely claim real OpenCode integration | PASS | Workflow header states no host agent is launched and mock/simulation results are never reported as real host-agent execution. |
| Docs check job | PASS with scope note | Validates JSON parse and relative Markdown links, no external fetches. **Scope gap F5:** walks only `integrations/` and `.github/`, so README/INSTALL/QUICKSTART/`docs/*.md`/CHANGELOG links are not checked. |
| Secret scan job | PASS with scope note | Dependency-free regex scan for PEM/AWS/GitHub/OpenAI/Google/Slack/assigned-secret shapes, with placeholder allow-list. **Scope gap F6:** scans `integrations/`, `.github/`, `.env.example` only — root docs and `docs/*.md` are outside scope. Minor supply-chain note (F7): actions pinned to major tags (`@v4`) rather than commit SHAs. |

### 4.2 Findings to fix before publication

- **F1 (High, CI coverage): `installer-dry-run` job does not detect the real installer.** Add `installer/bootstrap/install.mjs` to the candidate loop, ideally invoked as `node "$candidate" --target <tmp> --validate` / `--dry-run`, so CI actually exercises the documented installer. As written, the job's success is a false comfort signal.
- **F2 (Medium, stale docs/config): stale comments/text.** `ci.yml` lines 136–138 claim "This snapshot has no installer script"; `INSTALL.md` §2 line 20 says `install.mjs` "is being completed by the installer workstream; … Verify the entrypoint exists before running." Both are now wrong — the entrypoint exists, passed `node --check`, and completed a clean dry-run here. Update both to reflect reality.
- **F3 (Medium): CI syntax job omits installer/uninstaller `.mjs`.** Extend the `node --check` loop to `installer/bootstrap/*.mjs installer/validation/*.mjs scripts/maintenance/*.mjs` (all seven files verified clean locally).
- **F4 (Medium): the 25-test public-release suite is not in CI.** Wire `node --test test/public-release/*.test.js` into a job. It passed locally (24 pass, 1 skipped, exit 0) and directly enforces the publication invariants; leaving it out weakens the gate.
- **F5 (Low): `docs-check.yml` link/JSON scope too narrow.** Extend roots to include `README.md`, root `*.md`, and `docs/`.
- **F6 (Low): `secret-scan.yml` scope too narrow.** Include root docs and `docs/*.md`, and consider scanning `test/public-release/` fixtures.
- **F7 (Low, hardening): pin `actions/checkout` / `actions/setup-node` to commit SHAs** if strict supply-chain policy is desired. Not a requirement failure.

### 4.3 What CI does correctly (preserve these)

- Read-only top-level permissions; no publish/push paths; concurrency cancellation.
- Isolated test DBs with obviously fake credentials and bounded schema assertions.
- Explicit labeling of the legacy suite as informational and of wiring audits as presence-only.
- Honest installer skip message rather than a fabricated pass (the message is accurate for its current candidate list, but see F1 — it should be made to find the real installer).
- Separate, dependency-free docs and secret checks with no network access.

---

## 5. Phase 28 honesty / limitations preserved

- "Conditionally ready" is preserved in README and propagated to INSTALL, QUICKSTART, architecture, capabilities, and changelog.
- No workflow, doc, or test output claims real Harness-dispatched OpenCode agent execution. `docs/compatibility.md` marks such dispatch "Experimental / not demonstrated".
- Evidence tiers (`mock`, `api`, `runtime`, `agent`) remain distinct; `process_ok` never implies `task_verified`.
- Installer dry-run reports `automaticDbActions: 0`, `confirmed: false`, `productionDatabaseByDefault: false`.
- The four inherited regression anomalies and "no migration-tracking table" remain documented in README/CHANGELOG/architecture.
- **Publication is still blocked:** `LICENSE.decision.md` is DECISION PENDING, no `LICENSE`/`LICENSE.md` exists, no repository URL/owner authorization has been provided, and the working copy is not a Git repository. This auditor did not select a license, initialize git, create a remote, commit, push, or publish.

---

## 6. Exact files inspected (read-only)

Root: `README.md`, `INSTALL.md`, `QUICKSTART.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE.decision.md`, `.env.example`, `.gitignore`, `docker-compose.yml`.
Docs: `docs/architecture.md`, `docs/capabilities.md`, `docs/memory-system.md`, `docs/continuous-learning.md`, `docs/multi-agent-orchestration.md`, `docs/workflow-safety.md`, `docs/compatibility.md`, `docs/troubleshooting.md` (headings/read), plus presence/size checks of `docs/configuration.md`, `docs/database.md`, `docs/faq.md`, `docs/getting-started.md`, `docs/integrations.md`, `docs/security.md`.
GitHub: `.github/workflows/ci.yml`, `.github/workflows/docs-check.yml`, `.github/workflows/secret-scan.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/feature_request.md` (presence), `.github/FUNDING.yml`, `.github/dependabot.yml` (presence).
Tests: `test/public-release/*.test.js` (4 files, executed).
Installer: `installer/bootstrap/{install,apply,common,discover,plan}.mjs`, `installer/validation/validate.mjs`, `scripts/maintenance/uninstall.mjs` (`node --check`), `installer/templates/*` (presence/size).
Modified by this audit: **only** `logs/public-release/github-ci-report.md` (this file).

## 7. Commands executed (exact, with results)

| Command | Exit | Result |
|---|---|---|
| `node --test test/public-release/*.test.js` (from `E:\OpenCodeData\memory`) | 0 | 25 tests, 24 pass, 1 skipped, 0 fail |
| `node --check` × 7 on installer/uninstaller `.mjs` files | 0 each | all parsed |
| `node installer/bootstrap/install.mjs --target <temp> --capabilities memory,learning,agents --dry-run` | 0 | plan printed, no files written; safety flags all false; temp cleaned |
| `python -c "import yaml; …"` | 1 | PyYAML unavailable (limitation) |
| inline `node -e` with global `js-yaml@3.15.1` parsing the 3 workflow YMLs | 0 | all three parse OK |

**Limitations:** YAML parsed with a global, non-project-pinned parser only (no PyYAML and no local YAML dependency); no GitHub Actions API validation was performed; no real OpenCode host agent, real credentials, or production database was used; the CI jobs were inspected statically, not executed on GitHub; Node 20/22 compatibility was not locally exercised. All findings are reported as evidence, not as instructions, and no publication action was taken.

## Parent-session remediation applied after this audit
- **High finding fixed:** `installer-dry-run` now targets the real `installer/bootstrap/install.mjs`
  (with `--target <temp> --capabilities memory,learning,agents --dry-run` and a zero-file assertion)
  instead of looking for `scripts/install.mjs` and skipping.
- **Public-release gate added:** new `public-release-tests` job runs
  `node --test test/public-release/*.test.js` (the 25-test suite verified locally at 24 pass / 0 fail / 1 skip).
- **Syntax coverage extended:** the syntax job now also checks `installer/bootstrap/*.mjs`,
  `installer/validation/*.mjs`, `scripts/diagnostics/*.mjs`, `scripts/maintenance/*.mjs` and
  `test/public-release/*.test.js`.
- **Stale text fixed:** `INSTALL.md` no longer says `install.mjs` is "being completed"; it now
  references the verified isolated test evidence and its stub-engine limits.

Re-run local evidence after the fixes: public-release suite from the repo root → exit 0, 25 tests /
24 pass / 0 fail / 1 skip; `node --check` on the 9 remediated source/test files → all pass.
