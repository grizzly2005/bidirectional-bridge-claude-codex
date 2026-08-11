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
correlated official App Server token notifications when that transport is selected. Cached
token categories are subdimensions of input and must not be added to input a second time.

For Claude, `requested_model=opus` and `requested_effort=high` are launch-configuration
evidence. `model` remains the separate runtime-reported actual model. Claude Code 2.1.226 does
not expose effective effort in the machine-readable frames this adapter consumes, so the
bridge does not claim runtime-reported effort verification.

`runtime_reported` cost is not confirmed billing. In particular,
`billing_mode_known=false` means the value must not be presented as an invoice.

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
