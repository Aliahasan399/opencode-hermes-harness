# GitHub Publication Report — OpenCode Harness

Date: 2026-11-26 (updated after Stage A reinspection). Status: **NOT PUBLISHED — publication gated on owner decisions**. No Git repository was initialized, no remote was added, no commit was made, no push or pull request was created, and no repository URL was invented.

**Stage A verified:** GitHub account `Aliahasan399` (personal User; no organizations), token scopes
`gist`, `read:org`, `repo`, `workflow` (token value never printed), core rate-limit ~4988/5000.
Suggested names `opencode-hermes-harness` and `opencode-memory-harness` both return HTTP 404
(available under that owner) — **availability is not authorization**. Evidence:
`logs/public-release/github-access-audit.md`. Project root `E:\OpenCodeData\memory` is still not a
Git repository; `OPTIMIZATION_LEVEL=1` / `HARNESS_SEMANTIC_LLM=0` unchanged; no LICENSE file
(`LICENSE.decision.md` now covers MIT, Apache-2.0, GPL-3.0, AGPL-3.0, and private options).

## Verified publication state

| Item | State | Evidence |
|---|---|---|
| `E:\OpenCodeData\memory` is a Git repository | **No** | `git rev-parse` → fatal, exit 128 (release-audit §1); no `.git` directory present. |
| Remote / branch / repository URL | **None** | release-audit §1; no URL was provided by the owner. |
| `gh` CLI | 2.89.0, authenticated to github.com as `Aliahasan399` | release-audit §1. Authentication is **not** authorization to create a repository. |
| Repository created by `gh repo create` | **No** | No such command was run in this release-prep work. |
| Commit / push / PR | **None** | No Git operations were run by any release-prep test or script. |
| License file | **Missing by design** | No `LICENSE`/`LICENSE.md`; `LICENSE.decision.md` exists and requests the owner's decision. |
| Publication authorization | **Not given** | release-audit §1 and §11. |

## Exact missing decisions (all owner-owned)

1. **Repository owner and URL** — which account/org hosts the public repo, and its name.
2. **Visibility** — public vs private.
3. **License** — MIT, Apache-2.0, or private/proprietary. `LICENSE.decision.md` lays out the
   options; no choice was made on the owner's behalf. Source visibility is not reuse permission.
4. **Explicit publication authorization** — permission to run `git init`, create the remote,
   commit, and push. Authentication of the `gh` CLI does not grant this.
5. **Sanitization sign-off** — approval of the public file set, including the documented
   hard-coded Windows paths in `plugin/memory.ts` and the generic DB name `opencode_memory` used as
   a published fill-in default (see `security-review.md` residual risks).
6. **Release tagging / version strategy** — whether to tag an initial release and what version to
   use (the engine declares `0.1.0`; no tag decision was made).

## Deliberately not done

- No `git init`, `git add`, `git commit`, `git remote`, `git push`, `gh repo create`, or PR.
- No license chosen or generated.
- No URL, owner handle in a clone command, or release tag invented.
- No telemetry, analytics, or external publication side effect from the tests.

## Next action

Owner supplies decisions 1–6 above. Only after that may the parent session perform Git
initialization, commit, remote creation, and push. No further publication step should be taken
from this report alone.
