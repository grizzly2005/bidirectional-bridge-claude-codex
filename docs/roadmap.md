# Roadmap

The project is experimental, pre-1.0, and under active development. Nothing on this page is a
commitment or a date; see [release-policy.md](release-policy.md) for what stability does and
does not mean here.

## Current phase: experimental dogfooding

The repository is published so the design and its evidence can be inspected. Development
continues to be driven by real local use rather than by feature breadth:

```text
real project usage
-> passive telemetry
-> issue discovery
-> bridge tuning
-> later controlled benchmark
```

Dogfooding should favor bounded, useful project tasks. It should record runtime-reported
worker telemetry and concrete failures without adding synthetic benchmark infrastructure.

## Near term

- Use the bridge in real local development and collect actionable issues.
- Tighten lifecycle, recovery, adapter, and documentation behavior when dogfooding exposes a
  reproducible defect.
- Keep proof artifacts minimal, redacted, and local-first.
- Maintain deterministic tests and the closed certification manifest.

## Later controlled benchmark

Plan and run comparable Claude-alone, Codex-alone, and bridged tasks only after the
dogfooding phase supplies stable scenarios and an accepted cost budget. The future harness
must define task equivalence, success criteria, repetitions, failure handling, and token/cost
semantics before execution.

Controlled benchmarking is planned but has not been completed. Until then the project makes
no claim of superiority, token savings, economic efficiency, or benchmark advantage.

## Not a current goal

Production deployment, multi-machine coordination, a supervision UI, autonomous model
routing, quota balancing, and automatic Git merging remain outside this experimental
checkpoint. The bridge does not attempt to route work to the "better" model automatically,
and no such routing has been shown to be optimal.
