import { describe, expect, it } from "vitest";
import {
  AdapterHealth, AttemptTerminationKind, BridgeError, DeliverableStatus, ErrorCode,
  seededRandom, type AgentAdapter, type Deliverable, type TaskInvocation,
} from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { Orchestrator } from "./orchestrator.js";

const spec = {
  objective: "bounded local runtime fixture", scope: { paths: ["(no-write)/**"] },
  dependencies: [], expected_deliverable: "partial fixture", verification_criteria: ["budget respected"],
};

function partial(inv: TaskInvocation, at: number): Deliverable {
  return { task_id: inv.task_id, agent: "claude", status: DeliverableStatus.PARTIAL,
    summary: "fixture turn limit", changed_scope: [], artifacts: [], commit_or_diff: null,
    verification_performed: [], verification_results: [], remaining_risks: ["max_turns"],
    dependencies_unblocked: [], recommended_next_action: "explicit recovery", at };
}

function setup(invoke: AgentAdapter["invoke"]) {
  const clock = new ManualClock(1_000);
  const cp = ControlPlane.open({ workspaceRoot: "/tmp/bridge-budget", databasePath: ":memory:",
    clock, rng: seededRandom(67) });
  cp.adapters.register({ info: { agent: "claude", implementation: "fixture", version: "1",
    capabilities: ["resume"], max_concurrency: 1 },
    health: async () => ({ status: AdapterHealth.READY, checked_at: clock.now() }),
    invoke, cancel: async () => {} });
  return { cp, clock, orchestrator: new Orchestrator(cp) };
}

describe("shared delegation elapsed-time budget", () => {
  it("clips the second attempt and suppresses retries after the total budget", async () => {
    const deadlines: number[] = [];
    const { cp, clock, orchestrator } = setup(async (inv) => {
      deadlines.push(inv.deadline_at - clock.now());
      clock.advance(deadlines.at(-1)!);
      throw new BridgeError(ErrorCode.TIMEOUT, "fixture elapsed");
    });
    try {
      const result = await orchestrator.delegate({ from: "codex", to: "claude", spec,
        input_artifacts: [], deadline_ms: 2_000, total_deadline_ms: 3_000, max_attempts: 5 });
      expect(deadlines).toEqual([2_000, 1_000]);
      expect(result.attempts).toBe(2);
      expect(result.duration_ms).toBe(3_000);
      expect(cp.leases.listLive()).toEqual([]);
    } finally { cp.close(); }
  });

  it("rejects late success even if a cooperative timer has not fired", async () => {
    const { cp, clock, orchestrator } = setup(async (inv) => {
      clock.advance(1_001);
      return partial(inv, clock.now());
    });
    try {
      const result = await orchestrator.delegate({ from: "codex", to: "claude", spec,
        input_artifacts: [], deadline_ms: 5_000, total_deadline_ms: 1_000 });
      expect(result.error?.code).toBe(ErrorCode.TIMEOUT);
      expect(cp.deliverables.get(result.task_id)).toBeUndefined();
    } finally { cp.close(); }
  });

  it("uses durable remaining time after recreating the orchestrator and preserves owner", async () => {
    let calls = 0;
    const deadlines: number[] = [];
    const { cp, clock, orchestrator } = setup(async (inv, ctx) => {
      calls++;
      deadlines.push(inv.deadline_at - clock.now());
      await ctx.saveExecutionHandle("local-fixture-session");
      await ctx.reportTelemetry?.({ process_exit_code: 1 });
      clock.advance(100);
      return partial(inv, clock.now());
    });
    try {
      const first = await orchestrator.delegate({ from: "codex", to: "claude", spec,
        input_artifacts: [], deadline_ms: 2_000, total_deadline_ms: 3_000 });
      clock.advance(2_000);
      const resumed = await new Orchestrator(cp).resumeTask({ task_id: first.task_id, requested_by: "claude" });
      expect(deadlines).toEqual([2_000, 900]);
      expect(resumed.owner).toBe("claude");
      expect(resumed.telemetry?.termination_kind).toBe(AttemptTerminationKind.FAILED);
      clock.advance(900);
      await expect(new Orchestrator(cp).resumeTask({ task_id: first.task_id, requested_by: "claude" }))
        .rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
      expect(calls).toBe(2);
      expect(cp.tasks.get(first.task_id).attempt).toBe(1);
      expect(cp.leases.listLive()).toEqual([]);
    } finally { cp.close(); }
  });

  it("preserves original per-attempt duration for recovery without a total budget", async () => {
    const deadlines: number[] = [];
    const { cp, clock, orchestrator } = setup(async (inv, ctx) => {
      deadlines.push(inv.deadline_at - clock.now());
      await ctx.saveExecutionHandle("local-fixture-session");
      return partial(inv, clock.now());
    });
    try {
      const first = await orchestrator.delegate({ from: "codex", to: "claude", spec,
        input_artifacts: [], deadline_ms: 2_000 });
      await orchestrator.resumeTask({ task_id: first.task_id, requested_by: "claude" });
      expect(deadlines).toEqual([2_000, 2_000]);
    } finally { cp.close(); }
  });
});
