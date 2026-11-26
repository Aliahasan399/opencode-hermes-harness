// Discovery: report the environment without exposing credentials or file contents.
// All file inspection is existence-only except parsing JSON config into TOP-LEVEL KEYS.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  whichVersion, runCommand, isFile, isDir, exists, parseJsonFile, envKeyNames,
  configCandidates, findEngine, ENV_KEY_NAMES, SERVER_NAME, redact,
} from "./common.mjs";

function detectVersion(candidates) {
  for (const cmd of candidates) {
    const r = whichVersion(cmd, ["--version"]);
    if (r.available) return r;
  }
  return { available: false, version: null };
}

function detectViaWhere(cmd) {
  if (process.platform !== "win32") return null;
  const r = runCommand("where.exe", [cmd], { timeout: 15000 });
  return r.ok ? { available: true, version: "detected (version unavailable)" } : null;
}

function detectNpm() {
  // npm.cmd cannot always be spawned without a shell on Windows; run its CLI with node.
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (isFile(npmCli)) {
    const r = runCommand(process.execPath, [npmCli, "--version"], { timeout: 15000 });
    if (r.ok) return { available: true, version: (r.stdout || "").trim().split("\n")[0] };
  }
  const direct = detectVersion(process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"]);
  return direct.available ? direct : (detectViaWhere("npm") || { available: false, version: null });
}

function jsonShape(p) {
  if (!isFile(p)) return null;
  const parsed = parseJsonFile(p);
  if (!parsed.ok) return { exists: true, parseable: false, error: redact(parsed.error) };
  const data = parsed.data || {};
  const shape = {
    exists: true,
    parseable: true,
    jsonc: !!parsed.jsonc,
    topLevelKeys: Object.keys(data).sort(),
  };
  if (data.mcp && typeof data.mcp === "object" && !Array.isArray(data.mcp)) {
    const servers = data.mcp.servers;
    shape.mcpServers = servers && typeof servers === "object" && !Array.isArray(servers)
      ? Object.keys(servers).sort()
      : [];
    shape.harnessServerPresent = Array.isArray(shape.mcpServers) && shape.mcpServers.includes(SERVER_NAME);
  } else {
    shape.mcpServers = [];
    shape.harnessServerPresent = false;
  }
  if (Array.isArray(data.instructions)) {
    shape.instructionCount = data.instructions.length;
    shape.harnessInstructionsPresent = data.instructions.some((s) => String(s).includes("opencode-harness"));
  } else {
    shape.instructionCount = data.instructions === undefined ? 0 : null;
    shape.harnessInstructionsPresent = false;
  }
  if (Array.isArray(data.plugins)) shape.pluginCount = data.plugins.length;
  return shape;
}

function firstExisting(paths) {
  for (const p of paths) if (isFile(p)) return p;
  return null;
}

export function discover({ target, engine: engineOverride, config: configOverride } = {}) {
  const root = path.resolve(target || process.cwd());
  const home = os.homedir();
  const nodeVersion = process.versions?.node || null;

  const node = { available: true, version: nodeVersion, executable: process.execPath };
  // On Windows these CLIs are .cmd shims; spawnSync without a shell needs the exact name.
  const npm = detectNpm();
  const docker = detectVersion(["docker"]);
  const psql = detectVersion(["psql"]) || detectViaWhere("psql") || { available: false, version: null };
  const opencode = detectVersion(process.platform === "win32" ? ["opencode.cmd", "opencode"] : ["opencode"])
    || detectViaWhere("opencode") || { available: false, version: null };
  const compose = (() => {
    if (!docker.available) return { available: false };
    const r = runCommand("docker", ["compose", "version"], { timeout: 15000 });
    return { available: r.ok, output: r.ok ? redact((r.stdout || "").trim().slice(0, 120)) : null };
  })();

  const engine = findEngine(root, engineOverride);
  const configPaths = configCandidates(root, configOverride);
  // Project-local config ONLY by default: never modify the user's global config implicitly.
  const projectPaths = configPaths.filter((p) => !(p.startsWith(home + path.sep) && p.includes(`${path.sep}.config${path.sep}opencode${path.sep}`)));
  const chosenConfig = configOverride && configOverride !== true
    ? path.resolve(String(configOverride))
    : (firstExisting(projectPaths) || path.join(root, "opencode.json"));
  const shapeSource = configOverride && configOverride !== true ? chosenConfig : firstExisting(projectPaths);
  const config = {
    path: chosenConfig,
    candidates: configPaths.map((p) => ({ path: p, exists: isFile(p) })),
    shape: jsonShape(shapeSource),
  };

  const mcpCandidates = [
    path.join(root, ".mcp.json"),
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".config", "opencode", "opencode.json"),
  ];
  const mcp = {
    files: mcpCandidates.filter(isFile),
    note: "Only file presence and key names are reported; values and credentials are never read.",
  };

  const envPath = path.join(root, ".env");
  const envExamplePath = path.join(root, ".env.example");
  const envNames = envKeyNames(envPath);
  const envExampleNames = envKeyNames(envExamplePath);

  const projectMarkers = ["package.json", "AGENTS.md", "CLAUDE.md", ".git", "opencode.json", ".opencode"]
    .filter((name) => exists(path.join(root, name)));
  const instructionFiles = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "docs/AGENTS.md"]
    .filter((rel) => isFile(path.join(root, rel)));

  const statePath = path.join(root, ".opencode-harness", "install-state.json");
  const stateParsed = isFile(statePath) ? parseJsonFile(statePath) : null;
  const existingInstall = {
    stateFile: isFile(statePath),
    parseable: stateParsed ? stateParsed.ok : null,
    capabilities: stateParsed?.ok && Array.isArray(stateParsed.data?.capabilities) ? stateParsed.data.capabilities : [],
    installedAt: stateParsed?.ok ? stateParsed.data?.installedAt || null : null,
  };

  const dockerContainer = (() => {
    if (!docker.available) return { checked: false, running: null };
    const r = runCommand("docker", ["ps", "-a", "--filter", "name=opencode-memory-db", "--format", "{{.Names}}|{{.Status}}"], { timeout: 15000 });
    if (!r.ok) return { checked: true, running: null, error: redact(r.stderr || r.error || "docker ps failed") };
    const line = (r.stdout || "").trim();
    return { checked: true, running: line.length > 0, status: line.slice(0, 160) };
  })();

  return {
    schema: "opencode-harness/discovery/v1",
    generatedAt: new Date().toISOString(),
    target: root,
    os: { platform: process.platform, release: os.release(), arch: process.arch, home: home },
    runtime: { node, npm, docker, psql, opencode, dockerCompose: compose },
    engine,
    config,
    mcp,
    env: {
      present: isFile(envPath),
      examplePresent: isFile(envExamplePath),
      keyNamesFound: envNames,
      requiredKeyNames: ENV_KEY_NAMES,
      note: "Only variable NAMES are inspected. No value from .env is read, copied or printed.",
    },
    project: { root: root, markers: projectMarkers, instructionFiles },
    existingInstall,
    dockerContainer,
    warnings: buildWarnings({ node, npm, docker, engine, envNames }),
  };
}

function buildWarnings({ node, npm, docker, engine, envNames }) {
  const w = [];
  const major = Number(String(node.version || "0").split(".")[0]);
  if (!major || major < 18) w.push("Node.js 18+ is recommended; current version may not support the engine's ESM/top-level await.");
  if (!npm.available) w.push("npm not found; engine dependencies must be installed by the operator.");
  if (!docker.available) w.push("Docker not found; PostgreSQL/Ollama services must be provided externally.");
  if (!engine.found) w.push("Engine (src/cli.js + src/server.js) was not found; MCP registration will be a manual step.");
  else if (!engine.depsInstalled) w.push("Engine dependencies are not installed; run 'npm install' in the engine directory yourself (installer never installs dependencies).");
  if (envNames.length && envNames.length < ENV_KEY_NAMES.length) {
    w.push(`Existing .env has ${envNames.length}/${ENV_KEY_NAMES.length} expected variable names; review against .env.example.`);
  }
  return w;
}

export function discoveryText(d) {
  const lines = [
    `Discovery target: ${d.target}`,
    `OS: ${d.os.platform} ${d.os.release} (${d.os.arch})`,
    `Node: ${d.runtime.node.version || "unknown"} (${d.runtime.node.executable})`,
    `npm: ${d.runtime.npm.available ? d.runtime.npm.version : "not found"}`,
    `Docker: ${d.runtime.docker.available ? d.runtime.docker.version : "not found"}`,
    `docker compose: ${d.runtime.dockerCompose.available ? "available" : "not available"}`,
    `psql client: ${d.runtime.psql.available ? d.runtime.psql.version : "not found"}`,
    `OpenCode CLI: ${d.runtime.opencode.available ? d.runtime.opencode.version : "not found"}`,
    `Engine: ${d.engine.found ? d.engine.dir : "not found"}`,
    `Engine dependencies installed: ${d.engine.found ? (d.engine.depsInstalled ? "yes" : "no") : "n/a"}`,
    `OpenCode config: ${d.config.path}${d.config.shape?.exists ? "" : " (not created yet)"}`,
    `MCP config files detected: ${d.mcp.files.length}`,
    `.env present: ${d.env.present} (values never read); names found: ${d.env.keyNamesFound.length}/${d.env.requiredKeyNames.length}`,
    `Existing harness install: ${d.existingInstall.stateFile ? "yes" : "no"}`,
    `Project markers: ${d.project.markers.join(", ") || "none"}`,
    `Agent instruction files: ${d.project.instructionFiles.join(", ") || "none"}`,
    `Docker DB container: ${d.dockerContainer.checked ? (d.dockerContainer.running ? "present" : "not running/present") : "not checked"}`,
  ];
  if (d.warnings.length) lines.push("", "Warnings:", ...d.warnings.map((w) => `  - ${w}`));
  lines.push("", d.env.note);
  return lines.join("\n");
}
