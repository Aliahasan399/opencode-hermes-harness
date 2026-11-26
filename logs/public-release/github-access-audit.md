# GitHub Access Audit — OpenCode Harness Publication Stage

**Role:** `github-access-auditor`
**Date:** 2026-11-26
**Scope:** READ-ONLY verification of GitHub authentication/authorization state for the public-release stage.
**Posture:** No repository was created, initialized, committed, or pushed. No token, password, auth header, or secret is reproduced here. `gh auth status` masks the token itself (`gho_****...`); only that masked form and the reported scopes are recorded below.

---

## 1. Authenticated GitHub account

Commands and observed outputs:

| Command | Observed output |
|---|---|
| `gh api user --jq .login` | `Aliahasan399` |
| `gh api user --jq .type` | `User` |
| `gh api user/orgs` | `[]` |
| `gh auth status` | `github.com` / `✓ Logged in to github.com account Aliahasan399 (keyring)` / `- Active account: true` / `- Git operations protocol: https` / `- Token: gho_************************************` / `- Token scopes: 'gist', 'read:org', 'repo', 'workflow'` |

**Findings (evidence):**
- Authenticated login: **`Aliahasan399`**
- Account type: **`User`** (personal account, not a `Organization` / bot)
- Organizations: **none** — `gh api user/orgs` returned an empty array `[]`. There is no organization context available; any publication would be under the personal account namespace.
- Auth source: GitHub CLI keyring; active account; Git protocol is `https`.

---

## 2. Token scopes (`gh auth status`)

Exact scopes reported by `gh auth status` (token value stays masked, never printed):

- `gist`
- `read:org`
- `repo`
- `workflow`

No other scopes were reported. The token value itself is **not** recorded, and no authorization header was inspected or emitted.

---

## 3. Permissions: evidence vs. assumption

The following distinguishes what the token *scope* implies from what is actually *proven*. A scope being present is evidence of capability grant, **not** proof that the action will succeed.

### Appears available (scope evidence present)
- **Repository creation (personal account):** The `repo` scope grants full control of private repositories, which includes repository creation. Evidence: `repo` scope present; account is a personal `User`.
- **Push to owned repositories:** The `repo` scope permits read/write push access to repositories owned by `Aliahasan399`. Evidence: `repo` scope present; Git protocol `https`.
- **Workflow file changes:** The `workflow` scope permits creating/updating GitHub Actions workflow files. Evidence: `workflow` scope present.

### NOT proven (do not assume)
- **Repository creation will actually succeed.** Scope presence does not prove the account is not blocked by an enterprise/organization policy, email-verification requirement, or creation-rate limit. Not tested (creating a repo is a write action, explicitly out of scope).
- **Push will actually succeed.** There is currently **no local Git repository and no remote** (see §6), so there is nothing to push and no target repository exists yet. Write access to any *specific* repository is unproven because no such repository has been verified to exist.
- **Workflows will run.** `workflow` scope permits editing workflow files but does not prove GitHub Actions is enabled for a future repository, nor that any runner is available.
- **Organization publishing.** `gh api user/orgs` is empty, so there is no proven organization in which to create a repository.
- **No permission was exercised.** Every action above remains a capability inference from scopes only; no write, create, or push was performed.

---

## 4. Rate-limit headroom (`gh api rate_limit`)

Observed REST resources (selected, exact values):

| Resource | limit | used | remaining | reset (epoch) | reset (UTC) |
|---|---|---|---|---|---|
| `core` | 5000 | 12 | 4988 | 1795671898 | 2026-11-26 05:44:58Z |
| `search` | 30 | 0 | 30 | 1795668457 | 2026-11-26 04:47:37Z |
| `graphql` | 5000 | 0 | 5000 | 1795671997 | 2026-11-26 05:46:37Z |

The top-level `rate` block mirrors `core` (`limit 5000`, `used 12`, `remaining 4988`).

**Finding (evidence):** Core REST headroom is ample — **4988 / 5000 requests remaining** at audit time. Search headroom is 30/30. This is more than sufficient for the handful of read-only checks and any subsequent publication commands. No rate-limit concern blocks the publication stage.

---

## 5. Repository name availability (read-only)

Both checks were read-only `gh api` GETs against the verified owner `Aliahasan399`. A `404` response means no repository with that name currently exists under that owner (i.e., the name is available). **Neither repository was created.**

| Command | Observed output | Interpretation |
|---|---|---|
| `gh api repos/Aliahasan399/opencode-hermes-harness` | `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}` + `gh: Not Found (HTTP 404)` (exit code 1) | Name `opencode-hermes-harness` is **available** under `Aliahasan399`. |
| `gh api repos/Aliahasan399/opencode-memory-harness` | `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}` + `gh: Not Found (HTTP 404)` (exit code 1) | Name `opencode-memory-harness` is **available** under `Aliahasan399`. |

Caveat: a name being available now is not a reservation; it can be taken before an authorized creation step. No creation was attempted.

---

## 6. Current local Git state

Working directory checked: `E:\New  Project` (the session working directory).

| Command | Observed output |
|---|---|
| `git rev-parse --is-inside-work-tree` | `fatal: not a git repository (or any of the parent directories): .git` (exit code 1) |
| `git remote -v` | `fatal: not a git repository (or any of the parent directories): .git` (exit code 1) |

**Finding (evidence):** The checked directory is **not** a Git work tree, and there are **no remotes**. This is expected per the task brief — no repository is initialized locally for this stage. (Note: the harness project files themselves live under `E:\OpenCodeData\memory`, not under `E:\New  Project`; this audit reports the state of the session working directory as instructed.)

---

## 7. Current license state

Project root for the harness: `E:\OpenCodeData\memory`.

| Check | Observed output |
|---|---|
| Root files matching `LICENSE*` | `LICENSE.decision.md` only |
| `LICENSE.decision.md` | exists, 2639 bytes |
| Actual `LICENSE` / `LICENSE.md` / `LICENSE.txt` file | **absent** at project root |

**Finding (evidence):** There is **no final LICENSE file** at the project root. A decision document, **`LICENSE.decision.md`**, exists and is the current record of license intent. No license has been applied to the release. (LICENSE files found elsewhere under `engine/node_modules/` are third-party dependency licenses, not the project's own license.)

---

## 8. Publication gate statement

**Publication is GATED on owner decisions and is NOT authorized by this audit.** Specifically, the following owner decisions are required before any write/publish action may proceed:

1. **Repository identity:** explicit decision on **owner** (only `Aliahasan399` is verified; no org exists) and **name** (choose between `opencode-hermes-harness`, `opencode-memory-harness`, or another name) for each repository.
2. **Visibility:** public vs. private must be explicitly chosen.
3. **License choice:** a final license must be selected and a real `LICENSE` file produced from `LICENSE.decision.md`.
4. **Explicit authorization:** a clear, human, owner-level authorization to create repositories, initialize/commit locally, add remotes, and push.

**Critical distinction:** `gh` authentication is **not** authorization. This audit proves the CLI is *authenticated* as `Aliahasan399` with scopes that *appear* to permit repo creation, push, and workflow edits. It does **not** grant permission to publish. No repository has been created, no code has been committed or pushed, and nothing has been published. All actions taken here were read-only verification commands only.

---

## Appendix — full command list executed (all read-only)

1. `gh api user --jq .login`
2. `gh api user --jq .type`
3. `gh api user/orgs`
4. `gh auth status`
5. `gh api rate_limit`
6. `gh api repos/Aliahasan399/opencode-hermes-harness`
7. `gh api repos/Aliahasan399/opencode-memory-harness`
8. `git rev-parse --is-inside-work-tree` and `git remote -v`
9. PowerShell `Get-ChildItem` file listings and `Test-Path` for license/target-directory checks
10. `[DateTimeOffset]::FromUnixTimeSeconds(...)` for reset-time conversion

No write, create, commit, push, remote-add, or repo-creation command was executed. No secret value is reproduced.
