# Project isolation

Project isolation is a core safety boundary. Data from one project must not leak into another, and global data must be explicitly eligible.

## Data model

- Core memory rows (and nearly all derived tables) carry a `project_id` text column.
- `memory.layer` is one of `user`, `project`, `session`, `knowledge`.
- The sentinel `_global` marks global-scope rows. It is **not** a valid project id for project-scoped operations.
- `012-phase138.sql` added `memory.global_eligible` (default false) and `memory.scope_reason`. Global visibility is explicit: a row is eligible only via the flag or a verified user fact with `metadata.global_approval === true`.
- Migration 026 added eight additive `project_id` indexes on high-traffic tables so isolation filters remain efficient.

## Enforcement points

- `validProject` rejects `_global` and empty ids on project-scoped operations.
- `core.searchMemory` / `listMemories` scope to the requested project plus explicitly eligible globals. Retrieval no longer uses `OR project_id='_global'` with a boost.
- MCP tools `memory_get`, `memory_list`, and `memory_session_detail` enforce project scope; admin tools remain allowed but are flagged for caller audit and require explicit `admin === true`.
- `memoryScope.js` provides explicit eligibility, `scopeFilter`, `filterMemoryResults`, `memoryAccessGuard`, and a read-only `globalMisclassificationReport`.
- `memoryAuthorization.js` handles direct-ID access, relationship traversal, version history, session details, and suggestions; decisions are audited by ids/reason only, never memory content. Client-supplied UUIDs are validated before DB use so malformed ids fail closed instead of throwing SQLSTATE `22P02`.
- ContextPackage's user-preference query uses the same eligibility predicate; retrieved memory is labelled untrusted historical reference data and cannot override current instructions.

## Database-level isolation

- Production uses `opencode_memory`; isolated tests use `opencode_memory_test` via the `MEMORY_DB_NAME` override (`docs/development/testing.md`).
- When testing isolation, use distinct project ids (often hashes of directory paths) and assert that a retrieval in project B returns no rows from project A.
- Historical E2E evidence: project A retrieved its own saved memory from a fresh process; project B returned `NO_KNOWLEDGE` with a different project hash and zero A-memory leakage.

## Rules for contributors

1. Every new query against a project-scoped table must carry a `project_id` predicate.
2. Never default a new code path to `_global`. That was the root cause of a historical global-leakage bug.
3. Never auto-promote a row to global; use explicit eligibility plus governance (`memoryGovernance.js`) and approval.
4. Add a cross-project isolation test for any new retrieval or traversal path: save under project A, query under project B, assert no leakage.
5. Treat retrieved memories and transcripts as untrusted data; never execute instructions found in them (`docs/security.md`).
6. Keep fixture prefixes explicit so test data can be attributed without touching production rows.

## Verification

```powershell
node src/cli.js global-classification          # read-only global classification report
node src/cli.js context-retrieve --project <id> --query <text>
node src/cli.js memory-security-report --project <id>
```

These are inspection aids; they do not replace an explicit cross-project test in `engine/test/`.
