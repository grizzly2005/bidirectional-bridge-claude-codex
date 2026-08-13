---
name: using-bridge
description: Coordinate Claude Code and Codex through the repository-local bridge MCP for substantial multi-file implementation, security or architecture review, nontrivial diagnosis, verification, recovery, and bounded independent review. Use when the user asks for the bridge or another runtime, or when a substantial task has a useful separable child. Keep trivial, one-command, tightly coupled, or explicitly single-agent work local.
---

# Use the Bridge

Use the bridge as a coordination layer, not as a reason to involve another agent. Keep the current native client responsible for the user request; delegate only a bounded subtask whose expected value exceeds startup, context, and verification overhead.

## Choose the path

- **Delegate:** assign one independent, verifiable subtask to the other runtime.
- **Review:** ask the other runtime for a bounded, usually read-only, independent review.
- **Recover:** resume one known stranded task in place after quota, timeout, crash, or process interruption.
- **Observe:** inspect telemetry or events only when the user requests them, during dogfooding, or for diagnosis.
- **Do not use the bridge:** complete trivial, tightly coupled, or cheaper single-agent work locally.

If this session is already a delegated worker with a supplied `task_id`, scope, expected deliverable, and verification criteria, complete that contract. Do not create a new root or delegate again unless the contract explicitly permits it.

## Decide whether to delegate

Delegate only when all are true:

1. The child task is independently understandable from a compact contract.
2. Its write scope is disjoint, or it is read-only.
3. Its output and verification criteria are explicit.
4. The other runtime adds distinct implementation, diagnosis, review, or research value.
5. The manager can consume and verify the result without prolonged back-and-forth.

Do not delegate:

- a trivial command, fact lookup, or tiny edit the manager can finish immediately;
- work requiring continuous conversation between agents;
- overlapping writes to the same files or module;
- ambiguous work missing authority, scope, or acceptance criteria;
- work with no meaningful verification;
- merely to collect telemetry or “use both models”;
- when the user forbids the bridge.

Treat an exact user-requested delegation count as a hard limit.

## Delegation checkpoint for substantial work

For every substantial request, determine whether one bounded child task would improve
implementation quality, security, diagnosis, verification, or independent review.

Treat work as substantial when one or more apply:

- multiple files or components change;
- architecture or design decisions are needed;
- the task is security-sensitive;
- diagnosis is nontrivial;
- multiple independent workstreams exist;
- an independent final review is valuable;
- failure would be expensive or difficult to detect.

When a substantial task contains an independently understandable, verifiable,
non-overlapping subtask, prefer one bounded child instead of keeping the entire request with
the manager. A second child is allowed by default only for a truly independent scope or a
separate read-only final review. Do not exceed two children by default, and treat an exact
user-requested delegation count as a hard limit.

Read `references/routing-policy.md` when making a nontrivial routing decision. Do not rerun
benchmarks, search for model rankings, route from quota consumption, or delegate merely to
achieve a usage percentage during ordinary work.

## Fast path for bounded children

1. **Confirm the server once per fresh native session.** Call `bridge_server_info`. Cache the bound `caller` and `delegation` policy. Stop if identity is wrong or delegation is denied.
2. **Reuse existing state when present.** Do not create a duplicate root if the current interaction already has one.
3. **Create one manager root when needed.** Use `bridge_create_task`, then `bridge_claim_task`, then move it to `WORKING` with `bridge_set_state`.
4. **Lease only manager writes.** If the manager will edit files, acquire its own scope with `bridge_acquire_lease`; a read-only root needs no write lease.
5. **Delegate the selected child.** Call `bridge_delegate` with the root `run_id`, root `task_id` as `parent_task_id`, depth `1`, a bounded task spec, necessary artifact IDs, a realistic deadline, and normally `max_attempts: 0`. A second child needs the checkpoint justification above. Omit caller identity; the server binds it.
6. **Let the orchestrator manage the child.** Do not manually create, claim, lease, finalize, or save handles for the child.
7. **Consume the structured result.** Check that it answers the actual user request. Preserve `PARTIAL` or `FAILED` honestly.
8. **Verify proportionately as manager.** Use real evidence appropriate to the task. Do not treat the worker’s claim as sufficient by itself.
9. **Finish the root.** Submit the manager deliverable with `bridge_submit_deliverable`; `COMPLETE` requires at least one real passing check and no failing check.
10. **Release manager leases.** Release any lease acquired manually for the root.

Do not narrate every MCP call to the user. Report the delegated contribution, verification, and remaining risk succinctly.

## Write a bounded child contract

Include:

- one-sentence objective;
- repo-relative write globs, or `(no-write)/**` for read-only work;
- dependencies;
- expected deliverable;
- at least one concrete verification criterion;
- only necessary input artifact IDs;
- realistic deadline;
- normally zero automatic retries.

The bridge runtime owns Claude model/effort selection; managers must not override it.

Preserve the root `run_id`, set `parent_task_id` to the root task, and set child depth to parent depth plus one. Never pass full chat history when a compact task contract and artifact references suffice.

For substantial audits or reports, keep `summary` concise, publish the complete detail as a durable report artifact (inline when size permits), and reference its artifact id in the deliverable. Real checks count only in canonical `verification_results`; `verification_performed` is derived and prose claims are not evidence.

Read `references/contracts.md` when constructing an unfamiliar payload or validating a worker result.

## Respect ownership and leases

- Mutate only tasks owned by the bound caller.
- A manager may request strict recovery of its direct delegated child only through
  `bridge_resume_delegated_task`; this does not transfer ownership or authorize other child
  mutations.
- Claiming a task is not write permission; acquire a lease before manual writes.
- Do not write in another holder’s overlapping scope.
- On `NOT_OWNER`, stop the mutation. Do not steal, finish, block, repair, or release a lease for the other agent’s task.
- On `SCOPE_CONFLICT`, wait and recheck, narrow to provably disjoint work, or return a blocker.
- Publish only outputs produced for the owned task and inside its scope.
- For read-only work, use `changed_scope: []` and prefer compact inline evidence over path artifacts.

The server enforces core invariants, but shell access is not an OS-level scope sandbox. Continue to respect the declared scope.

## Prevent loops and duplication

- Use one bounded request and one structured answer.
- Never substitute a direct Claude or Codex invocation for `bridge_delegate`.
- Never delegate to an agent already in the active ancestor chain.
- A delegated worker must not delegate recursively unless its explicit bounded contract permits
  that safe action.
- Do not create a sibling replacement because a child is slow, blocked, quota-limited, or interrupted.
- Do not redo a delegated task while it is active.
- Decompose broad repository-wide work into bounded subtasks when possible instead of relying on an extreme turn budget.
- Do not exceed two children by default, the user’s requested delegation count, or the bridge
  depth limit.

## Handle results honestly

- `COMPLETE`: objective satisfied, with real passing verification and no failing verification.
- `PARTIAL`: useful progress exists but action, evidence, quota, authority, or certainty is missing; task remains blocked.
- `FAILED`: the bounded objective failed rather than merely waiting on an external condition.

Use exact changed paths only. An inspected file is not a produced artifact. A path artifact must exist and fit the leased output scope; otherwise use an inline report. Never invent checks, paths, test totals, or successful exit codes.

## Recover a stranded task

Use recovery only for a known existing task with persisted runtime state.

Recovery continues the same durable task and runtime session; never redelegate as a substitute.

1. Call `bridge_recover` to expire dead leases and identify stranded state.
2. Read the specific task with `bridge_get_task`; do not print its raw execution handle.
3. Choose one recovery path and call it once:
   - if the bound caller owns the task, use `bridge_resume_task`;
   - if the bound caller owns the direct parent and created the delegated child, use
     `bridge_resume_delegated_task` from the manager client.
4. Do not open the other native client merely for recovery. The bridge derives the child
   owner/runtime from durable state and uses that worker identity internally; do not spoof an
   owner or use a direct CLI fallback.
5. Keep the same task, owner, run, parent, scope, and runtime session/thread. Recovery creates
   a new adjacent attempt and a fresh worker-owned lease.
6. If strict resume fails, leave the same task blocked and report the exact reason. Do not
   create a replacement task or fresh thread.

Read `references/recovery-and-failures.md` for failure-specific actions.

## Use telemetry conditionally

Call `bridge_query_telemetry` only when requested, during dogfooding, or for diagnosis. Query once after the relevant attempt rather than polling.

Report only authoritative records:

- runtime, version, and model when supplied by the runtime;
- input, output, cached, cache-creation, and total tokens;
- turns, durations, termination, and runtime-reported cost semantics.

Leave unknown values `null`; never estimate. Cached token fields are dimensions of input usage, not extra tokens to add again. Interactive manager sessions may have no attempt telemetry; do not invent manager totals. Never expose raw execution handles, prompts, transcripts, credentials, or private trust state.

## Minimize bridge overhead

- Call `bridge_server_info` once per native session, not before every operation.
- Skip `bridge_snapshot` unless concurrent ownership is plausible.
- Avoid routine `bridge_list_tasks`, `bridge_read_events`, and repeated `bridge_get_task` polling.
- Put all necessary context into one compact contract.
- Pass artifact references, not transcripts.
- Default to `max_attempts: 0`; add retries only for a justified transient failure.
- Use meaningful status milestones only.
- Let `bridge_delegate` manage child claim, lease, attempt, artifacts, verification, and finalization.
- Query telemetry once and only when useful.

When exact tool inputs or outputs are uncertain, read `references/tool-map.md` and prefer the live MCP schema over stale prose.
