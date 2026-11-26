# Testing

Tests use Node's built-in test runner. `engine/package.json` defines:

```json
"test": "node --test test/*.test.js"
```

There are 90 test files in `engine/test/`. Do **not** run the full suite directly against the production database.

## Golden rule: isolated database

`engine/src/core.js` selects the database from `MEMORY_DB_NAME` (falling back to `MEMORY_DB_USER`/`MEMORY_DB_NAME` file values). Historically, tests run without overriding it wrote fixtures into production; fixtures are additive (unique UUIDs, no deletes), so rows accumulated. No production row was ever deleted or reclassified.

Always override to the isolated database and serialize:

```powershell
cd <repo>/engine
$env:MEMORY_DB_NAME='opencode_memory_test'
node --test --test-concurrency=1 test/*.test.js
Remove-Item Env:MEMORY_DB_NAME
```

Why serialized: parallel runs race on shared `harness_state` / live-DB fixtures. Why isolated: consolidation/pattern tests (`phases678.test.js`) scan all memories; against a 10k+ row production database the serialized suite did not finish within ~45 minutes, while the isolated database is both faster and non-contaminating.

Keep the isolated schema current by applying migrations to `opencode_memory_test` (never to production as a test side effect). If a test needs a table not yet present, apply the existing additive migration to the test database first (`docs/development/migrations.md`). Do not mix real end-to-end OpenCode sessions with unit tests in one run: real E2E sessions intentionally use the production database; unit/integration fixtures use the override.

## Chunked regression

The Phase 28 regression split the suite into 12 chunks. Reported results (`logs/phase28-final-report.md`):

| Chunk | Result |
|---|---|
| 1–10 | 1020 tests, 1017 pass |
| 11 (7 files, excluding `phases678`) | 102 tests, 102 pass |
| 12 | 12 tests, 12 pass |
| `phases678.test.js` (~9 tests) | **not confirmed** — process hung after partial passing output, terminated (lingering handle) |

Total discovered ≈ 1143 tests; ~1134 assertion-level results captured. Pipeline audit: **137/137** present, 0 missing, `verifiedBehavior:false`, `NO_RUNTIME_CLAIM` preserved. Phase 28 targeted suite (`phase28-hardening.test.js`): **13/13**. See `docs/development/regression.md` for the four classified anomalies.

## Writing tests

- Mirror the module under test: one `*.test.js` per phase/module, named `phaseNN-*.test.js` where applicable.
- Use unique fixture prefixes (`p15-*`, `p16-*`, `verify-*`, etc.); optionally set `provenance='test_fixture'` so attribution is one query rather than a prefix heuristic.
- Test untrusted-input boundaries: injection-as-data, redaction, cross-project isolation, explicit-admin-only access, and fail-closed UUIDs.
- Tests are additive: do not delete historical rows to "clean up"; rotate to a fresh scratch database if fixture volume becomes a problem.
- Verify safety invariants in tests: `OPTIMIZATION_LEVEL=1`, `HARNESS_SEMANTIC_LLM=0`, no auto-approval, no source writes.

## Useful commands

```powershell
# single file
node --test test/phase28-hardening.test.js

# LLM disabled, serialized, isolated DB
$env:MEMORY_DB_NAME='opencode_memory_test'
node --test --test-concurrency=1 test/*.test.js

# pipeline wiring (presence-only)
node src/cli.js pipeline-audit
node src/cli.js pipeline-processing --limit 20
node src/cli.js ops-health
```

## Honest limitations

- Passing tests do **not** prove runtime correctness; wiring audits are presence-only.
- Four inherited anomalies remain documented and must not be reported as passes.
- Real OpenCode agent execution was not demonstrated in Phase 28; tests exercise control paths, not fresh dispatch.
- No compatibility claim beyond the tested local Windows scope (`docs/compatibility.md`).
