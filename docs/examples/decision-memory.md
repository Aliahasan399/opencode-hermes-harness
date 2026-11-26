# Example: Recording and retrieving a decision

> **Illustrative output.** The JSON shown below is synthesized for documentation; it was not
> captured from a real run. All ids are placeholders. Use your own real `project_id` and never
> paste credentials or tokens into documentation.

Commands are verified against `engine/src/cli.js` and `engine/src/server.js`. Run the CLI from
`engine/` (`cd engine`), or use `npm run cli -- <cmd> …`; the MCP equivalents are tool names
from `server.js`.

## 1. Record a decision

```bash
node src/cli.js context-decision-record \
  --project payments-api \
  --title "Use local cache for routing rules" \
  --description "Routing rules are cached in-process with a 60s TTL" \
  --reasoning "Avoids a network hop on the hot path; staleness bounded by TTL" \
  --alternatives "remote-cache|no-cache" \
  --consequences "eventual consistency up to 60s" \
  --evidence "benchmark-bench-42|load-test-2026-11-20"
```

MCP equivalent — `context_decision_record` with the same fields
(`project_id`, `title`, `description`, `reasoning`, `alternatives`, `consequences`, `evidence`,
`confidence`, `source_session`, `supersedes`).

Illustrative result (a newly created active decision):

```json
{
  "ok": true,
  "id": "11111111-1111-4111-8111-111111111111",
  "created": true,
  "superseded": [],
  "decision": { "title": "Use local cache for routing rules", "status": "active" }
}
```

Notes verified in `decisionIntel.recordDecision()`:

- Evidence is stored, and `core.audit("decision.record", …)` writes a content-free entry.
- A same-title active decision is **not overwritten**; a second identical call returns
  `duplicate:true` with the existing id.

## 2. Supersede it with evidence

```bash
node src/cli.js context-decision-record \
  --project payments-api \
  --title "Use shared Redis cache for routing rules" \
  --reasoning "Local cache diverged across instances during rolling deploy" \
  --evidence "incident-2026-11-24|postmortem-review" \
  --supersedes 11111111-1111-4111-8111-111111111111
```

Supersession requires **non-empty evidence**; without it the call fails with
`"superseding a decision requires non-empty evidence"`. The old row is archived to
`status='superseded'` with a title marker and `superseded_by` — never deleted.

Illustrative result:

```json
{
  "ok": true,
  "id": "22222222-2222-4222-8222-222222222222",
  "created": true,
  "superseded": ["11111111-1111-4111-8111-111111111111"]
}
```

## 3. Search and retrieve context

```bash
# Deterministic keyword search over project decisions
node src/cli.js context-decisions --project payments-api --query "routing cache"

# Combined, budget-aware task context (hybrid retrieval + decisions + relationships + quality)
node src/cli.js context-retrieve --project payments-api \
  --prompt "why is routing cached locally?" --json
```

MCP equivalents: `context_decisions_search` and `context_retrieve_task`.

Illustrative `context-retrieve` excerpt:

```json
{
  "ok": true,
  "project_id": "payments-api",
  "explanation": "Selected 3/5 candidates … Verified and fresh items are preferred; contradicted/stale/superseded items are downweighted; items are deduplicated by (type,id) and cross-project rows excluded.",
  "degraded": [],
  "items": [
    { "type": "decision", "verification": "observed", "title": "Use shared Redis cache for routing rules" },
    { "type": "decision", "verification": "superseded", "title": "Use local cache for routing rules" }
  ]
}
```

Why the superseded decision can still appear but ranks lower: `contextRetrieval.adjustedScore()`
applies `VERIF_FACTOR.superseded = 0.2`, so it is downweighted rather than silently dropped —
the full history stays explainable.

## Safety notes

- Every call is project-scoped; `_global` is rejected for retrieval and not used for decisions.
- `context_retrieve_task` reuses the same isolation and ranking rules as memory retrieval
  (`memory-system.md`).
- No LLM is involved: decision search is deterministic token matching (stop-words removed,
  ≤8 tokens), and ranking is fixed arithmetic.
