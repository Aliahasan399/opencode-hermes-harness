# Workflow examples (real CLI commands)

All commands below exist in `engine/src/cli.js`. Replace `<engine>` with the
engine directory and `<project-id>` with your project identifier.

## Memory + context

```sh
node <engine>/src/cli.js status
node <engine>/src/cli.js context --prompt "What conventions does this project use?" --project <project-id>
node <engine>/src/cli.js context-package --prompt "session start" --project <project-id> --budget 4000
node <engine>/src/cli.js context-decisions --project <project-id>
node <engine>/src/cli.js context-relationships --project <project-id>
```

## Session understanding + learning

```sh
node <engine>/src/cli.js automate --session <session-id> --project <project-id> --stdin
node <engine>/src/cli.js session-understanding-run --session <session-id> --project <project-id>
node <engine>/src/cli.js learning-status --project <project-id>
node <engine>/src/cli.js learning-advice --project <project-id> --prompt "how should I approach this task?"
node <engine>/src/cli.js learning-patterns --project <project-id>
```

## Controlled agents (prepare-only by default)

```sh
node <engine>/src/cli.js workflow-templates
node <engine>/src/cli.js agent-plan --project <project-id> --prompt "<objective>" --max-tasks 6
node <engine>/src/cli.js agent-plan-status --plan <plan-id> --project <project-id>
node <engine>/src/cli.js workflow-create --project <project-id> --template <template> --objective "<objective>" --mode simulation
node <engine>/src/cli.js workflow-approvals --project <project-id>
```

Real dispatch requires an explicit single-use approval token from `workflow-approve`.
Simulation is the default; `process_ok` never implies `task_verified`.

## Operations / diagnostics

```sh
node <engine>/src/cli.js ops-health --project <project-id>
node <engine>/src/cli.js pipeline-audit
node scripts/diagnostics/doctor.mjs --target <project-dir>
```

`pipeline-audit` is wiring-only; `ops-health` contains a real database check. A
healthy single component is not proof that the whole system is healthy.
