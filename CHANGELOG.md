# Changelog

All notable changes to the OpenCode Harness are documented here. This is an **initial draft** for
the public open-source release. Dates, benchmark figures, and release URLs are intentionally omitted
until the owner confirms the publication plan; no runtime or agent-execution success is claimed here.

The format follows Keep a Changelog conventions. The version below comes from `engine/package.json`
(`0.1.0`).

## [Unreleased]

### Added (preparation only)

- Public-release governance and documentation templates: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, this changelog, and GitHub issue/PR templates.
- `LICENSE.decision.md` recording the pending owner decision on licensing. **No license has been
  chosen; no `LICENSE` file has been created.** Publication remains blocked until that decision is
  made.

### Changed

- `.gitignore` extended to exclude internal state and generated artifacts (checkpoints, reports,
  Python caches, editor/OS metadata, SQL error logs, engine-local dependencies) while preserving all
  existing rules. Only sanitized material is intended for publication.

## [0.1.0 (pre-release preparation)]

Initial aggregated release of the Phase 18–28 capabilities. Every phase below was additive: no
competing engine replaced an existing one, and `LEVEL 1` (`OPTIMIZATION_LEVEL=1`) and
`HARNESS_SEMANTIC_LLM=0` were preserved as the defaults.

### Added

- **Phase 18 — automatic intelligence in the request lifecycle.** Deterministic task
  classification, quality-aware context ranking, a budgeted untrusted-data injection block with
  redaction, and content-free injection auditing. Retrieved memory is explicitly labeled as
  historical, untrusted reference data and cannot override current instructions.
- **Phase 19 — advanced session understanding.** Evidence-graded session experiences, development
  goals and tasks, debugging-experience chains, and an experience store that preserves provenance
  and contradictions. Assistant claims are not treated as verified.
- **Phase 20 — memory lifecycle intelligence.** Explainable importance and freshness signals,
  lifecycle orchestration that is dry-run by default, evidence-preserving consolidation proposals,
  and explicit, auditable version/archive recovery that never deletes.
- **Phase 21 — continuous learning and self-improvement.** Learning records, explicit feedback,
  explainable intelligence, and a recoverable, idempotent learning pipeline that never
  auto-promotes unverified claims.
- **Phase 22 — autonomous agent orchestration intelligence.** Task decomposition, dependency-aware
  coordination, project-scoped context ledgers, file-ownership conflict detection, and
  evidence-required validation. Execution is handed to supported OpenCode interfaces; no competing
  agent runtime is introduced.
- **Phase 23 — proactive project intelligence.** Evidence-backed project health, technical-debt and
  risk findings, test/dependency gap analysis, and lifecycle-managed, non-executing recommendations.
- **Phase 24 — controlled autonomous workflow execution.** Durable workflow state machine,
  single-use approvals bound to project/plan/hash/scope/mode/risk, bounded idempotent dispatch
  through a fixed-argument adapter, read-only monitoring, approval-required recovery, and
  evidence-gated verification. Default mode is `simulation`; `process_ok` never implies
  `task_verified`. Evidence tiers (`mock`, `api`, `runtime`, `agent`) remain distinct.
- **Phase 25 — source-level engineering intelligence.** Bounded content-hash indexing,
  evidence-backed symbol relationships, version-aware change impact, test-link mapping, and
  source-local review findings. A deterministic heuristic extractor records explicit confidence;
  no AST parser was added and unsupported constructs remain unknown.
- **Phase 26 — long-term project management intelligence.** Evidence-gated goals and milestones,
  cross-session continuity briefings by reference, confirmed-only dependencies and blockers,
  explainable drift and next-best-action advice, and honest ownership/recovery states that preserve
  the Phase 24 approval model.
- **Phase 27 — adaptive intelligence evaluation and calibration.** Evaluation and calibration
  modules (`adapt-*` commands/tools) with explicit, labeled evidence and guarded confidence; no
  unverified improvement claim is inferred from test presence.
- **Phase 28 — production hardening and final validation.** Additive, reversible `project_id`
  indexes (migration `026`) on eight high-traffic tables, a bounded `operationalHealth` facade,
  adversarial security and reliability tests, an isolated backup/restore demonstration, and a
  consolidated Phase 18–27 regression report with anomalies classified.
- Database migrations `016`–`026` (additive only). Migration `001` is the base; a clean install
  must apply migrations in order. No development database dump is shipped.

### Changed

- Wiring-only updates in `cli.js`, `server.js`, and `pipelineAudit.js` to expose the new commands,
  MCP tools, and audit checks; no existing engine was rebuilt.
- Pipeline audit coverage extended across phases (wiring checks are explicitly labeled as
  presence-only and **not** runtime verification).

### Security

- Parameterized queries everywhere; dynamic SQL restricted to compile-time constants and
  whitelisted field names.
- Path containment plus symlink skipping for filesystem discovery; redaction of key/token/password
  patterns before storage or display; synthetic canaries used to verify absence of leakage.
- Single-use approval tokens (hash only) with atomic consumption and binding checks; injection of
  instructions through source comments or transcripts cannot grant authority.
- Project-scoped queries and fail-closed validation on untrusted inputs. The Phase 28 threat model
  records no confirmed exploitable vulnerability in the inspected boundaries, with residual risks
  documented rather than hidden.

### Notes / known limitations

- **Conditionally ready with documented limitations** for the tested local deployment scope. This
  is not a "production-ready" claim.
- Real OpenCode runtime/agent execution remains unverified and requires explicit operator
  authorization; historical evidence is reported at its true tier only.
- Presence-only audit checks do not prove runtime correctness.
- A few inherited regression anomalies (accumulated test data / duplicate detection, concurrent-write
  count fluctuations, and one lingering-process test) remain documented.
- There is no migration-tracking table; applied state is inferred from schema presence.
- Generic MCP clients can call tools but do not inherit OpenCode's autonomous capabilities. Host
  adapters and local port/DB settings are deployment-specific and need adaptation.
- No license has been selected. Source visibility is not permission to reuse; see
  `LICENSE.decision.md` before publication.
