# Architecture Decisions (append-only)

## D-001 — Runtime and storage
- **Date:** 2026-08-09 · **By:** claude (per user directive) · **Status:** accepted
- TypeScript on Node.js. SQLite in WAL mode for local state. MCP over stdio first.
- All control-plane messages are validated against JSON Schemas exported from `@bridge/protocol`.
- Storage and transport are behind interfaces (`StateStore`, MCP transport) and are replaceable.

## D-002 — Ownership split
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- claude owns: `@bridge/protocol` (shared contract), `@bridge/control-plane`, `@bridge/claude-side`.
- codex owns: the real Codex adapter (`packages/codex-side/**`), driven via Codex CLI exposed
  as an MCP server (`codex()` to start a conversation, `codex-reply()` to continue).
- claude ships only the adapter contract + a mock Codex adapter for integration tests.
  claude does not implement Codex internals.

## D-003 — Control plane is the only writer of state
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Adapters never touch SQLite. Every mutation goes through the control-plane API, which
  appends to an immutable event log in the same transaction as the state write.
- Rationale: single serialization point makes ownership, leases, and crash recovery decidable.

## D-004 — Write-scope leases, not advisory locks
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Conflicting writes are prevented by time-bounded leases over path globs, acquired atomically.
- Leases expire so a crashed agent cannot deadlock the system; expiry is evaluated lazily at
  acquisition time against a caller-injectable clock (keeps tests deterministic).

## D-005 — Idempotency via caller-supplied keys
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Every mutating operation accepts an `idempotency_key`. Replaying a key returns the original
  result instead of applying twice. Rationale: MCP calls can be retried after a crash or timeout.

## D-007 — The MCP server is agent-neutral (BRIDGE-CONVERGENCE-SHARED-001)
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- The generic MCP server, tool registration, adapter registry, and server lifecycle live in
  `@bridge/mcp-server-core` under `shared/`. `@bridge/claude-side` keeps only Claude's
  adapter, work session, and launcher.
- `@bridge/control-plane` moved from `claude/` to `shared/` (package name unchanged). A
  package under `shared/` depending on one under `claude/` would have made "neutral" a
  naming convention rather than a fact.
- Rationale: Codex was importing `BridgeMcpServer` from `@bridge/claude-side`, which made
  the bridge asymmetric — Claude's package was a hard dependency of Codex's server.
- Verified by deleting `node_modules/@bridge/claude-side` and importing the neutral package
  anyway; its dependency closure is `{protocol, control-plane}`.
- A deprecated re-export remains in `@bridge/claude-side` until Codex migrates
  (req-002). Breaking another agent's active build in the same commit is not a change one
  agent makes unilaterally.

## D-008 — Deliverable status maps to exactly one terminal state
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- `COMPLETE -> DONE`, `PARTIAL -> BLOCKED`, `FAILED -> FAILED`, exported as
  `DELIVERABLE_TERMINAL_STATE` from `@bridge/protocol`.
- `VERIFYING -> BLOCKED` is now a legal edge. Its absence forced adapters that reported a
  VERIFYING milestone to detour through WORKING to submit an honest PARTIAL
  (codex req_codex_partial_from_verifying_001).
- The deliverable row and the state change commit in one transaction, so a rejected
  deliverable cannot leave a task advanced past work that was never accepted.

## D-009 — Resumable execution handles, not session state
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Each attempt carries an optional `execution_handle`: an opaque, agent-defined pointer to
  resumable execution (Codex thread id, Claude session id). The control plane never parses it.
- Capped at 512 printable single-line ASCII characters and screened against credential
  patterns. The cap is the mechanism, not the documentation: a transcript cannot fit.
- The event log records the handle's length, never its value, so a supervisor tailing
  events cannot harvest session identifiers.
- Adapters must save the handle *before* working. A handle written on the success path is
  worthless — the only time anyone needs it is when the run died.

## D-010 — stdout belongs to the transport
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Every diagnostic goes to stderr. Enforced two ways: a live smoke test asserting each
  stdout line parses as JSON-RPC 2.0, and a static scan rejecting `console.log`-family and
  `process.stdout.write` calls anywhere on the server path.
- Both guards were mutation-tested — an injected `console.log` fails each of them — so
  neither can pass vacuously.
- `serve()` exits on transport close (stdin EOF). A launcher that ignores EOF holds the
  SQLite file open and Windows then refuses to delete the database.

## D-011 — Claude's real execution path is a bounded CLI subprocess
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- `ClaudeAdapter` is backed by `ClaudeCodeRunner`, which drives
  `claude -p --output-format stream-json --verbose` as a child process. `functionRunner`
  remains only as a test seam.
- Chosen over embedding an API client because Claude Code owns session lifecycle, tool
  permissions, and `--resume`. Reimplementing those against the raw API would duplicate
  them and diverge.
- The session id arrives in the first `system/init` frame, before any model work, so the
  execution handle is persisted at that instant rather than on completion. A run that dies
  mid-task is therefore resumable — which is the entire purpose of the field.
- stdin is `ignore`, not a pipe: a delegated run is structurally incapable of blocking on
  an interactive prompt. `bypassPermissions` is refused by the launcher because it would
  void the write-scope leases the bridge is built on.
- Verified against the real binary (2.1.222) for spawn, session capture, `--resume`,
  deadline kill, and cancellation. Model execution is unverified in this environment for
  lack of credentials, and the live script exits 6 rather than 0 in that state.

## D-012 — A verification without a command is not evidence
- **Date:** 2026-08-09 · **By:** claude · **Status:** accepted
- Verification entries returned by a runtime are discarded unless they carry the command
  that produced them. Rationale: the honesty gate exists to stop a task reaching DONE on an
  unrun check, and a claim with no reproducible command cannot be audited by a supervisor.

## D-006 — Deferred (do not build yet)
- **Date:** 2026-08-09 · **By:** claude (per user directive) · **Status:** accepted
- Out of scope for pass 1: supervision UI, model routing, learned agent metrics, quota
  balancing, multi-machine operation, git merge automation, real Codex adapter, autonomous
  agent-to-agent negotiation. Interfaces are shaped so these can be added without a core rewrite.
