// Safe disable / uninstall. Restores OUR config changes, never deletes user data.
// Database schema, Docker volumes, backups, logs and .env are intentionally left alone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_NAME, STATE_REL, INSTRUCTIONS_REL, ENV_EXAMPLE_REL, REPORT_REL, UNINSTALL_REPORT_REL,
  timestamp, sha256, isFile, readText, writeText, backupFile, readState, parseJsonFile,
  parseArgs, removeManagedBlock, confirmAsync, redact,
} from "../../installer/bootstrap/common.mjs";

const SELF = fileURLToPath(import.meta.url);

function manualSteps(root) {
  return [
    `Reload OpenCode (/reload) and verify with: opencode mcp list — '${SERVER_NAME}' should no longer be listed.`,
    "Docker services are left running: stop them yourself with docker compose -f <target>/docker-compose.yml --project-directory <target> down (keep data volumes unless you intend to lose memory data).",
    `No database rollback was performed. Additive indexes from init/026 are harmless; remove manually only if required: DROP INDEX IF EXISTS p28_* on an isolated database. Never restore over production.`,
    "The real .env, backups/, data/ and logs/ were not touched. Delete them only if you explicitly intend to lose data.",
    `The OpenCode plugin loader (e.g. ~/.config/opencode/plugins/memory.ts) was not modified or deleted; remove it manually if you installed one.`,
    `Setup reports remain at ${path.join(root, REPORT_REL)} and ${path.join(root, UNINSTALL_REPORT_REL)} for audit.`,
  ];
}

export async function runUninstall({ target, args }) {
  const root = path.resolve(target || process.cwd());
  const state = readState(root);
  const result = {
    schema: "opencode-harness/uninstall/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    ok: true,
    found: !!state,
    applied: [],
    backups: [],
    errors: [],
    manualSteps: manualSteps(root),
    report: null,
  };

  if (!state) {
    result.applied.push({ action: "no-op", path: path.join(root, STATE_REL), note: "No install state found; nothing was changed." });
    result.report = path.join(root, UNINSTALL_REPORT_REL);
    writeText(result.report, renderUninstallReport(result));
    return result;
  }

  const confirmed = await confirmAsync(args, `Disable OpenCode Harness in ${root}? Type 'yes': `);
  if (!confirmed) throw new Error("Refusing to uninstall: --apply requires --yes (or interactive 'yes'). No files were changed.");
  const stamp = timestamp();

  try {
    // Surgical config removal: preserves any later user edits better than whole-file restore.
    const configPath = path.join(root, "opencode.json");
    let cfg = null;
    for (const rel of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
      const p = path.join(root, rel);
      if (isFile(p)) { cfg = p; break; }
    }
    if (cfg) {
      const b = backupFile(cfg, root, stamp);
      result.backups.push(b);
      const parsed = parseJsonFile(cfg);
      if (!parsed.ok) {
        result.errors.push(`Could not parse ${cfg}; left untouched. Restore from ${b.path || "backup"} manually.`);
      } else {
        const data = parsed.data && typeof parsed.data === "object" ? { ...parsed.data } : {};
        let changed = false;
        if (data.mcp && typeof data.mcp === "object" && data.mcp.servers && data.mcp.servers[SERVER_NAME] !== undefined) {
          const servers = { ...data.mcp.servers };
          delete servers[SERVER_NAME];
          data.mcp = { ...data.mcp, servers };
          changed = true;
          result.applied.push({ action: "removed-mcp-entry", path: cfg });
        }
        if (Array.isArray(data.instructions)) {
          const filtered = data.instructions.filter((s) => !String(s).includes("opencode-harness"));
          if (filtered.length !== data.instructions.length) {
            data.instructions = filtered;
            changed = true;
            result.applied.push({ action: "removed-instructions-entry", path: cfg });
          }
        }
        if (changed) writeText(cfg, JSON.stringify(data, null, 2) + "\n");
        else result.applied.push({ action: "no-op", path: cfg, note: "no harness entries present" });
      }
    }

    // Remove the managed block from AGENTS.md only (append-only install left all other text intact).
    const agents = path.join(root, "AGENTS.md");
    if (isFile(agents)) {
      const before = readText(agents) || "";
      if (before.includes("<!-- BEGIN opencode-harness managed")) {
        const b = backupFile(agents, root, stamp);
        result.backups.push(b);
        const after = removeManagedBlock(before);
        if (after.changed) {
          writeText(agents, after.text);
          result.applied.push({ action: "removed-managed-block", path: agents });
        }
      }
    }

    // Remove only files we created AND that still match their install-time hash.
    const created = Array.isArray(state.created) ? state.created : [];
    for (const item of created) {
      const p = typeof item === "string" ? item : item?.path;
      if (!p) continue;
      const abs = path.resolve(root, p);
      if (!isFile(abs)) continue;
      const expected = typeof item === "string" ? null : item.hashAtInstall;
      const currentHash = sha256(readText(abs));
      if (expected && currentHash !== expected) {
        result.applied.push({ action: "kept-modified-file", path: abs, note: "user edits detected; left in place" });
      } else {
        fs.unlinkSync(abs);
        result.applied.push({ action: "removed-created-file", path: abs });
      }
    }

    // State file is ours; delete it last.
    const statePath = path.join(root, STATE_REL);
    if (isFile(statePath)) {
      fs.unlinkSync(statePath);
      result.applied.push({ action: "removed-state", path: statePath });
    }

    result.report = path.join(root, UNINSTALL_REPORT_REL);
    writeText(result.report, renderUninstallReport(result));
  } catch (e) {
    result.ok = false;
    result.errors.push(redact(String(e?.message || e)));
    result.report = path.join(root, UNINSTALL_REPORT_REL);
    try { writeText(result.report, renderUninstallReport(result)); } catch { /* best effort */ }
  }
  return result;
}

function renderUninstallReport(r) {
  const lines = [
    "# OpenCode Harness — uninstall / disable report",
    "",
    `- Generated: ${r.generatedAt}`,
    `- Target: ${r.target}`,
    `- Outcome: ${r.ok ? "DISABLED" : "DISABLED WITH ERRORS"}`,
    "",
    "## Changes",
    "",
    ...r.applied.map((a) => `- [${a.action}] ${a.path}${a.note ? ` — ${a.note}` : ""}`),
    "",
    "## Backups created before modification",
    "",
    ...r.backups.map((b) => `- ${b.path || b.source}`),
    "",
    "## NOT removed (by design)",
    "",
    "- Real .env and any credentials you placed there.",
    "- PostgreSQL/Ollama data volumes, database schemas, SQL backups and session logs.",
    "- User-authored AGENTS.md / CLAUDE.md content and any unrelated config keys.",
    "- Installed OpenCode plugin files (manual step below).",
    "",
    "## Manual steps",
    "",
    ...r.manualSteps.map((s, i) => `${i + 1}. ${s}`),
    "",
  ];
  if (r.errors.length) lines.push("## Errors", "", ...r.errors.map((e) => `- ${e}`), "");
  return lines.join("\n");
}

export function uninstallText(r) {
  const lines = [
    `Uninstall outcome: ${r.ok ? "DISABLED" : "DISABLED WITH ERRORS"}`,
    `Target: ${r.target}`,
    ...r.applied.map((a) => `  - [${a.action}] ${a.path}`),
    `Report: ${r.report}`,
    "",
    "Manual steps:",
    ...r.manualSteps.map((s, i) => `  ${i + 1}. ${s}`),
  ];
  if (r.errors.length) lines.push("", "Errors:", ...r.errors.map((e) => `  - ${e}`));
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = await runUninstall({ target: args.target || process.cwd(), args });
    console.log(uninstallText(r));
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`uninstall failed: ${redact(String(e?.message || e))}`);
    process.exitCode = 1;
  }
}
