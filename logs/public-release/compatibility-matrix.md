# Compatibility Matrix — OpenCode Harness Public Release

Date: 2026-11-26. Evidence-based only. Sources: `logs/phase28-final-report.md`,
`logs/phase28-security-threat-model.md`, `logs/public-release/release-audit.md`,
`engine/package.json`, `docker-compose.yml`, `integrations/**`, and direct verification in this
session (`node --version` → `v26.5.0`; safety/path scans over 64 public files).
"Unverified" means no evidence was found in the supplied material — not that it is known to fail.

| Component / platform | Version or scope | Status | Evidence |
|---|---|---|---|
| Node.js | v26.5.0 | **Tested** | Direct `node --version` in this session; Phase 28 §6 lists v26.5.0 tested; engine is ESM (`"type": "module"`). |
| PostgreSQL | 17 with `pgvector` + `pg_trgm` | **Tested (local deployment)** | `docker-compose.yml` pins `pgvector/pgvector:pg17`; Phase 28 §D reports isolated restore with 89 tables and matching record counts. |
| OpenCode host | v2.4.1 | **Tested for registration/inspection; real agent run not re-demonstrated** | Phase 28 §G: flags (`--agent`, `--model`, `--session`, `--continue`, `--fork`, `--worktree`, `--format`, `--title`) still exposed; `integrations/opencode/README.md`. Phase 28 §J: real execution remains unverified pending authorization. |
| Docker Desktop | local compose setup | **Tested locally** | `docker-compose.yml` bind mounts and loopback ports; Phase 28 references the Docker VM disk location. Not tested on a clean machine. |
| Windows | original author's machine | **Tested** | All local paths and the `HARNESS_OPENCODE_BIN` Windows shim resolution in `opencodeRunAdapter.js`; `plugin/memory.ts` hard-coded paths (documented as non-portable). |
| Ollama / local embeddings | `nomic-embed-text`, 768 dims | **Configured, optional** | `docker-compose.yml` `memory-embed` service; README stack table. No claim of universal availability. |
| MCP generic clients | any stdio MCP client | **Experimental / unverified** | `integrations/generic-mcp/README.md` and `limitations.md`: tools are callable, but generic hosts do **not** inherit OpenCode's autonomous capabilities. No external client was exercised in this release prep. |
| Linux | — | **Unverified** | No Linux run, container-host test, or path test in the supplied evidence. |
| macOS | — | **Unverified** | No macOS run in the supplied evidence. |
| Fresh clean install | migrations 001–026 | **Untested end to end** | Installer dry-run only (`installation-test-report.md`); a clean migration path is documented but not executed here. |
| `pg` / `@modelcontextprotocol/sdk` / `zod` | `^8.13.0` / `^1.0.0` / `^3.24.0` | **Declared** | `engine/package.json`. Ranges are declarations, not independently verified installs. |
| Installer | Node ESM, dry-run default | **Dry-run tested** | `installer.test.js`: exit 0, empty target, idempotent plan (`capabilities=["memory"]`, 7 actions); no Git ops. |

## Notes for downstream users

- Supported ≠ freshly proven. "Supported" in `integrations/opencode/README.md` means the
  registration path was verified against source and the local deployment; it explicitly does not
  claim a fresh real agent run.
- Presence/wiring audits carry `verifiedBehavior: false` / `NO_RUNTIME_CLAIM`; they are not runtime
  proof.
- Do not generalize the Windows-only path assumptions to Linux/macOS without the documented edits.
- No performance target or benchmark is claimed in this matrix beyond the Phase 28 baseline notes.
