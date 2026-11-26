# Continuous Learning

> Source of truth: `engine/src/*.js` (names below are verified exports). This describes the
> implemented deterministic/evidence-backed learning layer. It makes no LLM calls
> (`HARNESS_SEMANTIC_LLM=0`) and no external-network classification calls. Example outputs in
> `docs/examples/` are illustrative, not captured from a real run.

## Pipeline overview

Learning composes existing tables and modules; it does not add a second engine:

1. **Session understanding** (`sessionUnderstanding.js`) turns a durable transcript into a
   structured, idempotent, project-scoped record.
2. **Experience extraction** (`learningExperience.js`, `experienceStore.js`,
   `debuggingExperience.js`) captures reusable work as evidence-backed records.
3. **Verification & confidence** (`learningIntelligence.js`, `outcomeEvaluation.js`) classify
   outcomes from explicit markers only and compute explainable confidence.
4. **Feedback** (`learningPipeline.js`, `retrievalFeedback.js`) lets an operator correct
   confidence conservatively — never verification.
5. **Recurring-failure evidence** (`errorLearning.js`) fingerprints failures, links fixes to
   tool-observed passes, and tracks recurrence/non-recurrence.
6. **Evaluation** (`outcomeEvaluation.js`, `recommendationEvaluation.js`,
   `predictionEvaluation.js`) records verified outcomes, recommendation effectiveness and
   prediction accuracy using `min_samples` gates.

## Session understanding

`runSessionUnderstanding({ session_id, project_id, lines, sequence, min_sequence })`:

- Rejects `_global` and missing session/project. Refuses to learn from an **incomplete
  transcript**: if `min_sequence` is asserted and the durable sequence is lower, it returns
  `{ ok:false, incomplete:true, expected_sequence, actual_sequence }` with **no ledger claim**.
- Claims a ledger row on `(session_id, transcript_sequence)` with a stale-claim takeover
  (`status IN ('pending','failed','processing')` and older than 2 minutes). Re-running the
  same sequence is idempotent.
- Runs four optional capabilities via dynamic import with isolated `try/catch` —
  `sessionExperience`, `developmentGoal`, `debuggingExperience`, `experienceStore`. A failure
  in any one is recorded in `degraded[]` and does not block the others.
- Produces a structured summary: `goal_hints`, `changes`, `errors`, `tests`, `decisions`,
  `unfinished`, `constraints`. Goals/tasks/unfinished items and debugging experiences are
  recorded with evidence and `source_session`.
- **Never advances task status** here: explicit unfinished signals become `not_started`
  tasks only. "Only verification evidence can do that."
- Audits content-free metadata (counts + degraded list). `sessionUnderstandingStatus()` and
  `retrySessionUnderstanding()` provide bounded inspection and retry of `pending`/`failed`
  rows.

## Experience extraction

`experienceStore.js` defines the frozen vocabulary:

- `EXPERIENCE_KINDS`: `debugging`, `pattern`, `procedure`, `integration`, `configuration`,
  `testing`, `deployment`.
- `VERIFICATION_STATUS`: `verified`, `observed`, `inferred`, `uncertain`, `contradicted`,
  `stale`, `superseded`.
- `recordExperience()` is additive-only: no `DELETE`/`TRUNCATE`/`DROP`, deterministic
  token-overlap dedup, evidence merge, and redaction of credential-like content before
  persistence. Confidence is **clamped from the caller only, and stays null when the caller
  supplies nothing** — it is never invented.
- `findDuplicateExperiences()`, `consolidateExperiences()`, `markExperienceStale()`,
  `getExperiences()`, `experienceReport()` provide bounded, project-scoped operations.
- `learningExperience.js` adds `extractExperiences()`, `recordLearningExperience()`,
  `getLearningExperiences()`, `getLearningBySession()` with `EXPERIENCE_CATEGORIES`.

## Verification: explicit markers only

This is the central safety rule across the learning layer:

- `learningIntelligence.js` `VERIFICATION_MARKERS` is a fixed set:
  `test_pass`, `test_result`, `test_success`, `test_suite`, `tests`,
  `verification_result`, `verification`, `verified_outcome`, `tool_result`, `tool_success`,
  `build_success`, `build_result`.
- `analyzeOutcome()` sets `verified:true` **only** when an evidence item carries one of those
  markers with a determinate result (success/failure). A declared outcome ("fixed", "done")
  is reported as `verified:false`. With no marker and no determinate result, the outcome is
  `uncertain` and `verified:false`. An AI explanation alone cannot verify a result.
- `experienceStore.js` `decideVerification()` will not promote a status to `verified` without
  an **explicit verification marker in the new evidence**; it never auto-demotes and never
  promotes on a tie.
- `outcomeEvaluation.js` `ingestOutcome()` **reuses** `analyzeOutcome()` and never
  reimplements verification. Its note is explicit: *"a claim, exit code or model confidence
  never verifies."* It writes `verification_state` of `independently_verified`,
  `contradicted`, `unresolved`, or `observed`, with confidence `0.85` only when verified,
  else `0.4`. It is project-scoped, bounded, idempotent
  (`UNIQUE(project_id, source_type, source_id)`) and fails closed if Phase 21 verification is
  unavailable. No source write, no dispatch, no auto-approval.
- `errorLearning.js` links a fix to a pass **only** from a `TOOL` pass line with a
  verification command/result, preferring real tool output over prose that merely says
  "pass". Its report states "evidence only; no automatic verification promotion."

**Therefore, none of the following can verify a task or learning record:**

- an agent's own claim ("done", "OK");
- a process exit code of 0 (`process_ok`);
- a model's stated confidence;
- accumulated unverified repetitions of the same claim.

## Confidence rules

`learningIntelligence.js` `calculateConfidence()` is deterministic and returns a full
`breakdown` and human-readable `note`:

| Factor | Rule |
|---|---|
| Base by verification | `verified/confirmed .70`, `observed .45`, `inferred .30`, `uncertain .15`, `contradicted/stale .10`, `superseded .05` |
| Independent supports | `+.10` each, capped `+.30`, scaled by `evidence_quality` |
| Contradictions | `−.20` each, capped `−.60` |
| Occurrence bonus | `+.02` per extra occurrence, capped `+.10`, **only when verified** |
| Recency | `+.03` (0 days) down to `−.03` (≥30 days) |
| Unverified cap | confidence never exceeds **0.50** without verification |

Supports and contradictions are de-duplicated by `id` (or stable value), so repeated
reporting of one source is counted once. The note states: *"Repetition alone never raises an
unverified claim above 0.50."*

## Feedback

`learningPipeline.js` defines `FEEDBACK_VERDICTS = ["confirmed", "corrected", "rejected", "outdated"]`.

- `recordFeedback()` requires an explicit project and a valid verdict. The only
  confidence-raising verdict, `confirmed`, **requires `explicit_feedback === true`**. Rows
  are never deleted and audits carry no content.
- `applyFeedback()` requires explicit feedback, or an override backed by non-empty evidence.
  Deltas: `confirmed +0.05`, `corrected −0.15`, `rejected −0.25`, `outdated −0.10`. A single
  weak positive signal is ignored when confidence is already ≥ 0.9. It changes **confidence
  and evidence history only** — `verification` is never promoted (`verification_unchanged:true`).
  It is idempotent (`applied` flag) and transactional (`FOR UPDATE`).
- `retrievalFeedback.js` adds `observeUsage()`, `explicitFeedback()` and
  `usefulnessSummary()` for usefulness signals.

## Recurring failures

`errorLearning.js` implements failure evidence (not strategy promotion):

- `isErrorLine()` filters real failure signatures (pytest `FAILED`, `AssertionError`,
  "failed", etc.) while filtering documentation noise and "0 failed / no error" lines.
- `fingerprint()` normalizes paths, ids and numbers, then hashes with SHA-256 (24 hex chars).
- `recordFailure()` stores `observed_failure` at confidence `0.8`; `recordFix()` upgrades to
  `verified_fix` (`0.75`) only when the verification result matches a pass pattern, otherwise
  `attempted_fix` (`0.45`).
- `observeRecurrence()` marks `regressed` (`0.35`) if the error reappears, or after a window
  (default 7 days) records `strongly_supported` (`0.8`) / `non_recurrence` (`0.55`).
- `analyzeSessionErrors()` and `fixEvidenceReport()` provide bounded analysis and reporting.
  The report note: "evidence only; no automatic verification promotion."

## Evaluation

- `recommendationEvaluation.js`: `classifyRecommendation()` separates operator decision,
  action occurrence and result verification; `evaluateRecommendation()`,
  `listRecommendationEvaluations()`, and `recommendationEffectiveness()` with `min_samples`
  and window guards.
- `predictionEvaluation.js`: `evaluatePrediction()`, `getPredictionEvaluation()`,
  `predictionSummary()` with `min_samples` gating.
- `decompositionEvaluation.js`, `adaptRecalibration` modules feed calibration, but proposals
  require review and explicit apply — no auto-apply.

## Limitations (honest)

- All analysis is **deterministic and heuristic**: token overlap, keyword allow-lists, regex
  markers and fingerprints. There is no semantic LLM and no AST parser.
- Incomplete transcripts are refused, so learning is gated on a durable transcript sequence.
- Similarity/dedup is approximate; accumulated test fixtures can pollute bounded top-N
  results (a documented Phase 28 regression anomaly: identical semantic duplicates pushed a
  new candidate out of a bounded top-30).
- Verification is conservative by design: most captured experience stays `observed` or
  `inferred` until explicit evidence arrives. This is intentional, not a defect.
- Presence of a pipeline record or a passing unit test is not runtime verification of a real
  host task. Real OpenCode agent execution remains unverified without explicit operator
  authorization (Phase 28).
- No universal production-readiness claim is made; the tested scope is a local deployment.
