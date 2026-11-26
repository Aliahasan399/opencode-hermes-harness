# Workflow Safety

> Source of truth: `engine/src/*.js` (names below are verified exports) and
> `logs/phase28-final-report.md` / `logs/public-release/release-audit.md`. These controls are
> documented, not weakened. Example outputs in `docs/examples/` are illustrative.

## Baseline invariants

- **LEVEL 1** (`OPTIMIZATION_LEVEL=1`) is unchanged. `optimizer.js` reads
  `OPTIMIZATION_LEVEL` (default `1`); the documented configuration keeps it at 1.
- **`HARNESS_SEMANTIC_LLM=0`** is unchanged. `semanticUnderstanding.js` only enables its
  semantic path when `process.env.HARNESS_SEMANTIC_LLM === "1"` **and** an LLM is configured;
  with `0`, semantic LLM analysis is off. Source-intelligence and learning modules are
  explicitly documented as making no LLM calls.
- **No source rewrite.** Modules are analysis/evidence producers only. `sourceIndexer.js` states
  "EVIDENCE PRODUCER ONLY … no source rewrite, no spawn, no git, no secret reading." Workflow,
  approval, dispatch, validation and recovery modules contain no source-write or destructive
  path.
- **No auto-approval, no unrestricted execution.** Default mode is `simulation`; a real process
  is spawned only with explicit `mode:'real'` plus a valid single-use approval.
- **No competing persistent runtime** (see `multi-agent-orchestration.md`).

These settings and boundaries were re-confirmed in Phase 28 ("LEVEL 1 … unchanged;
HARNESS_SEMANTIC_LLM=0 … unchanged"; "no dependency upgrade, no provider/config change, no
source rewrite").

## Single-use, scope-bound approvals

`workflowApproval.js` is the gate. It only creates/verifies/consumes approval artifacts — it
"never spawns a process, never dispatches an agent, never writes source files and never
performs destructive operations."

An approval is bound to **all** of:

| Binding | Source |
|---|---|
| `project_id` | must be a real project; `_global` rejected |
| `plan_id` | exact string match |
| `plan_version` | exact string match |
| `plan_hash` | exact string match |
| `scope` | canonical redacted JSON → `scope_key = sha256(scopeJson)`; exact match |
| `mode` | `simulation` or `real`; exact match |
| `risk` | `low`/`medium`/`high`; exact match |

Safety properties (verified):

- The plaintext token is returned exactly **once** at creation; only `sha256(token)` is
  persisted. No token appears in returned rows or audit details (`redactApproval`,
  `redactValue`).
- `createApproval()` rejects `_global`, missing bindings, bad mode/risk and non-object scope.
  Expiry is clamped to 1 s – 30 days (default 24 h).
- `verifyApproval()` checks token hash, status, expiry and **every** binding; any mismatch
  returns `ok:false`. It changes no state.
- `consumeApproval()` verifies first, then performs a single guarded
  `UPDATE … WHERE status='active' AND token_hash=$3 AND (expires_at IS NULL OR expires_at>now())`.
  A second call cannot consume again — Phase 28 confirmed exactly one consumer under
  concurrent consumption, and binding changes are rejected.
- `revokeApproval()` and `listApprovals()` are project-scoped and bounded; `token_hash` is
  never selected.
- Every capability is fail-closed (`ok:false` rather than throwing), strings are redacted, and
  all reads are bounded.

Approvals are consumed by `workflowDispatcher.dispatchReady()` (run plan binding must match
the approval) and by `workflowRecovery.recoverRun()` (one approval per retry). **Recovery never
bypasses the gate.**

## `process_ok` is not `task_verified`

This distinction is enforced in multiple independent places:

- `opencodeRunAdapter.executeAgentRun()` always returns `task_verified:false`. Process exit 0
  sets only `process_ok:true`. Its file header: "process exit 0 sets process_ok ONLY; it NEVER
  sets task_verified."
- `workflowDispatcher.dispatchReady()` records `process_ok` and `evidence_class` in the dispatch
  ledger, but each result carries `task_verified:false` and the note "process_ok only records
  process outcome; task_verified requires independent validation."
- `workflowValidation.validateTask()` sets `verified:true` only from explicit passing
  post-conditions with eligible evidence; `process_ok` is accepted for transparency but can
  never set `verified`.
- `workflowValidation.assertNoOverclaim()` strips certainty/percentage/CVE/universal-quantifier
  language so an overclaim cannot be emitted as fact.
- `workflowValidation.validateRun()` reports "Unknown means insufficient evidence, not failure."
- `controlledWorkflow.report()` states "wiring/report presence is not runtime proof.
  process_ok never equals task_verified."

## Evidence tiers

`opencodeRunAdapter.classifyEvidence()` keeps four tiers distinct and never infers one from
another:

| Tier | Condition | Eligible for `verified`? |
|---|---|---|
| `mock` | no spawn (default/simulation) | No |
| `api` | `mode:'api'` / `evidence_class:'api'` | No |
| `runtime` | a real spawn occurred; bare exit 0 yields at most this tier | Yes |
| `agent` | explicit work-evidence flag **and** `process_ok` **and** a real spawn | Yes |

`workflowValidation.VALID_EVIDENCE = ["runtime", "agent"]`. A `mock`/`api` tier, or an empty or
failing `checks` array, leaves `verified:false`.

This is consistent with the learning layer: `outcomeEvaluation.ingestOutcome()` and
`learningIntelligence.analyzeOutcome()` require explicit verification markers; an agent claim,
a process exit code or model confidence never verifies (see `continuous-learning.md`).

## Fail-closed boundaries

Across the workflow modules the common pattern is:

- **Project scope required:** every write/validation/state call rejects empty or `_global`
  project ids with `ok:false`.
- **Bounded:** limits and timeouts are clamped (dispatch `max_parallel` 1–8; recovery
  `max_attempts` 1–5 and `stale_after_ms` 1 s–24 h; list limits ≤200; spawn timeout 1–300 s).
- **Redacted:** tokens, credentials and text are redacted before persistence/audit/output;
  audits are content-free and best-effort.
- **Idempotent:** dispatch uses a unique ledger key; approvals are single-use; validation rows
  are bounded; no broad locking is introduced.
- **Legal transitions only:** `workflowStateMachine.transitionTask()` rejects illegal moves.

## No auto-approval / no source rewrite

- Nothing in `workflowApproval`, `workflowDispatcher`, `workflowStateMachine`,
  `workflowRecovery`, `workflowValidation` or `opencodeRunAdapter` creates an approval on behalf
  of the operator, promotes a task to verified automatically, or writes source. Approvals come
  from an explicit operator action (`workflow_approve` / `approve()`).
- Source intelligence (`codeIntelligence.js`, `codeUnderstanding.js`, `sourceIndexer.js`,
  `testMap.js`, `testSelector.js`) is analysis-only under LEVEL 1 / `HARNESS_SEMANTIC_LLM=0`.
- Calibration/apply paths in the adaptive layer stage proposals that must be reviewed and
  explicitly applied; there is no silent self-modification.

## Honest limitations

- **Presence-only audit checks are not runtime verification.** The pipeline audit reports
  wiring/presence with `verifiedBehavior:false` and `NO_RUNTIME_CLAIM`.
- **Real execution remains unverified** without explicit authorization. Phase 28 did not run a
  fresh real OpenCode process; historical evidence stands at its true tier
  (`process_ok:true`, `task_verified:false`, no attribution of an agent's "OK" reply).
- **Not universally production-ready.** Phase 28 assesses "conditionally ready with documented
  limitations for the tested local deployment scope." Conditions: (a) real runtime requires
  explicit operator authorization, (b) presence-only checks are not runtime proof, (c) four
  inherited regression anomalies remain documented, (d) no migration-tracking table exists.
- **Source analysis is heuristic** (no AST parser, no semantic LLM); its confidence limits are
  documented, not a correctness guarantee.
- **Platform-dependent execution:** the `opencode run` adapter resolves a binary via
  `HARNESS_OPENCODE_BIN` and platform-specific shims; generic MCP clients do not inherit
  OpenCode's autonomous capabilities. Adapters are required for portability.
- Never publish real credentials, tokens, connection strings, dump files or local personal
  paths. Only a placeholder `.env.example` and sanitized logs are suitable for release.
