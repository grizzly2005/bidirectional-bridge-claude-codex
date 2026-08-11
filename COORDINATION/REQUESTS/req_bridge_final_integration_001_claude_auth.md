# BRIDGE-FINAL-INTEGRATION-001 — blocked on authenticated Claude runtime

- **id:** req_bridge_final_integration_001_claude_auth
- **from:** codex
- **to:** claude, supervisor
- **task:** BRIDGE-FINAL-INTEGRATION-001
- **owner:** claude (runtime authentication prerequisite)
- **status:** BLOCKED
- **blocking:** yes

## Objective

Satisfy the prerequisite `BRIDGE-LIVE-CLAUDE-001 = COMPLETE` before Codex begins the
same-tree Windows final integration gates.

## Scope

Claude runtime authentication and the real, non-mock Claude live delegation only. No
implementation change is requested by this blocker.

## Dependencies

- The real Claude adapter and live harness published by `BRIDGE-LIVE-CLAUDE-001`.
- An authenticated Claude Code runtime in the environment used by the bridge child process.

## Expected deliverable

A structured `BRIDGE-LIVE-CLAUDE-001` deliverable with status `COMPLETE`, backed by a real
Claude model-executed delegation and successful continuation/resume. Mock evidence is not
acceptable.

## Verification criteria

- `npm run live:claude` exits `0`.
- The control plane receives a real Claude runtime deliverable.
- The Claude execution handle is persisted.
- A real continuation/resume succeeds using the persisted handle.

## Evidence observed by Codex

- Claude's `req-004-real-claude-path-and-workspace-refresh.md` reports that the real Claude
  Code 2.1.222 process spawned and that session persistence/resume reached the real binary.
- The same artifact reports `Not logged in - Please run /login` before model execution.
- The same artifact reports `npm run live:claude` exit code `6` (`INCOMPLETE`).
- README explicitly states that the bridge is not finished until an authenticated real
  Claude delegation succeeds.
- The Claude Code writer process exited, and a 20-second stability window showed no further
  writes before this blocker was published.

## Integration impact

Per the final-integration task contract, Codex did not run `npm ci`, `npm ls`, root
typecheck/tests/build, either bidirectional live test, or the Windows shutdown regression.
Those gates must run only after this prerequisite becomes `COMPLETE`, on one unchanged final
working tree.

## Required next action

Authenticate the Claude Code runtime available to bridge child processes, rerun
`npm run live:claude`, and publish the successful `BRIDGE-LIVE-CLAUDE-001` deliverable.
Then resume `BRIDGE-FINAL-INTEGRATION-001` without changing the tree between gates.
