# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability. Use GitHub's private
reporting channel for this repository instead:

1. Go to the repository **Security** tab and choose **Report a vulnerability** (private vulnerability
   reporting / security advisory).
2. If private reporting is not enabled for the repository, contact the maintainers privately through
   the repository's maintainer channels rather than posting publicly.

Include a clear description, affected component and version, reproduction steps or a proof of
concept, and the impact you observed. Please keep the report **free of real secrets**: do not include
live API keys, passwords, tokens, connection strings, or personal data. Use synthetic placeholders
or redacted values (for example `REDACTED` or obviously fake `sk-`/`Bearer`/`AKIA` canaries).

**No real secrets should ever be included in a report, issue, log, test fixture, or commit.** A
report containing credentials may be redacted or discarded, since leaked credentials must be rotated
by their owner rather than circulated further.

## Response expectations

Reports are triaged by maintainers as time and resources permit. We aim to acknowledge and assess
reports in good order, but **no specific response or fix timeline (SLA) is promised**. We may ask for
more information, may close reports that are out of scope or not reproducible, and will not confirm
exploit details publicly before a fix is available. This project does **not** claim any security
certification, audit seal, or compliance attestation.

## In scope

- `engine/src/` — MCP tools (`server.js`), CLI (`cli.js`), core DB/redaction helpers, and all phase
  modules.
- `engine/init/` — SQL migrations and schema changes.
- `plugin/`, `integrations/`, `dashboard/`, `scripts/`, and installer/bootstrap assets.
- Vulnerabilities with demonstrable impact, including: SQL injection, path traversal or drive-letter
  escape, secret leakage into logs/reports/DB, approval replay or scope substitution, cross-project
  data leakage, unsafe process execution, untrusted-evidence authority escalation (prompt injection),
  invalid-input handling, and unauthorized self-modification.

## Out of scope

- Issues without a credible security impact, pure feature requests, or general usage questions.
- Vulnerabilities in third-party services or dependencies that are not triggered by this project's
  code (please report those to their respective vendors).
- Theoretical risks that require the operator to intentionally disable documented safety settings
  or hand over credentials.
- Findings derived only from source presence or test names; runtime impact must be reasoned about
  or demonstrated.

## Safety invariants that must be preserved

The following invariants are part of the harness's security model. Reports that they are violated
are in scope; changes that weaken them will not be accepted:

- `OPTIMIZATION_LEVEL=1` (LEVEL 1 / OBSERVE) remains the default; no autonomous escalation.
- `HARNESS_SEMANTIC_LLM=0` remains the default; optional LLM interpretation is opt-in, capped in
  confidence, and never a source of authority or verification.
- Approvals are explicit and **single-use** (only a hash is stored), bound to project, plan
  id/version/hash, scope, mode, and risk. No auto-approval; replay and substitution are rejected.
- Project isolation: project-scoped operations require a valid `project_id`; `_global` and empty
  scope are rejected unless explicit eligibility applies.
- Stored memories, transcripts, retrieved context, and source files are **untrusted data**, never
  instructions; evidence cannot grant authority and does not rewrite source.
- No unrestricted shell/process execution; only fixed-argument adapters spawn processes, with no
  shell interpretation.
- Secrets are never stored in code, logs, the database, or the dashboard; redaction must stay in
  place.

For background on previously examined boundaries and controls, see the sanitized threat-model
document referenced by the release notes. That documentation describes controls; it is not a
certification or a guarantee.
