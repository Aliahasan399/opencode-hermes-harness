# Migrations

Schema changes are **strictly additive and reversible**. This rule is enforced in the SQL itself and by the operational runbook.

## Naming and ordering

- Migrations live in `engine/init/` and are named `NNN-description.sql`, from `001-init.sql` to `026-phase28-hardening.sql`.
- On a fresh volume, `init/` is mounted read-only into `/docker-entrypoint-initdb.d` and executed in lexicographic order. A clean install requires no data dump (`docs/database.md`).
- `001-init.sql` creates extensions and base tables. Later migrations add tables, columns, indexes, constraints, or functions.

## Additivity rules

Every migration follows these patterns (quoted from the migration headers):

- `CREATE TABLE IF NOT EXISTS ...`
- `CREATE INDEX IF NOT EXISTS ...`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
- `CREATE OR REPLACE FUNCTION ...`
- `DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT` (used to widen a CHECK)

Never use `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or a data-rewriting update in a migration. No existing row, table, constraint, or index is changed or removed by an additive migration. This makes re-application safe: **all migrations are idempotent**.

## Workflow for a new migration

1. **Back up first.** Take a pre-migration backup of production (`docs/database.md`) before touching any real database.
2. **Add the file** `NNN-description.sql` using only the additive patterns above. Include a header comment stating that it is strictly additive and reversible.
3. **Apply to the isolated test database first.** Set `MEMORY_DB_NAME=opencode_memory_test` and apply the migration there. Verify idempotency by applying it a second time and confirming no errors.
4. **Verify** table/index presence and that representative queries still work. Run the relevant tests against the isolated database (`docs/development/testing.md`).
5. **Then apply to production**, and re-check. Never run the test suite against production as a way to validate a migration.
6. **Document rollback.** For example, migration 026's rollback is `DROP INDEX IF EXISTS p28_*` (eight named indexes).

## Idempotency and the no-tracking caveat

- `IF NOT EXISTS` means a migration can be re-run without error — important because there is **no migration-tracking table**. Applied state is inferred from table/index presence.
- Without tracking, never assume a migration ran just because it exists in `init/`. Verify presence (e.g. query `information_schema` for the expected table/column/index) rather than guessing.
- If a newer schema object is needed for a test, apply the migration to the isolated database; do not force-recreate production objects.

## Project-scoped migrations

Tables introduced in later phases carry `project_id`. When adding a high-traffic project-scoped table or column, add an additive `project_id` index (the Phase 28 pattern) so isolation filters stay efficient. See `docs/development/project-isolation.md`.

## Never do this

- No destructive reset (`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`) against a real database.
- No restore over production; restores go to a scratch database and compare counts (`docs/database.md`).
- No data reclassification or deletion as a side effect of a migration.
- No dependency upgrades or source rewriting bundled into a schema change.
