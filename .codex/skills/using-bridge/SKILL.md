---
name: using-bridge
description: Coordinate Claude Code, Codex and Gemini (Google Antigravity) through the repository-local bridge MCP for substantial multi-file implementation, security or architecture review, nontrivial diagnosis, verification, recovery, and bounded independent review. Use when the user asks for the bridge, another runtime, a delegation share such as "délègue 50 %", or a model change for a runtime, or when a substantial task has a useful separable child. Keep trivial, one-command, tightly coupled, or explicitly single-agent work local.
---

# Use the Bridge

Use the bridge as a coordination layer, not as a reason to involve another agent. Keep the current native client responsible for the user request; delegate only a bounded subtask whose expected value exceeds startup, context, and verification overhead.

Three runtimes can be managers or workers: `claude` (Claude Code), `codex` (Codex) and
`gemini` (Google Antigravity CLI `agy`, or legacy Gemini CLI). Delegate with
`bridge_delegate` `to` set to one of the others; never to your own runtime or an ancestor.

The Gemini **worker** runs only when the bridge was started with `--gemini-auth api-key`
(Google AI Studio key) or `--gemini-auth enterprise`. Google does not support driving a
consumer Antigravity login (Free/Pro/Ultra) from Claude Code, Codex or other third-party
agents and reports suspensions for it; never work around this. A Google AI Pro/Ultra plan is
used by running **Antigravity as the manager** with this bridge MCP and delegating to Claude or
Codex. If a Gemini delegation returns the “Gemini worker disabled” blocker, report it and
choose another runtime; do not retry it.

## Choose the path

`skills/using-bridge/` is the versioned source. Generate the client mirrors with
`node scripts/sync-bridge-skill.mjs --write`; check them with `--check`.
Edit the source rather than a client mirror.

- **Delegate:** assign one independent, verifiable subtask to another runtime.
- **Review:** ask another runtime for a bounded, usually read-only, independent review.
- **Recover:** resume one known stranded task in place after quota, timeout, crash, or process interruption.
- **Observe:** inspect telemetry or events only when the user requests them, during dogfooding, or for diagnosis.
- **Track visually:** on a request such as “active le suivi de délégation”, open the opt-in view before a blocking delegation; read [tracking-ui.md](references/tracking-ui.md).
- **Balance a share:** on an explicit delegation share (“délègue 50 %”, “moitié pour Codex”), follow [Honor an explicit delegation share](#honor-an-explicit-delegation-share).
- **Change models:** on an explicit model request (“pour Claude passe en opus 5.5”), follow [Select models](#select-models).
- **Do not use the bridge:** complete trivial, tightly coupled, or cheaper single-agent work locally.

If native bridge tools are absent, report that limitation and use read-only offline sources
for observation when useful. Configuration files and an offline review do not prove a live
bridge delegation. Do not replace missing MCP access with a direct worker CLI call.

If this session is already a delegated worker with a supplied `task_id`, scope, expected deliverable, and verification criteria, complete that contract. Do not create a new root or delegate again unless the contract explicitly permits it.

Tracking does not create a task, confer manager authority, or trigger another model. Keep
UI polling in the widget, never in repeated model turns. Closing or disabling the view
leaves workers running; cancellation remains a separate explicit request.

## Decide whether to delegate

Delegate only when all are true:

1. The child task is independently understandable from a compact contract.
2. Its write scope is disjoint, or it is read-only.
3. Its output and verification criteria are explicit.
4. The target runtime adds distinct implementation, diagnosis, review, or research value.
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
separate read-only final review. Do not exceed two children by default — an explicit
delegation share may require more — and treat an exact user-requested delegation count as
a hard limit.

Read [routing-policy.md](references/routing-policy.md) when making a nontrivial routing decision. Do not rerun
benchmarks, search for model rankings, route from quota consumption, or delegate merely to
achieve a usage percentage during ordinary work. The single exception is a share the user
explicitly requests; it is governed by the next section, not by your own initiative.

## Honor an explicit delegation share

When the user states a delegation share — “délègue les tâches à 50 %”, “fais faire la
moitié à Codex”, “30 % pour Gemini” — the share is a **token target**, not a task count:
by the end of the request, the tokens consumed by delegated workers must be about that
fraction of the total (50 % means the children together consume about as many tokens as
the manager session). The purpose is to use the user's separate subscription limits
(Claude, ChatGPT/Codex, Google AI) instead of exhausting the manager's. Pay close attention:
delegating many small tasks while the manager does the expensive reading, build/test loops
and rewrites does **not** meet the share.

1. **Confirm the target once.** Restate the share and the target runtime(s) in one line.
   If the user named none, choose a runtime on a *different* subscription from the manager
   (manager Claude → Codex; manager Codex → Claude; manager Antigravity → Claude or Codex).
   Delegate to `gemini` only when its worker is enabled (API key or Enterprise); a Gemini API
   key is billed per use and does not draw on a Google AI Pro/Ultra plan. The share stays in force for the whole request until the user changes it.
2. **Plan by consumption, before working.** Split the request into independent,
   verifiable chunks with disjoint write scopes. Weight each chunk by what consumes tokens:
   files and documentation to read, size of changes, number of build/test/fix iterations,
   breadth of an audit. Assign chunks so the delegated weight matches the share.
3. **Move the expensive work, keep the cheap control.** Give children the token-heavy
   parts: broad codebase reading, implementation of whole modules, repeated test/fix loops,
   test writing, exhaustive reviews or audits, large refactors. Keep decomposition,
   integration and verification on the manager, and verify cheaply (diff review, run the
   tests) rather than re-reading everything the child read.
4. **Lift the default child cap only as far as the share needs.** The default limit of two
   children does not apply to an explicit share; use as many bounded, non-overlapping
   children (sequential waves when scopes depend on each other) as the share requires. An
   exact delegation count from the user, the depth limit, leases and every other rule still
   apply. Give each child a realistic `deadline_ms` and `spec.max_turns` for its real size.
5. **Measure after each child.** Call `bridge_query_telemetry` once with the root `run_id`
   and read `by_agent`: it sums the runtime-reported `total_tokens` per delegated runtime.
   The bridge does not measure the interactive manager session. Use the manager client's
   own usage display when available (Claude Code `/usage` or `/cost`, Codex `/status`,
   Antigravity `/usage`) or the user's figure; otherwise state that the manager side is an
   estimate from work volume. Never invent token numbers.
6. **Rebalance with real work only.** If the delegated share is below target and
   substantial work remains, delegate the next eligible chunk instead of doing it locally;
   if it is above target, keep the next chunk local. Never pad prompts, duplicate a task,
   inflate turn budgets, ask for useless re-reads or delegate make-work to burn tokens:
   that wastes the user's limits instead of using them.
7. **Report the outcome.** At the end give the measured delegated tokens per runtime,
   the manager figure with its source or “non mesuré”, achieved versus target share, and
   any chunk kept local with the reason. The localhost dashboard shows “Tokens délégués par
   runtime” for the same run.

## Select models

Each worker uses its **runtime's default model** unless told otherwise. Do not change
models on your own initiative.

- On a request such as “pour Claude passe en opus 5.5” or “Gemini en Neon”, call
  `bridge_set_model_preference` with `runtime` (`claude`, `codex` or `gemini`) and the
  `model` and/or `effort` slug. It is stored for the workspace, shared by every manager
  (Claude, Codex or Antigravity), and applies to the next delegated attempt. `null` restores
  the runtime default. Confirm the stored value from the tool result.
- For one task only, put `model` / `effort` in that child's `spec` instead.
- Precedence: `spec.model`/`spec.effort` > stored preference > runtime default.
- `bridge_get_model_preferences` shows the current values and dated hints. The runtime is
  the authority on slugs (`claude --help`, Codex `/model`, `agy models`); an unknown slug
  fails the attempt instead of falling back. Read [model-catalog.md](references/model-catalog.md)
  for runtime roles and model choices.

## Fast path for bounded children

1. **Confirm the server once per fresh native session.** Call `bridge_server_info`. Cache the bound `caller` and `delegation` policy. Stop if identity is wrong or delegation is denied.
2. **Reuse existing state when present.** Do not create a duplicate root if the current interaction already has one.
3. **Create one manager root when needed.** Use `bridge_create_task`, then `bridge_claim_task`, then move it to `WORKING` with `bridge_set_state`.
4. **Lease only manager writes.** If the manager will edit files, acquire its own scope with `bridge_acquire_lease`; a read-only root needs no write lease.
5. **Delegate the selected child.** Call `bridge_delegate` with the root `run_id`, root `task_id` as `parent_task_id`, depth `1`, a bounded task spec, necessary artifact IDs, a realistic deadline, and normally `max_attempts: 0`. A second child needs the checkpoint justification above. Omit caller identity; the server binds it.
   Supply a stable `idempotency_key`. After a client timeout, reconcile or replay that same
   request; changing its inputs, budgets, or lineage under the same key is refused.
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
- a finite `spec.max_turns` suited to Claude work when its default 12 would be insufficient;
- normally zero automatic retries.

`deadline_ms` applies per attempt; `total_deadline_ms`, when supplied, includes retry and
recovery elapsed time, including time spent waiting for quota. `max_attempts: 0` means one
attempt; `1` permits at most two. Require only checks the worker can actually execute.
Use `spec.telemetry_mode: "operational"` for ordinary work (the default). Select `"strict"`
only when accepted measurements are an explicit completion criterion. A strict observation
failure can coexist with a completed business result; inspect both before acting.

Model and effort follow [Select models](#select-models); leave them unset for the runtime default.

Preserve the root `run_id`, set `parent_task_id` to the root task, and set child depth to parent depth plus one. Never pass full chat history when a compact task contract and artifact references suffice.

For substantial audits or reports, keep `summary` concise, publish the complete detail as a durable report artifact (inline when size permits), and reference its artifact id in the deliverable. Real checks count only in canonical `verification_results`; `verification_performed` is derived and prose claims are not evidence.

For longer children, narrow the scope to the finite turn budget and reserve a few turns for
the deliverable. Ask for explicit structured checkpoints when interruption would lose useful
findings; see [contracts.md](references/contracts.md). A checkpoint preserves progress and
real evidence, but cannot turn a runtime limit into `COMPLETE`. Resume the same child/session.

Read [contracts.md](references/contracts.md) when constructing an unfamiliar payload or validating a worker result.

## Respect ownership and leases

- Mutate only tasks owned by the bound caller.
- The owner of a direct parent that created the child may request strict resume, targeted
  cancellation, continuation after prelaunch contention, or observation repair through the
  corresponding bridge tools. These narrow exceptions do not transfer ownership or allow
  arbitrary child mutations; see [tool-map.md](references/tool-map.md).
- Claiming a task is not write permission; acquire a lease before manual writes.
- Do not write in another holder’s overlapping scope.
- Distinct tasks of the same holder also conflict. Same-task subdivision is refused while
  an execution may still be running or its scope is quarantined.
- On `NOT_OWNER`, stop the mutation. Do not steal, finish, block, or release another owner's task or lease.
- On prelaunch `SCOPE_CONFLICT`, preserve the blocked task and resolve contention. Then use
  `bridge_continue_task` with a new stable continuation key; it preserves the frozen contract
  and original deadline and does not require a runtime handle.
- On `RUNTIME_STOP_UNCONFIRMED`, preserve quarantine. A timeout, abort, interrupt ACK, expired
  TTL, or rejected promise does not prove the worker stopped. Do not force release or kill a
  shared runtime to free one task.
- Publish only outputs produced for the owned task and inside its scope.
- For read-only work, use `changed_scope: []` and prefer compact inline evidence over path artifacts.

The server enforces core invariants, but shell access is not an OS-level scope sandbox. Continue to respect the declared scope.

## Prevent loops and duplication

- Use one bounded request and one structured answer.
- Never substitute a direct Claude, Codex, `agy` or `gemini` invocation for `bridge_delegate`.
- Never delegate to an agent already in the active ancestor chain.
- A delegated worker must not delegate recursively unless its explicit bounded contract permits
  that safe action.
- Do not create a sibling replacement because a child is slow, blocked, quota-limited, or interrupted.
- Do not redo a delegated task while it is active.
- Decompose broad repository-wide work into bounded subtasks when possible instead of relying on an extreme turn budget.
- Do not exceed two children by default (an explicit delegation share may require more), the
  user’s requested delegation count, or the bridge depth limit.

## Handle results honestly

- `COMPLETE`: objective satisfied, with real passing verification and no failing verification.
- `PARTIAL`: useful progress exists but action, evidence, quota, authority, or certainty is missing; task remains blocked.
- `FAILED`: the bounded objective failed rather than merely waiting on an external condition.

Use exact changed paths only. An inspected file is not a produced artifact. A path artifact must exist and fit the leased output scope; otherwise use an inline report. Never invent checks, paths, test totals, or successful exit codes.

On the experimental web-audit branch, the standalone `(no-write)` namespace denotes a
read-only execution mode: it retains a durable lease for lifecycle and recovery, grants no
path writes, and does not conflict with other tasks' write scopes. Do not mix it with write
globs. Codex uses a read-only sandbox for these tasks; the Claude contract and result gate
require `changed_scope: []` and inline outputs. CLI directory access is not an OS sandbox.

The experimental database uses schema 6. Keep it separate from a schema-4/5 release database;
older binaries cannot reopen a database upgraded to version 6. Existing verification history
is retained, but old rows without a known attempt do not certify a new attempt.

## Shared working memory and project resumption

On “reprends ce projet”, “resume this project”, or when opening a fresh native chat without
conversation history on an existing project, call `bridge_resume_project` (`{}`) first. Present a
concise four-part resume card:

1. **Décisions en vigueur** (`decisions`): active `decision` and `context` notes across the
   project's discovered scopes, never resurrecting `superseded` or `archived` revisions.
2. **Résultats vérifiés et preuves** (`verified_results`): only results backed by passing canonical
   `VerificationResult` checks or `intact` SHA-256 artifact references, with their author and proof
   IDs; keep `unverified_observations` clearly separate so unverified claims never appear proven.
3. **Tâches ouvertes** (`open_tasks`): nonterminal tasks (`PENDING`, `CLAIMED`, `WORKING`,
   `VERIFYING`, `BLOCKED`) and any quarantined leases.
4. **Prochaine action** (`next_actions`): active `next-action` notes, `abandoned_tracks` (with
   `reopen_when`), and `recommended_next_action`.

When targeting one known scope directly, call `memory_get_context` for the
explicit project/program, namespace, branch, application version and evidence epoch.
The native manager performs these MCP calls. Delegated workers (Codex, Claude, Gemini) do not
use the project bridge MCP; load a useful context as manager, publish a compact input artifact, and persist
the returned working deltas under the manager's own task with references to the worker output.
At the end of every meaningful delegation, call `memory_upsert` to record what changed, set
`contributed_by` to the worker runtime (`claude`, `codex` or `gemini`), and include the child
task in `related_task_ids` and/or its produced artifacts in `references` so the server can
canonically verify and attribute the contribution to its author.
Request only the useful notes with a bounded byte budget. Keep the database/scope and
`change_cursor` together; use `memory_get_changes` at handoff or resumption for deltas.
Do not inject all memory into every prompt or load an old program's context implicitly.

Before handing work off, use `memory_upsert` for meaningful decisions, observations,
pending actions or abandoned-track reasons. Supply your current owned WORKING/VERIFYING
task, the revision you read and a stable idempotency key. On `REVISION_CONFLICT`, reread
and merge explicitly. Notes can be enriched by another caller using its own current task;
reading them never requires taking over their author's old task. Lifecycle is active,
superseded or archived, and earlier revisions remain accessible through the changes feed.

Keep detail in canonical artifacts and campaigns; store their IDs/hashes and record/epoch
references in the note. Memory cannot confirm a finding or modify campaign JSON. A stopped
investigation needs its reason, tested conditions and reopening trigger. Read
[shared-memory.md](references/shared-memory.md) for exact payloads, cursor pagination,
oversized-note handling and restart verification.

For an independent review, give the reviewer the objective, base revision, diff/artifacts and
tests, but not the author's reasoning or verdict; share those only after its first pass and
only to resolve a disagreement. Agreement between runtimes is a weak signal: executed tests,
reproducible artifacts and invariants decide. Bring in a third runtime only on disagreement,
security-sensitive changes, ambiguous tests or a stalled child — not on every task.

For reviews, separate a demonstrated blocker from a nonblocking remark or future proposal.
Tie findings to the inspected revision and preserve useful counterexamples. After two cycles
without progress on the same cause, inspect the contract or external blocker before another
review or recovery.

## Recover a stranded task

Use recovery only for a known existing task with persisted runtime state.

Recovery continues the same durable task and runtime session; never redelegate as a substitute.

1. Call `bridge_recover` to reconcile leases and identify stranded state. It never frees a
   quarantined scope without positive stop evidence.
2. Read the specific task with `bridge_get_task`; do not print its raw execution handle.
3. Choose one recovery path and call it once:
   - if the bound caller owns the task, use `bridge_resume_task`;
   - if the bound caller owns the direct parent and created the delegated child, use
     `bridge_resume_delegated_task` from the manager client.
4. Do not open the other native client merely for recovery. The bridge derives the child
   owner/runtime from durable state and uses that worker identity internally; do not spoof an
   owner or use a direct CLI fallback.
5. Keep the same task, owner, run, parent, scope, and runtime session/thread. Recovery reserves
   a fresh worker-owned lease and opens a new adjacent attempt only after admission. It
   preserves the original total deadline and turn ceiling.
6. If strict resume fails, leave the same task blocked and report the exact reason. Do not
   create a replacement task or fresh thread.

Read [recovery-and-failures.md](references/recovery-and-failures.md) for cancellation,
provider blockers, uncertain launches, and observation repair.

## Use telemetry conditionally

Call `bridge_query_telemetry` only when requested, during dogfooding, or for diagnosis. Query once after the relevant attempt rather than polling.

Report only authoritative records:

- runtime, version, and model when supplied by the runtime;
- input, output, cached, cache-creation, and total tokens;
- turns, durations, termination, and runtime-reported cost semantics.

Read the attempt's `observation` alongside telemetry. A storage failure leaves a validated
draft that `bridge_repair_observation` can seal without invoking the runtime. Do not repeat
completed work, submit invented metrics, or bypass schema/privacy rejection. Component
durations have separate clock sources; cumulative delegation elapsed time is not an
attempt duration to sum.

Leave unknown values `null`; never estimate. Cached token fields are dimensions of input usage, not extra tokens to add again. Interactive manager sessions may have no attempt telemetry; do not invent manager totals. Never expose raw execution handles, prompts, transcripts, credentials, or private trust state.

## Minimize bridge overhead

Wait for an active delegation result or notification. User progress updates do not require
a snapshot. After a client timeout, reconcile the specific child once; if its worker is
still active, wait rather than repeating the task. After two attempts blocked by the same
cause, inspect the contract or external blocker before another recovery.

- Call `bridge_server_info` once per native session, not before every operation.
- Skip `bridge_snapshot` unless concurrent ownership is plausible.
- Avoid routine `bridge_list_tasks`, `bridge_read_events`, and repeated `bridge_get_task` polling.
- Put all necessary context into one compact contract.
- Pass artifact references, not transcripts.
- Default to `max_attempts: 0`; add retries only for a justified transient failure.
- Use meaningful status milestones only.
- Let `bridge_delegate` manage child claim, lease, attempt, artifacts, verification, and finalization.
- Query telemetry once and only when useful.

Ordinary work does not need interactive manager telemetry as a completion criterion. If
the user explicitly requires metrics the runtime cannot provide, preserve the useful result
and report the unmet criterion. Never reinterpret missing metrics as zero.

Scheduled bridge use requires actual MCP discovery and a known manager session. A skill
does not wake a closed client. Scheduling and automatic activation are separate user
requests; keep the same eligible child across quota waits.

Use `bridge_doctor` when diagnosing loaded code or aggregate state; its startup snapshot is
distinct from the files currently on disk. An offline doctor cannot attest a loaded client,
and neither doctor calls a model or proves provider availability. Do not activate automations
or restart user clients merely because this skill was loaded.

When exact tool inputs or outputs are uncertain, read [tool-map.md](references/tool-map.md) and prefer the live MCP schema over stale prose.
