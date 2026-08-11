import { describe, expect, it } from "vitest";
import {
  AdapterHealth,
  DeliverableStatus,
  ErrorCode,
  seededRandom,
  type AgentAdapter,
  type TaskInvocation,
  type TaskSpec,
} from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { Orchestrator } from "./orchestrator.js";
import { MAX_DELEGATION_DEPTH } from "./task-service.js";

const RUN_ID = "run_0000000001";

function spec(agent?: string): TaskSpec {
  return {
    objective: "bounded lineage proof",
    scope: { paths: ["BENCHMARK/native-mcp/**"] },
    dependencies: [],
    expected_deliverable: "structured proof",
    verification_criteria: ["fixture check passes"],
    ...(agent ? { preferred_agent: agent } : {}),
  };
}

function adapter(agent: string, clock: ManualClock): AgentAdapter {
  return {
    info: {
      agent,
      implementation: `lineage-${agent}`,
      version: "1.0.0",
      capabilities: ["structured-deliverable"],
      max_concurrency: 1,
    },
    async health() {
      return { status: AdapterHealth.READY, checked_at: clock.now() };
    },
    async invoke(invocation: TaskInvocation, ctx) {
      const verification = {
        kind: "test" as const,
        command: "lineage fixture",
        passed: true,
        exit_code: 0,
        summary: "passed",
      };
      await ctx.recordVerification(verification);
      return {
        task_id: invocation.task_id,
        agent,
        status: DeliverableStatus.COMPLETE,
        summary: "lineage fixture complete",
        changed_scope: invocation.spec.scope.paths,
        artifacts: [],
        commit_or_diff: null,
        verification_performed: [verification.command],
        verification_results: [verification],
        remaining_risks: [],
        dependencies_unblocked: [],
        recommended_next_action: "none",
        at: clock.now(),
      };
    },
    async cancel() {},
  };
}

describe("delegation lineage safety", () => {
  it("preserves root/child lineage and rejects Claude -> Codex -> Claude", async () => {
    const clock = new ManualClock();
    const cp = ControlPlane.open({
      workspaceRoot: "/tmp/bridge-lineage",
      databasePath: ":memory:",
      clock,
      rng: seededRandom(801),
    });
    cp.adapters.register(adapter("codex", clock));
    cp.adapters.register(adapter("claude", clock));
    const orchestrator = new Orchestrator(cp);

    const root = cp.tasks.create({
      spec: spec("claude"),
      created_by: "claude",
      run_id: RUN_ID,
    });
    expect(root).toMatchObject({
      run_id: RUN_ID,
      parent_task_id: null,
      delegation_depth: 0,
    });

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec("codex"),
      run_id: RUN_ID,
      parent_task_id: root.task_id,
      delegation_depth: 1,
      input_artifacts: [],
      deadline_ms: 5_000,
    });
    expect(outcome.error).toBeNull();
    const child = cp.tasks.get(outcome.task_id);
    expect(child).toMatchObject({
      run_id: RUN_ID,
      parent_task_id: root.task_id,
      delegation_depth: 1,
      owner: "codex",
    });

    await expect(
      orchestrator.delegate({
        from: "codex",
        to: "claude",
        spec: spec("claude"),
        run_id: RUN_ID,
        parent_task_id: child.task_id,
        delegation_depth: 2,
        input_artifacts: [],
        deadline_ms: 5_000,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
      details: {
        target: "claude",
        conflicting_task_id: root.task_id,
      },
    });
    expect(cp.tasks.list()).toHaveLength(2);
    cp.close();
  });

  it("keeps the maximum delegation depth guard", () => {
    const cp = ControlPlane.open({
      workspaceRoot: "/tmp/bridge-max-depth",
      databasePath: ":memory:",
      rng: seededRandom(802),
    });
    let parent = cp.tasks.create({ spec: spec(), created_by: "supervisor", run_id: RUN_ID });
    for (let depth = 1; depth <= MAX_DELEGATION_DEPTH; depth += 1) {
      parent = cp.tasks.create({
        spec: spec(),
        created_by: "supervisor",
        parent_task_id: parent.task_id,
        delegation_depth: depth,
      });
    }
    expect(parent.delegation_depth).toBe(MAX_DELEGATION_DEPTH);
    expect(() =>
      cp.tasks.create({
        spec: spec(),
        created_by: "supervisor",
        parent_task_id: parent.task_id,
        delegation_depth: MAX_DELEGATION_DEPTH + 1,
      }),
    ).toThrow(`delegation depth exceeds the ${MAX_DELEGATION_DEPTH} level safety limit`);
    cp.close();
  });
});
