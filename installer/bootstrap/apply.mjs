// Apply: writes ONLY after explicit --apply plus confirmation. Backs up before any
// modification of an existing file. Idempotent. No Git, no dependency installs, no .env reads.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_NAME, STATE_REL, INSTRUCTIONS_REL, ENV_EXAMPLE_REL, REPORT_REL,
  NEVER_MIGRATE_DB_NAMES, timestamp, sha256, isFile, exists, readText, writeIfAbsent,
  writeText, backupFile, readState, writeState, appendUnique, parseJsonFile, parseArgs,
  mergeOpencodeConfig, appendManagedBlock, managedAgentBlock, confirmAsync, redact, runCommand,
} from "./common.mjs";
import { buildPlan, TEMPLATE_ENV, TEMPLATE_CONFIG, TEMPLATE_AGENTS } from "./plan.mjs";
import { discover } from "./discover.mjs";
import { runDoctor } from "../../scripts/diagnostics/doctor.mjs";

function substituteJsonText(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const escaped = JSON.stringify(String(value)).slice(1, -1);
    out = out.split(`{{${key}}}`).join(escaped);
  }
  return out;
}

function renderSetupReport(result) {
  const s = result;
  const lines = [
    "# OpenCode Harness — setup report",
    "",
    `- Generated: ${s.generatedAt}`,
    `- Target: ${s.target}`,
    `- Mode: ${s.mode}`,
    `- Capabilities: ${s.capabilities.join(", ") || "none"}`,
    `- Outcome: ${s.ok ? "APPLIED" : "APPLIED WITH ERRORS"}`,
    `- Diagnostics: ${s.diagnostics?.overall || "not run"}`,
    "",
    "## Changes applied",
    "",
  ];
  for (const c of s.applied) lines.push(`- [${c.action}] ${c.path}${c.note ? ` — ${c.note}` : ""}`);
  if (!s.applied.length) lines.push("- (none)");
  lines.push("", "## Backups created before modification", "");
  for (const b of s.backups) lines.push(`- ${b.path || b.source} (${b.size ?? "skipped"} bytes)`);
  if (!s.backups.length) lines.push("- (none: no existing files were modified)");
  lines.push("", "## Database", "");
  for (const d of s.dbResults) lines.push(`- [${d.action}] ${d.detail}`);
  if (!s.dbResults.length) lines.push("- No database action executed (manual steps below).");
  lines.push("", "## Diagnostics", "");
  lines.push(s.diagnosticsText || "not run");
  lines.push("", "## Manual steps remaining", "");
  s.manualSteps.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
  if (s.errors.length) {
    lines.push("", "## Errors", "");
    s.errors.forEach((e) => lines.push(`- ${redact(e)}`));
  }
  lines.push("", "## Safety notes", "");
  lines.push("- Real .env values were never read, copied or printed; only variable names were inspected.");
  lines.push("- Git was not invoked; dependencies were not installed; production DB was never selected by default.");
  lines.push("- Uninstall with: node scripts/maintenance/uninstall.mjs --target <dir> --apply --yes");
  lines.push("");
  return lines.join("\n");
}

function guardedDbMigration(root, args, result) {
  if (!args["apply-db-migrations"]) {
    result.dbResults.push({ action: "manual", detail: "No automatic DB action. Fresh migrations run on empty volume via docker compose; additive migrations must be applied by the operator after backup." });
    return;
  }
  try {
    const db = String(args.db || "");
    const user = String(args["db-user"] || "");
    const migration = String(args.migration || "");
    const backup = String(args["db-backup"] || "");
    if (!db || !user || !migration || !backup) {
      throw new Error("--apply-db-migrations requires --db, --db-user, --migration and --db-backup");
    }
    if (NEVER_MIGRATE_DB_NAMES.includes(db.toLowerCase())) {
      throw new Error(`Refusing to migrate production-looking database '${redact(db)}' by default`);
    }
    if (args["confirm-db-name"] !== db) {
      throw new Error("--confirm-db-name must exactly repeat --db");
    }
    if (!isFile(backup) || fs.statSync(backup).size === 0) {
      throw new Error("--db-backup must point to an existing, non-empty SQL dump");
    }
    const migPath = path.resolve(root, migration);
    const initDir = path.resolve(root, "init");
    if (!migPath.startsWith(initDir + path.sep) || !migPath.endsWith(".sql") || !isFile(migPath)) {
      throw new Error("--migration must be an existing .sql file inside <target>/init");
    }
    const sql = fs.readFileSync(migPath, "utf8");
    if (!/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(sql) || /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/i.test(sql)) {
      throw new Error("Only strictly additive CREATE INDEX IF NOT EXISTS migrations are allowed in the automatic path");
    }
    result.dbResults.push({ action: "verified", detail: `Backup verified (${fs.statSync(backup).size} bytes); migration ${path.basename(migPath)} is strictly additive; target '${redact(db)}' is not a production default name.` });
    const r = runCommand("docker", ["exec", "-i", "opencode-memory-db", "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1"], {
      input: sql, timeout: 120000,
    });
    result.dbResults.push({
      action: r.ok ? "applied" : "failed",
      detail: r.ok
        ? `Applied migration to isolated database '${redact(db)}'. Re-apply is a no-op (IF NOT EXISTS).`
        : redact(r.stderr || r.error || "psql failed"),
    });
    if (!r.ok) result.errors.push("Additive migration failed; no automatic rollback was attempted.");
  } catch (e) {
    const message = redact(String(e?.message || e));
    result.dbResults.push({ action: "refused", detail: message });
    result.errors.push(message);
  }
}

export async function applyPlan({ target, resolution, discovery, args }) {
  const root = path.resolve(target);
  const stamp = timestamp();
  const plan = buildPlan({ target: root, resolution, discovery, args, dryRun: false });
  const result = {
    schema: "opencode-harness/apply/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    mode: resolution.mode,
    capabilities: resolution.capabilities,
    ok: true,
    applied: [],
    backups: [],
    dbResults: [],
    manualSteps: [...plan.manualSteps],
    errors: [],
    diagnostics: null,
    diagnosticsText: "",
    report: null,
  };

  const confirmed = await confirmAsync(args, `Apply OpenCode Harness to ${root}? Type 'yes': `);
  if (!confirmed) {
    throw new Error("Refusing to write: --apply requires --yes (or interactive 'yes' confirmation). No files were changed.");
  }

  const nodeBin = typeof args["node-bin"] === "string" ? args["node-bin"] : process.execPath;
  const reportDir = typeof args["report-dir"] === "string" && args["report-dir"]
    ? path.resolve(String(args["report-dir"])) : path.join(root, "docs");

  try {
    // ---- .env.example (create only, never .env) ----
    const envExample = path.join(root, ENV_EXAMPLE_REL);
    const envTemplate = readText(TEMPLATE_ENV);
    if (envTemplate === null) throw new Error(`Missing template: ${TEMPLATE_ENV}`);
    const envRes = writeIfAbsent(envExample, envTemplate);
    result.applied.push({ action: envRes.created ? "created" : "kept", path: envExample, note: "placeholders only; real .env untouched" });

    // ---- config merge (backup first) ----
    const configPath = discovery.config.path;
    if (discovery.engine.found) {
      const tplText = readText(TEMPLATE_CONFIG);
      if (tplText === null) throw new Error(`Missing template: ${TEMPLATE_CONFIG}`);
      const rendered = substituteJsonText(tplText, {
        NODE_BIN: nodeBin,
        SERVER_JS: discovery.engine.server,
        ENGINE_DIR: discovery.engine.dir,
        INSTRUCTIONS_REL: INSTRUCTIONS_REL.replace(/\\/g, "/"),
      });
      const tpl = JSON.parse(rendered);
      const entry = tpl.mcp?.servers?.[SERVER_NAME];
      if (!entry) throw new Error("Config template does not define the opencode-memory MCP server");
      let current = {};
      let conflicts = [];
      let notes = [];
      let changed = false;
      if (isFile(configPath)) {
        const parsed = parseJsonFile(configPath);
        if (!parsed.ok) throw new Error(`Existing config is not parseable: ${redact(parsed.error)}`);
        current = parsed.data || {};
        const b = backupFile(configPath, root, stamp);
        result.backups.push(b);
        if (!b.ok && !b.skipped) throw new Error(`Backup failed for ${configPath}`);
      }
      const merged = mergeOpencodeConfig(current, { serverEntry: entry, instructionsRel: INSTRUCTIONS_REL.replace(/\\/g, "/") });
      changed = merged.changed;
      conflicts = merged.conflicts;
      notes = merged.notes;
      if (changed) {
        writeText(configPath, merged.text);
        result.applied.push({ action: isFile(configPath) ? "merged" : "created", path: configPath, note: notes.join("; ") });
      } else {
        result.applied.push({ action: "no-op", path: configPath, note: notes.join("; ") || "already configured" });
      }
      for (const c of conflicts) result.manualSteps.push(`Config conflict at ${configPath}: ${c}`);
    } else {
      result.applied.push({ action: "manual", path: configPath, note: "engine not found; MCP not registered" });
    }

    // ---- dedicated instructions file (never overwrite user files) ----
    const instrPath = path.join(root, INSTRUCTIONS_REL);
    const instrTemplate = readText(TEMPLATE_AGENTS);
    if (instrTemplate === null) throw new Error(`Missing template: ${TEMPLATE_AGENTS}`);
    const instrRes = writeIfAbsent(instrPath, instrTemplate);
    result.applied.push({ action: instrRes.created ? "created" : "kept-user-edits", path: instrPath });

    // ---- optional managed block appended to existing AGENTS.md ----
    if (args["inject-agents"]) {
      const agentsPath = path.join(root, "AGENTS.md");
      if (isFile(agentsPath)) {
        const b = backupFile(agentsPath, root, stamp);
        result.backups.push(b);
        if (!b.ok && !b.skipped) throw new Error(`Backup failed for ${agentsPath}`);
        const before = readText(agentsPath) || "";
        const after = appendManagedBlock(before, managedAgentBlock());
        if (after.conflict) result.manualSteps.push(`${agentsPath}: ${after.conflict}`);
        else if (after.changed) {
          writeText(agentsPath, after.text);
          result.applied.push({ action: "appended-managed-block", path: agentsPath });
        } else result.applied.push({ action: "no-op", path: agentsPath, note: "managed block already present" });
      }
    }

    // ---- guarded optional DB migration ----
    guardedDbMigration(root, args, result);
    if (result.errors.length) result.ok = false;

    // ---- diagnostics (non-fatal) ----
    try {
      result.diagnostics = runDoctor({ target: root, engine: args.engine });
      result.diagnosticsText = result.diagnostics.overall || "unknown";
    } catch (e) {
      result.diagnosticsText = `diagnostics unavailable: ${redact(String(e?.message || e))}`;
    }

    // ---- state (idempotent merge) ----
    const previous = readState(root) || {};
    const state = {
      schema: "opencode-harness/state/v1",
      version: 1,
      installedAt: previous.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      target: root,
      capabilities: resolution.capabilities,
      mode: resolution.mode,
      engine: discovery.engine.found ? discovery.engine.dir : null,
      created: Array.isArray(previous.created) ? [...previous.created] : [],
      configChanges: Array.isArray(previous.configChanges) ? [...previous.configChanges] : [],
      backups: Array.isArray(previous.backups) ? [...previous.backups] : [],
      migrations: Array.isArray(previous.migrations) ? [...previous.migrations] : [],
    };
    for (const c of result.applied.filter((x) => x.action === "created")) {
      appendUnique(state.created, { path: c.path, hashAtInstall: isFile(c.path) ? sha256(readText(c.path)) : null });
    }
    for (const c of result.applied.filter((x) => ["merged", "created", "appended-managed-block"].includes(x.action))) {
      appendUnique(state.configChanges, { path: c.path, action: c.action, at: new Date().toISOString() });
    }
    for (const b of result.backups.filter((b) => b.ok && !b.skipped)) appendUnique(state.backups, b);
    for (const d of result.dbResults.filter((d) => d.action === "applied")) appendUnique(state.migrations, d);
    writeState(root, state);

    // ---- report ----
    result.report = path.join(reportDir, "opencode-harness-setup-report.md");
    writeText(result.report, renderSetupReport(result));
    result.applied.push({ action: "created-or-refreshed", path: result.report });
  } catch (e) {
    result.ok = false;
    result.errors.push(redact(String(e?.message || e)));
    result.report = path.join(reportDir, "opencode-harness-setup-report.md");
    try { writeText(result.report, renderSetupReport(result)); } catch { /* report is best-effort */ }
  }

  return result;
}

export function applyText(result) {
  const lines = [
    `Apply outcome: ${result.ok ? "APPLIED" : "APPLIED WITH ERRORS"}`,
    `Target: ${result.target}`,
    `Capabilities: ${result.capabilities.join(", ") || "none"}`,
    `Backups: ${result.backups.length}`,
    `Diagnostics: ${result.diagnostics?.overall || result.diagnosticsText || "not run"}`,
    "",
    "Applied:",
    ...result.applied.map((c) => `  - [${c.action}] ${c.path}${c.note ? ` — ${c.note}` : ""}`),
    "",
    "Database:",
    ...result.dbResults.map((d) => `  - [${d.action}] ${d.detail}`),
    "",
    `Report: ${result.report}`,
  ];
  if (result.errors.length) lines.push("", "Errors:", ...result.errors.map((e) => `  - ${e}`));
  lines.push("", "Manual steps:");
  result.manualSteps.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  // Standalone use: recompute discovery/plan from --target.
  try {
    const args = parseArgs(process.argv.slice(2));
    const target = path.resolve(args.target || process.cwd());
    const { resolveMode } = await import("./common.mjs");
    const resolution = resolveMode(args);
    const discovery = discover({ target, engine: args.engine, config: args["opencode-config"] });
    const result = await applyPlan({ target, resolution, discovery, args });
    console.log(applyText(result));
    if (!result.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`apply failed: ${redact(String(e?.message || e))}`);
    process.exitCode = 1;
  }
}
