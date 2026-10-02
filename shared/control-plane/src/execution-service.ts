import { randomUUID } from "node:crypto";
import { BridgeError, ErrorCode, TaskState, type AgentId, type TaskId } from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { ExecutionRecord, StateStore } from "./store/state-store.js";

/** Durable admission and generation fencing shared by every native server in a workspace. */
export class ExecutionService {
  constructor(private readonly store: StateStore, private readonly clock: Clock) {}

  queue(task_id: TaskId, attempt: number, agent: AgentId, max_concurrency: number): ExecutionRecord {
    return this.store.transaction(() => {
      const previous = this.store.getExecution(task_id);
      if (previous && previous.phase !== "STOPPED") {
        throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "An execution already owns this task");
      }
      if (this.store.listExecutions(agent).filter(e => e.phase === "QUEUED").length >= 64) {
        throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Shared runtime admission queue is full");
      }
      const now = this.clock.now();
      const record: ExecutionRecord = { task_id, attempt, agent, max_concurrency, executor_pid: process.pid,
        generation: randomUUID(), phase: "QUEUED", queued_at: now, admitted_at: null,
        queue_ticket: Math.max(0, ...this.store.listExecutions().map(e => e.queue_ticket ?? 0)) + 1,
        runtime_stop_confirmed: true, lease_id: null,
        cancel_requested_at: null, cancel_requested_by: null, updated_at: now };
      this.store.putExecution(record);
      return record;
    });
  }

  tryAdmit(record: ExecutionRecord): boolean {
    return this.store.transaction(() => {
      this.reconcileExecutors(record.agent);
      const current = this.assertGeneration(record);
      if (current.cancel_requested_at !== null) return false;
      const all = this.store.listExecutions(record.agent).filter(e => e.phase !== "STOPPED")
        .sort((a, b) => a.queue_ticket - b.queue_ticket);
      const running = all.filter(e => e.phase === "RUNNING" || e.phase === "QUARANTINED");
      const limit = Math.min(record.max_concurrency, ...all.map(e => e.max_concurrency));
      const first = all.find(e => e.phase === "QUEUED" && e.cancel_requested_at === null);
      if (running.length >= limit || first?.generation !== record.generation) return false;
      this.store.putExecution({ ...current, phase: "RUNNING", admitted_at: this.clock.now(), updated_at: this.clock.now() });
      return true;
    });
  }

  /** Dead managers cannot hold the prelaunch FIFO forever. Authorized work stays fenced. */
  reconcileExecutors(agent?: AgentId): void {
    this.store.transaction(() => {
      for (const record of this.store.listExecutions(agent)) {
        if (record.phase === "STOPPED" || record.phase === "QUARANTINED" || !record.executor_pid || processAlive(record.executor_pid)) continue;
        if (record.phase === "QUEUED" || record.runtime_stop_confirmed === true) {
          this.store.putExecution({ ...record, phase: "STOPPED", runtime_stop_confirmed: true, updated_at: this.clock.now() });
          const lease = record.lease_id ? this.store.getLease(record.lease_id) : undefined;
          if (lease?.state === "HELD") {
            this.store.updateLease({ ...lease, state: "RELEASED", released_at: this.clock.now() });
            this.store.appendEvent({ type: "lease.released", task_id: record.task_id, agent: record.agent,
              payload: { lease_id: lease.lease_id, paths: lease.scope.paths, reason: "executor_died_before_launch" } }, this.clock.now());
          }
        } else {
          this.store.putExecution({ ...record, phase: "QUARANTINED", updated_at: this.clock.now() });
          const lease = record.lease_id ? this.store.getLease(record.lease_id) : undefined;
          if (lease?.state === "HELD") {
            this.store.updateLease({ ...lease, state: "QUARANTINED" });
            this.store.appendEvent({ type: "lease.quarantined", task_id: record.task_id, agent: record.agent,
              payload: { lease_id: lease.lease_id, reason: "executor_died_without_stop_evidence" } }, this.clock.now());
          }
        }
      }
    });
  }

  update(record: ExecutionRecord, patch: Partial<ExecutionRecord>): ExecutionRecord {
    return this.store.transaction(() => {
      const current = this.assertGeneration(record);
      const next = { ...current, ...patch, task_id: current.task_id, generation: current.generation,
        attempt: current.attempt, agent: current.agent, queue_ticket: current.queue_ticket,
        updated_at: this.clock.now() };
      this.store.putExecution(next);
      return next;
    });
  }

  requestCancel(task_id: TaskId, requested_by: AgentId): ExecutionRecord | undefined {
    return this.store.transaction(() => {
      const record = this.store.getExecution(task_id);
      if (!record || record.phase === "STOPPED" || record.cancel_requested_at !== null) return record;
      const next = { ...record, cancel_requested_by: requested_by,
        cancel_requested_at: this.clock.now(), updated_at: this.clock.now() };
      this.store.putExecution(next);
      return next;
    });
  }

  assertGeneration(record: ExecutionRecord): ExecutionRecord {
    const current = this.store.getExecution(record.task_id);
    if (!current || current.generation !== record.generation || current.attempt !== record.attempt) {
      throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Callback belongs to an obsolete execution generation");
    }
    return current;
  }

  assertCallback(record: ExecutionRecord): void {
    const current = this.assertGeneration(record);
    const task = this.store.getTask(record.task_id);
    const lease = current.lease_id ? this.store.getLease(current.lease_id) : undefined;
    if (current.phase !== "RUNNING" || current.cancel_requested_at !== null || task?.attempt !== record.attempt
      || task.owner !== record.agent || [TaskState.DONE, TaskState.FAILED, TaskState.CANCELLED].includes(task.state as never)
      || !lease || lease.state !== "HELD" || lease.expires_at <= this.clock.now()) {
      throw new BridgeError(ErrorCode.LEASE_INVALID, "Execution callback is cancelled, stopped, or outside its live lease");
    }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
