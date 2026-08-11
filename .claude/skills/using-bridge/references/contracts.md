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
    ]
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
- Use `commit_or_diff: null` when neither exists.
