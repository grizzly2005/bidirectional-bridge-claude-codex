/**
 * Deliverables and verification evidence.
 *
 * The rule that shapes this file: a task may only reach DONE if a check actually ran.
 * `submit` therefore refuses a COMPLETE deliverable whose verification results are empty
 * or all-failing. An agent that cannot verify must submit PARTIAL and say so — which is a
 * true statement — rather than COMPLETE with a confident summary, which is not.
 */

import {
  BridgeError,
  DELIVERABLE_TERMINAL_STATE,
  DeliverableSchema,
  DeliverableStatus,
  ErrorCode,
  EventType,
  TaskState,
  assertValid,
  validateVerificationResult,
  isReadOnlyScope,
  type AgentId,
  type Deliverable,
  type TaskId,
  type VerificationResult,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { StateStore } from "./store/state-store.js";
import type { TaskService } from "./task-service.js";

export interface SubmitOptions {
  /** Runtime commits provide their fenced attempt; manual/native submissions use current. */
  readonly attempt?: number;
  /**
   * Allow COMPLETE without passing verification evidence. Off by default and intended
   * only for tasks whose deliverable genuinely cannot be checked by a command
   * (a design decision, say). The waiver is recorded in the event log.
   */
  readonly allowUnverified?: boolean;
  readonly waiver_reason?: string;
}

/** Only this refusal permits the orchestrator to preserve COMPLETE as honest PARTIAL. */
export class VerificationRejectedError extends BridgeError {
  constructor(message: string, details: Record<string, unknown>) {
    super(ErrorCode.INVALID_ARGUMENT, message, details);
  }
}

export class DeliverableService {
  constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
    private readonly tasks: TaskService,
  ) {}

  /** Record evidence that a check ran. Callers must pass a real exit code. */
  recordVerification(task_id: TaskId, agent: AgentId, result: VerificationResult, attempt?: number): void {
    validateVerificationResult(result);
    this.store.transaction(() => {
      const task = this.tasks.get(task_id);
      if (task.owner !== agent) {
        throw new BridgeError(
          ErrorCode.NOT_OWNER,
          `${agent} cannot record verification for a task owned by ${task.owner ?? "nobody"}`,
          { task_id, owner: task.owner },
        );
      }
      if (attempt !== undefined && attempt !== task.attempt) {
        throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Verification belongs to an obsolete task attempt", { task_id, attempt });
      }
      this.store.insertVerification(task_id, result, task.attempt);
      this.store.appendEvent(
        {
          type: EventType.VERIFICATION_RECORDED,
          task_id,
          agent,
          payload: {
            attempt: task.attempt,
            kind: result.kind,
            command: result.command,
            passed: result.passed,
            exit_code: result.exit_code,
            summary: result.summary,
          },
        },
        this.clock.now(),
      );
    });
  }

  listVerifications(task_id: TaskId, attempt?: number | null): VerificationResult[] {
    return this.store.listVerifications(task_id, attempt);
  }

  /**
   * Submit the final deliverable and move the task to its terminal state.
   *
   * COMPLETE -> DONE, PARTIAL -> BLOCKED (it is not finished and someone must act),
   * FAILED -> FAILED.
   */
  submit(deliverable: Deliverable, options: SubmitOptions = {}): Deliverable {
    assertValid<Deliverable>(deliverable, DeliverableSchema, "Deliverable");

    return this.store.transaction(() => {
      const task = this.tasks.get(deliverable.task_id);
      if (task.owner !== deliverable.agent) {
        throw new BridgeError(
          ErrorCode.NOT_OWNER,
          `${deliverable.agent} cannot submit a deliverable for a task owned by ${task.owner ?? "nobody"}`,
          { task_id: deliverable.task_id, owner: task.owner },
        );
      }
      if (options.attempt !== undefined && options.attempt !== task.attempt) {
        throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Deliverable belongs to an obsolete task attempt", {
          task_id: task.task_id, attempt: options.attempt,
        });
      }
      if (isReadOnlyScope(task.spec.scope) && deliverable.changed_scope.length > 0) {
        throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "read-only tasks must report changed_scope: []", {
          task_id: task.task_id,
        });
      }

      // Historical/unknown-freshness checks stay readable, but cannot judge this attempt.
      const recorded = this.store.listVerifications(deliverable.task_id, task.attempt);
      const evidence = mergeEvidence(recorded, deliverable.verification_results);
      evidence.forEach(validateVerificationResult);

      if (deliverable.status === DeliverableStatus.COMPLETE) {
        // Order matters: report a *failing* check before an absent one. Both conditions
        // hold when the only evidence is a failure, and "your tests are red" is the
        // actionable diagnosis; "you ran no tests" would send the agent looking for the
        // wrong problem.
        const failing = evidence.filter((v) => !v.passed);
        if (failing.length > 0) {
          throw new VerificationRejectedError(
            `cannot submit COMPLETE while ${failing.length} verification(s) are failing: ` +
              failing.map((f) => `${f.kind}(${f.command})`).join(", "),
            { task_id: deliverable.task_id, attempt: task.attempt, failing: failing.map((f) => f.command) },
          );
        }
        if (evidence.length === 0 && !options.allowUnverified) {
          throw new VerificationRejectedError(
            `cannot submit COMPLETE for ${deliverable.task_id} with no passing verification. ` +
              `Run a real check, or submit PARTIAL, or pass allowUnverified with a waiver_reason.`,
            {
              task_id: deliverable.task_id,
              attempt: task.attempt,
              verification_criteria: task.spec.verification_criteria,
              evidence_count: evidence.length,
            },
          );
        }
      }

      const now = this.clock.now();
      const finalDeliverable: Deliverable = { ...deliverable, verification_results: evidence };
      this.store.insertDeliverable(finalDeliverable, task.attempt);
      this.store.appendEvent(
        {
          type: EventType.DELIVERABLE_SUBMITTED,
          task_id: deliverable.task_id,
          agent: deliverable.agent,
          payload: {
            attempt: task.attempt,
            status: deliverable.status,
            summary: deliverable.summary,
            artifacts: deliverable.artifacts,
            changed_scope: deliverable.changed_scope,
            verification_count: evidence.length,
            ...(options.allowUnverified ? { waiver_reason: options.waiver_reason ?? "unspecified" } : {}),
          },
        },
        now,
      );

      this.applyTerminalState(finalDeliverable, task.state);
      return finalDeliverable;
    });
  }

  /**
   * Resolve the deliverable to its terminal state in one atomic step.
   *
   * The mapping is `DELIVERABLE_TERMINAL_STATE` in `@bridge/protocol`, so the control
   * plane, the adapters, and the protocol doc cannot disagree about what PARTIAL means.
   *
   * Already inside `submit`'s transaction, so the deliverable row and the state change
   * commit or roll back together — there is no window where a stored deliverable claims
   * COMPLETE while the task still says WORKING.
   */
  private applyTerminalState(d: Deliverable, currentState: TaskState): void {
    const target = DELIVERABLE_TERMINAL_STATE[d.status];
    if (!target) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `unknown deliverable status '${d.status}'`, {
        task_id: d.task_id,
        status: d.status,
      });
    }

    // A BLOCKED task submitting COMPLETE has resolved whatever stopped it; clear the
    // blocker first so the finished task does not carry a stale reason.
    if (currentState === TaskState.BLOCKED && target === TaskState.DONE) {
      this.tasks.unblock(d.task_id, d.agent, "resolved on submission");
    }

    this.tasks.finalizeDeliverable({
      task_id: d.task_id,
      agent: d.agent,
      to: target,
      reason: `deliverable ${d.status}`,
      ...(target === TaskState.BLOCKED
        ? { blocker: d.remaining_risks[0] ?? "partial deliverable: work is incomplete" }
        : {}),
    });
  }

  get(task_id: TaskId): Deliverable | undefined {
    return this.store.getDeliverable(task_id);
  }
}

/** Union by (kind, command); the deliverable's copy wins on collision. */
function mergeEvidence(
  recorded: readonly VerificationResult[],
  submitted: readonly VerificationResult[],
): VerificationResult[] {
  const byKey = new Map<string, VerificationResult>();
  for (const r of recorded) byKey.set(`${r.kind}::${r.command}`, r);
  for (const r of submitted) byKey.set(`${r.kind}::${r.command}`, r);
  return [...byKey.values()];
}
