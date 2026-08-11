/**
 * Claude-side adapter.
 *
 * Two ways Claude participates in the bridge, and this file covers both:
 *
 *  A. Claude as the *delegate* — some other agent hands Claude a task. Claude Code /
 *     Cowork is not an HTTP endpoint you can call synchronously, so the task is handed to
 *     a Claude session through an injected `ClaudeRunner`. The production implementation is
 *     `ClaudeCodeRunner`, which drives a bounded `claude -p` subprocess; `functionRunner`
 *     remains as a test seam. Keeping the mechanism behind an interface is what lets the
 *     same adapter serve the CLI, the Agent SDK, or an in-process session.
 *
 *  B. Claude as the *caller* — Claude is already running (that is this session) and wants
 *     to record its own work in the control plane. For that, use `ClaudeWorkSession`
 *     below, which drives the same lifecycle from inside an existing Claude turn.
 *
 * What this file deliberately does not do: embed an Anthropic API client. Binding the
 * bridge to one invocation mechanism would make it useless in the Cowork/Claude Code
 * context where Claude is already the running process.
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
  type AttemptTelemetryUpdate,
  type Deliverable,
  type HealthReport,
  type InvocationContext,
  type TaskId,
  type TaskInvocation,
  type VerificationResult,
} from "@bridge/protocol";

/**
 * How a Claude session actually gets driven. Implementations decide the mechanism;
 * the bridge only cares that a bounded task goes in and a deliverable comes out.
 */
export interface ClaudeRunner {
  /** Human-readable description of the mechanism, for logs and health output. */
  readonly description: string;
  /**
   * Execute one task. Implementations MUST honour `ctx.signal` and SHOULD report
   * progress through `ctx` rather than buffering everything until the end.
   */
  run(invocation: TaskInvocation, ctx: InvocationContext): Promise<ClaudeRunResult>;
  /**
   * Resumable session identifier, for mechanisms that know it *before* the run starts.
   *
   * Most real runtimes do not: the Claude Code CLI mints the session id and reports it in
   * its first stream frame, so `ClaudeCodeRunner` calls `ctx.saveExecutionHandle` from
   * inside `run` the moment that frame arrives. Both paths are supported because both
   * exist; whichever fires first wins, and persisting twice is harmless.
   *
   * Return a bare identifier: it is persisted in a database shared with the other agent,
   * so it must not contain credentials or conversation content.
   *
   * `invocation.previous_execution_handle` carries the handle from the previous attempt,
   * which a runner may use to reconnect rather than starting cold.
   */
  sessionId?(invocation: TaskInvocation): string | undefined;
  /**
   * Runtime telemetry for this invocation's last run, in the neutral shape.
   *
   * Consulted only when `run` did not return one — a run that ended by throwing produces no
   * result object, and that is precisely the attempt a benchmark must still account for.
   */
  telemetry?(invocation: TaskInvocation): AttemptTelemetryUpdate | undefined;
  /** Optional readiness probe: is the underlying session/process usable right now? */
  probe?(): Promise<{ ok: boolean; detail?: string }>;
  dispose?(): Promise<void>;
}

export interface ClaudeRunResult {
  readonly summary: string;
  readonly changed_scope?: readonly string[];
  readonly artifacts?: readonly ArtifactId[];
  readonly verification_results?: readonly VerificationResult[];
  readonly remaining_risks?: readonly string[];
  readonly recommended_next_action?: string;
  readonly commit_or_diff?: string | null;
  /** Set when the run could not finish; produces a PARTIAL deliverable. */
  readonly blocker?: string;
  /** Runtime observations for this attempt, already in the runtime-neutral shape. */
  readonly telemetry?: AttemptTelemetryUpdate;
}

/**
 * Copy only the fields the neutral telemetry contract defines.
 *
 * An explicit projection rather than a pass-through: `reportTelemetry` writes to a record
 * shared with the other agent and readable by any supervisor, so a runner that grew an
 * extra field — a prompt, a session handle, an auth detail — must not be able to smuggle
 * it into that record simply by attaching it to its update object.
 */
export function projectTelemetryUpdate(update: AttemptTelemetryUpdate): AttemptTelemetryUpdate {
  return {
    ...(update.runtime !== undefined ? { runtime: update.runtime } : {}),
    ...(update.runtime_version !== undefined ? { runtime_version: update.runtime_version } : {}),
    ...(update.requested_model !== undefined ? { requested_model: update.requested_model } : {}),
    ...(update.requested_effort !== undefined ? { requested_effort: update.requested_effort } : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.runtime_started_at !== undefined
      ? { runtime_started_at: update.runtime_started_at }
      : {}),
    ...(update.first_output_at !== undefined ? { first_output_at: update.first_output_at } : {}),
    ...(update.runtime_ended_at !== undefined ? { runtime_ended_at: update.runtime_ended_at } : {}),
    ...(update.runtime_duration_ms !== undefined
      ? { runtime_duration_ms: update.runtime_duration_ms }
      : {}),
    ...(update.input_tokens !== undefined ? { input_tokens: update.input_tokens } : {}),
    ...(update.output_tokens !== undefined ? { output_tokens: update.output_tokens } : {}),
    ...(update.cached_input_tokens !== undefined
      ? { cached_input_tokens: update.cached_input_tokens }
      : {}),
    ...(update.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: update.cache_creation_input_tokens }
      : {}),
    ...(update.total_tokens !== undefined ? { total_tokens: update.total_tokens } : {}),
    ...(update.turn_count !== undefined ? { turn_count: update.turn_count } : {}),
    ...(update.cumulative_session_tokens !== undefined
      ? { cumulative_session_tokens: update.cumulative_session_tokens }
      : {}),
    ...(update.reported_cost_usd !== undefined
      ? { reported_cost_usd: update.reported_cost_usd }
      : {}),
    ...(update.cost_semantics !== undefined ? { cost_semantics: update.cost_semantics } : {}),
    ...(update.billing_mode_known !== undefined
      ? { billing_mode_known: update.billing_mode_known }
      : {}),
    ...(update.prompt_bytes !== undefined ? { prompt_bytes: update.prompt_bytes } : {}),
    ...(update.termination_kind !== undefined
      ? { termination_kind: update.termination_kind }
      : {}),
    ...(update.process_exit_code !== undefined
      ? { process_exit_code: update.process_exit_code }
      : {}),
  };
}

export interface ClaudeAdapterOptions {
  readonly runner: ClaudeRunner;
  readonly agent?: string;
  readonly capabilities?: readonly string[];
  readonly max_concurrency?: number;
  readonly now?: () => number;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly info: AdapterInfo;
  private readonly runner: ClaudeRunner;
  private readonly now: () => number;
  private readonly cancelled = new Set<TaskId>();

  constructor(options: ClaudeAdapterOptions) {
    this.runner = options.runner;
    this.now = options.now ?? (() => Date.now());
    this.info = {
      agent: options.agent ?? "claude",
      implementation: `claude-adapter(${options.runner.description})`,
      version: "0.1.0",
      capabilities: options.capabilities ?? ["code", "tests", "docs", "review", "analysis", "resume"],
      max_concurrency: options.max_concurrency ?? 1,
    };
  }

  async health(): Promise<HealthReport> {
    // Contract says health() must not throw — an adapter that explodes on a liveness
    // probe would take down the orchestrator's scheduling loop.
    try {
      if (!this.runner.probe) {
        return { status: AdapterHealth.READY, checked_at: this.now() };
      }
      const { ok, detail } = await this.runner.probe();
      return {
        status: ok ? AdapterHealth.READY : AdapterHealth.UNAVAILABLE,
        ...(detail ? { detail } : {}),
        checked_at: this.now(),
      };
    } catch (err) {
      return {
        status: AdapterHealth.UNAVAILABLE,
        detail: (err as Error).message,
        checked_at: this.now(),
      };
    }
  }

  async invoke(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable> {
    await ctx.report({
      state: TaskState.WORKING,
      current_action: `claude starting: ${invocation.spec.objective}`,
      owned_scope: invocation.spec.scope.paths,
      progress: 0,
      artifacts: [],
      blockers: [],
      next_action: "execute task within leased scope",
    });

    if (this.cancelled.has(invocation.task_id) || ctx.signal.aborted) {
      this.cancelled.delete(invocation.task_id);
      return this.partial(invocation, "cancelled before work began", []);
    }

    // Persist the resumable pointer BEFORE running, not after. A handle saved on the
    // success path is worthless: the only time anyone needs it is when the run died.
    const sessionId = this.runner.sessionId?.(invocation);
    if (sessionId) {
      try {
        await ctx.saveExecutionHandle(sessionId);
      } catch (err) {
        // A rejected handle (too long, credential-shaped) is a bug in the runner, not a
        // reason to abandon the task — but it must be visible, not swallowed silently.
        await ctx.report({
          state: TaskState.WORKING,
          current_action: `execution handle rejected: ${(err as Error).message}`,
          owned_scope: invocation.spec.scope.paths,
          progress: 0,
          artifacts: [],
          blockers: [],
          next_action: "continue without resumability",
        });
      }
    }

    let result: ClaudeRunResult | undefined;
    try {
      try {
        result = await this.runner.run(invocation, ctx);
      } catch (err) {
        if (ctx.signal.aborted) {
          return this.partial(invocation, "deadline reached during execution", []);
        }
        // Preserve a BridgeError's code instead of flattening everything to ADAPTER_FAILURE.
        // The code carries retryability: a runner reporting TIMEOUT or INTERNAL is describing
        // a transient fault the orchestrator should retry, and rewriting it as
        // ADAPTER_FAILURE would silently consume the caller's retry budget.
        if (err instanceof BridgeError) {
          throw err;
        }
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          `claude runner failed: ${(err as Error).message}`,
          { task_id: invocation.task_id, runner: this.runner.description },
        );
      }

      return await this.finish(invocation, ctx, result);
    } finally {
      // Every exit path, including the throws above: an attempt that failed costs real
      // tokens and real wall time, and leaving it out of the record would make the
      // benchmark's per-attempt costs systematically optimistic.
      await this.reportTelemetry(invocation, ctx, result);
    }
  }

  /**
   * Hand the runtime's observations to the control plane through the neutral callback.
   *
   * `reportTelemetry` is optional on the context — an embedder that predates it simply gets
   * no telemetry — so this is a no-op rather than an error when it is absent.
   */
  private async reportTelemetry(
    invocation: TaskInvocation,
    ctx: InvocationContext,
    result: ClaudeRunResult | undefined,
  ): Promise<void> {
    if (!ctx.reportTelemetry) return;
    const update = result?.telemetry ?? this.runner.telemetry?.(invocation);
    if (!update) return;
    await ctx.reportTelemetry(projectTelemetryUpdate(update));
  }

  private async finish(
    invocation: TaskInvocation,
    ctx: InvocationContext,
    result: ClaudeRunResult,
  ): Promise<Deliverable> {
    if (result.blocker) {
      await ctx.raiseBlocker(result.blocker);
      return this.partial(
        invocation,
        result.blocker,
        result.artifacts ?? [],
        // Keep the runner's own risk list. Collapsing it to just the blocker throws away
        // the diagnostic detail the runtime actually produced — for a timed-out or
        // unauthenticated run, that detail is the whole story.
        result.remaining_risks ?? [],
        result.changed_scope ?? [],
        result.verification_results ?? [],
        result.summary,
      );
    }

    const verifications = result.verification_results ?? [];
    // Honesty gate: the control plane rejects COMPLETE without passing evidence, but
    // downgrading here produces a clearer deliverable than an exception at submit time.
    const status =
      verifications.length > 0 && verifications.every((v) => v.passed)
        ? DeliverableStatus.COMPLETE
        : DeliverableStatus.PARTIAL;
    const failing = verifications.filter((verification) => !verification.passed);

    return {
      task_id: invocation.task_id,
      agent: this.info.agent,
      status,
      summary: result.summary,
      // A task's allowed globs are not evidence that every matching path changed. When
      // the runtime omits its exact changed paths, report none instead of inventing them.
      changed_scope: result.changed_scope ?? [],
      artifacts: result.artifacts ?? [],
      commit_or_diff: result.commit_or_diff ?? null,
      verification_performed: verifications.map((v) => v.command),
      verification_results: verifications,
      remaining_risks:
        status === DeliverableStatus.PARTIAL && verifications.length === 0
          ? [...(result.remaining_risks ?? []), "no verification evidence was produced"]
          : status === DeliverableStatus.PARTIAL && failing.length > 0
            ? [...(result.remaining_risks ?? []), `${failing.length} structured verification check(s) failed`]
            : (result.remaining_risks ?? []),
      dependencies_unblocked: [],
      recommended_next_action: result.recommended_next_action ?? "review the artifacts",
      at: this.now(),
    };
  }

  async cancel(task_id: TaskId, _reason: string): Promise<void> {
    this.cancelled.add(task_id);
  }

  async dispose(): Promise<void> {
    await this.runner.dispose?.();
  }

  private partial(
    invocation: TaskInvocation,
    reason: string,
    artifacts: readonly ArtifactId[],
    extraRisks: readonly string[] = [],
    changedScope: readonly string[] = [],
    verifications: readonly VerificationResult[] = [],
    summary?: string,
  ): Deliverable {
    // Deduplicate: the blocker is often repeated in the risk list, and a deliverable that
    // says the same thing twice reads like two separate problems.
    const risks = [...new Set([reason, ...extraRisks])];
    return {
      task_id: invocation.task_id,
      agent: this.info.agent,
      status: DeliverableStatus.PARTIAL,
      summary: summary ?? `claude stopped early: ${reason}`,
      changed_scope: changedScope,
      artifacts,
      commit_or_diff: null,
      verification_performed: verifications.map((verification) => verification.command),
      verification_results: verifications,
      remaining_risks: risks,
      dependencies_unblocked: [],
      recommended_next_action:
        "resolve the blocker and keep the same durable task; resume it only when eligible",
      at: this.now(),
    };
  }
}

/**
 * A runner that delegates to a caller-supplied function.
 *
 * This is the seam for the Claude Agent SDK or a spawned `claude -p` process: wrap
 * whichever you use in this and the bridge is agnostic to the choice.
 */
export function functionRunner(
  description: string,
  fn: (invocation: TaskInvocation, ctx: InvocationContext) => Promise<ClaudeRunResult>,
  options: {
    probe?: () => Promise<{ ok: boolean; detail?: string }>;
    sessionId?: (invocation: TaskInvocation) => string | undefined;
    telemetry?: (invocation: TaskInvocation) => AttemptTelemetryUpdate | undefined;
  } = {},
): ClaudeRunner {
  return {
    description,
    run: fn,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  };
}
