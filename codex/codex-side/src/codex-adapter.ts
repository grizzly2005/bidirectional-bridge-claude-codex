import { createHash } from "node:crypto";

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

import {
  CodexMcpProcessClient,
  buildDefaultCodexToolPath,
  type CodexApprovalPolicy,
  type CodexMcpClient,
  type CodexMcpResponse,
  type CodexSandbox,
} from "./codex-mcp-client.js";
import {
  CODEX_DEVELOPER_INSTRUCTIONS,
  buildRepairPrompt,
  buildResumePrompt,
  buildTaskPrompt,
  parseCodexTaskResult,
  type CodexTaskResult,
} from "./prompt.js";

export interface CodexAdapterOptions {
  readonly client?: CodexMcpClient;
  readonly implementation?: string;
  readonly model?: string;
  readonly approval_policy?: CodexApprovalPolicy;
  readonly sandbox?: CodexSandbox;
  readonly max_concurrency?: number;
  readonly max_structure_repairs?: number;
  readonly max_idempotency_entries?: number;
  /** Exact PATH for delegated shell tools. `null` disables the safe automatic PATH layer. */
  readonly tool_path?: string | null;
  readonly now?: () => number;
}

interface RunEntry {
  readonly fingerprint: string;
  readonly promise: Promise<Deliverable>;
  settled: boolean;
}

interface ActiveInvocation {
  readonly key: string;
  readonly controller: AbortController;
  reason: string;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

type MutableTelemetryUpdate = {
  -readonly [K in keyof AttemptTelemetryUpdate]: AttemptTelemetryUpdate[K];
};

function addNullableNumber(
  current: number | null | undefined,
  incoming: number | null | undefined,
): number | null | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return current ?? null;
  return (current ?? 0) + incoming;
}

/** Accumulate per-turn App Server observations into one per-attempt update. */
function mergeRuntimeTelemetry(
  target: MutableTelemetryUpdate,
  incoming: AttemptTelemetryUpdate | undefined,
): void {
  if (incoming === undefined) return;
  for (const field of ["runtime", "runtime_version", "model"] as const) {
    if (incoming[field] !== undefined) target[field] = incoming[field];
  }
  if (incoming.runtime_started_at !== undefined) {
    target.runtime_started_at =
      incoming.runtime_started_at === null
        ? (target.runtime_started_at ?? null)
        : target.runtime_started_at === null || target.runtime_started_at === undefined
          ? incoming.runtime_started_at
          : Math.min(target.runtime_started_at, incoming.runtime_started_at);
  }
  if (incoming.first_output_at !== undefined) {
    target.first_output_at =
      incoming.first_output_at === null
        ? (target.first_output_at ?? null)
        : target.first_output_at === null || target.first_output_at === undefined
          ? incoming.first_output_at
          : Math.min(target.first_output_at, incoming.first_output_at);
  }
  if (incoming.runtime_ended_at !== undefined) target.runtime_ended_at = incoming.runtime_ended_at;
  target.runtime_duration_ms = addNullableNumber(
    target.runtime_duration_ms,
    incoming.runtime_duration_ms,
  );
  target.input_tokens = addNullableNumber(target.input_tokens, incoming.input_tokens);
  target.output_tokens = addNullableNumber(target.output_tokens, incoming.output_tokens);
  target.cached_input_tokens = addNullableNumber(
    target.cached_input_tokens,
    incoming.cached_input_tokens,
  );
  target.cache_creation_input_tokens = addNullableNumber(
    target.cache_creation_input_tokens,
    incoming.cache_creation_input_tokens,
  );
  target.total_tokens = addNullableNumber(target.total_tokens, incoming.total_tokens);
  target.turn_count = addNullableNumber(target.turn_count, incoming.turn_count);
  if (incoming.cumulative_session_tokens !== undefined) {
    target.cumulative_session_tokens = incoming.cumulative_session_tokens;
  }
  target.reported_cost_usd = addNullableNumber(
    target.reported_cost_usd,
    incoming.reported_cost_usd,
  );
  if (incoming.cost_semantics !== undefined) target.cost_semantics = incoming.cost_semantics;
  if (incoming.billing_mode_known !== undefined) {
    target.billing_mode_known =
      (target.billing_mode_known ?? false) || incoming.billing_mode_known;
  }
  target.prompt_bytes = addNullableNumber(target.prompt_bytes, incoming.prompt_bytes);
  if (incoming.termination_kind !== undefined) {
    target.termination_kind = incoming.termination_kind;
  }
  if (incoming.process_exit_code !== undefined) {
    target.process_exit_code = incoming.process_exit_code;
  }
}

export type CodexShellEnvironmentFilterAction = "include" | "exclude";

/**
 * Canonical allowlist applied after Codex's minimal `core` inheritance.
 *
 * Include filters turn the map into an allowlist. No credential-shaped names appear here,
 * and Codex's built-in KEY/SECRET/TOKEN exclusions remain enabled as a second layer.
 */
export const CODEX_SHELL_ENVIRONMENT_FILTERS: Readonly<
  Record<string, CodexShellEnvironmentFilterAction>
> = Object.freeze({
  COMSPEC: "include",
  HOME: "include",
  LANG: "include",
  "LC_*": "include",
  LOGNAME: "include",
  PATH: "include",
  PATHEXT: "include",
  PSMODULEPATH: "include",
  SHELL: "include",
  SYSTEMDRIVE: "include",
  SYSTEMROOT: "include",
  TEMP: "include",
  TERM: "include",
  TMP: "include",
  USER: "include",
  USERNAME: "include",
  USERPROFILE: "include",
  WINDIR: "include",
});

export function buildCodexShellEnvironmentPolicy(
  toolPath: string | undefined,
): Record<string, unknown> {
  return {
    inherit: "core",
    ignore_default_excludes: false,
    filters: CODEX_SHELL_ENVIRONMENT_FILTERS,
    ...(toolPath !== undefined ? { set: { PATH: toolPath } } : {}),
  };
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError("semaphore wait aborted"));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }

    return new Promise<() => void>((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError("semaphore wait aborted"));
      };
      waiter = { signal, resolve, reject, onAbort };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.active -= 1;
        return;
      }
      next.signal.removeEventListener("abort", next.onAbort);
      next.resolve(this.releaseHandle());
    };
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

function invocationFingerprint(invocation: TaskInvocation): string {
  const stable = canonicalize({
    task_id: invocation.task_id,
    run_id: invocation.run_id ?? null,
    parent_task_id: invocation.parent_task_id ?? null,
    delegation_depth: invocation.delegation_depth ?? null,
    spec: invocation.spec,
    inputs: invocation.inputs.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      sha256: artifact.sha256,
    })),
    workspace_root: invocation.workspace_root,
    lease_id: invocation.lease_id,
    deadline_at: invocation.deadline_at,
    attempt: invocation.attempt,
    previous_execution_handle: invocation.previous_execution_handle ?? null,
    resume_required: invocation.resume_required ?? false,
  });
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function reasonText(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return fallback;
}

/** Production AgentAdapter backed by the official `codex mcp-server` tools. */
export class CodexAdapter implements AgentAdapter {
  readonly info: AdapterInfo;

  private readonly client: CodexMcpClient;
  private readonly model: string | undefined;
  private readonly approvalPolicy: CodexApprovalPolicy;
  private readonly sandbox: CodexSandbox;
  private readonly maxStructureRepairs: number;
  private readonly maxIdempotencyEntries: number;
  private readonly now: () => number;
  private readonly toolPath: string | undefined;
  private readonly semaphore: AsyncSemaphore;
  private readonly runs = new Map<string, RunEntry>();
  private readonly activeByTask = new Map<TaskId, ActiveInvocation>();
  private disposed = false;

  constructor(options: CodexAdapterOptions = {}) {
    const maxConcurrency = options.max_concurrency ?? 2;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "max_concurrency must be >= 1");
    }
    this.client = options.client ?? new CodexMcpProcessClient();
    this.model = options.model;
    this.approvalPolicy = options.approval_policy ?? "never";
    this.sandbox = options.sandbox ?? "workspace-write";
    this.maxStructureRepairs = options.max_structure_repairs ?? 1;
    this.maxIdempotencyEntries = options.max_idempotency_entries ?? 512;
    this.toolPath =
      options.tool_path === undefined
        ? buildDefaultCodexToolPath()
        : options.tool_path === null
          ? undefined
          : options.tool_path;
    if (!Number.isInteger(this.maxStructureRepairs) || this.maxStructureRepairs < 0) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        "max_structure_repairs must be a non-negative integer",
      );
    }
    if (!Number.isInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        "max_idempotency_entries must be >= 1",
      );
    }
    if (this.toolPath !== undefined && this.toolPath.trim().length === 0) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "tool_path must be non-empty or null");
    }
    this.now = options.now ?? Date.now;
    this.semaphore = new AsyncSemaphore(maxConcurrency);
    this.info = {
      agent: "codex",
      implementation: options.implementation ?? "official-codex-cli-mcp",
      version: "0.1.0",
      capabilities: [
        "code",
        "tests",
        "shell",
        "mcp",
        "resume",
        "structured-deliverable",
        ...(options.implementation === "official-codex-app-server" ? ["token-usage"] : []),
      ],
      max_concurrency: maxConcurrency,
    };
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.now();
    if (this.disposed) {
      return {
        status: AdapterHealth.UNAVAILABLE,
        detail: "Codex adapter is disposed",
        checked_at: checkedAt,
      };
    }
    try {
      const probe = await this.client.probe();
      const status =
        probe.state === "READY"
          ? AdapterHealth.READY
          : probe.state === "DEGRADED"
            ? AdapterHealth.DEGRADED
            : AdapterHealth.UNAVAILABLE;
      return {
        status,
        detail: `${probe.detail}; tools=${probe.tools.join(",") || "none"}`,
        checked_at: checkedAt,
      };
    } catch (error) {
      return {
        status: AdapterHealth.UNAVAILABLE,
        detail: error instanceof Error ? error.message : String(error),
        checked_at: checkedAt,
      };
    }
  }

  invoke(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable> {
    if (this.disposed) {
      return Promise.reject(
        new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex adapter is disposed"),
      );
    }
    const fingerprint = invocationFingerprint(invocation);
    const existing = this.runs.get(invocation.idempotency_key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new BridgeError(
            ErrorCode.IDEMPOTENCY_MISMATCH,
            "idempotency key was reused for a different Codex invocation",
            { task_id: invocation.task_id, key: invocation.idempotency_key },
          ),
        );
      }
      return existing.promise;
    }

    const promise = this.execute(invocation, ctx);
    const entry: RunEntry = { fingerprint, promise, settled: false };
    this.runs.set(invocation.idempotency_key, entry);
    void promise.then(
      () => {
        entry.settled = true;
        this.trimIdempotencyCache();
      },
      () => {
        // Replaying the same key must replay the same failure. A transport error may happen
        // after Codex already changed files; deleting this entry would allow duplicate work.
        entry.settled = true;
        this.trimIdempotencyCache();
      },
    );
    this.trimIdempotencyCache();
    return promise;
  }

  async cancel(task_id: TaskId, reason: string): Promise<void> {
    const active = this.activeByTask.get(task_id);
    if (active === undefined) return;
    active.reason = reason || "cancelled by control plane";
    active.controller.abort(new Error(active.reason));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.runs.values()]
      .filter((entry) => !entry.settled)
      .map((entry) => entry.promise);
    for (const active of this.activeByTask.values()) {
      active.reason = "adapter disposed";
      active.controller.abort(new Error(active.reason));
    }
    try {
      await this.client.close();
    } finally {
      // Keep the control plane alive until aborted invocations have returned their PARTIAL
      // deliverables; bridge-server closes shared state only after this method resolves.
      await Promise.allSettled(pending);
    }
  }

  private async execute(
    invocation: TaskInvocation,
    ctx: InvocationContext,
  ): Promise<Deliverable> {
    const concurrent = this.activeByTask.get(invocation.task_id);
    if (concurrent !== undefined) {
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        "task already has an active Codex invocation",
        { task_id: invocation.task_id, active_key: concurrent.key },
      );
    }

    const controller = new AbortController();
    const active: ActiveInvocation = {
      key: invocation.idempotency_key,
      controller,
      reason: "invocation stopped",
    };
    this.activeByTask.set(invocation.task_id, active);

    let deadlineReached = false;
    const onParentAbort = (): void => {
      active.reason = reasonText(ctx.signal.reason, "cancelled by control plane");
      controller.abort(ctx.signal.reason);
    };
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    if (ctx.signal.aborted) onParentAbort();
    const delay = invocation.deadline_at - this.now();
    let timer: NodeJS.Timeout | undefined;
    if (controller.signal.aborted) {
      // Parent cancellation was already active before the invocation began.
    } else if (delay <= 0) {
      deadlineReached = true;
      active.reason = "invocation deadline already elapsed";
      controller.abort(new Error(active.reason));
    } else {
      timer = setTimeout(() => {
        deadlineReached = true;
        active.reason = "invocation deadline elapsed";
        controller.abort(new Error(active.reason));
      }, delay);
      timer.unref();
    }

    let release: (() => void) | undefined;
    const published: ArtifactId[] = [];
    const recorded: VerificationResult[] = [];
    const runtimeTelemetry: MutableTelemetryUpdate = {};

    try {
      release = await this.semaphore.acquire(controller.signal);
      await ctx.report({
        state: TaskState.WORKING,
        current_action: "Starting bounded Codex MCP task",
        owned_scope: invocation.spec.scope.paths,
        progress: 0.1,
        artifacts: [],
        blockers: [],
        next_action: "Collect Codex result and validate the structured deliverable",
      });

      const first = await this.startOrResume(invocation, ctx, controller.signal);
      mergeRuntimeTelemetry(runtimeTelemetry, first.telemetry);

      const parsed = await this.parseWithBoundedRepair(
        first,
        invocation,
        ctx,
        controller.signal,
        (response) => mergeRuntimeTelemetry(runtimeTelemetry, response.telemetry),
      );
      if (parsed === undefined) {
        return this.invalidResultDeliverable(invocation);
      }

      await ctx.report({
        state: TaskState.VERIFYING,
        current_action: "Registering Codex artifacts and deterministic evidence",
        owned_scope: invocation.spec.scope.paths,
        progress: 0.82,
        artifacts: published,
        blockers: [],
        next_action: "Submit the structured deliverable to the control plane",
      });

      for (const artifact of parsed.artifacts) {
        if (controller.signal.aborted) throw abortError(active.reason);
        const artifactId = await ctx.publishArtifact({
          kind: artifact.kind,
          name: artifact.name,
          media_type: artifact.media_type,
          ...(artifact.path !== undefined ? { path: artifact.path } : {}),
          ...(artifact.inline !== undefined ? { inline: artifact.inline } : {}),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        });
        published.push(artifactId);
      }

      for (const verification of parsed.verification_results) {
        if (controller.signal.aborted) throw abortError(active.reason);
        await ctx.recordVerification(verification);
        recorded.push(verification);
      }

      if (parsed.status === DeliverableStatus.PARTIAL && parsed.blocker !== undefined) {
        await ctx.raiseBlocker(parsed.blocker);
      }

      const deliverable = this.toDeliverable(invocation, parsed, published, recorded);
      await ctx.report({
        state:
          parsed.status === DeliverableStatus.PARTIAL && parsed.blocker !== undefined
            ? TaskState.BLOCKED
            : TaskState.VERIFYING,
        current_action: "Codex deliverable assembled",
        owned_scope: invocation.spec.scope.paths,
        progress: 1,
        artifacts: published,
        blockers: parsed.blocker !== undefined ? [parsed.blocker] : [],
        next_action: "Control plane validates and records the deliverable",
      });
      return deliverable;
    } catch (error) {
      const timedOut =
        deadlineReached ||
        controller.signal.aborted ||
        (error instanceof BridgeError && error.code === ErrorCode.TIMEOUT);
      if (timedOut) {
        return this.stoppedDeliverable(
          invocation,
          published,
          recorded,
          active.reason,
        );
      }
      throw error instanceof BridgeError
        ? error
        : new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex adapter invocation failed", {
            cause: error instanceof Error ? error.message : String(error),
          });
    } finally {
      await ctx.reportTelemetry?.(runtimeTelemetry);
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
      release?.();
      const current = this.activeByTask.get(invocation.task_id);
      if (current === active) this.activeByTask.delete(invocation.task_id);
    }
  }

  private async parseWithBoundedRepair(
    first: CodexMcpResponse,
    invocation: TaskInvocation,
    ctx: InvocationContext,
    signal: AbortSignal,
    onResponse: (response: CodexMcpResponse) => void,
  ): Promise<CodexTaskResult | undefined> {
    let response = first;
    let lastError: unknown;
    for (let repair = 0; repair <= this.maxStructureRepairs; repair += 1) {
      try {
        return parseCodexTaskResult(response.content, invocation);
      } catch (error) {
        lastError = error;
        if (repair >= this.maxStructureRepairs || this.remainingMs(invocation) < 1_000) {
          break;
        }
        await ctx.report({
          state: TaskState.WORKING,
          current_action: "Requesting one bounded structured-output repair from the same Codex thread",
          owned_scope: invocation.spec.scope.paths,
          progress: 0.68,
          artifacts: [],
          blockers: [],
          next_action: "Re-validate the corrected deliverable without rerunning work",
        });
        const previousThreadId = response.thread_id;
        response = await this.client.reply({
          thread_id: response.thread_id,
          prompt: buildRepairPrompt(error),
          timeout_ms: this.remainingMs(invocation),
          signal,
        });
        onResponse(response);
        if (response.thread_id !== previousThreadId) {
          await ctx.saveExecutionHandle(response.thread_id);
        }
      }
    }

    if (lastError instanceof BridgeError && lastError.code !== ErrorCode.INVALID_ARGUMENT) {
      throw lastError;
    }
    return undefined;
  }

  private async startOrResume(
    invocation: TaskInvocation,
    ctx: InvocationContext,
    signal: AbortSignal,
  ): Promise<CodexMcpResponse> {
    const previousHandle = invocation.previous_execution_handle?.trim();
    if (previousHandle) {
      await ctx.report({
        state: TaskState.WORKING,
        current_action: "Resuming the persisted Codex thread after process restart",
        owned_scope: invocation.spec.scope.paths,
        progress: 0.14,
        artifacts: [],
        blockers: [],
        next_action: "Collect and validate the resumed structured deliverable",
      });
      try {
        let handleSaved = false;
        const resumed = await this.client.reply({
          thread_id: previousHandle,
          prompt: buildResumePrompt(invocation),
          timeout_ms: this.remainingMs(invocation),
          signal,
          on_execution_handle: async (threadId) => {
            await ctx.saveExecutionHandle(threadId);
            handleSaved = true;
          },
        });
        // This writes the previous attempt's pointer into the current attempt record. Do it
        // before parsing, artifact publication, or any other fallible post-processing.
        if (!handleSaved) await ctx.saveExecutionHandle(resumed.thread_id);
        return resumed;
      } catch (error) {
        if (!this.isExplicitlyStaleHandle(error) || invocation.resume_required === true) {
          throw error;
        }
        await ctx.report({
          state: TaskState.WORKING,
          current_action: "Persisted Codex thread is stale; starting one bounded replacement",
          owned_scope: invocation.spec.scope.paths,
          progress: 0.16,
          artifacts: [],
          blockers: [],
          next_action: "Persist the replacement thread id before processing its result",
        });
      }
    }

    if (invocation.resume_required === true) {
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        "strict resume requires a persisted Codex thread handle",
        { task_id: invocation.task_id, attempt: invocation.attempt },
      );
    }

    let handleSaved = false;
    const started = await this.client.start({
      prompt: buildTaskPrompt(invocation),
      cwd: invocation.workspace_root,
      approval_policy: this.approvalPolicy,
      sandbox: this.sandbox,
      ...(this.model !== undefined ? { model: this.model } : {}),
      config: {
        shell_environment_policy: buildCodexShellEnvironmentPolicy(this.toolPath),
      },
      developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
      timeout_ms: this.remainingMs(invocation),
      signal,
      on_execution_handle: async (threadId) => {
        await ctx.saveExecutionHandle(threadId);
        handleSaved = true;
      },
    });
    // The official MCP API exposes the thread id only when `codex` returns. Persist it at
    // that first observable moment, before parsing or registering any result data.
    if (!handleSaved) await ctx.saveExecutionHandle(started.thread_id);
    return started;
  }

  private isExplicitlyStaleHandle(error: unknown): boolean {
    if (!(error instanceof BridgeError) || error.code !== ErrorCode.ADAPTER_FAILURE) {
      return false;
    }
    return /(?:thread|conversation|session).*(?:not found|unknown|expired|does not exist|invalid)/i.test(
      error.message,
    );
  }

  private toDeliverable(
    invocation: TaskInvocation,
    parsed: CodexTaskResult,
    artifacts: readonly ArtifactId[],
    verifications: readonly VerificationResult[],
  ): Deliverable {
    return {
      task_id: invocation.task_id,
      agent: "codex",
      status: parsed.status,
      summary: parsed.summary,
      changed_scope: parsed.changed_scope,
      artifacts,
      commit_or_diff: parsed.commit_or_diff,
      verification_performed: verifications.map((item) => item.command),
      verification_results: verifications,
      dependencies_unblocked: [],
      remaining_risks: parsed.remaining_risks,
      recommended_next_action: parsed.recommended_next_action,
      at: this.now(),
    };
  }

  private invalidResultDeliverable(invocation: TaskInvocation): Deliverable {
    return {
      task_id: invocation.task_id,
      agent: "codex",
      status: DeliverableStatus.FAILED,
      summary: "Codex completed the turn but did not return a valid structured deliverable after the bounded repair attempt.",
      changed_scope: [],
      artifacts: [],
      commit_or_diff: null,
      verification_performed: [],
      verification_results: [],
      remaining_risks: [
        "The control plane cannot safely accept unvalidated paths, artifacts, or verification claims.",
      ],
      dependencies_unblocked: [],
      recommended_next_action: "Inspect the Codex task thread and retry with the same bounded task after correcting the output contract.",
      at: this.now(),
    };
  }

  private stoppedDeliverable(
    invocation: TaskInvocation,
    artifacts: readonly ArtifactId[],
    verifications: readonly VerificationResult[],
    reason: string,
  ): Deliverable {
    return {
      task_id: invocation.task_id,
      agent: "codex",
      status: DeliverableStatus.PARTIAL,
      summary: `Codex invocation stopped before completion: ${reason}`,
      changed_scope: [],
      artifacts,
      commit_or_diff: null,
      verification_performed: verifications.map((item) => item.command),
      verification_results: verifications,
      remaining_risks: ["The task may contain incomplete changes and requires inspection before retry."],
      dependencies_unblocked: [],
      recommended_next_action: "Inspect the leased scope, then retry or cancel the task explicitly.",
      at: this.now(),
    };
  }

  private remainingMs(invocation: TaskInvocation): number {
    return Math.max(1, invocation.deadline_at - this.now());
  }

  private trimIdempotencyCache(): void {
    if (this.runs.size <= this.maxIdempotencyEntries) return;
    for (const [key, entry] of this.runs) {
      if (this.runs.size <= this.maxIdempotencyEntries) break;
      if (entry.settled) this.runs.delete(key);
    }
  }
}
