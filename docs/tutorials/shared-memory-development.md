# Resume development with Claude and Codex

This tutorial uses the unreleased experimental memory V1. Build this checkout and configure
both native clients against one experimental database, separate from release state. See the
[experimental installation guide](../installation.md#experimental-branch-and-schema-6) for
the exact client arguments and use `--db .bridge/experimental-memory.db` for both callers.

## Codex records the decision

Ask Codex to register and start its normal working task, then load only relevant shared context:

> Use the bridge's working memory in namespace development, context_id my-project. Read durable
> architecture decisions with branch/version/epoch null. For this branch's work, use its exact
> branch scope separately. Save the scope and returned change_cursor. Record the selected
> storage approach, the unresolved question and the next action, with references to the design
> artifact, before handing off.

Here, "context" means the `context_id` field. The exact durable scope in this example is:

```json
{"namespace":"development","context_id":"my-project","branch":null,"application_version":null,"epoch":null}
```

Use the same field values in each client; `null` is an exact value, not a wildcard.

The skill uses memory_get_context on demand and memory_upsert with that current owned task.
For a delegated Codex worker, the native manager makes these calls, sends a bounded input
artifact and records its proposed delta with a reference to the worker output. The worker's
project bridge MCP remains disabled by the existing adapter configuration.
Initial expected_revision is 0; later changes use the exact revision read. Author/run/attempt
are assigned by the bound server. Keep long documents in artifacts, not note summaries.

## Close the client and let Claude continue

Start Claude in the same experimental project/database and ask:

> Read the working memory for the same project and explicit scope. Retrieve the referenced
> design only if needed. Continue from the recorded next action and add your observation or
> decision using your own current task and the revision you read. Preserve the prior author's
> references. If another writer changed it, reread and deliberately merge.

Claude need not take ownership of Codex's old task to read or enrich a note. Superseding a
decision creates a new revision; lifecycle superseded/archived keeps the old content available.
Temporary branch notes and durable versionless decisions stay in separate exact scopes.

## Codex reads the delta

After closing Claude's client and reopening Codex, ask it to call memory_get_changes with its
saved database/scope/change_cursor. If has_more, page with the returned cursor and unchanged
until_cursor=head_cursor. Do not replace the cursor with the head. If no bookmark was saved,
load a bounded context first or recover history from 0. This uses persisted bridge data rather
than needing either model's previous conversation.

Run the [executable restart demonstration](../shared-memory.md#executable-restart-demonstration)
to verify persistence and conflict handling locally. Its default mode tests the protocol with
real processes and synthetic work; it does not invoke either provider.
