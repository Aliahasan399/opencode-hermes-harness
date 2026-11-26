#!/usr/bin/env node
// OpenCode Harness installer entrypoint (Node ESM).
// Modes: full, memory-only, memory+learning, all three, diagnostics-only, uninstall/disable.
// Dry-run is the default; --apply requires --apply AND explicit confirmation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs, resolveMode, helpText, redact, isFile, readState, exists,
} from "./common.mjs";
import { discover, discoveryText } from "./discover.mjs";
import { buildPlan, planText } from "./plan.mjs";
import { applyPlan, applyText } from "./apply.mjs";
import { validate, validateText } from "../validation/validate.mjs";
import { runDoctor, doctorText } from "../../scripts/diagnostics/doctor.mjs";
import { runUninstall, uninstallText } from "../../scripts/maintenance/uninstall.mjs";

const SELF = fileURLToPath(import.meta.url);

function uninstallDryRun(root) {
  const state = readState(root);
  const lines = [
    "[DRY RUN — NOTHING WRITTEN] OpenCode Harness uninstall/disable",
    `Target: ${root}`,
    `Install state found: ${state ? "yes" : "no"}`,
  ];
  if (state) {
    lines.push(`Capabilities recorded: ${(state.capabilities || []).join(", ") || "none"}`);
    const created = Array.isArray(state.created) ? state.created : [];
    for (const c of created) {
      const p = typeof c === "string" ? c : c?.path;
      if (p) lines.push(`  would remove if unchanged: ${p}`);
    }
    lines.push("  would remove our MCP server entry and instructions entry from the OpenCode config (after backup)");
    lines.push("  would remove the managed block from AGENTS.md if present (after backup)");
    lines.push("  would remove .opencode-harness/install-state.json last");
  } else {
    lines.push("  nothing to do; no install state found");
  }
  lines.push("", "Would NOT remove: real .env, DB/volumes, backups, logs, user instructions, plugin files.");
  lines.push("Use --uninstall --apply --yes to actually disable.");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(helpText());
    return;
  }
  const resolution = resolveMode(args);
  const needsTarget = resolution.mode !== "validate" && resolution.mode !== "diagnostics" || !!args.target;
  const target = path.resolve(args.target || process.cwd());
  if (!needsTarget && !args.target) throw new Error("--target is required for install/uninstall modes");
  if (args.target === true) throw new Error("--target requires a directory path");

  // Diagnostics-only.
  if (resolution.mode === "diagnostics") {
    const report = runDoctor({ target, engine: args.engine, timeout: Number(args.timeout || 90000) });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(doctorText(report));
    return;
  }

  // Prerequisite validation only.
  if (resolution.mode === "validate") {
    const r = validate({ target, engine: args.engine, config: args["opencode-config"] });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else console.log(validateText(r));
    if (r.verdict === "FAIL") process.exitCode = 1;
    return;
  }

  // Safe disable / uninstall.
  if (resolution.mode === "uninstall") {
    if (!args.apply) {
      console.log(uninstallDryRun(target));
      return;
    }
    const r = await runUninstall({ target, args });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else console.log(uninstallText(r));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  // Install / apply. Dry-run by default.
  const discovery = discover({ target, engine: args.engine, config: args["opencode-config"] });
  const dryRun = !args.apply;
  const plan = buildPlan({ target, resolution, discovery, args, dryRun });

  if (dryRun) {
    if (args.json) console.log(JSON.stringify({ discovery, plan }, null, 2));
    else {
      console.log(discoveryText(discovery));
      console.log("");
      console.log(planText(plan));
      console.log("");
      console.log("DRY RUN: no files were written. Use --apply --yes to apply.");
    }
    return;
  }

  const result = await applyPlan({ target, resolution, discovery, args });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(applyText(result));
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`installer error: ${redact(String(e?.message || e))}`);
    process.exitCode = 1;
  });
}

export { main };
