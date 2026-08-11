/**
 * Attempt records and resumable execution handles.
 *
 * Why this exists: when an adapter dies mid-task the control plane knows the task failed
 * but not *where* the work was. An `execution_handle` — a Codex thread id, a Claude
 * session id, a queued job reference — lets the next attempt reconnect instead of redoing
 * everything from cold. It is agent-neutral: the control plane stores an opaque string and
 * never parses it.
 *
 * What it must never become: a place to stash conversation history or credentials. The
 * coordination database is shared between both agents and readable by any supervisor, so
 * the guard below is enforced rather than documented.
 */

import {
  BridgeError,
  AttemptTelemetrySchema,
  AttemptTerminationKind,
  EXECUTION_HANDLE_MAX_LENGTH,
  ErrorCode,
  EventType,
  ExecutionHandleSchema,
  TelemetryCostSemantics,
  assertValid,
  type AgentId,
  type AttemptTelemetry,
  type AttemptTelemetryUpdate,
  type TaskAttempt,
  type TaskId,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { AttemptTelemetryQuery, StateStore } from "./store/state-store.js";

/**
 * Patterns that indicate a caller is about to persist a credential rather than a pointer.
 *
 * Not a security boundary — an agent determined to leak a secret can encode around this.
 * It is a guardrail against the realistic failure: an adapter author passing the whole
 * session object, or a bearer token, because the field was conveniently to hand.
 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "Anthropic-style key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface NormalizeAttemptTelemetryInput {
  readonly task_id: TaskId;
  readonly run_id: string;
  readonly parent_task_id: TaskId | null;
  readonly delegation_depth: number;
  readonly attempt: number;
  readonly resumed_from_attempt?: number | null;
  readonly agent: AgentId;
  readonly orchestration_started_at: number;
  readonly observed_runtime_started_at: number | null;
  readonly observed_runtime_ended_at: number | null;
  readonly completed_at: number;
  readonly input_artifact_count: number;
  readonly input_artifact_bytes: number;
  readonly termination_kind: AttemptTelemetry["termination_kind"];
  readonly update: AttemptTelemetryUpdate;
}

/**
 * Seal an adapter's sparse observations into the complete, runtime-neutral durable shape.
 * Unknown keys cannot cross this explicit projection, which is also why a buggy adapter
 * cannot smuggle a prompt or raw execution handle into benchmark telemetry.
 */
export function normalizeAttemptTelemetry(
  input: NormalizeAttemptTelemetryInput,
): AttemptTelemetry {
  const update = input.update;
  const inputTokens = update.input_tokens ?? null;
  const outputTokens = update.output_tokens ?? null;
  const totalTokens =
    update.total_tokens ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const reportedCost = update.reported_cost_usd ?? null;

  return {
    run_id: input.run_id,
    task_id: input.task_id,
    attempt: input.attempt,
    resumed_from_attempt: input.resumed_from_attempt ?? null,
    agent: input.agent,
    runtime: update.runtime ?? null,
    runtime_version: update.runtime_version ?? null,
    requested_model: update.requested_model ?? null,
    requested_effort: update.requested_effort ?? null,
    model: update.model ?? null,
    parent_task_id: input.parent_task_id,
    delegation_depth: input.delegation_depth,
    orchestration_started_at: input.orchestration_started_at,
    runtime_started_at: update.runtime_started_at ?? input.observed_runtime_started_at,
    first_output_at: update.first_output_at ?? null,
    runtime_ended_at: update.runtime_ended_at ?? input.observed_runtime_ended_at,
    completed_at: input.completed_at,
    wall_duration_ms: Math.max(0, input.completed_at - input.orchestration_started_at),
    runtime_duration_ms: update.runtime_duration_ms ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: update.cached_input_tokens ?? null,
    cache_creation_input_tokens: update.cache_creation_input_tokens ?? null,
    total_tokens: totalTokens,
    turn_count: update.turn_count ?? null,
    cumulative_session_tokens: update.cumulative_session_tokens ?? null,
    reported_cost_usd: reportedCost,
    cost_semantics:
      update.cost_semantics ??
      (reportedCost === null
        ? TelemetryCostSemantics.UNAVAILABLE
        : TelemetryCostSemantics.RUNTIME_REPORTED),
    billing_mode_known: update.billing_mode_known ?? false,
    prompt_bytes: update.prompt_bytes ?? null,
    input_artifact_count: input.input_artifact_count,
    input_artifact_bytes: input.input_artifact_bytes,
    termination_kind:
      input.termination_kind === AttemptTerminationKind.UNKNOWN
        ? (update.termination_kind ?? AttemptTerminationKind.UNKNOWN)
        : input.termination_kind,
    process_exit_code: update.process_exit_code ?? null,
  };
}

export class AttemptService {
  constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
  ) {}

  /** Open (or re-open) the record for an attempt. Idempotent. */
  start(task_id: TaskId, attempt: number, agent: AgentId): TaskAttempt {
    return this.store.transaction(() => {
      const existing = this.store.getAttempt(task_id, attempt);
      const now = this.clock.now();
      const record: TaskAttempt = existing
        ? { ...existing, agent, updated_at: now }
        : {
            task_id,
            attempt,
            agent,
            resumed_from_attempt: null,
            execution_handle: null,
            started_at: now,
            updated_at: now,
          };
      this.store.upsertAttempt(record);
      if (!existing) {
        this.store.appendEvent(
          {
            type: EventType.ATTEMPT_STARTED,
            task_id,
            agent,
            payload: { attempt },
          },
          now,
        );
      }
      return record;
    });
  }

  /** Create a distinct attempt that is anchored to one persisted prior session handle. */
  startResumed(
    task_id: TaskId,
    attempt: number,
    agent: AgentId,
    resumed_from_attempt: number,
    execution_handle: string,
  ): TaskAttempt {
    this.assertSafeHandle(execution_handle);
    if (!Number.isInteger(attempt) || !Number.isInteger(resumed_from_attempt)) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "attempt numbers must be integers");
    }
    if (resumed_from_attempt < 0 || attempt !== resumed_from_attempt + 1) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `resumed attempt ${attempt} must immediately follow attempt ${resumed_from_attempt}`,
        { attempt, resumed_from_attempt },
      );
    }

    return this.store.transaction(() => {
      if (this.store.getAttempt(task_id, attempt) !== undefined) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `attempt ${attempt} already exists for ${task_id}`,
          { task_id, attempt },
        );
      }
      const previous = this.store.getAttempt(task_id, resumed_from_attempt);
      if (previous?.execution_handle !== execution_handle || previous.agent !== agent) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `attempt ${resumed_from_attempt} has no matching resumable handle for ${agent}`,
          { task_id, resumed_from_attempt, agent },
        );
      }

      const now = this.clock.now();
      const record: TaskAttempt = {
        task_id,
        attempt,
        agent,
        resumed_from_attempt,
        execution_handle,
        started_at: now,
        updated_at: now,
      };
      this.store.upsertAttempt(record);
      this.store.appendEvent(
        {
          type: EventType.ATTEMPT_STARTED,
          task_id,
          agent,
          payload: { attempt, resumed_from_attempt, resumed_handle_present: true },
        },
        now,
      );
      return record;
    });
  }

  /**
   * Persist the resumable pointer for an attempt.
   *
   * The event log records only that a handle was set and its length — never the handle
   * itself. The value lives in exactly one place, so a supervisor tailing events cannot
   * accidentally scrape a fleet of session ids out of the stream.
   */
  saveHandle(task_id: TaskId, attempt: number, agent: AgentId, handle: string): TaskAttempt {
    this.assertSafeHandle(handle);

    return this.store.transaction(() => {
      const now = this.clock.now();
      const existing = this.store.getAttempt(task_id, attempt);
      const record: TaskAttempt = existing
        ? { ...existing, agent, execution_handle: handle, updated_at: now }
        : {
            task_id,
            attempt,
            agent,
            resumed_from_attempt: null,
            execution_handle: handle,
            started_at: now,
            updated_at: now,
          };
      this.store.upsertAttempt(record);
      this.store.appendEvent(
        {
          type: EventType.ATTEMPT_HANDLE_SET,
          task_id,
          agent,
          payload: { attempt, handle_length: handle.length },
        },
        now,
      );
      return record;
    });
  }

  /** Close an attempt with its outcome, so a later reader can tell live from finished. */
  end(task_id: TaskId, attempt: number, agent: AgentId, outcome: string): TaskAttempt | undefined {
    return this.store.transaction(() => {
      const existing = this.store.getAttempt(task_id, attempt);
      if (!existing) return undefined;
      const now = this.clock.now();
      const record: TaskAttempt = { ...existing, updated_at: now, ended_at: now, outcome };
      this.store.upsertAttempt(record);
      this.store.appendEvent(
        { type: EventType.ATTEMPT_ENDED, task_id, agent, payload: { attempt, outcome } },
        now,
      );
      return record;
    });
  }

  get(task_id: TaskId, attempt: number): TaskAttempt | undefined {
    return this.store.getAttempt(task_id, attempt);
  }

  list(task_id: TaskId): TaskAttempt[] {
    return this.store.listAttempts(task_id);
  }

  /** Persist the single final telemetry record for an attempt and emit its audit event. */
  recordTelemetry(telemetry: AttemptTelemetry): AttemptTelemetry {
    assertValid<AttemptTelemetry>(telemetry, AttemptTelemetrySchema, "AttemptTelemetry");
    this.assertSafeTelemetry(telemetry);

    return this.store.transaction(() => {
      const task = this.store.getTask(telemetry.task_id);
      if (task === undefined) {
        throw new BridgeError(ErrorCode.NOT_FOUND, `no such task ${telemetry.task_id}`);
      }
      const attempt = this.store.getAttempt(telemetry.task_id, telemetry.attempt);
      if (attempt === undefined) {
        throw new BridgeError(
          ErrorCode.NOT_FOUND,
          `attempt ${telemetry.attempt} does not exist for ${telemetry.task_id}`,
        );
      }
      if (
        task.run_id !== telemetry.run_id ||
        task.parent_task_id !== telemetry.parent_task_id ||
        task.delegation_depth !== telemetry.delegation_depth ||
        attempt.agent !== telemetry.agent
      ) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          "telemetry identity or lineage does not match control-plane state",
          { task_id: telemetry.task_id, attempt: telemetry.attempt },
        );
      }
      if (
        this.store.listAttemptTelemetry({
          task_id: telemetry.task_id,
          attempt: telemetry.attempt,
          limit: 1,
        }).length > 0
      ) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `final telemetry already exists for ${telemetry.task_id} attempt ${telemetry.attempt}`,
        );
      }
      this.store.insertAttemptTelemetry(telemetry);
      this.store.appendEvent(
        {
          type: EventType.ATTEMPT_TELEMETRY_RECORDED,
          task_id: telemetry.task_id,
          agent: telemetry.agent,
          payload: {
            run_id: telemetry.run_id,
            attempt: telemetry.attempt,
            termination_kind: telemetry.termination_kind,
            numeric_tokens:
              telemetry.input_tokens !== null &&
              telemetry.output_tokens !== null &&
              telemetry.total_tokens !== null,
          },
        },
        telemetry.completed_at,
      );
      return telemetry;
    });
  }

  queryTelemetry(query: AttemptTelemetryQuery = {}): AttemptTelemetry[] {
    return this.store.listAttemptTelemetry(query);
  }

  /**
   * The most recent non-null handle before `attempt`, for resuming after a crash.
   * Searches backwards so attempt N resumes from N-1 rather than from the first try.
   */
  previousHandle(task_id: TaskId, attempt: number): string | null {
    const earlier = this.store
      .listAttempts(task_id)
      .filter((a) => a.attempt < attempt && a.execution_handle)
      .sort((a, b) => b.attempt - a.attempt);
    return earlier[0]?.execution_handle ?? null;
  }

  private assertSafeHandle(handle: string): void {
    if (typeof handle !== "string" || handle.length === 0) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "execution_handle must be a non-empty string");
    }
    if (handle.length > EXECUTION_HANDLE_MAX_LENGTH) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `execution_handle is ${handle.length} characters, over the ${EXECUTION_HANDLE_MAX_LENGTH} limit. ` +
          `It is a pointer to resumable state, not a place to store a transcript.`,
        { length: handle.length, limit: EXECUTION_HANDLE_MAX_LENGTH },
      );
    }
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(handle)) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `execution_handle looks like it contains a credential (${label}). Store a session ` +
            `or thread identifier instead; the coordination database is shared with the other agent.`,
          { detected: label },
        );
      }
    }
    // Schema check last: it enforces the printable-ASCII single-line shape, which also
    // rejects multi-line pastes that slipped past the length cap.
    assertValid<string>(handle, ExecutionHandleSchema, "ExecutionHandle");
  }

  private assertSafeTelemetry(telemetry: AttemptTelemetry): void {
    for (const [field, value] of [
      ["runtime", telemetry.runtime],
      ["runtime_version", telemetry.runtime_version],
      ["requested_model", telemetry.requested_model],
      ["requested_effort", telemetry.requested_effort],
      ["model", telemetry.model],
    ] as const) {
      if (value === null) continue;
      for (const { label, re } of SECRET_PATTERNS) {
        if (re.test(value)) {
          throw new BridgeError(
            ErrorCode.INVALID_ARGUMENT,
            `telemetry ${field} looks like it contains a credential (${label})`,
            { field, detected: label },
          );
        }
      }
    }
  }
}
