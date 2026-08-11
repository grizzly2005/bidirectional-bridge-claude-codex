# Neutral attempt telemetry v1

`AttemptTelemetry` is the smallest runtime-neutral record used by the first controlled
Claude-alone, Codex-alone, and bridged benchmark. Experimental mode is associated with a
`run_id` by the external harness; no benchmark-mode name is part of the generic protocol.

## Durability and lineage

The control plane writes exactly one final record for each `(task_id, attempt)` pair.
Records are queryable by `run_id`, `task_id`, `agent`, and `attempt`, and the append-only
event log emits `attempt.telemetry_recorded` after the row commits.

Every task has:

- `run_id`: generated once for a root task or inherited from its parent;
- `parent_task_id`: `null` for a root, otherwise an existing immediate parent;
- `delegation_depth`: `0` for a root and exactly `parent.delegation_depth + 1` for a child.

The control plane rejects a child-supplied run or depth that disagrees with its parent and
rejects depth above 32. Retries retain the same task lineage but produce distinct attempt
records.

## Final record

Unknown runtime observations are stored as `null`; authoritative control-plane identity,
lineage, orchestration timing, and artifact counts are always present.

| Group | Fields |
| --- | --- |
| Identity | `run_id`, `task_id`, `attempt`, `agent`, `runtime`, `runtime_version`, `requested_model`, `requested_effort`, `model`, `parent_task_id`, `delegation_depth` |
| Timing | `orchestration_started_at`, `runtime_started_at`, `first_output_at`, `runtime_ended_at`, `completed_at`, `wall_duration_ms`, `runtime_duration_ms` |
| Usage | `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`, `total_tokens`, `turn_count`, `cumulative_session_tokens` |
| Cost | `reported_cost_usd`, `cost_semantics`, `billing_mode_known` |
| Context | `prompt_bytes`, `input_artifact_count`, `input_artifact_bytes` |
| Runtime health | `termination_kind`, `process_exit_code` |

`termination_kind` is one of `completed`, `failed`, `cancelled`, `timeout`, `crash`, or
`unknown`. `cost_semantics` is one of `billed`, `runtime_reported`,
`api_equivalent_estimate`, or `unavailable`.

## Token normalization

`input_tokens` means total input consumed by the attempt. Cached input and cache-creation
input are retained as subdimensions and are not added to `input_tokens` a second time.
Consequently, when both are known:

```text
total_tokens = input_tokens + output_tokens
```

If a runtime does not emit `total_tokens`, the neutral finalizer derives only that sum. It
does not tokenize text, estimate from bytes, or use account-wide usage deltas.

For Codex App Server, one Codex turn can contain multiple model calls around tool use.
Each strictly newer `thread/tokenUsage/updated` notification contributes its `last`
breakdown to the attempt; duplicate notifications with the same cumulative total are
ignored. The latest notification's `total.totalTokens` is retained only as
`cumulative_session_tokens`. This keeps per-attempt usage distinct from cumulative thread
usage, including after resume.

## Collection boundary

Adapters may submit sparse `AttemptTelemetryUpdate` observations while running. Those
updates remain in memory. When the attempt ends, the control plane projects an explicit
allowlist into the complete neutral shape and persists it once. An adapter cannot override
the authoritative run, task, attempt, agent, parent, depth, orchestration timestamps, or
input-artifact measurements.

The durable schema has no fields for raw prompts, assistant text, conversation history,
authentication data, or raw execution handles. Unknown adapter keys are discarded;
credential-shaped values in the only free-form identity fields (`runtime`,
`runtime_version`, `requested_model`, `requested_effort`, `model`) are rejected. The telemetry event contains only correlation,
attempt, termination kind, and whether mandatory numeric token fields are present.

## Codex execution transport decision

The certified `codex mcp-server` tools return thread ID and textual content but do not
expose usage notifications. A passive process cannot subscribe to notifications from that
separate MCP execution process, so a reliable sidecar was not available. The benchmark
uses an opt-in official Codex App Server client that correlates notifications to both the
created thread ID and turn ID. The existing MCP client remains the default and regression
path; it was not removed.

## Claude Code mapping

The Claude-owned runner reads the installed Claude Code `stream-json` protocol. It uses
the final `result` frame, not model-written deliverable text, for `usage`, `duration_ms`,
`duration_api_ms`, `num_turns`, and `total_cost_usd`. Runtime version comes from the real
CLI version probe. A model is retained only when the runtime exposes one unambiguously;
otherwise it is `null`.

The runner separately records the bridge-owned launch request as `requested_model=opus` and
`requested_effort=high`. Those fields are configuration evidence, not inferred runtime
facts. Current Claude Code stream frames do not expose effective effort, so no effective
effort field is fabricated. A clearly reported non-Opus actual model fails the attempt with
`RUNTIME_PROFILE_MISMATCH`; a missing actual model remains `null`.

Claude Code 2.1.x reports uncached, cache-read, and cache-creation input separately. The
neutral mapping is therefore:

```text
input_tokens = usage.input_tokens
             + usage.cache_read_input_tokens
             + usage.cache_creation_input_tokens
cached_input_tokens = usage.cache_read_input_tokens
cache_creation_input_tokens = usage.cache_creation_input_tokens
total_tokens = input_tokens + usage.output_tokens
```

The runner accepts the per-TTL `usage.cache_creation` map only as a compatibility fallback
when the flat cache-creation count is absent. Invalid or missing counts become `null`, not
zero. `runtime_duration_ms` prefers the runtime's `duration_ms` and otherwise uses the
locally measured child-process interval. The runtime's `duration_api_ms` remains a
Claude-local diagnostic because the neutral v1 schema has no separate API-duration field.

`total_cost_usd` maps to `reported_cost_usd` with
`cost_semantics = runtime_reported` and `billing_mode_known = false`. Subscription usage
means that value must not be interpreted as an invoice or proven billed amount.

Session IDs are persisted only through the control plane's opaque execution-handle path.
They are intentionally absent from adapter telemetry, final records, events, and benchmark
exports. The structural frame probe can write only the same redacted digest it prints; it
has no raw-frame output mode.

## Live evidence

`live-proof.json` contains the redacted same-tree records for a real Claude root task, a
real Codex root task, and a Codex-manager to Claude-worker child. It also records handle
presence and length without the handle value. Runtime frames, prompts, assistant output,
authentication material, temporary database paths, and stderr content are not retained.
