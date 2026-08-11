/**
 * MOCK Codex adapter — reference implementation of `AgentAdapter`.
 *
 * This is NOT the real Codex integration. Per the ownership split (D-002), codex owns
 * `codex/**` and implements the real adapter over the Codex CLI running as an MCP server
 * (`codex()` to open a conversation, `codex-reply()` to continue it).
 *
 * This file exists for two reasons:
 *  1. it lets the Claude side test end-to-end delegation deterministically, with no
 *     network, no API key, and no second process;
 *  2. it is the executable specification of the contract — codex can read it to see
 *     exactly which callbacks fire in which order and what a well-formed deliverable
 *     looks like.
 *
 * codex: read this file, do not edit it. If the contract is wrong for you, file a
 * request in `COORDINATION/REQUESTS/`.
 */

import {
  AdapterHealth,
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  type AdapterInfo,
  type AgentAdapter,
  type ArtifactId,
  type Deliverable,
  type HealthReport,
  type InvocationContext,
  type TaskId,
  type TaskInvocation,
  type VerificationResult,
} from "@bridge/protocol";

/** Scripted behaviour for one invocation, so tests can drive any code path. */
export interface MockBehaviour {
  /** Milliseconds of simulated work before returning. Default 0. */
  readonly durationMs?: number;
  /** Artifacts the adapter should publish. */
  readonly artifacts?: ReadonlyArray<{ name: string; content: string; kind?: "report" | "json" | "log" | "diff" }>;
  /** Verification evidence to record. */
  readonly verifications?: readonly VerificationResult[];
  /** Raise a blocker and return PARTIAL. */
  readonly blocker?: string;
  /** Throw a transport-level failure instead of returning a deliverable. */
  readonly throwError?: { code: ErrorCode; message: string };
  /** Final status. Defaults to COMPLETE. */
  readonly status?: DeliverableStatus;
  /** Ignore the abort signal, to exercise the orchestrator's timeout handling. */
  readonly ignoreAbort?: boolean;
  /** Write outside the leased scope, to exercise scope enforcement. */
  readonly claimChangedScope?: readonly string[];
  /** Resumable pointer to persist before working, mirroring a real Codex thread id. */
  readonly executionHandle?: string;
}

export interface MockCodexAdapterOptions {
  readonly agent?: string;
  /** Behaviour per attempt index; the last entry repeats. Default: one success. */
  readonly script?: readonly MockBehaviour[];
  readonly health?: AdapterHealth;
  /** Injected so the mock uses the same clock as the control plane under test. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class MockCodexAdapter implements AgentAdapter {
  readonly info: AdapterInfo;
  private readonly script: readonly MockBehaviour[];
  private readonly healthStatus: AdapterHealth;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cancelled = new Set<TaskId>();

  /** Every invocation received, for assertions about what the orchestrator sent. */
  readonly invocations: TaskInvocation[] = [];

  constructor(options: MockCodexAdapterOptions = {}) {
    this.info = {
      agent: options.agent ?? "codex",
      implementation: "mock-codex-adapter",
      version: "0.1.0",
      capabilities: ["code", "tests", "shell"],
      max_concurrency: 4,
    };
    this.script = options.script ?? [{}];
    this.healthStatus = options.health ?? AdapterHealth.READY;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async health(): Promise<HealthReport> {
    return { status: this.healthStatus, checked_at: this.now() };
  }

  async invoke(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable> {
    this.invocations.push(invocation);
    const behaviour = this.script[Math.min(invocation.attempt, this.script.length - 1)] ?? {};

    // 0. Register the resumable session first. The real Codex adapter saves its thread id
    //    here, so an attempt that dies later can be resumed with `codex-reply`.
    if (behaviour.executionHandle) {
      await ctx.saveExecutionHandle(behaviour.executionHandle);
    }

    // 1. Acknowledge, so a supervisor sees the run start rather than a silent gap.
    await ctx.report({
      state: TaskState.WORKING,
      current_action: `starting: ${invocation.spec.objective}`,
      owned_scope: invocation.spec.scope.paths,
      progress: 0,
      artifacts: [],
      blockers: [],
      next_action: "produce artifacts",
    });

    if (behaviour.durationMs) await this.sleep(behaviour.durationMs);

    if (!behaviour.ignoreAbort && ctx.signal.aborted) {
      return this.partial(invocation, "aborted before producing output", []);
    }
    if (this.cancelled.has(invocation.task_id)) {
      return this.partial(invocation, "cancelled by caller", []);
    }

    if (behaviour.throwError) {
      throw new BridgeError(behaviour.throwError.code, behaviour.throwError.message, {
        task_id: invocation.task_id,
        adapter: this.info.implementation,
      });
    }

    // 2. Publish artifacts. Results cross the bridge as artifacts, never as transcripts.
    const artifactIds: ArtifactId[] = [];
    for (const spec of behaviour.artifacts ?? []) {
      artifactIds.push(
        await ctx.publishArtifact({
          kind: spec.kind ?? "report",
          name: spec.name,
          media_type: "text/plain",
          inline: spec.content,
        }),
      );
    }

    // 3. Record verification evidence.
    for (const v of behaviour.verifications ?? []) {
      await ctx.recordVerification(v);
    }

    // 4. Blocked path: report the blocker and hand back PARTIAL. Do not loop.
    if (behaviour.blocker) {
      await ctx.raiseBlocker(behaviour.blocker);
      return this.partial(invocation, behaviour.blocker, artifactIds);
    }

    await ctx.report({
      state: TaskState.VERIFYING,
      current_action: "checks complete",
      owned_scope: invocation.spec.scope.paths,
      progress: 1,
      artifacts: artifactIds,
      blockers: [],
      next_action: "submit deliverable",
    });

    const status = behaviour.status ?? DeliverableStatus.COMPLETE;
    return {
      task_id: invocation.task_id,
      agent: this.info.agent,
      status,
      summary: `mock ${this.info.agent} completed: ${invocation.spec.objective}`,
      changed_scope: behaviour.claimChangedScope ?? invocation.spec.scope.paths,
      artifacts: artifactIds,
      commit_or_diff: null,
      verification_performed: (behaviour.verifications ?? []).map((v) => v.command),
      verification_results: behaviour.verifications ?? [],
      remaining_risks: [],
      dependencies_unblocked: [],
      recommended_next_action: "review artifacts",
      at: this.now(),
    };
  }

  async cancel(task_id: TaskId, _reason: string): Promise<void> {
    this.cancelled.add(task_id);
  }

  private partial(invocation: TaskInvocation, reason: string, artifacts: ArtifactId[]): Deliverable {
    return {
      task_id: invocation.task_id,
      agent: this.info.agent,
      status: DeliverableStatus.PARTIAL,
      summary: `mock ${this.info.agent} stopped early: ${reason}`,
      changed_scope: invocation.spec.scope.paths,
      artifacts,
      commit_or_diff: null,
      verification_performed: [],
      verification_results: [],
      remaining_risks: [reason],
      dependencies_unblocked: [],
      recommended_next_action: "resolve the blocker and re-delegate",
      at: this.now(),
    };
  }
}

/** Convenience: evidence for a check that genuinely ran and passed. */
export function passingCheck(
  kind: VerificationResult["kind"],
  command: string,
  summary = "ok",
): VerificationResult {
  return { kind, command, passed: true, exit_code: 0, summary };
}

/** Convenience: evidence for a check that genuinely ran and failed. */
export function failingCheck(
  kind: VerificationResult["kind"],
  command: string,
  summary = "failed",
): VerificationResult {
  return { kind, command, passed: false, exit_code: 1, summary };
}
