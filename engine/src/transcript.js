// Durable, append-only transcript persistence for real OpenCode sessions.
// Never writes to original OpenCode session records; files live under E:\OpenCodeData\memory.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MEMORY_ROOT, audit } from "./core.js";
import { redact } from "./llm-provider.js";

const DIR = path.join(MEMORY_ROOT, "logs", "sessions");
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
// Atomic cross-process append lock. Each durable append is a separate CLI process
// with its own seqCache; an atomic mkdir (the only portable primitive that is
// exclusive across processes) serializes seq allocation per session. Different
// sessions use different lock directories and never block each other.
const LOCK_ROOT = path.join(DIR, ".append-locks");
fs.mkdirSync(LOCK_ROOT, { recursive: true, mode: 0o700 });
const seqCache = new Map();
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function lockDirFor(session_id) {
  const safe = crypto.createHash("sha256").update(String(session_id)).digest("hex").slice(0, 20);
  return path.join(LOCK_ROOT, safe);
}

function withAppendLock(session_id, fn) {
  const dir = lockDirFor(session_id);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      break; // acquired
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline) {
        // Stale lock from a process that died mid-append: remove only the empty
        // directory we own, then retry once. Existing transcripts are untouched.
        try { fs.rmdirSync(dir); } catch { /* still held; retry */ }
      }
      Atomics.wait(sleepBuf, 0, 0, 8);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(dir); } catch { /* never delete transcript data */ }
  }
}

function fileFor(session_id) {
  const safe = crypto.createHash("sha256").update(String(session_id)).digest("hex").slice(0, 20);
  return path.join(DIR, `${safe}.jsonl`);
}

export function appendLine({ session_id, role, text, kind, language, tool } = {}) {
  if (!session_id) throw new Error("session_id required");
  const clean = redact(String(text ?? "")).trim();
  if (clean.length < 4) return { ok: false, skipped: "empty" };
  const file = fileFor(session_id);
  // The whole read-seq/write block runs under a per-session cross-process lock so
  // overlapping appends cannot allocate the same seq. Existing readers are
  // unaffected: each line is still one atomic appendFileSync write.
  return withAppendLock(session_id, () => {
    const cached = seqCache.get(session_id);
    const onDisk = fs.existsSync(file) ? lastSequence(session_id) : 0;
    const seq = Math.max(cached ?? 0, onDisk) + 1;
    const rec = {
      seq, session_id, role: role || "UNKNOWN", text: clean.slice(0, 8000),
      kind: kind || null, language: language || null, tool: tool || null,
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    seqCache.set(session_id, seq);
    return { ok: true, seq, file };
  });
}

export function readLines(session_id) {
  const file = fileFor(session_id);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip damaged line, never rewrite file */ }
  }
  return out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

export function transcriptText(session_id) {
  return readLines(session_id).map((l) => `${l.role}: ${l.text}`).join("\n");
}

export function lastSequence(session_id) {
  const lines = readLines(session_id);
  return lines.length ? Math.max(...lines.map((l) => l.seq || 0)) : 0;
}

export function listDurableSessions() {
  const ids = new Set();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      for (const line of fs.readFileSync(path.join(DIR, f), "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.session_id) { ids.add(rec.session_id); break; }
      }
    } catch { /* skip unreadable file */ }
  }
  return [...ids];
}

export function resetSequenceCache() { seqCache.clear(); }

export async function auditTranscriptRecovery(session_id, seq, reason) {
  await audit("transcript.recovery", session_id, { seq, reason });
}
