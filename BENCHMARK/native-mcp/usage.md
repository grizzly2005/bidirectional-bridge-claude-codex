# Native bridge usage

The repository exposes the same neutral coordination bridge to Codex and Claude Code. No
separate smoke script is needed during normal work.

## One-time project preparation

From the repository root:

```powershell
npm ci
npm run build
```

The build is required because `scripts/native-bridge-mcp.mjs` composes the compiled shared,
Claude, and Codex workspace packages. The project configuration contains no credentials and
does not add a server to either user's global MCP configuration.

Both native clients ask before trusting a project-scoped MCP server. Review the project file
and approve `bridge` once when the client asks; do not edit private trust state by hand.

Delegated Claude runs are non-interactive and the launcher uses Claude Code's explicit
`Read/Edit/Write/Bash` allowlist (not `bypassPermissions`) so bounded tasks can verify their
work. Delegate only trusted local tasks: the bridge lease defines the contractual write scope,
but Bash itself is not an operating-system sandbox.

## Codex

Open a terminal at the repository root and verify discovery:

```powershell
.\node_modules\.bin\codex.cmd mcp list
```

The output should contain an enabled server named `bridge`, using
`scripts/native-bridge-mcp.mjs` with `--caller codex --delegation allow`. Then launch Codex
normally from the same directory. Codex loads `.codex/config.toml` only when the project is
trusted.

Ask Codex to use the bridge for bounded coordination. For a fresh interactive session it
should:

1. call `bridge_server_info` and confirm `caller=codex`;
2. create and claim a root task with no parent (depth 0);
3. delegate a child using the returned root `run_id` and `task_id` (depth 1);
4. consume the structured result and exported telemetry;
5. record real verification evidence and submit the root deliverable.

## Claude Code

The Claude project configuration is stored in `.mcp.json`. Verify discovery from the repository
root:

```powershell
claude mcp list
```

The output should contain `bridge`, using the same launcher with
`--caller claude --delegation allow`. Launch `claude` normally and approve the project MCP
server if prompted. Inside Claude Code, `/mcp` shows the current MCP connections.

The configuration uses `${CLAUDE_PROJECT_DIR:-.}`. Claude Code sets `CLAUDE_PROJECT_DIR` in
the spawned server environment, while the `:-.` default also lets the project configuration
pass expansion before that subprocess exists.

The root-session workflow is symmetric: confirm `caller=claude`, create/claim a depth-0 root,
delegate a depth-1 child to Codex, consume the structured result and telemetry, then complete
the root with real evidence.

## Approval status on this checkout

Claude Code 2.1.226 refused to let a non-interactive delegated model write the sensitive
project MCP file even with its documented tool allowlist. The project file was therefore
created through Claude Code's official project-scoped CLI and explicitly approved by the
human user. The final native proof confirmed that `claude mcp list` reports `bridge` as
`Connected`.

On a fresh checkout, review `.mcp.json`, run Claude Code from the repository root, and approve
the project server when prompted:

```powershell
claude
```

If the prompt is not shown automatically, open `/mcp`, select `bridge`, and approve it. Do not
edit private trust state by hand.

On Windows PowerShell, prefer `claude mcp add ... -- node ...` over passing JSON in a shell
variable. Older native-argument quoting can strip the JSON quotes before Claude Code receives
them and produce `Invalid configuration: Invalid input`.

## Delegation policy

Normal project configuration starts the server with `delegation=allow`. A controlled solo
benchmark can start the same launcher with `--delegation deny`; `bridge_delegate` is then
rejected server-side while inspection and telemetry tools remain available.

Caller identity is also fixed when each server process starts. Omitted caller fields resolve
to that identity, matching fields are accepted, and contradictory caller fields are rejected.
