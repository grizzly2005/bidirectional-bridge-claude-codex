/**
 * `ClaudeWorkSession` — the Claude-facing API of the coordination system.
 *
 * This is the case the adapter interface does not cover: Claude is *already* the running
 * process (a Claude Code or Cowork turn) and needs to participate in the bridge as a
 * first-class agent — claim a task, hold a lease, publish artifacts, submit a deliverable —
 * without anything "invoking" it.
 *
 * It is a thin, guard-railed wrapper over the control plane. It adds no state of its own
 * beyond the ids of what it currently holds, so a crashed session leaves nothing behind
 * except a lease that will expire on its own.
 */

import {
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  matchesGlob,
  type AgentId,
  type ArtifactId,
  type Deliverable,
  type Lease,
  type Task,
  type TaskId,
  type TaskSpec,
  type VerificationResult,
  type WriteScope,
} from "@bridge/protocol";
import type { ArtifactRegistry, ControlPlane } from "@bridge/control-plane";

export interface ClaudeWorkSessionOptions {
  readonly controlPlane: ControlPlane;
  readonly agent?: AgentId;
  /** Lease lifetime for `beginWork`. Default 15 minutes. */
  readonly defaultLeaseTtlMs?: number;
}

export interface BeginWorkResult {
  readonly task: Task;
  readonly lease: Lease;
}

const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export class ClaudeWorkSession {
  private readonly cp: ControlPlane;
  private readonly agent: AgentId;
  private readonly leaseTtlMs: number;
  /** task_id -> lease_id for work this session currently holds. */
  private readonly held = new Map<TaskId, string>();

  constructor(options: ClaudeWorkSessionOptions) {
    this.cp = options.controlPlane;
    this.agent = options.agent ?? "claude";
    this.leaseTtlMs = options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  get agentId(): AgentId {
    return this.agent;
  }

  private get artifacts(): ArtifactRegistry {
    return this.cp.artifacts;
  }

  /* ---------------- discovery ---------------- */

  /**
   * What may I safely pick up? Tasks that are unowned, dependency-satisfied, and whose
   * scope does not collide with a live lease held by another agent.
   *
   * Checking the lease conflict here — not just at claim time — is what stops Claude from
   * claiming a task it would immediately be unable to start because codex is mid-write in
   * the same files.
   */
  availableWork(): Task[] {
    return this.cp.tasks
      .readyTasks()
      .filter((t) => this.cp.leases.findConflicts(t.spec.scope, this.agent).length === 0);
  }

  /** Everything currently owned by this agent, in any non-terminal state. */
  myTasks(): Task[] {
    return this.cp.tasks
      .list({ owner: this.agent })
      .filter((t) => !["DONE", "FAILED", "CANCELLED"].includes(t.state));
  }

  /** Who owns what right now — the check to run before touching any file. */
  whoOwns(path: string): Array<{ holder: AgentId; task_id: TaskId; lease_id: string }> {
    return this.cp.leases
      .listLive()
      .filter((l) => l.scope.paths.some((p) => pathInGlob(path, p)))
      .map((l) => ({ holder: l.holder, task_id: l.task_id, lease_id: l.lease_id }));
  }

  /* ---------------- task creation and delegation ---------------- */

  /** Register work Claude intends to do itself. */
  declareTask(spec: TaskSpec, idempotency_key?: string): Task {
    return this.cp.tasks.create({
      spec,
      created_by: this.agent,
      ...(idempotency_key ? { idempotency_key } : {}),
    });
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Claim a task and take the write lease over its scope in one step.
   *
   * If the lease cannot be taken the claim is rolled back, so a failed start never leaves
   * a task owned-but-unstartable — which would look to codex like Claude is working on it.
   */
  beginWork(task_id: TaskId, ttl_ms = this.leaseTtlMs): BeginWorkResult {
    const claimed = this.cp.tasks.claim(task_id, this.agent);
    let lease: Lease;
    try {
      lease = this.cp.leases.acquire({
        task_id,
        holder: this.agent,
        scope: claimed.spec.scope,
        ttl_ms,
      });
    } catch (err) {
      try {
        this.cp.tasks.release(task_id, this.agent, "could not acquire write lease");
      } catch {
        /* surfacing the lease conflict matters more than the rollback failing */
      }
      throw err;
    }

    const task = this.cp.tasks.transition({ task_id, agent: this.agent, to: TaskState.WORKING });
    this.held.set(task_id, lease.lease_id);
    return { task, lease };
  }

  /** Throws unless this session may write `path` under the task's lease. */
  assertCanWrite(task_id: TaskId, path: string): void {
    const lease_id = this.held.get(task_id);
    if (!lease_id) {
      throw new BridgeError(
        ErrorCode.LEASE_INVALID,
        `this session holds no lease for ${task_id}; call beginWork first`,
        { task_id },
      );
    }
    this.cp.leases.assertWritable(lease_id, this.agent, path);
  }

  /** Extend the lease on long work, so it does not lapse mid-edit. */
  renewLease(task_id: TaskId, ttl_ms = this.leaseTtlMs): Lease {
    const lease_id = this.held.get(task_id);
    if (!lease_id) {
      throw new BridgeError(ErrorCode.LEASE_INVALID, `no lease held for ${task_id}`, { task_id });
    }
    return this.cp.leases.renew(lease_id, this.agent, ttl_ms);
  }

  /** Publish progress. Reserve this for milestones — not every internal step. */
  report(
    task_id: TaskId,
    current_action: string,
    next_action: string,
    progress: number | null = null,
  ): void {
    const task = this.cp.tasks.get(task_id);
    this.cp.tasks.reportStatus({
      task_id,
      agent: this.agent,
      state: task.state,
      current_action,
      owned_scope: task.spec.scope.paths,
      progress,
      artifacts: this.artifacts.list(task_id).map((a) => a.artifact_id),
      blockers: task.blockers,
      next_action,
      at: this.cp.clock.now(),
    });
  }

  publishArtifact(
    task_id: TaskId,
    name: string,
    content: string,
    kind: "report" | "json" | "log" | "diff" | "file" | "test_result" = "report",
  ): ArtifactId {
    return this.artifacts.publish({ task_id, produced_by: this.agent, kind, name, inline: content })
      .artifact_id;
  }

  publishFileArtifact(
    task_id: TaskId,
    name: string,
    repoRelativePath: string,
    kind: "file" | "diff" | "log" | "report" = "file",
  ): ArtifactId {
    return this.artifacts.publish({
      task_id,
      produced_by: this.agent,
      kind,
      name,
      path: repoRelativePath,
    }).artifact_id;
  }

  /** Record a check that actually ran. Callers must pass the real exit code. */
  recordVerification(task_id: TaskId, result: VerificationResult): void {
    this.cp.deliverables.recordVerification(task_id, this.agent, result);
  }

  /** Escalate rather than guess. Moves the task to BLOCKED with a reason. */
  block(task_id: TaskId, reason: string): Task {
    return this.cp.tasks.block(task_id, this.agent, reason);
  }

  /**
   * Ask another agent for something instead of doing it yourself.
   *
   * Returns the created task id; it is recorded as a dependency of `from_task` so the
   * dependency gate stops Claude finishing work that needs codex's part first.
   */
  requestFromAgent(from_task: TaskId, to: AgentId, spec: TaskSpec): TaskId {
    const requested = this.cp.tasks.create({ spec: { ...spec, preferred_agent: to }, created_by: this.agent });
    this.cp.tasks.addDependency(from_task, requested.task_id, this.agent);
    return requested.task_id;
  }

  /* ---------------- completion ---------------- */

  /**
   * Submit the deliverable and release the lease.
   *
   * The lease is released in a `finally`, so a rejected deliverable — the honesty gate
   * refusing COMPLETE without evidence, say — still frees the scope for the other agent.
   */
  complete(
    task_id: TaskId,
    input: {
      summary: string;
      artifacts?: readonly ArtifactId[];
      changed_scope?: readonly string[];
      commit_or_diff?: string | null;
      verification_results?: readonly VerificationResult[];
      remaining_risks?: readonly string[];
      recommended_next_action?: string;
      status?: DeliverableStatus;
    },
  ): Deliverable {
    const task = this.cp.tasks.get(task_id);
    const evidence = input.verification_results ?? this.cp.deliverables.listVerifications(task_id);
    const status =
      input.status ??
      (evidence.length > 0 && evidence.every((v) => v.passed)
        ? DeliverableStatus.COMPLETE
        : DeliverableStatus.PARTIAL);

    const deliverable: Deliverable = {
      task_id,
      agent: this.agent,
      status,
      summary: input.summary,
      changed_scope: input.changed_scope ?? task.spec.scope.paths,
      artifacts: input.artifacts ?? this.artifacts.list(task_id).map((a) => a.artifact_id),
      commit_or_diff: input.commit_or_diff ?? null,
      verification_performed: evidence.map((v) => v.command),
      verification_results: evidence,
      remaining_risks: input.remaining_risks ?? [],
      dependencies_unblocked: this.cp.store.getDependents(task_id),
      recommended_next_action: input.recommended_next_action ?? "review the artifacts",
      at: this.cp.clock.now(),
    };

    try {
      return this.cp.deliverables.submit(deliverable);
    } finally {
      this.releaseLease(task_id);
    }
  }

  /** Abandon a task, freeing both ownership and scope for the other agent. */
  abandon(task_id: TaskId, reason: string): Task {
    try {
      return this.cp.tasks.release(task_id, this.agent, reason);
    } finally {
      this.releaseLease(task_id);
    }
  }

  private releaseLease(task_id: TaskId): void {
    const lease_id = this.held.get(task_id);
    if (!lease_id) return;
    this.held.delete(task_id);
    try {
      this.cp.leases.release(lease_id, this.agent);
    } catch {
      // Already released or expired: the scope is free either way, which is the goal.
    }
  }

  /** Release every lease this session holds. Call on shutdown. */
  releaseAll(): void {
    for (const task_id of [...this.held.keys()]) this.releaseLease(task_id);
  }
}

/**
 * Path/glob check for `whoOwns`. Delegates to the protocol implementation rather than
 * re-deriving it: a second glob implementation that disagreed by even one edge case would
 * let an agent write into a scope the lease manager considers owned.
 */
function pathInGlob(path: string, glob: string): boolean {
  return matchesGlob(path, glob);
}
