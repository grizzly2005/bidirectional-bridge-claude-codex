# Resume an authorized web investigation

Use the [web-audit MVP](../web-audit-experimental.md) and experimental native MCP memory in
the same project. Campaign JSON stays single-writer. The memory is a short working context
with references; it does not rerun capture, create evidence or declare a vulnerability.

## Before closing Codex

Publish the current map/campaign as a versioned artifact and ask Codex:

> Load the bug-bounty memory for this exact program, branch, application version and evidence
> epoch. Record the open questions and missing witnesses, referencing the campaign artifact
> ID/hash and relevant hypothesis IDs. For paused or abandoned work, preserve why it stopped,
> the tested actor/object/state conditions and what would justify reopening it.

Use lifecycle active for useful current work. A formal rejected/confirmed hypothesis remains
in the campaign with its oracle evidence; the memory note records the working justification
or links to that decision. It never becomes a competing finding ledger.

## Claude resumes

For a delegated Codex worker, the native manager reads/writes memory and transmits a bounded
input artifact, preserving its returned delta as a note with the worker-output reference.
The existing adapter keeps project bridge MCP disabled inside that worker.

After closing the first client, let Claude start in the same experimental database. Ask:

> Read a bounded context for the same program and epoch. Check reference integrity, dereference
> only useful captures and continue the next missing comparison. Add any business observation
> with your own current task and expected_revision. Preserve the original artifact links and
> give a reopening trigger if the investigation remains blocked.

Notes from another version/epoch are not implicitly loaded. To revisit one, read its exact
older scope deliberately, inspect its tested conditions and establish fresh witnesses. No
actor session, tenant fact or prior verdict is transferred to a new program by this API.

## Codex resumes again

Use its saved scope/change_cursor to fetch only Claude's delta, or load a new bounded context
when no bookmark exists. Keep pagination at the last delivered cursor. Archive or supersede
obsolete working notes while preserving history; campaigns use their own reopen/epoch contract.

The [restart demonstration](../shared-memory.md#executable-restart-demonstration) uses a
synthetic map of 150 endpoints and 8 unconfirmed hypotheses. Their bodies stay in one artifact;
the context loads only short notes and references. The test confirms persistence, delta,
history, abandoned reasons, source hashes and conflicts, without an external target or a
claim of improved bug-bounty yield.
