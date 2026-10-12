# Bridge contracts

Load this reference only when constructing an unfamiliar delegation payload or validating a worker result.

## Canonical bounded delegation

```json
{
  "to": "codex",
  "run_id": "run_from_root",
  "parent_task_id": "task_root",
  "delegation_depth": 1,
  "spec": {
    "objective": "Inspect the configured entrypoint and report two facts without modifying files.",
    "scope": {
      "paths": ["(no-write)/**"],
      "note": "No writes; return evidence inline."
    },
    "dependencies": [],
    "expected_deliverable": "Two facts with exact file and command evidence.",
    "verification_criteria": [
      "The cited path exists.",
      "The reported command output is verbatim."
    ],
    "telemetry_mode": "operational"
  },
  "input_artifacts": [],
  "deadline_ms": 600000,
  "max_attempts": 0,
  "idempotency_key": "task_root:delegate:1"
}
```

Swap `to` for the opposite runtime. Preserve the actual root run, parent, and depth. Omit caller identity because the server binds it at startup.

## Worker result

```json
{
  "status": "COMPLETE",
  "summary": "Short factual result.",
  "changed_scope": [],
  "artifacts": [
    {
      "kind": "report",
      "name": "Evidence",
      "media_type": "text/plain",
      "inline": "Compact evidence produced for this task.",
      "metadata": {}
    }
  ],
  "commit_or_diff": null,
  "verification_results": [
    {
      "kind": "manual",
      "command": "exact command that ran",
      "passed": true,
      "exit_code": 0,
      "summary": "What the real result established.",
      "duration_ms": 100,
      "output_excerpt": "short real output"
    }
  ],
  "remaining_risks": [],
  "recommended_next_action": "One bounded next action."
}
```

## Validation rules

- Use `COMPLETE` only with at least one real passing verification and no failing verification.
- Use `PARTIAL` for useful incomplete work, missing evidence, runtime limits, blockers, or recoverable uncertainty.
- Use `FAILED` when the bounded objective itself failed.
- List only files actually changed in `changed_scope`; read-only work uses `[]`.
- An inspected source/config file is not a produced path artifact.
- A path artifact must exist, be repo-relative, and fit the leased output scope. Use inline evidence for read-only facts.
- Each artifact uses exactly one of `path` or `inline`.
- Preserve exact exit codes and commands. Never convert free-text claims into verification evidence.
- `passed` must agree with a known process exit code; command checks require a code. Only
  explicit manual checks may use `null`. Wrap negative tests in an assertion that exits zero.
- Use `commit_or_diff: null` when neither exists.

## Intermediate Claude checkpoints

For work with several milestones, ask the worker to send up to four separate fenced JSON
messages in this shape before its final deliverable:

```json
{"bridge_checkpoint":{"schema_version":1,"summary":"Bounded findings and progress.","verification_results":[],"remaining_risks":["Final review pending."]}}
```

The runner publishes only this explicit projection, never arbitrary assistant messages.
Keep the summary within 2000 characters, at most eight checks and eight risks. A check uses
`kind`, the exact `command`, `passed`, `exit_code` and `summary`; output logs and additional
fields are refused. Do not include credentials, runtime handles, prompts or transcripts.
Secret and handle checks are guardrails, not exhaustive data-loss prevention.

The final deliverable remains required. On a turn limit or interruption, a saved checkpoint
stays `PARTIAL` and carries its evidence and artifact references. If an intermediate command
failed, rerun that same check after fixing it so the final evidence can supersede its failure.

## Replay and observations

Keep one stable key for the complete normalized delegation request, including inputs,
lineage and budgets. Concurrent callers join one durable operation; a completed replay
returns its frozen outcome without another invocation. A changed payload under the same
key fails with `IDEMPOTENCY_MISMATCH`. If a process dies after launch authorization, the
bridge reports uncertainty and fences the scope rather than automatically launching again.

`outcome.deliverable` describes business work. `outcome.observation` separately reports
measurement acceptance (`COMPLETE`, `INCOMPLETE`, `REJECTED`, or a legacy unknown status).
Operational mode can accept useful work with unavailable usage fields. Strict mode can
return `TELEMETRY_INCOMPLETE` even when the business task is `DONE`; repair the persisted
observation, never repeat the business work to obtain measurements.
