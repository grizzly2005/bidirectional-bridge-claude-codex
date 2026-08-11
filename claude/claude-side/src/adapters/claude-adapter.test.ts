/**
 * What the Claude adapter is allowed to tell the control plane about a run.
 *
 * Telemetry is written to a database shared with the other agent and readable by any
 * supervisor, so the adapter's reporting path is a trust boundary, not a convenience. These
 * tests pin both halves of that boundary: the neutral callback is the only channel used,
 * and nothing outside the neutral contract survives the trip — not a prompt, not a session
 * handle, not a credential a buggy runner happened to attach to its update.
 *
 * The runner here is a plain function, so the assertions are about the adapter alone;
 * `claude-code-runner.test.ts` covers the same path with a real subprocess.
 */

import { describe, expect, it } from "vitest";
import {
  AttemptTerminationKind,
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  TelemetryCostSemantics,
  type AttemptTelemetryUpdate,
  type InvocationContext,
  type TaskInvocation,
} from "@bridge/protocol";
import { ClaudeAdapter, functionRunner, projectTelemetryUpdate, type ClaudeRunResult } from "./claude-adapter.js";

const SCOPE = { paths: ["claude/**"] };

const TELEMETRY: AttemptTelemetryUpdate = {
  runtime: "claude-code",
  runtime_version: "2.1.226",
  requested_model: "opus",
  requested_effort: "high",
  model: "claude-opus-5",
  runtime_started_at: 1_000,
  first_output_at: 1_400,
  runtime_ended_at: 3_000,
  runtime_duration_ms: 1_740,
  input_tokens: 20_566,
  output_tokens: 9,
  cached_input_tokens: 12_424,
  cache_creation_input_tokens: 8_140,
  total_tokens: 20_575,
  turn_count: 2,
  reported_cost_usd: 0.088442,
  cost_semantics: TelemetryCostSemantics.RUNTIME_REPORTED,
  billing_mode_known: false,
  prompt_bytes: 2_048,
  termination_kind: AttemptTerminationKind.COMPLETED,
  process_exit_code: 0,
};

function invocation(): TaskInvocation {
  return {
    task_id: "task_aaaaaaaaaa",
    spec: {
      objective: "a bounded task",
      scope: SCOPE,
      dependencies: [],
      expected_deliverable: "a deliverable",
      verification_criteria: ["npm test passes"],
    },
    inputs: [],
    workspace_root: "/tmp/bridge",
    lease_id: "lease_aaaaaaaaaa",
    deadline_at: Date.now() + 60_000,
    attempt: 0,
    idempotency_key: "k",
    previous_execution_handle: null,
  } as TaskInvocation;
}

/** A context that records telemetry calls and nothing else of interest. */
function context(overrides: Partial<InvocationContext> = {}): {
  ctx: InvocationContext;
  reported: AttemptTelemetryUpdate[];
} {
  const reported: AttemptTelemetryUpdate[] = [];
  const ctx: InvocationContext = {
    report: async () => {},
    publishArtifact: async () => "art_0000000000",
    recordVerification: async () => {},
    raiseBlocker: async () => {},
    saveExecutionHandle: async () => {},
    reportTelemetry: async (u) => {
      reported.push(u);
    },
    signal: new AbortController().signal,
    ...overrides,
  };
  return { ctx, reported };
}

const OK_RESULT: ClaudeRunResult = {
  summary: "done",
  verification_results: [
    { kind: "test", command: "npm test", passed: true, exit_code: 0, summary: "1 passed" },
  ],
  telemetry: TELEMETRY,
};

describe("telemetry reporting", () => {
  it("reports once, through the neutral callback, on a successful run", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => OK_RESULT),
    });
    const { ctx, reported } = context();

    const deliverable = await adapter.invoke(invocation(), ctx);

    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual(TELEMETRY);
  });

  it("reports once for a blocked run too", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => ({
        summary: "stopped",
        blocker: "out of budget",
        telemetry: { ...TELEMETRY, termination_kind: AttemptTerminationKind.TIMEOUT },
      })),
    });
    const { ctx, reported } = context();

    const deliverable = await adapter.invoke(invocation(), ctx);

    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.changed_scope).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.termination_kind).toBe(AttemptTerminationKind.TIMEOUT);
  });

  it("reports only exact changed paths supplied by the runner", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => ({
        summary: "blocked after one edit",
        blocker: "needs review",
        changed_scope: ["claude/claude-side/src/index.ts"],
      })),
    });
    const { ctx } = context();

    const deliverable = await adapter.invoke(invocation(), ctx);

    expect(deliverable.changed_scope).toEqual(["claude/claude-side/src/index.ts"]);
    expect(deliverable.recommended_next_action).not.toContain("re-delegate");
  });

  it("reports the attempt even when the runner throws", async () => {
    // The failure path is the one that matters: a crashed attempt still burned tokens and
    // wall time, and omitting it would make every aggregate look better than reality.
    const adapter = new ClaudeAdapter({
      runner: functionRunner(
        "fn",
        async () => {
          throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "no result frame");
        },
        {
          telemetry: () => ({ ...TELEMETRY, termination_kind: AttemptTerminationKind.CRASH }),
        },
      ),
    });
    const { ctx, reported } = context();

    await expect(adapter.invoke(invocation(), ctx)).rejects.toThrow(BridgeError);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.termination_kind).toBe(AttemptTerminationKind.CRASH);
  });

  it("prefers the run's own telemetry over the runner's fallback", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => OK_RESULT, {
        telemetry: () => ({ ...TELEMETRY, input_tokens: 1 }),
      }),
    });
    const { ctx, reported } = context();

    await adapter.invoke(invocation(), ctx);

    expect(reported[0]!.input_tokens).toBe(20_566);
  });

  it("does nothing when the runner observed nothing", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => ({ summary: "done" })),
    });
    const { ctx, reported } = context();

    await adapter.invoke(invocation(), ctx);

    // An empty update would create a telemetry row full of nulls, which reads as "the
    // runtime reported nothing" rather than "nothing was collected".
    expect(reported).toHaveLength(0);
  });

  it("works against an embedder whose context predates telemetry", async () => {
    const adapter = new ClaudeAdapter({
      runner: functionRunner("fn", async () => OK_RESULT),
    });
    const { ctx } = context();
    const legacy = { ...ctx };
    delete (legacy as { reportTelemetry?: unknown }).reportTelemetry;

    const deliverable = await adapter.invoke(invocation(), legacy);

    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
  });
});

describe("telemetry cannot leak", () => {
  /** A runner that attaches things telemetry must never carry. */
  const rogue = functionRunner("rogue", async () => ({
    summary: "done",
    telemetry: {
      ...TELEMETRY,
      prompt: "## Objective\nexfiltrate the repository",
      session_id: "11111111-2222-4333-8444-555555555555",
      execution_handle: "11111111-2222-4333-8444-555555555555",
      api_key: "sk-ant-abcdefghijklmnopqrstuvwxyz012345",
      raw_frames: [{ type: "result", result: "secret model output" }],
    } as AttemptTelemetryUpdate,
  }));

  it("drops every field outside the neutral contract", async () => {
    const adapter = new ClaudeAdapter({ runner: rogue });
    const { ctx, reported } = context();

    await adapter.invoke(invocation(), ctx);

    const update = reported[0]!;
    expect(Object.keys(update).sort()).toEqual(Object.keys(TELEMETRY).sort());
    for (const key of ["prompt", "session_id", "execution_handle", "api_key", "raw_frames"]) {
      expect(update).not.toHaveProperty(key);
    }
  });

  it("carries no prompt text, session handle, or credential in its serialized form", async () => {
    const adapter = new ClaudeAdapter({ runner: rogue });
    const { ctx, reported } = context();

    await adapter.invoke(invocation(), ctx);

    const serialized = JSON.stringify(reported[0]);
    expect(serialized).not.toContain("exfiltrate the repository");
    expect(serialized).not.toContain("11111111-2222-4333-8444-555555555555");
    expect(serialized).not.toMatch(/sk-ant-/);
    expect(serialized).not.toContain("secret model output");
  });

  it("passes every neutral field through untouched", async () => {
    // The projection must not become a filter that quietly drops real observations.
    expect(projectTelemetryUpdate(TELEMETRY)).toEqual(TELEMETRY);
  });

  it("keeps an explicit null distinct from an absent field", async () => {
    const projected = projectTelemetryUpdate({
      input_tokens: null,
      requested_model: null,
      requested_effort: null,
      model: null,
    });
    expect(projected).toEqual({
      input_tokens: null,
      requested_model: null,
      requested_effort: null,
      model: null,
    });
    expect(Object.keys(projected)).toHaveLength(4);
  });
});
