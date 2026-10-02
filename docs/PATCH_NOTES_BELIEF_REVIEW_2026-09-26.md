# BELIEF review: evidence and proposed bridge patches

Date: 2026-09-26. Bridge checkout: `a3d0d21`. BELIEF baseline: `0d0a592`.
Initial status: patch preparation. Runtime follow-up on 2026-09-27 is documented below.

## Corrected diagnosis

The manager requested `deadline_ms: 180000`, `max_attempts: 1` for review
`task_a7zt5cxg6y`, child of `task_2xjj7rc5r2`, run `run_z9tgtf74s3`
in the BELIEF workspace. It incorrectly interpreted this as one total attempt.

The current contract defines **additional retries**:

- `shared/protocol/src/types.ts:482`: “Max automatic retries by the caller”.
- `shared/control-plane/src/orchestrator.ts:111`: total attempts are
  `Math.max(1, (request.max_attempts ?? 0) + 1)`.
- `claude/claude-side/src/integration.test.ts:165` and
  `shared/control-plane/src/telemetry.test.ts:230` explicitly expect two attempts
  for `max_attempts: 1`.
- `orchestrator.ts:272,299` gives each attempt its own deadline.

Therefore two attempts are expected, not an off-by-one defect. For one attempt
under the current API, use **`max_attempts: 0`**. The earlier manager claim that
the bridge ignored its retry limit is withdrawn. MCP argument descriptions in
`shared/mcp-server-core/src/tools.ts:630-631` do not explain these semantics;
the JSON schema's “Hard stop” wording also fails to distinguish per-attempt
time from total elapsed time.

## Observed review outcome

`bridge_get_task` returned final state `FAILED`, two `TIMEOUT` attempts,
no deliverable, no artifacts, and no verifications. This is **not an approved
review**, nor evidence that the code has no remaining defects. No new Claude
review was launched during the remediation.

| Attempt | Runtime duration | Wall duration reported | Tokens/cost |
|---|---:|---:|---|
| 0 | 180040 ms | 180046 ms | unavailable |
| 1 | 180050 ms | 360100 ms | unavailable |

The wall duration on the second record is cumulative from orchestration start.
Do not add 180046 and 360100 to calculate total runtime. Null token/cost fields
must remain unknown, never zero.

The parent attempted `bridge_set_state(..., CANCELLED)` and received
`NOT_OWNER` (child owner Claude, caller Codex). This is consistent with the
owner guard in `shared/control-plane/src/task-service.ts:744`; do not weaken
that guard or impersonate the child. The tool surface has no parent cancellation
operation. The final task is `FAILED`, while `latest_status.state` still reads
`WORKING`; consumers must prefer the authoritative task state.

## Proposed patches and acceptance tests

1. **Clarify retry semantics without silently changing existing clients.**
   Describe `max_attempts` as additional retries in MCP and JSON schemas;
   consider an explicitly versioned `max_retries` alias. Test 0 => one attempt,
   1 => at most two, default => one; reject conflicting aliases. Display the
   resolved total-attempt budget to the caller before execution.
2. **Add an explicit total deadline.** Preserve the existing per-attempt
   deadline; add a total budget across retries, backoff and recovery. Calculate
   remaining time before each attempt and never restart a depleted budget.
   Fake-clock tests should prove a 180-second total budget cannot produce two
   180-second attempts. Persist that budget for recovery.
3. **Provide parent-authorized cancellation.** A dedicated operation should
   validate durable direct-parent ownership, cancel the active adapter process,
   suppress pending retries, release leases and persist a terminal result.
   Test unrelated-caller denial, idempotence, completion races, cancellation
   during backoff and restart recovery. Keep the child owner unchanged.
4. **Make review validity explicit.** Timeout, exit zero alone, empty deliverable
   or absent verification must not become review approval. Surface terminal
   state alongside stale progress, and distinguish supervisor validation from
   an independent review. Test terminal-state/progress inconsistency.
5. **Report budget coverage and attribution.** Label cumulative versus
   per-attempt durations. Preserve partial/unavailable usage on timeout; add
   manager telemetry where feasible with provenance and coverage. Do not claim
   token savings from a task-count ratio.

## BELIEF remediation and local validation

The pre-existing local fix rejects distant sinks, unrelated directories and
uncorroborated function matches. Local follow-up reproduced two additional
problems with synthetic Python: a summary map key could disguise another file,
and rejected recomputation could leave an old `open(folder)` audit sink.

Changes in BELIEF `belief/dataflow.py` now use the summary's declared file
identity, reject a path whose file differs from its summary, and remove stale
dataflow plus dependent cached hypotheses during refresh. Hypotheses without
dataflow dependencies are preserved. The normal pipeline recomputes hypotheses
after dataflow attachment. Five added test instances cover these cases;
four failed before the fix and all pass afterward. These are **Codex local
verification results**, not a retroactive Claude approval. No frozen benchmark
was rerun, rescored or modified.

Commands actually run (all final checks exit 0):

```text
# BELIEF workspace: 107 passed in 3.41s
python -B -m pytest -p no:cacheprovider tests/test_dataflow_causality.py tests/test_dataflow.py tests/test_audit_case.py tests/test_guard_causality.py -q
# BELIEF workspace: 42 passed in 3.24s
python -B -m pytest -p no:cacheprovider tests/test_hypothesis_engine.py tests/test_static_analysis_pipeline.py tests/test_reportability_scoring.py tests/test_pipeline_cycle_analysis.py -q
# Bridge workspace, mock/local tests only: 27 passed
node node_modules/vitest/vitest.mjs run shared/control-plane/src/telemetry.test.ts claude/claude-side/src/integration.test.ts
```

The pre-fix command was:
`python -B -m pytest -p no:cacheprovider tests/test_dataflow_causality.py -q -k 'dictionary_key or summary_cannot or refresh_'`
(exit 1: four failed, one passed).

## Allocation and cost limits

For this BELIEF run, excluding coordination and connection checks, the task
count is one Codex correction and two Claude diagnostic/review tasks: 33.3% /
66.7%. This is assigned work, not completed work or equivalent effort. The
manager's token usage is absent, and the latest review's usage is unknown.
Neither a 50/50 token split nor savings are established. Aim for roughly
40–60% of estimated useful effort over several batches, including verification
and rework; do not create artificial tasks to balance counts. Select an agent
using existing context, tools, observed quality and the value of an independent
review. This incident establishes no general model superiority.

## Runtime follow-up, 2026-09-27

User routing now assigns cyber analysis, corpus qualification and security review
to Claude; Codex handles integration, Git/CI, bridge plumbing and reports. No
Daybreak tool is used. The old provenance review `task_y7a0rg4bhb` remained
BLOCKED after its original six-turn attempt and one same-session recovery both
ended with `max_turns`. Neither produced a report or approval. That same task
must be retained for any further recovery; do not replace it to hide failures.

Implemented locally in the bridge (not yet committed/deployed):

- MCP and JSON schemas now describe `max_attempts` as additional retries and
  `deadline_ms` as a per-attempt limit.
- Optional `total_deadline_ms` persists an absolute deadline in the original
  delegation event. Retries are clipped to remaining time; exhaustion prevents
  a new attempt, including recovery through a new orchestrator instance. The
  elapsed budget includes periods between recoveries, not just runtime CPU.
- Recovery reuses the original delegation's per-attempt deadline when present.
  Previously an omitted `spec.deadline_ms` fell back to 600 seconds even when the
  original request had used a smaller limit.
- Nonzero runtime exit status no longer receives `termination_kind=completed`
  merely because the adapter returned a structured PARTIAL result.
- `bridge_get_task` retains the historical progress payload and adds
  `latest_status_is_stale` when its state differs from the authoritative task.

Validation actually run: `node node_modules/typescript/bin/tsc --build` exited 0.
`node node_modules/vitest/vitest.mjs run shared/control-plane/src/delegation-budget.test.ts shared/control-plane/src/telemetry.test.ts shared/control-plane/src/recovery.test.ts shared/mcp-server-core/src/tools.test.ts`
exited 0: 59 tests passed, including four new deterministic budget regressions.

Remaining: parent-requested cancellation, safe finite turn-budget amendment for
recovering a max-turns task, manager telemetry coverage and full regression/CLI
surface validation. No caller identity guard was relaxed. Existing delegations
without an explicit total budget retain their previous total-budget semantics.
