# Experimental control-plane changes

These changes belong to the experimental branch. Keep its `.bridge` database and runtime
state separate from the original checkout and release state.

## Schema 5 and verification attempts

The writable control-plane store migrates historical schemas 1–5 to schema 6 in one
transaction. It adds nullable `attempt` columns to `verifications` and `deliverables`,
then creates the verification attempt index. Historical IDs, JSON, other fields, and
events remain intact. Historical rows retain `attempt = NULL`: neither timestamps nor
the task's current attempt establish when those checks actually ran.

New verification callbacks pass the execution's fenced attempt explicitly. A runtime
commit also supplies that attempt; an obsolete attempt is refused. Manual/native
submissions bind to the task's current attempt inside the owner-check transaction.
`COMPLETE` merges only checks from that attempt with the submitted checks. The submitted
copy still wins for the same `(kind, command)` within the attempt, as in the existing
trust contract. A resumed runtime can redeclare an old check in its final JSON; the
control plane does not possess an execution receipt that proves its actual freshness.

`listVerifications(taskId)` retains the historical projection. Pass a numeric attempt
to inspect that attempt, or `null` to inspect the rows whose attempt is unknown.
Historical or prior-attempt passes cannot satisfy a new empty `COMPLETE`; old failures
cannot reject a fresh pass. Tasks recovered from schema 4 must provide new verification.

Older schema-4/5 release code refuses schema 6 state. Opening the original database with this
experimental store would make it incompatible with that release; use a separate state
directory and retain a backup before any intended production migration. There is no
automatic downgrade. The tracking reader accepts schemas 4 and 5 without migration or
writes. In schema 5 it counts only the current attempt, including canonical final checks;
schema 4 retains its historical totals because their freshness is unknown. The offline
doctor discovers the source-supported schema from `SCHEMA_VERSION`. The reader also accepts
schema 6 with the same attempt-freshness semantics as schema 5.

## Shared working-memory revisions (schema 6)

`ControlPlane.memory` exposes upsert, getContext and getChanges. Schema 6 adds immutable
`memory_notes` revisions without altering canonical task, artifact or audit data. Exact
namespace/context/branch/version/epoch scope and key identify a note. A write binds author,
run/task/attempt from the caller's owned current task; expected_revision and idempotency
prevent silent overwrite. The note, `memory.updated` event and retry cache commit atomically.

Context reads default to current active notes, preserve artifact IDs/hashes and report source
integrity without loading bodies. They have a byte budget and stable snapshot/key pagination.
Changes return all revisions, including superseded/archived, with a last-delivered cursor.
See [shared-memory.md](../../docs/shared-memory.md) for the MCP contract and restart test.

## Preserving a verification-rejected result

Only the deliverable service's dedicated verification refusal can convert a stopped
runtime's `COMPLETE` into `PARTIAL`. This preserves its original report, artifact IDs,
changed paths, and current checks, adds the refusal as the first remaining risk, and
clears declared dependency unblocks. The task is `BLOCKED` and the delegation outcome
retains the original `INVALID_ARGUMENT` diagnostic. With a valid saved runtime handle,
normal strict recovery resumes the same task/session on the next attempt.

Schema, storage, ownership, identity, and runtime-stop errors are not eligible for this
conversion. An unconfirmed runtime stays quarantined even for a read-only task.

## Read-only scopes

The reserved `(no-write)` namespace is interpreted as a read-only mode: both
`(no-write)/**` and `(no-write)/child-unique/**` grant no writable paths. A scope cannot
mix that namespace with real write paths. A read-only deliverable must declare
`changed_scope: []`.

These tasks retain durable leases, runtime admission, execution generations, cancellation,
stop confirmation, and strict recovery. Distinct read-only tasks have no write conflicts;
real writers still conflict normally. Another lease for the same active/quarantined
task is refused. Scope permissions are enforced by protocol helpers; runtime filesystem
sandboxing remains the adapter's responsibility.

## `runReady` input and scheduling contract

`runReady(defaultAgent, deadlineMs, options)` executes existing unowned `PENDING` tasks
whose dependencies are `DONE`. The reservation rechecks state, dependencies, lineage,
creator and contract in one transaction. It preserves the task ID, spec, run, parent,
depth, and current attempt instead of creating a child duplicate. Preferred agents and
ancestor-loop protection apply; unknown adapters produce a result bearing the real task
ID and leave it pending.

Use `options.run_id` to restrict a pass to its intended run. The scheduler leaves native
prelaunch reservations to their existing executor/recovery path. Its own stable
`run-ready:<taskId>:<attempt>` reservation supports contention and dead-executor
reconciliation. A repeated completed pass returns no new tasks.

`TaskSpec` has no input artifact field. For every task that expects artifacts, pass the
explicit `options.input_artifacts` map from task IDs to artifact IDs:

```ts
await orchestrator.runReady("claude", 30_000, {
  run_id: root.run_id,
  input_artifacts: { [task.task_id]: [capture.artifact_id] },
});
```

Omission means no inputs are expected; it does not infer artifacts from prose or
dependencies. The first reservation freezes the ordered input IDs for invocation,
continuation and recovery. Later scheduler retries reuse them and refuse an explicit
replacement. Input content still passes the normal integrity and snapshot checks.

The new tests use SQLite and local adapter fixtures. They establish coordination
behavior, with explicit synthetic verification records; they do not establish provider
health, HTTP target behavior, vulnerability validity, or campaign yield.
