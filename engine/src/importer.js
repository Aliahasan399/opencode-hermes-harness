// Read-only import of OpenCode V2 session history. Never modifies source files.
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import * as core from "./core.js";

const SQLITE = process.env.SQLITE3 || "C:\\msys64\\ucrt64\\bin\\sqlite3.exe";

function rows(db, sql) {
  const out = execFileSync(SQLITE, ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

export async function importOpenCodeHistory({ opencode_db, limit = 50 }) {
  const db = opencode_db || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  const sessions = rows(db, `
    SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
           (SELECT count(*) FROM session_message m WHERE m.session_id=s.id) AS message_count
    FROM session_v2 s ORDER BY s.time_updated DESC LIMIT ${Number(limit)};`);
  let imported = 0;
  for (const s of sessions) {
    const msgs = rows(db, `
      SELECT json_extract(data,'$.content') AS content, json_extract(data,'$.time.created') AS created
      FROM session_message WHERE session_id='${s.id.replace(/'/g, "''")}'
      ORDER BY seq LIMIT 12;`);
    const texts = [];
    for (const m of msgs) {
      try {
        const arr = JSON.parse(m.content || "[]");
        for (const c of arr) if (typeof c?.text === "string") texts.push(c.text);
      } catch { /* ignore malformed parts */ }
    }
    await core.dbQuery(
      `INSERT INTO session_index (id, project_id, directory, title, summary, message_count, time_created, time_updated)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp(($7)::bigint/1000.0),to_timestamp(($8)::bigint/1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.project_id || "_global", s.directory || "", s.title || "",
       texts.join(" ").slice(0, 2000), s.message_count || 0, s.time_created || 0, s.time_updated || 0],
    );
    imported++;
  }
  await core.dbQuery(
    `INSERT INTO import_state (source,last_run,count) VALUES ('opencode.db',now(),$1)
     ON CONFLICT (source) DO UPDATE SET last_run=now(), count=import_state.count+EXCLUDED.count`,
    [imported],
  );
  await core.audit("history.import", "opencode.db", { sessions: imported });
  return { ok: true, sessions_seen: sessions.length, sessions_imported: imported, source_read_only: true };
}
