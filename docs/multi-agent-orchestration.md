# Multi-Agent Orchestration

> Source of truth: `engine/src/*.js` (names below are verified exports). This layer **plans,
> coordinates, validates and gates** work; it is not a replacement agent runtime. Example
> outputs in `docs/examples/` are illustrative, not captured from a real run.

## What this layer is — and is not

- `agentOrchestrator.js` ("Phase 22 facade") states: it "never executes arbitrary code itself
  and never replaces OpenCode's native agent runtime." `orchestrate()` **prepares a plan only**;
  actual execution is handed to supported OpenCode interfaces (the subagent tool or
  `opencode run --agent`) by the caller.
- `controlledWorkflow.js` states it "does NOT add a persistent agent runtime." LEVEL 1 is
  preserved: simulation by default, no process spawned without an explicit single-use,
  scope-bound approval.
- **No competing persistent runtime.** There is no daemon, no work-stealing loop and no
  autonomous self-dispatch. `workflowDispatcher.dispatchReady()` runs a bounded number of
  workers over a fixed ready-task queue and exits.
- Real execution therefore requires **supported host capabilities** (an OpenCode host exposing
  a subagent tool or the `opencode run` CLI) **and explicit operator approval**. A generic MCP
  client can call these tools, but it does **not** inherit OpenCode's autonomous capabilities.

## Decomposition

`taskDecomposition.js`:

- `decomposeTask()` is **pure and deterministic**: no LLM, no network, no clock, no randomness;
  ids are stable SHA-256 hashes of inputs. `MAX_TASKS = 12` (hard cap 24).
- Dependencies are emitted only when the request **explicitly** implies ordering ("after",
  "then", "integration", "depends on", …), always point backwards, so the decomposer cannot
  produce cycles. `validateTaskGraph()` checks a supplied graph.
- Capabilities are never invented: a capability appears only on a literal keyword match from
  the allowed list (`database`, `api`, `security`, `testing`, `frontend`, `backend`,
  `documentation`). Risk level is likewise keyword-derived (`high` for security/migration/
  production/credentials, `medium` for refactor/api/integration/deploy, else `low`).
- All user-influenced text passes through `core.redact()`; fields and array lengths are bounded.
- `savePlan()`, `getPlan()`, `listPlans()`, `getTasks()` are project-scoped, idempotent and
  additive. `agentOrchestrator.orchestrate()` composes decomposition + selection + conflict
  detection (`agentConflicts.detectConflicts`) and audits content-free metadata.

## Agent selection

`agentRegistry.js`:

- `discoverAgents()` reads the host's `opencode.json` agent section and overlays the
  harness-provided `explore`, `explorer` and `general` agents. Capabilities come only from a
  fixed name→capability map; capabilities are never inferred from free-form description text.
- Agents pinned to a known-dead upstream (prefix `9router`) are reported unavailable in
  `degraded` and are **never selected**.
- `selectAgents()` is deterministic (same input → same output, ties broken by agent name) and
  pure (no DB, no I/O). "Smallest suitable team" is a soft preference balanced against
  workload spread; `max_parallel` bounds assignments per round.
- `agentOrchestrator.explainSelection()` returns the recorded reason/capabilities — "no hidden
  model call."

Portability note: agent discovery depends on a platform-specific OpenCode config path and on
the host's installed agents. Treat the roster as host-dependent; do not hard-code it.

## Context preparation

`agentContext.js`:

- `prepareAgentContext({ plan_id, task_id, agent, project_id, request, context_budget })` builds
  a **bounded, provenance-labelled** context block by composing
  `contextRetrieval.retrieveTaskContext()` with plan/task specifics. It returns
  `{ ok, items, text, ledger_id, chars, degraded }` and refuses a missing project id.
- `contextForHandoff({ plan_id, from_task, to_task, project_id })` prepares bounded context for
  a task handoff.

Because it reuses `contextRetrieval`, the same isolation, verification weighting and
budget-truncation rules apply (see `memory-system.md`).

## Ownership and coordination

- `workflowDispatcher.checkFileOwnership({ project_id, run_id, task_key })` compares a task's
  `file_ownership` against other **non-terminal** tasks in the run. Any overlap is a conflict;
  the dispatcher skips that task rather than risking concurrent writes to the same file.
- `agentCoordination.js` provides `claimTask()`, `completeTask()`, `failTask()`,
  `retryFailed()`, `getReadyTasks()` and `executionStatus()`.
- `workflowStateMachine.js` enforces legal task transitions:
  `pending → claimed → running → verifying → done`, with `failed`/`blocked`/`cancelled`
  branches. Illegal transitions are rejected (`ok:false`), and a run becomes terminal only
  when all its tasks are terminal. `startRun()` is idempotent per
  `(project, plan_id, plan_version, plan_hash, approval_id)`.

## Approval and dispatch

- `workflowApproval.js`: `createApproval()` produces a single-use token; the plaintext token is
  returned **once** and only `sha256(token)` is stored. It is bound to `project_id`, `plan_id`,
  `plan_version`, `plan_hash`, a canonical redacted `scope` (`scope_key`), `mode` and `risk`.
  `verifyApproval()` checks every binding plus expiry; `consumeApproval()` performs the atomic
  `active → consumed` update guarded by token hash, status and expiry (exact-one consumer under
  concurrency). `revokeApproval()` and `listApprovals()` are bounded and project-scoped.
- `workflowDispatcher.dispatchReady()`:
  1. loads the approval and **checks the run's plan binding matches it**;
  2. atomically consumes the approval;
  3. selects dependency-ready tasks (`getReadyTasks()`);
  4. runs bounded concurrency (`max_parallel` 1–8, default 4);
  5. skips tasks with ownership conflicts or an existing idempotency key
     (`sha256(run_id|task_key|attempts)` written to `workflow_dispatch` with
     `ON CONFLICT DO NOTHING`);
  6. transitions status and calls `opencodeRunAdapter` with a fixed argv array.
- `opencodeRunAdapter.js`: `buildRunArgs()` emits only allow-listed flags (`--agent`,
  `--model`, `--session`, `--fork`, `--worktree`, `--continue`, `--format`, `--title`, prompt)
  as an **argv array, never a shell string**. `executeAgentRun()` spawns only with explicit
  `mode:'real'`; missing/unknown modes degrade to **simulation**. On a real spawn, exit 0 sets
  `process_ok` only — `task_verified` is always `false` in this adapter. Output is redacted and
  capped. Windows shim resolution (`HARNESS_OPENCODE_BIN`) is platform-dependent.

## Monitoring and recovery

- `workflowMonitor.js`: `monitorRun()`, `listStale()` and `workflowHealth()` are read-only,
  bounded views. `workflowStateMachine.getRun()`/`listRuns()` provide durable state.
- `workflowRecovery.js`: `recoverRun()` / `retryTask()` retry only `failed`/`blocked`/stale
  tasks (bounded `max_attempts` 1–5, `stale_after_ms` default 5 minutes). **Every retry
  consumes one explicit single-use approval** bound to the run's plan; tasks without a matching
  approval are skipped. It uses only legal state transitions, writes no source and performs no
  destructive operation. It "never verifies task success."

## Postconditions and verification

`workflowValidation.js` is the independent verification step:

- `validateTask()` sets `verified:true` **only** when `checks` is a non-empty array whose every
  entry has `pass === true` (strict) **and** `evidence_class` is `runtime` or `agent`.
  `process_ok` is recorded for transparency but can never set `verified`. `mock` and `api`
  evidence are ineligible.
- `assertNoOverclaim()` scans for absolute percentages, guarantee terms, CVE ids, universal
  quantifiers, invented percentages and certainty terms; flagged text is stripped to
  `[REDACTED_CLAIM]` in emitted fields and recorded as generic flag codes.
- `validateRun()` is a read-only aggregate. Its note: "Unknown means insufficient evidence,
  not failure."
- `controlledWorkflow.report()` carries the explicit claim: "wiring/report presence is not
  runtime proof. process_ok never equals task_verified."

`agentValidation.js` complements this with `VALID_VERDICTS = ["accepted", "rejected",
"needs_revision", "blocked"]`, `validateTaskResult()`, `recordReview()` and `getReviews()`.
`agentIntegration.integrateResults()` and `agentWorkflowLearning.agentPerformance()` record
counts only — "claims are never verified outcomes."

## Evidence tiers

`opencodeRunAdapter.classifyEvidence()` keeps tiers distinct and never infers one from another:

| Tier | Condition |
|---|---|
| `agent` | explicit work-evidence flag **and** `process_ok` **and** a real spawn |
| `runtime` | a real spawn occurred (a bare exit 0 can only ever yield this tier) |
| `api` | `mode:'api'` / `evidence_class:'api'` |
| `mock` | no spawn (the default/simulation case) |

## Limitations (honest)

- **Real OpenCode runtime/agent execution has not been freshly demonstrated** (Phase 28).
  Historical Phase 24 evidence is one real process with exit 0 reported as
  `process_ok:true` / `task_verified:false`; an agent's direct "OK" reply was **not** attributed
  to a Harness task. Spawned / responded / dispatched / task-completed / postconditions-passed
  / task-verified are not demonstrated with fresh execution.
- Decomposition and selection are keyword/deterministic heuristics — not understanding.
- Generic MCP clients can call these tools but do not inherit OpenCode's autonomous runtime.
- Execution depends on host capabilities and platform-specific paths/config; it is not portable
  without adapters.
- Passing tests and presence-only audits are not runtime verification; no universal
  production-readiness claim is made.
