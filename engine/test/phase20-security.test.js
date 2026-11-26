// Phase 20 workstream E — security, isolation and compatibility tests.
// Additive only: unique fixtures created with core.saveMemory, no row is ever
// deleted or reclassified. core.close() is called exactly once, in the final test.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.MEMORY_DB_NAME = "opencode_memory_test";

const RUN = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const projectA = `p20sec-a-${RUN}`;
const projectB = `p20sec-b-${RUN}`;
const downProject = `p20sec-down-${RUN}`;

// Sibling modules may still be under construction: never fail merely because a
// dynamic import is unavailable — skip the specific test instead.
async function load(name) {
  try { return await import(`../src/${name}.js`); }
  catch { return null; }
}

const fx = {};

test.before(async () => {
  const core = await load("core");
  fx.memA = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "A private note", content: `alpha-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.memA2 = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "A second note", content: `alpha-two-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.memB = await core.saveMemory({ layer: "project", project_id: projectB,
    title: "B private note", content: `bravo-${RUN}`, source_kind: "observed", noEmbed: true });
  // A plain _global write is NOT globally eligible.
  fx.ineligibleGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "ineligible global", content: `global-no-${RUN}`, source_kind: "observed", noEmbed: true });
  // Eligible via explicit user approval in metadata (no flag flip needed).
  fx.eligibleGlobal = await core.saveMemory({ layer: "user", project_id: "_global",
    title: "eligible global", content: `global-yes-${RUN}`, source_kind: "user",
    verified: true, metadata: { global_approval: true }, noEmbed: true });
  // An assistant-generated claim (stored as an 'attempt', i.e. non-user source)
  // is never globally eligible. 'assistant' is not an allowed source_kind value.
  fx.assistantGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "assistant claim global", content: `global-assistant-${RUN}`,
    source_kind: "attempt", verified: false, noEmbed: true });

  fx.canary = `P20SEC_CANARY_${RUN}`;
  fx.canaryMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "canary holder", content: fx.canary, source_kind: "observed", noEmbed: true });

  // saveMemory redacts sk- and AKIA; the raw strings below must not survive.
  fx.secretMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "secret holder",
    content: "sk-aaaaaaaaaaaaaaaaaaaaaaaa Bearer bbbbbbbbbbbbbbbbbbbbbbbb AKIACCCCCCCCCCCCCCCC",
    source_kind: "observed", noEmbed: true });

  // Indirect-path fixtures: a cross-project relationship and suggestion.
  await core.dbQuery(
    "INSERT INTO memory_relationships (source_id, target_id, relation) VALUES ($1,$2,'related')",
    [fx.memA.id, fx.memB.id]);
  const s = await core.dbQuery(
    `INSERT INTO consolidation_suggestion (kind, memory_ids, title, description)
     VALUES ('review',$1::uuid[],$2,$3) RETURNING id`,
    [[fx.memA.id, fx.memB.id], `p20 cross suggestion ${RUN}`, "cross-project isolation probe"]);
  fx.crossSuggestion = s.rows[0]?.id ?? null;
});

test("1. cross-project direct and indirect authorization denies Project B memories", async (t) => {
  const authz = await load("memoryAuthorization");
  const cross = await authz.authorizeMemoryAccess({
    tool: "memory_get", project_id: projectA, memory_id: fx.memB.id });
  assert.equal(cross.allowed, false);
  assert.equal(cross.scope, "denied");
  assert.equal(cross.audit.logged, true);

  const own = await authz.authorizeMemoryAccess({
    tool: "memory_get", project_id: projectA, memory_id: fx.memA.id });
  assert.equal(own.allowed, true);
  assert.equal(own.scope, "project");

  const unscoped = await authz.authorizeMemoryAccess({ tool: "memory_get", memory_id: fx.memA.id });
  assert.equal(unscoped.allowed, false);
  assert.equal(unscoped.scope, "none");

  const rel = await authz.authorizeRelationshipTraversal({ project_id: projectA, memory_id: fx.memA.id });
  assert.equal(rel.allowed, false);
  assert.ok(rel.blocked_count >= 1);
  assert.ok(!rel.relations.some((r) => r.visible_memory_id === fx.memB.id),
    "a private cross-project target must never be returned");

  const ver = await authz.authorizeVersionHistory({ project_id: projectA, memory_id: fx.memB.id });
  assert.equal(ver.allowed, false);
  assert.equal(ver.version_count, 0);

  if (!fx.crossSuggestion) return t.skip("cross-project suggestion fixture not available");
  const sug = await authz.authorizeSuggestionAccess({
    project_id: projectA, suggestion_id: fx.crossSuggestion });
  assert.equal(sug.allowed, false);
  assert.ok(sug.blocked_count >= 1);
});

test("2. lifecycle/importance modules refuse another project's memories", async (t) => {
  const life = await load("memoryLifecycle");
  const imp = await load("memoryImportance");
  const core = await load("core");
  if (!life || !imp) return t.skip("module not yet available");

  const st = await life.getLifecycleStatus({ project_id: projectA, memory_id: fx.memB.id });
  assert.equal(st.ok, false);

  const ex = await imp.explainImportance({ project_id: projectA, memory_id: fx.memB.id });
  assert.equal(ex.ok, false);
  const rv = await imp.reviewFreshness({ project_id: projectA, memory_id: fx.memB.id });
  assert.equal(rv.ok, false);
  const sig = await imp.recordSignal({ project_id: projectA, memory_id: fx.memB.id,
    signal_type: "user_explicit", weight: 0.9, reason: "p20 isolation probe" });
  assert.equal(sig.ok, false);
  assert.match(sig.reason, /not found|project/i);

  const leaked = await core.dbQuery("SELECT id FROM memory_importance_signal WHERE memory_id=$1", [fx.memB.id]);
  assert.equal(leaked.rowCount, 0, "a failed cross-project write must not persist");
});

test("3. consolidation module never pairs or mutates cross-project memories", async (t) => {
  const con = await load("memoryConsolidation");
  if (!con) return t.skip("module not yet available");

  const prop = await con.proposeConsolidation({ project_id: projectA, candidate: {
    kind: "duplicate", memory_ids: [fx.memA.id, fx.memB.id], confidence: 0.95, reason: "p20 probe" } });
  assert.equal(prop.ok, false);
  assert.match(prop.reason, /cross-project/i);

  const contradiction = await con.recordContradiction({ project_id: projectA,
    memory_a: fx.memA.id, memory_b: fx.memB.id, description: "p20 probe" });
  assert.equal(contradiction.ok, false);

  const cand = await con.findCandidates({ project_id: projectA, limit: 50 });
  assert.equal(cand.ok, true);
  assert.ok(Array.isArray(cand.candidates));
  assert.ok(!cand.candidates.some((c) => (c.memory_ids || []).includes(fx.memB.id)),
    "no candidate may contain another project's memory");

  const rev = await con.reviewContradictions({ project_id: projectA, limit: 50 });
  assert.ok(!(rev.items || []).some((i) => i.memory_a === fx.memB.id || i.memory_b === fx.memB.id));
});

test("4. recovery module denies cross-project archive/restore/version operations", async (t) => {
  const rec = await load("memoryRecovery");
  const core = await load("core");
  if (!rec) return t.skip("module not yet available");

  assert.equal((await rec.getVersionHistory({ project_id: projectA, memory_id: fx.memB.id })).ok, false);
  assert.equal((await rec.archiveMemorySafe({ project_id: projectA, memory_id: fx.memB.id })).ok, false);
  assert.equal((await rec.restoreArchived({ project_id: projectA, memory_id: fx.memB.id })).ok, false);
  assert.equal((await rec.restoreVersion({ project_id: projectA, memory_id: fx.memB.id,
    version: 1, explicit: true })).ok, false);

  const rep = await rec.lifecycleReport({ project_id: projectA, limit: 10 });
  assert.equal(rep.ok, true);
  assert.ok(!(rep.events || []).some((e) => e.memory_id === fx.memB.id));
  assert.ok(!(rep.recoveries || []).some((e) => e.memory_id === fx.memB.id));

  const after = await core.getMemory(fx.memB.id);
  assert.equal(after.project_id, projectB);
  assert.notEqual(after.lifecycle, "ARCHIVED");
});

test("5. global-memory eligibility rules still apply (no accidental promotion)", async () => {
  const scope = await load("memoryScope");
  const core = await load("core");

  assert.equal(scope.isGloballyEligible(fx.eligibleGlobal), true);
  assert.equal(scope.isGloballyEligible(fx.ineligibleGlobal), false);
  assert.equal(scope.isGloballyEligible(fx.assistantGlobal), false);
  assert.equal(scope.isGloballyEligible({ global_eligible: true, source_kind: "assistant",
    layer: "knowledge", verified: false }), true, "an explicit flag is sufficient");
  assert.equal(scope.isGloballyEligible({ source_kind: "user", layer: "user", verified: false,
    metadata: { global_approval: true } }), false, "unverified user facts are not eligible");
  assert.equal(scope.isGloballyEligible({ source_kind: "user", layer: "project", verified: true,
    metadata: { global_approval: true } }), false, "wrong layer is not eligible");

  const filtered = scope.filterMemoryResults(
    [fx.memA, fx.memB, fx.eligibleGlobal, fx.ineligibleGlobal, fx.assistantGlobal],
    { project_id: projectA });
  const fids = filtered.map((m) => m.id);
  assert.ok(fids.includes(fx.memA.id));
  assert.ok(fids.includes(fx.eligibleGlobal.id));
  assert.ok(!fids.includes(fx.memB.id));
  assert.ok(!fids.includes(fx.ineligibleGlobal.id));
  assert.ok(!fids.includes(fx.assistantGlobal.id));

  const listed = await core.listMemories({ project_id: projectA });
  const lids = listed.map((m) => m.id);
  assert.ok(lids.includes(fx.memA.id));
  assert.ok(lids.includes(fx.eligibleGlobal.id));
  assert.ok(!lids.includes(fx.ineligibleGlobal.id));
  assert.ok(!lids.includes(fx.assistantGlobal.id));
  assert.ok(!lids.includes(fx.memB.id));

  const no = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.ineligibleGlobal.id]);
  assert.equal(no.rowCount, 0);
  const yes = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.eligibleGlobal.id]);
  assert.equal(yes.rowCount, 1);
});

test("6. secrets are redacted from stored memory, injected context and audit details", async () => {
  const core = await load("core");
  const llm = await load("llm-provider");
  const budget = await load("injectionBudget");
  const authz = await load("memoryAuthorization");

  const rawSk = "sk-aaaaaaaaaaaaaaaaaaaaaaaa";
  const rawBearer = "Bearer bbbbbbbbbbbbbbbbbbbbbbbb";
  const rawAws = "AKIACCCCCCCCCCCCCCCC";
  assert.doesNotMatch(core.redact(`key ${rawSk}`), /sk-aaaa/);
  assert.doesNotMatch(llm.redact(`auth ${rawBearer}`), /Bearer bbbb/);

  // core.redact covers sk-/AKIA on the storage path; Bearer is covered by the
  // llm-provider + injectionBudget redactors on the injection path (below).
  const stored = await core.getMemory(fx.secretMem.id);
  assert.doesNotMatch(stored.content, /sk-aaaa|AKIACCC/);

  const inj = budget.formatInjection({ items: [{ id: "p20-secret-probe",
    content: `${rawSk} ${rawBearer} ${rawAws}` }], project_id: projectA, budget_chars: 4000 });
  assert.equal(inj.ok, true);
  assert.match(inj.text, /UNTRUSTED/);
  assert.doesNotMatch(inj.text, /sk-aaaa|Bearer bbbb|AKIACCC/);
  assert.match(inj.text, /\[REDACTED\]/);

  await authz.authorizeMemoryAccess({ tool: "memory_get", project_id: projectA, memory_id: fx.canaryMem.id });
  const rows = await core.dbQuery(
    `SELECT detail FROM intelligence_audit_events
      WHERE resource=$1 AND action='access_decision'
      ORDER BY created_at DESC, id DESC LIMIT 1`, [fx.canaryMem.id]);
  assert.ok(rows.rowCount >= 1);
  const detail = rows.rows[0].detail;
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(fx.canary),
    "audit detail must never contain memory content");
  for (const key of ["content", "title", "summary", "description"]) {
    assert.ok(!(key in detail), `audit detail must not carry '${key}'`);
  }
});

test("7. retrieved memory stays untrusted data in prepareContext output", async () => {
  const pc = await load("contextPackage");
  const r = await pc.prepareContext({ project_id: projectA,
    query: `summarise alpha-${RUN}`, budget_chars: 2500 });
  assert.equal(r.ok, true);
  assert.match(r.context, /UNTRUSTED HISTORICAL REFERENCE DATA/);
  assert.match(r.context, /current user request|current user instructions take precedence/i);
  assert.match(r.note, /untrusted historical reference data/i);
  assert.match(r.note, /current user instructions always take precedence/i);
});

test("8. Phase 18 compatibility: prepareContext contract and budget are preserved", async () => {
  const pc = await load("contextPackage");
  const r = await pc.prepareContext({ project_id: projectA, session_id: `s-${RUN}`,
    query: `debug alpha-${RUN}`, budget_chars: 800 });
  assert.equal(r.ok, true);
  assert.ok(typeof r.context === "string");
  assert.equal(r.chars, r.context.length);
  assert.ok(Array.isArray(r.sources));
  assert.ok(r.audit && typeof r.audit === "object");
  assert.ok(Number.isFinite(r.audit.candidates));
  assert.ok(Number.isFinite(r.audit.estimated_tokens) && r.audit.estimated_tokens >= 0);
  assert.ok(r.context.length <= 800, `context ${r.context.length} exceeds the 800 char budget`);
});

test("9. Phase 19 compatibility: runSessionUnderstanding completes idempotently", async (t) => {
  const su = await load("sessionUnderstanding");
  if (!su) return t.skip("module not yet available");
  const session = `s20-${RUN}`;
  const lines = [
    { role: "USER", text: `Build alpha-${RUN} with full tests`, seq: 1 },
    { role: "TOOL", tool: "shell", text: "FAILED test_alpha - AssertionError: expected 600", seq: 2 },
    { role: "ASSISTANT", text: "The timeout is wrong; changing it to 600 seconds", seq: 3 },
    { role: "TOOL", tool: "shell", text: "1 passed in 0.11s", seq: 4 },
  ];
  const r = await su.runSessionUnderstanding({ session_id: session, project_id: projectA,
    lines, sequence: 4 });
  assert.equal(r.ok, true);
  assert.ok(r.understanding_id);
  assert.ok(r.result.analyzed_lines >= 4);
  const again = await su.runSessionUnderstanding({ session_id: session, project_id: projectA,
    lines, sequence: 4 });
  assert.equal(again.duplicate, true);
});

test("10. pipeline audit returns ok with all checks present (no DB)", async () => {
  const pa = await load("pipelineAudit");
  const a = pa.auditPipelineIntegrity();
  assert.equal(a.ok, true);
  assert.ok(a.summary.total > 0);
  assert.equal(a.summary.missing, 0);
  assert.equal(a.checks.length, a.summary.total);
  assert.ok(a.checks.every((c) => c.ok === true && c.present === true && c.missing === false));
  assert.deepEqual(a.missing, []);
});

test("11. lifecycle listing/report functions respect their bounds", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const authz = await load("memoryAuthorization");
  const kq = await load("knowledgeQuality");
  const imp = await load("memoryImportance");
  const con = await load("memoryConsolidation");
  const rec = await load("memoryRecovery");
  const su = await load("sessionUnderstanding");
  if (!imp) return t.skip("module not yet available");

  for (const signal of ["critical_decision", "user_explicit", "frequent_reuse"]) {
    await imp.recordSignal({ memory_id: fx.memA.id, project_id: projectA,
      signal_type: signal, weight: 0.7, reason: "p20 bound probe" });
  }
  for (const verdict of ["current", "stale", "needs_review"]) {
    await imp.recordFreshnessReview({ memory_id: fx.memA.id, project_id: projectA,
      verdict, reason: "p20 bound probe" });
  }

  const sigs = await imp.getSignals({ project_id: projectA, limit: 2 });
  assert.equal(sigs.ok, true);
  assert.equal(sigs.count, 2);
  const revs = await imp.getFreshnessReviews({ project_id: projectA, limit: 2 });
  assert.equal(revs.ok, true);
  assert.equal(revs.count, 2);

  const mis = await scope.globalMisclassificationReport({ limit: 2 });
  assert.equal(mis.ok, true);
  assert.ok(mis.items.length <= 2);
  const sec = await authz.securityAuditReport({ project_id: projectA, limit: 2 });
  assert.equal(sec.ok, true);
  assert.ok(sec.items.length <= 2);
  const fresh = await kq.freshnessReport({ project_id: projectA, limit: 2 });
  assert.equal(fresh.ok, true);
  assert.ok(fresh.count <= 2);

  if (con) {
    const c = await con.findCandidates({ project_id: projectA, limit: 2 });
    assert.equal(c.ok, true);
    assert.ok(c.candidates.length <= 2);
  }
  if (rec) {
    const r = await rec.lifecycleReport({ project_id: projectA, limit: 2 });
    assert.ok(r.events.length <= 2 && r.recoveries.length <= 2);
  }
  if (su) {
    const s = await su.sessionUnderstandingStatus({ project_id: projectA, limit: 2 });
    assert.equal(s.ok, true);
    assert.ok(s.count <= 2);
  }
  void core;
});

test("12. assistant-claim-only evidence never promotes a memory to verified", async () => {
  const core = await load("core");
  const kq = await load("knowledgeQuality");
  const scope = await load("memoryScope");
  const subject = `p20-subject-${RUN}`;
  const claim = { source: "assistant", claim: "assistant asserts this is verified" };

  const first = await kq.recordQuality({ project_id: projectA, subject_type: "memory",
    subject_id: subject, verification: kq.INFERRED, evidence_sources: [claim] });
  assert.equal(first.quality.verification, "inferred");
  const second = await kq.recordQuality({ project_id: projectA, subject_type: "memory",
    subject_id: subject, verification: kq.VERIFIED, evidence_sources: [claim] });
  assert.equal(second.promoted, false);
  assert.equal(second.quality.verification, "inferred",
    "an assistant claim must never become verified");

  assert.equal(scope.isGloballyEligible(fx.assistantGlobal), false);
  const g = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.assistantGlobal.id]);
  assert.equal(g.rowCount, 0);

  const trg = await core.dbQuery(
    "SELECT 1 FROM pg_trigger WHERE tgname='guard_memory_lifecycle' AND NOT tgisinternal");
  if (trg.rowCount) {
    const probe = await core.saveMemory({ layer: "project", project_id: projectA,
      title: "promotion probe", content: `probe-${RUN}`, source_kind: "hypothesis",
      verified: false, noEmbed: true });
    await assert.rejects(() => core.dbQuery(
      "UPDATE memory SET lifecycle='VERIFIED' WHERE id=$1", [probe.id]),
      "DB guard must refuse VERIFIED lifecycle without independent verified evidence");
  }
});

// Must be the final test: closes the shared pool exactly once, then verifies
// that prepareContext degrades gracefully instead of blocking the request.
test("13. final: prepareContext degrades gracefully when the database is down", async () => {
  const core = await load("core");
  const pc = await load("contextPackage");
  await core.close(); // the ONLY close() call in this file

  const r = await pc.prepareContext({ project_id: downProject,
    query: `post-close-${RUN}`, budget_chars: 1200 });
  assert.equal(r.ok, true);
  assert.ok(typeof r.context === "string" && r.context.length > 0);
  assert.ok(Array.isArray(r.audit.degraded));
  assert.ok(r.audit.degraded.length > 0, "degraded diagnostics expected when DB is unavailable");
});
