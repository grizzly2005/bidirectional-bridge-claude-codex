# Security and privacy

## Status

**Experimental · Pre-1.0 · under active development · not production-certified.**

This is experimental local tooling, not a production security boundary. The implementation
has deterministic safety checks, but production security and large-scale reliability have
not been proven, and no external security review has been performed. Security-relevant
behavior may change in any release; see [release-policy.md](release-policy.md).

## Trust boundary

- Project MCP configuration can launch local programs. Review `.mcp.json` and
  `.codex/config.toml` before granting project trust.
- Delegated runtimes can receive file and shell tools. Bridge scopes and leases are
  coordination contracts, not an operating-system sandbox.
- Use only trusted repositories, local tasks, disposable test data, and accounts you are
  authorized to access.
- Keep the bridge local. Do not expose its stdio server or SQLite database as a network
  service without a separate threat model and authentication design.

## Sensitive state

Never publish or commit:

- `.bridge/` databases or WAL/SHM sidecars;
- Claude or Codex trust state;
- raw execution handles, prompts, transcripts, or runtime frames;
- credentials, `.env` files, private keys, or authentication material;
- logs, temporary task directories, `node_modules`, coverage, or build output.

The repository `.gitignore` covers these common paths and formats, but ignore rules are not
a substitute for reviewing `git status`, the staged diff, and a secret scan.

## Built-in controls

- startup-bound caller identity and contradiction rejection;
- server-side delegation allow/deny policy;
- task ownership, expiring leases, and conservative scope conflict checks;
- parent/depth validation and ancestor-loop protection;
- deadlines and bounded retry counts;
- verification-gated `COMPLETE` deliverables;
- capped, printable, credential-screened execution handles;
- telemetry schemas that omit raw prompts, responses, authentication, and handles.

These controls reduce coordination mistakes. They do not prove resistance to malicious
clients, compromised runtimes, dependency attacks, or hostile shell commands.

## Before publishing or backing up

Run the local gates, inspect tracked `BENCHMARK/` proofs for identities and absolute user
paths, confirm only explicit redaction markers represent handles, and verify that staged
paths contain no runtime or private state. Stop before pushing to any remote if a finding
cannot be explained and removed safely. The release checklist in
[release-policy.md](release-policy.md#release-checklist) lists the gates in order.

## Reporting a vulnerability

Report suspected vulnerabilities privately by opening a GitHub security advisory on this
repository, or by opening an issue that describes the impact **without** a working exploit,
credentials, or captured private state. Please include:

- the affected component and revision;
- the exact command or tool call sequence;
- the observed versus expected behavior;
- the stable error `code`, if one was returned.

Never attach execution handles, prompts, transcripts, client trust state, `.bridge/`
databases, or credentials to a report; redact them first. Because the project is experimental
and maintained on a best-effort basis, no response time is guaranteed and there is no bounty.
Fixes with security impact are recorded in [CHANGELOG.md](../CHANGELOG.md).
