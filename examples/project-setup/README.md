# Project setup example (all three capabilities)

Recommended mode: **all three** (memory + learning + agents). Smaller modes are
available with `--capabilities memory` or `--capabilities memory,learning`.

## 1. Preview — writes nothing

```sh
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --dry-run
```

The plan lists every file/config change, backups, DB actions and manual steps.

## 2. Apply to an isolated project first

```sh
node installer/bootstrap/install.mjs --target <project-dir> --capabilities memory,learning,agents --apply --yes
```

The installer:
- copies `.env.example` (placeholders only) if missing; never touches a real `.env`;
- registers `mcp.servers["opencode-memory"]` and one `instructions` entry after a
  timestamped backup;
- creates `docs/opencode-harness/AGENTS.md` from a template;
- writes `.opencode-harness/install-state.json` and a setup report under `docs/`;
- runs `ops-health` and `pipeline-audit` diagnostics;
- is idempotent on re-run (no duplicate entries or migrations).

## 3. Operator-only steps (not automated)

1. Copy `.env.example` to `.env` and fill values locally; keep it out of version control.
2. Install engine dependencies yourself if missing: `cd <engine> && npm install`.
   The installer never installs dependencies.
3. Start services yourself:
   `docker compose -f <release>/docker-compose.yml --project-directory <release> up -d`.
   On a fresh volume, migrations `init/001..026` are applied by PostgreSQL's entrypoint.
   For an existing DB, back up first, then apply additive migrations to an isolated DB only.
4. Adapt `plugin/memory.ts` to your install location (it ships with absolute local paths).
5. Reload OpenCode (`/reload`) and check `opencode mcp list`.

## 4. Verify and disable

```sh
node installer/bootstrap/install.mjs --target <project-dir> --validate
node installer/bootstrap/install.mjs --target <project-dir> --doctor
node installer/bootstrap/install.mjs --target <project-dir> --uninstall --dry-run
node installer/bootstrap/install.mjs --target <project-dir> --uninstall --apply --yes
```

Uninstall removes only entries created by the installer (after backups). It never
deletes `.env`, database data, backups, logs or user-authored instructions.
