# Changelog

This project is **experimental and pre-1.0**. It has made no production release. Entries record
checkpoints, not compatibility promises: while the major version is `0`, any release may
contain breaking changes to the MCP tool surface, the task lifecycle, error codes, the
persisted schema, the telemetry shape, or the documented workflows. See
[docs/release-policy.md](docs/release-policy.md).

Grouped as Added / Changed / Fixed / Documentation / Security. Breaking changes are called out
explicitly.

## Unreleased

No changes recorded yet.

## 0.3.0 — 2026-10-03

### Fixed

- Reject overlapping leases between distinct tasks of the same holder; allow subdivision
  only within the same task. Scope checks can accept a task identity for that exemption.
- Add lossless event pagination through `next_cursor`, `has_more`, and `head_event_id`.
  The deprecated `last_event_id` retains its historical global-head meaning.
- Preserve `SCOPE_CONFLICT` on preparation failures and block without opening a runtime
  attempt or immediately retrying contention.
- Enforce Claude adapter concurrency with a bounded FIFO queue and isolated queued-call
  cancellation. Add bounded Codex admission and SQLite per-agent capacity shared by server
  processes using the same database, including quarantined workers.
- Discover failed sessions eligible for strict recovery using existing interruption evidence.
- Require positive correlated Codex stop evidence; unknown terminal statuses, local aborts
  and interrupt acknowledgements never free a possibly active scope. Fence late callbacks
  and preserve quarantine beyond expiry and same-task subdivision.
- Persist whole-operation delegation idempotency, frozen recovery outcomes and original
  contracts/budgets. Refuse automatic replay of abandoned authorized launches, and defer
  recovery attempt creation until admission. Resolve input bytes before reservations.
- Preserve completed business work independently of typed observation storage/privacy/schema
  failures. Repair stored validated observations without invoking the worker again.
- Classify runtime quota, authentication, transient, profile, contract and turn-limit faults;
  retain only provider-supplied retry times and prohibit unchanged quota/auth/profile retries.
- Consume indented Markdown fences correctly when extracting Claude's structured result;
  other-language closing fences no longer hide real verification evidence.
- Preserve historical database bytes when rejecting future or malformed schemas, including
  WAL-only metadata, and make v1-v3 migrations transactional under concurrent startup.
- Reopen a failed writable startup once after SQLite reports a read-only pager during
  concurrent WAL initialization; repeat schema preflight and preserve persistent failures.

### Added

- Add opt-in read-only MCP Apps delegation tracking with a dotted graph, keyboard list,
  attempt/resume details, paged history and authenticated loopback browser fallback.
- Add an independent stdio tracking observer for private MCP tunnels, without a writable
  control plane, runtime adapter, recovery or delegation tools.
- Preserve private task content through an allowlisted projection, signed scoped cursors,
  separate UI preferences, visibility-aware bounded polling and independent view closure.

- Add versioned bridge-clock attempt, queue, startup, work and separate observation-seal
  spans without redefining cumulative legacy or provider durations.
- Generate three client skill mirrors from `skills/using-bridge/` and verify their consistency
  through `skills:check` and the deterministic suite.
- Add targeted `bridge_cancel_task`, prelaunch `bridge_continue_task`, and
  `bridge_repair_observation`, with owner/direct-manager lineage checks.
- Add `bridge_doctor` and an offline, read-only snapshot CLI for startup/disk identity and
  safe aggregate diagnostics without model calls or historical migrations.
- Add Linux/Windows GitHub Actions validation and a manually dispatched release workflow
  that creates source, compiled, skill, SHA-256 and CycloneDX dependency assets in a draft.
- Add a root security policy, community conduct, issue/PR templates and Dependabot updates.

### Changed

- Build a bundled self-contained tracking resource and synchronize opt-in guidance across
  all three client skill mirrors. Upgrade the compatible test runner and patched transitive
  dependencies; keep MCP Apps SDK1.7.5 compatible with the existing MCP SDK1.x/Zod3 stack.
- Align all workspace packages, internal dependencies and runtime release identities on
  `0.3.0`; keep protocol version `1.3.0` and persisted schema version `4` distinct.

- **Compatibility:** native Codex now defaults to App Server; legacy MCP is explicit opt-in.
  Unsupported implicit OpenAI desktop models use the installed CLI's advertised default;
  explicit unsupported selections fail before launch, without changing user configuration.
- **Persistence:** schema v4 adds durable operations, execution admission and observation
  records. Older writers must not open the upgraded database; rollback restores a compatible
  code/database pair. See [the release guide](docs/BRIDGE_RELEASE_ROLLBACK.md).

### Documentation

- Record implementation, validation and evidence limits for the October bridge analysis in
  [the patch tracker](docs/SUIVI_PATCHS_BRIDGE_2026-10-01.md).
- Document downloadable release installation, dependency provenance, private tracking setup
  and the requirement to reload already-running MCP clients.

## 0.2.0 — 2026-08-13

### Added

- Add manager-authorized strict recovery for direct delegated child tasks through
  `bridge_resume_delegated_task`.
- Add a locally linkable `claude-codex-bridge` executable for external project use.
- Add portable external project configuration examples for Codex and Claude Code.
- Add a manually maintained routing policy for bounded delegation decisions.
- Add deterministic synchronization checks for the Claude/Codex skill mirrors.
- Add regression coverage for external workspace selection and linked-launcher startup.

### Changed

- Make the native launcher's workspace default to the process current working directory rather
  than the Bridge source repository.
- Allow a manager to request strict recovery of its direct delegated child while execution
  identity, ownership, leases, telemetry, and session handles remain worker-owned.
- Require substantial tasks to evaluate useful bounded delegation while trivial and tightly
  coupled work remains local.
- Allow external repositories to use the Bridge without containing its source launcher.
- Disable only the project MCP entry named `bridge` inside delegated Codex worker threads to
  prevent recursive manager-server startup while preserving unrelated project MCP servers.

### Fixed

- Fix the recovery dead end where a manager could delegate to another runtime but could not
  safely request strict recovery of that worker.
- Preserve linked-launcher execution through Windows npm junctions and record the launcher's
  Unix executable bit.
- Handle bidirectional Codex App Server requests instead of treating them as ordinary RPC
  responses, and fail closed for unsupported interactive requests.
- Report failed Codex turns immediately when the runtime emits no token-usage event, rather
  than waiting until the delegated deadline or fabricating telemetry.
- Document that custom MCP SDK wrappers must set a request timeout longer than the bounded
  worker deadline instead of relying on the SDK's 60-second default.

### Documentation

- Document external repository installation and bidirectional manager/worker behavior.
- Document owner recovery versus manager-authorized delegated recovery.
- Document manual routing policy maintenance and the prohibition on quota-based or automatic
  benchmark routing.
- Document project trust, linked binary lifetime, external `.bridge/` ownership, and the
  non-recursive Codex worker configuration.

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
