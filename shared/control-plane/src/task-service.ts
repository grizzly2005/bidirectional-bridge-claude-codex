/**
 * Task lifecycle, ownership, and dependency gating.
 *
 * Every state change funnels through here (D-003), which is what makes "who owns what"
 * and "what may start now" decidable rather than a matter of agent good behaviour.
 * The state write and its event-log append share one transaction, so the log can never
 * describe a transition that did not happen, nor miss one that did.
 */

import {
  ALLOWED_TRANSITIONS,
  BridgeError,
  ErrorCode,
  EventType,
  TERMINAL_STATES,
  TaskState,
  assertValid,
  canTransition,
  newRunId,
  newTaskId,
  normalizeScope,
  RunIdSchema,
  TaskSpecSchema,
  type AgentId,
  type RandomSource,
  type RunId,
  type StatusUpdate,
  type Task,
  type TaskId,
  type TaskSpec,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import { runIdempotent } from "./idempotency.js";
import type { StateStore } from "./store/state-store.js";

export interface CreateTaskInput {
  readonly spec: TaskSpec;
  readonly created_by: AgentId;
  readonly run_id?: RunId;
  readonly parent_task_id?: TaskId | null;
  readonly delegation_depth?: number;
  readonly idempotency_key?: string;
}

export const MAX_DELEGATION_DEPTH = 32;

export interface TransitionInput {
  readonly task_id: TaskId;
  readonly agent: AgentId;
  readonly to: TaskState;
  readonly reason?: string;
  readonly idempotency_key?: string;
}

export interface BeginRecoveryInput {
  readonly task_id: TaskId;
  readonly agent: AgentId;
  readonly next_attempt: number;
}

export interface DependencyReport {
  readonly satisfied: boolean;
  readonly unsatisfied: ReadonlyArray<{ task_id: TaskId; state: TaskState | "MISSING" }>;
}

export class TaskService {
  constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
    private readonly rng?: RandomSource,
  ) {}

  /* ---------------- creation ---------------- */

  create(input: CreateTaskInput): Task {
    return runIdempotent(
      this.store,
      this.clock,
      {
        key: input.idempotency_key,
        operation: "task.create",
        request: {
          spec: input.spec,
          created_by: input.created_by,
          run_id: input.run_id ?? null,
          parent_task_id: input.parent_task_id ?? null,
          delegation_depth: input.delegation_depth ?? null,
        },
      },
      () => {
        assertValid<TaskSpec>(input.spec, TaskSpecSchema, "TaskSpec");
        if (input.run_id !== undefined) {
          assertValid<RunId>(input.run_id, RunIdSchema, "RunId");
        }
        const spec: TaskSpec = { ...input.spec, scope: normalizeScope(input.spec.scope) };

        for (const dep of spec.dependencies) {
          if (!this.store.getTask(dep)) {
            throw new BridgeError(ErrorCode.NOT_FOUND, `dependency ${dep} does not exist`, {
              dependency: dep,
            });
          }
        }

        const parentTaskId = input.parent_task_id ?? null;
        const parent = parentTaskId === null ? undefined : this.store.getTask(parentTaskId);
        if (parentTaskId !== null && parent === undefined) {
          throw new BridgeError(ErrorCode.NOT_FOUND, `parent task ${parentTaskId} does not exist`, {
            parent_task_id: parentTaskId,
          });
        }

        const runId = parent?.run_id ?? input.run_id ?? newRunId(this.rng);
        if (parent !== undefined && input.run_id !== undefined && input.run_id !== parent.run_id) {
          throw new BridgeError(
            ErrorCode.INVALID_ARGUMENT,
            `child run_id must match parent ${parent.task_id}`,
            { run_id: input.run_id, parent_run_id: parent.run_id },
          );
        }
        const expectedDepth = parent === undefined ? 0 : parent.delegation_depth + 1;
        if (
          input.delegation_depth !== undefined &&
          input.delegation_depth !== expectedDepth
        ) {
          throw new BridgeError(
            ErrorCode.INVALID_ARGUMENT,
            `delegation_depth must be ${expectedDepth} for this lineage`,
            { supplied: input.delegation_depth, expected: expectedDepth },
          );
        }
        if (expectedDepth > MAX_DELEGATION_DEPTH) {
          throw new BridgeError(
            ErrorCode.INVALID_ARGUMENT,
            `delegation depth exceeds the ${MAX_DELEGATION_DEPTH} level safety limit`,
            { parent_task_id: parentTaskId, delegation_depth: expectedDepth },
          );
        }

        const now = this.clock.now();
        const task: Task = {
          task_id: newTaskId(this.rng),
          run_id: runId,
          parent_task_id: parentTaskId,
          delegation_depth: expectedDepth,
          spec,
          state: TaskState.PENDING,
          owner: null,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
          blockers: [],
          version: 1,
          attempt: 0,
        };

        return this.store.transaction(() => {
          this.store.insertTask(task);
          this.store.appendEvent(
            {
              type: EventType.TASK_CREATED,
              task_id: task.task_id,
              agent: input.created_by,
              payload: {
                objective: spec.objective,
                run_id: runId,
                parent_task_id: parentTaskId,
                delegation_depth: expectedDepth,
                scope: spec.scope.paths,
                dependencies: spec.dependencies,
                expected_deliverable: spec.expected_deliverable,
                verification_criteria: spec.verification_criteria,
              },
              ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
            },
            now,
          );
          return task;
        });
      },
    );
  }

  get(task_id: TaskId): Task {
    const task = this.store.getTask(task_id);
    if (!task) throw new BridgeError(ErrorCode.NOT_FOUND, `no such task ${task_id}`, { task_id });
    return task;
  }

  list(...args: Parameters<StateStore["listTasks"]>): Task[] {
    return this.store.listTasks(...args);
  }

  /**
   * Reject a delegation that would send work back to an agent already represented in the
   * parent lineage. The chain comes only from durable task records; model text and prompts
   * are deliberately irrelevant to this decision.
   */
  assertDelegationTargetNotInAncestors(parent_task_id: TaskId, target: AgentId): void {
    const seen = new Set<TaskId>();
    const ancestors: Array<{ readonly task_id: TaskId; readonly agent: AgentId }> = [];
    let currentTaskId: TaskId | null = parent_task_id;

    while (currentTaskId !== null) {
      if (seen.has(currentTaskId)) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `task lineage contains a cycle at ${currentTaskId}`,
          { parent_task_id, cycle_task_id: currentTaskId },
        );
      }
      seen.add(currentTaskId);

      const task = this.get(currentTaskId);
      const agent = task.owner ?? task.spec.preferred_agent ?? task.created_by;
      ancestors.push({ task_id: task.task_id, agent });
      if (agent === target) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `delegation to '${target}' would revisit an ancestor agent`,
          {
            parent_task_id,
            target,
            conflicting_task_id: task.task_id,
            ancestor_agents: ancestors.map((entry) => entry.agent),
          },
        );
      }
      currentTaskId = task.parent_task_id;
    }
  }

  /** Re-validate persisted run lineage before reactivating an existing task. */
  assertPersistedLineage(task: Task): void {
    const seen = new Set<TaskId>();
    let current = task;
    while (true) {
      if (seen.has(current.task_id)) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `task lineage contains a cycle at ${current.task_id}`,
          { task_id: task.task_id, cycle_task_id: current.task_id },
        );
      }
      seen.add(current.task_id);

      if (current.parent_task_id === null) {
        if (current.delegation_depth !== 0) {
          throw new BridgeError(
            ErrorCode.INVALID_ARGUMENT,
            `root task ${current.task_id} must have delegation_depth 0`,
            { task_id: current.task_id, delegation_depth: current.delegation_depth },
          );
        }
        break;
      }

      const parent = this.get(current.parent_task_id);
      if (
        current.run_id !== parent.run_id ||
        current.delegation_depth !== parent.delegation_depth + 1
      ) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `persisted lineage is invalid for ${current.task_id}`,
          {
            task_id: current.task_id,
            run_id: current.run_id,
            parent_run_id: parent.run_id,
            delegation_depth: current.delegation_depth,
            expected_depth: parent.delegation_depth + 1,
          },
        );
      }
      current = parent;
    }

    if (task.owner !== null) {
      if (task.parent_task_id !== null) {
        this.assertDelegationTargetNotInAncestors(task.parent_task_id, task.owner);
      }
    }
  }

  /* ---------------- ownership ---------------- */

  /**
   * Claim an unowned task. Atomic: the version check in `updateTask` means two agents
   * racing to claim the same task cannot both win — the loser gets a concurrency error
   * and re-reads to find the task already owned.
   */
  claim(task_id: TaskId, agent: AgentId, idempotency_key?: string): Task {
    return runIdempotent(
      this.store,
      this.clock,
      { key: idempotency_key, operation: "task.claim", request: { task_id, agent } },
      () =>
        this.store.transaction(() => {
          const task = this.get(task_id);
          if (task.owner && task.owner !== agent) {
            throw new BridgeError(
              ErrorCode.NOT_OWNER,
              `task ${task_id} is already owned by ${task.owner}`,
              { task_id, owner: task.owner, caller: agent },
            );
          }
          if (task.owner === agent && task.state !== TaskState.PENDING) return task;
          this.assertTransition(task, TaskState.CLAIMED);

          const now = this.clock.now();
          const claimed: Task = {
            ...task,
            state: TaskState.CLAIMED,
            owner: agent,
            claimed_at: now,
            updated_at: now,
            version: task.version + 1,
          };
          this.store.updateTask(claimed);
          this.store.appendEvent(
            {
              type: EventType.TASK_CLAIMED,
              task_id,
              agent,
              payload: { previous_state: task.state },
              ...(idempotency_key ? { idempotency_key } : {}),
            },
            now,
          );
          return claimed;
        }),
    );
  }

  /** Give a task back to the pool without failing it (e.g. the agent is over budget). */
  release(task_id: TaskId, agent: AgentId, reason: string): Task {
    return this.store.transaction(() => {
      const task = this.assertOwner(this.get(task_id), agent);
      this.assertTransition(task, TaskState.PENDING);
      const now = this.clock.now();
      const released: Task = {
        ...task,
        state: TaskState.PENDING,
        owner: null,
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(released);
      this.store.appendEvent(
        { type: EventType.TASK_RELEASED, task_id, agent, payload: { reason } },
        now,
      );
      return released;
    });
  }

  /* ---------------- dependencies ---------------- */

  /** Add an edge, refusing any edge that would create a cycle (deadlock by construction). */
  addDependency(task_id: TaskId, depends_on: TaskId, agent: AgentId): Task {
    return this.store.transaction(() => {
      const task = this.get(task_id);
      this.get(depends_on);
      if (task_id === depends_on) {
        throw new BridgeError(ErrorCode.DEPENDENCY_CYCLE, "a task cannot depend on itself", {
          task_id,
        });
      }
      if (this.reaches(depends_on, task_id)) {
        throw new BridgeError(
          ErrorCode.DEPENDENCY_CYCLE,
          `adding ${task_id} -> ${depends_on} would create a dependency cycle`,
          { task_id, depends_on },
        );
      }
      if (task.spec.dependencies.includes(depends_on)) return task;

      const now = this.clock.now();
      const updated: Task = {
        ...task,
        spec: { ...task.spec, dependencies: [...task.spec.dependencies, depends_on] },
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(updated);
      this.store.addDependency(task_id, depends_on);
      this.store.appendEvent(
        { type: EventType.TASK_DEPENDENCY_ADDED, task_id, agent, payload: { depends_on } },
        now,
      );
      return updated;
    });
  }

  /** Is `to` reachable from `from` by following dependency edges? Cycle-safe. */
  private reaches(from: TaskId, to: TaskId): boolean {
    const seen = new Set<TaskId>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...this.store.getDependencies(current));
    }
    return false;
  }

  checkDependencies(task_id: TaskId): DependencyReport {
    const unsatisfied: Array<{ task_id: TaskId; state: TaskState | "MISSING" }> = [];
    for (const dep of this.store.getDependencies(task_id)) {
      const depTask = this.store.getTask(dep);
      if (!depTask) unsatisfied.push({ task_id: dep, state: "MISSING" });
      else if (depTask.state !== TaskState.DONE) unsatisfied.push({ task_id: dep, state: depTask.state });
    }
    return { satisfied: unsatisfied.length === 0, unsatisfied };
  }

  /** Tasks that are PENDING, unowned, and whose dependencies are all DONE. */
  readyTasks(): Task[] {
    return this.store
      .listTasks({ state: TaskState.PENDING })
      .filter((t) => this.checkDependencies(t.task_id).satisfied);
  }

  /* ---------------- transitions ---------------- */

  transition(input: TransitionInput): Task {
    return runIdempotent(
      this.store,
      this.clock,
      {
        key: input.idempotency_key,
        operation: "task.transition",
        request: { task_id: input.task_id, to: input.to, agent: input.agent },
      },
      () =>
        this.store.transaction(() => {
          const task = this.assertOwner(this.get(input.task_id), input.agent);
          if (task.state === input.to) return task; // replay-safe no-op
          this.assertTransition(task, input.to);

          // Dependency gate: enforced at the WORKING boundary, not at claim time, so an
          // agent can claim and prepare while a dependency is still finishing.
          if (input.to === TaskState.WORKING) {
            const deps = this.checkDependencies(input.task_id);
            if (!deps.satisfied) {
              throw new BridgeError(
                ErrorCode.DEPENDENCY_UNSATISFIED,
                `cannot start: ${deps.unsatisfied.map((d) => `${d.task_id}(${d.state})`).join(", ")}`,
                { unsatisfied: deps.unsatisfied },
              );
            }
          }

          const now = this.clock.now();
          const isTerminal = TERMINAL_STATES.has(input.to);
          const next: Task = {
            ...task,
            state: input.to,
            updated_at: now,
            version: task.version + 1,
            ...(isTerminal ? { completed_at: now } : {}),
            ...(input.to === TaskState.WORKING ? { blockers: [] } : {}),
          };
          this.store.updateTask(next);
          this.store.appendEvent(
            {
              type: EventType.TASK_STATE_CHANGED,
              task_id: input.task_id,
              agent: input.agent,
              payload: { from: task.state, to: input.to, ...(input.reason ? { reason: input.reason } : {}) },
              ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
            },
            now,
          );
          return next;
        }),
    );
  }

  /** Atomically reactivate the same owned task while advancing only its attempt counter. */
  beginRecovery(input: BeginRecoveryInput): Task {
    return this.store.transaction(() => {
      const task = this.assertOwner(this.get(input.task_id), input.agent);
      this.assertRecoverable(task);
      if (input.next_attempt !== task.attempt + 1) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `recovery attempt must be ${task.attempt + 1} for ${task.task_id}`,
          { task_id: task.task_id, current_attempt: task.attempt, next_attempt: input.next_attempt },
        );
      }
      const dependencies = this.checkDependencies(task.task_id);
      if (!dependencies.satisfied) {
        throw new BridgeError(
          ErrorCode.DEPENDENCY_UNSATISFIED,
          `cannot recover: ${dependencies.unsatisfied
            .map((dependency) => `${dependency.task_id}(${dependency.state})`)
            .join(", ")}`,
          { unsatisfied: dependencies.unsatisfied },
        );
      }
      this.assertPersistedLineage(task);

      const now = this.clock.now();
      const recovered: Task = {
        ...task,
        state: TaskState.WORKING,
        attempt: input.next_attempt,
        blockers: [],
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(recovered);
      this.store.appendEvent(
        {
          type: EventType.TASK_STATE_CHANGED,
          task_id: task.task_id,
          agent: input.agent,
          payload: {
            from: task.state,
            to: TaskState.WORKING,
            reason: "recovery",
            attempt: input.next_attempt,
          },
        },
        now,
      );
      return recovered;
    });
  }

  /** Reject states that cannot represent an interrupted, resumable execution. */
  assertRecoverable(task: Task): void {
    if (
      task.state === TaskState.PENDING ||
      task.state === TaskState.DONE ||
      task.state === TaskState.FAILED ||
      task.state === TaskState.CANCELLED
    ) {
      throw new BridgeError(
        ErrorCode.ILLEGAL_TRANSITION,
        `task ${task.task_id} is not recoverable from ${task.state}`,
        { task_id: task.task_id, state: task.state },
      );
    }
  }

  /**
   * Apply a deliverable's outcome as one atomic state change.
   *
   * Replaces the old multi-hop dance (`VERIFYING -> WORKING -> BLOCKED` to submit a
   * PARTIAL). The caller already holds the transaction, so the state write and its event
   * commit together: an observer never sees the task pass through an intermediate state
   * that does not describe what happened.
   *
   *   COMPLETE -> DONE, PARTIAL -> BLOCKED, FAILED -> FAILED
   *
   * A submission straight from WORKING is routed through VERIFYING first, because DONE is
   * only reachable from VERIFYING and the log should show that the work was checked. That
   * hop is inside the same transaction, so it is still atomic to any reader.
   */
  finalizeDeliverable(input: {
    task_id: TaskId;
    agent: AgentId;
    to: TaskState;
    reason: string;
    blocker?: string;
  }): Task {
    return this.store.transaction(() => {
      const task = this.assertOwner(this.get(input.task_id), input.agent);
      if (task.state === input.to) return task; // replay-safe

      const now = this.clock.now();
      const path: TaskState[] = [];

      // DONE is only reachable via VERIFYING; insert the hop rather than widening the
      // state machine, so "reached DONE without being verified" stays unrepresentable.
      if (input.to === TaskState.DONE && task.state === TaskState.WORKING) {
        path.push(TaskState.VERIFYING);
      }
      path.push(input.to);

      let current = task;
      for (const next of path) {
        if (!canTransition(current.state, next)) {
          throw new BridgeError(
            ErrorCode.ILLEGAL_TRANSITION,
            `${current.state} -> ${next} is not a legal transition ` +
              `(allowed: ${(ALLOWED_TRANSITIONS[current.state] ?? []).join(", ") || "none, terminal"})`,
            { task_id: input.task_id, from: current.state, to: next },
          );
        }
        const isTerminal = TERMINAL_STATES.has(next);
        const blockers =
          next === TaskState.BLOCKED && input.blocker ? [...current.blockers, input.blocker] : current.blockers;
        current = {
          ...current,
          state: next,
          blockers,
          updated_at: now,
          version: current.version + 1,
          ...(isTerminal ? { completed_at: now } : {}),
        };
        this.store.updateTask(current);
        this.store.appendEvent(
          {
            type: next === TaskState.BLOCKED ? EventType.TASK_BLOCKED : EventType.TASK_STATE_CHANGED,
            task_id: input.task_id,
            agent: input.agent,
            payload: {
              from: task.state === current.state ? task.state : undefined,
              to: next,
              reason: input.reason,
              ...(next === TaskState.BLOCKED && input.blocker ? { blocker: input.blocker } : {}),
            },
          },
          now,
        );
      }
      return current;
    });
  }

  /** Move to BLOCKED and record why. A blocker is an escalation, not a retry. */
  block(task_id: TaskId, agent: AgentId, reason: string): Task {
    return this.store.transaction(() => {
      const task = this.assertOwner(this.get(task_id), agent);
      this.assertTransition(task, TaskState.BLOCKED);
      const now = this.clock.now();
      const blocked: Task = {
        ...task,
        state: TaskState.BLOCKED,
        blockers: [...task.blockers, reason],
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(blocked);
      this.store.appendEvent(
        { type: EventType.TASK_BLOCKED, task_id, agent, payload: { reason, from: task.state } },
        now,
      );
      return blocked;
    });
  }

  unblock(task_id: TaskId, agent: AgentId, resolution: string): Task {
    return this.store.transaction(() => {
      const task = this.assertOwner(this.get(task_id), agent);
      if (task.state !== TaskState.BLOCKED) return task;
      const now = this.clock.now();
      const unblocked: Task = {
        ...task,
        state: TaskState.WORKING,
        blockers: [],
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(unblocked);
      this.store.appendEvent(
        { type: EventType.TASK_UNBLOCKED, task_id, agent, payload: { resolution } },
        now,
      );
      return unblocked;
    });
  }

  /**
   * Reset a FAILED task for another attempt. Deliberately explicit rather than automatic:
   * silent infinite retry is how multi-agent systems burn budget on an impossible task.
   */
  retry(task_id: TaskId, agent: AgentId, max_attempts: number): Task {
    return this.store.transaction(() => {
      const task = this.get(task_id);
      if (task.state !== TaskState.FAILED) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `only FAILED tasks can be retried; ${task_id} is ${task.state}`,
          { task_id, state: task.state },
        );
      }
      if (task.attempt + 1 >= max_attempts) {
        throw new BridgeError(
          ErrorCode.ILLEGAL_TRANSITION,
          `retry budget exhausted for ${task_id} (${task.attempt + 1}/${max_attempts})`,
          { task_id, attempt: task.attempt, max_attempts },
        );
      }
      const now = this.clock.now();
      const reset: Task = {
        ...task,
        state: TaskState.PENDING,
        owner: null,
        blockers: [],
        attempt: task.attempt + 1,
        updated_at: now,
        version: task.version + 1,
      };
      this.store.updateTask(reset);
      this.store.appendEvent(
        {
          type: EventType.TASK_STATE_CHANGED,
          task_id,
          agent,
          payload: { from: TaskState.FAILED, to: TaskState.PENDING, reason: "retry", attempt: reset.attempt },
        },
        now,
      );
      return reset;
    });
  }

  /* ---------------- status ---------------- */

  reportStatus(update: StatusUpdate): void {
    this.store.transaction(() => {
      this.assertOwner(this.get(update.task_id), update.agent);
      this.store.insertStatus(update);
      this.store.appendEvent(
        {
          type: EventType.STATUS_REPORTED,
          task_id: update.task_id,
          agent: update.agent,
          payload: {
            state: update.state,
            current_action: update.current_action,
            progress: update.progress,
            next_action: update.next_action,
            blockers: update.blockers,
          },
        },
        update.at,
      );
    });
  }

  latestStatus(task_id: TaskId): StatusUpdate | undefined {
    return this.store.latestStatus(task_id);
  }

  /* ---------------- guards ---------------- */

  private assertOwner(task: Task, agent: AgentId): Task {
    if (task.owner !== agent) {
      throw new BridgeError(
        ErrorCode.NOT_OWNER,
        `${agent} does not own ${task.task_id} (owner: ${task.owner ?? "none"})`,
        { task_id: task.task_id, owner: task.owner, caller: agent },
      );
    }
    return task;
  }

  private assertTransition(task: Task, to: TaskState): void {
    if (!canTransition(task.state, to)) {
      throw new BridgeError(
        ErrorCode.ILLEGAL_TRANSITION,
        `${task.state} -> ${to} is not a legal transition ` +
          `(allowed: ${(ALLOWED_TRANSITIONS[task.state] ?? []).join(", ") || "none, terminal"})`,
        { task_id: task.task_id, from: task.state, to },
      );
    }
  }
}
