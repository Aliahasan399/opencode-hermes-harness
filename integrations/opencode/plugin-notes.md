# Plugin notes — `plugin/memory.ts`

This file is the **only** component that wires automatic memory behaviour into an OpenCode
session. It is an OpenCode V2 plugin, exported as:

```ts
export default { id: "opencode-memory", setup: setupV2 };
```

It is installed by copying it into OpenCode's global plugin directory:
`~/.config/opencode/plugins/memory.ts`. OpenCode also auto-discovers direct `.ts`/`.js` files under
a project's `.opencode/plugins/`, but a file beside a project-root `opencode.json` is not
discovered automatically. Source: <https://opencode.ai/docs/plugins/>.

## What it does (real hooks, not a runtime)

On `setup`, it reads the working directory from `ctx.location`, starts an idempotent
`automation-recover-if-due`, and registers:

| Hook | Engine CLI call | Purpose |
|---|---|---|
| `session.hook("prompt")` | `context-package` | Retrieve compact, relevant memories; cache for this session. |
| `session.hook("context")` | (local cache) | Push a `Relevant memory (retrieved automatically)` text block into `e.system`. |
| `tool.hook("execute.before")` | (local timer) | Record tool start time. |
| `tool.hook("execute.after")` | `observe`, `transcript-append` | Record measured duration/exit/error/retry; append a durable transcript line. |
| `ctx.event.subscribe` (`session.idle`, `session.execution.*`, `session.step.ended`) | `automate` | Debounced, settling-loop turn-end processing of the accumulated transcript. |
| teardown (returned cleanup fn) | `finalize-session.js` (synchronous) | Final boundary so the complete transcript is processed before the OpenCode process exits. |

All calls are wrapped so failures are logged to stderr and swallowed — the plugin **fails open**
and never blocks the host. The durable transcript is append-only and serialized per session;
turn-end automation dedupes by `(session, event/sequence)`.

## Hard-coded paths — must be edited for your checkout

The shipped source starts with these constants from the original author's machine:

```ts
const CLI = "E:\\OpenCodeData\\memory\\engine\\src\\cli.js";
const FINALIZER = "E:\\OpenCodeData\\memory\\engine\\src\\finalize-session.js";
const LOG_DIR = "E:\\OpenCodeData\\memory\\logs\\sessions";
```

Replace all three with absolute paths for your install before loading the plugin. These are
non-portable and are not secrets.

## Node binary resolution

OpenCode runs plugins from its native CLI process where `process.execPath` is `opencode.exe`, not
`node`. Spawning that binary with the CLI path would print help instead of running the command, so
the plugin resolves a real Node binary:

- `HARNESS_NODE_BIN` override wins if set.
- Otherwise, if `process.execPath` looks like `opencode`, it uses `node`; else it uses the current
  executable.

Set `HARNESS_NODE_BIN` explicitly if auto-resolution fails on your platform.

## Timing / budget knobs (environment)

- `HARNESS_CONTEXT_BUDGET` (default `2500`) — context-package budget on prompt.
- `HARNESS_END_COALESCE_MS` (default `4000`, min `1000`) — debounce for turn-end.
- `HARNESS_SETTLE_MS` (default `3000`, min `1000`) — settling-loop interval.
- `HARNESS_MAX_SETTLE_CHECKS` (default `20`, min `1`) — bounded re-checks.
- `HARNESS_APPEND_WAIT_MS` (default `20000`, min `10000`) — flush timeout for durable appends.

## Boundaries

- This plugin is **hook plumbing**. It does not spawn an autonomous agent loop and does not grant
  workflow approvals. Real agent execution remains an OpenCode host capability subject to explicit
  Phase 24 approval.
- It records only measurements the harness actually exposes (duration when available, exit code
  when exposed, error flag, retry signature). It does not fabricate tool telemetry.
- Retrieved memory and historical sessions are treated as untrusted data, never instructions.
- Reload the plugin/engine with `/reload` in OpenCode after any change.
