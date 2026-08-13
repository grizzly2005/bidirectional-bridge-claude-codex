# Release policy

## Status

**Experimental · Pre-1.0 · under active development · not production-certified.**

This is an experimental open-source checkpoint of a local coordination bridge. It is
published so the design and its evidence can be inspected and criticized, not because it is
finished or certified for production use.

## What "pre-1.0" means here

Everything below may change in any release, without a deprecation period and without an
automated migration path:

- MCP tool names, arguments, and response shapes;
- the task lifecycle, gates, and state transitions;
- error codes and their retryability;
- the persisted SQLite schema and the on-disk location of local state;
- the telemetry record shape and field semantics;
- the delegation contract, depth rules, and turn-budget defaults;
- the project-scoped configuration files and launcher arguments;
- documented workflows, including the ones in this repository's own docs.

The normative wire contract is [PROTOCOL.md](PROTOCOL.md), and its version marker is the
authority for what a given checkout implements. When prose and the exported schemas disagree,
the schemas win.

There is no compatibility guarantee, no support commitment, and no security certification. The
project does not promise that a database created by one revision will be readable by the next.

## Versioning

- The package/checkpoint version is `0.2.0` and the workspace root is marked `private`; nothing here is
  published to a package registry.
- While the major version is `0`, a minor bump may carry breaking changes. Treat every version
  change as potentially breaking and read the changelog.
- Stable public checkpoints use annotated Semantic Versioning tags and matching GitHub
  Releases. Published release tags are never moved or recreated.

## Changelog

Every user-visible change is recorded in [CHANGELOG.md](../CHANGELOG.md) under an
`Unreleased` heading until it ships, grouped as Added / Changed / Fixed / Documentation /
Security. Breaking changes are called out explicitly rather than being implied by a version
number, because a `0.x` number does not communicate impact on its own.

## Release checklist

A checkpoint is only prepared after these gates pass locally, with real exit codes:

```bash
npm ci                              # deterministic install from the lockfile
npm run build                       # compiled workspace packages
npm test                            # deterministic regression suite
node docs/tools/check-doc-links.mjs # documentation and internal-link gate
node scripts/certification-manifest.mjs
```

Then, before publishing anything:

1. inspect `git status` and the staged diff for runtime state, trust state, transcripts,
   handles, absolute user paths, or credentials;
2. confirm proof artifacts under `BENCHMARK/` remain minimal and redacted;
3. confirm the changelog entry matches what actually changed;
4. confirm no claim was added that the committed evidence does not support.

## Claim discipline

Release notes and documentation must not assert benchmark superiority, token or economic
savings, production security or readiness, large-scale reliability, or optimal autonomous
routing. None of those have been established for this project. Controlled Claude-alone versus
Codex-alone versus bridged benchmarking is planned but has not been run; until it is, the
project claims only what its committed tests and redacted evidence show. See
[roadmap.md](roadmap.md).

## Toward 1.0

A 1.0 would require, at minimum: a stable protocol and persisted schema with a migration
story, an external security review of the trust boundary, evidence of reliability beyond a
single machine and a single maintainer, and completed controlled benchmarking with a published
methodology. None of that exists today, and no date is committed.

## Licensing

The project is distributed under the [MIT License](../LICENSE). Package manifests remain
`private` because this release publishes source on GitHub and does not publish npm packages.

## Security issues

Security-relevant fixes are recorded in the changelog. Reporting instructions are in
[security.md](security.md#reporting-a-vulnerability). Given the experimental status, assume no
guaranteed response time.
