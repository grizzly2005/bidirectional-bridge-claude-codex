/**
 * Bounded delegation.
 *
 * Turns "claude asks codex to do X" into a supervised, terminating, auditable run:
 * create task -> claim on the delegate's behalf -> acquire the write lease -> invoke the
 * adapter under a deadline -> collect the deliverable -> release the lease.
 *
 * Every exit path releases the lease, including timeout and adapter crash. A lease left
 * behind would block the other agent from ever touching that scope again until expiry.
 */

import {
  BridgeError,
  AttemptTerminationKind,
  DeliverableStatus,
  ErrorCode,
  EventType,
  TaskState,
  conflictingPairs,
  type AgentId,
  type ArtifactId,
  type AttemptTelemetry,
  type AttemptTelemetryUpdate,
  type Deliverable,
  type DelegationOutcome,
  type DelegationRequest,
  type InvocationContext,
  type ResumeDelegatedTaskRequest,
  type ResumeTaskOutcome,
  type ResumeTaskRequest,
  type StatusUpdate,
  type Task,
  type TaskInvocation,
  type VerificationResult,
} from "@bridge/protocol";
import type { ControlPlane } from "./control-plane.js";
import { normalizeAttemptTelemetry } from "./attempt-service.js";
import { hashRequest } from "./idempotency.js";
import { DelegationOperations } from "./delegation-operation.js";
import type { DelegationOperation, ExecutionRecord } from "./store/state-store.js";

export interface DelegateOptions {
  /** Extra time beyond `deadline_ms` before the lease lapses; default 30s. */
  readonly leaseGraceMs?: number;
  readonly onEvent?: (type: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_LEASE_GRACE_MS = 30_000;
const DEFAULT_RECOVERY_DEADLINE_MS = 600_000;
const RECOVERY_IDEMPOTENCY_OPERATION = "task.resume";
const DELEGATED_RECOVERY_IDEMPOTENCY_OPERATION = "task.resume.delegated";
const RESUME_CAPABILITY = "resume";

type RecoveryAuthorizationKind = "owner" | "delegated_manager";

interface RecoveryRequest {
  readonly task_id: string;
  readonly requested_by: AgentId;
  readonly idempotency_key?: string;
}

interface RecoveryAuthorization {
  readonly kind: RecoveryAuthorizationKind;
  readonly requested_by: AgentId;
  readonly execution_agent: AgentId;
}

interface RecoveryReservation {
  readonly task_id: string;
  readonly authorization_kind: RecoveryAuthorizationKind;
  readonly requested_by: AgentId;
  readonly execution_agent: AgentId;
  readonly previous_attempt: number;
  readonly recovered_attempt: number;
  readonly resumed_from_attempt: number;
  readonly fresh_lease_id: string;
  readonly input_artifact_ids: readonly string[];
  readonly requested_at: number;
  readonly deadline_ms: number;
  readonly outcome?: ResumeTaskOutcome;
  readonly phase?: "PREPARING" | "AUTHORIZED" | "FINISHED";
  readonly prelaunch_error?: { readonly code: ErrorCode; readonly message: string };
  readonly execution_generation?: string;
  readonly operation_key?: string;
}

interface ActiveRecovery {
  readonly idempotency_key?: string;
  readonly authorization_key: string;
  readonly promise: Promise<ResumeTaskOutcome>;
}

export class Orchestrator {
  private readonly activeRecoveries = new Map<string, ActiveRecovery>();
  private readonly activeDelegations = new Map<string, Promise<DelegationOutcome>>();
  private readonly operations: DelegationOperations;

  constructor(private readonly cp: ControlPlane) { this.operations = new DelegationOperations(cp); }

  /**
   * Delegate one bounded task and wait for its outcome.
   *
   * Never loops back to the delegate for clarification — a delegation is one request and
   * one answer. If the delegate needs something it cannot get, it returns PARTIAL with a
   * blocker and the caller decides what to do, which keeps agent-to-agent traffic finite.
   */
  async delegate(request: DelegationRequest, options: DelegateOptions = {}): Promise<DelegationOutcome> {
    if (request.total_deadline_ms !== undefined && (
      !Number.isInteger(request.total_deadline_ms) || request.total_deadline_ms < 1_000
      || request.total_deadline_ms > 86_400_000
    )) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "total_deadline_ms must be between 1000 and 86400000");
    }
    if (request.parent_task_id !== undefined && request.parent_task_id !== null) {
      this.cp.tasks.assertDelegationTargetNotInAncestors(request.parent_task_id, request.to);
    }
    const adapter = this.cp.adapters.get(request.to);
    if (!adapter) {
      throw new BridgeError(ErrorCode.NOT_FOUND, `no adapter registered for agent '${request.to}'`, {
        to: request.to,
        available: this.cp.adapters.list().map((a) => a.info.agent),
      });
    }

    const { operation, owned } = this.operations.reserve(request);
    if (operation.outcome) return operation.outcome;
    const existing = this.activeDelegations.get(operation.task_id);
    if (existing) return existing;
    if (!owned) return this.operations.wait(operation);
    const promise = this.delegateOnce(operation, options);
    this.activeDelegations.set(operation.task_id, promise);
    try { return await promise; }
    finally { this.activeDelegations.delete(operation.task_id); }
  }

  private async delegateOnce(operation: DelegationOperation, options: DelegateOptions): Promise<DelegationOutcome> {
    const request = operation.request;
    const started = operation.started_at;
    const task = this.cp.tasks.get(operation.task_id);
    const maxAttempts = (request.max_attempts ?? 0) + 1;

    let lastError: BridgeError | null = null;
    // Attempts actually made, which is not the same as the budget: a non-retryable
    // failure stops after one. Reporting the budget instead would tell a supervisor the
    // system retried when it did not.
    let attemptsMade = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attemptsMade = attempt + 1;
      try {
        const deliverable = await this.runAttempt(task, request, attempt, started, options, operation);
        return this.operations.finish(operation, {
          task_id: task.task_id,
          delegate: request.to,
          deliverable,
          error: null,
          attempts: attempt + 1,
          duration_ms: this.cp.clock.now() - started,
          observation: this.cp.attempts.observation(task.task_id, attempt),
        });
      } catch (err) {
        lastError = BridgeError.from(err);
        // Contention happens before an attempt record or runtime exists. Escalate the
        // existing task instead of resetting it through an illegal CLAIMED -> FAILED edge.
        if (this.cp.attempts.get(task.task_id, attempt) === undefined) attemptsMade = attempt;
        options.onEvent?.("attempt_failed", {
          task_id: task.task_id,
          attempt,
          code: lastError.code,
          message: lastError.message,
        });

        const runtimeFailure = this.cp.attempts.queryTelemetry({ task_id: task.task_id, attempt, limit: 1 })[0]?.runtime_failure
          ?? lastError.details["runtime_failure"] as AttemptTelemetry["runtime_failure"];
        const canRetry = lastError.code !== ErrorCode.SCOPE_CONFLICT
          && attempt + 1 < maxAttempts && lastError.retryable
          && this.cp.store.getExecution(task.task_id)?.runtime_stop_confirmed === true
          && !["quota", "auth", "profile", "contract", "turn_limit"].includes(
            runtimeFailure?.category ?? "unknown")
          && (runtimeFailure?.retry_after_at == null || runtimeFailure.retry_after_at <= this.cp.clock.now())
          && this.remainingDeadline(task, request.deadline_ms) > 0;
        if (!canRetry) break;

        // Reset for another go. A non-FAILED task (e.g. left BLOCKED) is failed first so
        // `retry` has a legal predecessor state.
        const current = this.cp.tasks.get(task.task_id);
        if (current.state !== TaskState.FAILED && current.owner === request.to) {
          try {
            this.cp.tasks.transition({
              task_id: task.task_id,
              agent: request.to,
              to: TaskState.FAILED,
              reason: `attempt ${attempt} failed: ${lastError.code}`,
            });
          } catch {
            /* already terminal; retry below will surface the real problem */
          }
        }
        this.cp.tasks.retry(task.task_id, request.from, maxAttempts);
      }
    }

    const err = lastError ?? new BridgeError(ErrorCode.INTERNAL, "delegation failed with no error recorded");
    this.cp.store.appendEvent(
      {
        type: EventType.DELEGATION_FAILED,
        task_id: task.task_id,
        agent: request.to,
        payload: {
          code: err.code,
          message: err.message,
          attempts: attemptsMade,
          budget: maxAttempts,
          retryable: err.retryable,
        },
      },
      this.cp.clock.now(),
    );
    return this.operations.finish(operation, {
      task_id: task.task_id,
      delegate: request.to,
      deliverable: this.cp.deliverables.get(task.task_id) ?? null,
      error: { code: err.code, message: err.message },
      attempts: attemptsMade,
      duration_ms: this.cp.clock.now() - started,
      ...(this.cp.attempts.get(task.task_id, this.cp.tasks.get(task.task_id).attempt)
        ? { observation: this.cp.attempts.observation(task.task_id, this.cp.tasks.get(task.task_id).attempt) } : {}),
    });
  }

  private async runAttempt(
    task: Task, request: DelegationRequest, attempt: number, orchestrationStartedAt: number,
    options: DelegateOptions, operation: DelegationOperation,
  ): Promise<Deliverable> {
    const adapter = this.cp.adapters.get(request.to)!;
    const deadlineMs = this.remainingDeadline(task, request.deadline_ms);
    if (deadlineMs <= 0) throw new BridgeError(ErrorCode.TIMEOUT, "Total delegation deadline exhausted before preparation");
    const deadlineAt = this.cp.clock.now() + deadlineMs;
    // Inputs, dependencies and admission must succeed before opening a runtime attempt.
    const inputs = this.cp.artifacts.resolveForInvocation(request.input_artifacts);
    const execution = this.cp.store.transaction(() => {
      this.cp.tasks.claim(task.task_id, request.to);
      return this.cp.executions.queue(task.task_id, attempt, request.to, adapter.info.max_concurrency);
    });
    let prepared: ExecutionRecord;
    try {
      await this.awaitAdmission(execution, deadlineAt);
      prepared = this.cp.store.transaction(() => {
        const current = this.cp.executions.assertGeneration(execution);
        if (current.cancel_requested_at !== null) throw new BridgeError(ErrorCode.TASK_CANCELLED, "Cancelled before launch");
        const lease = this.cp.leases.acquire({ task_id: task.task_id, holder: request.to,
          scope: request.spec.scope, ttl_ms: Math.max(1, deadlineAt - this.cp.clock.now()) + (options.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS) });
        this.cp.tasks.transition({ task_id: task.task_id, agent: request.to, to: TaskState.WORKING });
        this.cp.attempts.start(task.task_id, attempt, request.to);
        const launched = this.cp.executions.update(execution, { lease_id: lease.lease_id, runtime_stop_confirmed: false });
        this.operations.authorize(operation);
        return launched;
      });
    } catch (error) {
      this.cp.executions.update(execution, { phase: "STOPPED", runtime_stop_confirmed: true });
      const failure = BridgeError.from(error);
      if (failure.code === ErrorCode.SCOPE_CONFLICT) this.cp.tasks.block(task.task_id, request.to, `SCOPE_CONFLICT: ${failure.message}`.slice(0, 500));
      throw failure;
    }
    const invocation: TaskInvocation = { task_id: task.task_id, run_id: task.run_id,
      parent_task_id: task.parent_task_id, delegation_depth: task.delegation_depth,
      spec: request.spec, inputs, workspace_root: this.cp.workspaceRoot, lease_id: prepared.lease_id!,
      deadline_at: deadlineAt, attempt, idempotency_key: `${operation.key}:${attempt}`,
      previous_execution_handle: this.cp.attempts.previousHandle(task.task_id, attempt) };
    const result = await this.performInvocation(invocation, prepared, orchestrationStartedAt, undefined,
      (deliverable, observation) => {
        this.cp.store.appendEvent({ type: EventType.DELEGATION_COMPLETED, task_id: task.task_id, agent: request.to,
          payload: { status: deliverable.status, attempt, artifacts: deliverable.artifacts } }, this.cp.clock.now());
        this.operations.finish(operation, { task_id: task.task_id, delegate: request.to, deliverable,
          error: observation.accepted ? null : { code: ErrorCode.TELEMETRY_INCOMPLETE, message: "Strict observation requirements are incomplete" },
          attempts: attempt + 1, duration_ms: Math.max(0, this.cp.clock.now() - orchestrationStartedAt), observation });
      });
    if (result.error) throw result.error;
    return result.deliverable!;
  }

  private async awaitAdmission(record: ExecutionRecord, deadlineAt: number): Promise<void> {
    const realDeadline = Date.now() + Math.max(0, deadlineAt - this.cp.clock.now());
    while (true) {
      const current = this.cp.executions.assertGeneration(record);
      if (current.cancel_requested_at !== null) {
        this.cp.executions.update(record, { phase: "STOPPED", runtime_stop_confirmed: true });
        const task = this.cp.tasks.get(record.task_id);
        if (!isTerminal(task.state)) this.cp.tasks.transition({ task_id: task.task_id, agent: record.agent, to: TaskState.CANCELLED, reason: "cancelled in admission queue" });
        throw new BridgeError(ErrorCode.TASK_CANCELLED, "Cancelled in admission queue", { runtime_stop_confirmed: true });
      }
      if (this.cp.clock.now() >= deadlineAt || Date.now() >= realDeadline) {
        this.cp.executions.update(record, { phase: "STOPPED", runtime_stop_confirmed: true });
        throw new BridgeError(ErrorCode.TIMEOUT, "Deadline exhausted waiting for shared admission", { runtime_stop_confirmed: true });
      }
      if (current.phase === "RUNNING" || this.cp.executions.tryAdmit(record)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  private async performInvocation(
    invocation: TaskInvocation, execution: ExecutionRecord, startedAt: number,
    requireHandle?: string,
    onSuccess?: (deliverable: Deliverable, observation: import("@bridge/protocol").ObservationStatus) => void,
    onEnded?: (error: BridgeError | null, deliverable: Deliverable | null) => void,
    onFinalized?: (result: { deliverable: Deliverable | null; error: BridgeError | null; sameHandle: boolean; telemetry: AttemptTelemetry | null },
      observation: import("@bridge/protocol").ObservationStatus) => void,
  ): Promise<{ deliverable: Deliverable | null; error: BridgeError | null; telemetry: AttemptTelemetry | null; sameHandle: boolean }> {
    const task = this.cp.tasks.get(invocation.task_id);
    const adapter = this.cp.adapters.get(execution.agent)!;
    const controller = new AbortController();
    const update: AttemptTelemetryUpdate = {};
    let reportedHandle: string | null = null;
    const context = this.makeContext(task.task_id, execution.agent, controller.signal, execution.attempt, update,
      handle => {
        if (requireHandle !== undefined && handle !== requireHandle) throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Strict resume changed the persisted execution handle");
        reportedHandle = handle;
      }, execution);
    const runtimeStartedAt = this.cp.clock.now();
    let runtimeEndedAt: number | null = null;
    let error: BridgeError | null = null;
    let returned: Deliverable | null = null;
    let timedOut = false;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop!: (error: BridgeError) => void;
    const stopBound = new Promise<never>((_, reject) => { rejectStop = reject; });
    const onAbort = (): void => {
      void adapter.cancel(task.task_id, timedOut ? "deadline" : "cancellation").catch(() => undefined);
      stopTimer = setTimeout(() => rejectStop(new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED,
        "Runtime did not confirm its stop within the bounded grace period", { runtime_stop_confirmed: false })), 5000);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, invocation.deadline_at - this.cp.clock.now()));
    const cancellation = setInterval(() => {
      const current = this.cp.store.getExecution(task.task_id);
      if (current?.generation === execution.generation && current.cancel_requested_at !== null) controller.abort();
    }, 25);
    try {
      const runtime = adapter.invoke(invocation, context);
      void runtime.then(() => { settled = true; }, () => { settled = true; });
      returned = await Promise.race([runtime, stopBound]);
      runtimeEndedAt = this.cp.clock.now();
      if (requireHandle !== undefined && reportedHandle !== requireHandle) throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Strict resume did not confirm its persisted handle");
      if (returned.task_id !== task.task_id || returned.agent !== execution.agent) throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Deliverable identity differs from the reserved task");
      if (controller.signal.aborted || this.cp.clock.now() >= invocation.deadline_at) throw new BridgeError(
        timedOut || this.cp.clock.now() >= invocation.deadline_at ? ErrorCode.TIMEOUT : ErrorCode.TASK_CANCELLED, "Invocation stopped after deadline or cancellation",
        { runtime_stop_confirmed: this.cp.executions.assertGeneration(execution).runtime_stop_confirmed === true
          || !adapter.info.capabilities.includes("stop-confirmation") });
    } catch (caught) {
      error = BridgeError.from(caught);
      if (error.code === ErrorCode.TASK_CANCELLED && this.cp.clock.now() >= invocation.deadline_at) {
        error = new BridgeError(ErrorCode.TIMEOUT, "Invocation deadline elapsed", { ...error.details });
      }
      returned = null;
      runtimeEndedAt = settled ? this.cp.clock.now() : null;
    } finally {
      clearTimeout(timer); clearInterval(cancellation);
      if (stopTimer) clearTimeout(stopTimer);
      controller.signal.removeEventListener("abort", onAbort);
    }
    const current = this.cp.executions.assertGeneration(execution);
    // Legacy in-process adapters promise that settle is terminal. Native adapters advertise
    // stop-confirmation and must supply positive lifecycle evidence instead.
    const stopped = error?.details?.["runtime_stop_confirmed"] === false ? false
      : current.runtime_stop_confirmed === true || error?.details?.["runtime_stop_confirmed"] === true
        || (settled && !adapter.info.capabilities.includes("stop-confirmation"));
    this.cp.executions.update(execution, { runtime_stop_confirmed: stopped,
      phase: stopped ? "RUNNING" : "QUARANTINED" });
    if (!stopped) {
      error = new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED, "Remote stop evidence is missing; scope retained in quarantine", { runtime_stop_confirmed: false });
      returned = null;
    }
    const cancelled = this.cp.executions.assertGeneration(execution).cancel_requested_at !== null;
    const termination = error ? (cancelled ? AttemptTerminationKind.CANCELLED
      : timedOut || error.code === ErrorCode.TIMEOUT ? AttemptTerminationKind.TIMEOUT
      : error.code === ErrorCode.ADAPTER_FAILURE ? AttemptTerminationKind.CRASH : AttemptTerminationKind.FAILED)
      : update.process_exit_code != null && update.process_exit_code !== 0 ? AttemptTerminationKind.FAILED : AttemptTerminationKind.COMPLETED;
    let telemetry = normalizeAttemptTelemetry({ task_id: task.task_id, run_id: task.run_id,
      parent_task_id: task.parent_task_id, delegation_depth: task.delegation_depth,
      attempt: execution.attempt, resumed_from_attempt: invocation.resume_required ? execution.attempt - 1 : null,
      agent: execution.agent, orchestration_started_at: startedAt,
      attempt_started_at: this.cp.attempts.get(task.task_id, execution.attempt)?.started_at ?? null,
      queued_at: execution.queued_at, admitted_at: current.admitted_at,
      observed_runtime_started_at: runtimeStartedAt, observed_runtime_ended_at: runtimeEndedAt,
      completed_at: this.cp.clock.now(), input_artifact_count: invocation.inputs.length,
      input_artifact_bytes: invocation.inputs.reduce((n, a) => n + a.bytes, 0), termination_kind: termination, update });
    let draft = this.cp.attempts.prepareObservation(telemetry, task.spec.telemetry_mode === "strict");
    let deliverable: Deliverable | null = null;
    const finalResult = () => ({ deliverable, error,
      sameHandle: requireHandle !== undefined && reportedHandle === requireHandle,
      telemetry: this.cp.attempts.queryTelemetry({ task_id: task.task_id, attempt: execution.attempt, limit: 1 })[0] ?? null });
    const commit = (): void => { this.cp.store.transaction(() => {
      // Runtime callbacks are fenced as soon as this attempt ends. A stop confirmation
      // remains legal for this generation even when the deadline has already fired.
      if (this.cp.executions.assertGeneration(execution).cancel_requested_at !== null && returned) {
        returned = null; error = new BridgeError(ErrorCode.TASK_CANCELLED, "Cancellation won the result commit race", { runtime_stop_confirmed: stopped });
      }
      if (returned) deliverable = this.cp.deliverables.submit(returned);
      this.cp.attempts.end(task.task_id, execution.attempt, execution.agent, deliverable?.status ?? error!.code);
      this.cp.store.putObservation(draft);
      const observation = this.cp.attempts.sealObservation(task.task_id, execution.attempt);
      if (!deliverable) {
        const state = this.cp.tasks.get(task.task_id).state;
        if (!isTerminal(state)) {
          if (this.cp.executions.assertGeneration(execution).cancel_requested_at !== null && stopped) this.cp.tasks.transition({ task_id: task.task_id, agent: execution.agent, to: TaskState.CANCELLED, reason: "runtime stop confirmed" });
          else if (!stopped || invocation.resume_required) this.cp.tasks.block(task.task_id, execution.agent, `${error!.code}: ${error!.message}`.slice(0, 500));
          else this.cp.tasks.transition({ task_id: task.task_id, agent: execution.agent, to: TaskState.FAILED, reason: `${error!.code}: ${error!.message}`.slice(0, 500) });
        }
      }
      onEnded?.(error, deliverable);
      if (stopped) {
        this.cp.executions.update(execution, { phase: "STOPPED", runtime_stop_confirmed: true });
        this.cp.leases.release(execution.lease_id!, execution.agent);
      } else this.cp.leases.quarantine(execution.lease_id!, execution.agent);
      if (deliverable) onSuccess?.(deliverable, observation);
      onFinalized?.(finalResult(), observation);
    }); };
    try { commit(); }
    catch (commitError) {
      if (!returned) throw commitError;
      error = BridgeError.from(commitError); returned = null; deliverable = null;
      telemetry = { ...telemetry, termination_kind: AttemptTerminationKind.FAILED };
      draft = this.cp.attempts.prepareObservation(telemetry, task.spec.telemetry_mode === "strict");
      commit();
    }
    return finalResult();
  }

  /**
   * Resume one existing task in place using only its persisted control-plane identity.
   * The synchronous reservation phase is one SQLite transaction; runtime execution is
   * bounded and occurs after the write lock has been released.
   */
  async resumeTask(request: ResumeTaskRequest): Promise<ResumeTaskOutcome> {
    return this.resumeAuthorizedTask(request, "owner");
  }

  /**
   * Let the owner of a direct parent request strict recovery of its delegated child.
   * Authorization is evaluated from durable lineage while execution remains bound to the
   * child's persisted owner. The manager never owns or impersonates the worker task.
   */
  async resumeDelegatedTask(
    request: ResumeDelegatedTaskRequest,
  ): Promise<ResumeTaskOutcome> {
    return this.resumeAuthorizedTask(request, "delegated_manager");
  }

  /** A durable request is observed by the executor even in another native MCP process. */
  async cancelTask(task_id: string, requested_by: AgentId, wait_ms = 6000): Promise<{
    task_id: string; state: TaskState; runtime_stop_confirmed: boolean; cancelled: boolean;
  }> {
    if (!Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 30_000) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Cancellation wait must be 0..30000 ms");
    this.cp.store.transaction(() => {
      const task = this.cp.tasks.get(task_id);
      this.authorizeRecoveryIdentity(task, { task_id, requested_by }, task.owner === requested_by ? "owner" : "delegated_manager");
      if (isTerminal(task.state)) return;
      const prior = this.cp.store.getExecution(task_id);
      if (prior?.cancel_requested_at === null) this.cp.store.appendEvent({ type: EventType.CANCELLATION_REQUESTED,
        task_id, agent: requested_by, payload: { attempt: task.attempt } }, this.cp.clock.now());
      const record = this.cp.executions.requestCancel(task_id, requested_by);
      if (!record || record.phase === "QUEUED" || record.phase === "STOPPED") {
        if (record) {
          this.cp.executions.update(record, { phase: "STOPPED", runtime_stop_confirmed: true });
          const lease = record.lease_id ? this.cp.store.getLease(record.lease_id) : undefined;
          // No executor callback is needed for prelaunch cleanup: its manager may already
          // be dead. Never force release of a quarantined lease on this path.
          if (lease?.state === "HELD") this.cp.leases.release(lease.lease_id, record.agent);
        }
        this.cp.tasks.transition({ task_id, agent: task.owner!, to: TaskState.CANCELLED, reason: "No active runtime" });
      }
    });
    const deadline = Date.now() + wait_ms;
    do {
      const task = this.cp.tasks.get(task_id);
      const execution = this.cp.store.getExecution(task_id);
      if (!execution || execution.phase === "STOPPED" || execution.phase === "QUARANTINED" || Date.now() >= deadline) {
        return { task_id, state: task.state, runtime_stop_confirmed: execution?.runtime_stop_confirmed ?? true,
          cancelled: task.state === TaskState.CANCELLED };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
  }

  repairObservation(task_id: string, requested_by: AgentId, attempt?: number): import("@bridge/protocol").ObservationStatus {
    return this.cp.store.transaction(() => {
      const task = this.cp.tasks.get(task_id);
      this.authorizeRecoveryIdentity(task, { task_id, requested_by }, task.owner === requested_by ? "owner" : "delegated_manager");
      return this.cp.attempts.sealObservation(task_id, attempt ?? task.attempt);
    });
  }

  /** Explicitly continue preparation on the same task; no runtime attempt was consumed. */
  async continueTask(task_id: string, requested_by: AgentId, idempotency_key: string): Promise<DelegationOutcome> {
    const operation = this.cp.store.transaction(() => {
      const task = this.cp.tasks.get(task_id);
      this.authorizeRecoveryIdentity(task, { task_id, requested_by }, task.owner === requested_by ? "owner" : "delegated_manager");
      const prior = this.cp.store.firstDelegationOperation(task_id);
      if (!prior) {
        throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Only prelaunch scope contention can use preparation continuation");
      }
      const key = `continue:${idempotency_key}`;
      const request_hash = hashRequest({ task_id, requested_by, prior_hash: prior.request_hash });
      const cached = this.cp.store.getDelegationOperation(requested_by, key);
      if (cached) {
        if (cached.request_hash !== request_hash) throw new BridgeError(ErrorCode.IDEMPOTENCY_MISMATCH, "Continuation key has another contract");
        return cached;
      }
      if (prior.outcome?.error?.code !== ErrorCode.SCOPE_CONFLICT
        || this.cp.attempts.list(task_id).length !== 0 || task.state !== TaskState.BLOCKED) {
        throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Only prelaunch scope contention can use preparation continuation");
      }
      const next: DelegationOperation = { ...prior, caller: requested_by, key, request_hash,
        phase: "PREPARING", executor_id: this.operations.executor, executor_pid: process.pid,
        outcome: null, updated_at: this.cp.clock.now() };
      this.cp.store.putDelegationOperation(next);
      return next;
    });
    if (operation.outcome) return operation.outcome;
    const active = this.activeDelegations.get(task_id);
    if (active) return active;
    if (operation.executor_id !== this.operations.executor) return this.operations.wait(operation);
    const promise = this.delegateOnce(operation, {});
    this.activeDelegations.set(task_id, promise);
    try { return await promise; } finally { this.activeDelegations.delete(task_id); }
  }

  private async resumeAuthorizedTask(
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): Promise<ResumeTaskOutcome> {
    const task = this.cp.tasks.get(request.task_id);
    const authorization = this.authorizeRecoveryIdentity(task, request, kind);
    const authorizationKey = this.recoveryAuthorizationKey(authorization);

    const active = this.activeRecoveries.get(task.task_id);
    if (active !== undefined) {
      if (
        request.idempotency_key !== undefined &&
        active.idempotency_key === request.idempotency_key &&
        active.authorization_key === authorizationKey
      ) {
        return active.promise;
      }
      throw new BridgeError(
        ErrorCode.ILLEGAL_TRANSITION,
        `task ${task.task_id} already has an active recovery`,
        { task_id: task.task_id, attempt: task.attempt },
      );
    }

    const replay = this.readRecoveryReservation(request, kind);
    if (replay !== null) return this.replayRecovery(replay);

    const promise = this.resumeTaskOnce(request, kind);
    this.activeRecoveries.set(task.task_id, {
      ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
      authorization_key: authorizationKey,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = this.activeRecoveries.get(task.task_id);
      if (current?.promise === promise) this.activeRecoveries.delete(task.task_id);
    }
  }

  private async resumeTaskOnce(
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): Promise<ResumeTaskOutcome> {
    const task = this.cp.tasks.get(request.task_id);
    this.authorizeRecoveryIdentity(task, request, kind);
    const inputs = this.cp.artifacts.resolveForInvocation(this.recoveryInputArtifactIds(task.task_id));
    const prepared = this.prepareRecovery(request, kind);
    if (prepared.replayed) return this.replayRecovery(prepared.reservation);
    return this.executeRecovery(request, prepared.reservation, inputs);
  }

  private prepareRecovery(
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): { readonly reservation: RecoveryReservation; readonly replayed: boolean } {
    return this.cp.store.transaction(() => {
      const racedReplay = this.readRecoveryReservation(request, kind);
      if (racedReplay !== null) return { reservation: racedReplay, replayed: true };

      const task = this.cp.tasks.get(request.task_id);
      const authorization = this.authorizeRecoveryIdentity(task, request, kind);
      const executionAgent = authorization.execution_agent;
      this.cp.tasks.assertRecoverable(task);
      this.cp.tasks.assertPersistedLineage(task);

      const adapter = this.cp.adapters.get(executionAgent);
      if (adapter === undefined) {
        throw new BridgeError(
          ErrorCode.NOT_FOUND,
          `no adapter registered for owner '${executionAgent}'`,
          { task_id: task.task_id, owner: executionAgent },
        );
      }
      if (!adapter.info.capabilities.includes(RESUME_CAPABILITY)) {
        throw new BridgeError(
          ErrorCode.UNIMPLEMENTED,
          `adapter '${adapter.info.implementation}' does not advertise persisted-session resume`,
          { task_id: task.task_id, owner: executionAgent, capability: RESUME_CAPABILITY },
        );
      }

      const prior = this.cp.attempts.get(task.task_id, task.attempt);
      if (prior === undefined || !prior.execution_handle?.trim()) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `task ${task.task_id} attempt ${task.attempt} has no persisted execution handle`,
          { task_id: task.task_id, attempt: task.attempt },
        );
      }
      const handle = prior.execution_handle.trim();
      if (prior.agent !== executionAgent) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `task ${task.task_id} attempt ${task.attempt} is not owned by its persisted task owner`,
          {
            task_id: task.task_id,
            attempt: task.attempt,
            task_owner: executionAgent,
            attempt_agent: prior.agent,
          },
        );
      }

      const liveLeases = this.cp.leases.listLive();
      const liveTaskLease = liveLeases.find((lease) => lease.task_id === task.task_id);
      if (liveTaskLease !== undefined) {
        throw new BridgeError(
          ErrorCode.SCOPE_CONFLICT,
          `task ${task.task_id} still has a live lease and may still be executing`,
          { task_id: task.task_id, lease_id: liveTaskLease.lease_id },
        );
      }
      const overlapping = liveLeases
        .map((lease) => ({ lease, pairs: conflictingPairs(task.spec.scope, lease.scope) }))
        .filter((entry) => entry.pairs.length > 0);
      if (overlapping.length > 0) {
        throw new BridgeError(
          ErrorCode.SCOPE_CONFLICT,
          `task ${task.task_id} recovery scope conflicts with ${overlapping.length} live lease(s)`,
          {
            task_id: task.task_id,
            conflicts: overlapping.map(({ lease, pairs }) => ({
              lease_id: lease.lease_id,
              task_id: lease.task_id,
              holder: lease.holder,
              overlapping: pairs,
            })),
          },
        );
      }

      const recoveredAttempt = task.attempt + 1;
      if (this.cp.attempts.get(task.task_id, recoveredAttempt) !== undefined) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `attempt ${recoveredAttempt} already exists for ${task.task_id}`,
          { task_id: task.task_id, attempt: recoveredAttempt },
        );
      }
      const inputArtifactIds = this.recoveryInputArtifactIds(task.task_id);
      // Fail before reserving any state if the original durable inputs cannot be resolved.
      this.cp.artifacts.resolveMany(inputArtifactIds);
      const deadlineMs = this.recoveryDeadline(task);
      if (deadlineMs <= 0) {
        throw new BridgeError(ErrorCode.TIMEOUT, "total delegation deadline exhausted before recovery");
      }
      const requestedAt = this.cp.clock.now();
      const execution = this.cp.executions.queue(task.task_id, recoveredAttempt, executionAgent, adapter.info.max_concurrency);
      this.cp.store.appendEvent(
        {
          type: EventType.RECOVERY_REQUESTED,
          task_id: task.task_id,
          agent: request.requested_by,
          payload: {
            previous_attempt: task.attempt,
            recovered_attempt: recoveredAttempt,
            authorization_kind: authorization.kind,
            execution_agent: executionAgent,
          },
          ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
        },
        requestedAt,
      );

      const lease = this.cp.leases.acquire({
        task_id: task.task_id,
        holder: executionAgent,
        scope: task.spec.scope,
        ttl_ms: deadlineMs + DEFAULT_LEASE_GRACE_MS,
      });
      this.cp.executions.update(execution, { lease_id: lease.lease_id });
      const reservation: RecoveryReservation = {
        task_id: task.task_id,
        authorization_kind: authorization.kind,
        requested_by: request.requested_by,
        execution_agent: executionAgent,
        previous_attempt: task.attempt,
        recovered_attempt: recoveredAttempt,
        resumed_from_attempt: task.attempt,
        fresh_lease_id: lease.lease_id,
        input_artifact_ids: inputArtifactIds,
        requested_at: requestedAt,
        deadline_ms: deadlineMs,
        phase: "PREPARING",
        execution_generation: execution.generation,
        ...(request.idempotency_key ? { operation_key: request.idempotency_key } : {}),
      };
      if (request.idempotency_key) {
        this.cp.store.putIdempotency({
          key: request.idempotency_key,
          operation: this.recoveryIdempotencyOperation(kind),
          request_hash: this.recoveryRequestHash(request, kind),
          response_json: JSON.stringify(reservation),
          created_at: requestedAt,
        });
      }
      return { reservation, replayed: false };
    });
  }

  private async executeRecovery(request: RecoveryRequest, reservation: RecoveryReservation, inputs: TaskInvocation["inputs"]): Promise<ResumeTaskOutcome> {
    const task = this.cp.tasks.get(reservation.task_id);
    const prior = this.cp.attempts.get(task.task_id, reservation.previous_attempt)!;
    const execution = this.cp.store.getExecution(task.task_id)!;
    const invocation: TaskInvocation = { task_id: task.task_id, run_id: task.run_id,
      parent_task_id: task.parent_task_id, delegation_depth: task.delegation_depth,
      spec: task.spec, inputs,
      workspace_root: this.cp.workspaceRoot, lease_id: reservation.fresh_lease_id,
      deadline_at: reservation.requested_at + reservation.deadline_ms,
      attempt: reservation.recovered_attempt,
      idempotency_key: `${request.idempotency_key ?? task.task_id}:recovery:${reservation.recovered_attempt}`,
      previous_execution_handle: prior.execution_handle!, resume_required: true };
    try {
    await this.awaitAdmission(execution, invocation.deadline_at);
    this.cp.store.transaction(() => {
      const current = this.cp.executions.assertGeneration(execution);
      if (current.cancel_requested_at !== null) throw new BridgeError(ErrorCode.TASK_CANCELLED, "Cancelled before recovery launch");
      if (prior.ended_at === undefined) this.cp.attempts.end(task.task_id, reservation.previous_attempt, execution.agent, "interrupted");
      this.cp.tasks.beginRecovery({ task_id: task.task_id, agent: execution.agent, next_attempt: reservation.recovered_attempt });
      this.cp.attempts.startResumed(task.task_id, reservation.recovered_attempt, execution.agent, reservation.previous_attempt, prior.execution_handle!);
      this.cp.store.appendEvent({ type: EventType.RESUME_ATTEMPTED, task_id: task.task_id, agent: execution.agent,
        payload: { previous_attempt: reservation.previous_attempt, recovered_attempt: reservation.recovered_attempt,
          lease_id: reservation.fresh_lease_id, persisted_handle_present: true, requested_by: request.requested_by,
          authorization_kind: reservation.authorization_kind } }, this.cp.clock.now());
      this.cp.executions.update(execution, { runtime_stop_confirmed: false });
      this.storeRecoveryReservation(request, { ...reservation, phase: "AUTHORIZED" });
    });
    } catch (error) {
      const current = this.cp.executions.assertGeneration(execution);
      if (current.runtime_stop_confirmed !== true) throw new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED,
        "Recovery admission cannot clear an execution with unconfirmed runtime stop");
      this.cp.store.transaction(() => {
        this.cp.executions.update(execution, { phase: "STOPPED", runtime_stop_confirmed: true });
        this.cp.leases.release(reservation.fresh_lease_id, reservation.execution_agent);
        if (!isTerminal(this.cp.tasks.get(task.task_id).state)) this.cp.tasks.block(task.task_id, execution.agent,
          `Recovery preparation failed: ${BridgeError.from(error).code}`);
        this.storeRecoveryReservation(request, { ...reservation, phase: "FINISHED",
          prelaunch_error: { code: BridgeError.from(error).code, message: BridgeError.from(error).message } });
      });
      throw error;
    }
    let finalized!: ResumeTaskOutcome;
    await this.performInvocation(invocation, execution, reservation.requested_at, prior.execution_handle!, undefined,
      (error, deliverable) => { this.cp.store.appendEvent({ type: error ? EventType.RESUME_FAILED : EventType.RESUME_SUCCEEDED,
      task_id: task.task_id, agent: reservation.execution_agent,
      payload: { previous_attempt: reservation.previous_attempt, recovered_attempt: execution.attempt,
        ...(error ? { code: error.code, retryable: error.retryable } : { status: deliverable!.status, same_execution_handle: true }),
        requested_by: request.requested_by, authorization_kind: reservation.authorization_kind } }, this.cp.clock.now()); },
      (result, observation) => {
        const finalAttempt = this.cp.attempts.get(task.task_id, execution.attempt)!;
        finalized = { task_id: task.task_id, run_id: task.run_id, parent_task_id: task.parent_task_id,
      delegation_depth: task.delegation_depth, owner: reservation.execution_agent,
      previous_attempt: reservation.previous_attempt, recovered_attempt: execution.attempt,
      resumed_from_attempt: reservation.previous_attempt,
      same_execution_handle: result.sameHandle && finalAttempt.execution_handle === prior.execution_handle,
      fresh_lease_id: reservation.fresh_lease_id, lease_state: this.cp.store.getLease(reservation.fresh_lease_id)!.state,
      state: this.cp.tasks.get(task.task_id).state, deliverable: result.deliverable, telemetry: result.telemetry, observation,
      error: result.error ? { code: result.error.code, message: result.error.message }
        : observation.accepted ? null : { code: ErrorCode.TELEMETRY_INCOMPLETE, message: "Strict observation requirements are incomplete" } };
        this.storeRecoveryReservation(request, { ...reservation, phase: "FINISHED", outcome: finalized });
      });
    return finalized;
  }

  private storeRecoveryReservation(request: RecoveryRequest, reservation: RecoveryReservation): void {
    if (!request.idempotency_key) return;
    const record = this.cp.store.getIdempotency(request.idempotency_key)!;
    this.cp.store.updateIdempotencyResponse({ ...record, response_json: JSON.stringify(reservation) });
  }

  private readRecoveryReservation(
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): RecoveryReservation | null {
    if (!request.idempotency_key) return null;
    const record = this.cp.store.getIdempotency(request.idempotency_key);
    if (record === undefined) return null;
    const expectedHash = this.recoveryRequestHash(request, kind);
    if (
      record.operation !== this.recoveryIdempotencyOperation(kind) ||
      record.request_hash !== expectedHash
    ) {
      throw new BridgeError(
        ErrorCode.IDEMPOTENCY_MISMATCH,
        `idempotency key '${request.idempotency_key}' was already used for a different request`,
        { key: request.idempotency_key, previous_operation: record.operation },
      );
    }
    const parsed = JSON.parse(record.response_json) as Partial<RecoveryReservation>;
    if (
      parsed.task_id !== request.task_id ||
      !Number.isInteger(parsed.previous_attempt) ||
      !Number.isInteger(parsed.recovered_attempt) ||
      !Number.isInteger(parsed.resumed_from_attempt) ||
      typeof parsed.fresh_lease_id !== "string" ||
      !Array.isArray(parsed.input_artifact_ids) ||
      !parsed.input_artifact_ids.every((artifactId) => typeof artifactId === "string") ||
      typeof parsed.requested_at !== "number" ||
      typeof parsed.deadline_ms !== "number"
    ) {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `stored recovery reservation is invalid for ${request.task_id}`,
      );
    }
    const task = this.cp.tasks.get(request.task_id);
    const authorization = this.authorizeRecoveryIdentity(task, request, kind);
    const storedKind = parsed.authorization_kind ?? "owner";
    const storedRequester = parsed.requested_by ?? request.requested_by;
    const storedExecutionAgent = parsed.execution_agent ?? request.requested_by;
    if (
      storedKind !== authorization.kind ||
      storedRequester !== authorization.requested_by ||
      storedExecutionAgent !== authorization.execution_agent
    ) {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `stored recovery authorization is invalid for ${request.task_id}`,
        { task_id: request.task_id },
      );
    }
    return {
      ...(parsed as RecoveryReservation),
      authorization_kind: storedKind,
      requested_by: storedRequester,
      execution_agent: storedExecutionAgent,
    };
  }

  private authorizeRecoveryIdentity(
    task: Task,
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): RecoveryAuthorization {
    if (kind === "owner") {
      if (task.owner !== request.requested_by) {
        throw new BridgeError(
          ErrorCode.NOT_OWNER,
          `${request.requested_by} cannot resume a task owned by ${task.owner ?? "nobody"}`,
          { task_id: task.task_id, owner: task.owner, caller: request.requested_by },
        );
      }
      return {
        kind,
        requested_by: request.requested_by,
        execution_agent: request.requested_by,
      };
    }

    if (task.parent_task_id === null) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `task ${task.task_id} is not a delegated child`,
        { task_id: task.task_id },
      );
    }
    if (task.owner === null) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `delegated child ${task.task_id} has no persisted owner`,
        { task_id: task.task_id },
      );
    }
    if (task.owner === request.requested_by) {
      throw new BridgeError(
        ErrorCode.NOT_OWNER,
        `owner ${request.requested_by} must use direct owner recovery for ${task.task_id}`,
        { task_id: task.task_id, owner: task.owner, caller: request.requested_by },
      );
    }

    const parent = this.cp.tasks.get(task.parent_task_id);
    if (
      task.run_id !== parent.run_id ||
      task.delegation_depth !== parent.delegation_depth + 1
    ) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        `persisted direct-parent lineage is invalid for ${task.task_id}`,
        {
          task_id: task.task_id,
          parent_task_id: parent.task_id,
          run_id: task.run_id,
          parent_run_id: parent.run_id,
          delegation_depth: task.delegation_depth,
          expected_depth: parent.delegation_depth + 1,
        },
      );
    }
    if (parent.owner !== request.requested_by) {
      throw new BridgeError(
        ErrorCode.NOT_OWNER,
        `${request.requested_by} does not own direct parent ${parent.task_id}`,
        {
          task_id: task.task_id,
          parent_task_id: parent.task_id,
          parent_owner: parent.owner,
          caller: request.requested_by,
        },
      );
    }
    if (task.created_by !== request.requested_by) {
      throw new BridgeError(
        ErrorCode.NOT_OWNER,
        `${request.requested_by} did not create delegated child ${task.task_id}`,
        {
          task_id: task.task_id,
          parent_task_id: parent.task_id,
          created_by: task.created_by,
          caller: request.requested_by,
        },
      );
    }
    const delegated = this.cp.events({ task_id: task.task_id }).find(event => event.type === EventType.DELEGATION_REQUESTED);
    if (delegated && (delegated.agent !== request.requested_by || delegated.payload["to"] !== task.owner)) {
      throw new BridgeError(ErrorCode.NOT_OWNER, "Direct-parent authority contradicts the durable delegation event");
    }

    return {
      kind,
      requested_by: request.requested_by,
      execution_agent: task.owner,
    };
  }

  private recoveryAuthorizationKey(authorization: RecoveryAuthorization): string {
    return `${authorization.kind}:${authorization.requested_by}:${authorization.execution_agent}`;
  }

  private recoveryIdempotencyOperation(kind: RecoveryAuthorizationKind): string {
    return kind === "owner"
      ? RECOVERY_IDEMPOTENCY_OPERATION
      : DELEGATED_RECOVERY_IDEMPOTENCY_OPERATION;
  }

  private recoveryRequestHash(
    request: RecoveryRequest,
    kind: RecoveryAuthorizationKind,
  ): string {
    return kind === "owner"
      ? hashRequest({ task_id: request.task_id, requested_by: request.requested_by })
      : hashRequest({
          task_id: request.task_id,
          requested_by: request.requested_by,
          authorization_kind: kind,
        });
  }

  private replayRecovery(reservation: RecoveryReservation): ResumeTaskOutcome {
    if (reservation.outcome) return reservation.outcome;
    if (reservation.prelaunch_error) throw new BridgeError(reservation.prelaunch_error.code, reservation.prelaunch_error.message);
    const task = this.cp.tasks.get(reservation.task_id);
    const prior = this.cp.attempts.get(task.task_id, reservation.previous_attempt);
    const attempt = this.cp.attempts.get(task.task_id, reservation.recovered_attempt);
    const lease = this.cp.store.getLease(reservation.fresh_lease_id);
    if (reservation.phase === "PREPARING") {
      this.cp.executions.reconcileExecutors();
      const execution = this.cp.store.getExecution(task.task_id);
      if ((reservation.execution_generation && execution?.generation !== reservation.execution_generation) ||
          execution?.attempt === reservation.recovered_attempt && execution.phase === "STOPPED" && execution.runtime_stop_confirmed === true) {
        const failure = task.state === TaskState.CANCELLED
          ? { code: ErrorCode.TASK_CANCELLED, message: "Recovery cancelled before runtime launch" }
          : { code: ErrorCode.ADAPTER_FAILURE, message: "Recovery reservation abandoned before runtime launch" };
        this.cp.store.transaction(() => {
          if (lease?.state === "HELD") this.cp.leases.release(lease.lease_id, reservation.execution_agent);
          if (reservation.operation_key) this.storeRecoveryReservation({ task_id: task.task_id,
            requested_by: reservation.requested_by, idempotency_key: reservation.operation_key },
            { ...reservation, phase: "FINISHED", prelaunch_error: failure });
        });
        throw new BridgeError(failure.code, failure.message);
      }
      throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "Recovery preparation is already reserved; no runtime attempt has started");
    }
    if (prior === undefined || attempt === undefined || lease === undefined) {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `stored recovery reservation is incomplete for ${task.task_id}`,
      );
    }
    if (attempt.ended_at === undefined) {
      throw new BridgeError(
        ErrorCode.ILLEGAL_TRANSITION,
        `recovery attempt ${attempt.attempt} is already active for ${task.task_id}`,
        { task_id: task.task_id, attempt: attempt.attempt },
      );
    }
    const storedDeliverable = this.cp.deliverables.get(task.task_id) ?? null;
    const deliverable =
      storedDeliverable !== null && storedDeliverable.status === attempt.outcome
        ? storedDeliverable
        : null;
    const telemetry =
      this.cp.attempts.queryTelemetry({
        task_id: task.task_id,
        attempt: attempt.attempt,
        limit: 1,
      })[0] ?? null;
    const observation = this.cp.attempts.observation(task.task_id, attempt.attempt);
    const error = deliverable === null
      ? {
          code: Object.values(ErrorCode).includes(attempt.outcome as ErrorCode) ? attempt.outcome as ErrorCode : ErrorCode.ADAPTER_FAILURE,
          message: `recovery attempt ended with ${attempt.outcome ?? "unknown outcome"}`,
        }
      : observation.strict_required && !observation.accepted ? {
          code: ErrorCode.TELEMETRY_INCOMPLETE, message: "Strict observation requirements are incomplete",
        } : null;
    return {
      task_id: task.task_id,
      run_id: task.run_id,
      parent_task_id: task.parent_task_id,
      delegation_depth: task.delegation_depth,
      owner: task.owner!,
      previous_attempt: reservation.previous_attempt,
      recovered_attempt: reservation.recovered_attempt,
      resumed_from_attempt: reservation.resumed_from_attempt,
      same_execution_handle:
        prior.execution_handle !== null && prior.execution_handle === attempt.execution_handle,
      fresh_lease_id: reservation.fresh_lease_id,
      lease_state: lease.state,
      state: task.state,
      deliverable,
      telemetry,
      observation,
      error,
    };
  }

  private recoveryDeadline(task: Task): number {
    const delegation = this.cp.events({ task_id: task.task_id })
      .find((event) => event.type === EventType.DELEGATION_REQUESTED);
    const configured = delegation?.payload["deadline_ms"] ?? task.spec.deadline_ms;
    const perAttempt = typeof configured === "number" && Number.isInteger(configured)
      && configured >= 1_000 && configured <= 86_400_000
      ? configured : DEFAULT_RECOVERY_DEADLINE_MS;
    return this.remainingDeadline(task, perAttempt);
  }

  /** The first persisted delegation owns the budget; retries/resumes cannot reset it. */
  private remainingDeadline(task: Task, perAttempt: number): number {
    const delegation = this.cp.events({ task_id: task.task_id })
      .find((event) => event.type === EventType.DELEGATION_REQUESTED);
    const totalDeadlineAt = delegation?.payload["total_deadline_at"];
    if (totalDeadlineAt === undefined) return perAttempt;
    if (typeof totalDeadlineAt !== "number" || !Number.isSafeInteger(totalDeadlineAt)) {
      throw new BridgeError(ErrorCode.INTERNAL, "persisted total delegation deadline is invalid");
    }
    return Math.min(perAttempt, totalDeadlineAt - this.cp.clock.now());
  }

  /** Recover the immutable input list recorded when this existing task was delegated. */
  private recoveryInputArtifactIds(task_id: string): ArtifactId[] {
    const delegation = this.cp
      .events({ task_id })
      .find((event) => event.type === EventType.DELEGATION_REQUESTED);
    const raw = delegation?.payload["input_artifacts"];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every((artifactId) => typeof artifactId === "string")) {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `persisted input artifact metadata is invalid for ${task_id}`,
        { task_id },
      );
    }
    return raw as ArtifactId[];
  }

  /** The callbacks handed to an adapter. All of them route through the control plane. */
  private makeContext(
    task_id: string,
    agent: AgentId,
    signal: AbortSignal,
    attempt: number,
    telemetry: AttemptTelemetryUpdate,
    onExecutionHandle?: (handle: string) => void,
    execution?: ExecutionRecord,
  ): InvocationContext {
    const cp = this.cp;
    const assertCallback = (): void => {
      if (signal.aborted) throw new BridgeError(ErrorCode.TASK_CANCELLED, "Execution was aborted");
      if (execution) cp.executions.assertCallback(execution);
    };
    const guarded = <T>(fn: () => T): T => cp.store.transaction(() => { assertCallback(); return fn(); });
    return {
      async saveExecutionHandle(handle: string): Promise<void> {
        guarded(() => { onExecutionHandle?.(handle); cp.attempts.saveHandle(task_id, attempt, agent, handle); });
      },
      async reportTelemetry(update: AttemptTelemetryUpdate): Promise<void> {
        if (execution) {
          cp.executions.assertGeneration(execution);
          if (cp.attempts.get(task_id, attempt)?.ended_at !== undefined) throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Attempt observation is already final");
        }
        Object.assign(telemetry, update);
      },
      async reportRuntimeState(state): Promise<void> {
        if (!execution) return;
        const current = cp.executions.assertGeneration(execution);
        if (state === "running") { assertCallback(); cp.executions.update(execution, { runtime_stop_confirmed: false }); }
        else if (state === "unconfirmed") cp.executions.update(execution, { runtime_stop_confirmed: false });
        else cp.store.transaction(() => {
          if (current.runtime_stop_confirmed === true) return;
          cp.executions.update(execution, { runtime_stop_confirmed: true,
            ...(current.phase === "QUARANTINED" ? { phase: "STOPPED" as const } : {}) });
          cp.store.appendEvent({ type: EventType.RUNTIME_STOP_CONFIRMED, task_id, agent, payload: { attempt } }, cp.clock.now());
          if (current.phase === "QUARANTINED" && current.lease_id) cp.leases.confirmStopped(current.lease_id, agent);
        });
      },
      async report(update: Omit<StatusUpdate, "task_id" | "agent" | "at">): Promise<void> {
        guarded(() => cp.tasks.reportStatus({ ...update, task_id, agent, at: cp.clock.now() }));
      },
      async publishArtifact(input): Promise<ArtifactId> {
        const artifact = guarded(() => cp.artifacts.publish({
          task_id,
          produced_by: agent,
          kind: input.kind,
          name: input.name,
          media_type: input.media_type,
          ...(input.inline !== undefined ? { inline: input.inline } : {}),
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }));
        return artifact.artifact_id;
      },
      async recordVerification(result: VerificationResult): Promise<void> {
        guarded(() => cp.deliverables.recordVerification(task_id, agent, result));
      },
      async raiseBlocker(reason: string): Promise<void> {
        guarded(() => cp.tasks.block(task_id, agent, reason));
      },
      signal,
    };
  }

  /**
   * Run every currently-ready task through its preferred adapter, in parallel.
   *
   * Concurrency is bounded implicitly by lease conflicts: two ready tasks with overlapping
   * scopes cannot both acquire, so one fails fast with SCOPE_CONFLICT and stays PENDING for
   * the next pass rather than corrupting the other's files.
   */
  async runReady(
    defaultAgent: AgentId,
    deadline_ms: number,
    options: DelegateOptions = {},
  ): Promise<DelegationOutcome[]> {
    const ready = this.cp.tasks.readyTasks();
    const results = await Promise.allSettled(
      ready.map((task) =>
        this.delegate(
          {
            from: "orchestrator",
            to: task.spec.preferred_agent ?? defaultAgent,
            spec: task.spec,
            input_artifacts: [],
            deadline_ms,
          },
          options,
        ),
      ),
    );
    return results.flatMap((r) =>
      r.status === "fulfilled"
        ? [r.value]
        : [
            {
              task_id: "",
              delegate: defaultAgent,
              deliverable: null,
              error: { code: ErrorCode.INTERNAL, message: String(r.reason) },
              attempts: 1,
              duration_ms: 0,
            } satisfies DelegationOutcome,
          ],
    );
  }
}

function isTerminal(state: TaskState): boolean {
  return state === TaskState.DONE || state === TaskState.FAILED || state === TaskState.CANCELLED;
}

export { DeliverableStatus };
