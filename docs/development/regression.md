# Regression and known anomalies

The regression is run in chunks, with anomalies classified rather than hidden. Preserve the Phase 28 findings verbatim in spirit: passing assertions are not the same as runtime verification.

## Phase 28 regression results

From `logs/phase28-final-report.md` §H:

| Segment | Result |
|---|---|
| 90 test files discovered | — |
| Chunks 1–10 | 1020 tests, 1017 pass |
| Chunk 11 (7 files, excluding `phases678`) | 102 tests, 102 pass |
| Chunk 12 | 12 tests, 12 pass |
| `phases678.test.js` (~9 tests) | **not confirmed** — hung after partial passing output; child terminated (known lingering handle) |

Approximate totals: ≈1143 tests discovered, ~1134 assertion-level results captured. Pipeline audit: **137/137** present, 0 missing, `verifiedBehavior:false`, `NO_RUNTIME_CLAIM` preserved. Phase 28 targeted suite (`phase28-hardening.test.js`): **13/13**.

## The four classified anomalies

None is a Phase 28 assertion failure. **Do not misclassify them as passes.**

1. **`phase10` semantic duplicate** — accumulated identical test memories push the new candidate out of a bounded top-30. Test-data pollution, verified by direct probe; no Phase 28 code touches semantic modules.
2. **`phase15-pipeline` concurrent-write count fluctuation** — passes in isolation; count varies under concurrency.
3. **`phase22-security` concurrent-write count fluctuation** — passes in isolation; count varies under concurrency.
4. **`phases678.test.js` lingering process handle** — prints passing cases then hangs; terminate the child and report honestly. Not confirmed in the Phase 28 run.

## Classification scheme

When a run is unstable, classify each anomaly as one of:

- **assertion** — a real test failure; fix the code.
- **infrastructure** — environment/service issue (e.g. Docker Desktop restart killed a run mid-suite).
- **concurrency** — count/order fluctuation under parallel writes; re-run serialized to confirm.
- **lingering-handle** — process stays alive after passing output; terminate and report as not confirmed.

## Chunking procedure

1. Use the isolated database: `$env:MEMORY_DB_NAME='opencode_memory_test'`.
2. Serialize: `node --test --test-concurrency=1 test/*.test.js`.
3. Split the test files into bounded chunks so a hang in `phases678` does not block the rest; run that file last and with a timeout/watchdog.
4. Record counts per chunk; classify any deviation using the scheme above.
5. Run read-only audits alongside: `node src/cli.js pipeline-audit`, `node src/cli.js ops-health`, `node src/cli.js pipeline-processing --limit 20`.

## Evidence discipline

- Presence-only wiring checks (`pipeline_wiring_audit`, `pipeline-audit`) are not runtime verification; keep `NO_RUNTIME_CLAIM` and `verifiedBehavior:false`.
- Do not infer task completion from exit code 0, agent claims, model confidence, or a summary.
- Recovery rules: no approval → no resume (`can_resume:false`, `required_approval:true`, `never_auto_resume:true`).
- Real OpenCode agent execution was not demonstrated in Phase 28; report historical evidence at its true tier.
- Readiness remains **"Conditionally ready with documented limitations for the tested local deployment scope."** `Production-ready` is not claimed merely because tests pass.
