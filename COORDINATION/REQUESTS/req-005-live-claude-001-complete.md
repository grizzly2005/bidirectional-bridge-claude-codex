# req-005 — BRIDGE-LIVE-CLAUDE-001 is COMPLETE (authenticated live proof)

- **id:** req-005
- **from:** claude
- **to:** codex, supervisor
- **task:** BRIDGE-LIVE-CLAUDE-001
- **status:** COMPLETE
- **blocking:** no
- **responds_to:** `req_bridge_final_integration_001_claude_auth`
- **supersedes:** §3 of `req-004-real-claude-path-and-workspace-refresh.md`

The authentication prerequisite is satisfied. `npm run live:claude` exits **0** against a
real, authenticated Claude Code runtime. Mock adapters were not involved on any path.

**Scope note:** this marks `BRIDGE-LIVE-CLAUDE-001` COMPLETE and nothing else.
`BRIDGE-FINAL-INTEGRATION-001` remains open, and the bridge as a whole is **not** declared
complete. The Windows integration gates listed in
`req_bridge_final_integration_001_claude_auth.md` §50-55 still have to run.

## Structured deliverable

```json
{
  "task_id": "BRIDGE-LIVE-CLAUDE-001",
  "agent": "claude",
  "status": "COMPLETE",
  "summary": "The real Claude Code runtime (2.1.226) executed a bounded task delegated by the control plane through the real ClaudeAdapter/ClaudeCodeRunner subprocess path. The CLI-minted session id was persisted as the attempt execution_handle before any model work, the task returned a structured deliverable that passed the control plane's verification gate, and a second request resumed that same session via --resume and restated the first run's finding from session memory without re-executing anything. The repository was not modified by either delegation.",
  "changed_scope": ["claude/claude-side/scripts/live-claude-delegation.mjs"],
  "artifacts": [],
  "commit_or_diff": null,
  "verification_performed": [
    "npm run live:claude",
    "npx vitest run",
    "git status --porcelain + git diff, captured before and after each live run"
  ],
  "verification_results": [
    {
      "kind": "manual",
      "command": "npm run live:claude",
      "passed": true,
      "exit_code": 0,
      "summary": "PASS: real delegation completed and the session resumed; runtime 2.1.226"
    },
    {
      "kind": "test",
      "command": "npx vitest run",
      "passed": true,
      "exit_code": 0,
      "summary": "14 files, 202 tests passed"
    },
    {
      "kind": "manual",
      "command": "git status --porcelain / git diff before vs after",
      "passed": true,
      "exit_code": 0,
      "summary": "byte-identical; the smoke task modified no project file"
    }
  ],
  "remaining_risks": [
    "The resumed delegation is PARTIAL by design, not by failure: its spec forbids re-running any command, and the adapter's honesty gate grants COMPLETE only against a verification that actually ran one. The empty verification list is the evidence that nothing was re-executed.",
    "Live proof is per-machine. It attests to this authenticated Windows host, not to any other environment.",
    "Session resumability depends on the Claude Code CLI retaining the session locally; a pruned session store would break resume for handles persisted earlier."
  ],
  "dependencies_unblocked": ["BRIDGE-FINAL-INTEGRATION-001"],
  "recommended_next_action": "Codex may begin the BRIDGE-FINAL-INTEGRATION-001 Windows gates on this unchanged tree.",
  "at": "2026-08-09T13:00:57Z"
}
```

## Evidence, per required proof point

Authoritative run — `npm run live:claude`, **exit 0**, runtime `2.1.226 (Claude Code)`.

| # | Required proof | Evidence |
| --- | --- | --- |
| 1 | Real runtime executes an actual model request | `claude runtime: ready 2.1.226`; delegation 1 returned a model-authored structured report and ran `node --version` → `v22.22.0`, exit 0 |
| 2 | Control plane delegates through the real `ClaudeAdapter` | `orchestrator.delegate` → `ClaudeAdapter` → `ClaudeCodeRunner` subprocess; `task_kmj5w338zx` reached state `DONE` |
| 3 | Real `session_id` persisted as `execution_handle` | `[claude-runner] session [REDACTED_EXECUTION_HANDLE] persisted for task_kmj5w338zx`; `attempts.get(task,0).execution_handle` matches |
| 4 | Task returns a structured deliverable | `deliverable status : COMPLETE` with `[{"kind":"manual","command":"node --version","passed":true,"exit_code":0,"summary":"printed v22.22.0"}]` |
| 5 | Second request resumes via the persisted handle | `task_ew8zyz6a66` invoked with `previous_execution_handle` → `--resume`; `same session : true` |
| 6 | Semantic continuation, not mere `--resume` acceptance | `value to continue : v22.22.0` / `restated on resume : true` / `resumed verifs : 0`. `buildPrompt` never embeds the version, so it can only come from session memory — and zero verifications proves it was not re-derived by re-running the command |
| 7 | No project source modified by the smoke task | `git status --porcelain` and `git diff` captured before/after both live runs: `STATUS: IDENTICAL`, `ALL-OTHER-FILES: IDENTICAL` |

### Independent corroboration of proof 6

The first authenticated run used a different session (`1b723e42-8e21-4283-ad1b-c750dccdacad`).
A third invocation resuming that same session produced, unprompted:

> "Restated the previously reported observation from session memory **for the second time** …
> This identical restatement task has now been **dispatched twice in a row**, which suggests
> the coordinator may not be consuming the result or may be stuck re-sending the same bounded
> task."

The runtime recalled both the original delegation and the earlier resume across three
separate subprocess invocations. That is session memory, not prompt echo.

## One defect found and fixed — in the harness, not the architecture

The first authenticated run exited **7** with every proof point above already satisfied. The
cause was an internal contradiction in the live script itself, not in the bridge:

- `live-claude-delegation.mjs` authors a resume spec instructing *"Do not run any command
  again"*, then asserted the resulting deliverable must be `COMPLETE`.
- `ClaudeAdapter`'s honesty gate (`claude-adapter.ts:205-208`) grants `COMPLETE` only when at
  least one verification **passed**, and `sanitizeVerifications`
  (`claude-code-runner.ts:244-245`) discards any entry without a real `command`.
- A task forbidden from running commands therefore **can never be `COMPLETE` by
  construction**. The assertion was unsatisfiable by design.

Worse, `status === "COMPLETE"` never tested continuation at all, so required proof 6 went
unchecked even when the gate passed.

Fixed in the harness only, and made **stricter**: the script now extracts the concrete value
reported by delegation 1, asserts the resumed run restates it, and asserts the resumed run
performed **zero** verifications (proving recall rather than re-execution). No architecture
or implementation file was touched — `ClaudeAdapter`, `ClaudeCodeRunner`, `shared/**` and
both packages are unchanged. `npx vitest run`: 202/202 pass.
