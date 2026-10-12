---
name: bridge-web-audit
description: Investigate an authorized web application or API with a JSON actor/object/state matrix, hypothesis history, differential replay and abstract cross-program lessons. Use for application-specific pentest or bug bounty work with the existing bridge; not a generic scanner run or simple code fix.
---

# Bridge Web Audit

Keep the application question and next missing witness central. This skill uses the existing bridge and tools; it does not connect PDX/BELIEF engines or add an orchestrator. Preserve the user's scope, tool preferences and read-only boundaries. Offline analysis stays offline.

## Work from evidence

Read the program scope, saved campaign, available actors/sessions and relevant business rules. Distinguish actor identity from role, object owner from actor, and object tenant from actor tenant. Unknown facts stay explicit. Keep exact origin/port, serialized HTTP URL, method, route and ordered duplicate query shape beside each receipt. Recipes refuse URLs that Node would rewrite, such as unresolved dot segments or literal spaces/Unicode; prepare the encoded URL explicitly. A JS route is discovered until an actual capture exists.

Use the user's capture tools. The current executable MVP accepts its versioned JSON import format and has a Node HTTP runner; it does not import arbitrary HAR/Burp files or instrument a browser. Read [formats-and-replay.md](references/formats-and-replay.md) for the schema, working CLI commands and local fixture.

Keep retained bytes, derived JSON and interpretation separate. The hash binds the retained representation; it does not establish identity, policy, causality or impact. A 200 error, login redirect, timeout, copied source or fired hook is not a vulnerability. Credential headers resolve from environment references at execution and are redacted in the retained request; response data can still contain private information.

## Resume shared work

Use `memory_get_context` on entry for the exact bug-bounty program, branch, application version
and evidence epoch; load only useful working notes and source references. Inspect reference
integrity and the campaign before relying on a note. Resume from the saved scope/change_cursor
with `memory_get_changes`, paging without skipping to head_cursor. At handoff, record meaningful
observations, missing witnesses and pending work with `memory_upsert`, using the current owned
task and the revision read. On a conflict, reread and merge.
Use the native manager for these MCP calls; delegated Codex workers receive the selected
context through input artifacts because their project bridge MCP is disabled. Persist their
proposed notes as manager with references to the worker output and the actual writer's task.
Keep the campaign as the sole canonical hypothesis/evidence ledger. For abandoned work, preserve reason, tested conditions
and reopening trigger; an active working note is never an oracle-confirmed vulnerability.
Archive or supersede temporary notes when their context changes; earlier revisions remain.

## Choose and verify an investigation

Write competing predictions, explicit prerequisites, their capture predicates and a potential refutation. Run `plan` for a deterministic ranking with cost/risk/discrimination reasons. Its score is a documented heuristic, not measured information gain or a probability. It cannot replace a business decision or supply missing credentials.

Use one agent for mechanical capture and surface exploration. Use a bounded second-agent refutation for business logic or an explicitly promising hypothesis when delegation is authorized. Honor a user request for a different review cadence. Use `using-bridge` for ownership, lineage, exact input transport and recovery. Do not launch a second runtime for every routine request by default.

Generate `refutation-input` for the second analyst: receipts, recipe context and expected policy, with the first registered verdict/history omitted. Check the supplied policy prose for an embedded verdict. Send the exact packet and its hash before confronting conclusions. A shared workspace is not an isolation guarantee; report what the reviewer actually received.

Automatic replay requires `replaySafety=idempotent-read`. Stateful operations use separate preparation, before/after captures and causal controls; the current automatic runner does not execute them. Confirmation in this MVP is only a controlled differential GET read: two distinct actors, both owned-object baselines, a protected-object probe, a negative control, response actor markers, established state/tenant facts and two complete reproducible runs. `verify` recomputes predicates and integrity. Task `COMPLETE`, model agreement, status <400 or a stored finding flag cannot promote a hypothesis.

Preserve inconclusive and rejected results. Reopen explicitly after session/state/application changes so older captures cannot prove the new investigation. Hypothesis definitions and event chains are hash-bound; a changed question, rule or prediction needs a new hypothesis definition/ID. This is tamper detection within saved JSON, not a signature or externally anchored audit log.

## Reuse lessons and measure

Author an abstract lesson separately: application context, root cause, suspicion signals, confirmation/refutation tests and variants. Remove concrete hosts, routes, identities, object IDs, sessions, private markers and the original verdict. `pattern-export` accepts authored abstraction only; pass the source campaign for source-fact checks. Its string rules catch common accidental transfers, while human review still has to catch arbitrary names, short IDs and unknown token forms. Do not claim exhaustive secret detection.

Import a pattern with a newly authored target binding. It creates an unconfirmed hypothesis with no inherited receipt or verdict. Establish the new program's facts and witnesses independently.

Start/stop a campaign timer and keep lanes comparable before interpreting `report` or `compare`. The practical dedupe key is program + authored root cause + affected asset + impact; review its granularity for the campaign. Count unique findings whose current oracle passes and attribute each key at its earliest sufficient confirmation before assigning a lane. Concordant replays do not transfer discovery credit; `lastObservationAt` records them separately. Use saved wall-clock intervals, including refutation effort. Unknown duration yields no rate. Fixture arithmetic demonstrates the implementation; it is not bug-bounty performance or proof that two agents are faster.
