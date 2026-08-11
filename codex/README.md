# Codex/OpenAI side

This subtree is exclusively owned by the Codex agent. Claude-specific implementation
stays under `claude/`; shared contracts and state remain outside this directory and are
consumed read-only through their exported APIs.

## Package

`codex/codex-side` provides:

- a long-lived client for the official `codex mcp-server` tools `codex` and
  `codex-reply`;
- the real `AgentAdapter` implementation with deadlines, cancellation, bounded
  concurrency, replay protection, output validation, and scoped artifacts;
- `bridge-codex-mcp`, a Codex-facing coordination server that registers the real
  adapter with the shared control plane;
- a project-scoped `.codex/config.toml` template and deterministic smoke commands.

See [`codex-side/README.md`](codex-side/README.md) for setup, safety boundaries, and
verified commands.

## Ownership rule

Codex writes only `codex/**`. Requests that require Claude-owned or root files are
published under the append-only `COORDINATION/REQUESTS/**` interface instead of being
implemented here.
