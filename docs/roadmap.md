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

## Three-runtime architecture backlog (0.5.0 onward)

Version 0.5.0 adds Gemini (Google Antigravity) as a third runtime, giving six logical
delegation directions. The working rule, consistent with 2026 multi-agent research supplied
by the maintainer (adaptive sparse DAGs over permanent meshes; evidence over consensus;
blind review; error-cascade control), is: **all six directions are addressable, few are
active per task**, and the deterministic control plane owns state, budgets and permissions.
Candidate work, none of it committed or dated:

- per-attempt Git worktrees on a pinned base revision, with revision-checked integration so
  evidence produced on an older revision cannot certify a newer one;
- monotonic fencing tokens on leases checked at every protected write;
- a provenance DAG (`causal_parent_ids`, base revision, artifact digests) exported with
  telemetry, plus OpenTelemetry-style spans for delegation, review and verification;
- reviewer-isolation by default in `bridge_delegate` review contracts;
- a value-of-information gate for second/third opinions, first in shadow mode;
- fault-injection tests (duplicate, delayed, reordered and crashed attempts);
- a paired, repeated evaluation (single runtime, each pair, three runtimes sparse/adaptive,
  per-direction ablations) under comparable token budgets before any routing claim.

## Later controlled benchmark

Plan and run comparable Claude-alone, Codex-alone, and bridged tasks only after the
dogfooding phase supplies stable scenarios and an accepted cost budget. The future harness
must define task equivalence, success criteria, repetitions, failure handling, and token/cost
semantics before execution.

Controlled benchmarking is planned but has not been completed. Until then the project makes
no claim of superiority, token savings, economic efficiency, or benchmark advantage.

## Not a current goal

Production deployment, multi-machine coordination, autonomous model routing, automatic
quota balancing, and automatic Git merging remain outside this experimental checkpoint. A
user-requested delegation share is followed by the manager skill, not by automatic routing;
the read-only localhost dashboard is an observation aid, not a supervision console. The bridge does not attempt to route work to the "better" model automatically,
and no such routing has been shown to be optimal.
