// Phase 21 workstream E — integration, security, isolation and reliability tests.
// Isolated DB only (MEMORY_DB_NAME=opencode_memory_test), HARNESS_SEMANTIC_LLM=0.
// Unique project ids; no row is ever deleted, reclassified or overwritten in place.
// Sibling modules are imported dynamically and a missing module skips only the
// affected test. core.close() is called AT MOST once, in the FINAL test.
//
//   cd E:\OpenCodeData\memory\engine
//   $env:MEMORY_DB_NAME='opencode_memory_test'
//   node --test test/phase21-security.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.MEMORY_DB_NAME = "opencode_memory_test";
process.env.HARNESS_SEMANTIC_LLM = "0";

const RUN = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const projectA = `p21sec-a-${RUN}`;
const projectB = `p21sec-b-${RUN}`;
const downProject = `p21sec-down-${RUN}`;

// Dynamic import with a null result; tests use t.skip when a sibling is absent.
async function load(name) {
  try { return await import(`../src/${name}.js`); }
  catch { return null; }
}
const srcFile = (name) => path.join(import.meta.dirname, "..", "src",
  name.endsWith(".js") ? name : `${name}.js`);
const allSourcesPresent = (names) => names.every((n) => fs.existsSync(srcFile(n)));

const fx = {};

test.before(async () => {
  const core = await load("core");
  if (!core) throw new Error("core module unavailable; cannot run integration tests");

  // Idempotent, additive schema guards (no-ops once migration 019 is applied).
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_record (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      session_id text,
      signature text NOT NULL,
      category text NOT NULL DEFAULT 'pattern',
      problem text NOT NULL DEFAULT '',
      approach text NOT NULL DEFAULT '',
      outcome text NOT NULL DEFAULT 'uncertain',
      verification text NOT NULL DEFAULT 'observed',
      confidence real NOT NULL DEFAULT 0,
      confidence_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
      reusability text NOT NULL DEFAULT 'project',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'active',
      superseded_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, signature)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_feedback (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      learning_id uuid,
      pattern_id uuid,
      session_id text,
      verdict text NOT NULL,
      explicit_feedback boolean NOT NULL DEFAULT false,
      reason text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      applied boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS learning_pipeline_run (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      session_id text NOT NULL,
      transcript_sequence integer NOT NULL,
      status text NOT NULL DEFAULT 'processing',
      result jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text,
      attempts integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (session_id, transcript_sequence)
    )`);
  await core.dbQuery(`
    CREATE TABLE IF NOT EXISTS knowledge_quality (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      verification text NOT NULL DEFAULT 'observed',
      confidence real,
      evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      freshness_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, subject_type, subject_id)
    )`);

  fx.sessionA = `p21sec-sess-a-${RUN}`;
  fx.sessionB = `p21sec-sess-b-${RUN}`;

  fx.memA = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "A private note", content: `alpha-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.memB = await core.saveMemory({ layer: "project", project_id: projectB,
    title: "B private note", content: `bravo-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.ineligibleGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "ineligible global", content: `global-no-${RUN}`, source_kind: "observed", noEmbed: true });
  fx.eligibleGlobal = await core.saveMemory({ layer: "user", project_id: "_global",
    title: "eligible global", content: `global-yes-${RUN}`, source_kind: "user",
    verified: true, metadata: { global_approval: true }, noEmbed: true });
  fx.assistantGlobal = await core.saveMemory({ layer: "knowledge", project_id: "_global",
    title: "assistant claim global", content: `global-assistant-${RUN}`,
    source_kind: "attempt", verified: false, noEmbed: true });

  fx.canary = `P21SEC_CANARY_${RUN}`;
  fx.canaryMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "canary holder", content: fx.canary, source_kind: "observed", noEmbed: true });

  fx.skCanary = `sk-${"a".repeat(32)}`;
  fx.bearerCanary = `Bearer sk-${"b".repeat(32)}`;
  fx.awsCanary = `AKIA${"C".repeat(16)}`;
  fx.secretMem = await core.saveMemory({ layer: "project", project_id: projectA,
    title: "secret holder", content: `${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}`,
    source_kind: "observed", noEmbed: true });

  const insertLearning = async (project, signature, opts = {}) => {
    const id = crypto.randomUUID();
    const created = opts.created_at || new Date().toISOString();
    await core.dbQuery(
      `INSERT INTO learning_record
         (id, project_id, session_id, signature, category, problem, approach, outcome,
          verification, confidence, evidence, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       ON CONFLICT DO NOTHING`,
      [id, project, opts.session_id ?? null, signature, opts.category ?? "pattern",
        opts.problem ?? "p21sec default problem", opts.approach ?? "p21sec default approach",
        opts.outcome ?? "uncertain", opts.verification ?? "observed", opts.confidence ?? 0.5,
        JSON.stringify(opts.evidence ?? ["p21sec-evidence"]), opts.status ?? "active",
        created, created],
    );
    return id;
  };

  fx.learnA = await insertLearning(projectA, `p21sec-sig-a-${RUN}`,
    { session_id: fx.sessionA, problem: `alpha learning for ${RUN}`, evidence: ["ev-A"] });
  fx.learnB = await insertLearning(projectB, `p21sec-sig-b-${RUN}`,
    { session_id: fx.sessionB, problem: `bravo learning for ${RUN}`,
      approach: "B original approach", outcome: "success", confidence: 0.7,
      evidence: ["ev-B", "shared-B"] });

  // A raw-canary learning row inserted directly: module read paths must redact it.
  fx.secretLearn = await insertLearning(projectA, `p21sec-sig-secret-${RUN}`,
    { session_id: fx.sessionA, problem: `p21secretprobe api_key=${fx.skCanary} auth=${fx.bearerCanary} key=${fx.awsCanary}`,
      verification: "verified", confidence: 0.9,
      evidence: [`token ${fx.skCanary}`, `authorization ${fx.bearerCanary}`, `secret ${fx.awsCanary}`] });

  // A B-project feedback row used to prove A cannot apply another project's feedback.
  const fb = await core.dbQuery(
    `INSERT INTO learning_feedback
       (project_id, learning_id, session_id, verdict, explicit_feedback, reason, evidence)
     VALUES ($1,$2,$3,'corrected',true,$4,'[]'::jsonb) RETURNING id`,
    [projectB, fx.learnB, fx.sessionB, `p21sec B feedback ${RUN}`]);
  fx.feedbackB = fb.rows[0]?.id ?? null;

  fx.rawLearning = async (id) => (await core.dbQuery(
    `SELECT id, project_id, signature, problem, approach, evidence, status,
            superseded_by, verification, confidence
       FROM learning_record WHERE id=$1 LIMIT 1`, [id])).rows[0] || null;
});

// ---------------------------------------------------------------------------
// 1. Cross-project isolation for learning records (read/modify/consolidate/feedback)
// ---------------------------------------------------------------------------
test("1. Project A cannot read, modify, consolidate or give feedback on Project B learning records", async (t) => {
  const core = await load("core");
  const lex = await load("learningExperience");
  const li = await load("learningIntegration");
  const lp = await load("learningPipeline");
  const authz = await load("memoryAuthorization");
  if (!lex || !li) return t.skip("learning modules not yet available");

  // READ: listing and session lookup are strictly project-scoped.
  const listA = await lex.getLearningExperiences({ project_id: projectA, limit: 200 });
  assert.equal(listA.ok, true, `unexpected: ${listA.reason}`);
  assert.ok(listA.items.some((x) => x.id === fx.learnA), "A sees its own record");
  assert.equal(listA.items.some((x) => x.id === fx.learnB), false, "A cannot list B's record");
  const sess = await lex.getLearningBySession({ session_id: fx.sessionB, project_id: projectA });
  assert.equal(sess.ok, true);
  assert.equal(sess.count, 0, "A cannot look up B's session-scoped record");
  const explainCross = await li.explainLearning({ project_id: projectA, learning_id: fx.learnB });
  assert.equal(explainCross.ok, false, "A cannot explain B's record");

  // MODIFY: the same signature in A creates a new A row and leaves B untouched.
  const hijack = await lex.recordLearningExperience({ project_id: projectA,
    session_id: fx.sessionA, signature: `p21sec-sig-b-${RUN}`, category: "pattern",
    problem: "A hijack attempt", approach: "OVERWRITE", outcome: "uncertain",
    verification: "observed", confidence: 0.1, evidence: ["a-hijack"] });
  assert.equal(hijack.ok, true, `unexpected: ${hijack.reason}`);
  assert.notEqual(hijack.id, fx.learnB, "A's write never took over B's row id");
  const bAfterWrite = await fx.rawLearning(fx.learnB);
  assert.equal(bAfterWrite.problem, `bravo learning for ${RUN}`);
  assert.equal(bAfterWrite.approach, "B original approach");
  assert.equal(JSON.stringify(bAfterWrite.evidence).includes("a-hijack"), false);

  // CONSOLIDATE: running consolidation in A never supersedes or merges B's rows.
  const cons = await li.consolidateLearning({ project_id: projectA, dry_run: false, limit: 50 });
  assert.equal(cons.ok, true, `unexpected: ${cons.reason}`);
  const bAfterCons = await fx.rawLearning(fx.learnB);
  assert.equal(bAfterCons.project_id, projectB);
  assert.equal(bAfterCons.status, "active");
  assert.equal(bAfterCons.superseded_by, null);
  assert.equal(JSON.stringify(bAfterCons.evidence).includes("a-hijack"), false);

  // FEEDBACK: A cannot apply B's feedback, nor a feedback row it records about B.
  if (!lp) return t.skip("learningPipeline module not yet available");
  if (fx.feedbackB) {
    const crossApply = await lp.applyFeedback({ feedback_id: fx.feedbackB.id,
      project_id: projectA, actor: "p21sec-probe" });
    assert.equal(crossApply.ok, false, "A cannot apply B's feedback row");
    const bAfterFb = await fx.rawLearning(fx.learnB);
    assert.equal(Number(bAfterFb.confidence), 0.7, "B's confidence is unchanged");
    assert.equal(bAfterFb.evidence.some((e) => e && e.event === "learning.feedback_applied"), false,
      "no A-originated feedback event on B's record");
  }
  const crossRecord = await lp.recordFeedback({ project_id: projectA,
    learning_id: fx.learnB, verdict: "confirmed", explicit_feedback: true,
    reason: `p21sec cross feedback ${RUN}` });
  assert.equal(crossRecord.ok, true, "A can only create a row in its own namespace");
  const applied = await lp.applyFeedback({ feedback_id: crossRecord.id,
    project_id: projectA, actor: "p21sec-probe" });
  assert.equal(applied.ok, false, "feedback naming B's id cannot be applied within A");
  assert.equal(applied.changed, false);
  const bFinal = await fx.rawLearning(fx.learnB);
  assert.equal(Number(bFinal.confidence), 0.7);
  assert.equal(bFinal.status, "active");

  // Direct memory authorization is unchanged: B's memories stay denied.
  if (authz) {
    const denied = await authz.authorizeMemoryAccess({
      tool: "memory_get", project_id: projectA, memory_id: fx.memB.id });
    assert.equal(denied.allowed, false);
    assert.equal(denied.scope, "denied");
  }
  const listed = await core.listMemories({ project_id: projectA, limit: 200 });
  assert.equal(listed.some((m) => m.id === fx.memB.id), false, "B's memory absent from A's listing");
});

// ---------------------------------------------------------------------------
// 2. Global memory eligibility is unchanged; no project-to-global promotion
// ---------------------------------------------------------------------------
test("2. Global memory eligibility unchanged; learning never promotes a project record to global", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const lex = await load("learningExperience");
  const li = await load("learningIntegration");
  const lp = await load("learningPipeline");
  if (!scope || !core) return t.skip("core modules not yet available");

  assert.equal(scope.isGloballyEligible(fx.eligibleGlobal), true);
  assert.equal(scope.isGloballyEligible(fx.ineligibleGlobal), false);
  assert.equal(scope.isGloballyEligible(fx.assistantGlobal), false);
  assert.equal(scope.isGloballyEligible({ global_eligible: true, source_kind: "assistant",
    layer: "knowledge", verified: false }), true, "explicit flag is sufficient");
  assert.equal(scope.isGloballyEligible({ source_kind: "user", layer: "user", verified: false,
    metadata: { global_approval: true } }), false, "unverified user facts are not eligible");

  const filtered = scope.filterMemoryResults(
    [fx.memA, fx.memB, fx.eligibleGlobal, fx.ineligibleGlobal, fx.assistantGlobal],
    { project_id: projectA });
  const ids = filtered.map((m) => m.id);
  assert.ok(ids.includes(fx.memA.id));
  assert.ok(ids.includes(fx.eligibleGlobal.id));
  assert.equal(ids.includes(fx.memB.id), false);
  assert.equal(ids.includes(fx.ineligibleGlobal.id), false);
  assert.equal(ids.includes(fx.assistantGlobal.id), false);

  const no = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.ineligibleGlobal.id]);
  assert.equal(no.rowCount, 0);
  const yes = await core.dbQuery(
    `SELECT id FROM memory WHERE id=$1 AND (${scope.GLOBAL_ELIGIBLE_SQL})`, [fx.eligibleGlobal.id]);
  assert.equal(yes.rowCount, 1);

  // Learning capabilities refuse the '_global' namespace entirely.
  if (lex) {
    assert.equal((await lex.getLearningExperiences({ project_id: "_global" })).ok, false);
    assert.equal((await lex.getLearningBySession({ session_id: fx.sessionA, project_id: "_global" })).ok, false);
    assert.equal((await lex.recordLearningExperience({ project_id: "_global", signature: `p21sec-g-${RUN}` })).ok, false);
  }
  if (li) {
    assert.equal((await li.learningContextItems({ project_id: "_global" })).ok, false);
    assert.equal((await li.learningReport({ project_id: "_global" })).ok, false);
    assert.equal((await li.consolidateLearning({ project_id: "_global" })).ok, false);
  }
  if (lp) {
    assert.equal((await lp.learningPipelineStatus({ project_id: "_global" })).ok, false);
    assert.equal((await lp.recordFeedback({ project_id: "_global", verdict: "corrected" })).ok, false);
  }

  // No project learning content was written into the global memory pool.
  const promoted = await core.dbQuery(
    "SELECT count(*)::int AS n FROM memory WHERE project_id='_global' AND content LIKE $1",
    [`%p21sec-${RUN}%`]);
  assert.equal(promoted.rows[0].n, 0, "no project fixture promoted into _global memory");

  const mis = await scope.globalMisclassificationReport({ limit: 2 });
  assert.equal(mis.ok, true);
  assert.ok(mis.items.length <= 2);
  assert.equal(mis.auto_applied, 0);
  assert.equal(mis.destructive_operations, 0);
});

// ---------------------------------------------------------------------------
// 3. Secrets are redacted in audits and in learning evidence/output
// ---------------------------------------------------------------------------
test("3. sk-/Bearer/AKIA canaries never appear in audits or learning evidence", async (t) => {
  const core = await load("core");
  const llm = await load("llm-provider");
  const budget = await load("injectionBudget");
  const authz = await load("memoryAuthorization");
  const inj = await load("injectionAudit");
  const lex = await load("learningExperience");
  const li = await load("learningIntegration");
  if (!core) return t.skip("core module not yet available");

  const canaries = [fx.skCanary, fx.bearerCanary, fx.awsCanary, fx.canary];
  const assertClean = (value, label) => {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    for (const c of canaries) assert.equal(s.includes(c), false, `${label} leaked ${c.slice(0, 14)}...`);
  };

  assert.doesNotMatch(core.redact(`key ${fx.skCanary}`), /sk-aaa/);
  assert.doesNotMatch(core.redact(`key ${fx.awsCanary}`), /AKIACCC/);
  if (llm) assert.doesNotMatch(llm.redact(`auth ${fx.bearerCanary}`), /Bearer sk-bbb/);

  const stored = await core.getMemory(fx.secretMem.id);
  assertClean(stored.content, "stored memory");

  if (budget) {
    const formatted = budget.formatInjection({ project_id: projectA, budget_chars: 4000,
      items: [{ id: "p21sec-secret-probe",
        content: `${fx.skCanary} ${fx.bearerCanary} ${fx.awsCanary}` }] });
    assert.equal(formatted.ok, true);
    assertClean(formatted.text, "injected context");
    assert.match(formatted.text, /UNTRUSTED/);
    assert.match(formatted.text, /\[REDACTED/);
  }

  // Access decisions are content-free: only ids/scope/reason reach the audit table.
  if (authz) {
    await authz.authorizeMemoryAccess({ tool: "memory_get", project_id: projectA, memory_id: fx.canaryMem.id });
    const rows = await core.dbQuery(
      `SELECT detail FROM intelligence_audit_events
        WHERE resource=$1 AND action='access_decision'
        ORDER BY created_at DESC, id DESC LIMIT 1`, [fx.canaryMem.id]);
    assert.ok(rows.rowCount >= 1);
    assertClean(rows.rows[0].detail, "access_decision audit detail");
    for (const key of ["content", "title", "summary", "description"]) {
      assert.equal(key in rows.rows[0].detail, false, `audit detail must not carry '${key}'`);
    }
  }

  // Injection audits stay content-free even with hostile detail strings.
  if (inj) {
    const rec = await inj.recordInjection({ project_id: projectA,
      request_id: `req api_key=${fx.skCanary}`, task: { category: `impl token=${fx.canary}` },
      reject_reasons: [`bearer ${fx.bearerCanary}`], degraded: [`secret=${fx.awsCanary}`] });
    assert.equal(rec.ok, true, `unexpected: ${rec.reason}`);
    const row = await core.dbQuery("SELECT detail FROM intelligence_audit_events WHERE id=$1", [rec.id]);
    assertClean(row.rows[0].detail, "injection audit detail");
  }

  // Learning read paths redact raw secrets stored in evidence.
  if (lex && li) {
    const items = await li.learningContextItems({ project_id: projectA, limit: 50 });
    assert.equal(items.ok, true, `unexpected: ${items.reason}`);
    const hit = items.items.find((x) => x.id === fx.secretLearn);
    assert.ok(hit, "the secret-bearing record is still returned (redacted)");
    assertClean(hit.text, "learning context item");
    assertClean(items.items, "learning context items");
    const ex = await li.explainLearning({ project_id: projectA, learning_id: fx.secretLearn });
    assert.equal(ex.ok, true, `unexpected: ${ex.reason}`);
    assertClean(ex, "learning explanation");
    // The public write path redacts before persistence, so a listing of those
    // rows can never expose a raw canary either.
    const saved = await lex.recordLearningExperience({ project_id: projectA,
      signature: `p21sec-sig-redacted-${RUN}`, category: "pattern",
      problem: `redacted api_key=${fx.skCanary} auth=${fx.bearerCanary} key=${fx.awsCanary}`,
      approach: "stored through the redacting write path", outcome: "uncertain",
      verification: "verified", confidence: 0.9,
      evidence: [`token ${fx.skCanary}`, `authorization ${fx.bearerCanary}`] });
    assert.equal(saved.ok, true, `unexpected: ${saved.reason}`);
    const list = await lex.getLearningExperiences({ project_id: projectA, limit: 200 });
    const cleanRow = list.items.find((x) => x.id === saved.id);
    assert.ok(cleanRow, "the redacted record is listed");
    assertClean(cleanRow, "redacted learning experience listing");
  }
});

// ---------------------------------------------------------------------------
// 4. Retrieved memory remains untrusted in prepareContext output
// ---------------------------------------------------------------------------
test("4. prepareContext keeps the UNTRUSTED banner and current-instruction precedence", async () => {
  const pc = await load("contextPackage");
  if (!pc) return t.skip("contextPackage module not yet available");
  const r = await pc.prepareContext({ project_id: projectA,
    query: `summarise alpha-${RUN}`, budget_chars: 2500 });
  assert.equal(r.ok, true);
  assert.match(r.context, /UNTRUSTED HISTORICAL REFERENCE DATA/);
  assert.match(r.context, /current user request|current user instructions take precedence/i);
  assert.match(r.note, /untrusted historical reference data/i);
  assert.match(r.note, /current user instructions always take precedence/i);
});

// ---------------------------------------------------------------------------
// 5. Phase 18 contract preserved
// ---------------------------------------------------------------------------
test("5. Phase 18 contract: prepareContext returns {ok,context,chars,sources,audit} within budget", async () => {
  const pc = await load("contextPackage");
  if (!pc) return t.skip("contextPackage module not yet available");
  const r = await pc.prepareContext({ project_id: projectA, session_id: `s-${RUN}`,
    query: `debug alpha-${RUN}`, budget_chars: 800 });
  assert.equal(r.ok, true);
  assert.equal(typeof r.context, "string");
  assert.equal(r.chars, r.context.length);
  assert.ok(Array.isArray(r.sources));
  assert.ok(r.audit && typeof r.audit === "object");
  assert.ok(Number.isFinite(r.audit.candidates));
  assert.ok(Number.isFinite(r.audit.estimated_tokens) && r.audit.estimated_tokens >= 0);
  assert.ok(r.context.length <= 800, `context ${r.context.length} exceeds the 800 char budget`);
});

// ---------------------------------------------------------------------------
// 6. Phase 19 compatibility: sessionUnderstanding is idempotent
// ---------------------------------------------------------------------------
test("6. Phase 19 compatibility: sessionUnderstanding is idempotent on a tiny transcript", async (t) => {
  const su = await load("sessionUnderstanding");
  if (!su) return t.skip("module not yet available");
  const session = `p21sec-su-${RUN}`;
  const lines = [
    { role: "USER", text: `Build alpha-${RUN} with full tests`, seq: 1 },
    { role: "TOOL", tool: "shell", text: "FAILED test_alpha - AssertionError: expected 600", seq: 2 },
    { role: "ASSISTANT", text: "The timeout is wrong; changing it to 600 seconds", seq: 3 },
    { role: "TOOL", tool: "shell", text: "1 passed in 0.11s", seq: 4 },
  ];
  const r = await su.runSessionUnderstanding({ session_id: session, project_id: projectA,
    lines, sequence: 4 });
  assert.equal(r.ok, true, `unexpected: ${r.reason || r.error}`);
  assert.ok(r.understanding_id);
  assert.ok(r.result.analyzed_lines >= 4);
  const again = await su.runSessionUnderstanding({ session_id: session, project_id: projectA,
    lines, sequence: 4 });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, "a second identical run is a duplicate");
});

// ---------------------------------------------------------------------------
// 7. Phase 20 compatibility: lifecycle maintenance remains a bounded dry run
// ---------------------------------------------------------------------------
test("7. Phase 20 compatibility: runLifecycleMaintenance dry run is ok and bounded", async (t) => {
  const life = await load("memoryLifecycle");
  if (!life) return t.skip("module not yet available");
  const r = await life.runLifecycleMaintenance({ project_id: projectA,
    limit: 5, dry_run: true, actor: "p21sec-probe" });
  assert.equal(r.ok, true, `unexpected: ${r.reason}`);
  assert.equal(r.dry_run, true);
  assert.ok(r.examined <= 5, `examined ${r.examined} exceeds the limit of 5`);
  assert.ok(Array.isArray(r.degraded));
  const stillA = await (await load("core")).getMemory(fx.memA.id);
  assert.equal(stillA.project_id, projectA, "dry run never reclassifies a memory");
});

// ---------------------------------------------------------------------------
// 8. Pipeline audit returns ok with all checks
// ---------------------------------------------------------------------------
test("8. Pipeline audit returns ok with all wiring checks present", async (t) => {
  const pa = await load("pipelineAudit");
  if (!pa) return t.skip("pipelineAudit module not yet available");
  const needed = ["learningEngine", "learningExperience", "learningIntelligence",
    "learningIntegration", "learningPipeline"];
  if (!allSourcesPresent(needed)) return t.skip("sibling Phase 21 source files not yet available");
  const a = pa.auditPipelineIntegrity();
  assert.equal(a.ok, true, `missing checks: ${(a.missing || []).join(", ")}`);
  assert.ok(a.summary.total > 0);
  assert.equal(a.summary.missing, 0);
  assert.equal(a.checks.length, a.summary.total);
  assert.equal(a.checks.filter((c) => c.ok === true && c.present === true && c.missing === false).length,
    a.checks.length, "every check is present");
  assert.deepEqual(a.missing, []);
  for (const id of ["p21.engine", "p21.experience", "p21.intelligence",
    "p21.integration", "p21.pipeline", "p21.cli-integration", "p21.mcp-integration"]) {
    assert.ok(a.present.includes(id), `expected p21 wiring check ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Bounded listing/report functions respect their limits
// ---------------------------------------------------------------------------
test("9. Bounded listing and report functions respect their limits", async (t) => {
  const core = await load("core");
  const scope = await load("memoryScope");
  const authz = await load("memoryAuthorization");
  const kq = await load("knowledgeQuality");
  const inj = await load("injectionAudit");
  const lex = await load("learningExperience");
  const li = await load("learningIntegration");
  const lp = await load("learningPipeline");
  const su = await load("sessionUnderstanding");
  if (!core || !scope) return t.skip("core modules not yet available");

  const mis = await scope.globalMisclassificationReport({ limit: 1 });
  assert.equal(mis.ok, true);
  assert.ok(mis.items.length <= 1);
  const sec = await authz.securityAuditReport({ project_id: projectA, limit: 2 });
  assert.equal(sec.ok, true);
  assert.ok(sec.items.length <= 2);
  const fresh = await kq.freshnessReport({ project_id: projectA, limit: 2 });
  assert.equal(fresh.ok, true);
  assert.ok(fresh.count <= 2);
  if (inj) {
    const rep = await inj.injectionReport({ project_id: projectA, limit: 2 });
    assert.equal(rep.ok, true);
    assert.ok(rep.items.length <= 2);
  }
  if (lex) {
    const exp = await lex.getLearningExperiences({ project_id: projectA, limit: 2 });
    assert.equal(exp.ok, true);
    assert.equal(exp.count, 2, "experience listing honors limit=2");
    assert.equal(exp.items.length, 2);
  }
  if (li) {
    const ctx = await li.learningContextItems({ project_id: projectA, limit: 2 });
    assert.equal(ctx.ok, true);
    assert.ok(ctx.items.length <= 2);
    const rep = await li.learningReport({ project_id: projectA });
    assert.equal(rep.ok, true);
    assert.ok(rep.total >= 1);
  }
  if (lp) {
    const st = await lp.learningPipelineStatus({ project_id: projectA, limit: 2 });
    assert.equal(st.ok, true);
    assert.ok(st.items.length <= 2);
  }
  const listed = await core.listMemories({ project_id: projectA, limit: 2 });
  assert.ok(listed.length <= 2);
  if (su) {
    const s = await su.sessionUnderstandingStatus({ project_id: projectA, limit: 2 });
    assert.equal(s.ok, true);
    assert.ok(s.count <= 2);
  }
});

// ---------------------------------------------------------------------------
// 10. Assistant-claim-only evidence never promotes learning verification
// ---------------------------------------------------------------------------
test("10. Assistant-claim-only evidence never promotes learning verification to verified", async (t) => {
  const lex = await load("learningExperience");
  const li = await load("learningIntelligence");
  const lp = await load("learningPipeline");
  const kq = await load("knowledgeQuality");
  const core = await load("core");
  if (!lex || !li) return t.skip("learning modules not yet available");

  // Extraction: a bare assistant claim produces no verified/success experience.
  const extracted = await lex.extractExperiences({ lines: [
    { role: "USER", text: `Fix the failing bug ${RUN}`, seq: 1 },
    { role: "ASSISTANT", text: "I fixed the bug and all tests pass now, trust me", seq: 2 },
  ] });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.experiences.some((e) => e.verification === "verified"), false,
    "no experience is verified without tool evidence");
  assert.equal(extracted.experiences.some((e) => e.outcome === "success"), false,
    "no experience claims success without tool evidence");

  // Storage: an explicit 'verified' request with only an assistant claim is refused promotion.
  const signature = `p21sec-claim-${RUN}`;
  const first = await lex.recordLearningExperience({ project_id: projectA, signature,
    category: "pattern", problem: "assistant claim probe", approach: "claimed fixed",
    outcome: "uncertain", verification: "inferred", confidence: 0.3,
    evidence: ["assistant: I believe it works"] });
  assert.equal(first.ok, true, `unexpected: ${first.reason}`);
  const second = await lex.recordLearningExperience({ project_id: projectA, signature,
    verification: "verified", confidence: 0.99,
    evidence: ["assistant: all tests definitely passed"] });
  assert.equal(second.ok, true);
  assert.notEqual(second.promoted, true, "assistant claim must not promote verification");
  const row = (await lex.getLearningExperiences({ project_id: projectA, limit: 200 }))
    .items.find((x) => x.signature === signature);
  assert.equal(row.verification, "inferred", "verification stays inferred");

  // analyzeOutcome agrees: a claim alone is not verified.
  const claimAnalysis = li.analyzeOutcome({ experience: { explanation: "all tests pass, trust me" } });
  assert.equal(claimAnalysis.verified, false);
  const withMarker = li.analyzeOutcome({ evidence: [{ marker: "test_pass", value: "true" }] });
  assert.equal(withMarker.verified, true, "only explicit tool/test evidence verifies");

  // Confidence recalculation demotes unsupported 'verified' without rewriting verification.
  if (lp) {
    const id = crypto.randomUUID();
    await core.dbQuery(
      `INSERT INTO learning_record (id, project_id, signature, problem, verification, confidence, evidence)
       VALUES ($1,$2,$3,'claim recalculation probe','verified',0.99,$4::jsonb)
       ON CONFLICT DO NOTHING`,
      [id, projectA, `p21sec-recalc-${RUN}`, JSON.stringify([{ marker: "explanation", value: "success" }])]);
    const rec = await li.recalculateLearningConfidence({ project_id: projectA, learning_id: id });
    assert.equal(rec.ok, true, `unexpected: ${rec.reason}`);
    assert.ok(rec.confidence <= 0.5, "unsupported verified claim is capped when recalculated");
    const verifyRow = await core.dbQuery("SELECT verification FROM learning_record WHERE id=$1", [id]);
    assert.equal(verifyRow.rows[0].verification, "verified", "recalculation never writes verification");
  }

  // knowledgeQuality mirrors the same rule for arbitrary subjects.
  if (kq) {
    const subject = `p21sec-subject-${RUN}`;
    const firstQ = await kq.recordQuality({ project_id: projectA, subject_type: "learning",
      subject_id: subject, verification: kq.INFERRED,
      evidence_sources: [{ source: "assistant", claim: "this is verified" }] });
    assert.equal(firstQ.quality.verification, "inferred");
    const secondQ = await kq.recordQuality({ project_id: projectA, subject_type: "learning",
      subject_id: subject, verification: kq.VERIFIED,
      evidence_sources: [{ source: "assistant", claim: "trust me" }] });
    assert.equal(secondQ.promoted, false);
    assert.equal(secondQ.quality.verification, "inferred");
  }
});

// ---------------------------------------------------------------------------
// 11. FINAL: database-down graceful degradation. Nothing runs after this test.
// ---------------------------------------------------------------------------
test("11. FINAL: prepareContext degrades gracefully when the database is down", async () => {
  const core = await load("core");
  const pc = await load("contextPackage");
  await core.close(); // the ONLY close() call in this file

  const r = await pc.prepareContext({ project_id: downProject,
    query: `post-close-${RUN}`, budget_chars: 1200 });
  assert.equal(r.ok, true, "context preparation must never block a request");
  assert.equal(typeof r.context, "string");
  assert.ok(r.context.length > 0, "a safe fallback context is still returned");
  assert.ok(Array.isArray(r.audit.degraded));
  assert.ok(r.audit.degraded.length > 0, "degraded diagnostics expected when the DB is unavailable");
  assert.match(r.context, /UNTRUSTED|current user instructions|no context available/i);
});
