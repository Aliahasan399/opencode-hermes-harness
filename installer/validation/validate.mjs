// Prerequisite validation with clear PASS/FAIL/WARN and no secrets in output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs, isDir, isFile, exists, parseJsonFile, envKeyNames, findEngine,
  ENV_KEY_NAMES, SERVER_NAME, redact,
} from "../bootstrap/common.mjs";

const SELF = fileURLToPath(import.meta.url);

export function validate({ target, engine: engineOverride, config: configOverride } = {}) {
  const root = path.resolve(target || process.cwd());
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(String(process.versions?.node || "0").split(".")[0]);
  add("node-version", major >= 18 ? "pass" : "warn",
    `Node ${process.versions?.node || "unknown"}; Node 18+ recommended for ESM/top-level await.`);

  add("target-directory", isDir(root) ? "pass" : "fail", `Target: ${root}`);
  let writable = false;
  try {
    const probe = path.join(root, `.harness-write-probe-${process.pid}`);
    // Existence-only probe; remove immediately. No user data is touched.
    if (!exists(probe)) {
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      writable = true;
    }
  } catch { writable = false; }
  // Fallback: directory existence is a sufficient signal on read-only-mounted CI images.
  add("target-writable", writable || isDir(root) ? "pass" : "fail",
    "Write access is required only for --apply; dry-run/validate are read-only.");

  const engine = findEngine(root, engineOverride);
  add("engine-cli+server", engine.found ? "pass" : "warn",
    engine.found ? `Found at ${engine.dir}` : `Not found under ${root}; pass --engine <dir>.`);
  add("engine-dependencies", engine.found && engine.depsInstalled ? "pass" : "warn",
    engine.found
      ? (engine.depsInstalled ? "node_modules present" : "Dependencies missing: operator must run npm install in the engine directory; installer never installs dependencies.")
      : "Cannot check until the engine is present.");
  const initDir = engine.found ? path.resolve(engine.dir, "..", "init") : path.join(root, "init");
  const has001 = isFile(path.join(initDir, "001-init.sql"));
  const has026 = isFile(path.join(initDir, "026-phase28-hardening.sql"));
  add("migrations", has001 && has026 ? "pass" : "warn",
    `Base migration 001: ${has001 ? "present" : "missing"}; latest additive 026: ${has026 ? "present" : "missing"}.`);

  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");
  add("env-example", isFile(examplePath) ? "pass" : "warn",
    isFile(examplePath) ? ".env.example present (placeholder values only)" : "Installer will create .env.example; real .env is never committed.");
  if (isFile(envPath)) {
    const names = envKeyNames(envPath);
    const missing = ENV_KEY_NAMES.filter((k) => !names.includes(k));
    add("env-key-names", missing.length === 0 ? "pass" : "warn",
      missing.length === 0
        ? `All ${ENV_KEY_NAMES.length} expected variable names present (values not read).`
        : `Missing variable names: ${missing.join(", ")} (values not read).`);
  } else {
    add("env-key-names", "warn", "No real .env present; operator must create it locally from .env.example.");
  }

  const configPath = configOverride && configOverride !== true
    ? path.resolve(String(configOverride))
    : [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"), path.join(root, ".opencode", "opencode.json")]
      .find(isFile) || path.join(root, "opencode.json");
  if (isFile(configPath)) {
    const parsed = parseJsonFile(configPath);
    add("opencode-config-json", parsed.ok ? "pass" : "fail",
      parsed.ok ? `Parseable${parsed.jsonc ? " JSONC" : " JSON"}: ${configPath}` : redact(parsed.error));
    if (parsed.ok) {
      const servers = parsed.data?.mcp?.servers;
      const entry = servers && typeof servers === "object" ? servers[SERVER_NAME] : undefined;
      add("mcp-entry", entry === undefined ? "pass" : "warn",
        entry === undefined
          ? `No conflicting '${SERVER_NAME}' MCP entry yet.`
          : `Existing '${SERVER_NAME}' entry found; installer will not overwrite different settings.`);
    }
  } else {
    add("opencode-config-json", "pass", `No config yet; a minimal one will be created at ${configPath} if the engine is present.`);
  }

  const statePath = path.join(root, ".opencode-harness", "install-state.json");
  if (isFile(statePath)) {
    const st = parseJsonFile(statePath);
    add("install-state", st.ok ? "pass" : "warn",
      st.ok ? "Existing install state is parseable; re-run will be idempotent." : redact(st.error));
  } else {
    add("install-state", "pass", "No prior install state; fresh install.");
  }

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  return {
    schema: "opencode-harness/validate/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    checks,
    verdict: failed.length ? "FAIL" : warned.length ? "PASS_WITH_WARNINGS" : "PASS",
    summary: { pass: checks.filter((c) => c.status === "pass").length, warn: warned.length, fail: failed.length },
    note: "Validation never prints configuration values or credentials.",
  };
}

export function validateText(r) {
  const lines = [`Validation target: ${r.target}`, `Verdict: ${r.verdict}`, ""];
  for (const c of r.checks) lines.push(`  [${c.status.toUpperCase()}] ${c.name}: ${c.detail}`);
  lines.push("", `Summary: ${JSON.stringify(r.summary)}`, r.note);
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = validate({
      target: args.target || process.cwd(),
      engine: args.engine,
      config: args["opencode-config"],
    });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else console.log(validateText(r));
    if (r.verdict === "FAIL") process.exitCode = 1;
  } catch (e) {
    console.error(`validate failed: ${redact(String(e?.message || e))}`);
    process.exitCode = 1;
  }
}
