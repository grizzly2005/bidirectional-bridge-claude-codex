# Bridge protocol — v1.0.0

The wire contract between Claude and Codex. Normative source: JSON Schemas exported from
`@bridge/protocol` (`SCHEMAS`). TypeScript types mirror them; where they disagree, the
schema wins, because the two agents may validate from different toolchains.

## The model in one paragraph

Work is a **task**: a bounded objective with a declared **write scope**, dependencies, an
expected deliverable, and verification criteria. Exactly one agent **owns** a task. Before
touching files an owner takes a **lease** over its scope; overlapping leases for distinct
tasks are refused, including those held by the same agent. Results cross the
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

Strict stranded-task recovery has two entry points. `bridge_resume_task` requires the bound
caller to own the task. `bridge_resume_delegated_task` authorizes the owner of a direct parent
to request recovery of the child it created, after SQLite proves the direct parent, same run,
adjacent depth, parent ownership, child creator, child owner, and recoverable persisted state.
Both accept only a `task_id` and optional idempotency key; owner, lineage, scope, target
runtime, and opaque handle are read from durable state.

Authorization identity and execution identity are distinct for delegated recovery. The
manager is only `requested_by`; the child's persisted owner remains the execution agent for
adapter selection, task transitions, attempts, lease holding, invocation callbacks,
verification, deliverables, telemetry, and handle persistence. Ownership never transfers.
Unrelated tasks, another manager's child, and descendants whose direct parent is not owned by
the caller are rejected.

Recovery validates recoverability, ancestry, immutable inputs and the original elapsed
budget before launch. A short transaction reserves a fresh lease and FIFO entry; only after
admission does another short transaction close the interrupted attempt, create the adjacent
attempt with `resumed_from_attempt`, and reactivate the same task. Runtime work then
runs under a deadline with `resume_required=true`. The worker adapter must confirm the exact
stored handle: a stale handle or a different returned handle fails the recovery and must never
start a replacement session. The business outcome and observation receipt are separate.
The fresh lease is released only after positive stop evidence; an unconfirmed stop keeps
the execution and scope quarantined. Replay returns the frozen recovery outcome, including
strict measurement failures. Queued cancellation does not open an attempt.

Constraints, enforced with `INVALID_ARGUMENT`:

- at most `EXECUTION_HANDLE_MAX_LENGTH` (512) characters;
- printable ASCII, single line;
- rejected if it matches a credential pattern (`sk-`, `sk-ant-`, `ghp_`, `AKIA…`,
  `Bearer …`, JWT, PEM private key header).

Manual handle tools require the task owner and cannot rewrite a closed attempt. During an
orchestrated execution only the generation-fenced adapter callback may save its handle.
The coordination database is shared between both agents and readable by any local supervisor, so
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

- Leases are **time-bounded** when no possibly running execution is attached. An expired
  lease without positive runtime stop evidence remains conflicting in `QUARANTINED` state.
- Expiry is evaluated **lazily** against the injected clock, so behaviour is deterministic
  under test and there is no background timer to get out of sync.
- Renewal of a lapsed lease is refused — the scope may already belong to someone else.
- The **same holder and task** may subdivide an overlapping scope only when no possibly
  running execution or quarantine is attached. Distinct tasks conflict even when their
  holder is identical. Subdivision cannot bypass quarantine.

Cancellation and stop confirmation are distinct. `bridge_cancel_task` durably records the
request and stops only that task. Its owner or the proven owner/creator of the direct parent
may request it; arbitrary parent mutation remains forbidden. Queued cancellation consumes
no attempt. Active cancellation waits for positive terminal evidence, fences late callbacks,
and quarantines the scope if stop cannot be confirmed. Codex uses correlated native App
Server turn identifiers; an interrupt RPC acknowledgement alone is insufficient. A terminal
notification with an unknown status is also insufficient. Shared servers are never killed
to cancel one task. Claude confirms its process and observed descendants have exited;
this is not containment of an adversarial detached descendant.

## Error codes

| Code | Retryable | Meaning |
| --- | --- | --- |
| `INVALID_ARGUMENT` | no | Payload failed schema validation, or a gate rejected it |
| `NOT_FOUND` | no | No such task, lease, or artifact |
| `ILLEGAL_TRANSITION` | no | The state machine forbids this edge |
| `NOT_OWNER` | no | Caller does not own the task / hold the lease |
| `SCOPE_CONFLICT` | **yes** | Another task or holder has an overlapping live lease |
| `LEASE_INVALID` | no | Lease expired or released; the write must not proceed |
| `DEPENDENCY_UNSATISFIED` | **yes** | Upstream tasks are not `DONE` yet |
| `DEPENDENCY_CYCLE` | no | The edge would create a cycle |
| `IDEMPOTENCY_MISMATCH` | no | Key reused with a different payload |
| `TIMEOUT` | **yes** | Adapter exceeded its deadline |
| `ADAPTER_FAILURE` | conditional | Retry only for a classified transient fault, positive stop and remaining budget |
| `RUNTIME_PROFILE_MISMATCH` | no | Runtime-reported model contradicts the bridge-owned profile |
| `RUNTIME_STOP_UNCONFIRMED` | no | Stop evidence missing; scope remains quarantined |
| `TELEMETRY_INCOMPLETE` | no | Strict observation criterion not met; business work may be complete |
| `OPERATION_IN_PROGRESS` | no | Existing operation, admission, provider wait or uncertain authorized launch |
| `TASK_CANCELLED` | no | Durable targeted cancellation |
| `INTERNAL` | **yes** | Unclassified fault |

Branch on `code` and typed `runtime_failure`, not message text. Runtime failure categories
are quota, auth, transient, profile, contract, turn_limit or unknown; their source is a
provider code or provider text. `retry_after_at` is null unless explicitly known from the
provider. Quota, auth, profile, contract and turn-limit faults do not automatically retry.

## Idempotency

Use `idempotency_key` where the tool schema exposes it. A replay returns the original response;
the key and its response are written in the same transaction as the mutation, so a crash
between the two cannot cache a response for work that rolled back. Reusing a key with a
different payload raises `IDEMPOTENCY_MISMATCH` rather than silently returning the old
answer.

Delegation reserves the entire normalized request, artifact identities/content hashes,
budgets and lineage durably. A stable key joins concurrent calls across processes and
replays a finished frozen outcome after restart. Launch authorization precedes invoking
the runtime; final outcome persistence shares the business transaction. An abandoned
prelaunch reservation may be reclaimed. An abandoned authorized operation becomes uncertain
and quarantined; it is never automatically invoked a second time. Long runtime calls and
artifact byte reads occur outside SQLite transactions. Schema v4 adds operation, execution
and observation records; existing v1-v3 history is migrated transactionally. A future or
malformed schema is refused before opening the original database for writes.

## Delegation

`DelegationRequest` requires a `deadline_ms`. That is the mechanism that stops open-ended
agent-to-agent loops: one request, one answer. A delegate that needs something it cannot
get returns `PARTIAL` with a blocker; it never opens a conversation back. Inputs are
artifact ids, so the delegate reads exactly what it was given, not a transcript.

`TaskSpec.max_turns` optionally selects a finite runtime ceiling from 1 through 64. Omission
keeps Claude's conservative default of 12. The field persists with the task, so strict
same-task recovery uses the same ceiling. It does not permit model or effort overrides:
bridge-created Claude workers always request `opus` with `high` effort.

The orchestrator releases the lease after positive stop confirmation. Timeout, transport
failure or a dead manager without that evidence retains quarantine beyond the lease TTL.

Scope contention during preparation records `BLOCKED` with `SCOPE_CONFLICT`, opens no
attempt and does not immediately retry. The existing task remains available for explicit
resolution through `bridge_continue_task`. Continuation preserves the same task, frozen
contract and original total deadline; its new key does not rewrite the original cached
contention outcome. `recover()` also reports `FAILED` tasks admitted by the durable interruption
check: no authored deliverable, an owner-matching closed attempt, a non-empty handle, and
`TIMEOUT` or `ADAPTER_FAILURE`. Discovery does not authorize or execute recovery.

Admission enforces the adapter's `max_concurrency` (Claude default 1, Codex default 2) in a FIFO queue.
`max_pending_invocations` bounds waiting calls (default 64); queued calls can abort without
affecting the active runner. SQLite also enforces a FIFO queue and shared per-agent capacity
across server processes using the same workspace database. A quarantined execution occupies
capacity until confirmed stopped. Separate databases do not share a concurrency bound.

New attempt telemetry may contain `attempt_started_at`, `attempt_wall_duration_ms`, and
`duration_measurement_version: 2`. These optional fields measure the attempt record's span
using the bridge clock. Missing or reversed clocks yield a null span. Existing records need
no rewrite. The legacy `wall_duration_ms` retains its elapsed-from-orchestration meaning
and is cumulative on automatic retries; do not sum it across attempts. Runtime-reported
`runtime_duration_ms` is a separate observation and is not redefined by this addition.
Version 2 separates delegation elapsed, queue, startup and work spans, with a provider_wall,
provider_api or local_span source for runtime duration. Unknown/reversed spans stay null.
Observation receipts separately measure sealing (`seal_measurement_version: 1`); telemetry's
`seal_duration_ms` remains null because its immutable record cannot measure its own commit.
The receipt span covers local sealing, not the enclosing transaction's durability time.

### Observations and native model selection

`spec.telemetry_mode` defaults to `operational`. A correlated completed Codex turn with no
usage notification can finish with null usage. `strict` requires accepted measurements.
Both modes preserve a completed business deliverable independently of observation storage,
schema or privacy errors. A typed observation receipt records COMPLETE, INCOMPLETE or
REJECTED; strict rejection returns `TELEMETRY_INCOMPLETE` without undoing business DONE.
Storage repair uses only the persisted validated draft through `bridge_repair_observation`,
never caller-supplied metrics or another model invocation. Privacy rejection stores no raw
telemetry, and legacy records are not assigned invented measurements.

The native Codex default transport is App Server; legacy MCP is opt-in. When an implicit
OpenAI model inherited from the desktop configuration is absent from the installed CLI's
official catalog, the adapter selects its uniquely advertised default before creating a
thread. Explicit unsupported models fail before launch; custom provider namespaces retain
their configured model. Actual model telemetry follows the runtime result. This selection
does not modify authentication or user configuration.

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
2. Stop only the targeted invocation when `ctx.signal` aborts. Native adapters report positive
   runtime lifecycle evidence through `ctx.reportRuntimeState`; promise rejection is not proof.
3. Never write outside `invocation.spec.scope`.
4. Be idempotent with respect to `invocation.idempotency_key`.
5. Report through `ctx` (`report`, `publishArtifact`, `recordVerification`, `raiseBlocker`) —
   callbacks are fenced by execution generation, owner, attempt, cancellation and live lease.

A reference implementation is `claude/claude-side/src/adapters/mock-codex-adapter.ts`.

## Event log

Append-only, monotonic `event_id`. Written in the same transaction as the state change it
describes, so the log can never disagree with the state. Tail it by polling
`bridge_read_events` with `after` set to `next_cursor` from the previous page and the same
`task_id` filter. `next_cursor` is the last returned event id, or the input `after` (default
zero) for an empty page. `has_more` indicates further matching events in the current read.
Poll again after an empty page to discover later appends. `head_event_id` is the global log
head. The deprecated `last_event_id` keeps its historical global-head meaning for existing
consumers; it is not a lossless pagination cursor. Event types are `EventType` in the protocol
package; `lease.denied` records near-collisions between the agents and is written outside
the failing transaction so it survives the rejection.

## MCP tool surface

Served over stdio by the agent-neutral `@bridge/mcp-server-core`; each native launcher binds
the caller identity. Names and full descriptions live in `shared/mcp-server-core/src/tools.ts`.

Discovery: `bridge_server_info`, `bridge_doctor`, `bridge_snapshot`, `bridge_list_tasks`, `bridge_get_task`, `bridge_check_scope`,
`bridge_read_events`.
Ownership: `bridge_create_task`, `bridge_claim_task`, `bridge_add_dependency`.
Scope: `bridge_acquire_lease`, `bridge_renew_lease`, `bridge_release_lease`.
Execution: `bridge_set_state`, `bridge_report_status`, `bridge_publish_artifact`,
`bridge_read_artifact`, `bridge_record_verification`, `bridge_block_task`.
Completion: `bridge_submit_deliverable`.
Coordination: `bridge_delegate`, `bridge_resume_task`, `bridge_resume_delegated_task`,
`bridge_cancel_task`, `bridge_continue_task`, `bridge_repair_observation`, `bridge_recover`,
`bridge_query_telemetry`. Direct-manager authority for cancellation, continuation and repair
uses the same durable ancestry checks as delegated recovery; it never transfers ownership.

Diagnostics and upgrade/rollback evidence boundaries are specified in
[BRIDGE_RELEASE_ROLLBACK.md](BRIDGE_RELEASE_ROLLBACK.md).
