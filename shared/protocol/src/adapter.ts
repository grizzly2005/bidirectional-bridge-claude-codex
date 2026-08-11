/**
 * The agent adapter contract.
 *
 * This is the ONLY surface the control plane uses to drive an agent. Claude implements
 * it over the Claude/Anthropic side; Codex implements it over the Codex CLI exposed as an
 * MCP server (`codex()` to open a conversation, `codex-reply()` to continue one).
 *
 * Design rules baked into this interface:
 *  - Work is delegated as a bounded `TaskSpec`, never as a chat transcript.
 *  - Inputs and outputs are artifact references, not prose blobs.
 *  - Every invocation carries a hard deadline and an abort signal, so no agent-to-agent
 *    exchange can run open-ended.
 *  - Progress is pushed through a callback so an external supervisor can observe a run
 *    that has not finished yet.
 */

import type {
  AgentId,
  ArtifactId,
  TaskId,
} from "./ids.js";
import type {
  Artifact,
  AttemptTelemetryUpdate,
  Deliverable,
  StatusUpdate,
  TaskSpec,
  VerificationResult,
} from "./types.js";

/** Everything an adapter needs to execute one task. */
export interface TaskInvocation {
  readonly task_id: TaskId;
  /** Always populated by the control-plane orchestrator; optional for legacy embedders. */
  readonly run_id?: string;
  readonly parent_task_id?: TaskId | null;
  readonly delegation_depth?: number;
  readonly spec: TaskSpec;
  /** Resolved artifacts the delegate should read as input. */
  readonly inputs: readonly Artifact[];
  /** Absolute path to the repository root the agent may operate in. */
  readonly workspace_root: string;
  /** The lease covering `spec.scope`. Writing outside it is a contract violation. */
  readonly lease_id: string;
  /** Epoch millis after which the adapter must stop and return. */
  readonly deadline_at: number;
  /** Retry counter; 0 on first attempt. Adapters may use it to change strategy. */
  readonly attempt: number;
  /** Stable key for the whole invocation — replaying it must not duplicate work. */
  readonly idempotency_key: string;
  /**
   * Handle saved by a previous attempt at this task, if any.
   *
   * Present when an earlier attempt crashed or timed out after registering a resumable
   * session. An adapter MAY reconnect to it instead of starting cold; it MUST tolerate the
   * handle being stale, since the underlying session may be long gone.
   */
  readonly previous_execution_handle?: string | null;
  /** Recovery must fail rather than silently starting a replacement runtime session. */
  readonly resume_required?: boolean;
}

/** Callbacks the control plane injects so an adapter can report without owning state. */
export interface InvocationContext {
  /** Push a progress update. Cheap; may be called several times. Never for trivial steps. */
  report(update: Omit<StatusUpdate, "task_id" | "agent" | "at">): Promise<void>;
  /** Register a produced artifact and get back its canonical id. */
  publishArtifact(
    input: Omit<Artifact, "artifact_id" | "task_id" | "produced_by" | "created_at" | "sha256" | "bytes">,
  ): Promise<ArtifactId>;
  /** Record deterministic evidence. Must reflect a command that actually ran. */
  recordVerification(result: VerificationResult): Promise<void>;
  /** Declare a blocker. Moves the task to BLOCKED; the run should then return PARTIAL. */
  raiseBlocker(reason: string): Promise<void>;
  /**
   * Persist a resumable pointer for this attempt — a Codex thread id, a Claude session id,
   * a queued job reference. Call it as soon as the underlying session exists, not at the
   * end: the whole point is that a crash between here and completion leaves something to
   * resume from.
   *
   * Rejected with `INVALID_ARGUMENT` if the handle exceeds
   * `EXECUTION_HANDLE_MAX_LENGTH` or contains control characters. Never put secrets or
   * conversation content here — the control-plane database is shared with the other agent
   * and readable by any supervisor.
   */
  saveExecutionHandle(handle: string): Promise<void>;
  /**
   * Merge authoritative runtime observations into an in-memory draft. The control plane
   * persists exactly one normalized record when the attempt ends; this callback never
   * writes a partial telemetry row.
   */
  reportTelemetry?(update: AttemptTelemetryUpdate): Promise<void>;
  /** Aborted when the deadline passes or the task is cancelled. */
  readonly signal: AbortSignal;
}

/** Static description of an adapter, used for capability checks and logging. */
export interface AdapterInfo {
  readonly agent: AgentId;
  readonly implementation: string;
  readonly version: string;
  /** Free-form capability tags, e.g. `["code", "tests", "shell"]`. */
  readonly capabilities: readonly string[];
  /** Max concurrent invocations this adapter will accept. */
  readonly max_concurrency: number;
}

export const AdapterHealth = {
  READY: "READY",
  DEGRADED: "DEGRADED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;
export type AdapterHealth = (typeof AdapterHealth)[keyof typeof AdapterHealth];

export interface HealthReport {
  readonly status: AdapterHealth;
  readonly detail?: string;
  readonly checked_at: number;
}

/**
 * Implemented once per agent. Implementations must be stateless with respect to task
 * state — the control plane is the only owner of state.
 */
export interface AgentAdapter {
  readonly info: AdapterInfo;

  /** Cheap liveness/readiness probe. Must not throw; report UNAVAILABLE instead. */
  health(): Promise<HealthReport>;

  /**
   * Execute one task to completion, failure, or blocked-with-partial-progress.
   *
   * Contract:
   *  - MUST return a `Deliverable` rather than throwing, for expected failures.
   *  - MAY throw `BridgeError` for transport-level faults; the caller treats an
   *    `ADAPTER_FAILURE` as a failed attempt and may retry per `max_attempts`.
   *  - MUST stop promptly when `ctx.signal` aborts and return a PARTIAL deliverable.
   *  - MUST NOT write outside `invocation.spec.scope`.
   *  - MUST be idempotent with respect to `invocation.idempotency_key`.
   */
  invoke(invocation: TaskInvocation, ctx: InvocationContext): Promise<Deliverable>;

  /** Best-effort cancellation of an in-flight invocation. */
  cancel(task_id: TaskId, reason: string): Promise<void>;

  /** Release adapter-side resources (child processes, MCP sessions, sockets). */
  dispose?(): Promise<void>;
}

/** Registry so the control plane can resolve an `AgentId` to its adapter. */
export interface AdapterRegistry {
  register(adapter: AgentAdapter): void;
  get(agent: AgentId): AgentAdapter | undefined;
  list(): readonly AgentAdapter[];
}
