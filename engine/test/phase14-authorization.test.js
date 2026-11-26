import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/core.js";
import {
  authorizeMemoryAccess,
  authorizeRelationshipTraversal,
  authorizeVersionHistory,
  authorizeSessionDetail,
  authorizeSuggestionAccess,
  auditAccessDecision,
  securityAuditReport,
} from "../src/memoryAuthorization.js";

const GLOBAL = "_global";
const projectA = `authz-a-${randomUUID()}`;
const projectB = `authz-b-${randomUUID()}`;
const mA = randomUUID();
const mB = randomUUID();
const mA2 = randomUUID();
const mGlobalFlag = randomUUID();
const mGlobalApproval = randomUUID();
const mIneligible = randomUUID();
const mSecret = randomUUID();
const secretMarker = `AUTHZ_SECRET_${randomUUID()}`;
const sessionA = `sess-a-${randomUUID()}`;
const sessionB = `sess-b-${randomUUID()}`;
const sugDeny = randomUUID();
const sugAllow = randomUUID();

test.before(async () => {
  // Unique rows only; nothing is ever deleted or reclassified.
  await core.dbQuery(
    `INSERT INTO memory (id, project_id, layer, title, content, source_kind, verified, metadata, global_eligible)
     VALUES
       ($1, $2, 'project',    'A private',           'a private marker',          'observed', false, '{}'::jsonb,                       false),
       ($3, $4, 'project',    'B private',           'b private marker',          'observed', false, '{}'::jsonb,                       false),
       ($5, $2, 'project',    'A private two',       'a2 private marker',         'observed', false, '{}'::jsonb,                       false),
       ($6, $7, 'knowledge',  'eligible by flag',    'eligible flag marker',      'observed', false, '{}'::jsonb,                       true),
       ($8, $7, 'user',       'eligible by approval','eligible approval marker',  'user',     true,  '{"global_approval": true}'::jsonb, false),
       ($9, $7, 'knowledge',  'ineligible global',   'ineligible marker',         'observed', false, '{}'::jsonb,                       false),
       ($10,$2, 'project',    'secret content',      $11,                         'observed', false, '{}'::jsonb,                       false)`,
    [mA, projectA, mB, projectB, mA2, mGlobalFlag, GLOBAL, mGlobalApproval, mIneligible, mSecret, secretMarker],
  );
  await core.dbQuery(
    `INSERT INTO memory_relationships (source_id, target_id, relation)
     VALUES ($1,$2,'related'), ($3,$4,'related')`,
    [mA, mB, mA2, mGlobalFlag],
  );
  await core.dbQuery(
    "INSERT INTO memory_history (memory_id, version, content) VALUES ($1, 2, $2)",
    [mA, `history marker ${secretMarker}`],
  );
  await core.dbQuery(
    "INSERT INTO session_index (id, project_id) VALUES ($1,$2),($3,$4)",
    [sessionA, projectA, sessionB, projectB],
  );
  await core.dbQuery(
    `INSERT INTO consolidation_suggestion (id, kind, memory_ids, title, description)
     VALUES ($1,'review',$2::uuid[],'deny sug','deny sug desc'),
            ($3,'review',$4::uuid[],'allow sug','allow sug desc')`,
    [sugDeny, [mA, mB], sugAllow, [mA, mGlobalFlag]],
  );
});

test.after(() => core.close());

test("cross-project direct ID access is denied; same project is allowed", async () => {
  const cross = await authorizeMemoryAccess({ tool: "memory_get", project_id: projectA, memory_id: mB });
  assert.equal(cross.allowed, false);
  assert.equal(cross.scope, "denied");
  assert.match(cross.reason, /different project/i);
  assert.equal(cross.audit.logged, true);

  const reverse = await authorizeMemoryAccess({ tool: "memory_get", project_id: projectB, memory_id: mA });
  assert.equal(reverse.allowed, false);
  assert.equal(reverse.scope, "denied");

  const own = await authorizeMemoryAccess({ tool: "memory_get", project_id: projectA, memory_id: mA });
  assert.equal(own.allowed, true);
  assert.equal(own.scope, "project");

  // Retrieval without a project scope fails closed.
  const unscoped = await authorizeMemoryAccess({ tool: "memory_get", memory_id: mA });
  assert.equal(unscoped.allowed, false);
  assert.equal(unscoped.scope, "none");
});

test("indirect paths (relationship, version, session, suggestion) deny cross-project data", async () => {
  const rel = await authorizeRelationshipTraversal({ project_id: projectA, memory_id: mA });
  assert.equal(rel.allowed, false, "traversal must deny when a target is another project's private memory");
  assert.ok(rel.blocked_count >= 1);
  assert.ok(!rel.relations.some((r) => r.visible_memory_id === mB), "private target must not be returned");

  const ver = await authorizeVersionHistory({ project_id: projectA, memory_id: mB });
  assert.equal(ver.allowed, false);
  assert.equal(ver.version_count, 0);

  const sess = await authorizeSessionDetail({ project_id: projectA, session_id: sessionB });
  assert.equal(sess.allowed, false);

  const sug = await authorizeSuggestionAccess({ project_id: projectA, suggestion_id: sugDeny });
  assert.equal(sug.allowed, false);
  assert.ok(sug.blocked_count >= 1);
});

test("globally eligible memories (flag or explicit approval) are allowed across scopes", async () => {
  const byFlag = await authorizeMemoryAccess({ project_id: projectA, memory_id: mGlobalFlag });
  assert.equal(byFlag.allowed, true);
  assert.equal(byFlag.scope, "global-eligible");

  const byApproval = await authorizeMemoryAccess({ project_id: projectA, memory_id: mGlobalApproval });
  assert.equal(byApproval.allowed, true);
  assert.equal(byApproval.scope, "global-eligible");

  const ineligible = await authorizeMemoryAccess({ project_id: projectA, memory_id: mIneligible });
  assert.equal(ineligible.allowed, false);

  // A relation to an eligible global is visible (and therefore allowed).
  const rel = await authorizeRelationshipTraversal({ project_id: projectA, memory_id: mA2 });
  assert.equal(rel.allowed, true);
  assert.ok(rel.relations.some((r) => r.visible_memory_id === mGlobalFlag));

  // In-scope version history and session detail succeed.
  const ver = await authorizeVersionHistory({ project_id: projectA, memory_id: mA });
  assert.equal(ver.allowed, true);
  assert.ok(ver.version_count >= 1);
  const sess = await authorizeSessionDetail({ project_id: projectA, session_id: sessionA });
  assert.equal(sess.allowed, true);
  const sug = await authorizeSuggestionAccess({ project_id: projectA, suggestion_id: sugAllow });
  assert.equal(sug.allowed, true);
});

test("admin must be explicitly true: default/false denied, true allowed and audited", async () => {
  const noFlag = await authorizeMemoryAccess({ project_id: projectB, memory_id: mA });
  assert.equal(noFlag.allowed, false);

  const explicitFalse = await authorizeMemoryAccess({ project_id: projectB, memory_id: mA, admin: false });
  assert.equal(explicitFalse.allowed, false);

  const notBoolean = await authorizeMemoryAccess({ project_id: projectB, memory_id: mA, admin: "true" });
  assert.equal(notBoolean.allowed, false, "truthy non-boolean admin must not grant access");

  const admin = await authorizeMemoryAccess({ project_id: projectB, memory_id: mA, admin: true });
  assert.equal(admin.allowed, true);
  assert.equal(admin.scope, "admin");
  assert.equal(admin.audit.logged, true);

  const rows = (await core.dbQuery(
    `SELECT resource, detail FROM intelligence_audit_events
      WHERE action='access_decision' AND resource=$1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [mA],
  )).rows;
  assert.ok(rows.length >= 1, "admin decision must be audited");
  assert.equal(rows[0].resource, mA);
  assert.equal(rows[0].detail.allowed, true);
  assert.equal(rows[0].detail.scope, "admin");
});

test("decisions are logged with ids/actions only -- never memory content", async () => {
  const decision = await authorizeMemoryAccess({
    tool: "memory_get", project_id: projectA, memory_id: mSecret,
  });
  assert.equal(decision.allowed, true);

  const rows = (await core.dbQuery(
    `SELECT resource, detail FROM intelligence_audit_events
      WHERE action='access_decision' AND resource=$1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [mSecret],
  )).rows;
  assert.ok(rows.length >= 1);
  const detail = rows[0].detail;
  const raw = JSON.stringify(detail);
  assert.ok(!raw.includes(secretMarker), "audit detail must not contain memory content");
  assert.equal(detail.memory_id, mSecret);
  assert.equal(detail.project_id, projectA);
  assert.equal(detail.allowed, true);
  assert.ok(typeof detail.reason === "string" && detail.reason.length > 0);
  for (const forbidden of ["content", "title", "summary", "description"]) {
    assert.ok(!(forbidden in detail), `audit detail must not carry '${forbidden}'`);
  }

  // The standalone primitive also writes a content-free event.
  const extra = await auditAccessDecision(
    { allowed: false, action: "read", scope: "denied", reason: "probe" },
    { tool: "memory_get", memory_id: mB, project_id: projectA },
  );
  assert.equal(extra.ok, true);
  const extraRows = (await core.dbQuery(
    "SELECT detail FROM intelligence_audit_events WHERE id=$1", [extra.id],
  )).rows;
  assert.ok(!JSON.stringify(extraRows[0].detail).includes("private marker"));
});

test("securityAuditReport is a read-only count summary", async () => {
  const before = (await core.dbQuery("SELECT count(*)::int AS n FROM intelligence_audit_events")).rows[0].n;
  const report = await securityAuditReport({ project_id: projectA, limit: 5 });
  const after = (await core.dbQuery("SELECT count(*)::int AS n FROM intelligence_audit_events")).rows[0].n;

  assert.equal(after, before, "report must not insert/update/delete audit events");
  assert.equal(report.ok, true);
  assert.equal(report.auto_applied, 0);
  assert.equal(report.destructive_operations, 0);
  assert.match(report.note, /never changes/i);
  assert.ok(report.total >= 1);
  assert.equal(report.total, report.allowed + report.denied);
  assert.ok(report.items.length <= 5, "report must respect the limit");
  for (const item of report.items) {
    for (const forbidden of ["content", "title", "summary", "description"]) {
      assert.ok(!(forbidden in item), `report items must not carry '${forbidden}'`);
    }
  }
});
