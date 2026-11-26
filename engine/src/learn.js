// Safe, role-aware, idempotent learning from session transcripts.
// No model call. All extracted memories are CANDIDATES: never verified, never auto-promoted.
// Original imported summaries are never overwritten; derived text goes to summary_roles.
import crypto from "node:crypto";
import * as core from "./core.js";
import { classifyText, languageOf } from "./roles.js";

const LAYER_FOR = {
  user_preference: "user", user_correction: "user",
  successful_solution: "knowledge", failed_approach: "knowledge", debugging_pattern: "knowledge",
  repeated_failure: "knowledge", root_cause_candidate: "knowledge",
  historical_decision: "project", project_decision: "project",
  technical_knowledge: "knowledge", workflow_pattern: "knowledge",
  environment_config: "project", architecture_decision: "project",
  temporary_observation: "session", user_statement: "session", agent_reasoning: "session",
};

function parseLine(line) {
  // Accept both "TOOL: text" (durable reader) and the plugin's in-memory
  // "TOOL shell: text" form so tool output is classified as technical_knowledge.
  const m = String(line).trim().match(/^(USER|ASSISTANT|TOOL)(?:\s+[^:]{1,80})?:\s*(.*)$/s);
  if (m) return { role: m[1], text: m[2].trim() };
  return { role: "UNKNOWN", text: String(line).trim() };
}

export async function learnFromTranscript({ session_id, project_id, directory, transcript, save = true, force = false }) {
  const raw = String(transcript || "");
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 12 && x.length < 1200);
  const hash = crypto.createHash("sha256").update(`${session_id}|${raw}`).digest("hex");
  const pid = project_id || "_global";

  if (save && !force) {
    const prev = await core.dbQuery("SELECT candidates,saved FROM learning_runs WHERE session_id=$1 AND content_hash=$2", [session_id, hash]);
    if (prev.rowCount) {
      return { ok: true, idempotent: true, analyzed_lines: lines.length,
        candidates: prev.rows[0].candidates, saved: 0,
        previously_saved: prev.rows[0].saved, memories: [] };
    }
  }

  const candidates = [];
  for (const line of lines) {
    const { role, text } = parseLine(line);
    let kind = null;
    if (role === "TOOL") kind = "technical_knowledge"; // observed tool output, never verified
    else if (role === "USER" || role === "ASSISTANT" || role === "UNKNOWN") kind = classifyText(text, role);
    if (!kind) continue;
    // Assistant reasoning and tool output are candidates only; never proof of success.
    candidates.push({
      layer: LAYER_FOR[kind] || "knowledge",
      project_id: pid,
      title: `${kind}: ${text.slice(0, 70)}`,
      content: text,
      category: kind,
      source_session: session_id,
      source_kind: "observed",
      confidence: 0.45,
      importance: kind === "user_preference" || kind === "user_correction" ? 0.85 : 0.6,
      verified: false,
      language: languageOf(text),
      role,
    });
  }

  const saved = [];
  if (save) {
    for (const c of candidates) {
      const dup = await core.findDuplicate(c.title, c.content, c.project_id);
      if (dup) continue;
      const m = await core.saveMemory(c);
      saved.push(m);
    }
    // Derived summary stored separately. NEVER touch the original `summary` column.
    const derived = candidates.slice(0, 8).map((c) => `${c.role}: ${c.content.slice(0, 280)}`).join("\n").slice(0, 6000);
    const existing = await core.dbQuery("SELECT id FROM session_index WHERE id=$1", [session_id]);
    if (existing.rowCount) {
      await core.dbQuery(
        `UPDATE session_index SET summary_roles=COALESCE(summary_roles,$2),
          role_extracted_at=now(), message_count=GREATEST(message_count,$3) WHERE id=$1`,
        [session_id, derived || null, lines.length],
      );
    } else {
      await core.dbQuery(
        `INSERT INTO session_index (id, project_id, directory, title, summary, summary_roles, message_count, time_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [session_id, pid, directory || "", `Session ${session_id}`, lines[0]?.slice(0, 500) || "", derived || null, lines.length],
      );
    }
    await core.dbQuery(
      `INSERT INTO learning_runs (session_id,content_hash,project_id,candidates,saved)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [session_id, hash, pid, candidates.length, saved.length],
    );
    await core.audit("learning.run", session_id, { candidates: candidates.length, saved: saved.length, project_id: pid, idempotent: false });
    await core.dbQuery(
      `INSERT INTO intelligence_audit_events (track,action,resource,detail)
       VALUES ('learning','turn_end_learn',$1,$2::jsonb)`,
      [session_id, JSON.stringify({ candidates: candidates.length, saved: saved.length, project_id: pid })],
    );
  }
  return { ok: true, idempotent: false, analyzed_lines: lines.length,
    candidates: candidates.length, saved: saved.length, memories: saved };
}
