# GitHub Publication Staging Plan (prepared; not executed)

Date: 2026-11-26. Status: **prepared only — Git repository not initialized** (publication gated on owner decisions: repository identity and license).

## Inclusion set (reviewed candidates)
| Path | Files | Notes |
|---|---|---|
| Root docs/config | 11 | README, INSTALL, QUICKSTART, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, LICENSE.decision.md, .env.example, .gitignore, docker-compose.yml |
| `init/` | 26 | migrations 001–026 (additive) |
| `engine/src/` | 112 | engine modules |
| `engine/test/` | 90 | test suites |
| `plugin/` | 1 | memory.ts (contains host-specific paths documented as must-edit) |
| `docs/` | 24 | public documentation + examples + development guides |
| `installer/` | 9 | bootstrap/validation/templates |
| `integrations/` | 9 | opencode / generic-mcp / adapters |
| `examples/` | 4 | configuration / project-setup / workflows |
| `scripts/setup|diagnostics|maintenance/` | 4 | setup.ps1, setup.sh, doctor.mjs, uninstall.mjs |
| `.github/` | 9 | 3 CI workflows, dependabot, issue templates, PR template, funding |
| `test/public-release/` | 4 | public-release tests |
| `logs/public-release/*.md` | 6 | sanitized reports only (raw logs excluded) |
| **Total candidate files** | **~300** | exact count confirmed at staging time |

## Exclusion set (must never be staged)
- `.env` (real values, including DB password) — `.gitignore` covers it.
- `backups/` (166 files, ~14 GB of DB dumps), `checkpoints/` (18+ dirs incl. `publicrelease-final-20261126-102947`), `data/` — `.gitignore` covers them.
- `logs/` except `logs/public-release/*.md` — raw logs contain local paths/session ids.
- `reports/` (internal) — `.gitignore` covers it.
- `node_modules/`, `dist/`, `__pycache__/`, `.pytest_cache/`, `*.pyc`, `*.sql.err`, `.DS_Store`.
- Root scratch files `calc.py`, `test_add.py`, `test_multiply.py` (development-only).
- Any GitHub credentials, tokens, private keys, database dumps, transcripts, or user data.

## Planned Git steps (ONLY after owner decisions)
1. Verify cwd is `E:\OpenCodeData\memory` and no nested repo exists.
2. `git init -b main` (only if no repo exists).
3. Stage explicitly by path from the inclusion set (not `git add -A`).
4. `git status` + staged file list + staged diff review.
5. Staged secret/sensitive-file scan; verify no excluded file is staged.
6. Commit with a meaningful message (e.g. `docs: prepare public release of OpenCode Harness`).
7. Create repo under the **confirmed owner** with the **confirmed name** and visibility.
8. Add remote from the verified URL, verify remote before push, push `main`.
9. Independently verify the remote (clone to isolated temp dir, inspect structure).
10. Save the five required GitHub reports.

## Decisions required before executing
- Repository owner and name (suggestion: `opencode-hermes-harness` under `Aliahasan399` — name availability confirmed, **not** authorization).
- Visibility (public requested).
- License selection (MIT / Apache-2.0 / GPL-3.0 / AGPL-3.0 / other) + copyright holder/year.
- Explicit authorization to run `git init`, create the remote, commit and push.
