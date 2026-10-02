# Recovery and failure actions

Load this reference for a blocked, failed, interrupted, or stranded bridge task, or an
incomplete observation. Read the durable state before invoking a runtime again.

## Recovery sequence

1. Call `bridge_recover` to reconcile leases and identify stranded tasks. An expired lease
   attached to a possibly running worker stays quarantined; discovery invokes no model.
2. Call `bridge_get_task` for the exact task. Inspect attempts, execution and observation;
   do not expose the raw handle.
3. Confirm persisted strict-resume state, positive stop evidence, and no live execution or conflicting lease
   exists. A `FAILED` task is eligible only when it has no authored deliverable and its
   owner-matching closed attempt contains a handle and `TIMEOUT` or `ADAPTER_FAILURE`.
   `DONE`, `CANCELLED`, authored failures, and failures without handles stay excluded.
4. Choose one path with a stable idempotency key:
   - current caller owns the task: call `bridge_resume_task` once;
   - current caller owns the direct parent and created its delegated child: call
     `bridge_resume_delegated_task` once.
5. For manager recovery, let the bridge derive the child owner and runtime from SQLite. Do not
   open the other native client, spoof ownership, or invoke the worker CLI directly.
6. Admission precedes the adjacent attempt. Expect the same task, owner, lineage, scope,
   exact session/thread, `resumed_from_attempt`, and fresh worker-owned lease. Release follows
   positive stop confirmation; an unconfirmed stop retains quarantine.
7. If resume fails, leave the same task blocked and report the exact failure. Never create a
   replacement sibling or fresh thread.

## Failure decisions

| Condition | Do | Do not |
|---|---|---|
| Runtime `quota` / `auth` | Preserve the same child; resolve provider availability before explicit eligible resume within the original budget. | No automatic retries, direct calls or replacement child. |
| Runtime `profile` / `contract` | Diagnose incompatible runtime/configuration or request. | Do not retry an unchanged contract. Explicit unsupported Codex models are refused before launch. |
| Runtime `transient` | Retry only with positive stop evidence, remaining declared budget and no future provider retry time. | Do not ignore `retry_after_at`. |
| Runtime `turn_limit` | Preserve checkpoint and real checks. | Do not silently raise the stored ceiling or replace the child. |
| `RUNTIME_UNAVAILABLE` | Report runtime unavailable and preserve durable state. | Do not bypass the bridge with a direct CLI invocation. |
| `TIMEOUT` | Assume partial work may exist; inspect the specific durable task; use only the declared retry budget or strict recovery. | Do not blindly restart or duplicate work. |
| `RUNTIME_STOP_UNCONFIRMED` | Keep the scope quarantined until positive stop evidence. | Do not treat interrupt ACK, abort, rejected promise or TTL as proof; do not force release or kill a shared server. |
| `OPERATION_IN_PROGRESS` / uncertain authorized launch | Reconcile the existing operation. | Do not bypass uncertainty with a fresh delegation key. |
| Child `BLOCKED` / `PARTIAL` | Consume useful evidence and blocker at the parent; resolve or report it. | Do not mutate the child as manager or upgrade it to complete. |
| `NOT_OWNER` | Stop the mutation; read state if needed. | Do not steal ownership, finish the task, or release another holder’s lease. |
| Prelaunch `SCOPE_CONFLICT` | Resolve contention, then `bridge_continue_task` on the same task with a new stable continuation key. | Do not replace the frozen contract, inputs, lineage or budget. |
| Completed business, incomplete observation | `bridge_repair_observation` seals the validated stored draft without a model call. | Do not rerun business work or supply invented metrics. |
| Observation `REJECTED` | Preserve the typed privacy/schema rejection. | Do not export the raw payload or bypass validation. |
| Validation failure | Correct the payload/result once using existing real evidence. | Do not rerun completed work or invent paths/checks. |
| Failed recovery | Report the same task, new attempt, lineage, and exact reason. | Do not create a sibling task or fresh runtime thread. |

`runtime_failure.source` distinguishes provider code from provider text. A category does
not prove a reset time; `retry_after_at` stays `null` unless the provider supplied a known
time. Do not invent a schedule or activate an automation. Resume the same eligible task
only after availability is confirmed. A `max_turns` result should include a
durable checkpoint and real checks; narrow the contract before retrying. Recovery currently
retains the persisted turn ceiling and total elapsed deadline; it does not grant a budget
extension. Queued cancellation and failed input/preparation do not consume a runtime attempt.

## Parent/child boundary

A proven direct manager may use `bridge_resume_delegated_task`, `bridge_cancel_task`,
`bridge_continue_task`, and `bridge_repair_observation`. It must own the direct parent and
have created the child in that run with adjacent depth. These narrow operations preserve the
child owner as execution identity. They do not authorize arbitrary state, handle or lease
writes, unrelated tasks, another manager's child, or non-direct descendants.

Cancellation records the request durably, stops only that invocation, and reports whether
runtime stop is confirmed. Queued work can cancel without a model call; active work requires
positive terminal evidence. Preserve quarantine when confirmation is missing. Native Codex
uses correlated App Server turns; native Claude checks its process and observed descendants.
These are coordination safeguards, not OS containment of an adversarial detached process.

Operational mode preserves the business result when usage or observation storage is
unavailable. Strict mode preserves that result but rejects unmet measurement criteria
separately. Repair is idempotent and never invokes the worker. Consume the child's result
and finalize the parent's own root with honest verification.
