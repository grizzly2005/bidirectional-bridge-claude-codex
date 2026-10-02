import { describe, expect, it } from "vitest";
import {
  AdapterHealth,
  AttemptTerminationKind,
  BridgeError,
  ErrorCode,
  seededRandom,
  type AgentAdapter,
  type TaskSpec,
} from "@bridge/protocol";
import { normalizeAttemptTelemetry } from "./attempt-service.js";
import { ManualClock } from "./clock.js";
import { ControlPlane } from "./control-plane.js";
import { Orchestrator } from "./orchestrator.js";

const spec: TaskSpec = {
  objective: "bounded local patch regression",
  scope: { paths: ["fixture/**"] },
  dependencies: [],
  expected_deliverable: "structured local result",
  verification_criteria: ["fixture check passes"],
};

function fixture() {
  const clock = new ManualClock(10_000);
  const cp = ControlPlane.open({ workspaceRoot: "/tmp/patch-regression", databasePath: ":memory:", clock, rng: seededRandom(813) });
  return { cp, clock };
}

describe("report patch regressions", () => {
  it.each([0, 1])("preserves contention without launching a runtime with %i retries", async (max_attempts) => {
    const { cp, clock } = fixture();
    let invokes = 0;
    const adapter: AgentAdapter = {
      info: { agent: "codex", implementation: "fixture", version: "1", capabilities: [], max_concurrency: 1 },
      async health() { return { status: AdapterHealth.READY, checked_at: clock.now() }; },
      async invoke() { invokes++; throw new Error("must never launch on a conflicting scope"); },
      async cancel() {},
    };
    cp.adapters.register(adapter);
    const heldTask = cp.tasks.create({ spec, created_by: "claude" });
    const held = cp.leases.acquire({ task_id: heldTask.task_id, holder: "claude", scope: spec.scope, ttl_ms: 60_000 });
    try {
      const outcome = await new Orchestrator(cp).delegate({ from: "claude", to: "codex", spec, input_artifacts: [], deadline_ms: 5_000, max_attempts });
      expect(outcome.error?.code).toBe(ErrorCode.SCOPE_CONFLICT);
      expect(outcome.attempts).toBe(0);
      expect(invokes).toBe(0);
      expect(cp.tasks.get(outcome.task_id)).toMatchObject({ state: "BLOCKED", attempt: 0 });
      expect(cp.tasks.get(outcome.task_id).blockers[0]).toContain("SCOPE_CONFLICT");
      expect(cp.attempts.list(outcome.task_id)).toEqual([]);
      expect(cp.leases.listLive()).toEqual([held]);
    } finally { cp.close(); }
  });

  it("discovers FAILED interrupted sessions and excludes authored or handleless failures", () => {
    const { cp } = fixture();
    const failed = (outcome: string, handle: boolean) => {
      const task = cp.tasks.create({ spec, created_by: "codex" });
      cp.tasks.claim(task.task_id, "codex");
      cp.tasks.transition({ task_id: task.task_id, agent: "codex", to: "WORKING" });
      cp.attempts.start(task.task_id, 0, "codex");
      if (handle) cp.attempts.saveHandle(task.task_id, 0, "codex", "thread_fixture_safe");
      cp.attempts.end(task.task_id, 0, "codex", outcome);
      cp.tasks.transition({ task_id: task.task_id, agent: "codex", to: "FAILED" });
      return task.task_id;
    };
    try {
      const interrupted = failed(ErrorCode.ADAPTER_FAILURE, true);
      failed("FAILED", true);
      failed(ErrorCode.TIMEOUT, false);
      expect(cp.recover().in_flight_tasks.map((task) => task.task_id)).toEqual([interrupted]);
      expect(cp.tasks.get(interrupted).state).toBe("FAILED");
    } finally { cp.close(); }
  });

  it("counts a scope failure after a runtime has already started", async () => {
    const { cp, clock } = fixture();
    cp.adapters.register({
      info: { agent: "codex", implementation: "fixture", version: "1", capabilities: [], max_concurrency: 1 },
      async health() { return { status: AdapterHealth.READY, checked_at: clock.now() }; },
      async invoke() { throw new BridgeError(ErrorCode.SCOPE_CONFLICT, "runtime fixture crossed its scope"); },
      async cancel() {},
    });
    try {
      const outcome = await new Orchestrator(cp).delegate({ from: "claude", to: "codex", spec, input_artifacts: [], deadline_ms: 5_000 });
      expect(outcome.error?.code).toBe(ErrorCode.SCOPE_CONFLICT);
      expect(outcome.attempts).toBe(1);
      expect(cp.attempts.list(outcome.task_id)).toHaveLength(1);
      expect(cp.leases.listLive()).toEqual([]);
    } finally { cp.close(); }
  });

  it("measures retry spans separately from the cumulative delegation clock", async () => {
    const { cp, clock } = fixture();
    let call = 0;
    cp.adapters.register({
      info: { agent: "codex", implementation: "fixture", version: "1", capabilities: [], max_concurrency: 1 },
      async health() { return { status: AdapterHealth.READY, checked_at: clock.now() }; },
      async invoke() {
        clock.advance(++call === 1 ? 2_000 : 1_000);
        throw new BridgeError(ErrorCode.INTERNAL, "retry fixture");
      },
      async cancel() {},
    });
    try {
      const outcome = await new Orchestrator(cp).delegate({ from: "claude", to: "codex", spec, input_artifacts: [], deadline_ms: 10_000, max_attempts: 1 });
      const records = cp.attempts.queryTelemetry({ task_id: outcome.task_id });
      expect(records.map((record) => record.attempt_wall_duration_ms)).toEqual([2_000, 1_000]);
      expect(records.map((record) => record.wall_duration_ms)).toEqual([2_000, 3_000]);
      expect(records.map((record) => record.duration_measurement_version)).toEqual([2, 2]);
      expect(outcome.duration_ms).toBe(3_000);
    } finally { cp.close(); }
  });

  it("leaves an unknown or reversed attempt clock unmeasured", () => {
    const input = {
      task_id: "task_0000000001", run_id: "run_0000000001", parent_task_id: null, delegation_depth: 0,
      attempt: 0, agent: "codex", orchestration_started_at: 1_000,
      observed_runtime_started_at: null, observed_runtime_ended_at: null, completed_at: 2_000,
      input_artifact_count: 0, input_artifact_bytes: 0, termination_kind: AttemptTerminationKind.UNKNOWN, update: {},
    };
    expect(normalizeAttemptTelemetry(input).attempt_wall_duration_ms).toBeNull();
    expect(normalizeAttemptTelemetry({ ...input, attempt_started_at: 3_000 }).attempt_wall_duration_ms).toBeNull();
  });
});
