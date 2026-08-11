# Bridge benchmark telemetry gap report

- Audit: `BRIDGE-TELEMETRY-AUDIT-001`
- Baseline: `bridge-v0.1.0-certified` / `5959e8df3d8707cc1ee5a588c407c7255b3c74a5`
- Certification fingerprint: `86eac9b9f7b0e4a28c820d010e5093c3cc95317cf942fcca7f9bfe333c12c906`

## Outcome

The certified bridge already provides strong task/result telemetry: task and agent identity, lifecycle, ownership, leases, attempt number, persisted execution handle, progress, artifacts, verification evidence, deliverables, retries, blockers, and end-to-end delegation duration.

It does **not** yet provide benchmark-grade model, token, cost, runtime-phase, human-supervision, context-size, delegation-depth, or process-termination telemetry. Those gaps must not be filled with estimates or worker self-report in the first controlled benchmark.

The machine-readable classification and redacted event examples are in [`telemetry-capabilities.json`](telemetry-capabilities.json).

## Baseline and write-scope checks

- Branch at audit start: `bench/bridge-pilot-v1`.
- `HEAD` and annotated tag target: `5959e8df3d8707cc1ee5a588c407c7255b3c74a5`.
- Baseline ancestry check: exit `0`.
- Initial Git porcelain: empty.
- Initial certification fingerprint: exact match.
- No process command line referenced the repository before the audit.
- No implementation, root configuration, or coordination file was changed.
- The only intended writes are the two files under `BENCHMARK/audit/`.

After creating the required audit outputs, the stock certification command exits `1` because its closed manifest correctly treats both new audit files as unlisted project material. This audit did not modify that root manifest. An exact rehash of the same 101 explicitly listed files, using the manifest's domain separator, byte ordering, and record encoding, exited `0` and remained `86eac9b9f7b0e4a28c820d010e5093c3cc95317cf942fcca7f9bfe333c12c906`; `git diff --quiet HEAD -- .` also exited `0` for tracked material.

## Actual runtime evidence

### Real Codex path

The neutral MCP bridge launched the real `CodexAdapter`, which in turn used the official Codex MCP runtime. No mock was registered.

- Task: `task_nsygpxkjxf`
- Runtime: `official-codex-cli-mcp`
- Direct version probe: `codex-cli 0.147.0`, exit `0`
- State/deliverable: `DONE` / `COMPLETE`
- Attempts: `1`
- Persisted handle: present, 36 characters; raw value redacted
- Events: `17`
- Orchestrator wall duration: `18,742 ms`
- Independent manager wall duration: `18,743 ms`
- Verification: harmless Node command, exit `0`, reported duration `400 ms`
- Changed scope/artifacts: `[]` / `[]`

The actual Codex bridge output contained no model, token, cache, monetary-cost, model-duration, or per-turn field. The Codex MCP client retains only `thread_id` and final `content` from the official tool response, so no usage value reached the control plane in this installation.

### Real Claude path delegated by Codex

Codex called `bridge_delegate` on the neutral MCP server, targeting the real Claude adapter and authenticated Claude Code runtime. No mock was registered, and Claude performed the runtime portion independently.

- Task: `task_x662mdqp7g`
- Runtime: `claude-adapter(claude-code-cli(claude))`
- Direct version evidence: `2.1.226 (Claude Code)`, exit `0`
- State/deliverable: `DONE` / `COMPLETE`
- Attempts: `1`
- Runtime turns reported in progress text: `2`
- Persisted handle: present, 36 characters; raw value redacted
- Events: `15`
- Orchestrator wall duration: `112,305 ms`
- Independent manager wall duration: `112,306 ms`
- Changed scope/artifacts: `[]` / `[]`

Claude's independent finding was deliberately conservative: the worker could verify runtime/version, but could not directly see its wrapper session ID, authoritative model, runtime duration, usage tokens, cost, cancellation/timeout/crash outcome, or resume metadata. It also marked the subscription-plan inference as weak because authentication and account configuration were not inspected.

The bridge did expose Claude's turn count only inside free-text progress (`claude runtime finished in 2 turn(s)`). That is useful evidence for this run but not a stable structured per-turn metric.

### Manager setup retry that the bridge did not record

The first ephemeral Claude launcher was asserted as `supervisor`, which registered its adapter under `supervisor`; `bridge_delegate(to: "claude")` therefore returned `NOT_FOUND` before a task was created or a worker launched. The ephemeral database was removed, then the launcher was correctly started as `claude` and the one real delegated task ran.

This is not counted as a task retry, but it is valuable audit evidence: manager/setup retries occurring before task creation are currently invisible to benchmark telemetry.

## Classification totals

| Classification | Metrics | Meaning for the first benchmark |
|---|---:|---|
| `AVAILABLE_NOW` | 20 | Capture directly from current events/state/runtime evidence. |
| `DERIVABLE_NOW` | 3 | Compute deterministically from existing timestamps or OS census. |
| `MISSING` | 3 | No current reliable signal. |
| `UNRELIABLE` | 11 | Optional, free-text, self-reported, ambiguous, or unexercised. |
| `REQUIRES_IMPLEMENTATION` | 19 | Needs a neutral field/event or adapter propagation. |

Total audited metrics: **56**.

## What is available now

### Shared bridge/control plane

Directly available:

- `task_id`, agent/owner, creator, task state, deliverable status;
- task creation/update/claim/completion timestamps;
- attempt number, start/end/outcome, persisted execution handle;
- delegation requested/completed events and overall `duration_ms`;
- scope leases, holder, paths, expiry, acquisition and release;
- blocker lists and blocker events;
- progress state/action/fraction;
- verification command, boolean result, exit code, summary, and optional duration/output;
- artifact IDs, kinds, names, bytes, SHA-256 and integrity;
- changed scope and dependency IDs;
- idempotency records for unique keys.

Deterministically derivable:

- composite attempt identity as `(task_id, attempt)`;
- control-plane queue/scheduling intervals from task/attempt timestamps;
- external remaining-child count from a Windows process census.

Important limitations:

- `newRunId` exists as a helper but no actual task/event uses a `run_id`.
- A stored idempotency record proves a key was used, not how many duplicate replays occurred.
- Dependencies do not encode delegation parentage/depth.
- A handle is persisted, but there is no explicit resume-attempt/success event.

### Codex runtime

Available from this installation:

- runtime implementation and direct CLI version;
- final structured deliverable and verification result;
- thread-handle persistence;
- command exit code and optional verification duration/output;
- adapter progress milestones.

Not available in the actual result/event path:

- authoritative model;
- input/output/cache/total tokens;
- per-turn or cumulative-thread usage;
- reported cost;
- separate model/runtime duration;
- successful model-process exit code.

### Claude runtime

Available from this installation:

- runtime implementation and direct Claude Code version;
- final structured deliverable;
- session-handle persistence;
- a free-text completed-turn count;
- verification exit code supplied in the deliverable.

Not available to the worker or propagated to the bridge in this run:

- authoritative model;
- session metadata beyond the redacted persisted handle;
- input/output/cache tokens and session cumulative usage;
- runtime/API duration fields;
- reported cost and trustworthy subscription billing semantics;
- explicit cancellation, timeout, crash, or process-exit record.

## Token and cost visibility

Token visibility is currently **not benchmark-ready for either runtime**. No actual numeric token value appeared in either bridge result or event stream. Claude reported that wrapper usage metadata lies outside the worker's observation boundary, but because the audit did not receive the raw value, it remains unavailable rather than being promoted from a documented/type-level possibility.

Cost visibility is **missing and semantically unsafe**:

- no dollar amount reached the bridge;
- no account plan/billing mode was inspected;
- subscription use can make an API-equivalent `total_cost_usd` estimate different from billed spend;
- any future cost field must include source and semantics such as `billed`, `api_equivalent_estimate`, or `unavailable`.

## Human-supervision visibility

Human supervision is not automatically observable. The bridge has generic blockers but no structured events for:

- human input requested;
- human response received;
- intervention/correction performed;
- wait start/end and responsible actor.

Blocked duration can be bounded from state transitions, but it cannot currently be attributed reliably to a human. The manager's launcher correction in this audit is a concrete example of an intervention that produced no bridge record.

## Context-efficiency visibility

The bridge correctly exchanges bounded task specs and artifact references rather than manager chat history. Both live requests had `input_artifacts: []`, and neither transferred full conversation history.

However, it does not record:

- final prompt/context byte or token size;
- hashes/counts of context segments;
- repeated prompt context;
- runtime-local context loaded on resume;
- retrieved artifact bytes/tokens.

Artifact IDs, hashes, and sizes make artifact-reference accounting possible now, but prompt/context efficiency needs privacy-preserving size and digest telemetry.

## Runtime-health visibility

Both actual tasks completed, both MCP clients closed, their disposable SQLite databases were removed, and the final Windows census found no matching bridge runtime child.

The current bridge can surface generic timeout/adapter failures when they occur, but this audit did not observe a cancellation, timeout, or crash. Those paths therefore remain `UNRELIABLE`, not `AVAILABLE_NOW`. Successful runtime-process exit codes are also not stored symmetrically with failures.

Restart/resume capability is proven on this installation by the certified tag annotation for both runtimes, and fresh handles were persisted in both audit tasks. The missing piece is an explicit automatic resume counter and outcome event.

## Recommended minimal telemetry changes

No implementation change was made in this audit. The smallest coherent follow-up is:

1. Add one neutral, optional `AttemptTelemetry` record emitted once per attempt, with:
   - `run_id`, composite attempt identity, runtime name/version, authoritative model when supplied by the runtime;
   - orchestration start, runtime start, first useful result, runtime end, verification end;
   - normalized token fields, turn count, and optional cumulative-session usage;
   - cost value plus `cost_semantics` and `billing_mode_known`;
   - prompt/context byte count, artifact reference count/bytes, and privacy-preserving context digests;
   - process exit code/signal and normalized termination kind.
2. Add `parent_task_id` or `parent_delegation_event_id` and `delegation_depth` to bounded delegation metadata.
3. Emit explicit counters/events for `idempotency.replayed`, `resume.attempted`, `resume.succeeded`, `review.recorded`, and manager pre-task failures.
4. Add `human.input_requested` and `human.input_resolved` with timestamps and blocker category.
5. Keep raw prompts, conversation history, credentials, and raw execution handles out of exported telemetry. Persist only sizes, references, and safe digests where correlation is necessary.

Until those changes exist, the first benchmark should report only the 20 directly available and 3 deterministic metrics, label the 11 unreliable metrics explicitly, and leave missing token/cost/model values as `null` rather than estimating them.
