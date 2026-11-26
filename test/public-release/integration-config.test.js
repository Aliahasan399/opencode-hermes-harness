// Integration/config contract tests. Read-only; no network, no Git, no writes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SERVER = path.join(REPO_ROOT, "engine", "src", "server.js");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function isPlaceholder(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (/^(changeme|change[-_]?me|your[-_]?password|your[-_]?key|placeholder|example|todo|dummy|fake|sample|none|null)$/i.test(v)) return true;
  if (/^[xX*]{3,}$/.test(v) || /^\.{3,}$/.test(v)) return true;
  if (/^<[^>]+>$/.test(v) || /^\$\{[^}]+\}$/.test(v) || /^%[^%]+%$/.test(v)) return true;
  if (/\.\.\./.test(v)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return true; // env var name, not a value
  return false;
}

test("JSON config templates parse as valid JSON", (t) => {
  const dirs = [
    path.join(REPO_ROOT, "integrations"),
    path.join(REPO_ROOT, "examples"),
  ].filter((d) => fs.existsSync(d));
  if (dirs.length === 0) {
    t.skip("integrations/ and examples/ not produced yet");
    return;
  }
  const files = dirs.flatMap((d) => walk(d)).filter((f) => /\.json($|\.)/i.test(path.basename(f)));
  const markdown = dirs.flatMap((d) => walk(d)).filter((f) => /\.md$/i.test(f));
  if (files.length === 0 && markdown.length === 0) {
    t.skip("no JSON config templates produced yet under integrations/ or examples/");
    return;
  }

  const failures = [];
  for (const f of files) {
    try {
      JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      failures.push(`${path.relative(REPO_ROOT, f)}: ${e.message}`);
    }
  }
  // Fenced ```json blocks in docs may be snippets (e.g. a bare `"scripts": { ... }`
  // property) rather than whole documents. Accept a snippet if wrapping it as an
  // object or array yields valid JSON; otherwise report the failure.
  const parseSnippet = (block) => {
    for (const candidate of [block, `{${block}}`, `[${block}]`]) {
      try {
        JSON.parse(candidate);
        return true;
      } catch { /* try next form */ }
    }
    return false;
  };
  for (const f of markdown) {
    const text = fs.readFileSync(f, "utf8");
    const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
    blocks.forEach((block, i) => {
      if (!parseSnippet(block)) {
        let reason = "invalid JSON";
        try { JSON.parse(block); } catch (e) { reason = e.message; }
        failures.push(`${path.relative(REPO_ROOT, f)} fenced json block #${i + 1}: ${reason}`);
      }
    });
  }
  assert.deepEqual(failures, [],
    "all JSON config templates and fenced JSON examples must parse; failures:\n" + failures.join("\n"));
  t.diagnostic(`checked ${files.length} JSON file(s) and ${markdown.length} markdown file(s)`);
});

test("server.js registers the documented MCP tool-name prefixes", (t) => {
  assert.ok(fs.existsSync(SERVER), "engine/src/server.js must exist");
  const text = fs.readFileSync(SERVER, "utf8");
  const names = [...text.matchAll(/\bs\.tool\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "server.js must register MCP tools via s.tool(name, ...)");

  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual([...new Set(duplicates)], [], "MCP tool names must be unique");

  const malformed = names.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n));
  assert.deepEqual(malformed, [], "MCP tool names must be snake_case");

  const prefixes = ["memory_", "learning_", "project_", "workflow_", "code_", "pm_", "adapt_", "agent_"];
  for (const prefix of prefixes) {
    assert.ok(names.some((n) => n.startsWith(prefix)),
      `server.js must register at least one ${prefix}* MCP tool`);
  }
  assert.ok(names.includes("ops_health"), "server.js must register the ops_health MCP tool");
  t.diagnostic(`${names.length} MCP tools registered; prefixes verified`);
});

test("example files contain no real credentials", (t) => {
  const candidates = [];
  const envExample = path.join(REPO_ROOT, ".env.example");
  if (fs.existsSync(envExample)) candidates.push(envExample);
  for (const d of ["integrations", "examples", "docs"]) {
    const dir = path.join(REPO_ROOT, d);
    if (fs.existsSync(dir)) candidates.push(...walk(dir));
  }
  if (candidates.length === 0) {
    t.skip("no example/config files produced yet (.env.example, integrations/, examples/, docs/)");
    return;
  }

  const patterns = [
    { name: "sk- API key", re: /\bsk-[A-Za-z0-9]{16,}\b/g },
    { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },
    { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  ];
  // Backticks delimit inline code in docs (e.g. `password=`/`token=` patterns);
  // they are prose markers, not credential values.
  const passwordRe = /\b(?:password|passwd|pwd)\s*[:=]\s*["'`]?([^"'`\s#]+)["'`]?/gi;

  const hits = [];
  for (const file of candidates) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(REPO_ROOT, file);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const p of patterns) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(line)) !== null) {
          if (p.name === "sk- API key" && isPlaceholder(m[0])) continue;
          if (p.name === "Bearer token" && isPlaceholder(m[0].replace(/^Bearer\s+/i, ""))) continue;
          hits.push(`${rel}:${i + 1} [${p.name}]`);
        }
      }
      passwordRe.lastIndex = 0;
      let pm;
      while ((pm = passwordRe.exec(line)) !== null) {
        if (isPlaceholder(pm[1]) || pm[1].length < 3) continue;
        hits.push(`${rel}:${i + 1} [non-placeholder password value]`);
      }
    });
  }
  assert.deepEqual(hits, [],
    "example files must not contain real credentials; findings:\n" + hits.join("\n"));
  t.diagnostic(`scanned ${candidates.length} example file(s) for credential patterns`);
});
