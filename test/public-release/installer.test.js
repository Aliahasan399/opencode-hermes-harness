// Public-release installer contract tests.
// DRY-RUN ONLY. No Git commands, no network, no writes outside a unique temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const INSTALLER = path.join(REPO_ROOT, "installer", "bootstrap", "install.mjs");

// Stable production files that an installer must never modify. Chosen because no
// other release-prep agent owns them, so a fingerprint change is attributable.
const PRODUCTION_SENTINELS = [
  ".env",
  ".gitignore",
  "engine/package.json",
  "engine/src/server.js",
  "engine/src/cli.js",
  "init/001-init.sql",
  "docker-compose.yml",
];

function fingerprint() {
  const out = {};
  for (const rel of PRODUCTION_SENTINELS) {
    const p = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(p)) {
      out[rel] = "ABSENT";
      continue;
    }
    const st = fs.statSync(p);
    out[rel] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
  }
  return out;
}

function listDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    out.push(entry.name + (entry.isDirectory() ? "/" : ""));
  }
  return out.sort();
}

// Extract the first balanced JSON value from text that may contain banners or
// fenced blocks. Respects strings and escape sequences.
function extractFirstJson(text) {
  const s = String(text || "");
  for (let start = 0; start < s.length; start += 1) {
    const open = s[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function planShape(raw) {
  // --json emits { discovery, plan }; text mode emits a human-readable plan.
  let plan = raw;
  if (plan && plan.plan && typeof plan.plan === "object") plan = plan.plan;
  assert.ok(plan && typeof plan === "object" && !Array.isArray(plan),
    "installer must expose a plan object");
  const capabilities = plan.capabilities ?? plan.selectedCapabilities ?? plan.selection?.capabilities;
  assert.ok(capabilities !== undefined,
    "plan must expose a capabilities selection (capabilities / selectedCapabilities / selection.capabilities)");
  const actions = plan.actions ?? plan.changes ?? plan.steps;
  assert.ok(Array.isArray(actions), "plan must expose an actions list (actions / changes / steps)");
  return {
    capabilities: JSON.parse(JSON.stringify(capabilities)),
    actions: JSON.parse(JSON.stringify(actions)),
  };
}

// The contract command does not pass --json, so support both the machine and
// human-readable dry-run renderings.
function parsePlanOutput(stdout) {
  const json = extractFirstJson(stdout);
  if (json && typeof json === "object" && !Array.isArray(json) &&
      (json.capabilities !== undefined || json.changes !== undefined ||
        (json.plan && typeof json.plan === "object"))) {
    return planShape(json);
  }
  const capMatch = stdout.match(/^Mode:\s*(.*?)\s*\|\s*Capabilities:\s*(.*)$/m);
  assert.ok(capMatch, "dry-run text output must include a 'Mode: ... | Capabilities: ...' line");
  const capabilities = capMatch[2].trim().split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(capabilities, ["memory"],
    "dry-run must select the requested 'memory' capability");
  const actions = stdout.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*\[([^\]]+)\]\s+(.+)$/))
    .filter(Boolean)
    .map((m) => `${m[1]}: ${m[2].trim()}`);
  assert.ok(actions.length > 0, "dry-run text output must include an actions list");
  return { capabilities, actions };
}

function runDryRun(target) {
  const r = spawnSync(process.execPath,
    [INSTALLER, "--target", target, "--capabilities", "memory", "--dry-run"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30000 });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error ? String(r.error) : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function assertCleanRun(r) {
  const detail = `status=${r.status} signal=${r.signal} error=${r.error}\n` +
    `stdout=${r.stdout.slice(0, 2000)}\nstderr=${r.stderr.slice(0, 2000)}`;
  assert.equal(r.status, 0, `installer dry-run must exit 0; ${detail}`);
  assert.equal(r.error, null, `installer dry-run must not fail to spawn; ${detail}`);
}

test("installer dry-run: present, non-destructive, idempotent plan", (t) => {
  if (!fs.existsSync(INSTALLER)) {
    t.skip(`installer/bootstrap/install.mjs not produced yet (repo=${REPO_ROOT})`);
    return;
  }
  assert.ok(fs.statSync(INSTALLER).isFile(), "installer path must be a file");

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-release-installer-"));
  t.after(() => { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ } });

  const beforeRepo = fingerprint();
  assert.deepEqual(listDir(target), [], "temp target must start empty");

  const first = runDryRun(target);
  assertCleanRun(first);
  const firstPlan = parsePlanOutput(first.stdout);
  assert.deepEqual(listDir(target), [],
    "dry-run must create no files or directories inside --target");
  assert.deepEqual(fingerprint(), beforeRepo,
    "dry-run must not modify the production repository");

  const second = runDryRun(target);
  assertCleanRun(second);
  const secondPlan = parsePlanOutput(second.stdout);
  assert.deepEqual(listDir(target), [],
    "a repeated dry-run must still create no files inside --target");
  assert.deepEqual(fingerprint(), beforeRepo,
    "a repeated dry-run must still not modify the production repository");

  assert.deepEqual(secondPlan, firstPlan,
    "dry-run plan must be idempotent (same capabilities selection and actions list)");
  t.diagnostic(`capabilities=${JSON.stringify(firstPlan.capabilities)} actions=${firstPlan.actions.length}`);
});

test("installer source contains no Git operations", (t) => {
  const bootstrap = path.join(REPO_ROOT, "installer", "bootstrap");
  if (!fs.existsSync(bootstrap)) {
    t.skip("installer/bootstrap not produced yet");
    return;
  }
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(bootstrap);
  if (files.length === 0) {
    t.skip("installer/bootstrap contains no files yet");
    return;
  }
  const gitOp = /\bgit\s+(init|add|commit|push|pull|clone|remote|fetch|checkout|merge|rebase|tag|reset|clean|worktree)\b/i;
  const gitSpawn = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]git["'`]/i;
  const gitArg = /["'`]git["'`]\s*,/;
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (gitOp.test(line) || gitSpawn.test(line) || gitArg.test(line)) {
        hits.push(`${path.relative(REPO_ROOT, f)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    "installer must not perform Git operations; found at " + hits.join(", "));
});
