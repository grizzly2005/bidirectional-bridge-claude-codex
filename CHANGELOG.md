# Changelog

This project is **experimental and pre-1.0**. It has made no production release. Entries record
checkpoints, not compatibility promises: while the major version is `0`, any release may
contain breaking changes to the MCP tool surface, the task lifecycle, error codes, the
persisted schema, the telemetry shape, or the documented workflows. See
[docs/release-policy.md](docs/release-policy.md).

Grouped as Added / Changed / Fixed / Documentation / Security. Breaking changes are called out
explicitly.

## 0.1.0 — 2026-08-11

### Documentation

- Rewrite `README.md` for a public audience: status banner, purpose, architecture, Node
  `>=22.13.0` requirement, the deterministic `npm ci` → `npm run build` → `npm test` workflow,
  quick start, both project-scoped MCP configurations, the `using-bridge` skill, bounded
  delegation with one Claude-to-Codex and one Codex-to-Claude worked example, ownership and
  leases, recovery, telemetry, troubleshooting, security, contribution, and release policy.
- Label the project Experimental, Pre-1.0, under active development, and not
  production-certified across the public documentation set, and state that APIs and workflows
  may change.
- Add `docs/troubleshooting.md`: symptom-first guidance for setup, MCP discovery and identity,
  ownership and lease errors, delegation and completion gates, recovery, telemetry `null`
  fields, and repository state.
- Add `docs/release-policy.md`: what pre-1.0 means for each interface, the versioning scheme,
  the changelog convention, the release checklist, claim discipline, licensing, and 1.0
  preconditions.
- Add `docs/tools/check-doc-links.mjs`, a dependency-free gate for broken relative links,
  missing heading anchors, and absolute filesystem paths in the public docs.
- Add a vulnerability-reporting section to `docs/security.md` and note that no external
  security review has been performed.
- Add concrete bidirectional delegation examples and an ownership-and-leases section to
  `docs/usage.md`.
- Restate the claim boundary throughout: no benchmark superiority, token or economic savings,
  production security or readiness, large-scale reliability, or optimal autonomous routing.
- Add the standard MIT License and keep every npm workspace package private from registry
  publication.

### Earlier in this cycle

- Position the bridge as an experimental, local Claude Code and Codex coordination system.
- Document installation, native project MCP usage, architecture, telemetry, recovery, security
  boundaries, and the roadmap.
- Record proven behavior separately from claims that still require controlled benchmarking.
- Package the same bounded `using-bridge` skill for project-local Claude Code and Codex
  discovery, and document its opt-in manager workflow.

### Repository hygiene

- Keep runtime SQLite state, generated output, local trust state, temporary files, and
  credential containers outside version control.
- Version only the shared `using-bridge` subtrees beneath otherwise private client-state
  directories.

### Fixed

- Make every bridge-created Claude worker request the protected `opus` / `high` runtime
  profile, persist requested versus actual model evidence, and reject reported non-Opus runs.
- Add a finite persisted Claude turn-budget contract: 1–64 turns, default 12, with 32 as the
  documented starting value for bounded repository audits and identical strict-resume use.
- Stop the Claude adapter from reporting allowed scope globs as changed files when a runtime
  omits exact paths, including blocked read-only runs.
- Replace generic "re-delegate" advice for blocked Claude work with same-task recovery
  guidance.
- Upgrade the deterministic test stack to fixed Vitest and Vite releases after the clean
  install exposed critical/high development-server advisories.

### Core bridge

- Add native MCP composition, runtime telemetry, same-task recovery, deterministic tests, and
  redacted proof artifacts.
