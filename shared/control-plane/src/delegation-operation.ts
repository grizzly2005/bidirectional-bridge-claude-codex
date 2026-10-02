import { randomUUID } from "node:crypto";
import { BridgeError, ErrorCode, EventType, TaskState, type DelegationOutcome, type DelegationRequest } from "@bridge/protocol";
import type { ControlPlane } from "./control-plane.js";
import type { DelegationOperation } from "./store/state-store.js";
import { hashRequest } from "./idempotency.js";

/** Short durable reservations; no SQLite transaction ever spans a runtime await. */
export class DelegationOperations {
  readonly executor = randomUUID();
  constructor(private readonly cp: ControlPlane) {}

  reserve(input: DelegationRequest): { operation: DelegationOperation; owned: boolean } {
    if (!Number.isInteger(input.deadline_ms) || input.deadline_ms < 1000 || input.deadline_ms > 86400000
      || !Number.isInteger(input.max_attempts ?? 0) || (input.max_attempts ?? 0) < 0 || (input.max_attempts ?? 0) > 5) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Invalid delegation deadline or retry budget");
    }
    const request: DelegationRequest = { ...input, max_attempts: input.max_attempts ?? 0,
      spec: { ...input.spec, preferred_agent: input.to,
        telemetry_mode: input.spec.telemetry_mode ?? "operational" } };
    const artifacts = this.cp.artifacts.resolveMany(input.input_artifacts)
      .map(a => ({ artifact_id: a.artifact_id, sha256: a.sha256, bytes: a.bytes }));
    const fingerprint = hashRequest({ ...request, idempotency_key: undefined,
      run_id: request.run_id ?? null, parent_task_id: request.parent_task_id ?? null,
      delegation_depth: request.delegation_depth ?? null, total_deadline_ms: request.total_deadline_ms ?? null,
      artifacts });
    const key = input.idempotency_key ?? `unkeyed:${randomUUID()}`;
    return this.cp.store.transaction(() => {
      const existing = this.cp.store.getDelegationOperation(input.from, key);
      if (existing) {
        if (existing.request_hash !== fingerprint) {
          throw new BridgeError(ErrorCode.IDEMPOTENCY_MISMATCH, "Delegation key was reused with a different complete contract");
        }
        if (existing.phase === "FINISHED" || existing.phase === "UNCERTAIN") return { operation: existing, owned: false };
        if (existing.executor_id === this.executor) return { operation: existing, owned: true };
        if (processAlive(existing.executor_pid)) return { operation: existing, owned: false };
        if (existing.phase === "PREPARING") {
          const execution = this.cp.store.getExecution(existing.task_id);
          if (execution?.phase === "QUEUED" || (execution?.phase === "RUNNING" && execution.runtime_stop_confirmed === true)) {
            this.cp.executions.update(execution, { phase: "STOPPED" });
          }
          const resumed = { ...existing, executor_id: this.executor, executor_pid: process.pid, updated_at: this.cp.clock.now() };
          this.cp.store.putDelegationOperation(resumed);
          return { operation: resumed, owned: true };
        }
        // The launch reservation committed, but whether a model started is unknowable.
        // Never turn heartbeat expiry or a dead manager PID into remote stop evidence.
        const execution = this.cp.store.getExecution(existing.task_id);
        if (execution && execution.runtime_stop_confirmed !== true) {
          this.cp.executions.update(execution, { phase: "QUARANTINED" });
          if (execution.lease_id) this.cp.leases.quarantine(execution.lease_id, execution.agent);
        }
        const task = this.cp.tasks.get(existing.task_id);
        if (task.owner && task.state === TaskState.WORKING) this.cp.tasks.block(task.task_id, task.owner, "Launch outcome uncertain; positive stop evidence required");
        const uncertain = { ...existing, phase: "UNCERTAIN" as const, updated_at: this.cp.clock.now() };
        this.cp.store.putDelegationOperation(uncertain);
        return { operation: uncertain, owned: false };
      }
      const started_at = this.cp.clock.now();
      const task = this.cp.tasks.create({ spec: request.spec, created_by: input.from,
        ...(input.run_id ? { run_id: input.run_id } : {}),
        ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
        ...(input.delegation_depth !== undefined ? { delegation_depth: input.delegation_depth } : {}) });
      this.cp.store.appendEvent({ type: EventType.DELEGATION_REQUESTED, task_id: task.task_id, agent: input.from,
        payload: { to: input.to, run_id: task.run_id, parent_task_id: task.parent_task_id,
          delegation_depth: task.delegation_depth, objective: request.spec.objective,
          deadline_ms: input.deadline_ms, input_artifacts: input.input_artifacts, max_attempts: (input.max_attempts ?? 0) + 1,
          ...(input.total_deadline_ms !== undefined ? { total_deadline_at: started_at + input.total_deadline_ms } : {}) } }, started_at);
      const operation: DelegationOperation = { caller: input.from, key, request_hash: fingerprint,
        task_id: task.task_id, request, phase: "PREPARING", executor_id: this.executor, executor_pid: process.pid,
        started_at, updated_at: started_at, outcome: null };
      this.cp.store.putDelegationOperation(operation);
      return { operation, owned: true };
    });
  }

  authorize(operation: DelegationOperation): void {
    const current = this.cp.store.getDelegationOperation(operation.caller, operation.key)!;
    if (current.executor_id !== this.executor || current.outcome || current.phase === "UNCERTAIN") {
      throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "Execution reservation belongs to another process");
    }
    this.cp.store.putDelegationOperation({ ...current, phase: "AUTHORIZED", updated_at: this.cp.clock.now() });
  }

  finish(operation: DelegationOperation, outcome: DelegationOutcome): DelegationOutcome {
    return this.cp.store.transaction(() => {
      const current = this.cp.store.getDelegationOperation(operation.caller, operation.key)!;
      if (current.outcome) return current.outcome;
      if (current.executor_id !== this.executor) throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "Operation executor changed");
      this.cp.store.putDelegationOperation({ ...current, phase: "FINISHED", outcome, updated_at: this.cp.clock.now() });
      return outcome;
    });
  }

  async wait(operation: DelegationOperation): Promise<DelegationOutcome> {
    const limit = Date.now() + operation.request.deadline_ms + 10_000;
    do {
      const current = this.cp.store.getDelegationOperation(operation.caller, operation.key)!;
      if (current.outcome) return current.outcome;
      if (current.phase === "UNCERTAIN") return { task_id: current.task_id, delegate: current.request.to,
        deliverable: this.cp.deliverables.get(current.task_id) ?? null,
        error: { code: ErrorCode.RUNTIME_STOP_UNCONFIRMED, message: "Previous launch is uncertain; automatic re-execution refused" },
        attempts: this.cp.attempts.list(current.task_id).length, duration_ms: Math.max(0, this.cp.clock.now() - current.started_at) };
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < limit);
    throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "Delegation is still owned by another live executor", { task_id: operation.task_id });
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
