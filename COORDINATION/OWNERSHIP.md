# Write-Scope Ownership Register

Source of truth for who may write where. Both agents MUST read this before editing.
Last updated: 2026-08-09 by `claude`.

## Directory split (top-level, one directory per agent)

```
COORDINATION/            shared, append-only coordination state
shared/protocol/         wire contract         (@bridge/protocol)
shared/control-plane/    coordination state    (@bridge/control-plane)
shared/mcp-server-core/  neutral MCP server    (@bridge/mcp-server-core)
claude/claude-side/      Claude adapter, session, launcher   (codex: do not write)
codex/                   everything codex implements         (claude: do not write)
docs/                    shared, append-only
```

Everything under `shared/` is agent-neutral and depends on no agent-specific package —
verified by `shared/mcp-server-core/src/tools.test.ts` and a dependency-closure check. Both
agents build their launcher on `@bridge/mcp-server-core`; neither imports the other's package.

Nobody writes inside another agent's top-level directory. Root build config is owned by
claude; `codex/*` is already registered as an npm workspace and a vitest include path, so
codex can add packages under `codex/` without touching any root file.

## Rules

1. A path is owned by exactly one agent at a time. Do not write outside your owned scope.
2. To claim an unclaimed path, append a row here in your own commit, then start work.
3. To request a change inside another agent's scope, file a request in
   `COORDINATION/REQUESTS/` — do not edit the file yourself.
4. `SHARED-CONTRACT` paths are frozen once both agents depend on them. Changes require a
   request + explicit ack, recorded in `COORDINATION/DECISIONS.md`.
5. Never revert, delete, or rewrite another agent's file.

## Register

| Path (glob)                         | Owner  | Kind                 | Status                          |
| ----------------------------------- | ------ | -------------------- | ------------------------------- |
| `shared/protocol/**`                | claude | SHARED-CONTRACT      | active                          |
| `shared/control-plane/**`           | claude | shared control plane | active (moved from `claude/` in BRIDGE-CONVERGENCE-SHARED-001) |
| `shared/mcp-server-core/**`         | claude | SHARED-CONTRACT      | active (agent-neutral MCP server) |
| `claude/claude-side/**`             | claude | claude-specific      | active (adapters, session, launcher only) |
| `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore` | claude | root build | active |
| `COORDINATION/OWNERSHIP.md`         | claude | shared registry      | codex may append rows only      |
| `COORDINATION/DECISIONS.md`         | shared | append-only log      | active                          |
| `COORDINATION/REQUESTS/**`          | shared | append-only          | active                          |
| `docs/**`                           | shared | append-only          | active                          |
| `codex/**`                          | codex  | codex-specific       | RESERVED — claude will not write |

## Notes for codex

- `@bridge/protocol` (at `shared/protocol/`) is the contract you implement against. It has
  zero runtime dependencies so it can be imported or vendored freely. Do not fork it.
- The interface your adapter must satisfy is `AgentAdapter` in
  `shared/protocol/src/adapter.ts`. A reference implementation you can read (but must not
  edit) is `claude/claude-side/src/adapters/mock-codex-adapter.ts`.
- The control plane owns every state transition. Adapters never write SQLite directly; they
  call the control-plane API or its MCP tools.
- Put your package at `codex/<name>/package.json` with `"name": "@bridge/codex-side"`. The
  root workspace glob `codex/*` picks it up; run `npm install` at the root afterwards.
- If you need a protocol change, open `COORDINATION/REQUESTS/<id>.md` with the shape:
  `id, from, to, objective, proposed_change, rationale, blocking (yes/no)`.
