# Bridge protocol — v1.0.0

The wire contract between Claude and Codex. Normative source: JSON Schemas exported from
`@bridge/protocol` (`SCHEMAS`). TypeScript types mirror them; where they disagree, the
schema wins, because the two agents may validate from different toolchains.

## The model in one paragraph

Work is a **task**: a bounded objective with a declared **write scope**, dependencies, an
expected deliverable, and verification criteria. Exactly one agent **owns** a task. Before
touching files an owner takes a **lease** over its scope; overlapping leases held by
different agents are refused, which is what prevents conflicting writes. Results cross the
bridge as **artifacts**, not chat transcripts. Progress is published as **status updates**
and finished work as a structured **deliverable**. Every state change is appended to an
immutable **event log** an external supervisor can tail.

## Task lifecycle

```
        ┌──────────┐  claim   ┌─────────┐  start  ┌─────────┐
        │ PENDING  │─────────►│ CLAIMED │────────►│ WORKING │
        └──────────┘◄─────────└─────────┘         └─────────┘
             ▲        release       │  block           │  │  block
             │                      ▼                  │  ▼
             │                 ┌─────────┐  resume     │ ┌─────────┐
             │                 │ BLOCKED │◄────────────┴─│ BLOCKED │
             │                 └─────────┘                └─────────┘
             │  retry               │                     │ submit
             │                      │ fail                ▼
             │                      ▼               ┌───────────┐
             │                 ┌────────┐           │ VERIFYING │
             └─────────────────│ FAILED │◄──────────└───────────┘
                               └────────┘                 │ verified
                                                          ▼
                                                     ┌────────┐
                                                     │  DONE  │
                                                     └────────┘
```

`DONE`, `FAILED`, `CANCELLED` are terminal. The legal edges are `ALLOWED_TRANSITIONS` in
`@bridge/protocol`; the control plane rejects anything else with `ILLEGAL_TRANSITION`.

### Deliverable outcomes

Submitting a deliverable resolves the task in one atomic step. The mapping is
`DELIVERABLE_TERMINAL_STATE`, the single source of truth for both agents:

| Deliverable status | Terminal state | Meaning |
| --- | --- | --- |
| `COMPLETE` | `DONE` | verified and finished |
| `PARTIAL` | `BLOCKED` | real progress, but someone must act before it can finish |
| `FAILED` | `FAILED` | gave up |

All three are reachable directly from `VERIFYING`, so an adapter can report a verification
milestone and still return an honest `PARTIAL`. A submission made straight from `WORKING`
is routed through `VERIFYING` inside the same transaction, because `DONE` is only reachable
from `VERIFYING` — "reached DONE without being checked" stays unrepresentable.

The deliverable row and the state change commit together. A rejected deliverable — the
verification gate refusing `COMPLETE` without evidence — leaves the task exactly where it
was, with no event written.

`summary` is a bounded synthesis, not storage for a substantive report. Adapters preserve
long-form output through durable artifact ids (inline artifacts for read-only reports when
size permits). Executed checks belong in canonical `verification_results`; the bridge derives
`verification_performed` from those records, and prose-only claims never satisfy completion.

### Attempts and resumable execution handles

Each attempt at a task has a record carrying an optional `execution_handle`: an opaque,
agent-defined pointer to resumable execution state (a Codex thread id, a Claude session
id). Adapters save it through `ctx.saveExecutionHandle(handle)` **as soon as the session
exists**, not on completion — the only time anyone needs it is when the run died. The next
attempt receives it as `invocation.previous_execution_handle` and may resume, treating a
failed resume as a normal cold start during an ordinary retry.

`bridge_resume_task` is the stricter stranded-task path. It accepts only a `task_id` and an
optional idempotency key; owner, lineage, scope, and the opaque handle are read from durable
state. In one control-plane transaction it validates recoverability and ancestry, rejects
live or conflicting leases, acquires a fresh lease, closes the interrupted attempt, creates
the adjacent attempt with `resumed_from_attempt`, and reactivates the same task. Runtime work
then runs under a deadline with `resume_required=true`. The adapter must confirm the exact
stored handle: a stale handle or a different returned handle fails the recovery and must
never start a replacement session. Success or failure seals one telemetry row for the new
attempt and releases the fresh lease; a runtime failure leaves the task `BLOCKED` and
recoverable.

Constraints, enforced with `INVALID_ARGUMENT`:

- at most `EXECUTION_HANDLE_MAX_LENGTH` (512) characters;
- printable ASCII, single line;
- rejected if it matches a credential pattern (`sk-`, `sk-ant-`, `ghp_`, `AKIA…`,
  `Bearer …`, JWT, PEM private key header).

The coordination database is shared between both agents and readable by any supervisor, so
handles must never carry secrets or conversation content. The event log records only the
handle's length.

Two gates are enforced, not advisory:

- **Dependency gate** — entering `WORKING` fails with `DEPENDENCY_UNSATISFIED` unless every
  dependency is `DONE`. Checked at start, not at claim, so an agent may claim and prepare
  while an upstream task finishes.
- **Verification gate** — a `COMPLETE` deliverable is rejected unless at least one
  verification passed and none failed. An agent that cannot run a check submits `PARTIAL`,
  or passes an explicit waiver that is recorded in the event log.

## Write scopes and leases

A scope is a set of repo-relative glob patterns (`*`, `**`, `?`). Overlap is computed by
`globsOverlap`, which is deliberately conservative: when it cannot prove two patterns are
disjoint it reports a conflict. A false conflict costs a retry; a false clearance costs
corrupted files.

- Leases are **time-bounded**. A crashed agent's scope frees itself; it cannot deadlock.
- Expiry is evaluated **lazily** against the injected clock, so behaviour is deterministic
  under test and there is no background timer to get out of sync.
- Renewal of a lapsed lease is refused — the scope may already belong to someone else.
- The **same holder** may take an overlapping scope. Forcing release-then-reacquire would
  open a window for the other agent to steal the scope mid-task.

## Error codes

| Code | Retryable | Meaning |
| --- | --- | --- |
| `INVALID_ARGUMENT` | no | Payload failed schema validation, or a gate rejected it |
| `NOT_FOUND` | no | No such task, lease, or artifact |
| `ILLEGAL_TRANSITION` | no | The state machine forbids this edge |
| `NOT_OWNER` | no | Caller does not own the task / hold the lease |
| `SCOPE_CONFLICT` | **yes** | Another agent holds an overlapping live lease |
| `LEASE_INVALID` | no | Lease expired or released; the write must not proceed |
| `DEPENDENCY_UNSATISFIED` | **yes** | Upstream tasks are not `DONE` yet |
| `DEPENDENCY_CYCLE` | no | The edge would create a cycle |
| `IDEMPOTENCY_MISMATCH` | no | Key reused with a different payload |
| `TIMEOUT` | **yes** | Adapter exceeded its deadline |
| `ADAPTER_FAILURE` | no | Agent-specific failure; see `details` |
| `RUNTIME_PROFILE_MISMATCH` | no | Runtime-reported model contradicts the bridge-owned profile |
| `INTERNAL` | **yes** | Unclassified fault |

Branch on `code`, never on message text.

## Idempotency

Every mutating operation accepts `idempotency_key`. A replay returns the original response;
the key and its response are written in the same transaction as the mutation, so a crash
between the two cannot cache a response for work that rolled back. Reusing a key with a
different payload raises `IDEMPOTENCY_MISMATCH` rather than silently returning the old
answer.

## Delegation

`DelegationRequest` requires a `deadline_ms`. That is the mechanism that stops open-ended
agent-to-agent loops: one request, one answer. A delegate that needs something it cannot
get returns `PARTIAL` with a blocker; it never opens a conversation back. Inputs are
artifact ids, so the delegate reads exactly what it was given, not a transcript.

`TaskSpec.max_turns` optionally selects a finite runtime ceiling from 1 through 64. Omission
keeps the conservative runtime default of 12. The field persists with the task, so strict
same-task recovery uses the same ceiling. It does not permit model or effort overrides:
bridge-created Claude workers always request `opus` with `high` effort.

The orchestrator guarantees the lease is released on every exit path — success, timeout,
crash, or non-retryable failure.

## Adapter contract

Implement `AgentAdapter` (`shared/protocol/src/adapter.ts`):

```ts
interface AgentAdapter {
  readonly info: AdapterInfo;
  health(): Promise<HealthReport>;                                  // must not throw
  invoke(inv: TaskInvocation, ctx: InvocationContext): Promise<Deliverable>;
  cancel(task_id: TaskId, reason: string): Promise<void>;
  dispose?(): Promise<void>;
}
```

Rules:

1. Return a `Deliverable` for expected failures; throw only for transport faults.
2. Stop promptly when `ctx.signal` aborts and return `PARTIAL`.
3. Never write outside `invocation.spec.scope`.
4. Be idempotent with respect to `invocation.idempotency_key`.
5. Report through `ctx` (`report`, `publishArtifact`, `recordVerification`, `raiseBlocker`) —
   adapters hold no state of their own.

A reference implementation is `claude/claude-side/src/adapters/mock-codex-adapter.ts`.

## Event log

Append-only, monotonic `event_id`. Written in the same transaction as the state change it
describes, so the log can never disagree with the state. Tail it by polling
`bridge_read_events` with the last id you saw. Event types are `EventType` in the protocol
package; `lease.denied` records near-collisions between the agents and is written outside
the failing transaction so it survives the rejection.

## MCP tool surface

Served over stdio by the agent-neutral `@bridge/mcp-server-core`; each native launcher binds
the caller identity. Names and full descriptions live in `shared/mcp-server-core/src/tools.ts`.

Discovery: `bridge_snapshot`, `bridge_list_tasks`, `bridge_get_task`, `bridge_check_scope`,
`bridge_read_events`.
Ownership: `bridge_create_task`, `bridge_claim_task`, `bridge_add_dependency`.
Scope: `bridge_acquire_lease`, `bridge_renew_lease`, `bridge_release_lease`.
Execution: `bridge_set_state`, `bridge_report_status`, `bridge_publish_artifact`,
`bridge_read_artifact`, `bridge_record_verification`, `bridge_block_task`.
Completion: `bridge_submit_deliverable`.
Coordination: `bridge_delegate`, `bridge_resume_task`, `bridge_recover`,
`bridge_query_telemetry`.
