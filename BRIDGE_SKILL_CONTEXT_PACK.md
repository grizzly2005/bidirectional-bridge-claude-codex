# Bridge Skill Context Pack

This pack describes the repository at commit `3a42149737e97a9a47d93e18715b2bde84e2e59a` on branch `bench/bridge-pilot-v1`. It is design input for a future agent skill, not the skill itself. “Manager” means the native client handling the user request; “worker” means the runtime invoked through `bridge_delegate`.

## 1. Project snapshot

The project is an experimental, local Claude Code ↔ Codex coordination bridge. It gives both native clients the same MCP tool surface over a shared repository-local SQLite control plane. It records bounded tasks, ownership, path leases, lineage, artifacts, verification, runtime handles, recovery events, and per-attempt telemetry. It does not choose the better model, merge work automatically, provide an OS sandbox, or prove performance superiority.

The principal tree is:

```text
.mcp.json                    Claude project MCP configuration
.codex/config.toml           Codex project MCP configuration
scripts/native-bridge-mcp.mjs
shared/protocol/             neutral types, schemas, errors, scope rules
shared/control-plane/        tasks, leases, attempts, artifacts, SQLite, orchestration
shared/mcp-server-core/      neutral MCP tools and stdio server
claude/claude-side/          Claude Code runner and adapter
codex/codex-side/            Codex App Server/MCP clients and adapter
docs/                        architecture, usage, protocol, recovery, security, telemetry
BENCHMARK/                   redacted native-integration and telemetry proofs
certification/               deterministic certification manifest
```

The root package requires Node `>=22.13.0`, uses npm workspaces, and exposes `npm run typecheck`, `npm test`, and `npm run build`. Checked-in proofs show native project discovery, real delegation in both directions, bound identity, allow/deny policy, ancestor-loop rejection, persisted handles, recovery, and runtime telemetry. Those proofs do not establish token savings, economic efficiency, production security, large-scale reliability, or benchmark superiority.

## 2. Native MCP entrypoints

`scripts/native-bridge-mcp.mjs` is the composition root. It parses `--caller`, `--delegation`, `--workspace`, and optional `--db`; imports the built neutral core plus both runtime adapters; registers Claude and Codex adapters; constructs `BridgeMcpServer`; and serves MCP on stdio. Its default database is `<workspace>/.bridge/bridge.db`. MCP JSON-RPC owns stdout; diagnostics belong on stderr.

| Client | Project config | Effective launch |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `node ${CLAUDE_PROJECT_DIR:-.}/scripts/native-bridge-mcp.mjs --caller claude --delegation allow --workspace ${CLAUDE_PROJECT_DIR:-.}` |
| Codex | `.codex/config.toml` | `node scripts/native-bridge-mcp.mjs --caller codex --delegation allow`, with `cwd = "."`, 30-second startup, and 1,800-second tool timeout |

The process binds caller identity and delegation policy at startup. A tool’s optional `agent` field may be omitted; if supplied and contradictory, it is rejected rather than treated as an override. `bridge_server_info` exposes the bound values. Both current project configurations allow delegation. Build outputs must exist before the launcher can import the workspace packages.

## 3. Complete MCP tool inventory

Frequency labels: **R** = required in the applicable shortest workflow, **O** = optional/conditional, **D** = debugging, supervision, or recovery only. There are 25 tools.

| Tool | Minimum input → main output | Restrictions and intended frequency |
| --- | --- | --- |
| `bridge_server_info` | none → bound `caller`, `delegation` | Read-only. **R once per fresh native session**, not before every call. Stop if identity/policy is wrong. |
| `bridge_create_task` | `spec` → task/run/parent/depth/state | `spec` needs objective, nonempty scope, dependencies, expected deliverable, and nonempty verification criteria. Root defaults to depth 0. **R for a manager root**; delegation creates its own child. |
| `bridge_list_tasks` | none; optional state/owner/limit → summaries | Read-only. **O/D** when duplication or unknown task state is plausible; avoid routine polling. |
| `bridge_get_task` | `task_id` → full task, dependencies, artifacts, status, deliverable, verification, attempts, telemetry | Read-only. **O/D** after ambiguity, interruption, or recovery. |
| `bridge_set_execution_handle` | task, handle → saved attempt metadata | Handle is printable, ≤512 characters, credential-screened, and must be only a session/thread pointer. Adapters normally save it. **D/recovery plumbing**, not ordinary manager use. |
| `bridge_get_execution_handle` | task; optional attempt → current/previous raw handle | Handle may be stale and is sensitive operational state. **D only**; never include it in user output or telemetry. |
| `bridge_resume_task` | existing `task_id`; optional idempotency key → same-task recovery outcome | Existing owner only; derives lineage/scope/handle from durable state and requires exact-session resume. **R only for confirmed stranded recovery**. |
| `bridge_claim_task` | `task_id` → owner/state | Atomic; another owner yields `NOT_OWNER`. Claim is not write permission. **R for the manager root**; delegated children are claimed automatically. |
| `bridge_acquire_lease` | task, scope; optional TTL → lease/expiry/paths | Needed before manual file writes; overlapping other-holder scope yields `SCOPE_CONFLICT`. Delegation acquires its child lease automatically. **R for manager writes; otherwise O**. |
| `bridge_check_scope` | scope → free/conflicts | Non-mutating planning check. **O** when concurrent writes are plausible. |
| `bridge_renew_lease` | lease, TTL → new expiry | Holder only; cannot revive an expired lease. **O** for unusually long manual work. |
| `bridge_release_lease` | lease → state | Holder only; repeat release is safe. **R after a manually leased write task**; delegation/recovery release automatically. |
| `bridge_set_state` | task, target state → state | Owner only; state machine enforced; entering `WORKING` requires dependencies `DONE`. **R to move a claimed root to `WORKING`**; terminal delivery is better done by submit. |
| `bridge_report_status` | task, current action, next action → `ok` | Owner only. **O**, meaningful milestones only—not narration of every step. |
| `bridge_publish_artifact` | task, name, exactly one of inline/path → artifact id/hash/bytes | Path must be readable and repo-relative; inline limit is 64 KiB. Publish only owned, in-scope outputs. **O**, prefer inline for small read-only evidence. |
| `bridge_read_artifact` | `artifact_id` → metadata, integrity, content | Read-only. **O** when an artifact is an explicit input or result. |
| `bridge_record_verification` | task and real result → `ok` | Owner only; exact command and actual outcome. **O** when recording incrementally; submission can carry the same evidence directly. |
| `bridge_submit_deliverable` | task, status, summary; result fields → status/state/unblocked tasks | Owner only. `COMPLETE` needs ≥1 passing and zero failing checks. **R to finish the manager root**; adapter finishes delegated child. |
| `bridge_block_task` | task, reason → `BLOCKED`/blockers | Owner only. **O** when escalation is honest; do not use it on another agent’s child. |
| `bridge_add_dependency` | task, dependency → dependency list | Cycles rejected. **O**, normally declare dependencies in the initial spec. Agent discipline must restrict edits to tasks it controls. |
| `bridge_delegate` | target, spec, deadline; optional artifacts/lineage/retries/key → child id, delegate, deliverable/error, attempts, duration | Startup policy must allow it; ancestor target rejected; one request/one answer; child claim/lease/invocation/finalization are automatic. **R for cross-agent work**. |
| `bridge_query_telemetry` | optional run/task/agent/attempt/limit → final records | Read-only; `agent` is a filter, not impersonation. **O**, only for requested telemetry, dogfooding, or diagnosis. |
| `bridge_snapshot` | none → task counts, ready tasks, live leases, adapters | Read-only. **O** when concurrency or current ownership matters; it is not a prerequisite to every delegation. |
| `bridge_read_events` | optional cursor/task/limit → events and last id | Read-only supervisor feed. **D** for targeted progress/history; do not busy-poll. |
| `bridge_recover` | none → expired leases and stranded-state report | Does not retry or fail tasks. **D/R at the start of an operator recovery**, not normal flow. |

Mutators generally accept idempotency keys. Replaying the same key and payload returns the original result; reusing it with different data yields `IDEMPOTENCY_MISMATCH`.

## 4. Shortest correct cross-agent workflows

The directions are symmetric; only caller and target change.

**Claude → Codex:** **REQUIRED** (1) call `bridge_server_info` once and require `caller=claude`, `delegation=allow`; (2) create one root, claim it, set it `WORKING`; (3) call `bridge_delegate` once with `to=codex`, the returned root `run_id`, root task as `parent_task_id`, depth 1, a bounded spec, and a deadline; (4) consume the returned structured child outcome; (5) perform a real manager-side check appropriate to the user request and submit the root deliverable with that evidence. **OPTIONAL:** snapshot before step 2 if concurrent work is plausible; artifact reads for declared inputs; one telemetry query after completion if requested. **DEBUG:** get the specific task, then events; use recovery tools only for a genuinely stranded task.

**Codex → Claude:** use the identical sequence with `caller=codex` and `to=claude`. Do not invoke the target CLI directly, manually create/claim the child, or require telemetry for an interactive manager session that is not itself a recorded adapter attempt.

If the root manager edits files, it must acquire and later release its own lease. The child lease is orchestrator-managed. A read-only root needs no write lease and must report `changed_scope: []`.

## 5. When delegation is worth it

Delegate when the child can answer independently from a bounded repository slice, supplies a distinct capability or review perspective, and the expected value exceeds startup/context/verification overhead. Good cases include an independent code review, a narrowly scoped implementation in disjoint files, a targeted diagnosis, or a fact-finding task whose evidence the manager will consume.

Do not delegate a trivial command the manager can run locally, work requiring continuous back-and-forth, ambiguous work with missing authority, tightly coupled edits in the same files, a task whose verification cannot be stated, or any request that explicitly forbids the bridge. Never delegate merely to obtain telemetry.

## 6. Delegation contract

Every `TaskSpec` needs one-sentence `objective`; `scope.paths` as repo-relative write globs (plus optional note); `dependencies`; `expected_deliverable`; and at least one `verification_criteria`. Optional fields are preferred agent, task-local deadline, priority, and tags. `bridge_delegate` additionally requires `to`, `input_artifacts`, and a hard `deadline_ms` (1,000–86,400,000). `max_attempts` is retries beyond the first attempt, from 0 to 5. For a child, preserve the root `run_id`, use the root `task_id` as parent, and supply exactly parent depth + 1.

Canonical bounded read-only child call (caller identity intentionally omitted):

```json
{
  "to": "codex",
  "run_id": "run_from_root",
  "parent_task_id": "task_root",
  "delegation_depth": 1,
  "spec": {
    "objective": "Inspect the configured entrypoint and report two facts without modifying files.",
    "scope": {"paths": ["(no-write)/**"], "note": "No writes; return evidence inline."},
    "dependencies": [],
    "expected_deliverable": "Two facts with exact file/command evidence.",
    "verification_criteria": ["Cited path exists", "Reported command output is verbatim"]
  },
  "input_artifacts": [],
  "deadline_ms": 600000,
  "max_attempts": 0,
  "idempotency_key": "task_root:delegate:1"
}
```

Inputs are artifact IDs, not transcripts. A child cannot ask the manager questions through a conversation loop; missing information becomes an honest `PARTIAL` plus blocker.

## 7. Result contract

Runtime output is structured as `status`, `summary`, `changed_scope`, `artifacts`, `commit_or_diff`, `verification_results`, `remaining_risks`, `recommended_next_action`, and optional `blocker`. Each artifact has kind/name/media type/metadata and exactly one of small `inline` content or a repo-relative `path`. The adapter registers drafts and the durable deliverable returned by `bridge_delegate` contains artifact IDs plus injected task/agent/timestamp/dependency fields.

- `COMPLETE` maps to task `DONE`; it requires at least one real passing verification and no failing result.
- `PARTIAL` maps to `BLOCKED`; use it for real progress that still needs action, missing evidence, runtime limits, or recoverable uncertainty.
- `FAILED` maps to `FAILED`; use it when the bounded objective failed rather than merely awaiting external action.

Gotchas: `changed_scope` lists actual changed repo-relative paths, not files merely inspected. Read-only work returns `[]`. A path artifact must exist and fall inside the leased output scope; otherwise use an inline report. Do not name an existing config/source file as a produced path artifact for a no-write task. `passed` must agree with the real exit code; non-manual checks need an exit code. Use `commit_or_diff: null` when neither exists. Never invent evidence or expose execution handles.

## 8. Ownership and lease rules

Server-enforced: startup caller identity; atomic claim; owner checks for lifecycle/status/verification/deliverable/block/resume; dependency and state gates; conservative cross-holder lease conflicts; lease holder/path/expiry checks; exact lineage; verification-gated completion; artifact shape, relative path, readability, and hash.

Agent-known obligations: claim only intended roots; acquire leases only for owned work; mutate only owned tasks; publish only outputs produced for that owned task and inside its scope; do not use `add_dependency`, artifact publication, or manual handle-saving to affect another owner’s task. The current lower-level dependency, artifact, handle-save, and lease-acquire paths do not all independently assert task ownership. Leases coordinate cooperative agents but do not prevent shell writes at the OS layer.

On `NOT_OWNER`, stop the mutation. Read the result if needed, but do not steal, block, finish, release a lease for, or “repair” the other agent’s child. Claiming and leasing are separate permissions.

## 9. Loop and depth protection

Roots are depth 0; every child is exactly parent depth + 1 in the same run. Depth above 32 is rejected. Delegation to any agent already present in the ancestor lineage is rejected before child creation, preventing Claude → Codex → Claude recursion. Every delegation has a deadline and at most six total attempts. The semantic rule is one bounded request and one answer; use `PARTIAL`, not agent-to-agent clarification loops.

## 10. Recovery

For interrupted work, keep the durable task and runtime thread. First run `bridge_recover` to expire dead leases and identify stranded tasks, then `bridge_get_task` without printing the raw handle. The existing owner calls `bridge_resume_task` once. The control plane derives identity, lineage, scope, previous attempt, and handle; rejects live/conflicting leases; creates the adjacent attempt; takes a fresh lease; and requires the adapter to confirm the exact stored handle. Success or failure seals telemetry and releases the lease.

A stale/wrong handle, timeout, crash, unsupported resume, or failed strict resume does not authorize a replacement task or fresh thread. Report the same task’s blocked recovery outcome. Ordinary configured delegation retries are separate and may cold-start after an explicitly stale handle; strict stranded-task recovery may not.

## 11. Telemetry

One normalized final record is stored per worker attempt: run/task/attempt/parent/depth/agent, resumed-from attempt, runtime/version/model, orchestration and runtime timestamps/durations, input/output/cache/total tokens, turns, cumulative session tokens, runtime-reported cost and semantics, billing-known flag, prompt byte count, input artifact counts/bytes, termination kind, and process exit code. Unknowns are `null`—never estimated. Cached token categories are subdimensions, not additions to input.

Telemetry contains no prompt, response, transcript, authentication material, or execution handle. Report reliable **worker** telemetry when requested. Do not estimate missing manager tokens, call runtime-reported cost an invoice, or require telemetry for the interactive native manager session unless it has its own actual attempt record.

## 12. Failure handling

| Condition | Honest signal | Skill action |
| --- | --- | --- |
| `QUOTA_EXHAUSTED` | Runtime text/blocker, often `PARTIAL` or `ADAPTER_FAILURE`; not a stable bridge error code | Label it a runtime-quota blocker, stop, and do not create replacement children. Resume the same eligible task only after quota returns. |
| `RUNTIME_UNAVAILABLE` | Missing adapter `NOT_FOUND`, failed probe, or `ADAPTER_FAILURE` details | Report unavailable runtime; no direct CLI fallback and no replacement child. |
| `TIMEOUT` | Retryable bridge `TIMEOUT` or worker `PARTIAL` deadline blocker | Assume partial edits may exist; inspect durable state/scope. Use only the predeclared bounded retry budget, or strict same-task recovery when eligible. |
| Child `BLOCKED` | Child state `BLOCKED`, normally `PARTIAL` deliverable | Consume blocker and report/resolve at the parent. Do not mutate the child as manager. |
| `PARTIAL` | Structured incomplete result with risks/action | Preserve useful evidence, state what remains, and do not upgrade to complete. |
| `NOT_OWNER` | Non-retryable structured bridge error | Stop mutation; never force ownership or release the other holder’s lease. |
| Lease conflict | Retryable `SCOPE_CONFLICT` with holders/overlaps | Wait and recheck, narrow to provably disjoint scope, or return a blocker. Never steal the lease. |
| Validation failure | `INVALID_ARGUMENT`, or adapter’s bounded repair ending in `PARTIAL` | Correct the payload/result once using actual evidence; do not redo completed work or invent paths/checks. |
| Failed recovery | `resume.failed`, error, and same task left `BLOCKED` | Report exact reason and same task/attempt lineage; never start a replacement task/thread. |

## 13. Dogfood lessons

Checked-in native proofs show both project configs discover the same composition root; caller identity matches each client; real Claude-managed Codex work and Codex-managed Claude work reached bounded child completion; worker results were consumed; source stayed unchanged in read-only proofs; and raw handles were not exported. Deterministic tests cover allow/deny, spoof rejection, lineage, maximum depth, and SQLite coordination.

Operational lessons are stricter than “the process started”: an outer host/background execution handle is not a completed bridge child or its structured result. Consume the actual `bridge_delegate` outcome or the specific durable task. A no-write task must not return inspected repository files as produced path artifacts. Runtime quota exhaustion is a runtime blocker, not evidence that the bridge failed, and it does not justify redelegation. User-requested delegation count is a hard limit.

## 14. Efficiency guidance

Use the smallest correct sequence. Cache session identity after one `bridge_server_info`. Skip snapshot when no concurrent work is plausible. Put all needed context in one bounded spec; pass only necessary artifact IDs. Default to `max_attempts: 0`; add retries only for a justified transient failure. Choose a realistic deadline, not the maximum by habit. Let `bridge_delegate` manage the child claim, lease, attempt, artifacts, verification, and final state. Emit status only at meaningful milestones. Query telemetry once, after the attempt, and only when useful. Prefer compact inline evidence for read-only facts. On interruption, target one known task rather than listing and polling the whole database.

The manager must still read the child result, check that it answers the user’s actual request, and perform proportionate verification before completing the root. Delegation is not a substitute for synthesis or accountability.

## 15. Source-of-truth map

| Concern | Authoritative files |
| --- | --- |
| Native startup/config | `scripts/native-bridge-mcp.mjs`, `.mcp.json`, `.codex/config.toml` |
| MCP names, schemas, bound caller | `shared/mcp-server-core/src/tools.ts`, `shared/mcp-server-core/src/server.ts` |
| Protocol objects/errors | `shared/protocol/src/types.ts`, `schemas.ts`, `errors.ts` |
| Ownership/lineage/state | `shared/control-plane/src/task-service.ts` |
| Leases/artifacts/completion | `lease-manager.ts`, `artifact-registry.ts`, `deliverable-service.ts` in `shared/control-plane/src/` |
| Attempts/recovery/delegation | `attempt-service.ts`, `orchestrator.ts` in `shared/control-plane/src/` |
| Runtime result validation | `codex/codex-side/src/prompt.ts`, `codex-adapter.ts`, `claude/claude-side/src/adapters/claude-code-runner.ts` |
| Normative/explanatory docs | `docs/PROTOCOL.md`, `architecture.md`, `usage.md`, `recovery.md`, `telemetry.md`, `security.md` |
| Historical proof, not normative behavior | `BENCHMARK/native-mcp/native-mcp-proof.json`, `BENCHMARK/telemetry/live-proof.json` |

When prose and code differ, use schemas and implementation for current behavior, then update stale prose separately. Proof files establish what a particular run observed, not a universal guarantee.

## 16. Recommendations for the future skill

The skill should trigger only when the user asks to use the bridge, delegate to the other runtime, coordinate parallel ownership, recover a stranded bridge task, or retrieve bridge telemetry. It should explicitly decline activation when the user says not to use the bridge. It should have a fast path for one bounded child and separate opt-in branches for concurrent-write planning, telemetry, debugging, and recovery.

Encode invariants as short checklists: verify caller once; create/claim/start one root; preserve run/parent/depth; omit caller fields; never direct-invoke the target; let the orchestrator own the child; consume the structured result; provide real root verification; never expose handles; honor exact delegation counts. Treat snapshots, event tails, status reports, manual handle tools, and telemetry as conditional—not ceremony.

### SKILL_DESIGN_TOP_10

1. Respect explicit bridge opt-in/opt-out and exact delegation counts.
2. Verify startup-bound caller and delegation policy once per native session.
3. Use one depth-0 root and preserve run/parent/depth in each bounded child.
4. Make every spec self-contained, scoped, deadline-bound, and verifiable.
5. Call `bridge_delegate`; never substitute a direct Claude/Codex invocation.
6. Let the orchestrator manage child ownership, lease, attempt, and finalization.
7. Consume and validate the child’s structured result before answering the user.
8. Keep read-only evidence inline, changed scope exact, and verification real.
9. Report only authoritative worker telemetry; never expose handles or estimate unknowns.
10. On quota, ownership, lease, timeout, or recovery failure, stop honestly and never spawn replacement work outside the contract.
