// Public-release safety scan. Read-only; no network, no Git, no writes.
// Scans the intended public surface only (never backups/, checkpoints/, logs/,
// data/, node_modules/, or the raw .env).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// Synthetic canaries used by the engine's adversarial tests. None may appear
// in a public file, even though they are not real credentials.
const CANARIES = [
  "sk-abcdefgh12345678",
  "sk-abcdefghijklmnopqrstuvwxyz",
  "sk-abcdefghijklmnopqrst",
  "sk-1234567890abcdefghijklmnop",
  "sk-test-placeholder-not-real",
  "Bearer abcdef123456",
  "Bearer eyJhbGciOiJIUzI1NiJ9payloadsignature",
  "AKIAIOSFODNN7EXAMPLE",
  "hunter2secret",
  "P20SEC_CANARY_",
];

// The only real absolute path permitted in a public file is the documented
// repository location for this reference deployment.
const DOCUMENTED_REPO = "E:\\OpenCodeData\\memory";
const BS = String.fromCharCode(92); // literal backslash, avoids escaping ambiguity

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function publicFiles() {
  const files = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(REPO_ROOT, e.name));
  for (const d of ["docs", "installer", "integrations", "examples", ".github"]) {
    files.push(...walk(path.join(REPO_ROOT, d)));
  }
  const envExample = path.join(REPO_ROOT, ".env.example");
  if (fs.existsSync(envExample)) files.push(envExample);
  return [...new Set(files)];
}

function withLines(files, check) {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(REPO_ROOT, f);
    text.split(/\r?\n/).forEach((line, i) => {
      const found = check(line, text);
      if (found) hits.push(`${rel}:${i + 1} [${found}]`);
    });
  }
  return hits;
}

test("public files contain no synthetic canaries or secret fixtures", (t) => {
  const files = publicFiles();
  if (files.length === 0) {
    t.skip("no public files found yet");
    return;
  }
  const hits = withLines(files, (line) => {
    for (const c of CANARIES) if (line.includes(c)) return `canary ${c.slice(0, 12)}…`;
    if (/\bsk-a{32}\b/.test(line)) return "generated sk- canary";
    return null;
  });
  assert.deepEqual(hits, [], "synthetic canaries must not appear in public files; found:\n" + hits.join("\n"));
  t.diagnostic(`scanned ${files.length} public file(s) for canaries`);
});

test("installer performs no Git operations", (t) => {
  const dir = path.join(REPO_ROOT, "installer");
  if (!fs.existsSync(dir)) {
    t.skip("installer/ not produced yet");
    return;
  }
  const files = walk(dir);
  if (files.length === 0) {
    t.skip("installer/ contains no files yet");
    return;
  }
  const gitOp = /\bgit\s+(init|add|commit|push|pull|clone|remote|fetch|checkout|merge|rebase|tag|reset|clean|worktree)\b/i;
  const gitSpawn = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]git["'`]/i;
  const gitArg = /["'`]git["'`]\s*,/;
  const hits = withLines(files, (line) =>
    (gitOp.test(line) || gitSpawn.test(line) || gitArg.test(line)) ? "git operation" : null);
  assert.deepEqual(hits, [], "installer must never run Git; found:\n" + hits.join("\n"));
  t.diagnostic(`scanned ${files.length} installer file(s)`);
});

test("public files contain no production database name", (t) => {
  const env = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(env)) {
    t.skip("raw .env absent; cannot extract production DB name for comparison");
    return;
  }
  const match = fs.readFileSync(env, "utf8").match(/^\s*MEMORY_DB_NAME\s*=\s*(.+?)\s*$/m);
  if (!match) {
    t.skip("MEMORY_DB_NAME not set in .env");
    return;
  }
  const dbName = match[1].replace(/^["']|["']$/g, "").trim();
  // Generic defaults are intentionally published by the installer/integration
  // docs as fill-in examples; they are not environment-specific identifiers.
  const GENERIC_DB_NAMES = new Set([
    "postgres", "template0", "template1", "memory", "opencode_memory",
    "prod", "production", "live", "main", "test", "ci",
  ]);
  if (dbName.length < 4 || GENERIC_DB_NAMES.has(dbName.toLowerCase())) {
    t.skip("production DB name is a generic default (also published intentionally as a fill-in value); no environment-specific DB name to scan");
    return;
  }
  const escaped = dbName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  const files = publicFiles();
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (re.test(text)) hits.push(path.relative(REPO_ROOT, f));
  }
  assert.deepEqual(hits, [],
    "environment-specific production database name must not appear in public files; found in:\n" + hits.join("\n"));
  t.diagnostic(`production DB name checked against ${files.length} public file(s)`);
});

test("public files contain no personal/real filesystem paths or session ids", (t) => {
  const files = publicFiles();
  if (files.length === 0) {
    t.skip("no public files found yet");
    return;
  }
  const allowed = DOCUMENTED_REPO.toLowerCase();
  // Require at least two path segments and exclude regex metacharacters so a
  // code snippet such as `status:\s*(stale|...)` is not mistaken for a drive path.
  const winPath = /[A-Za-z]:\\{1,2}[^\s"'`<>)|,;*()^]*(?:\\{1,2}[^\s"'`<>)|,;*()^]*)+/g;
  const unixHome = /\/(?:Users|home)\/[A-Za-z0-9._-]{2,}\//g;
  const sessionId = /\bses_[A-Za-z0-9]{8,}\b/g;

  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(REPO_ROOT, f);
    for (const [name, re] of [["absolute path", winPath], ["personal home path", unixHome], ["session id", sessionId]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (name === "absolute path") {
          // Docs show escaped TypeScript strings (E:\\OpenCodeData\\memory\\...),
          // so collapse doubled backslashes before comparing to the allowed root.
          const normalized = m[0].toLowerCase().split(BS + BS).join(BS);
          if (normalized === allowed || normalized.startsWith(allowed + BS)) continue;
        }
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line} [${name}]`);
      }
    }
  }
  assert.deepEqual(hits, [],
    "public files must contain no real paths beyond the documented repo location and no session ids; found:\n" + hits.join("\n"));
  t.diagnostic(`path scan covered ${files.length} public file(s)`);
});

test(".gitignore excludes sensitive local material", () => {
  const p = path.join(REPO_ROOT, ".gitignore");
  assert.ok(fs.existsSync(p), ".gitignore must exist");
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim());
  const required = [".env", "backups/", "logs/", "checkpoints/", "data/", "node_modules/"];
  const missing = required.filter((r) => !lines.includes(r));
  assert.deepEqual(missing, [], `.gitignore is missing required ignore entries: ${missing.join(", ")}`);
});
