import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import * as signals from "../src/usefulnessSignals.js";
import { appendLine, readLines, resetSequenceCache } from "../src/transcript.js";

const uniq = () => `eurn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function schemaAllows() {
  const r = await core.dbQuery(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='memory_usefulness_observations_signal_check'",
  );
  const def = r.rows[0]?.def || "";
  return !def || def.includes("error_not_recurred");
}

// Builds a durable timeline with well-ordered timestamps:
//   prior error line  <  retrieval event created_at  <  later lines
async function createEventWithTimeline({ project, session, memoryIds = [], priorErrorText = null, laterTexts = [] }) {
  resetSequenceCache();
  let baseMs = Date.now();
  if (priorErrorText) {
    const a = appendLine({ session_id: session, role: "TOOL", text: priorErrorText });
    const ln = readLines(session).find((l) => l.seq === a.seq);
    baseMs = new Date(ln.ts).getTime();
  }
  const eventMs = baseMs + 400;
  const createdAt = new Date(eventMs).toISOString();
  const ins = await core.dbQuery(
    `INSERT INTO memory_retrieval_events (session_id,project_id,query,memory_ids,created_at)
     VALUES ($1,$2,$3,$4::uuid[],$5) RETURNING id`,
    [session, project, "timeline query", memoryIds, createdAt],
  );
  while (Date.now() <= eventMs + 8) await sleep(8);
  for (const text of laterTexts) appendLine({ session_id: session, role: "ASSISTANT", text });
  return ins.rows[0].id;
}

async function newMemory(project, title, content) {
  return core.saveMemory({ layer: "knowledge", project_id: project, title, content, noEmbed: true });
}

async function rowsFor(event_id, memory_id, signal) {
  return (await core.dbQuery(
    `SELECT * FROM memory_usefulness_observations
     WHERE event_id=$1 AND memory_id=$2 AND signal=$3 ORDER BY id`,
    [event_id, memory_id, signal],
  )).rows;
}

test("true positive: prior error + no recurrence + later memory reference", async () => {
  const p = `tp-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive redis ttl policy ${uniq()}`;
  const m = await newMemory(p, title, `Use redis with ttl ${uniq()} in ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    priorErrorText: `BUILD FAILED: cannot start ${uniq()} — error in ${p}`,
    laterTexts: [`Applied ${title} — the issue is resolved.`],
  });

  const r = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  if (!(await schemaAllows())) {
    assert.equal(r.ok, false);
    assert.equal(r.kind, "schema_update_required", JSON.stringify(r));
    assert.equal(r.would_observe, 1, "detection must find the qualifying memory even before migration");
    assert.ok(r.analysis.matched_error_text.includes("FAILED"));
    assert.equal((await rowsFor(event_id, m.id, "error_not_recurred")).length, 0);
  } else {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.observed, 1);
    const rows = await rowsFor(event_id, m.id, "error_not_recurred");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "deterministic");
    const ev = typeof rows[0].evidence === "string" ? JSON.parse(rows[0].evidence) : rows[0].evidence;
    assert.equal(ev.retrieval_event_id, event_id);
    assert.ok(ev.matched_error_text.includes("FAILED"));
    assert.ok(Array.isArray(ev.later_reference_seqs) && ev.later_reference_seqs.length >= 1);
    const after = await core.getMemory(m.id);
    assert.equal(after.useful_count, m.useful_count + 1);
    assert.match(r.claim, /no helpfulness claim/i);
  }
});

test("no prior error in session → 0 observations", async () => {
  const p = `nop-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive cache policy ${uniq()}`;
  const m = await newMemory(p, title, `Cache policy body ${uniq()} for ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    laterTexts: [`Applied ${title} and everything works.`],
  });
  const r = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.observed, 0);
  assert.match(r.reason, /no prior error/i);
  assert.equal((await rowsFor(event_id, m.id, "error_not_recurred")).length, 0);
});

test("no retrieved-memory reference in later lines → 0 observations", async () => {
  const p = `noref-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive ttl reference ${uniq()}`;
  const m = await newMemory(p, title, `Reference body ${uniq()} for ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    priorErrorText: `BUILD FAILED: error ${uniq()} in ${p}`,
    laterTexts: ["Finished the work without further issues."],
  });
  const r = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.observed, 0);
  assert.match(r.reason, /no retrieved-memory reference/i);
  assert.equal((await rowsFor(event_id, m.id, "error_not_recurred")).length, 0);
});

test("error recurred after retrieval → 0 observations", async () => {
  const p = `recur-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive retry policy ${uniq()}`;
  const m = await newMemory(p, title, `Retry policy body ${uniq()} for ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    priorErrorText: `BUILD FAILED: error ${uniq()} in ${p}`,
    laterTexts: [`Applied ${title} so far.`, `ERROR: still failing again ${uniq()}`],
  });
  const r = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.observed, 0);
  assert.match(r.reason, /recurred/i);
  assert.equal((await rowsFor(event_id, m.id, "error_not_recurred")).length, 0);
});

test("idempotency: a second call never duplicates rows or double-increments", async () => {
  const p = `idem-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive idempotent policy ${uniq()}`;
  const m = await newMemory(p, title, `Idempotent body ${uniq()} for ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    priorErrorText: `BUILD FAILED: error ${uniq()} in ${p}`,
    laterTexts: [`Applied ${title} successfully.`],
  });
  const allowed = await schemaAllows();
  const a = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  const b = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  const count = (await rowsFor(event_id, m.id, "error_not_recurred")).length;
  if (!allowed) {
    assert.equal(a.kind, "schema_update_required");
    assert.equal(b.kind, "schema_update_required");
    assert.equal(count, 0);
  } else {
    assert.equal(a.observed, 1);
    assert.equal(b.observed, 0, "second call must be a no-op");
    assert.equal(count, 1);
    const after = await core.getMemory(m.id);
    assert.equal(after.useful_count, m.useful_count + 1);
  }
});

test("project isolation in usefulnessSignalSummary", async () => {
  const pA = `isoA-${uniq()}`, pB = `isoB-${uniq()}`;
  const sA = `sess-${uniq()}`, sB = `sess-${uniq()}`;
  const mA = await newMemory(pA, `Isolated A ${uniq()}`, `Body ${uniq()} in ${pA}.`);
  const evA = await createEventWithTimeline({ project: pA, session: sA, memoryIds: [mA.id] });
  const evB = await createEventWithTimeline({ project: pB, session: sB, memoryIds: [] });

  await core.dbQuery(
    `INSERT INTO memory_usefulness_observations (event_id,memory_id,signal,evidence,source)
     VALUES ($1,$2,'observed_usage',$3::jsonb,'deterministic')`,
    [evA, mA.id, JSON.stringify({ note: "project isolation fixture" })],
  );

  const sumA = await signals.usefulnessSignalSummary({ project_id: pA });
  const sumB = await signals.usefulnessSignalSummary({ project_id: pB });
  assert.equal(sumA.ok, true);
  assert.equal(sumB.ok, true);
  assert.ok(sumA.retrieval_events >= 1);
  assert.ok(sumA.inferred.observed_usage >= 1, "A must see its own observed_usage row");
  assert.equal(sumB.inferred.observed_usage, 0, "B must not see A's row");
  assert.ok(sumB.events_without_usefulness_rows >= 1, "B's event with no rows must be insufficient evidence");
  const bRow = (await core.dbQuery(
    "SELECT count(*)::int n FROM memory_usefulness_observations WHERE event_id=$1", [evB],
  )).rows[0].n;
  assert.equal(bRow, 0);
});

test("explicit helpful is separated from inferred deterministic signals; none are fabricated", async () => {
  const p = `sep-${uniq()}`, s = `sess-${uniq()}`;
  const title = `Distinctive separation policy ${uniq()}`;
  const m = await newMemory(p, title, `Separation body ${uniq()} for ${p}.`);
  const event_id = await createEventWithTimeline({
    project: p, session: s, memoryIds: [m.id],
    priorErrorText: `BUILD FAILED: error ${uniq()} in ${p}`,
    laterTexts: [`Applied ${title} successfully.`],
  });
  await core.dbQuery(
    `INSERT INTO memory_usefulness_observations (event_id,memory_id,signal,evidence,source)
     VALUES ($1,$2,'helpful',$3::jsonb,'user')`,
    [event_id, m.id, JSON.stringify({ reason: "explicit fixture" })],
  );
  const helpfulBefore = (await core.dbQuery(
    "SELECT count(*)::int n FROM memory_usefulness_observations WHERE event_id=$1 AND signal='helpful'", [event_id],
  )).rows[0].n;

  await signals.observeErrorNonRecurrence({ session_id: s, event_id });

  const sum = await signals.usefulnessSignalSummary({ project_id: p });
  assert.equal(sum.ok, true);
  assert.ok(sum.explicit.helpful >= 1);
  assert.equal(sum.deterministic_signals_never_claim_helpful, true);
  assert.equal(sum.no_fabrication, true);
  const helpfulAfter = (await core.dbQuery(
    "SELECT count(*)::int n FROM memory_usefulness_observations WHERE event_id=$1 AND signal='helpful'", [event_id],
  )).rows[0].n;
  assert.equal(helpfulAfter, helpfulBefore, "deterministic observation must never create a helpful row");
  assert.ok(!sum.by_signal_source.some((x) => x.signal === "error_not_recurred" && x.source === "user"));
});

test("empty/missing data produces structured results, never fabricated counts", async () => {
  const p = `empty-${uniq()}`, s = `sess-${uniq()}`;
  const event_id = await createEventWithTimeline({ project: p, session: s, memoryIds: [] });
  const before = await signals.usefulnessSignalSummary({ project_id: p });
  const r = await signals.observeErrorNonRecurrence({ session_id: s, event_id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.observed, 0);
  const after = await signals.usefulnessSignalSummary({ project_id: p });
  assert.equal(after.insufficient_evidence, before.insufficient_evidence);
  assert.equal(after.explicit.helpful, 0);
  assert.equal(after.inferred.error_not_recurred, 0);

  const bad = await signals.observeErrorNonRecurrence({});
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "invalid_argument");
  const missing = await signals.observeErrorNonRecurrence({ session_id: s, event_id: 999999999 });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "not_found");
});

test("close", async () => { await core.close(); });
