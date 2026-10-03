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
  BRIDGE_VERSION,
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
  /** True only for runners that report running/stopped from correlated process-tree evidence. */
  readonly supportsStopConfirmation?: boolean;
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
    ...(update.runtime_duration_source !== undefined
      ? { runtime_duration_source: update.runtime_duration_source } : {}),
    ...(update.runtime_failure !== undefined ? { runtime_failure: update.runtime_failure === null
      ? null : { category: update.runtime_failure.category, source: update.runtime_failure.source,
        retryable: update.runtime_failure.retryable, retry_after_at: update.runtime_failure.retry_after_at } } : {}),
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
  /** Per-adapter pending-call bound; default 64. This is not a workspace-wide limit. */
  readonly max_pending_invocations?: number;
  /** Deadline for cancellation acknowledgement; an expiry retains an uncertain runtime. */
  readonly cancel_timeout_ms?: number;
  readonly now?: () => number;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly info: AdapterInfo;
  private readonly runner: ClaudeRunner;
  private readonly now: () => number;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly invocations = new Map<TaskId, {
    controller: AbortController; done: Promise<Deliverable>; context: InvocationContext;
  }>();
  private readonly uncertainStops = new Map<TaskId, BridgeError>();
  private readonly cancelTimeoutMs: number;
  private readonly maxPending: number;
  private active = 0;
  private readonly pending: Array<{
    task_id: TaskId;
    signal: AbortSignal;
    onAbort: () => void;
    timer: ReturnType<typeof setTimeout>;
    cancel: (reason: string) => void;
    resolve: (release: () => void) => void;
  }> = [];

  constructor(options: ClaudeAdapterOptions) {
    this.runner = options.runner;
    this.now = options.now ?? (() => Date.now());
    const concurrency = options.max_concurrency ?? 1;
    this.maxPending = options.max_pending_invocations ?? 64;
    this.cancelTimeoutMs = options.cancel_timeout_ms ?? 30_000;
    if (!Number.isInteger(concurrency) || concurrency < 1
      || !Number.isInteger(this.maxPending) || this.maxPending < 0) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Claude concurrency must be positive and the pending bound non-negative");
    }
    if (!Number.isSafeInteger(this.cancelTimeoutMs) || this.cancelTimeoutMs < 1 || this.cancelTimeoutMs > 60_000) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Claude cancellation timeout must be 1..60000ms");
    }
    this.info = {
      agent: options.agent ?? "claude",
      implementation: `claude-adapter(${options.runner.description})`,
      version: BRIDGE_VERSION,
      capabilities: [...new Set([
        ...(options.capabilities ?? ["code", "tests", "docs", "review", "analysis", "resume"]),
        ...(this.runner.supportsStopConfirmation === true ? ["stop-confirmation"] : []),
      ])],
      max_concurrency: concurrency,
    };
  }

  async health(): Promise<HealthReport> {
    // Contract says health() must not throw — an adapter that explodes on a liveness
    // probe would take down the orchestrator's scheduling loop.
    try {
      if (this.disposed) return { status: AdapterHealth.UNAVAILABLE, detail: "adapter disposed", checked_at: this.now() };
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

  invoke(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable> {
    if (this.disposed) return Promise.reject(new BridgeError(ErrorCode.ADAPTER_FAILURE, "Claude adapter is disposed"));
    const uncertain = this.uncertainStops.get(invocation.task_id);
    if (uncertain) return Promise.reject(uncertain);
    if (this.invocations.has(invocation.task_id)) {
      return Promise.reject(new BridgeError(ErrorCode.ADAPTER_FAILURE, "Claude task already has an active invocation"));
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const invocationContext: InvocationContext = { ...ctx, signal: controller.signal,
      reportRuntimeState: async (state) => {
        await ctx.reportRuntimeState?.(state);
        if (state === "stopped") this.uncertainStops.delete(invocation.task_id);
      },
    };
    const done = Promise.resolve().then(() => this.invokeBounded(invocation, invocationContext)).catch((error: unknown) => {
      if (error instanceof BridgeError && error.code === ErrorCode.RUNTIME_STOP_UNCONFIRMED) {
        this.uncertainStops.set(invocation.task_id, error);
      }
      throw error;
    }).finally(() => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (this.invocations.get(invocation.task_id) === entry) this.invocations.delete(invocation.task_id);
    });
    const entry = { controller, done, context: invocationContext };
    this.invocations.set(invocation.task_id, entry);
    return done;
  }

  private async invokeBounded(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable> {
    if (ctx.signal.aborted) {
      await ctx.reportRuntimeState?.("stopped");
      return this.partial(invocation, "cancelled before admission", []);
    }
    let release: () => void;
    try {
      release = await this.acquireSlot(invocation, ctx.signal);
    } catch (error) {
      await ctx.reportRuntimeState?.("stopped");
      if (error instanceof BridgeError && error.code === ErrorCode.TIMEOUT) {
        return this.partial(invocation, error.message, []);
      }
      throw error;
    }
    let runnerEntered = false;
    try {
      return await this.execute(invocation, ctx, () => { runnerEntered = true; });
    } finally {
      try { if (!runnerEntered) await ctx.reportRuntimeState?.("stopped"); }
      finally { release(); }
    }
  }

  private acquireSlot(invocation: TaskInvocation, signal: AbortSignal): Promise<() => void> {
    const remaining = invocation.deadline_at - this.now();
    if (signal.aborted || remaining <= 0) {
      return Promise.reject(new BridgeError(ErrorCode.TIMEOUT, "Claude admission deadline reached"));
    }
    if (this.active < this.info.max_concurrency) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new BridgeError(ErrorCode.ADAPTER_FAILURE, "Claude pending invocation queue is full"));
    }
    return new Promise((resolve, reject) => {
      const cancel = (reason: string): void => {
        const index = this.pending.indexOf(waiter);
        if (index < 0) return;
        this.pending.splice(index, 1);
        clearTimeout(waiter.timer);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(new BridgeError(ErrorCode.TIMEOUT, reason));
      };
      const waiter = {
        task_id: invocation.task_id,
        signal,
        onAbort: () => cancel("Claude invocation aborted while queued"),
        timer: setTimeout(() => cancel("Claude admission deadline reached while queued"), remaining),
        cancel,
        resolve,
      };
      this.pending.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.pending.shift();
      if (next) {
        clearTimeout(next.timer);
        next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaser());
      } else {
        this.active--;
      }
    };
  }

  private async execute(invocation: TaskInvocation, ctx: InvocationContext, markRunnerEntered: () => void): Promise<Deliverable> {
    await ctx.report({
      state: TaskState.WORKING,
      current_action: `claude starting: ${invocation.spec.objective}`,
      owned_scope: invocation.spec.scope.paths,
      progress: 0,
      artifacts: [],
      blockers: [],
      next_action: "execute task within leased scope",
    });

    if (ctx.signal.aborted) {
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
    let primaryError: unknown;
    try {
      try {
        markRunnerEntered();
        result = await this.runner.run(invocation, ctx);
      } catch (err) {
        if (err instanceof BridgeError && err.code === ErrorCode.RUNTIME_STOP_UNCONFIRMED) throw err;
        if (ctx.signal.aborted) {
          return this.partial(invocation, "invocation cancelled during execution", []);
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

      if (ctx.signal.aborted && !result.blocker) {
        return this.partial(invocation, "invocation cancelled during execution", result.artifacts ?? [],
          result.remaining_risks ?? [], result.changed_scope ?? [], result.verification_results ?? []);
      }

      return await this.finish(invocation, ctx, result);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // Every exit path, including the throws above: an attempt that failed costs real
      // tokens and real wall time, and leaving it out of the record would make the
      // benchmark's per-attempt costs systematically optimistic.
      try { await this.reportTelemetry(invocation, ctx, result); }
      catch (error) {
        // A late/fenced telemetry write must not erase the reason a scope stays quarantined.
        if (primaryError instanceof BridgeError && primaryError.code === ErrorCode.RUNTIME_STOP_UNCONFIRMED) throw primaryError;
        throw error;
      }
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

  async cancel(task_id: TaskId, reason: string): Promise<void> {
    const uncertain = this.uncertainStops.get(task_id);
    if (uncertain) throw uncertain;
    const active = this.invocations.get(task_id);
    if (!active) return;
    active.controller.abort(new Error(reason || "Claude invocation cancelled"));
    for (const waiter of [...this.pending]) {
      if (waiter.task_id === task_id) waiter.cancel("Claude invocation cancelled while queued");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([active.done, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED,
            "Claude runner did not acknowledge cancellation before its stop deadline",
            { task_id, runtime_stop_confirmed: false });
          this.uncertainStops.set(task_id, error);
          void active.context.reportRuntimeState?.("unconfirmed").catch(() => {});
          reject(error);
        }, this.cancelTimeoutMs);
      })]);
    } catch (error) {
      if (error instanceof BridgeError && error.code === ErrorCode.RUNTIME_STOP_UNCONFIRMED) throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.invocations.keys()]
      .map((task_id) => this.cancel(task_id, "Claude adapter disposed")));
    const unconfirmed = results.find((result) => result.status === "rejected"
      && result.reason instanceof BridgeError && result.reason.code === ErrorCode.RUNTIME_STOP_UNCONFIRMED);
    if (unconfirmed?.status === "rejected") throw unconfirmed.reason;
    if (this.runner.dispose) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.runner.dispose(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED,
            "Claude runner did not finish disposal before its stop deadline", { runtime_stop_confirmed: false })),
          this.cancelTimeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
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
    dispose?: () => Promise<void>;
    /** Opt in only when the function reports correlated runtime stop evidence through ctx. */
    supportsStopConfirmation?: boolean;
  } = {},
): ClaudeRunner {
  return {
    description,
    run: fn,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.dispose ? { dispose: options.dispose } : {}),
    ...(options.supportsStopConfirmation === true ? { supportsStopConfirmation: true } : {}),
  };
}
