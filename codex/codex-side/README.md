# `@bridge/codex-side`

Production Codex/OpenAI adapter for the local Claude ↔ Codex coordination bridge.
It implements the shared `AgentAdapter` contract from `@bridge/protocol` and invokes
the official Codex CLI as a long-lived stdio MCP server.

## Boundaries

- This package owns only `codex/**`.
- It never writes SQLite or the shared event log; every state mutation remains a
  control-plane callback.
- Each invocation contains a bounded `TaskSpec` plus artifact references, never a full
  Claude or Codex chat history.
- The default policy is `approval-policy=never` with `sandbox=workspace-write`.
- Delegated shells inherit only Codex's core environment plus an explicit tool `PATH`;
  canonical `filters` form a small allowlist and Codex's automatic KEY/SECRET/TOKEN
  exclusions remain enabled. A bundled Codex runtime Node directory is detected and
  prepended when available.
- A returned Codex `threadId` is persisted immediately through
  `InvocationContext.saveExecutionHandle`. A later attempt receives it as
  `previous_execution_handle`. The adapter first uses `codex-reply`; because its session
  table is local to one MCP-server process, an exact `Session not found` after restart is
  continued with the official `codex exec resume` command and the same persisted UUID.
- Returned file paths are rejected unless they fall inside the task's leased scope.
- A malformed final response gets at most one `codex-reply` formatting repair. No
  open-ended agent conversation loop is possible.

## Runtime

The launcher comes from the official `@openai/codex` npm dependency. On Windows this
avoids relying on the Microsoft Store application's executable ACL. The MCP client
requires both official tools:

- `codex` starts a thread;
- `codex-reply` continues that same thread for a bounded output repair.

`bridge-codex-mcp --tool-path <value>` can replace the delegated tool path, while
`--no-tool-path` disables that PATH augmentation but keeps the core allowlist and automatic
secret exclusions.

## Commands

Run from the repository root:

```powershell
npm install
npx tsc --build codex/tsconfig.json
npm test --workspace @bridge/codex-side
npm run smoke --workspace @bridge/codex-side
npm run smoke:invoke --workspace @bridge/codex-side
npm run smoke:delegate --workspace @bridge/codex-side
```

The `smoke` command only performs MCP initialization and `tools/list`. `smoke:invoke`
runs one real, read-only environment-exclusion check through the official Codex adapter.
`smoke:delegate` starts the final neutral `@bridge/mcp-server-core` launcher over stdio,
delegates one real `node --version` task, and verifies both `DONE` and the persisted attempt
handle. Its disposable SQLite database lives under `codex/codex-side/` and is removed on
shutdown.

## Usage

```ts
import { CodexAdapter } from "@bridge/codex-side";

const adapter = new CodexAdapter({
  max_concurrency: 2,
  approval_policy: "never",
  sandbox: "workspace-write",
});

const health = await adapter.health();
// Register `adapter` with the control plane only when health.status is READY.
```

The control plane supplies `TaskInvocation` and `InvocationContext`, owns leases and
task transitions, persists status/events and attempt handles, and caches idempotent
outcomes. This adapter keeps only live MCP connections and a bounded in-process replay
cache.

## Expose the coordination API to Codex

The agent-neutral `@bridge/mcp-server-core` exposes the shared control plane as an MCP
stdio server. `@bridge/codex-side` has no runtime dependency on `@bridge/claude-side`. A
project-scoped Codex configuration template is available at
[`examples/codex-project-config.toml`](examples/codex-project-config.toml).

1. Build the repository so `codex/codex-side/dist/bridge-server.js` exists.
2. Copy the template table into the trusted target project's `.codex/config.toml`.
3. Replace both placeholders with absolute paths. On Windows, obtain the Node path with
   `(Get-Command node).Source`; TOML literal strings preserve backslashes.
4. Start Codex in that project and confirm `bridge_snapshot` is available before
   delegating work.

The server is launched with `--agent codex`, but ownership, leases, dependencies, and
task status still come from the shared control plane. This repository does not install
the entry automatically because project trust and MCP registration are user-level
choices.

Unlike the generic control-plane launcher, this Codex-owned entry point registers the
real `CodexAdapter`. Consequently, bounded `bridge_delegate` calls targeting `codex`
resolve to the official Codex MCP process instead of failing with a missing adapter.

## Current limitation

The official `codex` MCP tool exposes `threadId` only in its completed tool response. The
adapter persists it at that first observable moment, before parsing or publishing the
result, but a hard crash while the initial tool call itself is still in flight cannot leave
a thread pointer in the control plane. A replacement MCP process has no in-memory entry for
the old UUID, so the client first attempts `codex-reply` and then uses the official persisted
`codex exec resume` path only for the exact missing-session response. A truly expired stored
session may start one bounded replacement thread; ambiguous transport failures still fail
closed instead of risking duplicate writes.
