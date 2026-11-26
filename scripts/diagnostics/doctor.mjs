// Diagnostics for the installed harness. Presence is NOT presented as runtime proof.
// Runs the REAL engine CLI commands: `ops-health` and `pipeline-audit`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findEngine, runCommand, parseArgs, redact, isFile,
} from "../../installer/bootstrap/common.mjs";

const SELF = fileURLToPath(import.meta.url);

function parseLastJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

function summarizeCommand(result, { runtimeProof }) {
  const parsed = parseLastJson(result.stdout);
  const out = {
    command: result.command,
    exitCode: result.code,
    ok: result.ok,
    runtimeProof,
    parseableJson: !!parsed,
  };
  if (parsed) {
    const safe = {};
    for (const key of ["ok", "verdict", "status", "summary", "database", "pipeline_wiring", "sources", "counts", "checks", "passed", "failed", "warnings"]) {
      if (parsed[key] !== undefined) safe[key] = parsed[key];
    }
    out.result = JSON.parse(redact(JSON.stringify(safe)));
  }
  if (!result.ok) {
    out.error = redact((result.stderr || result.error || "command failed").trim().slice(0, 600));
    out.verdict = out.verdict || "unknown";
  }
  if (parsed?.verdict !== undefined) out.verdict = parsed.verdict;
  else if (out.ok && parsed) out.verdict = "reported";
  else out.verdict = out.verdict || "unknown";
  return out;
}

export function runDoctor({ target, engine: engineOverride, timeout = 90000 } = {}) {
  const root = path.resolve(target || process.cwd());
  const engine = findEngine(root, engineOverride);
  const report = {
    schema: "opencode-harness/doctor/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    engine: {
      found: engine.found,
      dir: engine.dir,
      cli: engine.cli,
      server: engine.server,
      depsInstalled: engine.depsInstalled,
    },
    commands: [],
    notes: [
      "CLI file presence is not runtime proof.",
      "pipeline-audit is wiring/presence-only (runtime_check:false) per the Phase 28 runbook.",
      "ops-health database component is a real runtime check; a healthy component does not certify the whole system.",
      "No secrets are printed: outputs are redacted and .env values are never read.",
    ],
  };

  if (!engine.found || !isFile(engine.cli)) {
    report.overall = "unknown";
    report.reason = "Engine CLI not found; no runtime command was executed.";
    return report;
  }

  for (const cmd of ["ops-health", "pipeline-audit"]) {
    const r = runCommand(process.execPath, [engine.cli, cmd], {
      cwd: engine.dir,
      timeout,
    });
    report.commands.push(summarizeCommand({ ...r, command: `node ${engine.cli} ${cmd}` }, {
      // ops-health includes a real DB check; pipeline-audit explicitly does not prove runtime.
      runtimeProof: cmd === "ops-health" && r.ok,
    }));
  }

  const health = report.commands[0];
  const wiring = report.commands[1];
  if (health?.verdict === "healthy") report.overall = "healthy";
  else if (health?.verdict === "degraded") report.overall = "degraded";
  else if (health?.verdict === "failed") report.overall = "failed";
  else report.overall = "unknown";
  report.wiringVerdict = wiring?.verdict || "unknown";
  return report;
}

export function doctorText(report) {
  const lines = [
    `Doctor target: ${report.target}`,
    `Engine: ${report.engine.found ? report.engine.dir : "not found"}`,
    `Engine dependencies installed: ${report.engine.found ? (report.engine.depsInstalled ? "yes" : "no") : "n/a"}`,
    `Overall: ${report.overall}${report.reason ? ` (${report.reason})` : ""}`,
    `Wiring (pipeline-audit): ${report.wiringVerdict || "not run"}`,
    "",
    "Commands:",
  ];
  for (const c of report.commands) {
    lines.push(`  $ ${c.command}`);
    lines.push(`    exit=${c.exitCode} verdict=${c.verdict} runtimeProof=${c.runtimeProof} parseableJson=${c.parseableJson}`);
    if (c.result) lines.push(`    result=${redact(JSON.stringify(c.result)).slice(0, 1200)}`);
    if (c.error) lines.push(`    error=${c.error}`);
  }
  lines.push("", "Notes:");
  report.notes.forEach((n) => lines.push(`  - ${n}`));
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const target = path.resolve(args.target || process.cwd());
    const report = runDoctor({ target, engine: args.engine, timeout: Number(args.timeout || 90000) });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(doctorText(report));
    if (report.overall === "failed") process.exitCode = 1;
  } catch (e) {
    console.error(`doctor failed: ${redact(String(e?.message || e))}`);
    process.exitCode = 1;
  }
}
