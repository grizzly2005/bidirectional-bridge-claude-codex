# Installation

This project is experimental and pre-1.0. Installation steps, configuration files, and
launcher arguments may change between revisions; see [release-policy.md](release-policy.md).

## Requirements

- Node.js **>= 22.13.0** (`node:sqlite` is used without an experimental CLI flag); the same
  floor is declared in the `engines` field of `package.json`
- npm
- Git
- Claude Code and Codex installed and authenticated when real delegation is required
- A trusted local checkout; this project is not intended for untrusted tasks or repositories

## Install and verify

From the repository root, the deterministic workflow is:

```bash
npm ci          # deterministic install from the committed package-lock.json
npm run build   # tsc --build
npm test        # vitest run
```

Use `npm ci` rather than `npm install`: it installs exactly the committed lockfile tree, which
is what makes a local result reproducible by someone else. Additional optional checks:

```bash
npm ls
npm run typecheck
```

The native launcher loads compiled workspace packages, so run `npm run build` before opening
the bridge through either client. If workspace package links are stale, inspect them with:

```bash
npm run links:check
```

Use `npm run links:fix` only when that check reports a broken local workspace link.

## Project-scoped MCP configuration

The repository contains two portable, credential-free configuration files:

- `.mcp.json` for Claude Code, bound to `caller=claude`;
- `.codex/config.toml` for Codex, bound to `caller=codex`.

Both launch `scripts/native-bridge-mcp.mjs` over stdio with delegation enabled. They use
repository-relative paths and do not install a global MCP server.

The repository also carries the same `using-bridge` skill in the native project locations:

- `.claude/skills/using-bridge/` for Claude Code;
- `.codex/skills/using-bridge/` for Codex.

These directories contain only the shared skill, compact contract/failure/tool references,
and display metadata. They are versioned deliberately; other client-local state remains
ignored. No global skill installation is required for this checkout.

Review the configuration before approving it. Claude Code and Codex may ask you to trust a
project-scoped MCP server. Approve only this repository and do not copy or edit private trust
state by hand.

Verify discovery from the repository root:

```powershell
claude mcp list
.\node_modules\.bin\codex.cmd mcp list
```

On non-Windows systems, use the equivalent installed `codex mcp list` command.

## Local state

The bridge stores coordination data at `.bridge/bridge.db` by default. Runtime databases,
WAL sidecars, build output, logs, local trust state, and dependencies are ignored by Git.
The two project-local `using-bridge` directories are narrow exceptions; do not broaden them
to include trust decisions, settings, transcripts, or runtime data. Do not copy private state
into a backup repository.

For platform-specific native-client notes, see
[BENCHMARK/native-mcp/usage.md](../BENCHMARK/native-mcp/usage.md). If discovery, startup, or a
first delegation fails, work through [troubleshooting.md](troubleshooting.md).
