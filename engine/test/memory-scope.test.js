import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/core.js";
import {
  isGloballyEligible,
  scopeFilter,
  filterMemoryResults,
  globalMisclassificationReport,
  memoryAccessGuard,
} from "../src/memoryScope.js";

const projectA = `scope-a-${randomUUID()}`;
const projectB = `scope-b-${randomUUID()}`;
const idA = randomUUID();
const idB = randomUUID();
const idIneligible = randomUUID();
const idFlag = randomUUID();
const idApproval = randomUUID();
const GLOBAL = "_global";

let allRows = [];
const byId = (id) => allRows.find((r) => r.id === id);

test.before(async () => {
  // Session-local temp tables only; nothing is written to public.memory and the
  // temp tables vanish when the pool connection closes. No rows are ever deleted.
  await core.dbQuery("CREATE TEMP TABLE memory (LIKE public.memory INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
  // Migration 012 may already have added the column; keep this idempotent.
  const exists = (await core.dbQuery(
    "SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('pg_temp.memory') AND attname='global_eligible' AND NOT attisdropped",
  )).rowCount;
  if (!exists) await core.dbQuery("ALTER TABLE pg_temp.memory ADD COLUMN global_eligible boolean NOT NULL DEFAULT false");
  await core.dbQuery("SET search_path TO pg_temp");
  await core.dbQuery(
    `INSERT INTO pg_temp.memory
       (id, project_id, layer, title, content, source_kind, verified, metadata, global_eligible, source_session)
     VALUES
       ($1,  $2, 'project',    'A private marker',   'project A private marker content', 'observed', false, '{}'::jsonb,                       false, 'sess-A'),
       ($3,  $4, 'project',    'B private marker',   'project B private marker content', 'observed', false, '{}'::jsonb,                       false, 'sess-B'),
       ($5,  $6, 'knowledge',  'ineligible global',  'leaky global content',             'observed', false, '{}'::jsonb,                       false, 'sess-ineligible'),
       ($7,  $6, 'session',    'eligible by flag',   'explicitly flagged global',        'observed', false, '{}'::jsonb,                       true,  'sess-flag'),
       ($8,  $6, 'user',       'eligible by approval','approved user fact',              'user',     true,  '{"global_approval": true}'::jsonb, false, 'sess-approval')`,
    [idA, projectA, idB, projectB, idIneligible, GLOBAL, idFlag, idApproval],
  );
  allRows = (await core.dbQuery("SELECT * FROM memory")).rows;
});

test.after(() => core.close());

test("project A private marker cannot be returned to project B via filterMemoryResults or scopeFilter", async () => {
  assert.equal(byId(idA).project_id, projectA);
  assert.equal(byId(idB).project_id, projectB);

  // Post-filter: asking for project B must drop project A's private marker.
  const filtered = filterMemoryResults(allRows, { project_id: projectB });
  const filteredIds = filtered.map((r) => r.id);
  assert.ok(filteredIds.includes(idB), "project B's own row must survive");
  assert.ok(!filteredIds.includes(idA), "project A private marker must not leak to project B");

  // SQL fragment built the same way, executed against real test-created rows.
  const forB = scopeFilter({ project_id: projectB });
  const bRows = (await core.dbQuery(`SELECT id FROM memory WHERE ${forB.sql}`, forB.params)).rows.map((r) => r.id);
  assert.ok(bRows.includes(idB));
  assert.ok(!bRows.includes(idA), "scopeFilter must not include project A's row for project B");

  const forA = scopeFilter({ project_id: projectA });
  const aRows = (await core.dbQuery(`SELECT id FROM memory WHERE ${forA.sql}`, forA.params)).rows.map((r) => r.id);
  assert.ok(aRows.includes(idA));
  assert.ok(!aRows.includes(idB), "scopeFilter must not include project B's row for project A");

  // No other project is ever included: with no globals allowed, only the requested project.
  const noGlobal = scopeFilter({ project_id: projectA, allow_global: false });
  const ngRows = (await core.dbQuery(`SELECT DISTINCT project_id FROM memory WHERE ${noGlobal.sql}`, noGlobal.params)).rows;
  assert.deepEqual(ngRows.map((r) => r.project_id), [projectA]);
});

test("ineligible _global memory is excluded; eligible _global memory (with explicit approval metadata) is included", async () => {
  assert.equal(isGloballyEligible(byId(idIneligible)), false);
  assert.equal(isGloballyEligible(byId(idFlag)), true, "explicit global_eligible flag makes a row eligible");
  assert.equal(isGloballyEligible(byId(idApproval)), true, "verified user fact with global_approval makes a row eligible");

  const filtered = filterMemoryResults(allRows, { project_id: projectA }).map((r) => r.id);
  assert.ok(!filtered.includes(idIneligible), "ineligible global must be excluded");
  assert.ok(filtered.includes(idFlag), "flag-eligible global must be included");
  assert.ok(filtered.includes(idApproval), "approval-eligible global must be included");

  const scoped = scopeFilter({ project_id: projectA });
  const sqlIds = (await core.dbQuery(`SELECT id FROM memory WHERE ${scoped.sql}`, scoped.params)).rows.map((r) => r.id);
  assert.ok(!sqlIds.includes(idIneligible));
  assert.ok(sqlIds.includes(idFlag));
  assert.ok(sqlIds.includes(idApproval));

  // allow_global=false removes ALL globals, even eligible ones.
  const noGlobal = filterMemoryResults(allRows, { project_id: projectA, allow_global: false }).map((r) => r.id);
  assert.ok(!noGlobal.includes(idFlag));
  assert.ok(!noGlobal.includes(idApproval));
  assert.ok(noGlobal.includes(idA));

  // A pure helper must not mutate its inputs.
  const frozen = allRows.map((r) => Object.freeze({ ...r }));
  const before = JSON.stringify(frozen);
  filterMemoryResults(frozen, { project_id: projectB });
  assert.equal(JSON.stringify(frozen), before, "filterMemoryResults must not mutate input rows");
});

test("globalMisclassificationReport is read-only and lists misclassified globals with reasons", async () => {
  const countsBefore = (await core.dbQuery("SELECT project_id, count(*)::int AS n FROM memory GROUP BY 1 ORDER BY 1")).rows;

  const report = await globalMisclassificationReport({ limit: 10 });
  assert.equal(report.auto_applied, 0);
  assert.equal(report.destructive_operations, 0);
  assert.match(report.note, /never changes memory/i);

  const ids = report.items.map((r) => r.id);
  assert.ok(ids.includes(idIneligible), "ineligible global must be reported");
  assert.ok(!ids.includes(idFlag), "flag-eligible global must not be reported");
  assert.ok(!ids.includes(idApproval), "approval-eligible global must not be reported");
  const mis = report.items.find((r) => r.id === idIneligible);
  for (const field of ["id", "source_session", "source_kind", "layer", "created_at", "reason"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(mis, field), `missing ${field}`);
  }
  assert.equal(mis.source_session, "sess-ineligible");
  assert.equal(mis.source_kind, "observed");
  assert.equal(mis.layer, "knowledge");
  assert.ok(typeof mis.reason === "string" && mis.reason.length > 0);
  assert.ok(report.total >= 1);
  assert.ok(report.items.length <= 10, "report must respect the limit");

  const countsAfter = (await core.dbQuery("SELECT project_id, count(*)::int AS n FROM memory GROUP BY 1 ORDER BY 1")).rows;
  assert.deepEqual(countsAfter, countsBefore, "read-only report must not change any counts");
});

test("memoryAccessGuard allows approved admin tools and scopes retrieval tools", async () => {
  for (const tool of ["memory_update", "memory_delete", "memory_lifecycle", "memory_suggestion_resolve"]) {
    const g = memoryAccessGuard({ tool, project_id: projectB });
    assert.equal(g.allowed, true, `${tool} must be allowed`);
    assert.equal(g.audited_by_caller, true, `${tool} must be audited by caller`);
  }

  const scoped = memoryAccessGuard({ tool: "memory_search", project_id: projectA });
  assert.equal(scoped.allowed, true);
  assert.equal(scoped.scope, "project");
  assert.equal(scoped.project_id, projectA);
  assert.equal(scoped.require_global_eligibility, true);

  // project_id can be supplied via args too.
  const fromArgs = memoryAccessGuard({ tool: "memory_semantic_search", args: { project_id: projectB } });
  assert.equal(fromArgs.allowed, true);
  assert.equal(fromArgs.project_id, projectB);

  // Retrieval without a project scope is denied by default (no cross-project leakage).
  const unscoped = memoryAccessGuard({ tool: "memory_list" });
  assert.equal(unscoped.allowed, false);
  assert.match(unscoped.reason, /project scope/i);

  // An explicit global request is allowed but constrained to eligible globals only.
  const globalOnly = memoryAccessGuard({ tool: "memory_search", project_id: GLOBAL });
  assert.equal(globalOnly.allowed, true);
  assert.equal(globalOnly.scope, "global-eligible-only");
  assert.equal(globalOnly.require_global_eligibility, true);

  const unknown = memoryAccessGuard({ tool: "not_a_real_tool" });
  assert.equal(unknown.allowed, false);
});

test("no existing memory is reclassified (project_id counts and rows are unchanged)", async () => {
  const countsBefore = (await core.dbQuery("SELECT project_id, count(*)::int AS n FROM memory GROUP BY 1 ORDER BY 1")).rows;
  const projectsBefore = (await core.dbQuery("SELECT id, project_id FROM memory ORDER BY id")).rows;

  // Exercise every exported entry point; none may reclassify or mutate rows.
  isGloballyEligible(byId(idIneligible));
  scopeFilter({ project_id: projectA });
  filterMemoryResults(allRows, { project_id: projectA });
  await globalMisclassificationReport({ limit: 5 });
  memoryAccessGuard({ tool: "memory_get", project_id: projectA });

  const countsAfter = (await core.dbQuery("SELECT project_id, count(*)::int AS n FROM memory GROUP BY 1 ORDER BY 1")).rows;
  const projectsAfter = (await core.dbQuery("SELECT id, project_id FROM memory ORDER BY id")).rows;
  assert.deepEqual(countsAfter, countsBefore, "counts per project_id must be unchanged");
  assert.deepEqual(projectsAfter, projectsBefore, "no row's project_id may be reclassified");
  assert.equal(byId(idIneligible).project_id, GLOBAL, "ineligible global must remain _global");
});
