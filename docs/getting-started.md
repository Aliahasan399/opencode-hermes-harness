# Getting started

This guide explains the concepts you need before using the OpenCode Harness and walks through a first session. It assumes you have completed [INSTALL.md](../INSTALL.md).

> Readiness: conditionally ready with documented limitations for the tested local deployment scope. Real Harness-dispatched OpenCode agent execution was not demonstrated in Phase 28.

## The one idea to keep in mind

**The host agent remains the execution environment. The Harness extends it; it does not replace it.**

The Harness is a sidecar: an MCP server, a CLI, and an optional plugin hook. It remembers, learns, plans, validates, and reports. Your coding agent still reads files, writes code, runs commands, and talks to you. The Harness supplies better context and guardrails to that work.

## Core concepts

- **Project scope** — every memory, experience, and workflow is tied to a project id resolved from the project directory. Isolation is enforced in queries and in MCP access guards. Cross-project reuse is opt-in and explicit.
- **Memory** — a row with a layer (`user`, `project`, `session`, `knowledge`), confidence, importance, provenance, and version history. Retrieval combines PostgreSQL full-text search, trigram similarity, and pgvector cosine search, then reranks and filters by quality. The whole database is never injected into a prompt.
- **Untrusted data boundary** — retrieved memories and past transcripts are historical reference data, never instructions. They cannot override your current request, grant authority, approve a workflow, or change a safety setting.
- **Evidence tiers** — `mock`, `api`, `runtime`, `agent`. A successful process exit (`process_ok`) is not the same as a verified task (`task_verified`). Only observed evidence promotes a claim toward verified.
- **Approval** — multi-agent dispatch requires a single-use token bound to the project, plan id/version/hash, scope, mode, and risk. The default workflow mode is `simulation`.
- **Autonomy level** — LEVEL 1 (`OPTIMIZATION_LEVEL=1`) by default; semantic LLM interpretation off (`HARNESS_SEMANTIC_LLM=0`). These are safety settings, not performance knobs to raise casually.

## Capabilities you can enable

| Capability | What it gives you | Disable by selecting |
|---|---|---|
| Persistent Project Memory | Decisions, project context, relationships, lifecycle, retrieval | omit `memory` |
| Continuous Session Understanding and Learning | Durable transcripts, goals/tasks, debugging experience, learning records and feedback | omit `learning` |
| Controlled Multi-Agent Engineering | Task graphs, agent coordination, context ledgers, validation, approval-gated workflows | omit `agents` |

The recommended selection is all three. Each capability degrades independently; basic memory save/search/retrieval remain available even if an optional component is absent.

## Guided first session

1. **Install and verify.** Follow [INSTALL.md](../INSTALL.md), then:

   ```powershell
   cd E:\OpenCodeData\memory\engine
   npm test
   node src/cli.js status
   node src/cli.js ops-health
   ```

2. **Record a decision.** In your host agent, ask it to remember a project decision (it calls `memory_save`), or use the CLI:

   ```powershell
   node src/cli.js context-decision-record --project <project-dir> --title "Adopt snake_case for tests" --reasoning "Matches existing suite"
   ```

3. **Recall it in a later session.** Ask your agent a question that needs that context; the plugin injects budgeted context automatically. To check directly:

   ```powershell
   node src/cli.js context --project <project-dir> --prompt "What test naming convention do we use?"
   ```

4. **Let learning run at turn end.** After a debugging session with a verified fix, run:

   ```powershell
   node src/cli.js automate --project <project-dir> --session <session-id> --durable
   node src/cli.js learning-status --project <project-dir>
   ```

5. **Plan, then approve before dispatch.** See [QUICKSTART.md](../QUICKSTART.md#4-first-use-examples) for the exact `agent-plan`, `workflow-create`, `workflow-approve`, and `workflow-dispatch` sequence. Dispatch defaults to dry-run and needs a single-use token.

6. **Verify with evidence.**

   ```powershell
   node src/cli.js workflow-validate --project <project-dir> --run <run-id> --checks <checks.json> --evidence runtime
   node src/cli.js workflow-report --project <project-dir> --run <run-id>
   ```

## Where to look next

- [Capabilities](capabilities.md) — which module implements each behavior, and the real command/tool names.
- [Architecture](architecture.md) — how the layers compose and how data flows.
- [FAQ](faq.md) — honest limitations and answers to common questions.
