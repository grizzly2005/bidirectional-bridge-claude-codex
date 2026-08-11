import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AdapterHealth,
  AttemptTerminationKind,
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  TelemetryCostSemantics,
  seededRandom,
  type AgentAdapter,
  type Deliverable,
  type TaskInvocation,
  type TaskSpec,
} from "@bridge/protocol";
import { describe, expect, it } from "vitest";

import { normalizeAttemptTelemetry } from "./attempt-service.js";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { Orchestrator } from "./orchestrator.js";

const RUN_ID = "run_0000000001";

function spec(scope = "codex/**"): TaskSpec {
  return {
    objective: "produce one harmless telemetry fixture",
    scope: { paths: [scope] },
    dependencies: [],
    expected_deliverable: "one structured result",
    verification_criteria: ["fixture verification passes"],
  };
}

function complete(invocation: TaskInvocation, at: number): Deliverable {
  return {
    task_id: invocation.task_id,
    agent: "codex",
    status: DeliverableStatus.COMPLETE,
    summary: "fixture complete",
    changed_scope: [],
    artifacts: [],
    commit_or_diff: null,
    verification_performed: ["fixture verification"],
    verification_results: [
      {
        kind: "test",
        command: "fixture verification",
        passed: true,
        exit_code: 0,
        summary: "passed",
      },
    ],
    remaining_risks: [],
    dependencies_unblocked: [],
    recommended_next_action: "none",
    at,
  };
}

describe("AttemptTelemetry normalization and persistence", () => {
  it("normalizes unknown fields to null and derives total from normalized input plus output", () => {
    const telemetry = normalizeAttemptTelemetry({
      task_id: "task_0000000001",
      run_id: RUN_ID,
      parent_task_id: null,
      delegation_depth: 0,
      attempt: 0,
      agent: "codex",
      orchestration_started_at: 1_000,
      observed_runtime_started_at: 1_100,
      observed_runtime_ended_at: 1_900,
      completed_at: 2_000,
      input_artifact_count: 0,
      input_artifact_bytes: 0,
      termination_kind: AttemptTerminationKind.COMPLETED,
      update: { input_tokens: 21, output_tokens: 4 },
    });

    expect(telemetry.total_tokens).toBe(25);
    expect(telemetry.cached_input_tokens).toBeNull();
    expect(telemetry.runtime_duration_ms).toBeNull();
    expect(telemetry.requested_model).toBeNull();
    expect(telemetry.requested_effort).toBeNull();
    expect(telemetry.wall_duration_ms).toBe(1_000);
    expect(telemetry.cost_semantics).toBe(TelemetryCostSemantics.UNAVAILABLE);
  });

  it("persists exactly one final record and queries it by every required key", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-telemetry-"));
    const dbPath = join(dir, "bridge.db");
    const clock = new ManualClock(10_000);
    try {
      const cp = ControlPlane.open({
        workspaceRoot: dir,
        databasePath: dbPath,
        clock,
        rng: seededRandom(41),
      });
      const task = cp.tasks.create({ spec: spec(), created_by: "codex", run_id: RUN_ID });
      cp.attempts.start(task.task_id, 0, "codex");
      const telemetry = normalizeAttemptTelemetry({
        task_id: task.task_id,
        run_id: task.run_id,
        parent_task_id: null,
        delegation_depth: 0,
        attempt: 0,
        agent: "codex",
        orchestration_started_at: 9_000,
        observed_runtime_started_at: 9_100,
        observed_runtime_ended_at: 9_900,
        completed_at: clock.now(),
        input_artifact_count: 0,
        input_artifact_bytes: 0,
        termination_kind: AttemptTerminationKind.COMPLETED,
        update: {
          runtime: "fixture-runtime",
          requested_model: "opus",
          requested_effort: "high",
          model: "claude-opus-5",
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10,
        },
      });
      cp.attempts.recordTelemetry(telemetry);

      expect(cp.attempts.queryTelemetry({ run_id: RUN_ID })).toEqual([telemetry]);
      expect(cp.attempts.queryTelemetry({ task_id: task.task_id })).toEqual([telemetry]);
      expect(cp.attempts.queryTelemetry({ agent: "codex" })).toEqual([telemetry]);
      expect(cp.attempts.queryTelemetry({ attempt: 0 })).toEqual([telemetry]);
      expect(telemetry).toMatchObject({
        requested_model: "opus",
        requested_effort: "high",
        model: "claude-opus-5",
      });
      expect(cp.events({ types: ["attempt.telemetry_recorded"] })).toHaveLength(1);
      expect(() => cp.attempts.recordTelemetry(telemetry)).toThrow(/already exists/u);
      cp.close();

      const reopened = ControlPlane.open({ workspaceRoot: dir, databasePath: dbPath, clock });
      expect(reopened.attempts.queryTelemetry({ run_id: RUN_ID })).toEqual([telemetry]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rejects credentials in the only free-form telemetry identity fields", () => {
    const cp = ControlPlane.open({
      workspaceRoot: "/tmp/bridge-telemetry-secret",
      databasePath: ":memory:",
      rng: seededRandom(42),
    });
    const task = cp.tasks.create({ spec: spec(), created_by: "codex", run_id: RUN_ID });
    cp.attempts.start(task.task_id, 0, "codex");
    const telemetry = normalizeAttemptTelemetry({
      task_id: task.task_id,
      run_id: task.run_id,
      parent_task_id: null,
      delegation_depth: 0,
      attempt: 0,
      agent: "codex",
      orchestration_started_at: 1,
      observed_runtime_started_at: 1,
      observed_runtime_ended_at: 2,
      completed_at: 2,
      input_artifact_count: 0,
      input_artifact_bytes: 0,
      termination_kind: AttemptTerminationKind.COMPLETED,
      update: { model: "sk-abcdefghijklmnopqrstuvwxyz012345" },
    });

    expect(() => cp.attempts.recordTelemetry(telemetry)).toThrow(/credential/u);
    cp.close();
  });
});

describe("run lineage and orchestrated finalization", () => {
  it("derives and validates run_id, parent_task_id, and delegation_depth", () => {
    const cp = ControlPlane.open({
      workspaceRoot: "/tmp/bridge-lineage",
      databasePath: ":memory:",
      rng: seededRandom(43),
    });
    const root = cp.tasks.create({ spec: spec(), created_by: "codex", run_id: RUN_ID });
    const child = cp.tasks.create({
      spec: spec("claude/**"),
      created_by: "codex",
      parent_task_id: root.task_id,
    });
    const grandchild = cp.tasks.create({
      spec: spec(),
      created_by: "claude",
      parent_task_id: child.task_id,
    });

    expect(child).toMatchObject({
      run_id: RUN_ID,
      parent_task_id: root.task_id,
      delegation_depth: 1,
    });
    expect(grandchild).toMatchObject({
      run_id: RUN_ID,
      parent_task_id: child.task_id,
      delegation_depth: 2,
    });
    expect(() =>
      cp.tasks.create({
        spec: spec(),
        created_by: "codex",
        parent_task_id: root.task_id,
        delegation_depth: 7,
      }),
    ).toThrow(/delegation_depth must be 1/u);
    expect(() =>
      cp.tasks.create({
        spec: spec(),
        created_by: "codex",
        run_id: "run_1111111111",
        parent_task_id: root.task_id,
      }),
    ).toThrow(/must match parent/u);
    cp.close();
  });

  it("records separate retry telemetry, resumes the previous handle, and exports no raw data", async () => {
    const clock = new ManualClock(20_000);
    let calls = 0;
    let resumedHandle: string | null | undefined;
    const adapter: AgentAdapter = {
      info: {
        agent: "codex",
        implementation: "fixture",
        version: "1.0.0",
        capabilities: ["telemetry"],
        max_concurrency: 1,
      },
      async health() {
        return { status: AdapterHealth.READY, checked_at: clock.now() };
      },
      async invoke(invocation, ctx) {
        const call = calls++;
        resumedHandle = invocation.previous_execution_handle;
        await ctx.saveExecutionHandle(`thread_private_${call}`);
        await ctx.reportTelemetry?.({
          runtime: "fixture",
          runtime_version: "1.0.0",
          input_tokens: 10 + call,
          output_tokens: 2,
          total_tokens: 12 + call,
          turn_count: 1,
          prompt_bytes: 50,
          // Deliberately hostile extra keys prove the finalizer is an allowlist projection.
          raw_prompt: "PRIVATE_PROMPT_TEXT",
          execution_handle: `thread_private_${call}`,
          authentication: "Bearer abcdefghijklmnopqrstuvwxyz",
        } as never);
        clock.advance(100);
        if (call === 0) throw new BridgeError(ErrorCode.TIMEOUT, "fixture retry");
        await ctx.recordVerification({
          kind: "test",
          command: "fixture verification",
          passed: true,
          exit_code: 0,
          summary: "passed",
        });
        return complete(invocation, clock.now());
      },
      async cancel() {},
    };
    const cp = ControlPlane.open({
      workspaceRoot: "/tmp/bridge-telemetry-retry",
      databasePath: ":memory:",
      clock,
      rng: seededRandom(44),
    });
    cp.adapters.register(adapter);
    const parent = cp.tasks.create({ spec: spec(), created_by: "supervisor", run_id: RUN_ID });
    const outcome = await new Orchestrator(cp).delegate({
      from: "codex",
      to: "codex",
      run_id: RUN_ID,
      parent_task_id: parent.task_id,
      delegation_depth: 1,
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 5_000,
      max_attempts: 1,
      idempotency_key: "telemetry-retry",
    });

    expect(outcome.error).toBeNull();
    expect(outcome.attempts).toBe(2);
    expect(resumedHandle).toBe("thread_private_0");
    const records = cp.attempts.queryTelemetry({ task_id: outcome.task_id });
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.attempt)).toEqual([0, 1]);
    expect(records.map((record) => record.termination_kind)).toEqual(["timeout", "completed"]);
    expect(records[1]).toMatchObject({
      run_id: RUN_ID,
      parent_task_id: parent.task_id,
      delegation_depth: 1,
      input_tokens: 11,
      output_tokens: 2,
      total_tokens: 13,
    });
    const exported = JSON.stringify(records);
    expect(exported).not.toContain("PRIVATE_PROMPT_TEXT");
    expect(exported).not.toContain("thread_private");
    expect(exported).not.toContain("Bearer");
    expect(cp.tasks.get(outcome.task_id).state).toBe(TaskState.DONE);
    cp.close();
  });
});
