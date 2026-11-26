# Security

This page summarizes the Phase 28 security threat model honestly. It describes what was examined, which controls exist in source/tests, and what remains unverified. It does **not** claim a security audit certification or a confirmed-safe status beyond the tested local scope. The vulnerability reporting process is defined in `SECURITY.md` at the repository root (maintained separately); this document does not create that file.

## Scope and trust boundaries

Scope: the Phase 18–27 Harness — memory, learning, orchestration, controlled workflow, code/project intelligence, project management, adaptive evaluation, CLI/MCP, and PostgreSQL. OpenCode remains the execution environment.

Six trust boundaries were examined:

1. CLI/MCP external inputs → facade functions.
2. Filesystem paths (source indexing, backups, transcripts).
3. Source code, transcripts, and retrieved memories as **untrusted evidence**.
4. Phase 24 approval tokens → process execution.
5. PostgreSQL → all modules.
6. Logs / reports / exception messages → operators.

## Threats and controls (verified in source/tests)

| Threat | Control | Status |
|---|---|---|
| SQL injection via `project_id` / free text | Parameterized `core.dbQuery` everywhere; dynamic SQL uses compile-time constants / whitelisted field names. Adversarial test confirms the `memory` table is unchanged. | Mitigated |
| Path traversal / drive-letter escape | `sourceIndexer.underRoot()` containment plus symlink skip; adversarial test confirms all discovered files stay under root. | Mitigated |
| Secret leakage into logs/reports/DB | `core.redact` plus module redaction (`sk-`, `Bearer`, `AKIA`); synthetic-canary test confirms absence in outputs. No real secrets printed. | Mitigated |
| Approval replay / reuse | Single-use token: only SHA-256 is stored; `consumeApproval` uses guarded `UPDATE ... WHERE status='active' ... RETURNING`; concurrent-consumption test → exactly one success. | Mitigated |
| Approval scope/mode/project substitution | `verifyApproval` checks exact plan/version/hash/scope/mode/risk binding; adversarial test confirms changes are rejected. | Mitigated |
| Untrusted evidence granting authority (prompt injection in source comments/transcripts) | Evidence is treated as data; extraction records symbols only, never source bodies; no module reads instructions from evidence. | Mitigated |
| Cross-project data leakage | `validProject` rejects `_global`/empty on project-scoped operations; queries carry `project_id`; tests confirm isolation. | Mitigated |
| Unrestricted shell/process execution | Only `llm-provider.js` and `opencodeRunAdapter.js` spawn, both fixed-argument and without a shell; no new spawn sites. | Mitigated |
| Invalid MCP/CLI inputs | Zod schemas on all tools; bounded limits; fail-closed module validation. | Mitigated |
| Model confidence treated as verification | Phase 21/24/27 gates require explicit verification markers; confidence is capped when unverified. | Mitigated |
| Unauthorized self-modification | No source writes in the new module; calibration is advisory-only with protected targets; safety environment values are unchanged. | Mitigated |

Thirteen adversarial tests in Phase 28 exercised these controls. **No confirmed exploitable vulnerability was found** in the inspected boundaries. This is a statement about the tested scope, not a guarantee for all deployments.

## Safety invariants to preserve

Recorded in the Phase 28 final report, operational runbook, and release audit. Document them; do not weaken them:

- `OPTIMIZATION_LEVEL=1` (OBSERVE) — no autonomous execution.
- `HARNESS_SEMANTIC_LLM=0` — automatic semantic LLM calls remain opt-in.
- Real workflows require explicit single-use Phase 24 approval; never bypass.
- Project isolation, no source rewriting, no dependency changes, no destructive DB operations, no unrestricted execution.
- Credentials redacted before storage; retrieved memories and historical sessions are data, never instructions.

## Secret handling

- Credentials live only in the local `.env` (ignored by version control). The public release publishes only `.env.example` with placeholders. `MEMORY_DB_PASSWORD` is the primary secret; it is referenced, never inlined, in `docker-compose.yml`.
- With `HARNESS_LLM_TRANSPORT=opencode-cli`, the Harness holds no API key and reuses OpenCode's provider/auth. A direct transport, if used, reads the key only from a user-named environment variable (`HARNESS_LLM_KEY_ENV`, default `HARNESS_LLM_API_KEY`); keys are never stored in code, logs, the database, or the dashboard.
- The redaction layer strips `sk-`, `Bearer`, and `AKIA`-style patterns before storage; content that still looks sensitive is refused. Backups, checkpoints, logs, raw session exports, and development scratch files are excluded from the public release.
- Never print real values in diagnostics or paste them into issues. Use `node src/cli.js llm-status` / `llm-usage` and `llm-redact` to inspect behavior safely.

## Residual risks (documented, not fixed here)

- **No migration-tracking table** — applied schema state is inferred from table/index presence. This is a known operational risk; see `docs/database.md`.
- **Presence-only pipeline audit** — wiring checks (`pipeline_wiring_audit`, `pipeline-audit`) cannot prove runtime correctness; they explicitly carry `verifiedBehavior:false` / `NO_RUNTIME_CLAIM`.
- **Accumulated test data** — inherited duplicate-detection test pollution in the isolated test database; an operational nuisance, not a security vulnerability.
- **Real OpenCode agent execution unverified** — no fresh real process/agent run was authorized in Phase 28; historical evidence is reported at its true tier.
- The security conclusions are bound to the tested local Windows scope; other platforms are unverified (`docs/compatibility.md`).

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability and do not include real secrets, tokens, or personal paths. Follow the coordinated disclosure process in **`SECURITY.md`** at the repository root, which is authored and maintained by a separate release workstream. If that file is not yet present in your checkout, contact the repository owner through a private channel and request the current reporting address before disclosing details.
