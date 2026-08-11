# Contributing

This project is **experimental, pre-1.0, under active development, and not
production-certified**. Interfaces and workflows may change without a migration path — read
[docs/release-policy.md](docs/release-policy.md) before planning a larger change.

Contributions are welcome. Small, local, evidence-backed changes are much more likely to land
than broad redesigns.

## Ways to contribute

- **Bug reports** — include the exact command, its real exit code, the stable bridge error
  `code`, your Node version, and redacted state. Never attach execution handles, prompts,
  transcripts, client trust state, `.bridge/` databases, or credentials.
- **Documentation fixes** — especially anything inaccurate, unsupported, or stale.
- **Deterministic tests** — reproductions of real failures are valuable on their own.
- **Focused code changes** — one problem per pull request.

Before starting something substantial, open an issue describing the problem and the intended
approach. Reporting a suspected vulnerability is different: follow
[docs/security.md](docs/security.md#reporting-a-vulnerability) instead of filing a public issue
with exploit details.

## Set up

Requires Node.js **>= 22.13.0**. See [docs/installation.md](docs/installation.md), then run
the deterministic workflow from the repository root:

```bash
npm ci          # deterministic install from the committed lockfile
npm run build   # tsc --build
npm test        # vitest run
```

Use `npm ci`, not `npm install`, so your dependency tree matches everyone else's. Optional:
`npm run typecheck` for a forced clean type build, and `npm ls` to inspect the workspace tree.

## Local gates

Every change should pass, with real exit codes:

```bash
npm run build
npm test
node docs/tools/check-doc-links.mjs   # broken links, bad anchors, absolute paths
```

A complete checkpoint must also pass the certification command:

```bash
node scripts/certification-manifest.mjs
```

Report what you actually ran. Do not paste a test count from memory, and do not describe a
check you did not execute.

## Working rules

- Read [docs/architecture.md](docs/architecture.md) and the normative
  [bridge protocol](docs/PROTOCOL.md) before changing boundaries or lifecycle behavior. Where
  prose and the exported schemas disagree, the schemas win.
- Respect the package dependency direction: protocol → control plane → MCP server core →
  adapters. An agent-neutral package must never import an agent-specific one, and the two
  adapters must never import each other.
- When working alongside another agent in this repository, register bounded work, declare its
  write scope, and acquire a bridge lease before editing. Do not write inside another holder's
  overlapping scope.
- Add deterministic regression coverage for behavior changes. Tests must not depend on real
  model calls, wall-clock timing, or network access.
- Do not redesign the bridge as part of an unrelated fix.
- Do not run real-model proofs or controlled benchmarks unless the task specifically needs them
  and their cost has been accepted.

## Claim discipline

This project holds its own documentation to the same standard it asks agents to meet. Do not
claim performance advantages, token or economic savings, production security or readiness,
large-scale reliability, benchmark superiority, or optimal autonomous routing. None of these
have been established. State what the committed tests and redacted evidence actually show, and
mark anything else as unproven.

## Pull requests

- One focused change per pull request, with a clear problem statement.
- Use focused, imperative commit subjects.
- Include the commands you ran and their exit codes in the description.
- Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for any user-visible change, and call
  out breaking changes explicitly — a `0.x` version number does not communicate impact.
- Update the affected documentation in the same pull request.

## Privacy and repository hygiene

Never commit runtime databases, raw execution handles, prompts, transcripts, credentials,
client trust state, logs, temporary task directories, dependencies, or build output. Proof
artifacts must be redacted and contain only the minimum evidence needed to reproduce the
claim. Documentation must contain no absolute user paths; the documentation gate checks this.
See [docs/security.md](docs/security.md).

Before committing, inspect the staged paths and run both `git diff --check` and
`git diff --cached --check`. Never move or recreate an existing published release tag.

## Licensing

This project is licensed under the [MIT License](LICENSE). By contributing, you agree that
your contribution may be distributed under that license.
