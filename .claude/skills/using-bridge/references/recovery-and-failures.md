# Recovery and failure actions

Load this reference only for a blocked, failed, interrupted, or stranded bridge task.

## Recovery sequence

1. Call `bridge_recover` to expire dead leases and identify stranded tasks.
2. Call `bridge_get_task` for the exact task. Do not expose the raw handle.
3. Confirm the task is non-terminal, persisted strict-resume state exists, and no live attempt
   or conflicting lease exists.
4. Choose one path, preferably with an idempotency key:
   - current caller owns the task: call `bridge_resume_task` once;
   - current caller owns the direct parent and created its delegated child: call
     `bridge_resume_delegated_task` once.
5. For manager recovery, let the bridge derive the child owner and runtime from SQLite. Do not
   open the other native client, spoof ownership, or invoke the worker CLI directly.
6. Expect the same durable task, owner, lineage, and runtime session/thread, a new adjacent
   attempt, `resumed_from_attempt`, a fresh worker-owned lease, separate worker telemetry, and
   automatic lease release.
7. If resume fails, leave the same task blocked and report the exact failure. Never create a
   replacement sibling or fresh thread.

## Failure decisions

| Condition | Do | Do not |
|---|---|---|
| `QUOTA_EXHAUSTED` | Label a runtime-quota blocker; stop; resume the same eligible task after quota returns. | Do not call the target directly or create a replacement child. |
| `RUNTIME_UNAVAILABLE` | Report runtime unavailable and preserve durable state. | Do not bypass the bridge with a direct CLI invocation. |
| `TIMEOUT` | Assume partial work may exist; inspect the specific durable task; use only the declared retry budget or strict recovery. | Do not blindly restart or duplicate work. |
| Child `BLOCKED` / `PARTIAL` | Consume useful evidence and blocker at the parent; resolve or report it. | Do not mutate the child as manager or upgrade it to complete. |
| `NOT_OWNER` | Stop the mutation; read state if needed. | Do not steal ownership, finish the task, or release another holder’s lease. |
| `SCOPE_CONFLICT` | Wait and recheck, narrow to disjoint scope, or return a blocker. | Do not steal or overlap the lease. |
| Validation failure | Correct the payload/result once using existing real evidence. | Do not rerun completed work or invent paths/checks. |
| Failed recovery | Report the same task, new attempt, lineage, and exact reason. | Do not create a sibling task or fresh runtime thread. |

## Parent/child boundary

A parent manager may read a child result but cannot block, finish, or otherwise mutate a child
owned by the other runtime. The narrow recovery exception is
`bridge_resume_delegated_task`: durable state must prove that the caller owns the direct parent
and created that child. The bridge then executes as the unchanged child owner. This permission
does not extend to unrelated tasks, siblings from another manager, or non-direct descendants.
After the child reaches a terminal result, the manager consumes it and finalizes its own root.
