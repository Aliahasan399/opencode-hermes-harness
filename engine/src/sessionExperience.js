// Phase 19 workstream A — understand a complete development session as a set of
// connected, evidence-backed events.
//
// Pure and deterministic: no LLM, no network, no database access and no clock or
// randomness. Given the same lines it always returns the same result. Every
// signal points back to a specific transcript line (seq + excerpt), and only
// transcript/tool evidence is used: a file is never claimed as "inspected" unless
// its path literally appears in the transcript text.

import { redact } from "./llm-provider.js";

// Fixed, frozen change-state vocabulary used by classifyChange and summary.changes.
export const CHANGE_STATES = Object.freeze({
  PROPOSED: "proposed",
  ATTEMPTED: "attempted",
  EXECUTED: "executed",
  VERIFIED: "verified",
  REJECTED: "rejected",
  REVERTED: "reverted",
});

// ---- hard bounds -----------------------------------------------------------
const MAX_LINES = 60;
const MAX_EVENT_TEXT = 1200;
const MAX_ITEM_TEXT = 300;
const MAX_GOAL_HINTS = 8;
const MAX_CHANGES = 30;
const MAX_ERRORS = 20;
const MAX_TESTS = 20;
const MAX_DECISIONS = 20;
const MAX_UNFINISHED = 20;
const MAX_CONSTRAINTS = 20;
const MAX_TOOLS = 30;
const MAX_EVIDENCE = 60;
const MAX_FILES = 5;

// ---- deterministic detection rules ----------------------------------------
const ERROR_RE = /(?:error|exception|traceback|failed|fails|failure|assertionerror|assert\s+\S+\s*==|\bFAILED\b|crash(?:ed)?|rejected|non-?zero)/i;
const PASS_RE = /\b(\d+\s+tests?\s+(?:passed|ok)|tests?\s+pass(?:ed)?|all tests|test suite passed|1 passed|\d+ passed|green|build passed|verified|pass)\b/i;
const FAIL_RE = /\b(\d+\s+tests?\s+failed|tests?\s+fail(?:ed)?|failing|assertionerror|assert\s+\S+\s*==|\bFAILED\b|fail)\b/i;
const TEST_RE = /(\btests?\b|\bpytest\b|\bnpm test\b|\bnode --test\b|\btest suite\b|\bverif(?:y|ied|ication)\b|\bpassed\b|\bfailed\b)/i;
const VERIFY_TOOL_RE = /\b(verif(?:y|ied|ication)|confirmed|test result|test run|node --test|npm test|pytest|check passed)\b/i;
const WRITE_RE = /\b(wrote|written|write|wrote to|created|create file|updated|saved|edited|edit|modified|patched|applied|added file|overwrote|new file|file created|file written)\b/i;
const WRITE_TOOL_RE = /\b(edit|write|create|patch|apply_patch|replace|sed|mkdir|touch|copy|move|rm|delete)\b/i;
const REVERT_RE = /\b(revert(?:ed|ing)?|rolled back|rollback|undone|undo|reversed|back out)\b/i;
const PROPOSE_RE = /\b(will|going to|gonna|about to|plan to|planning to|intend to|shall|let me|i'll|we'll|create|build|implement|add|write|next i)\b/i;
const ATTEMPT_RE = /\b(attempt(?:ed|ing)?|trying|tried|running|try to|started|starting|in progress)\b/i;
const DECISION_RE = /\b(decided|chose|choose|selected|agreed|opted(?:\s+for)?|switched(?:\s+from|\s+to)?|will use|shall use|going to use|went with|migrated to|decision\s*:)\b/i;
const UNFINISHED_RE = /\b(todo|to-do|not done|not yet|do not|not implement|yet|incomplete|unfinished|remaining|left to do|next step|still need|still to|pending|will do later|will be done later|left for|follow(?: |-)?up|need to (?:add|do|fix|finish|complete)|work in progress|wip)\b/i;
const CONSTRAINT_RE = /\b(must|must not|should|should not|never|always|do not|don't|cannot|can't|only|required|requirement|constraints?|restriction|forbid(?:den)?|have to|need to ensure)\b/i;
const GOAL_RE = /\b(build|create|implement|fix|add|refactor|debug|design|make|need|want|please|goal|task|help me|set up|write|migrate|investigate|research|update|improve|optimize)\b/i;
const FILE_PATH_RE = /([A-Za-z]:\\[^\s"'<>|]{2,140}|\.{0,2}\/[A-Za-z0-9_.][A-Za-z0-9_.\/-]{1,140}|\b[A-Za-z0-9_-]+\/[A-Za-z0-9_.\/-]+\.[A-Za-z]{1,8}\b|\b[A-Za-z0-9_-]+\.(?:js|jsx|ts|tsx|py|sql|json|md|css|html|yml|yaml|java|go|rs|rb|sh|toml|ini)\b)/g;

// ---- small pure helpers ----------------------------------------------------
function safeString(v) {
  if (v === undefined || v === null) return "";
  try { return typeof v === "string" ? v : String(v); } catch { return ""; }
}

function bound(text, max) {
  const s = safeString(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function hasFailedExit(raw) {
  const exit = raw && typeof raw === "object" ? raw.metadata && raw.metadata.exit : undefined;
  return exit !== undefined && exit !== null && exit !== "" && Number(exit) !== 0;
}

function detectKind(raw, role, text) {
  const declared = safeString(raw.kind).toUpperCase();
  if (declared === "TOOL_CALL") return "tool_call";
  if (declared === "TOOL_RESULT") return "tool_result";

  if (role === "USER") return "user_request";
  if (role === "ASSISTANT") return "assistant_statement";

  const tool = raw.tool ? safeString(raw.tool) : "";
  if (role === "TOOL") {
    if (hasFailedExit(raw) || ERROR_RE.test(text)) return "error_output";
    if (TEST_RE.test(text)) return "test_output";
    if (tool && WRITE_TOOL_RE.test(tool)) return "edit_write_result";
    if (WRITE_RE.test(text)) return "edit_write_result";
    return tool ? "tool_call" : "tool_result";
  }

  // UNKNOWN / other roles: infer conservatively from content only.
  if (hasFailedExit(raw) || ERROR_RE.test(text)) return "error_output";
  if (TEST_RE.test(text)) return "test_output";
  if (tool) return "tool_call";
  return "assistant_statement";
}

function derivePhase(kind, text) {
  switch (kind) {
    case "user_request": return "request";
    case "error_output": return "error";
    case "test_output": return "verify";
    case "edit_write_result": return "execute";
    case "tool_call": return "execute";
    case "tool_result": return "observe";
    case "assistant_statement": return REVERT_RE.test(text) ? "revert" : "plan";
    default: return "observe";
  }
}

/**
 * Parse raw transcript lines into connected, ordered, redacted events.
 * @param {Array<object>} lines
 * @returns {Array<{seq:number,role:string,kind:string,tool:string|null,text:string,phase:string,evidence:object}>}
 */
export function parseSessionEvents(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const events = [];
  const input = arr.slice(0, MAX_LINES);
  for (let i = 0; i < input.length; i++) {
    try {
      const raw = input[i] && typeof input[i] === "object" ? input[i] : {};
      const roleRaw = safeString(raw.role).toUpperCase();
      const role = ["USER", "ASSISTANT", "TOOL"].includes(roleRaw) ? roleRaw : "UNKNOWN";
      const text = bound(redact(safeString(raw.text)), MAX_EVENT_TEXT);
      if (!text) continue;
      const tool = raw.tool ? bound(redact(safeString(raw.tool)), 120) : null;
      const kind = detectKind(raw, role, text);
      const seq = Number.isFinite(Number(raw.seq)) ? Math.trunc(Number(raw.seq)) : i + 1;
      const exit = raw.metadata && raw.metadata.exit !== undefined ? raw.metadata.exit : null;
      const evidence = {
        seq,
        role,
        excerpt: text.slice(0, 200),
        ...(exit !== null ? { exit } : {}),
      };
      events.push({ seq, role, kind, tool, text, phase: derivePhase(kind, text), evidence });
    } catch {
      // A single malformed line is skipped; parseSessionEvents never throws.
      continue;
    }
  }
  return events;
}

/**
 * Classify a change event into exactly one CHANGE_STATE. Never treats a bare
 * assistant claim as verified or executed: those states require tool evidence.
 * @param {object} event
 * @returns {string} one of CHANGE_STATES
 */
export function classifyChange(event) {
  if (!event || typeof event !== "object") return CHANGE_STATES.ATTEMPTED;
  const role = safeString(event.role).toUpperCase();
  const text = safeString(event.text);
  const kind = safeString(event.kind);
  const tool = safeString(event.tool);
  const exit = event.evidence && event.evidence.exit;
  const failedExit = exit !== undefined && exit !== null && exit !== "" && Number(exit) !== 0;

  // 1. Explicit reversal is the strongest signal.
  if (REVERT_RE.test(text)) return CHANGE_STATES.REVERTED;

  // 2. Errors / non-zero tool exit code are failed (rejected) changes.
  if (failedExit || kind === "error_output" || ERROR_RE.test(text)) return CHANGE_STATES.REJECTED;

  // 3. Verification requires actual tool test/verification output with a pass.
  if (role === "TOOL"
      && (kind === "test_output" || VERIFY_TOOL_RE.test(text))
      && PASS_RE.test(text)
      && !FAIL_RE.test(text)) {
    return CHANGE_STATES.VERIFIED;
  }

  // 4. Execution requires an observed tool write/edit.
  if (role === "TOOL"
      && (kind === "edit_write_result" || WRITE_RE.test(text) || (tool && WRITE_TOOL_RE.test(tool)))) {
    return CHANGE_STATES.EXECUTED;
  }

  // 5. An in-flight tool call or attempt is only attempted.
  if (kind === "tool_call" || (role === "TOOL" && ATTEMPT_RE.test(text))) return CHANGE_STATES.ATTEMPTED;

  // 6. Assistant proposal language is proposed; a bare assistant claim stays
  //    proposed and is never promoted to verified/executed.
  if (role === "ASSISTANT") return CHANGE_STATES.PROPOSED;

  return CHANGE_STATES.ATTEMPTED;
}

function extractFiles(text) {
  const out = [];
  const seen = new Set();
  FILE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    const p = m[1];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p.slice(0, 140));
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function signature(text) {
  const sig = safeString(text)
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/gi, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{12,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[^\p{L}\p{N}<>:_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return sig || "unknown";
}

function emptySummary() {
  return {
    goal_hints: [], changes: [], errors: [], tests: [],
    decisions: [], unfinished: [], constraints: [], tools_used: [],
  };
}

function safeResult() {
  return {
    ok: true,
    session_id: null,
    project_id: null,
    analyzed_lines: 0,
    events: [],
    summary: emptySummary(),
    evidence: [],
  };
}

/**
 * Analyze a whole session from transcript lines only.
 * @param {{session_id?:string, project_id?:string, lines?:Array<object>}} [options]
 */
export function analyzeSessionExperience(options = {}) {
  try {
    const input = options && typeof options === "object" ? options : {};
    const session_id = input.session_id ? safeString(input.session_id) : null;
    const project_id = input.project_id ? safeString(input.project_id) : null;
    const events = parseSessionEvents(input.lines);
    const summary = emptySummary();
    const evidence = [];
    const tools = new Set();
    const seenGoal = new Set();
    const seenChange = new Set();
    const seenErr = new Set();
    const seenDec = new Set();
    const seenUnf = new Set();
    const seenCon = new Set();

    for (const ev of events) {
      if (evidence.length < MAX_EVIDENCE) {
        evidence.push({ seq: ev.seq, role: ev.role, kind: ev.kind, excerpt: ev.evidence.excerpt });
      }
      if (ev.tool && tools.size < MAX_TOOLS) tools.add(ev.tool);

      const text = ev.text;

      // Goal hints come only from user requests carrying goal language.
      if (ev.role === "USER" && summary.goal_hints.length < MAX_GOAL_HINTS && GOAL_RE.test(text)) {
        const g = bound(text, 240);
        if (g && !seenGoal.has(g)) { seenGoal.add(g); summary.goal_hints.push(g); }
      }

      // Changes: only events that represent a proposal, execution, verification,
      // error or reversal. Pure chatter never becomes a "change".
      const state = classifyChange(ev);
      const isChangeEvt = ["edit_write_result", "test_output", "error_output", "tool_call", "tool_result"].includes(ev.kind)
        || REVERT_RE.test(text)
        || (ev.role === "ASSISTANT" && (PROPOSE_RE.test(text) || WRITE_RE.test(text)));
      if (isChangeEvt && summary.changes.length < MAX_CHANGES) {
        const files = extractFiles(text);
        const changeKind = ev.kind === "test_output" ? "test"
          : ev.kind === "error_output" ? "error"
            : REVERT_RE.test(text) ? "revert"
              : (ev.kind === "edit_write_result" || WRITE_RE.test(text)) ? "edit"
                : ev.kind;
        const key = `${changeKind}|${state}|${ev.seq}|${files.join(",")}`;
        if (!seenChange.has(key)) {
          seenChange.add(key);
          summary.changes.push({
            kind: changeKind,
            state,
            file: files[0] || null,
            evidence: { seq: ev.seq, role: ev.role, excerpt: ev.evidence.excerpt },
          });
        }
      }

      // Errors: observed tool error output only (never an assistant's prose claim).
      if ((ev.kind === "error_output" || (ev.role === "TOOL" && ERROR_RE.test(text)))
          && !/^\s*(0 failed|no error|passed)/i.test(text)) {
        if (summary.errors.length < MAX_ERRORS) {
          const sig = signature(text);
          if (!seenErr.has(sig)) {
            seenErr.add(sig);
            summary.errors.push({ signature: sig, text: bound(text, MAX_ITEM_TEXT), seq: ev.seq });
          }
        }
      }

      // Tests: a pass is only recorded from tool evidence; a bare assistant
      // claim of success is downgraded to "unknown", never to "pass".
      if ((ev.kind === "test_output" || TEST_RE.test(text)) && summary.tests.length < MAX_TESTS) {
        const result = (FAIL_RE.test(text) || ev.kind === "error_output") ? "fail"
          : (ev.role === "TOOL" && PASS_RE.test(text)) ? "pass" : "unknown";
        summary.tests.push({ result, seq: ev.seq });
      }

      // Decisions / unfinished work / constraints: explicit language only.
      if (DECISION_RE.test(text) && summary.decisions.length < MAX_DECISIONS) {
        const d = bound(text, MAX_ITEM_TEXT);
        if (!seenDec.has(d)) { seenDec.add(d); summary.decisions.push({ text: d, seq: ev.seq }); }
      }
      if (UNFINISHED_RE.test(text) && summary.unfinished.length < MAX_UNFINISHED) {
        // Capture only the sentences that actually express unfinished/negative
        // intent, not the whole prompt (otherwise completed work in the same
        // message is mistaken for remaining work downstream).
        const sentences = String(text).split(/(?<=\.)\s+(?=[A-Z])|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
        const candidates = sentences.filter((s) => UNFINISHED_RE.test(s));
        for (const sentence of (candidates.length ? candidates : [text]).slice(0, 3)) {
          const u = bound(sentence, MAX_ITEM_TEXT);
          if (!seenUnf.has(u)) { seenUnf.add(u); summary.unfinished.push({ text: u, seq: ev.seq }); }
          if (summary.unfinished.length >= MAX_UNFINISHED) break;
        }
      }
      if (CONSTRAINT_RE.test(text) && summary.constraints.length < MAX_CONSTRAINTS) {
        const c = bound(text, MAX_ITEM_TEXT);
        if (!seenCon.has(c)) { seenCon.add(c); summary.constraints.push({ text: c, seq: ev.seq }); }
      }
    }

    summary.tools_used = [...tools].sort().slice(0, MAX_TOOLS);

    return {
      ok: true,
      session_id,
      project_id,
      analyzed_lines: events.length,
      events,
      summary,
      evidence,
    };
  } catch {
    return safeResult();
  }
}

export default { CHANGE_STATES, parseSessionEvents, classifyChange, analyzeSessionExperience };
