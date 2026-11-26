# Example: Debugging learning and explicit verification

> **Illustrative output.** The JSON below is synthesized for documentation; it was not captured
> from a real run. Session ids and hashes are placeholders. Never store real credentials.

Commands are verified against `engine/src/cli.js` and `engine/src/server.js`. Run from `engine/`.

## 1. Understand a completed session

```bash
node src/cli.js session-understanding-run \
  --project payments-api \
  --session sess-2026-11-25-001 \
  --seq 42 \
  --min-seq 42
```

MCP equivalent: `session_understanding_run` with `session_id`, `project_id`, `sequence`,
`min_sequence` — it calls `sessionUnderstanding.runSessionUnderstanding()` directly.
(`learning_run` is a different tool: it runs the learning pipeline via
`learningEngine.runLearningNow` → `runLearningPipeline`, not session understanding.)

Illustrative result:

```json
{
  "ok": true,
  "understanding_id": "33333333-3333-4333-8333-333333333333",
  "result": { "goals": 1, "tasks": 3, "debugging": 1, "experiences": 2, "degraded": [] }
}
```

Important behavior (verified in `sessionUnderstanding.js`):

- If `--min-seq` exceeds the durable transcript sequence, the call returns
  `{ ok:false, incomplete:true, expected_sequence, actual_sequence }` and takes **no claim**.
- Unfinished signals become `not_started` tasks. Session understanding **never** advances a
  task to verified — only verification evidence does that.
- Optional capabilities fail independently into `degraded[]`.

## 2. Analyze failures and link a fix

```bash
node src/cli.js error-analyze --project payments-api --session sess-2026-11-25-001
node src/cli.js error-report --project payments-api --limit 20
```

MCP equivalents: `error_record_failure`, `error_record_fix`, `error_observe_recurrence`,
`error_fix_report` (args mirrored from `server.js`).

Illustrative `error-report` excerpt:

```json
{
  "ok": true,
  "summary": [
    { "status": "verified_fix", "n": 1 },
    { "status": "observed_failure", "n": 3 }
  ],
  "items": [
    {
      "error_hash": "abc123def456abc123def456",
      "status": "verified_fix",
      "confidence": 0.75,
      "verification_result": "1 test passed"
    }
  ],
  "note": "evidence only; no automatic verification promotion"
}
```

How verification actually happened here (verified in `errorLearning.js`): a fix is linked to
the **last error line** and a pass line taken preferentially from a `TOOL` line with a
`verification_command`; only a pass pattern in that result yields `verified_fix`.
An agent merely writing "fixed" or "OK" does **not** produce this status.

## 3. Explicit feedback (operator action)

```bash
# Only 'confirmed' raises confidence, and it REQUIRES --explicit true.
node src/cli.js learning-feedback \
  --project payments-api \
  --pattern 44444444-4444-4444-8444-444444444444 \
  --verdict confirmed \
  --explicit true \
  --reason "reproduced in staging with the recorded command" \
  --evidence "tool-result|staging-run-9"

node src/cli.js learning-feedback-apply --id 17 --project payments-api --actor operator
```

MCP equivalents: `learning_feedback_record` and `learning_feedback_apply`.

Illustrative apply result:

```json
{
  "ok": true,
  "changed": true,
  "verdict": "confirmed",
  "delta": 0.05,
  "confidence_before": 0.6,
  "confidence_after": 0.65,
  "verification_unchanged": true
}
```

Rules verified in `learningPipeline.js`:

- `confirmed` is the only raising verdict and requires `explicit_feedback=true`; otherwise
  `recordFeedback()` fails.
- `applyFeedback()` changes confidence/evidence only — `verification_unchanged:true`. It is
  idempotent (`already_applied` on a second call) and the delta is suppressed once confidence
  is ≥ 0.9.
- `corrected`/`rejected`/`outdated` lower confidence (`−0.15` / `−0.25` / `−0.10`).

## 4. Inspect what was learned

```bash
node src/cli.js learning-status --project payments-api --limit 20
node src/cli.js learning-patterns --project payments-api
node src/cli.js learning-records --project payments-api --category debugging
```

MCP equivalents: `learning_status`, `learning_patterns`, `learning_records`.

## What is deliberately NOT claimed

- An agent's "OK" reply, a process exit 0, or a model's confidence value never verifies a
  learning record (`learningIntelligence.analyzeOutcome`, `outcomeEvaluation.ingestOutcome`).
- Unverified claims are capped at confidence `0.50` no matter how often they repeat.
- Similarity/dedup is token-overlap heuristic, not semantic understanding; with
  `HARNESS_SEMANTIC_LLM=0` there is no LLM classifier in this path.
