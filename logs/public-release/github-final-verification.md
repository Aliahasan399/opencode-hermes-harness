# GitHub Final Verification Report — OpenCode Harness

Date: 2026-11-26. Status: **pre-publication verification complete; remote verification NOT APPLICABLE (nothing published)**.

## Local verification actually performed
| Check | Command / evidence | Result |
|---|---|---|
| GitHub identity | `gh auth status`, `gh api user --jq .login`, `gh api user/orgs` | `Aliahasan399`, personal User, no orgs; scopes `gist`, `read:org`, `repo`, `workflow`; no token printed |
| Repo-name availability | `gh api repos/Aliahasan399/opencode-hermes-harness` and `.../opencode-memory-harness` | both HTTP 404 (available); no repo created |
| Git state | `git rev-parse --is-inside-work-tree` | not a repository; no history, no remote |
| Safety settings | read `.env` keys | `OPTIMIZATION_LEVEL=1`, `HARNESS_SEMANTIC_LLM=0` unchanged |
| Public-release tests (root cwd) | `node --test test/public-release/*.test.js` | **exit 0 — 25 tests, 24 pass, 0 fail, 1 deliberate skip** |
| Targeted regression after source remediation | `node --test test/phase9.test.js test/phase10.test.js test/reliability.test.js` (engine cwd) | 38 tests, 37 pass, 1 known phase10 test-data-pollution failure (not caused by edits) |
| Syntax | `node --check` on 9 remediated src/test files + all installer/uninstaller `.mjs` | all pass |
| Installer dry-run | `node installer/bootstrap/install.mjs --target <temp> --capabilities memory,learning,agents --dry-run` | exit 0, no files written, repeated plans identical |
| Secret/personal-path scan | candidate public surface (302 files) | 0 real secrets; F-1 personal path remediated to 0 occurrences |
| Security audit | `github-security-audit.md` | PASS after F-1/F-2/F-3 remediation |
| Docs/CI audit | `github-ci-report.md` | CI defects fixed (correct installer path, public-release test gate, extended syntax checks) |
| Documentation link check / CI YAML | auditor replayed docs-check + parsed 3 workflows with js-yaml | pass; YAML parse verified |

## Remote verification (Stage J) — NOT PERFORMED
Correct owner, repository name, visibility, default branch, commit, license visible, README render,
docs/CI presence, no published secrets, clone verification: **all NOT APPLICABLE** because no
repository was created and no push occurred.

## Publication gate — exact owner decisions still required
1. Repository identity: owner (`Aliahasan399` verified) + name (suggestion `opencode-hermes-harness`) + visibility (public requested).
2. License selection: MIT / Apache-2.0 / GPL-3.0 / AGPL-3.0 / private (`LICENSE.decision.md`), plus copyright holder/year.
3. Explicit authorization to run `git init`, create the remote, commit and push.
4. Sign-off on the sanitized public file set (`staging-plan.md`).

## Safety confirmation
No destructive operation, no Git operation, no dependency change, no provider/config change, no
safety-level change, no approval bypass, no project-isolation change, no publication. Phase 28
conditional-readiness statement preserved throughout.
