# Recovery

Recovery continues an interrupted execution without inventing a replacement task or runtime
thread.

## Persisted handle model

Each attempt may store an opaque execution handle: a Claude session identifier or Codex
thread identifier. The adapter saves it as soon as the runtime exposes it. The control plane
caps and credential-screens the value, never parses it, and excludes it from events,
telemetry, proof exports, and user-facing reports.

## Same-task recovery

`bridge_resume_task` accepts an existing `task_id` and optional idempotency key. The control
plane derives the owner, run lineage, write scope, previous attempt, and persisted handle
from SQLite. It then:

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
3. Have the existing owner call `bridge_resume_task` once.
4. Verify the same task ID, adjacent attempt, `resumed_from_attempt`, fresh lease release,
   final state, and worker telemetry.

Recovery semantics and state transitions are specified in [PROTOCOL.md](PROTOCOL.md) and
covered deterministically by `shared/control-plane/src/recovery.test.ts`. For symptom-first
guidance when a resume is refused, see
[troubleshooting.md](troubleshooting.md#strict-resume-fails).
