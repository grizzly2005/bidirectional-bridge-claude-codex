# Shared working memory V1 — experimental branch

Claude and Codex can read and enrich working context across native MCP client restarts.
The existing bridge stores compact notes in SQLite and retains detailed material through
its artifact registry. Web-audit campaigns remain their own single-writer JSON documents.
No new server, runtime dependency, vector database, embeddings or RAG pipeline is added.

## Three operations

| Tool | Behaviour |
| --- | --- |
| `memory_get_context` | On-demand current notes, useful references and pending task IDs/states, under a byte budget. |
| `memory_upsert` | Immutable create/update revision with expected_revision, caller/task provenance and idempotency. |
| `memory_get_changes` | Revisions after change_cursor; resumable pagination and recoverable lifecycle history. |

These are additions to the native MCP server on this branch. Build it and reconnect the
experimental clients to load them. Select the same experimental database path for both
callers, for example `.bridge/experimental-memory.db`; keep older release state separate.
The schema-6 migration preserves prior history but is not an automatic downgrade path.

Use the [development tutorial](tutorials/shared-memory-development.md) or
[web-audit tutorial](tutorials/shared-memory-web-audit.md). Exact payload examples and
limits are in the [skill reference](../skills/using-bridge/references/shared-memory.md).

## A working note, not a second evidence ledger

Notes have stable scoped keys and a kind: context, decision, observation, next-action or
abandoned-track. They hold a title, short summary, artifact IDs/hashes, optional entity/version/
epoch references and related task IDs. An abandoned track must retain reason, tested_conditions
and reopen_when. Formal audit hypothesis status remains in the campaign and its oracle.

Scope is namespace (`development`/`bug-bounty`), context_id, branch, application_version
and epoch inside one bridge database. Qualifiers default to null and match exactly. Versionless
project decisions and version-bound investigations use deliberately different scopes. There
is no implicit merge across branches/programs and no timer-based expiry.

Lifecycle is active, superseded or archived. A new lifecycle state creates another revision;
the prior revision survives. Active context reads never resurrect an older active revision
when the latest is archived. Historical reconstruction uses changes from cursor 0.

Only the bound caller's current WORKING/VERIFYING task can create a new revision. Another
agent can enrich the note using its own task. The server supplies author, run and attempt;
reading never requires taking over the previous author's task. A stale expected_revision
returns REVISION_CONFLICT and requires an explicit reread/merge. An identical idempotent
retry preserves its first result; a changed payload under that key is refused.

## Context and cursor boundaries

Adapters do not automatically inject note content. Skills request the relevant context on
entry and record meaningful deltas at handoff. The default context budget is 16 KiB, with
an explicit 2–64 KiB range. Detailed artifacts stay behind references. A note that cannot
fit is listed in omitted and can be requested by key with a larger budget; no partial
body masquerades as a full note. The budget includes the MCP text representation.

Interactive native managers call the memory tools directly. Delegated Codex App Server
workers retain their existing disabled project-MCP configuration: their manager supplies
the selected context through an input artifact and records any proposed delta under its
own task, referencing the worker's output. This preserves writer/source provenance without
activating bridge tools recursively inside workers.

Page a context with next_key and the same at_cursor=change_cursor. Save each consumer's
cursor with its database and exact scope. For changes, advance only to the returned
change_cursor and hold until_cursor=head_cursor while a paginated scan has_more. The head
is not a pagination bookmark. A too-large whole change returns an error without advancing.

Source integrity is checked when reading. A changed retained path or source hash is flagged.
Reference hashes bind bytes, not actor identity, policy or vulnerability truth. JSON campaigns
and notes can remain meaningful only when their tested conditions and epochs are reviewed.

## Executable restart demonstration

```powershell
npm run build
node scripts/test-shared-memory.mjs
```

The test starts a Codex-bound MCP process, publishes a synthetic map with 150 endpoints and
8 unconfirmed hypotheses and stores three small working notes. It closes that client, starts
a Claude-bound process, reads the saved context and appends an enrichment, closes it, then
starts a new Codex-bound process to read only the delta and reconstruct history. Hash references,
abandoned reason, pending work and epoch isolation are asserted. Two simultaneous processes
also race one revision: one succeeds, the other returns REVISION_CONFLICT. Archived history
remains recoverable. Temporary cleanup is confined to the generated fixture directory.

The default test uses real MCP processes and on-disk SQLite but invokes no model or target.
It demonstrates protocol continuity, not a finding rate or a fresh LLM session benchmark.
For an actual agent to perform the middle stage, use three separate commands/processes:

```powershell
node scripts/test-shared-memory.mjs --prepare-live .bridge/memory-demo/fixture.json
node scripts/test-shared-memory.mjs --claude-enrich .bridge/memory-demo/fixture.json "Claude's working observation"
node scripts/test-shared-memory.mjs --codex-resume .bridge/memory-demo/fixture.json
```

Run the middle command from the actual Claude session and retain its command/result evidence.
The helper itself never invokes a model. The live stages retain their isolated fixture DB
and metadata; they do not operate on a real campaign. GUI clients are not closed by the test.
