# Recovery

Recovery continues an interrupted execution without inventing a replacement task or runtime
thread.

## Persisted handle model

Each attempt may store an opaque execution handle: a Claude session identifier or Codex
thread identifier. The adapter saves it as soon as the runtime exposes it. The control plane
caps and credential-screens the value, never parses it, and excludes it from events,
telemetry, proof exports, and user-facing reports.

## Recovery entry points

There are two explicit ways to request the same strict recovery operation. Both accept only
an existing `task_id` and an optional idempotency key. Caller identity is bound when the MCP
process starts; neither operation accepts an owner, agent, runtime, lineage, scope, or handle.

- `bridge_resume_task` is direct owner recovery. The bound caller must own the task.
- `bridge_resume_delegated_task` lets a manager request recovery of its direct delegated
  child. SQLite must prove that the caller owns the direct parent, created the child, and that
  parent and child have the expected same-run, adjacent-depth lineage. The caller must not be
  the child owner; an owner uses `bridge_resume_task`.

Manager authorization does not transfer ownership or make the manager the execution agent.
For delegated recovery, the child owner remains the identity used for adapter selection, task
transitions, attempt records, lease ownership, invocation callbacks, verification,
deliverables, telemetry, and handle persistence. Unrelated tasks, another manager's child,
and non-direct descendants are rejected.

After authorization, the control plane derives the owner, run lineage, write scope, previous
attempt, and persisted handle from SQLite. It then:

1. verifies that the task is stranded and recoverable;
2. rejects live or conflicting leases;
3. reserves a fresh lease and shared FIFO admission record;
4. after admission, closes the interrupted attempt and creates the adjacent recovery attempt;
5. requires the adapter to resume the exact stored handle;
6. persists the business outcome and typed observation receipt, releasing the lease only
   after positive runtime stop confirmation. Unconfirmed stops keep quarantine.

Input bytes are resolved and validated outside the reservation transaction. Cancellation
while queued opens no new attempt. An abandoned prelaunch reservation can be safely closed;
an abandoned authorized launch cannot be automatically invoked again. Completed replay
returns the same frozen typed outcome, including strict observation rejection.

Recovery preserves the stored contract, turn ceiling and original total elapsed deadline.
Quota waits consume that deadline. Provider quota/auth faults do not automatically retry,
and a provider-supplied future retry time blocks immediate recovery. Profile and contract
faults require diagnosis rather than an unchanged retry. No quota reset is inferred.

A stale handle, wrong returned handle, failed strict resume, timeout, or runtime crash does
not authorize a fresh thread. The task remains honestly blocked or failed according to the
recorded outcome.

## Operator workflow

1. Call `bridge_recover` to reconcile leases and identify stranded state. Quarantine is
   retained when a worker may still be running.
2. Inspect the task with `bridge_get_task`; do not request or print its raw handle.
3. Choose exactly one path:
   - if the bound caller owns the task, call `bridge_resume_task` once;
   - if the bound caller owns the task's direct parent and created that child, call
     `bridge_resume_delegated_task` once from the manager client.
4. Do not open the other native client merely for recovery. The bridge invokes the child's
   persisted owner/runtime internally; never use a direct CLI fallback or replacement child.
5. Verify the same task ID, owner, run, parent, depth, objective, scope, exact-session result,
   adjacent attempt, `resumed_from_attempt`, positive stop evidence, fresh worker-owned lease
   release or honest quarantine, final business state, and observation receipt.

## Other bounded operations

`bridge_cancel_task` durably cancels only the target invocation. `runtime_stop_confirmed`
distinguishes actual stop from the cancellation request. Codex requires a correlated known
terminal turn status; interrupt RPC acknowledgement alone is insufficient. Claude verifies
its process and observed descendants, without claiming OS containment of detached processes.

`bridge_continue_task` applies to the same task blocked by scope contention before runtime
launch. It requires a new stable continuation key and uses the frozen inputs and original
budget; it does not need a runtime handle or rewrite the cached contention outcome.

`bridge_repair_observation` seals only an existing validated draft after a storage fault.
It accepts no supplied metrics and invokes no model. Privacy/schema rejection is preserved.

These operations authorize the task owner or proven direct parent owner/child creator,
without ownership transfer or arbitrary child state/handle/lease writes. For migration,
startup identity and compatible rollback, see [BRIDGE_RELEASE_ROLLBACK.md](BRIDGE_RELEASE_ROLLBACK.md).

Recovery semantics and state transitions are specified in [PROTOCOL.md](PROTOCOL.md) and
covered deterministically by `shared/control-plane/src/recovery.test.ts`. For symptom-first
guidance when a resume is refused, see
[troubleshooting.md](troubleshooting.md#strict-resume-fails).
