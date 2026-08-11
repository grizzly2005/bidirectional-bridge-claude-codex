import type { AgentId, ArtifactId, EventId, LeaseId, RunId, TaskId } from "./ids.js";
import type { ErrorCode } from "./errors.js";

/* ------------------------------------------------------------------ *
 * Task lifecycle
 * ------------------------------------------------------------------ */

export const TaskState = {
  /** Created, not yet claimed by any agent. */
  PENDING: "PENDING",
  /** Claimed by an owner; not started (dependencies may be unmet). */
  CLAIMED: "CLAIMED",
  /** Owner is actively producing the deliverable. */
  WORKING: "WORKING",
  /** Owner stopped and needs something external (see `blockers`). */
  BLOCKED: "BLOCKED",
  /** Work complete; deterministic verification in progress. */
  VERIFYING: "VERIFYING",
  /** Verified and delivered. Terminal. */
  DONE: "DONE",
  /** Gave up or verification failed unrecoverably. Terminal. */
  FAILED: "FAILED",
  /** Withdrawn before completion. Terminal. */
  CANCELLED: "CANCELLED",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  TaskState.DONE,
  TaskState.FAILED,
  TaskState.CANCELLED,
]);

/**
 * Legal transitions. The control plane is the sole enforcer; adapters must not
 * assume a transition is legal without calling through.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING: [TaskState.CLAIMED, TaskState.CANCELLED],
  CLAIMED: [TaskState.WORKING, TaskState.BLOCKED, TaskState.PENDING, TaskState.CANCELLED],
  WORKING: [TaskState.BLOCKED, TaskState.VERIFYING, TaskState.FAILED, TaskState.CANCELLED],
  BLOCKED: [TaskState.WORKING, TaskState.CLAIMED, TaskState.FAILED, TaskState.CANCELLED],
  // VERIFYING must reach all three deliverable outcomes directly. BLOCKED was missing,
  // which forced adapters that reported a VERIFYING milestone to detour through WORKING
  // before submitting an honest PARTIAL (codex req_codex_partial_from_verifying_001).
  // WORKING stays legal so a failed check can send the task back for rework.
  VERIFYING: [TaskState.DONE, TaskState.BLOCKED, TaskState.WORKING, TaskState.FAILED],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
} as const;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The terminal state each deliverable status resolves to.
 *
 * Single source of truth so the control plane, both adapters, and the docs cannot drift:
 *   COMPLETE -> DONE     (verified and finished)
 *   PARTIAL  -> BLOCKED  (real progress, but someone must act before it can finish)
 *   FAILED   -> FAILED   (gave up)
 */
export const DELIVERABLE_TERMINAL_STATE: Readonly<Record<string, TaskState>> = {
  COMPLETE: TaskState.DONE,
  PARTIAL: TaskState.BLOCKED,
  FAILED: TaskState.FAILED,
} as const;

/* ------------------------------------------------------------------ *
 * Write scopes and leases
 * ------------------------------------------------------------------ */

/**
 * A write scope is a set of path globs, relative to the repository root, that an
 * agent intends to modify. Overlapping live scopes held by different agents are a
 * conflict — this is how we prevent two agents editing the same files.
 */
export interface WriteScope {
  /** Glob patterns, POSIX separators, relative to repo root. e.g. `packages/protocol/**` */
  readonly paths: readonly string[];
  /** Optional human note explaining why this scope is needed. */
  readonly note?: string;
}

export const LeaseState = {
  HELD: "HELD",
  RELEASED: "RELEASED",
  EXPIRED: "EXPIRED",
} as const;
export type LeaseState = (typeof LeaseState)[keyof typeof LeaseState];

export interface Lease {
  readonly lease_id: LeaseId;
  readonly task_id: TaskId;
  readonly holder: AgentId;
  readonly scope: WriteScope;
  readonly state: LeaseState;
  /** Epoch millis. */
  readonly acquired_at: number;
  /** Epoch millis. A lease past this instant is treated as EXPIRED. */
  readonly expires_at: number;
  readonly released_at?: number;
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export const ArtifactKind = {
  FILE: "file",
  DIFF: "diff",
  LOG: "log",
  REPORT: "report",
  TEST_RESULT: "test_result",
  JSON: "json",
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

/**
 * Artifacts are how agents exchange results instead of chat history. The registry
 * stores metadata + either an inline payload (small) or a repo-relative path (large).
 */
export interface Artifact {
  readonly artifact_id: ArtifactId;
  readonly task_id: TaskId;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly media_type: string;
  /** Repo-relative path, when the artifact lives on disk. */
  readonly path?: string;
  /** Inline content for small artifacts. Mutually exclusive with `path`. */
  readonly inline?: string;
  /** sha256 hex of the content, for change detection and dedupe. */
  readonly sha256: string;
  readonly bytes: number;
  readonly produced_by: AgentId;
  readonly created_at: number;
  readonly metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

export const VerificationKind = {
  TEST: "test",
  TYPECHECK: "typecheck",
  BUILD: "build",
  LINT: "lint",
  STATIC_ANALYSIS: "static_analysis",
  BENCHMARK: "benchmark",
  MANUAL: "manual",
} as const;
export type VerificationKind = (typeof VerificationKind)[keyof typeof VerificationKind];

/**
 * Evidence that a check actually ran. `passed` must reflect a real execution;
 * `command` and `exit_code` exist so a supervisor can audit the claim.
 */
export interface VerificationResult {
  readonly kind: VerificationKind;
  readonly command: string;
  readonly passed: boolean;
  readonly exit_code: number | null;
  readonly summary: string;
  readonly duration_ms?: number;
  /** Truncated stdout/stderr tail, or an artifact id holding the full log. */
  readonly output_excerpt?: string;
  readonly log_artifact_id?: ArtifactId;
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/** Finite per-task turn-budget contract for runtimes that expose a turn ceiling. */
export const MIN_TASK_MAX_TURNS = 1;
export const DEFAULT_TASK_MAX_TURNS = 12;
export const MAX_TASK_MAX_TURNS = 64;

export interface TaskSpec {
  /** One sentence: what "done" means. */
  readonly objective: string;
  /** Files/modules the task is allowed to change. */
  readonly scope: WriteScope;
  /** Task ids that must reach DONE before this task may enter WORKING. */
  readonly dependencies: readonly TaskId[];
  /** What the owner must hand back. */
  readonly expected_deliverable: string;
  /** How completion will be checked, deterministically where possible. */
  readonly verification_criteria: readonly string[];
  /** Optional agent hint; the control plane does not route on this in pass 1. */
  readonly preferred_agent?: AgentId;
  /** Wall-clock budget in ms for the owning agent to finish. */
  readonly deadline_ms?: number;
  /** Optional runtime turn ceiling. Runtimes that support it enforce the shared bounds. */
  readonly max_turns?: number;
  readonly priority?: number;
  readonly tags?: readonly string[];
}

export interface Task {
  readonly task_id: TaskId;
  /** Durable correlation id shared by every task in one coordinated run. */
  readonly run_id: RunId;
  /** Immediate lineage parent, or null for a root task. */
  readonly parent_task_id: TaskId | null;
  /** Root tasks are depth 0; every child is exactly parent depth + 1. */
  readonly delegation_depth: number;
  readonly spec: TaskSpec;
  readonly state: TaskState;
  /** null while PENDING. */
  readonly owner: AgentId | null;
  readonly created_by: AgentId;
  readonly created_at: number;
  readonly updated_at: number;
  readonly claimed_at?: number;
  readonly completed_at?: number;
  /** Free-text reasons the task is BLOCKED. Empty when not blocked. */
  readonly blockers: readonly string[];
  /** Monotonic version for optimistic concurrency. */
  readonly version: number;
  /** Number of times this task has been retried after failure. */
  readonly attempt: number;
}

/* ------------------------------------------------------------------ *
 * Attempts and resumable execution handles
 * ------------------------------------------------------------------ */

/**
 * Maximum length of an `execution_handle`.
 *
 * The field exists to hold a *pointer* — a Codex thread id, a Claude session id, a job
 * reference — so a crashed run can be resumed. It is deliberately too small to hold a
 * transcript, which keeps conversation content out of the coordination database by
 * construction rather than by asking agents nicely.
 */
export const EXECUTION_HANDLE_MAX_LENGTH = 512;

/**
 * One attempt at a task. Attempt 0 is the first try; `TaskService.retry` increments.
 *
 * Separate from `Task` because the handle is per-attempt: resuming attempt 2 must not
 * reconnect to the dead session from attempt 1.
 */
export interface TaskAttempt {
  readonly task_id: TaskId;
  readonly attempt: number;
  readonly agent: AgentId;
  /** Prior attempt whose persisted runtime session this attempt resumes, or null. */
  readonly resumed_from_attempt: number | null;
  /**
   * Opaque, agent-defined pointer to resumable execution state.
   *
   * MUST NOT contain secrets (API keys, tokens) or conversation content. Agents choose
   * the format; the control plane never parses it.
   */
  readonly execution_handle: string | null;
  readonly started_at: number;
  readonly updated_at: number;
  readonly ended_at?: number;
  /** Terminal state of this attempt, when it has ended. */
  readonly outcome?: string;
}

/* ------------------------------------------------------------------ *
 * Neutral per-attempt telemetry
 * ------------------------------------------------------------------ */

export const TelemetryCostSemantics = {
  BILLED: "billed",
  RUNTIME_REPORTED: "runtime_reported",
  API_EQUIVALENT_ESTIMATE: "api_equivalent_estimate",
  UNAVAILABLE: "unavailable",
} as const;
export type TelemetryCostSemantics =
  (typeof TelemetryCostSemantics)[keyof typeof TelemetryCostSemantics];

export const AttemptTerminationKind = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  CRASH: "crash",
  UNKNOWN: "unknown",
} as const;
export type AttemptTerminationKind =
  (typeof AttemptTerminationKind)[keyof typeof AttemptTerminationKind];

/**
 * One final, normalized record for one task attempt.
 *
 * Unknown observations are explicit `null`s in the durable record. Identity, lineage,
 * orchestration timestamps, and input-artifact measurements come from the control plane;
 * an adapter can report only the runtime observations represented by
 * `AttemptTelemetryUpdate` below. There is deliberately no prompt text, conversation
 * history, authentication data, or execution-handle field.
 */
export interface AttemptTelemetry {
  readonly run_id: RunId;
  readonly task_id: TaskId;
  readonly attempt: number;
  readonly resumed_from_attempt: number | null;
  readonly agent: AgentId;
  readonly runtime: string | null;
  readonly runtime_version: string | null;
  /** Bridge-selected runtime profile; distinct from the runtime-reported actual model. */
  readonly requested_model: string | null;
  readonly requested_effort: string | null;
  readonly model: string | null;
  readonly parent_task_id: TaskId | null;
  readonly delegation_depth: number;

  readonly orchestration_started_at: number;
  readonly runtime_started_at: number | null;
  readonly first_output_at: number | null;
  readonly runtime_ended_at: number | null;
  readonly completed_at: number;
  readonly wall_duration_ms: number;
  readonly runtime_duration_ms: number | null;

  /** Total normalized input tokens. Cached categories are subdimensions, not additions. */
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
  readonly total_tokens: number | null;
  readonly turn_count: number | null;
  readonly cumulative_session_tokens: number | null;

  readonly reported_cost_usd: number | null;
  readonly cost_semantics: TelemetryCostSemantics;
  readonly billing_mode_known: boolean;

  readonly prompt_bytes: number | null;
  readonly input_artifact_count: number;
  readonly input_artifact_bytes: number;

  readonly termination_kind: AttemptTerminationKind;
  readonly process_exit_code: number | null;
}

/**
 * Runtime observations an adapter may contribute before the control plane seals the final
 * record. Every property is optional because runtimes expose different authoritative data.
 */
export interface AttemptTelemetryUpdate {
  readonly runtime?: string | null;
  readonly runtime_version?: string | null;
  readonly requested_model?: string | null;
  readonly requested_effort?: string | null;
  readonly model?: string | null;
  readonly runtime_started_at?: number | null;
  readonly first_output_at?: number | null;
  readonly runtime_ended_at?: number | null;
  readonly runtime_duration_ms?: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cached_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly total_tokens?: number | null;
  readonly turn_count?: number | null;
  readonly cumulative_session_tokens?: number | null;
  readonly reported_cost_usd?: number | null;
  readonly cost_semantics?: TelemetryCostSemantics;
  readonly billing_mode_known?: boolean;
  readonly prompt_bytes?: number | null;
  readonly termination_kind?: AttemptTerminationKind;
  readonly process_exit_code?: number | null;
}

/* ------------------------------------------------------------------ *
 * Progress + deliverable envelopes (the supervisor-visible surface)
 * ------------------------------------------------------------------ */

export interface StatusUpdate {
  readonly task_id: TaskId;
  readonly agent: AgentId;
  readonly state: TaskState;
  readonly current_action: string;
  readonly owned_scope: readonly string[];
  /** 0..1, or null when not meaningfully measurable. */
  readonly progress: number | null;
  readonly artifacts: readonly ArtifactId[];
  readonly blockers: readonly string[];
  readonly next_action: string;
  readonly at: number;
}

export const DeliverableStatus = {
  COMPLETE: "COMPLETE",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
} as const;
export type DeliverableStatus = (typeof DeliverableStatus)[keyof typeof DeliverableStatus];

export interface Deliverable {
  readonly task_id: TaskId;
  readonly agent: AgentId;
  readonly status: DeliverableStatus;
  readonly summary: string;
  readonly changed_scope: readonly string[];
  readonly artifacts: readonly ArtifactId[];
  readonly commit_or_diff: string | null;
  readonly verification_performed: readonly string[];
  readonly verification_results: readonly VerificationResult[];
  readonly remaining_risks: readonly string[];
  readonly dependencies_unblocked: readonly TaskId[];
  readonly recommended_next_action: string;
  readonly at: number;
}

/* ------------------------------------------------------------------ *
 * Event log
 * ------------------------------------------------------------------ */

export const EventType = {
  TASK_CREATED: "task.created",
  TASK_CLAIMED: "task.claimed",
  TASK_STATE_CHANGED: "task.state_changed",
  TASK_RELEASED: "task.released",
  TASK_BLOCKED: "task.blocked",
  TASK_UNBLOCKED: "task.unblocked",
  TASK_DEPENDENCY_ADDED: "task.dependency_added",
  LEASE_ACQUIRED: "lease.acquired",
  LEASE_RELEASED: "lease.released",
  LEASE_EXPIRED: "lease.expired",
  LEASE_DENIED: "lease.denied",
  ATTEMPT_STARTED: "attempt.started",
  ATTEMPT_HANDLE_SET: "attempt.handle_set",
  ATTEMPT_ENDED: "attempt.ended",
  ATTEMPT_TELEMETRY_RECORDED: "attempt.telemetry_recorded",
  RECOVERY_REQUESTED: "recovery.requested",
  RESUME_ATTEMPTED: "resume.attempted",
  RESUME_SUCCEEDED: "resume.succeeded",
  RESUME_FAILED: "resume.failed",
  ARTIFACT_PUBLISHED: "artifact.published",
  STATUS_REPORTED: "status.reported",
  DELIVERABLE_SUBMITTED: "deliverable.submitted",
  VERIFICATION_RECORDED: "verification.recorded",
  DELEGATION_REQUESTED: "delegation.requested",
  DELEGATION_COMPLETED: "delegation.completed",
  DELEGATION_FAILED: "delegation.failed",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Append-only. Never updated or deleted. The full state is reconstructible from
 * this log, which is what makes crash recovery and external supervision possible.
 */
export interface BridgeEvent<P = Record<string, unknown>> {
  readonly event_id: EventId;
  readonly type: EventType;
  readonly task_id: TaskId | null;
  readonly agent: AgentId;
  readonly at: number;
  readonly payload: P;
  /** Set when the event was produced by an idempotent operation. */
  readonly idempotency_key?: string;
}

/* ------------------------------------------------------------------ *
 * Delegation (agent -> agent, bounded)
 * ------------------------------------------------------------------ */

export interface DelegationRequest {
  readonly from: AgentId;
  readonly to: AgentId;
  /** Omit for a new root run; inherited and validated when parent_task_id is present. */
  readonly run_id?: RunId;
  readonly parent_task_id?: TaskId | null;
  readonly delegation_depth?: number;
  readonly spec: TaskSpec;
  /** Artifacts the delegate needs; explicitly NOT chat history. */
  readonly input_artifacts: readonly ArtifactId[];
  /** Hard stop for the delegate. Prevents open-ended agent loops. */
  readonly deadline_ms: number;
  /** Max automatic retries by the caller. Defaults to 0. */
  readonly max_attempts?: number;
  readonly idempotency_key?: string;
}

export interface DelegationOutcome {
  readonly task_id: TaskId;
  readonly delegate: AgentId;
  readonly deliverable: Deliverable | null;
  readonly error: { code: string; message: string } | null;
  readonly attempts: number;
  readonly duration_ms: number;
}

/** Internal request derived from a caller-bound MCP session. */
export interface ResumeTaskRequest {
  readonly task_id: TaskId;
  readonly requested_by: AgentId;
  readonly idempotency_key?: string;
}

/** Result of resuming one existing task without changing its identity or lineage. */
export interface ResumeTaskOutcome {
  readonly task_id: TaskId;
  readonly run_id: RunId;
  readonly parent_task_id: TaskId | null;
  readonly delegation_depth: number;
  readonly owner: AgentId;
  readonly previous_attempt: number;
  readonly recovered_attempt: number;
  readonly resumed_from_attempt: number;
  readonly same_execution_handle: boolean;
  readonly fresh_lease_id: LeaseId;
  readonly lease_state: LeaseState;
  readonly state: TaskState;
  readonly deliverable: Deliverable | null;
  readonly telemetry: AttemptTelemetry | null;
  readonly error: { readonly code: ErrorCode; readonly message: string } | null;
}
