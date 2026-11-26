// Plan: describe every intended change without writing anything.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "./common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.resolve(HERE, "..", "templates");
export const TEMPLATE_ENV = path.join(TEMPLATES_DIR, "env.example.tmpl");
export const TEMPLATE_CONFIG = path.join(TEMPLATES_DIR, "opencode-config.tmpl.json");
export const TEMPLATE_AGENTS = path.join(TEMPLATES_DIR, "agent-instructions.tmpl.md");

/**
 * Build a structured, human-readable installation plan. Pure: never writes.
 */
export function buildPlan({ target, resolution, discovery, args, dryRun = true }) {
  const root = path.resolve(target);
  const caps = resolution.capabilities;
  const has = (c) => caps.includes(c);
  const changes = [];
  const manualSteps = [];
  const dbActions = [];
  const backups = [];

  const add = (a) => { changes.push({ id: a.id, ...a }); return a; };

  // 1. Environment example — create only; .env is never touched.
  add({
    id: "env-example",
    capability: "memory",
    kind: "file",
    path: path.join(root, ".env.example"),
    action: exists(path.join(root, ".env.example")) ? "no-op" : "create",
    details: "Copy of templates/env.example.tmpl: all variable NAMES with empty/placeholder values. Real .env is never read, copied or committed.",
    reversible: true,
  });

  // 2. OpenCode config: MCP server registration + dedicated instructions file.
  const configPath = discovery.config.path;
  if (discovery.engine.found) {
    add({
      id: "mcp-config",
      capability: "all",
      kind: "config",
      path: configPath,
      action: discovery.config.shape?.harnessServerPresent ? "no-op-or-merge" : "merge",
      details: `Merge ONLY mcp.servers['opencode-memory'] and one 'instructions' entry into ${configPath}. Existing keys, agents, permissions, plugins and unrelated instructions are preserved. A timestamped backup is created first.`,
      reversible: true,
    });
  } else {
    manualSteps.push(`Engine not found under ${root}; place the engine there (or pass --engine <dir>) and re-run, or register the MCP server manually using templates/opencode-config.tmpl.json.`);
    add({
      id: "mcp-config",
      capability: "all",
      kind: "config",
      path: configPath,
      action: "manual",
      details: "MCP registration deferred: engine/src/server.js is required before a working entry can be written.",
      reversible: true,
    });
  }

  add({
    id: "instructions-file",
    capability: "all",
    kind: "file",
    path: path.join(root, "docs", "opencode-harness", "AGENTS.md"),
    action: exists(path.join(root, "docs", "opencode-harness", "AGENTS.md")) ? "no-op" : "create",
    details: "Dedicated managed instructions file generated from templates/agent-instructions.tmpl.md. User AGENTS.md / CLAUDE.md files are never overwritten.",
    reversible: true,
  });

  if (args["inject-agents"]) {
    const agents = path.join(root, "AGENTS.md");
    add({
      id: "agents-block",
      capability: "all",
      kind: "config",
      path: agents,
      action: exists(agents) ? "append-managed-block" : "no-op",
      details: "Optional (--inject-agents): append a clearly delimited managed block at the END of AGENTS.md after a backup. Existing text is never edited.",
      reversible: true,
    });
  }

  // 3. Install state — enables idempotency and safe uninstall.
  add({
    id: "install-state",
    capability: "all",
    kind: "file",
    path: path.join(root, ".opencode-harness", "install-state.json"),
    action: exists(path.join(root, ".opencode-harness", "install-state.json")) ? "merge" : "create",
    details: "Record capabilities, created files, config mutations, backups and migration actions. Re-runs merge without duplicating entries.",
    reversible: true,
  });

  // 4. Setup report.
  add({
    id: "setup-report",
    capability: "all",
    kind: "report",
    path: path.join(root, "docs", "opencode-harness-setup-report.md"),
    action: "create-or-refresh",
    details: "Write a setup report listing exact changes, backups, diagnostics results and remaining manual steps.",
    reversible: true,
  });

  // 5. Backups before modification.
  if (exists(configPath)) backups.push(configPath);
  if (args["inject-agents"] && exists(path.join(root, "AGENTS.md"))) backups.push(path.join(root, "AGENTS.md"));

  // 6. DB: fresh install path is documented; nothing runs automatically.
  dbActions.push({
    id: "db-fresh",
    action: "manual",
    detail: `Fresh database: migrations init/001..026 are applied by PostgreSQL's docker-entrypoint when the data volume is empty. Operator command: docker compose -f "${path.join(root, "docker-compose.yml")}" --project-directory "${root}" up -d`,
  });
  dbActions.push({
    id: "db-backup",
    action: "manual",
    detail: "Before any additive migration, create and verify a dump: docker exec opencode-memory-db pg_dump -U <MEMORY_DB_USER> <MEMORY_DB_NAME> > <backup>.sql 2> <backup>.err (backup size > 0, .err empty). Never delete earlier backups.",
  });
  if (discovery.engine.migrations.length) {
    dbActions.push({
      id: "db-additive",
      action: "manual-by-default",
      detail: `For an existing DB, apply additive migrations one at a time to an ISOLATED database after backup: ${path.join(root, "init", "026-phase28-hardening.sql")} (CREATE INDEX IF NOT EXISTS only). Rollback: DROP INDEX IF EXISTS p28_*. Never restore over production.`,
    });
  }
  if (args["apply-db-migrations"]) {
    dbActions.push({
      id: "db-optional-automatic",
      action: "guarded-opt-in",
      detail: `Only with --db, --db-user, --migration, --db-backup and --confirm-db-name equal to --db. Production-looking names are refused. No password is read or printed.`,
    });
  }

  manualSteps.push(
    "Install engine dependencies yourself if missing: cd <engine> && npm install (the installer never installs dependencies).",
    "Create the real .env from .env.example and fill values locally; keep .env out of version control.",
    "Start services yourself: docker compose -f <target>/docker-compose.yml --project-directory <target> up -d.",
    "OpenCode plugin loader: plugin/memory.ts ships with absolute local paths. Adapt it to your install location manually (the installer never rewrites plugin source).",
    "After config changes, reload OpenCode (/reload) and confirm: opencode mcp list.",
  );

  if (has("memory")) manualSteps.push("Verify memory capability: node <engine>/src/cli.js context --prompt '...' --project '<project-id>'.");
  if (has("learning")) manualSteps.push("Verify learning capability: node <engine>/src/cli.js learning-status and node <engine>/src/cli.js automate --session <id> --project <dir> --stdin.");
  if (has("agents")) manualSteps.push("Verify agents capability (prepare-only): node <engine>/src/cli.js workflow-templates and agent-plan (real dispatch requires explicit single-use approval).");

  const summary = {
    creates: changes.filter((c) => c.action === "create" || c.action === "create-or-refresh").length,
    merges: changes.filter((c) => String(c.action).startsWith("merge") || c.action === "append-managed-block").length,
    backupsBeforeWrite: backups.length,
    manualSteps: manualSteps.length,
    automaticDbActions: args["apply-db-migrations"] ? 1 : 0,
  };

  return {
    schema: "opencode-harness/plan/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    dryRun,
    mode: resolution.mode,
    capabilities: caps,
    recommended: resolution.recommended,
    engine: discovery.engine.found ? discovery.engine.dir : null,
    changes,
    backups,
    dbActions,
    manualSteps,
    summary,
    safety: {
      readsEnvValues: false,
      runsGit: false,
      installsDependencies: false,
      overwritesUnrelatedInstructions: false,
      productionDatabaseByDefault: false,
      confirmed: false,
    },
  };
}

export function planText(plan) {
  const tag = plan.dryRun ? "[DRY RUN — NOTHING WRITTEN]" : "[APPLY MODE]";
  const lines = [
    `${tag} OpenCode Harness installation plan`,
    `Target: ${plan.target}`,
    `Mode: ${plan.mode} | Capabilities: ${plan.capabilities.join(", ") || "none (diagnostics/uninstall)"}`,
    `Recommended: ${plan.recommended}`,
    "",
    "Planned changes:",
  ];
  for (const c of plan.changes) {
    lines.push(`  - [${c.action}] ${c.kind} ${c.path}`);
    lines.push(`      ${c.details}`);
  }
  lines.push("", `Backups before modification: ${plan.backups.length}`);
  for (const b of plan.backups) lines.push(`  - ${b}`);
  lines.push("", "Database actions (manual by default):");
  for (const d of plan.dbActions) lines.push(`  - [${d.action}] ${d.detail}`);
  lines.push("", "Manual steps (operator):");
  plan.manualSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push("", `Summary: ${JSON.stringify(plan.summary)}`);
  lines.push("Safety: " + JSON.stringify(plan.safety));
  return lines.join("\n");
}
