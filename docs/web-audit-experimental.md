# Experimental web-audit workflow

This branch combines bridge reliability fixes with a small web-application investigation library, JSON campaign format, CLI and skill. It is separate from the release branch. It has no runtime dependency on PDX/BELIEF, new database, scanner or MCP server. The selector and collaboration policy are recommendations for an analyst; they do not automatically start another agent.

## Install and try it locally

From this checkout, with Node >=22.13:

```powershell
npm ci
npm run build
node scripts/web-audit.mjs --help
node shared/web-audit/examples/cli-smoke.mjs
```

The smoke starts a real HTTP server on loopback and executes the JSON import, planning, timing, replay, verification, report, refutation packet and abstract pattern commands. All identities and objects are synthetic. It also changes the fixture to deny the object and checks that conflicting evidence removes confirmation. It does not measure bug-bounty performance.

For a persistent example and the complete schema, use the [skill's format guide](../skills/bridge-web-audit/references/formats-and-replay.md). Start with the executable fixture import generator, inspect the generated fields and author a new binding for the application under investigation. The current importer accepts this versioned JSON format; it has no HAR/Burp importer or browser instrumentation.

## Investigation loop

1. Record exact origin, method, route/query shape and actor, role, object, owner, actor/object tenant and business state. Mark missing facts unknown. Capture bytes and derived JSON remain separate.
2. Write a hypothesis, competing predictions, prerequisites and a discriminating test. `plan` ranks current hypotheses with an explicit score and stable tie-break; it reports missing witnesses and estimated cost. This is a heuristic, not calibrated information gain.
3. Start a campaign timer. Use one agent for mechanical capture; request a second analyst for business-state reasoning or a promising track. `refutation-input` gives the second analyst receipts and policy without the saved verdict/history.
4. Run explicitly idempotent read recipes. The recorder preserves timeout, error and truncated outcomes and saves each result. It follows no redirects and makes no retries. `verify` recalculates the evidence; model agreement or HTTP 200 alone cannot confirm a finding.
5. Reopen after a session/application/state change. Old history remains, but the new evidence epoch requires fresh receipts. Changing the hypothesis definition requires a new ID.
6. Author an abstract lesson separately. `pattern-export` checks common concrete target facts; `pattern-import` creates an unconfirmed hypothesis in a new program. Review the abstraction for names and short identifiers that string rules cannot identify.
7. Stop the timer and review `report` or `compare`. Unique finding keys receive credit at their earliest sufficient confirmation before lane attribution. Later replays do not shift discovery credit. Include unsuccessful investigation and refutation time.

Automatic confirmation currently covers a differential GET read with two actors, two owned-object baselines, a protected-object probe, a negative control, response actor markers, explicit policy/state/tenant prerequisites and at least two independent complete runs. Stateful mutations need separately captured causal controls; this runner does not execute them. Apps without suitable actor markers remain inconclusive under this oracle.

## Bridge changes on this branch

| Area | Result |
| --- | --- |
| Claude inputs (F01/F03) | Resolved inline/path artifacts reach the worker; prompt travels through stdin with EOF, pipe-error handling and cancellation, rather than Windows command-line arguments. |
| Read-only scope / path names (F02/F07) | Reserved `(no-write)` scopes grant no write path, may coexist across different tasks and preserve durable task authority. Parent `..` segments are rejected; ordinary names containing `..` are allowed. Codex native starts and continuations request read-only sandboxing. |
| Existing pending tasks (F04) | `runReady` reserves and executes the existing task transactionally, keeping its ID, specification, dependencies and explicit input artifacts. |
| Verification freshness (F05) | Schema 5 associates checks and deliverables with the current attempt. Historical unknown attempts remain NULL and cannot validate a later attempt. |
| Large Codex outputs (F06) | Oversized inline output is preserved in UTF-8 byte-bounded fragments with an ordered hash manifest; publication failures retain partial results without claiming a complete manifest. |
| Rejected completion (F08) | A verification rejection preserves a PARTIAL deliverable, artifacts and checks on a BLOCKED task. Storage/authority failures and an unconfirmed runtime stop retain their own error handling. |
| Repair lifecycle (R1) | Every Codex structure-repair reply starts a new running interval. Unknown or negative stop evidence cannot inherit a prior response's stopped state. |

See [control-plane contracts](../shared/control-plane/README.md) and the focused adapter, protocol and control-plane tests. The bridge checks declared scope and runtime state; it is not an OS sandbox for Claude. A hash binds bytes, not business truth or an authenticated witness.

## State and release separation

Use an isolated database with this branch, for example:

```powershell
node scripts/native-bridge-mcp.mjs --caller codex --delegation allow --workspace . --db .bridge/experimental-web-audit.db
```

This starts an MCP stdio server, not an interactive shell command. Point the client's MCP configuration at the same arguments when using it. Older databases are migrated on open; older release binaries cannot read schema 6. Do not use the release's database for experiments. Campaign JSON files are independent from bridge state and currently require one writer at a time.

The [shared-memory extension](shared-memory.md) keeps working notes and references in this
SQLite state. It never turns the campaign JSON into a concurrent writer or a second finding ledger.

## Evidence and limits

Receipts retain exact canonical HTTP URLs, reported timing, request representation, response bytes and derived views. Reusing the same reported execution under another run ID cannot supply a second repetition. The JSON files are unsigned: someone rewriting all data can fabricate timings and recompute hashes. The retention mechanism is not an external audit anchor.

The campaign comparison separates local fixtures from authorized programs and reports comparability as unestablished. No real-program speedup or finding rate is claimed. Evaluate single-agent, memory, two-agent and two-agent-oracle lanes on comparable scope, budgets and conditions before drawing a performance conclusion.

The canonical skills are [using-bridge](../skills/using-bridge/SKILL.md) and [bridge-web-audit](../skills/bridge-web-audit/SKILL.md). `npm run skills:sync` maintains their Claude/Codex/agents mirrors; `npm run skills:check` checks parity.
