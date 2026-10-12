# Shared working memory V1 (experimental)

The existing native MCP server exposes exactly `memory_get_context`, `memory_upsert` and
`memory_get_changes`. Notes persist in schema-6 SQLite beside tasks, artifacts and events.
The API is on demand; adapters do not inject note content into every runtime prompt.
Campaign JSON remains single-writer and canonical for audit hypotheses and evidence.

The native interactive managers can call these tools. The existing delegated Codex App Server
configuration disables project bridge MCP servers, so its worker cannot call memory_* directly.
The manager reads a bounded context, publishes it as an input artifact, and persists the
worker's proposed delta using its own current task plus a reference to that worker's output.
That records the actual writer and preserves the contribution's source; it does not impersonate
the worker. No automatic context injection or recursive bridge activation is introduced.

## Scope and lifecycle

Every request has a scope:

```json
{
  "namespace": "development",
  "context_id": "my-project",
  "branch": null,
  "application_version": null,
  "epoch": null
}
```

`namespace` is `development` or `bug-bounty`. `context_id` identifies the project or program
inside the chosen bridge database. Qualifiers default to null on the MCP wire. Scope matches
exactly: null is a deliberate versionless context, not a wildcard. Read durable project
decisions in that scope and branch-specific work in a separate explicit scope. For temporary
audit observations, supply the application version and evidence epoch. A new epoch does not
load older notes silently. There is no clock-based automatic expiry.

`lifecycle` is `active`, `superseded` or `archived`. Context reads default to the current
active revision. Changing lifecycle writes a new immutable revision; it never deletes history.
To read inactive notes, request those lifecycles. To recover every revision, read changes from 0.

## Read before writing

`memory_get_context` accepts scope, optional keys/lifecycles, limit (1–50), max_bytes
(2048–65536, default 16384), and optional after_key/at_cursor. It returns notes with references
and their current integrity state, referenced pending task IDs/states, `change_cursor`,
`has_more`, `next_key` and `omitted`. It never loads artifact bodies or old conversation text.

Page with `after_key=next_key` and the same `at_cursor=change_cursor`. This holds the note
snapshot stable while another agent writes. An oversized whole note is listed in `omitted`
with its key/revision and minimum byte budget; request that key again with a larger budget.
Notes are never silently truncated. The budget includes the MCP text payload's indentation.

`reference_states` is intact, missing, hash-mismatch, content-changed or context-mismatch.
It is checked when reading; a retained hash does not establish business truth. A changed path
source or an incompatible supplied source epoch requires revisiting the source before reuse.

Write an initial note with `expected_revision=0`; use the revision returned by a later read
to enrich it. A current owned WORKING/VERIFYING task is required. The server supplies author,
task, run and attempt; the author of the previous revision does not grant current authority.
Memory writes mutate bridge metadata, not repository files, so they need no filesystem lease.

```json
{
  "scope": {"namespace":"development","context_id":"my-project"},
  "key": "architecture/storage",
  "expected_revision": 0,
  "task_id": "ACTUAL_CURRENT_OWNED_TASK_ID",
  "idempotency_key": "current-task:architecture-storage:initial",
  "note": {
    "kind": "decision",
    "title": "Working notes use the bridge SQLite",
    "summary": "Campaign evidence remains in versioned artifacts; notes retain references.",
    "lifecycle": "active",
    "references": [],
    "related_task_ids": [],
    "abandonment": null
  }
}
```

Keys are stable identifiers of 1–128 ASCII letters/digits and `._:/-`, starting with a letter
or digit. Notes have kind context/decision/observation/next-action/abandoned-track, title up
to 200 characters, summary up to 2000, at most 16 artifact references and 8 related task IDs.
The complete revision is capped at 32 KiB. Put longer material in an artifact.

A reference requires an existing `artifact_id` and its `sha256`; optional record_type,
record_id, source_revision and source_epoch locate the canonical entity. A new write refuses
a missing or changed source. The full reference and previous note revisions remain retained.

An abandoned-track also requires `abandonment` with reason, tested_conditions and reopen_when.
This describes investigation work; it does not change an audit hypothesis's oracle verdict.

On `REVISION_CONFLICT`, reread, understand the other revision and deliberately merge. An
identical request with the same idempotency key returns its original revision; a changed
payload under that key gives `IDEMPOTENCY_MISMATCH`. No last-write-wins overwrite occurs.

## Changes and restart

Call `memory_get_changes` with scope and the saved `change_cursor` (default 0). Keep that
cursor per consumer and per database/scope; the two agents must not share a single advancing
bookmark. The returned cursor is the last delivered revision's event ID, and `head_cursor`
is the snapshot upper bound. While has_more, pass change_cursor and until_cursor=head_cursor
for subsequent pages. Never use the head as a pagination cursor. Start a fresh scan after
the last delivered cursor to collect writes made after the snapshot.

An oversized change returns an explicit budget error without advancing the cursor. Increase
max_bytes and repeat it. The stream contains all revisions, including lifecycle changes;
an event ID gap from another scope or task does not drop a memory update.

For a local protocol demonstration, build then run:

```powershell
npm run build
node scripts/test-shared-memory.mjs
```

It starts and closes three actual native MCP processes (Codex, Claude, Codex), using the same
SQLite file, and checks enrichment, history, source references, abandoned reason and epoch
isolation. Two additional simultaneous processes prove one successful update and one explicit
revision conflict. These are protocol clients with no model invocation. The live-stage flags
allow a real agent to perform the Claude enrichment separately; report which mode ran.
