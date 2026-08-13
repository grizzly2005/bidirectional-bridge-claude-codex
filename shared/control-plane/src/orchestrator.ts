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
}

interface ActiveRecovery {
  readonly idempotency_key?: string;
  readonly authorization_key: string;
  readonly promise: Promise<ResumeTaskOutcome>;
}

export class Orchestrator {
  private readonly activeRecoveries = new Map<string, ActiveRecovery>();

  constructor(private readonly cp: ControlPlane) {}

  /**
   * Delegate one bounded task and wait for its outcome.
   *
   * Never loops back to the delegate for clarification — a delegation is one request and
   * one answer. If the delegate needs something it cannot get, it returns PARTIAL with a
   * blocker and the caller decides what to do, which keeps agent-to-agent traffic finite.
   */
  async delegate(request: DelegationRequest, options: DelegateOptions = {}): Promise<DelegationOutcome> {
    const started = this.cp.clock.now();
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

    const maxAttempts = Math.max(1, (request.max_attempts ?? 0) + 1);

    const task = this.cp.tasks.create({
      spec: { ...request.spec, preferred_agent: request.to },
      created_by: request.from,
      ...(request.run_id ? { run_id: request.run_id } : {}),
      ...(request.parent_task_id !== undefined
        ? { parent_task_id: request.parent_task_id }
        : {}),
      ...(request.delegation_depth !== undefined
        ? { delegation_depth: request.delegation_depth }
        : {}),
      ...(request.idempotency_key ? { idempotency_key: `${request.idempotency_key}:create` } : {}),
    });

    this.cp.store.appendEvent(
      {
        type: EventType.DELEGATION_REQUESTED,
        task_id: task.task_id,
        agent: request.from,
        payload: {
          to: request.to,
          run_id: task.run_id,
          parent_task_id: task.parent_task_id,
          delegation_depth: task.delegation_depth,
          objective: request.spec.objective,
          deadline_ms: request.deadline_ms,
          input_artifacts: request.input_artifacts,
          max_attempts: maxAttempts,
        },
      },
      started,
    );

    let lastError: BridgeError | null = null;
    // Attempts actually made, which is not the same as the budget: a non-retryable
    // failure stops after one. Reporting the budget instead would tell a supervisor the
    // system retried when it did not.
    let attemptsMade = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attemptsMade = attempt + 1;
      try {
        const deliverable = await this.runAttempt(task, request, attempt, started, options);
        this.cp.store.appendEvent(
          {
            type: EventType.DELEGATION_COMPLETED,
            task_id: task.task_id,
            agent: request.to,
            payload: { status: deliverable.status, attempt, artifacts: deliverable.artifacts },
          },
          this.cp.clock.now(),
        );
        return {
          task_id: task.task_id,
          delegate: request.to,
          deliverable,
          error: null,
          attempts: attempt + 1,
          duration_ms: this.cp.clock.now() - started,
        };
      } catch (err) {
        lastError = BridgeError.from(err);
        options.onEvent?.("attempt_failed", {
          task_id: task.task_id,
          attempt,
          code: lastError.code,
          message: lastError.message,
        });

        const canRetry = attempt + 1 < maxAttempts && lastError.retryable;
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
    return {
      task_id: task.task_id,
      delegate: request.to,
      deliverable: this.cp.deliverables.get(task.task_id) ?? null,
      error: { code: err.code, message: err.message },
      attempts: attemptsMade,
      duration_ms: this.cp.clock.now() - started,
    };
  }

  private async runAttempt(
    task: Task,
    request: DelegationRequest,
    attempt: number,
    orchestrationStartedAt: number,
    options: DelegateOptions,
  ): Promise<Deliverable> {
    const adapter = this.cp.adapters.get(request.to)!;
    const grace = options.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS;

    this.cp.tasks.claim(task.task_id, request.to);

    const lease = this.cp.leases.acquire({
      task_id: task.task_id,
      holder: request.to,
      scope: request.spec.scope,
      ttl_ms: request.deadline_ms + grace,
    });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let attemptOpened = false;
    let observedRuntimeStartedAt: number | null = null;
    let observedRuntimeEndedAt: number | null = null;
    let terminationKind: AttemptTerminationKind = AttemptTerminationKind.UNKNOWN;
    const telemetryUpdate: AttemptTelemetryUpdate = {};
    let telemetryError: unknown;
    let inputArtifactCount = 0;
    let inputArtifactBytes = 0;

    try {
      this.cp.tasks.transition({ task_id: task.task_id, agent: request.to, to: TaskState.WORKING });

      // Open the attempt record before invoking, so an adapter that registers a session and
      // then crashes still leaves a row the next attempt can resume from.
      this.cp.attempts.start(task.task_id, attempt, request.to);
      attemptOpened = true;
      const previousHandle = this.cp.attempts.previousHandle(task.task_id, attempt);
      const inputs = this.cp.artifacts.resolveMany(request.input_artifacts);
      inputArtifactCount = inputs.length;
      inputArtifactBytes = inputs.reduce((total, artifact) => total + artifact.bytes, 0);

      const deadline_at = this.cp.clock.now() + request.deadline_ms;
      const invocation: TaskInvocation = {
        task_id: task.task_id,
        run_id: task.run_id,
        parent_task_id: task.parent_task_id,
        delegation_depth: task.delegation_depth,
        spec: request.spec,
        inputs,
        workspace_root: this.cp.workspaceRoot,
        lease_id: lease.lease_id,
        deadline_at,
        attempt,
        idempotency_key: `${request.idempotency_key ?? task.task_id}:${attempt}`,
        previous_execution_handle: previousHandle,
      };

      const ctx = this.makeContext(
        task.task_id,
        request.to,
        controller.signal,
        attempt,
        telemetryUpdate,
      );

      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.deadline_ms);

      observedRuntimeStartedAt = this.cp.clock.now();
      const deliverable = await adapter.invoke(invocation, ctx);
      observedRuntimeEndedAt = this.cp.clock.now();
      terminationKind = AttemptTerminationKind.COMPLETED;

      if (timedOut) {
        terminationKind = AttemptTerminationKind.TIMEOUT;
        throw new BridgeError(
          ErrorCode.TIMEOUT,
          `adapter '${request.to}' exceeded its ${request.deadline_ms}ms deadline`,
          { task_id: task.task_id, deadline_ms: request.deadline_ms },
        );
      }

      if (deliverable.task_id !== task.task_id || deliverable.agent !== request.to) {
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          `adapter returned a deliverable for the wrong task/agent`,
          { expected: { task_id: task.task_id, agent: request.to }, got: { task_id: deliverable.task_id, agent: deliverable.agent } },
        );
      }

      const submitted = this.cp.deliverables.submit(deliverable);
      this.cp.attempts.end(task.task_id, attempt, request.to, submitted.status);
      return submitted;
    } catch (err) {
      const bridgeErr = BridgeError.from(err);
      observedRuntimeEndedAt ??= observedRuntimeStartedAt === null ? null : this.cp.clock.now();
      if (terminationKind === AttemptTerminationKind.UNKNOWN) {
        terminationKind = timedOut || bridgeErr.code === ErrorCode.TIMEOUT
          ? AttemptTerminationKind.TIMEOUT
          : controller.signal.aborted
            ? AttemptTerminationKind.CANCELLED
            : bridgeErr.code === ErrorCode.ADAPTER_FAILURE
              ? AttemptTerminationKind.CRASH
              : AttemptTerminationKind.FAILED;
      }
      // Close the attempt with its failure code. The execution_handle stays, so the next
      // attempt can resume the session this one abandoned.
      try {
        this.cp.attempts.end(task.task_id, attempt, request.to, bridgeErr.code);
      } catch {
        /* attempt bookkeeping must never mask the original failure */
      }
      // Record why this attempt died so the log explains a retry rather than just showing one.
      try {
        const current = this.cp.tasks.get(task.task_id);
        if (current.owner === request.to && !isTerminal(current.state)) {
          this.cp.tasks.transition({
            task_id: task.task_id,
            agent: request.to,
            to: TaskState.FAILED,
            reason: `${bridgeErr.code}: ${bridgeErr.message}`.slice(0, 500),
          });
        }
      } catch {
        /* best effort; the original error is what matters */
      }
      throw bridgeErr;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (attemptOpened) {
        const completedAt = this.cp.clock.now();
        try {
          this.cp.attempts.recordTelemetry(
            normalizeAttemptTelemetry({
              task_id: task.task_id,
              run_id: task.run_id,
              parent_task_id: task.parent_task_id,
              delegation_depth: task.delegation_depth,
              attempt,
              agent: request.to,
              orchestration_started_at: orchestrationStartedAt,
              observed_runtime_started_at: observedRuntimeStartedAt,
              observed_runtime_ended_at: observedRuntimeEndedAt,
              completed_at: completedAt,
              input_artifact_count: inputArtifactCount,
              input_artifact_bytes: inputArtifactBytes,
              termination_kind: terminationKind,
              update: telemetryUpdate,
            }),
          );
        } catch (error) {
          telemetryError = error;
          options.onEvent?.("telemetry_record_failed", {
            task_id: task.task_id,
            attempt,
            message: (error as Error).message,
          });
        }
      }
      try {
        this.cp.leases.release(lease.lease_id, request.to);
      } catch (releaseErr) {
        options.onEvent?.("lease_release_failed", {
          lease_id: lease.lease_id,
          message: (releaseErr as Error).message,
        });
      }
      if (telemetryError !== undefined) throw telemetryError;
    }
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
    const prepared = this.prepareRecovery(request, kind);
    if (prepared.replayed) return this.replayRecovery(prepared.reservation);
    return this.executeRecovery(request, prepared.reservation);
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
      const requestedAt = this.cp.clock.now();
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
      if (prior.ended_at === undefined) {
        this.cp.attempts.end(
          task.task_id,
          task.attempt,
          executionAgent,
          "interrupted",
        );
      }
      this.cp.tasks.beginRecovery({
        task_id: task.task_id,
        agent: executionAgent,
        next_attempt: recoveredAttempt,
      });
      this.cp.attempts.startResumed(
        task.task_id,
        recoveredAttempt,
        executionAgent,
        task.attempt,
        handle,
      );
      this.cp.store.appendEvent(
        {
          type: EventType.RESUME_ATTEMPTED,
          task_id: task.task_id,
          agent: executionAgent,
          payload: {
            previous_attempt: task.attempt,
            recovered_attempt: recoveredAttempt,
            lease_id: lease.lease_id,
            persisted_handle_present: true,
            requested_by: request.requested_by,
            authorization_kind: authorization.kind,
          },
          ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
        },
        this.cp.clock.now(),
      );

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

  private async executeRecovery(
    request: RecoveryRequest,
    reservation: RecoveryReservation,
  ): Promise<ResumeTaskOutcome> {
    const task = this.cp.tasks.get(reservation.task_id);
    const executionAgent = reservation.execution_agent;
    const adapter = this.cp.adapters.get(executionAgent)!;
    const prior = this.cp.attempts.get(task.task_id, reservation.previous_attempt)!;
    const persistedHandle = prior.execution_handle!;
    const inputs = this.cp.artifacts.resolveMany(reservation.input_artifact_ids as ArtifactId[]);
    const controller = new AbortController();
    const telemetryUpdate: AttemptTelemetryUpdate = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let runtimeStartedAt: number | null = null;
    let runtimeEndedAt: number | null = null;
    let terminationKind: AttemptTerminationKind = AttemptTerminationKind.UNKNOWN;
    let reportedHandle: string | null = null;
    let deliverable: Deliverable | null = null;
    let runtimeError: BridgeError | null = null;
    let finalTelemetry: AttemptTelemetry | null = null;
    let telemetryError: unknown;

    const invocation: TaskInvocation = {
      task_id: task.task_id,
      run_id: task.run_id,
      parent_task_id: task.parent_task_id,
      delegation_depth: task.delegation_depth,
      spec: task.spec,
      inputs,
      workspace_root: this.cp.workspaceRoot,
      lease_id: reservation.fresh_lease_id,
      deadline_at: this.cp.clock.now() + reservation.deadline_ms,
      attempt: reservation.recovered_attempt,
      idempotency_key: `${request.idempotency_key ?? task.task_id}:recovery:${reservation.recovered_attempt}`,
      previous_execution_handle: persistedHandle,
      resume_required: true,
    };
    const context = this.makeContext(
      task.task_id,
      executionAgent,
      controller.signal,
      reservation.recovered_attempt,
      telemetryUpdate,
      (handle) => {
        if (handle !== persistedHandle) {
          throw new BridgeError(
            ErrorCode.ADAPTER_FAILURE,
            "runtime tried to replace the persisted execution handle during strict resume",
            {
              task_id: task.task_id,
              recovered_attempt: reservation.recovered_attempt,
              handle_reported: true,
            },
          );
        }
        reportedHandle = handle;
      },
    );

    try {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, reservation.deadline_ms);
      runtimeStartedAt = this.cp.clock.now();
      const returned = await adapter.invoke(invocation, context);
      runtimeEndedAt = this.cp.clock.now();
      terminationKind = AttemptTerminationKind.COMPLETED;
      if (timedOut) {
        terminationKind = AttemptTerminationKind.TIMEOUT;
        throw new BridgeError(
          ErrorCode.TIMEOUT,
          `resumed adapter '${executionAgent}' exceeded its ${reservation.deadline_ms}ms deadline`,
          { task_id: task.task_id, recovered_attempt: reservation.recovered_attempt },
        );
      }
      if (reportedHandle !== persistedHandle) {
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          "runtime did not confirm the exact persisted execution handle during strict resume",
          {
            task_id: task.task_id,
            recovered_attempt: reservation.recovered_attempt,
            handle_reported: reportedHandle !== null,
          },
        );
      }
      if (returned.task_id !== task.task_id || returned.agent !== executionAgent) {
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          "resumed adapter returned a deliverable for the wrong task or agent",
          { task_id: task.task_id, owner: executionAgent },
        );
      }

      deliverable = this.cp.deliverables.submit(returned);
      this.cp.attempts.end(
        task.task_id,
        reservation.recovered_attempt,
        executionAgent,
        deliverable.status,
      );
      this.cp.store.appendEvent(
        {
          type: EventType.RESUME_SUCCEEDED,
          task_id: task.task_id,
          agent: executionAgent,
          payload: {
            previous_attempt: reservation.previous_attempt,
            recovered_attempt: reservation.recovered_attempt,
            status: deliverable.status,
            same_execution_handle: true,
            requested_by: request.requested_by,
            authorization_kind: reservation.authorization_kind,
          },
        },
        this.cp.clock.now(),
      );
    } catch (error) {
      runtimeError = BridgeError.from(error);
      runtimeEndedAt ??= runtimeStartedAt === null ? null : this.cp.clock.now();
      terminationKind =
        timedOut || runtimeError.code === ErrorCode.TIMEOUT
          ? AttemptTerminationKind.TIMEOUT
          : controller.signal.aborted
            ? AttemptTerminationKind.CANCELLED
            : runtimeError.code === ErrorCode.ADAPTER_FAILURE
              ? AttemptTerminationKind.CRASH
              : AttemptTerminationKind.FAILED;
      this.cp.attempts.end(
        task.task_id,
        reservation.recovered_attempt,
        executionAgent,
        runtimeError.code,
      );
      const current = this.cp.tasks.get(task.task_id);
      if (
        current.owner === executionAgent &&
        current.state !== TaskState.BLOCKED &&
        !isTerminal(current.state)
      ) {
        this.cp.tasks.block(
          task.task_id,
          executionAgent,
          `resume ${runtimeError.code}: ${runtimeError.message}`.slice(0, 500),
        );
      }
      this.cp.store.appendEvent(
        {
          type: EventType.RESUME_FAILED,
          task_id: task.task_id,
          agent: executionAgent,
          payload: {
            previous_attempt: reservation.previous_attempt,
            recovered_attempt: reservation.recovered_attempt,
            code: runtimeError.code,
            retryable: runtimeError.retryable,
            requested_by: request.requested_by,
            authorization_kind: reservation.authorization_kind,
          },
        },
        this.cp.clock.now(),
      );
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      const completedAt = this.cp.clock.now();
      try {
        finalTelemetry = this.cp.attempts.recordTelemetry(
          normalizeAttemptTelemetry({
            task_id: task.task_id,
            run_id: task.run_id,
            parent_task_id: task.parent_task_id,
            delegation_depth: task.delegation_depth,
            attempt: reservation.recovered_attempt,
            resumed_from_attempt: reservation.previous_attempt,
            agent: executionAgent,
            orchestration_started_at: reservation.requested_at,
            observed_runtime_started_at: runtimeStartedAt,
            observed_runtime_ended_at: runtimeEndedAt,
            completed_at: completedAt,
            input_artifact_count: inputs.length,
            input_artifact_bytes: inputs.reduce((total, artifact) => total + artifact.bytes, 0),
            termination_kind: terminationKind,
            update: telemetryUpdate,
          }),
        );
      } catch (error) {
        telemetryError = error;
      }
      try {
        this.cp.leases.release(reservation.fresh_lease_id, executionAgent);
      } catch (releaseError) {
        if (telemetryError === undefined) telemetryError = releaseError;
      }
    }
    if (telemetryError !== undefined) throw telemetryError;

    const finalTask = this.cp.tasks.get(task.task_id);
    const finalAttempt = this.cp.attempts.get(task.task_id, reservation.recovered_attempt)!;
    const finalLease = this.cp.store.getLease(reservation.fresh_lease_id)!;
    return {
      task_id: task.task_id,
      run_id: task.run_id,
      parent_task_id: task.parent_task_id,
      delegation_depth: task.delegation_depth,
      owner: executionAgent,
      previous_attempt: reservation.previous_attempt,
      recovered_attempt: reservation.recovered_attempt,
      resumed_from_attempt: reservation.previous_attempt,
      same_execution_handle:
        reportedHandle === persistedHandle && finalAttempt.execution_handle === persistedHandle,
      fresh_lease_id: reservation.fresh_lease_id,
      lease_state: finalLease.state,
      state: finalTask.state,
      deliverable,
      telemetry: finalTelemetry,
      error: runtimeError
        ? { code: runtimeError.code, message: runtimeError.message }
        : null,
    };
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
    const task = this.cp.tasks.get(reservation.task_id);
    const prior = this.cp.attempts.get(task.task_id, reservation.previous_attempt);
    const attempt = this.cp.attempts.get(task.task_id, reservation.recovered_attempt);
    const lease = this.cp.store.getLease(reservation.fresh_lease_id);
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
    const error = deliverable === null
      ? {
          code: ErrorCode.ADAPTER_FAILURE,
          message: `recovery attempt ended with ${attempt.outcome ?? "unknown outcome"}`,
        }
      : null;
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
      error,
    };
  }

  private recoveryDeadline(task: Task): number {
    const configured = task.spec.deadline_ms;
    return Number.isInteger(configured) && configured! >= 1_000 && configured! <= 86_400_000
      ? configured!
      : DEFAULT_RECOVERY_DEADLINE_MS;
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
  ): InvocationContext {
    const cp = this.cp;
    return {
      async saveExecutionHandle(handle: string): Promise<void> {
        onExecutionHandle?.(handle);
        cp.attempts.saveHandle(task_id, attempt, agent, handle);
      },
      async reportTelemetry(update: AttemptTelemetryUpdate): Promise<void> {
        Object.assign(telemetry, update);
      },
      async report(update: Omit<StatusUpdate, "task_id" | "agent" | "at">): Promise<void> {
        cp.tasks.reportStatus({ ...update, task_id, agent, at: cp.clock.now() });
      },
      async publishArtifact(input): Promise<ArtifactId> {
        const artifact = cp.artifacts.publish({
          task_id,
          produced_by: agent,
          kind: input.kind,
          name: input.name,
          media_type: input.media_type,
          ...(input.inline !== undefined ? { inline: input.inline } : {}),
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        });
        return artifact.artifact_id;
      },
      async recordVerification(result: VerificationResult): Promise<void> {
        cp.deliverables.recordVerification(task_id, agent, result);
      },
      async raiseBlocker(reason: string): Promise<void> {
        cp.tasks.block(task_id, agent, reason);
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
