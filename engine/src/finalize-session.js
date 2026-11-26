// Detached, one-shot turn-end finalizer used by the OpenCode plugin when a
// session process exits. It re-reads the durable transcript after pending
// appends have had time to land and runs the EXISTING turn-end pipeline with a
// completeness assertion. No new engine, no new DB schema, no deletion.
import * as core from "./core.js";
import { readLines, lastSequence } from "./transcript.js";
import { runTurnEnd } from "./automation.js";

const [session_id, directory] = process.argv.slice(2);

if (!session_id) {
  console.log(JSON.stringify({ ok: false, reason: "session_id required" }));
} else {
  // Short grace period: fire-and-forget append children may still be writing as
  // the parent process tears down. The completeness guard still refuses a short
  // transcript, so this never invents success.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const lines = readLines(session_id);
    const seq = lastSequence(session_id);
    if (!seq || !lines.length) {
      console.log(JSON.stringify({ ok: true, skipped: "no durable transcript", session_id }));
    } else {
      const result = await runTurnEnd({
        session_id,
        project_id: directory,
        directory,
        transcript: lines.map((l) => `${l.role}: ${l.text}`).join("\n"),
        sequence: seq,
        min_sequence: seq,
      });
      console.log(JSON.stringify({ ok: result.ok, duplicate: !!result.duplicate,
        incomplete: !!result.incomplete, session_id, sequence: seq }));
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, session_id, error: String(e?.message || e).slice(0, 300) }));
  }
}
await core.close();
