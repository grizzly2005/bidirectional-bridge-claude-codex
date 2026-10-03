# Bridge tool map

Use the live MCP schema as the final authority. Load this map only when the exact tool purpose or expected use is unclear.

## Common manager flow

| Tool | Use |
|---|---|
| `bridge_server_info` | Confirm bound caller and delegation policy once per fresh session. |
| `bridge_doctor` | Diagnose startup identity versus current disk and safe aggregate state; does not call models or prove provider availability. |
| `bridge_create_task` | Create a depth-0 manager root with objective, scope, dependencies, deliverable, and verification criteria. |
| `bridge_claim_task` | Atomically own the root. Claiming is not write permission. |
| `bridge_set_state` | Move the owned root to `WORKING`. |
| `bridge_acquire_lease` | Acquire scope before manager file writes. Delegated child leases are automatic. |
| `bridge_delegate` | Create and execute one bounded child through the opposite runtime. |
| `bridge_submit_deliverable` | Finalize the owned root with structured result and real verification. |
| `bridge_release_lease` | Release a manually acquired manager lease. |

## Conditional task and coordination tools

| Tool | Use |
|---|---|
| `bridge_list_tasks` | Check for duplication or unknown state; avoid routine polling. |
| `bridge_get_task` | Inspect one task after ambiguity, interruption, or recovery. |
| `bridge_check_scope` | Check live and quarantined overlaps; same-task subdivision is permitted only when no possibly running execution is attached. |
| `bridge_renew_lease` | Extend an unusually long active lease; cannot revive an expired lease. |
| `bridge_report_status` | Record meaningful milestones, not narration. |
| `bridge_publish_artifact` | Publish an owned, in-scope output; inline limit is 64 KiB. |
| `bridge_read_artifact` | Read a declared input or result artifact. |
| `bridge_record_verification` | Persist real verification incrementally; submission may carry it directly. |
| `bridge_block_task` | Block an owned task honestly. Never block another owner’s child. |
| `bridge_add_dependency` | Add a dependency to a task the agent controls; cycles are rejected. |
| `bridge_snapshot` | Inspect counts, ready tasks, adapters, and live leases when concurrency matters. |

## Optional visual observation

| Tool | Use |
|---|---|
| `bridge_tracking_open` | Open the read-only view on explicit request, before a long delegation; choose `display: "browser"` if the native host lacks MCP Apps. |
| `bridge_tracking_bind` | Widget selects an existing run; `run_id: null` restores automatic follow. |
| `bridge_tracking_read` | Widget polls a safe snapshot and signed cursor; not routine model polling. |
| `bridge_tracking_history` | Widget pages existing runs with a signed, filter-bound token. |
| `bridge_tracking_close` | Close the view; `disable: true` also opts out. Neither action cancels work. |

Read [tracking-ui.md](tracking-ui.md) for observation-only ChatGPT connections and host limits.

## Recovery and debugging tools

| Tool | Use |
|---|---|
| `bridge_recover` | Expire dead leases and report stranded tasks; it does not retry work. |
| `bridge_resume_task` | Strictly resume one owned, recoverable task using persisted runtime state. |
| `bridge_resume_delegated_task` | Let a direct parent owner request strict recovery of its delegated child; the child owner remains the execution identity. |
| `bridge_cancel_task` | Request durable targeted cancellation as owner or proven direct manager; inspect `runtime_stop_confirmed`, and preserve quarantine when false. |
| `bridge_continue_task` | Continue the same prelaunch contention-blocked task with a required stable continuation key and its original budget; no runtime handle is needed. |
| `bridge_repair_observation` | Seal the stored validated observation draft as owner or proven direct manager; no supplied metrics and no model call. |
| `bridge_read_events` | Page with `next_cursor` as `after` and a stable `task_id`; `has_more` signals another page. `head_event_id` and legacy `last_event_id` are global heads, not pagination cursors. |
| `bridge_query_telemetry` | Query final attempt telemetry after completion when requested or diagnosing. |
| `bridge_set_execution_handle` | Owner-only manual plumbing for a current open attempt; cannot overwrite a closed attempt or the fenced callback of an active orchestrated execution. |
| `bridge_get_execution_handle` | Owner-only sensitive debug access; never expose the value. Managers recover through lineage instead. |

Use keys wherever the live schema accepts them. Replaying the same delegation key and
payload returns its original durable result; reusing a key with different data yields
`IDEMPOTENCY_MISMATCH`. Cancellation and observation repair are idempotent by durable state.
`bridge_set_state` to `CANCELLED` routes owned work through cancellation; a direct manager
uses `bridge_cancel_task`. Other state mutations remain owner-only.
