# Recovery and failure actions

Load this reference only for a blocked, failed, interrupted, or stranded bridge task.

## Recovery sequence

1. Call `bridge_recover` to expire dead leases and identify stranded tasks.
2. Call `bridge_get_task` for the exact task. Do not expose the raw handle.
3. Confirm the current caller owns the task, a persisted handle exists, no live attempt or conflicting lease exists, and the task is non-terminal.
4. Call `bridge_resume_task` once, preferably with an idempotency key.
5. Expect the same durable task and runtime session/thread, a new adjacent attempt, `resumed_from_attempt`, a fresh lease, separate telemetry, and automatic lease release.
6. If resume fails, leave the same task blocked and report the exact failure. Never create a replacement sibling or fresh thread.

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

A parent manager may read a child result but cannot block, finish, resume, or otherwise mutate a child owned by the other runtime. The child owner performs recovery. After the child reaches a terminal result, the manager consumes it and finalizes its own root.
