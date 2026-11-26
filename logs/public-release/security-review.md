# Public Release Security Review — OpenCode Harness

Date: 2026-11-26. Scope: the intended public surface after release-prep agents finished writing
docs, installer, integrations, examples, `.github/`, and `.env.example`.
Evidence: `test/public-release/safety-scan.test.js`, `test/public-release/integration-config.test.js`,
`logs/public-release/release-audit.md`, `logs/phase28-security-threat-model.md`, and
`logs/phase28-final-report.md`. This review is read-only; no Git operations were performed.

## Verdict

**No blocking secret, canary, Git-operation, or personal-path finding in the candidate public
files.** Readiness remains **conditional**, not production-ready: see "Residual risks" below and
the Phase 28 readiness assessment (`phase28-final-report.md` §J). Publication is still blocked by
the owner decisions listed in `github-publication-report.md`.

## What was scanned and what passed

Final run: `node --test *.test.js` in `test/public-release/` — 25 tests, 24 pass, 0 fail, 1 skip.
Security-relevant assertions:

| Check | Result | Evidence |
|---|---|---|
| Synthetic canaries / secret fixtures in public files | PASS — 64 files scanned, 0 hits | `safety-scan.test.js` canary list taken from Phase 18-28 adversarial tests (synthetic `sk-`/`Bearer`/`AKIA` shaped fixtures and `P20SEC_CANARY_`, etc.; none are real credentials) |
| Real credentials in example files | PASS — 38 files scanned, 0 hits | `integration-config.test.js`: `sk-` (16+ chars), `Bearer` (20+ chars), `AKIA` + 16 chars, and non-placeholder `password=` values. `.env.example`, `integrations/**`, `examples/**`, `docs/**` covered. |
| Git operations in installer | PASS — 9 installer files scanned, 0 hits | Both `installer.test.js` and `safety-scan.test.js` check `git init/add/commit/push/...` and spawn/exec of `git`. |
| Personal/real filesystem paths and session ids | PASS — 64 files scanned, 0 hits | Only the documented repo root `E:\OpenCodeData\memory` is allowed; escaped TypeScript strings are normalized before comparison; `C:\Users\`, `/home/<user>/`, `/Users/<user>/`, and `ses_*` ids are rejected. |
| `.gitignore` sensitive entries | PASS | `.env`, `backups/`, `logs/`, `checkpoints/`, `data/`, `node_modules/` all present. |
| JSON config templates | PASS | 3 `.json` files and 10 fenced `json` blocks parsed; snippets are accepted by wrapping as an object/array. |
| MCP tool-name surface | PASS | 236 `s.tool(...)` registrations in `engine/src/server.js`; all snake_case, no duplicates; `memory_`, `learning_`, `project_`, `workflow_`, `code_`, `pm_`, `adapt_`, `agent_` prefixes and `ops_health` present. |
| Production database name in public files | SKIPPED (explicit reason) | The value in `.env` is the generic default `opencode_memory`, which the integration docs intentionally publish as a fill-in value. It is not an environment-specific identifier; no environment-specific DB name was available to scan. |

## Secrets and sensitive material excluded from the public surface

- `.env` (real values, including `MEMORY_DB_PASSWORD`) remains untracked and git-ignored; the
  public tests never read its values (only the DB *name*, for a substring check that was skipped).
- `backups/`, `checkpoints/`, `logs/`, `data/`, `node_modules/`, `dist/`, `__pycache__/`,
  `.pytest_cache/` are git-ignored. Sanitized reports under `logs/public-release/` are the only
  log-derived files intended for publication.
- Only a placeholder `.env.example` is published; it contains no credential values.
- `.github/FUNDING.yml` contains commented placeholders only (`# github: [OWNER]`), no real
  sponsor handles.
- The plugin's hard-coded `E:\OpenCodeData\memory\...` constants remain in `plugin/memory.ts`;
  they are disclosed as non-portable and must be edited by the installer (documented in
  `integrations/opencode/plugin-notes.md`). They are a portability issue, not a secret.

## Residual risks (documented, not fixed here)

1. **Conditional readiness preserved.** Phase 28 §J: real OpenCode agent execution was not
   re-demonstrated and requires explicit operator authorization; presence-only audit checks do
   not prove runtime correctness; four inherited regression anomalies remain documented; no
   migration-tracking table exists.
2. **Generic DB name published.** `opencode_memory` is intentionally used as a fill-in default in
   public docs. Acceptable for a public template, but any *environment-specific* rename must be
   re-checked with the safety scan before publication.
3. **Plugin path portability.** `plugin/memory.ts` still contains original-machine Windows paths;
   publication requires the documented edit step, not a claim of out-of-box portability.
4. **Generic MCP hosts** are experimental: tools are callable but host autonomous capabilities are
   not inherited (`integrations/generic-mcp/limitations.md`).
5. **Real `--apply` installation was not executed** by these tests; only dry-run was exercised.
   See `installation-test-report.md`.
6. **License and publication authorization are pending** — source visibility is not reuse
   permission. See `LICENSE.decision.md` and `github-publication-report.md`.

## Conclusion

The candidate public surface passes the automated safety checks. Nothing in this review weakens
the Phase 28 safety defaults (`LEVEL 1`, `HARNESS_SEMANTIC_LLM=0`, single-use approvals, project
isolation, no source rewrite, no auto-approval). Publication remains gated on owner decisions and
on an explicit authorization to initialize Git and push.
