import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";
import { runTurnEnd } from "../src/automation.js";
import { prepareContext } from "../src/contextPackage.js";
import { intelligenceQualityReport } from "../src/phase13Report.js";

const uniq = () => `p13g-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "q")}`;

test("unified pipeline includes semantic and error-learning stages", async () => {
  const sid = `flow-${uniq()}`;
  const r = await runTurnEnd({ session_id: sid, directory: "E:\\New  Project",
    transcript: `USER: use focused tests before full suite in ${sid}\nTOOL: ERROR: missing module in ${sid}\nASSISTANT: installed module and reran focused test: 1 passed` });
  assert.equal(r.ok, true);
  for (const s of ["learning","understanding","patterns","strategy","semantic_understanding","error_learning","outcome_capture","retrieval_feedback"]) {
    assert.ok(r.stages[s], `missing stage ${s}`);
  }
});

test("session-start context package is available after learning", async () => {
  const sid = `ctx-${uniq()}`;
  await runTurnEnd({ session_id: sid, directory: "E:\\New  Project",
    transcript: `USER: prefer redis ttl in ${sid}` });
  const r = await prepareContext({ project_id: "13044f2ae5cff09764b32f1ba690d7d4343cae52", budget_chars: 1500 });
  assert.equal(r.ok, true);
  assert.ok(r.context.length <= 1600);
});

test("unified intelligence report labels every metric", async () => {
  const r = await intelligenceQualityReport({});
  assert.equal(r.ok, true);
  for (const section of ["session_intelligence","memory_intelligence","learning_intelligence","data_quality"]) {
    assert.ok(r[section], `missing ${section}`);
  }
  const sample = r.session_intelligence.sessions_analyzed;
  assert.equal(sample.measurement, "observed");
  assert.ok(sample.source);
});

test("close", async () => { await core.close(); });
