# Troubleshooting

Symptom-first guide for the experimental bridge. Every check below is a command you can run
locally; none of them require a real model call unless the section says so.

Bridge errors are identified by a stable `code`, never by message text. The full table is in
[PROTOCOL.md](PROTOCOL.md#error-codes).

## Setup and startup

### `npm ci` fails, or the bridge behaves inconsistently after a dependency change

Use `npm ci`, not `npm install`. `npm ci` installs exactly the committed
`package-lock.json` tree; `npm install` may resolve a different tree and produce a state that
nobody else can reproduce. If the lockfile and `package.json` disagree, `npm ci` fails by
design — fix the lockfile rather than switching to `npm install`.

### Node version errors, or `node:sqlite` is reported as unavailable

The project requires **Node.js >= 22.13.0** so `node:sqlite` is usable without an experimental
CLI flag. Check with:

```bash
node -v
```

Older Node versions fail at bridge startup rather than degrading quietly. Note that Node still
prints `ExperimentalWarning: SQLite is an experimental feature` on stderr — that warning is
expected and is not an error.

### A client starts the server but every tool call fails to import a package

The launcher `scripts/native-bridge-mcp.mjs` composes **compiled** workspace packages. Run:

```bash
npm run build
```

Rebuild after every source change before reopening the bridge from a client. If the build
succeeds but workspace resolution still looks wrong, inspect the local links:

```bash
npm run links:check
```

Use `npm run links:fix` only when that check reports a broken link.

### `npm run <script>` exits non-zero immediately with `ERR_INVALID_ARG_TYPE` and no script output

Observed on Windows when npm runs from a shell that does not export `ComSpec`. npm cannot
locate a shell to spawn the script, so it fails before the script starts — the script itself is
fine. Run the command from PowerShell or `cmd.exe`, or export `ComSpec` in the calling shell.
Confirm by running the underlying tool directly (for example `npx vitest run`): if that passes,
the failure was in the npm wrapper, not in the repository.

## MCP discovery and identity

### `bridge` does not appear in `claude mcp list` or `codex mcp list`

1. Run the command from the intended **managed project root**. The Bridge checkout's configs
   use its source launcher; external-project configs use the linked `claude-codex-bridge`
   command. Neither registers a global MCP server with the clients.
2. Confirm the project configuration exists and is unmodified: `.mcp.json` for Claude Code,
   `.codex/config.toml` for Codex. For an external project, also run
   `claude-codex-bridge --help` to confirm npm's linked binary directory is on `PATH`.
3. Codex loads `.codex/config.toml` only after the project is trusted. Claude Code prompts for
   approval of a project-scoped MCP server; inside the client, `/mcp` shows current
   connections and lets you approve `bridge`.
4. Do not hand-edit client trust state to work around a missing prompt.

If a linked command starts but imports fail, rebuild the Bridge checkout with `npm run build`
and confirm the checkout still exists at the location registered by `npm link`. The external
project intentionally has no Bridge `scripts/` tree. Its `.bridge/bridge.db` should appear in
the external project, not in the Bridge installation directory.

A delegated Codex App Server runs in the same project but receives a thread-local override
that disables `mcp_servers.bridge`. Without that guard, the worker can try to start the
manager's required Bridge server recursively and fail before its first turn. This override
does not disable unrelated project MCP servers or the manager's native Bridge connection.

If Codex rejects a turn before emitting token usage (for example, because the authenticated
workspace has no credits), the Bridge reports that runtime failure immediately. It does not
wait for the task deadline or fabricate zero-token telemetry.

On Windows without a global Codex on `PATH`, use `.\node_modules\.bin\codex.cmd mcp list`.

### `bridge_server_info` returns the wrong caller

Stop. Caller identity is bound when the server process starts, from the `--caller` argument in
the project configuration. A wrong caller means the client launched the wrong configuration
(or a stale global one), not that a tool argument needs fixing. Tool payloads cannot override
the bound identity: a contradicting caller field is rejected, and an omitted one resolves to
the bound value.

### `bridge_delegate` is rejected server-side

The launcher was started with `--delegation deny`. Inspection and telemetry tools remain
available in that mode. Delegation policy, like caller identity, is fixed at process start.

## Ownership, scope, and leases

### `SCOPE_CONFLICT` on lease acquisition

Another agent holds a live, overlapping lease. Overlap detection is deliberately conservative:
when two glob patterns cannot be proven disjoint, the bridge reports a conflict rather than
risking a concurrent write. Options, in order of preference:

1. narrow your scope to provably disjoint paths;
2. wait for the lease to expire and recheck (leases are time-bounded, not permanent locks);
3. return a blocker.

Never steal or overlap another holder's lease. Use `bridge_check_scope` before acquiring to see
whether a scope is currently contested.

### `LEASE_INVALID` mid-task

The lease expired or was released, so the write must not proceed. Renewal of a **lapsed** lease
is refused on purpose — the scope may already belong to someone else. Acquire a fresh lease,
and if that fails with `SCOPE_CONFLICT`, treat it as the case above.

### `NOT_OWNER`

The bound caller does not own that task or hold that lease. Stop the mutation. Reading state is
fine; finishing, blocking, repairing, or releasing another agent's work is not. A parent
manager may read a child's result but cannot mutate the child. The sole narrow exception is
`bridge_resume_delegated_task`: a direct parent owner may request strict recovery when durable
lineage proves it created that child; the worker remains owner and execution agent.

### `DEPENDENCY_UNSATISFIED` when entering `WORKING`

At least one declared dependency is not `DONE`. The gate is checked at start, not at claim, so
an agent may claim and prepare while an upstream task finishes.

## Delegation and completion

### A `COMPLETE` deliverable is rejected

The verification gate requires at least one passing verification and no failing verification,
recorded in canonical `verification_results` with the exact command and real exit code. Prose
claims are not evidence. When you cannot run a check, submit `PARTIAL` with a blocker instead
of arguing the point — the rejected submission leaves the task exactly where it was, with no
event written.

### A child returns `PARTIAL` or `FAILED`

Consume its evidence and blocker at the parent. Do not upgrade it to success, and do not create
a sibling replacement task because a child was slow, blocked, quota-limited, or interrupted.
`PARTIAL` resolves the child task to `BLOCKED`, which is recoverable; `FAILED` means the
bounded objective failed.

### `TIMEOUT`

The adapter exceeded its deadline. Partial work may exist, so inspect the specific durable task
before acting, and use only the declared retry budget or strict recovery. Do not blindly
restart.

### A custom `bridge_delegate` caller disconnects after about 60 seconds

The MCP TypeScript SDK defaults a request to 60,000 ms when a custom client calls
`Client.callTool` without a `RequestOptions.timeout`. That client-side envelope is independent
of the delegated task's `deadline_ms`. It also bypasses Codex's project MCP setting
`tool_timeout_sec = 1800`, which applies only when Codex itself owns the native MCP call.

Use the native project MCP client, or set an explicit request timeout in a custom wrapper that
is at least as long as the bounded task deadline. A wrapper timeout does not prove that the
worker stopped: inspect the durable task, then use the appropriate strict recovery operation.
No asynchronous delegation redesign is implied by this client-side timeout.

### `RUNTIME_PROFILE_MISMATCH` on a Claude worker

Claude Code reported an actual model that contradicts the bridge-owned `opus` / `high` launch
profile. This is a deliberate failure, not a bug to route around: the profile is owned by the
bridge runtime and cannot be overridden from a delegation payload. Check which Claude Code
version and account the runtime is using. If the runtime reports no model at all, telemetry
keeps the actual model `null` rather than inventing one — that is expected, not a mismatch.

### A Claude worker stops before finishing the objective

It probably hit its turn ceiling. The default is a conservative 12 turns; `TaskSpec.max_turns`
accepts 1–64, and 32 is the recommended starting value for a bounded repository audit. Prefer
decomposing broad work into bounded subtasks over raising the ceiling toward the maximum.

### `QUOTA_EXHAUSTED` or an unavailable runtime

Report the runtime failure and preserve durable state. Do not bypass the bridge with a direct
CLI invocation, and do not create a replacement child task. Once quota returns, resume the same
eligible task.

## Recovery

### A task is stranded after a crash, timeout, or interrupted process

1. `bridge_recover` — expires dead leases and identifies stranded state.
2. `bridge_get_task` — inspect the specific task. Never print its raw execution handle.
3. Choose one operation, called **once** with the durable `task_id`:
   - existing owner: `bridge_resume_task`;
   - owner of the direct parent that delegated the child: `bridge_resume_delegated_task`.

Expect the same task and runtime session, a new adjacent attempt with `resumed_from_attempt`,
a fresh lease held under the child owner, separate worker telemetry, unchanged ownership, and
automatic lease release on every exit path. A manager does not need to open the worker's native
client; the bridge selects the child owner's adapter from durable state.

### Strict resume fails

A stale handle, a different returned handle, a failed resume, a timeout, or a runtime crash
does **not** authorize a fresh thread. Leave the same task blocked and report the exact reason.
Creating a replacement task or a new runtime thread is a contract violation, not a workaround.

See [recovery.md](recovery.md) for the full model.

## Telemetry

### Telemetry fields are `null`

Expected whenever the runtime did not report a value authoritatively. The bridge does not
estimate missing tokens, derive them from text length, or treat cumulative session usage as
per-attempt usage. Effort is not runtime-verified, so `requested_effort=high` is launch
configuration evidence only.

### An interactive manager session has no telemetry

Also expected. Records are written per task **attempt**; a manager driving the session
interactively may have no attempt of its own. Do not invent manager totals.

### Cached tokens appear to be missing from the total

Cached and cache-creation token counts are subdimensions of input usage. Adding them to input
again double-counts. See [telemetry.md](telemetry.md).

### Runtime-reported cost does not match a bill

Runtime-reported cost is not confirmed billing. When `billing_mode_known=false`, the value must
not be presented as an invoice.

## Repository state

### Where is the local state?

`.bridge/bridge.db`, with WAL/SHM sidecars. It is git-ignored, along with build output, logs,
client trust state, and dependencies. Never commit it, and never copy it into a backup
repository — it is shared coordination state readable by any supervisor.

### Documentation links or paths look wrong after an edit

Run the documentation gate:

```bash
node docs/tools/check-doc-links.mjs
```

It fails on broken relative links, missing heading anchors, and absolute filesystem paths in
the public documentation set.

## Still stuck

Open an issue with the failing command, its exit code, the stable error `code`, and the
redacted state you can share. Do not paste execution handles, prompts, transcripts, trust
state, or credentials — see [security.md](security.md).
