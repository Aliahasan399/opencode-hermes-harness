// Canonical project identity resolution.
// Directory paths are resolved to the SAME project id OpenCode uses (from its read-only
// project table). No new project rows are created; unknown directories get one stable,
// deterministic namespace derived from the normalized path.
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./core.js";

const SQLITE = process.env.SQLITE3 || "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";
const OPENCODE_DB = process.env.HARNESS_OPENCODE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const cache = new Map();

export function normalizeDir(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let p = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  // Make relative paths absolute against the current working directory.
  if (!/^[A-Za-z]:/.test(p) && !p.startsWith("/")) p = path.resolve(raw).replace(/\\/g, "/");
  return p.replace(/\/+/g, "/").toLowerCase();
}

function sqliteRows(db, sql) {
  const out = execFileSync(SQLITE, ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

function canonicalFromOpenCode(dir) {
  const rows = sqliteRows(OPENCODE_DB, "SELECT id, worktree FROM project");
  const target = normalizeDir(dir);
  // Exact match only. Parent-prefix matching would collapse unrelated folders into
  // root projects (e.g. every E: folder into the E:/ project).
  for (const r of rows) {
    if (normalizeDir(r.worktree) === target) return r.id;
  }
  return null;
}

export async function resolveProjectId(directory) {
  const norm = normalizeDir(directory);
  if (!norm) return "_global";
  if (cache.has(norm)) return cache.get(norm);

  let id = null;
  try { id = canonicalFromOpenCode(norm); } catch { /* fall through to local mapping */ }
  if (!id) {
    try {
      const r = await core.dbQuery(
        `SELECT project_id FROM session_index
         WHERE lower(replace(replace(directory,'\\','/'),'//','/')) = $1 LIMIT 1`,
        [norm],
      );
      id = r.rows[0]?.project_id || null;
    } catch { id = null; }
  }
  if (!id) id = `dir-${crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12)}`;
  cache.set(norm, id);
  return id;
}

export async function resolveMany(directories = []) {
  const out = {};
  for (const d of directories) out[String(d)] = await resolveProjectId(d);
  return out;
}

export function clearCache() { cache.clear(); }
