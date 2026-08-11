# Usage

This project is experimental and pre-1.0; the workflows below may change between revisions.
See [release-policy.md](release-policy.md).

## Start from a native client

Open Claude Code or Codex from the repository root after installation and build. First call
`bridge_server_info` and verify that the returned caller matches the client:

- Claude Code: `caller=claude`
- Codex: `caller=codex`

If the identity is wrong, stop. Caller identity is bound when the server starts and must not
be overridden through tool arguments.

The project-local `using-bridge` skill is available to both clients. Invoke it explicitly for
bounded delegation, independent review, recovery, or telemetry work. It should not be used
for a trivial fact, a tiny local edit, overlapping writes, or merely to involve both models.

## Normal manager workflow

1. Call `bridge_server_info` once for the native session and confirm the bound identity and
   delegation policy. Call `bridge_snapshot` only if concurrent tasks or leases are plausible.
2. Create one depth-0 root task with an objective, scope, expected deliverable, and real
   verification criteria.
3. Claim the root and move it to `WORKING`.
4. Delegate a bounded child with `bridge_delegate`, a deadline, the root `run_id`, the root
   `task_id` as parent, and depth 1. For Claude work, optionally set `spec.max_turns` only
   when the conservative default is too small for the bounded objective.
5. Consume the child's structured deliverable and reliable worker telemetry.
6. Verify the result, submit the root deliverable, and confirm final states.

Do not invoke the target CLI directly when testing the bridge path. If a runtime is
unavailable, report that failure without creating replacement child tasks.

When a child returns `PARTIAL`, consume its evidence and blocker without upgrading it to
success or creating a sibling replacement. Recovery keeps the same durable task and runtime
session when that task is eligible and its owner can resume it.

## Claude worker profile and turn budget

The bridge runtime, not the manager or `using-bridge` skill, owns Claude selection. Every
fresh and resumed Claude worker is launched through the supported Claude Code interface with
`--model opus --effort high`. Ordinary task and delegation payloads have no model or effort
override. If Claude Code reports an actual non-Opus model, the attempt fails with
`RUNTIME_PROFILE_MISMATCH`; if it reports no model, telemetry keeps the actual model `null`
rather than inventing a version.

Claude turn ceilings are finite and task-specific:

- minimum: 1;
- conservative default: 12;
- maximum: 64;
- recommended starting value for a bounded repository audit: 32.

Set `max_turns` on the persisted `TaskSpec`. Invalid values are rejected. The persisted value
therefore follows the same task into strict recovery; trivial tasks should omit it and keep
the default.

## Worked example: Claude Code → Codex

Run Claude Code from the repository root and ask for one bounded delegation:

> Use the bridge MCP. Confirm `caller=claude`, then create and claim one depth-0 root task for
> "add a regression test for expired-lease renewal". Delegate exactly one depth-1 child to
> Codex with write scope `shared/control-plane/src/**`, a 15-minute deadline,
> `max_attempts: 0`, and the verification criterion "`npm test` passes". Consume the child's
> structured deliverable, verify it yourself, then submit the root deliverable. Report
> lineage, final states, and worker telemetry without exposing execution handles.

What should happen: one `bridge_server_info` call, one root task created and claimed, one
`bridge_delegate` carrying the root `run_id`, the root `task_id` as `parent_task_id`, and
depth 1. The orchestrator claims, leases, runs, and finalizes the child; the manager does not
touch the child's lifecycle. The manager then verifies the result with its own real check and
submits the root deliverable.

## Worked example: Codex → Claude

Run Codex from the repository root and ask for the symmetric flow, here read-only:

> Use the bridge MCP. Confirm `caller=codex`, then create and claim one depth-0 root task for
> "review the lease-expiry logic". Delegate exactly one depth-1 child to Claude with scope
> `(no-write)/**`, a 10-minute deadline, `max_attempts: 0`, and the verification criterion
> "cites concrete file:line evidence". Consume the child's structured deliverable, verify it
> yourself, then submit the root deliverable. Report lineage, final states, and worker
> telemetry without exposing execution handles.

The Claude child is launched by the bridge with `--model opus --effort high`; the Codex
manager cannot change that in the delegation payload. A read-only child returns
`changed_scope: []` and compact inline evidence rather than publishing a repository path as
though it were an output file.

## Ownership and leases

- Exactly one agent owns a task, and claiming a task is not permission to write.
- A file-writing task declares repo-relative scope globs and acquires a lease before editing.
  An overlapping live lease held by another agent is rejected with `SCOPE_CONFLICT`.
- Overlap detection is conservative: patterns that cannot be proven disjoint are treated as
  conflicting. A false conflict costs a retry; a false clearance costs corrupted files.
- Leases are time-bounded and expire lazily, so a crashed agent cannot deadlock the
  repository. Renewing a lapsed lease is refused, because the scope may already belong to
  someone else.
- On `NOT_OWNER`, stop the mutation. Do not finish, block, repair, or release another agent's
  task or lease.
- Read-only tasks declare `(no-write)/**` and make no source changes.

Bridge scopes and leases are coordination contracts enforced by the control plane, not an
operating-system sandbox.

## Completion

A task can submit `COMPLETE` only with at least one passing verification and no failing
verification. Use the exact command and real exit code. Return `PARTIAL` or `FAILED` when the
evidence does not support completion.

See [PROTOCOL.md](PROTOCOL.md) for the complete tool surface and lifecycle, and
[troubleshooting.md](troubleshooting.md) when a call is rejected with a stable error code.
