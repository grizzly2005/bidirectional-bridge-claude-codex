# Telemetry

The bridge persists one normalized final telemetry record per task attempt. Telemetry exists
for local observation and later controlled analysis. It is not evidence of a performance,
cost, or efficiency advantage, and the record shape may change while the project is pre-1.0.

## What is recorded

- run, task, attempt, parent, depth, and worker identity;
- runtime and runtime version;
- bridge-requested model and effort configuration, plus the actual model when authoritatively
  reported by the runtime;
- orchestration and runtime timing;
- input, output, cache, and total token counts when emitted by the runtime;
- runtime-reported cost and its semantics;
- turn count, input-artifact measurements, termination kind, and process exit code.

Unknown fields remain `null`. The bridge does not estimate missing manager tokens, derive
tokens from text length, or treat cumulative session usage as per-attempt usage.

## Runtime sources

Claude telemetry comes from the Claude Code `stream-json` result frame. Codex telemetry uses
correlated official App Server token notifications with the default native transport. Cached
token categories are subdimensions of input and must not be added to input a second time.

For Claude, `requested_model=opus` and `requested_effort=high` are launch-configuration
evidence. `model` remains the separate runtime-reported actual model. Claude Code 2.1.226 does
not expose effective effort in the machine-readable frames this adapter consumes, so the
bridge does not claim runtime-reported effort verification.

`runtime_reported` cost is not confirmed billing. In particular,
`billing_mode_known=false` means the value must not be presented as an invoice.

The installed Codex CLI's official model catalog determines compatibility for its OpenAI
provider. An implicit desktop model missing from that catalog uses its uniquely advertised
default before launch; an explicit unsupported selection fails. Custom provider model names
retain their configuration. Telemetry reports the actual runtime model, and the bridge does
not modify user configuration or authentication.

## Business outcome and observation receipt

`spec.telemetry_mode` defaults to `operational`. A correlated completed turn with no usage
notification may finish with null token fields. `strict` requires accepted measurement
evidence; it does not invent missing usage or undo a completed business deliverable.

The attempt's observation receipt records COMPLETE, INCOMPLETE or REJECTED, an acceptance
flag, a strict-acceptance flag and a typed category (storage, schema, privacy or usage
unavailable). A business task can be DONE while strict observation returns
`TELEMETRY_INCOMPLETE`. A failed storage seal preserves the validated draft and its typed
incomplete status. Privacy rejection stores no raw telemetry. Schema disagreement with an
already sealed record preserves that record and records the rejection.

`bridge_repair_observation` retries sealing the stored validated draft as owner or proven
direct manager. It never accepts caller-supplied metrics, invokes a model or repeats business
work. Repeating a completed repair returns the same receipt. It cannot manufacture provider
usage missing from the original attempt. Legacy records retain unknown measurement status.

## Duration sources

`duration_measurement_version: 2` keeps legacy `wall_duration_ms` cumulative and adds
delegation elapsed, attempt wall, queue, startup and work spans. Missing or reversed clocks
produce null component spans. `runtime_duration_source` identifies provider wall, provider
API or a local span; these are not interchangeable CPU or billable-time measurements.
Do not add cumulative delegation elapsed times across retry attempts.

Observation receipts separately contain local seal start/end/duration and
`seal_measurement_version: 1`. That span measures sealing, not the durability time of the
enclosing business transaction. Telemetry's `seal_duration_ms` remains null because the
immutable telemetry record cannot measure its own commit.

## Privacy boundary

Durable telemetry has no raw prompt, assistant response, transcript, authentication, or
execution-handle field. Runtime identity strings are screened for credential-shaped values.
Proof artifacts retain only redacted, minimum evidence.

Use `bridge_query_telemetry` to read final records by run, task, worker, or attempt. The full
field definition and normalization rules are in
[BENCHMARK/telemetry/schema.md](../BENCHMARK/telemetry/schema.md).

## How it is used today

The current strategy is passive observation during real project work. Telemetry may reveal
failure patterns or tuning opportunities, but it does not establish superiority, savings,
or economic efficiency without a later controlled benchmark. See
[roadmap.md](roadmap.md) for what such a benchmark would have to define first, and
[troubleshooting.md](troubleshooting.md#telemetry) for why fields are commonly `null`.
