# Example: An approved, simulation-first engineering workflow

> **Illustrative output.** All JSON below is synthesized for documentation; it was not captured
> from a real run. Tokens/ids are placeholders — never paste a real approval token into docs.
> Everything here runs in **simulation** mode; no process is spawned.

Commands are verified against `engine/src/cli.js` and `engine/src/server.js`. Run from `engine/`.

## 0. List available templates

```bash
node src/cli.js workflow-templates
```

MCP equivalent: `workflow_templates`.

## 1. Create the plan and run (no dispatch)

```bash
node src/cli.js workflow-create \
  --project payments-api \
  --template feature \
  --prompt "Add idempotent retry to the payment webhook handler" \
  --scope '{"files":["engine/src/workers/"]}' \
  --risk medium \
  --mode simulation \
  --plan plan-2026-11-26 \
  --version 1 \
  --hash 9f0c1a2b3d4e5f60
```

MCP equivalent — `workflow_create` with `project_id`, `template`, `objective`, `scope`,
`risk`, `mode`, `plan_id`, `plan_version`, `plan_hash`.

Illustrative result:

```json
{
  "ok": true,
  "plan_id": "plan-2026-11-26",
  "run_id": "55555555-5555-4555-8555-555555555555",
  "tasks": 3,
  "note": "Run and pending tasks prepared. No agent dispatched and no process spawned."
}
```

`controlledWorkflow.createWorkflow()` composes planning + approval artifact + durable run; it
does **not** dispatch.

## 2. Create an approval (explicit operator action)

```bash
node src/cli.js workflow-approve \
  --project payments-api \
  --plan plan-2026-11-26 \
  --version 1 \
  --hash 9f0c1a2b3d4e5f60 \
  --scope '{"files":["engine/src/workers/"]}' \
  --mode simulation \
  --risk medium \
  --approved-by operator
```

MCP equivalent: `workflow_approve` (same bindings; `expires_in_ms` optional, 1 s–30 days).

Illustrative result — the token is returned **once**:

```json
{
  "ok": true,
  "approval_id": "66666666-6666-4666-8666-666666666666",
  "token": "<token-returned-once-placeholder>",
  "approval": { "status": "active", "mode": "simulation", "risk": "medium" },
  "claim": "NO_RUNTIME_CLAIM"
}
```

Boundings verified in `workflowApproval.createApproval()`/`verifyApproval()`: the approval is
tied to project, `plan_id`, `plan_version`, `plan_hash`, canonical redacted `scope` (→
`scope_key`), `mode` and `risk`. Only `sha256(token)` is stored. Change any binding and
verification fails.

## 3. Dispatch in simulation (dry-run)

```bash
node src/cli.js workflow-dispatch \
  --project payments-api \
  --run 55555555-5555-4555-8555-555555555555 \
  --approval 66666666-6666-4666-8666-666666666666 \
  --token '<token-returned-once-placeholder>' \
  --mode simulation \
  --dry-run \
  --parallel 2
```

MCP equivalent: `workflow_dispatch` (`dry_run:true` is the default in `server.js`).

Illustrative result:

```json
{
  "ok": true,
  "run_id": "55555555-5555-4555-8555-555555555555",
  "mode": "simulation",
  "dispatched": 2,
  "skipped": 1,
  "results": [
    {
      "task_key": "task-1",
      "evidence_class": "mock",
      "process_ok": false,
      "task_verified": false,
      "note": "process_ok only records process outcome; task_verified requires independent validation."
    }
  ]
}
```

Verified behavior: no spawn occurs in simulation; the approval is consumed atomically (a second
dispatch with the same token fails); tasks with overlapping `file_ownership` or an existing
idempotency key are skipped; no task is marked verified here.

## 4. Inspect status

```bash
node src/cli.js workflow-status \
  --project payments-api \
  --run 55555555-5555-4555-8555-555555555555
```

MCP equivalent: `workflow_status`.

Illustrative result: a bounded list of tasks in legal states
(`pending → claimed → running → verifying → done`, with `failed`/`blocked` branches). Read-only.

## 5. Validate postconditions with eligible evidence

```bash
# Note: the CLI reads --checks from a JSON FILE (fs.readFileSync), not inline JSON.
cat > /tmp/checks.json <<'EOF'
[{"name":"unit tests pass","pass":true},{"name":"no secret in output","pass":true}]
EOF
node src/cli.js workflow-validate \
  --project payments-api \
  --run 55555555-5555-4555-8555-555555555555 \
  --task task-1 \
  --checks /tmp/checks.json \
  --evidence runtime \
  --process-ok false
```

MCP equivalent: `workflow_validate` (`checks` is an array of `{ pass, name? }`,
`evidence_class` is one of `mock|api|runtime|agent`, `process_ok` boolean).

Illustrative result:

```json
{
  "ok": true,
  "verified": true,
  "checks": [
    { "name": "unit tests pass", "pass": true },
    { "name": "no secret in output", "pass": true }
  ],
  "claims": [],
  "reason": "postconditions_passed_with_eligible_evidence",
  "process_ok": false,
  "note": "Post-conditions passed with eligible evidence. No certainty claim was emitted."
}
```

`workflowValidation.validateTask()` requires a non-empty `checks` array with every
`pass === true` **and** `evidence_class` of `runtime` or `agent`. `process_ok` alone would not
verify the task; `mock`/`api` evidence is ineligible. Overclaim language is stripped, not
emitted as fact.

## 6. Recovery requires a fresh approval

```bash
# A new, single-use approval is created for a retry; recovery never bypasses the gate.
node src/cli.js workflow-recover \
  --project payments-api \
  --run 55555555-5555-4555-8555-555555555555 \
  --approval <new-approval-id-placeholder> \
  --token '<token-returned-once-placeholder>' \
  --max-attempts 2 \
  --dry-run
```

MCP equivalent: `workflow_recover`. Each retry consumes one approval; tasks without one are
skipped. Recovery performs no source writes and never verifies task success.

## To move from simulation to real execution

Only with all of the following, and never by editing docs alone:

1. An explicit operator approval with `mode:"real"` and matching bindings.
2. A supported host capability — an OpenCode host exposing a subagent tool or the
   `opencode run` CLI (`opencodeRunAdapter.buildRunArgs` emits allow-listed flags as an argv
   array, no shell string).
3. Platform adaptation where needed (`HARNESS_OPENCODE_BIN`, Windows shim resolution).
4. Independent postcondition validation — exit 0 (`process_ok`) is not `task_verified`.

> As of Phase 28, real OpenCode agent execution was **not** freshly demonstrated. The only
> historical real-process evidence is `process_ok:true` with `task_verified:false`; an agent's
> direct "OK" reply was not attributed to a Harness task. Do not treat this walkthrough as proof
> that a real task completed.
