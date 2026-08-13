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
3. closes the interrupted attempt and creates the adjacent recovery attempt;
4. acquires a fresh lease over the original scope;
5. requires the adapter to resume the exact stored handle;
6. seals final telemetry and releases the lease on every exit path.

A stale handle, wrong returned handle, failed strict resume, timeout, or runtime crash does
not authorize a fresh thread. The task remains honestly blocked or failed according to the
recorded outcome.

## Operator workflow

1. Call `bridge_recover` to identify stranded state and expire dead leases.
2. Inspect the task with `bridge_get_task`; do not request or print its raw handle.
3. Choose exactly one path:
   - if the bound caller owns the task, call `bridge_resume_task` once;
   - if the bound caller owns the task's direct parent and created that child, call
     `bridge_resume_delegated_task` once from the manager client.
4. Do not open the other native client merely for recovery. The bridge invokes the child's
   persisted owner/runtime internally; never use a direct CLI fallback or replacement child.
5. Verify the same task ID, owner, run, parent, depth, objective, scope, exact-session result,
   adjacent attempt, `resumed_from_attempt`, fresh worker-owned lease release, final state,
   and worker telemetry.

Recovery semantics and state transitions are specified in [PROTOCOL.md](PROTOCOL.md) and
covered deterministically by `shared/control-plane/src/recovery.test.ts`. For symptom-first
guidance when a resume is refused, see
[troubleshooting.md](troubleshooting.md#strict-resume-fails).
