import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AdapterHealth,
  AttemptTerminationKind,
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  EventType,
  LeaseState,
  TaskState,
  seededRandom,
  type AgentId,
  type AgentAdapter,
  type Deliverable,
  type TaskInvocation,
  type TaskSpec,
} from "@bridge/protocol";
import { describe, expect, it } from "vitest";

import { normalizeAttemptTelemetry } from "./attempt-service.js";
import { ManualClock } from "./clock.js";
import { ControlPlane } from "./control-plane.js";
import { Orchestrator } from "./orchestrator.js";

const RUN_ID = "run_0000000001";
const HANDLE = "thread_private_recovery_0";

function spec(scope = "recovery/**"): TaskSpec {
  return {
    objective: "resume one existing bounded task",
    scope: { paths: [scope] },
    dependencies: [],
    expected_deliverable: "one structured recovery result",
    verification_criteria: ["recovery fixture passes"],
    preferred_agent: "codex",
    deadline_ms: 5_000,
  };
}

function complete(invocation: TaskInvocation, at: number, agent: AgentId = "codex"): Deliverable {
  const verification = {
    kind: "test" as const,
    command: "recovery fixture",
    passed: true,
    exit_code: 0,
    summary: "passed",
  };
  return {
    task_id: invocation.task_id,
    agent,
    status: DeliverableStatus.COMPLETE,
    summary: "existing task resumed",
    changed_scope: [],
    artifacts: [],
    commit_or_diff: null,
    verification_performed: [verification.command],
    verification_results: [verification],
    remaining_risks: [],
    dependencies_unblocked: [],
    recommended_next_action: "none",
    at,
  };
}

interface AdapterBehavior {
  readonly fail?: boolean;
  readonly gate?: Promise<void>;
  readonly onStart?: () => void;
  readonly reportedHandle?: string | null;
  readonly capabilities?: readonly string[];
}

function recoveryAdapter(
  clock: ManualClock,
  behavior: AdapterBehavior = {},
  agent: AgentId = "codex",
) {
  const seen: TaskInvocation[] = [];
  let calls = 0;
  const adapter: AgentAdapter = {
    info: {
      agent,
      implementation: "recovery-fixture",
      version: "1.0.0",
      capabilities: behavior.capabilities ?? ["resume", "structured-deliverable", "token-usage"],
      max_concurrency: 1,
    },
    async health() {
      return { status: AdapterHealth.READY, checked_at: clock.now() };
    },
    async invoke(invocation, context) {
      calls += 1;
      seen.push(invocation);
      behavior.onStart?.();
      if (behavior.gate) await behavior.gate;
      const reported =
        behavior.reportedHandle === undefined
          ? invocation.previous_execution_handle
          : behavior.reportedHandle;
      if (reported) await context.saveExecutionHandle(reported);
      await context.reportTelemetry?.({
        runtime: "recovery-fixture",
        runtime_version: "1.0.0",
        model: "fixture-model",
        input_tokens: 13,
        output_tokens: 5,
        total_tokens: 18,
        turn_count: 1,
        prompt_bytes: 64,
      });
      if (behavior.fail) {
        throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "fixture runtime unavailable");
      }
      const verification = complete(invocation, clock.now(), agent).verification_results[0]!;
      await context.recordVerification(verification);
      return complete(invocation, clock.now(), agent);
    },
    async cancel() {},
  };
  return { adapter, seen, calls: () => calls };
}

interface StrandedOptions {
  readonly handle?: string | null;
  readonly keepLease?: boolean;
  readonly manager?: AgentId;
  readonly worker?: AgentId;
}

function createStranded(
  cp: ControlPlane,
  options: StrandedOptions = {},
) {
  const manager = options.manager ?? "claude";
  const worker = options.worker ?? "codex";
  const parent = cp.tasks.create({
    spec: { ...spec("parent/**"), preferred_agent: manager },
    created_by: manager,
    run_id: RUN_ID,
  });
  cp.tasks.claim(parent.task_id, manager);
  const child = cp.tasks.create({
    spec: { ...spec(), preferred_agent: worker },
    created_by: manager,
    parent_task_id: parent.task_id,
  });
  cp.tasks.claim(child.task_id, worker);
  const lease = cp.leases.acquire({
    task_id: child.task_id,
    holder: worker,
    scope: child.spec.scope,
    ttl_ms: 60_000,
  });
  cp.tasks.transition({ task_id: child.task_id, agent: worker, to: TaskState.WORKING });
  cp.attempts.start(child.task_id, 0, worker);
  const handle = options.handle === undefined ? HANDLE : options.handle;
  if (handle) cp.attempts.saveHandle(child.task_id, 0, worker, handle);
  if (!options.keepLease) cp.leases.release(lease.lease_id, worker);
  cp.tasks.block(child.task_id, worker, "runtime interrupted");
  return { parent, child: cp.tasks.get(child.task_id), oldLease: lease };
}

function setup(seed: number, behavior: AdapterBehavior = {}) {
  const clock = new ManualClock(10_000);
  const cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-recovery",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(seed),
  });
  const fixture = recoveryAdapter(clock, behavior);
  cp.adapters.register(fixture.adapter);
  return { cp, clock, fixture, orchestrator: new Orchestrator(cp) };
}

function setupDelegated(seed: number, workerBehavior: AdapterBehavior = {}) {
  const clock = new ManualClock(30_000);
  const cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-delegated-recovery",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(seed),
  });
  const managerFixture = recoveryAdapter(clock, {}, "codex");
  const workerFixture = recoveryAdapter(clock, workerBehavior, "claude");
  cp.adapters.register(managerFixture.adapter);
  cp.adapters.register(workerFixture.adapter);
  const stranded = createStranded(cp, { manager: "codex", worker: "claude" });
  return {
    cp,
    clock,
    managerFixture,
    workerFixture,
    orchestrator: new Orchestrator(cp),
    ...stranded,
  };
}

function corruptPersistedRun(cp: ControlPlane, task_id: string, run_id: string): void {
  const store = cp.store as unknown as {
    db: { prepare(sql: string): { run(...values: unknown[]): unknown } };
  };
  store.db.prepare("UPDATE tasks SET run_id = ? WHERE task_id = ?").run(run_id, task_id);
}

function strandExistingTask(
  cp: ControlPlane,
  task_id: string,
  owner: AgentId,
  handle = `${HANDLE}_nested`,
): void {
  const task = cp.tasks.get(task_id);
  cp.tasks.claim(task_id, owner);
  const lease = cp.leases.acquire({
    task_id,
    holder: owner,
    scope: task.spec.scope,
    ttl_ms: 60_000,
  });
  cp.tasks.transition({ task_id, agent: owner, to: TaskState.WORKING });
  cp.attempts.start(task_id, 0, owner);
  cp.attempts.saveHandle(task_id, 0, owner, handle);
  cp.leases.release(lease.lease_id, owner);
  cp.tasks.block(task_id, owner, "runtime interrupted");
}

describe("stranded task recovery", () => {
  it("1. lets the owner recover its own stranded task", async () => {
    const { cp, orchestrator, fixture } = setup(901);
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.error).toBeNull();
    expect(fixture.calls()).toBe(1);
    cp.close();
  });

  it("2. rejects a parent attempting to recover another agent's child", async () => {
    const { cp, orchestrator, fixture } = setup(902);
    const { child } = createStranded(cp);
    await expect(
      orchestrator.resumeTask({ task_id: child.task_id, requested_by: "claude" }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_OWNER });
    expect(fixture.calls()).toBe(0);
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });

  it("3. rejects a stranded task without a persisted handle", async () => {
    const { cp, orchestrator } = setup(903);
    const { child } = createStranded(cp, { handle: null });
    await expect(
      orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });

  it("4. rejects live task leases and overlapping live execution scopes", async () => {
    const first = setup(904);
    const live = createStranded(first.cp, { keepLease: true });
    await expect(
      first.orchestrator.resumeTask({ task_id: live.child.task_id, requested_by: "codex" }),
    ).rejects.toMatchObject({ code: ErrorCode.SCOPE_CONFLICT });
    first.cp.close();

    const second = setup(905);
    const { child } = createStranded(second.cp);
    const competing = second.cp.tasks.create({ spec: spec(), created_by: "claude" });
    second.cp.tasks.claim(competing.task_id, "claude");
    second.cp.leases.acquire({
      task_id: competing.task_id,
      holder: "claude",
      scope: competing.spec.scope,
      ttl_ms: 60_000,
    });
    await expect(
      second.orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" }),
    ).rejects.toMatchObject({ code: ErrorCode.SCOPE_CONFLICT });
    expect(second.cp.tasks.get(child.task_id).attempt).toBe(0);
    second.cp.close();
  });

  it("5. rejects terminal tasks", async () => {
    const { cp, orchestrator } = setup(906);
    const { child } = createStranded(cp);
    cp.tasks.transition({ task_id: child.task_id, agent: "codex", to: TaskState.FAILED });
    await expect(
      orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" }),
    ).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_TRANSITION });
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });

  it("6. creates a new attempt without creating a new task", async () => {
    const { cp, orchestrator } = setup(907);
    const { child } = createStranded(cp);
    const count = cp.tasks.list().length;
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.recovered_attempt).toBe(1);
    expect(cp.tasks.list()).toHaveLength(count);
    expect(cp.tasks.get(child.task_id).attempt).toBe(1);
    cp.close();
  });

  it("7. persists resumed_from_attempt on the new attempt", async () => {
    const { cp, orchestrator } = setup(908);
    const { child } = createStranded(cp);
    await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(cp.attempts.get(child.task_id, 1)).toMatchObject({ resumed_from_attempt: 0 });
    expect(cp.attempts.get(child.task_id, 0)?.outcome).toBe("interrupted");
    cp.close();
  });

  it("8. passes and confirms the exact same execution handle internally", async () => {
    const { cp, orchestrator, fixture } = setup(909);
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(fixture.seen[0]).toMatchObject({
      previous_execution_handle: HANDLE,
      resume_required: true,
      attempt: 1,
    });
    expect(outcome.same_execution_handle).toBe(true);
    cp.close();
  });

  it("rejects a replacement handle without overwriting the persisted recovery pointer", async () => {
    const { cp, orchestrator } = setup(9091, { reportedHandle: "thread_replacement" });
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.error).toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
    expect(outcome.same_execution_handle).toBe(false);
    expect(cp.tasks.get(child.task_id).state).toBe(TaskState.BLOCKED);
    expect(cp.attempts.get(child.task_id, 1)?.execution_handle).toBe(HANDLE);
    cp.close();
  });

  it("9. does not export the raw execution handle in outcome, events, or telemetry", async () => {
    const { cp, orchestrator } = setup(910);
    const { child } = createStranded(cp);
    const cursor = cp.lastEventId();
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    const exported = JSON.stringify({
      outcome,
      events: cp.events({ after: cursor, task_id: child.task_id }),
      telemetry: cp.attempts.queryTelemetry({ task_id: child.task_id, attempt: 1 }),
    });
    expect(exported).not.toContain(HANDLE);
    expect(outcome.same_execution_handle).toBe(true);
    cp.close();
  });

  it("10. acquires and releases one fresh recovery lease", async () => {
    const { cp, orchestrator } = setup(911);
    const { child, oldLease } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.fresh_lease_id).not.toBe(oldLease.lease_id);
    expect(outcome.lease_state).toBe(LeaseState.RELEASED);
    expect(cp.leases.listLive()).toHaveLength(0);
    const events = cp.events({ task_id: child.task_id });
    expect(events.filter((event) => event.type === "lease.acquired")).toHaveLength(2);
    expect(events.filter((event) => event.type === "lease.released")).toHaveLength(2);
    cp.close();
  });

  it("11. joins a duplicate idempotent resume without spawning another attempt", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const invoked = new Promise<void>((resolve) => (started = resolve));
    const { cp, orchestrator, fixture } = setup(912, { gate, onStart: started });
    const { child } = createStranded(cp);
    const first = orchestrator.resumeTask({
      task_id: child.task_id,
      requested_by: "codex",
      idempotency_key: "resume-duplicate",
    });
    await invoked;
    const second = orchestrator.resumeTask({
      task_id: child.task_id,
      requested_by: "codex",
      idempotency_key: "resume-duplicate",
    });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.recovered_attempt).toBe(two.recovered_attempt);
    expect(fixture.calls()).toBe(1);
    expect(cp.attempts.list(child.task_id)).toHaveLength(2);
    cp.close();
  });

  it("12. serializes a cross-control-plane resume race to one active attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-recovery-race-"));
    const db = join(dir, "bridge.db");
    const clock = new ManualClock(20_000);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const invoked = new Promise<void>((resolve) => (started = resolve));
    const cp1 = ControlPlane.open({
      workspaceRoot: dir,
      databasePath: db,
      clock,
      rng: seededRandom(913),
    });
    const firstFixture = recoveryAdapter(clock, { gate, onStart: started });
    cp1.adapters.register(firstFixture.adapter);
    const { child } = createStranded(cp1);
    const cp2 = ControlPlane.open({
      workspaceRoot: dir,
      databasePath: db,
      clock,
      rng: seededRandom(914),
    });
    cp2.adapters.register(recoveryAdapter(clock).adapter);
    try {
      const first = new Orchestrator(cp1).resumeTask({
        task_id: child.task_id,
        requested_by: "codex",
        idempotency_key: "race-first",
      });
      await invoked;
      await expect(
        new Orchestrator(cp2).resumeTask({
          task_id: child.task_id,
          requested_by: "codex",
          idempotency_key: "race-second",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.SCOPE_CONFLICT });
      expect(cp1.attempts.list(child.task_id)).toHaveLength(2);
      release();
      await first;
      expect(firstFixture.calls()).toBe(1);
    } finally {
      cp2.close();
      cp1.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("13. returns a failed resume to recoverable BLOCKED state", async () => {
    const { cp, orchestrator } = setup(915, { fail: true });
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.error).toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
    expect(outcome.state).toBe(TaskState.BLOCKED);
    expect(outcome.lease_state).toBe(LeaseState.RELEASED);
    expect(cp.attempts.get(child.task_id, 1)).toMatchObject({
      resumed_from_attempt: 0,
      outcome: ErrorCode.ADAPTER_FAILURE,
    });
    expect(cp.events({ task_id: child.task_id }).at(-1)?.type).toBe("lease.released");
    expect(cp.events({ task_id: child.task_id }).some((event) => event.type === "resume.failed")).toBe(true);
    cp.close();
  });

  it("14. completes the same task after a successful resume", async () => {
    const { cp, orchestrator } = setup(916);
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(outcome.task_id).toBe(child.task_id);
    expect(outcome.state).toBe(TaskState.DONE);
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
    expect(cp.events({ task_id: child.task_id }).some((event) => event.type === "resume.succeeded")).toBe(true);
    cp.close();
  });

  it("15. keeps one final telemetry record per attempt without copying attempt zero", async () => {
    const { cp, clock, orchestrator } = setup(917);
    const { child } = createStranded(cp);
    cp.attempts.recordTelemetry(
      normalizeAttemptTelemetry({
        task_id: child.task_id,
        run_id: child.run_id,
        parent_task_id: child.parent_task_id,
        delegation_depth: child.delegation_depth,
        attempt: 0,
        agent: "codex",
        orchestration_started_at: 9_000,
        observed_runtime_started_at: 9_100,
        observed_runtime_ended_at: 9_200,
        completed_at: clock.now(),
        input_artifact_count: 0,
        input_artifact_bytes: 0,
        termination_kind: AttemptTerminationKind.CRASH,
        update: {},
      }),
    );
    await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    const telemetry = cp.attempts.queryTelemetry({ task_id: child.task_id });
    expect(telemetry).toHaveLength(2);
    expect(telemetry.map((record) => [record.attempt, record.resumed_from_attempt])).toEqual([
      [0, null],
      [1, 0],
    ]);
    expect(telemetry[0]?.total_tokens).toBeNull();
    expect(telemetry[1]).toMatchObject({ input_tokens: 13, output_tokens: 5, total_tokens: 18 });
    cp.close();
  });

  it("16. preserves run, parent, depth, owner, objective, and scope", async () => {
    const { cp, orchestrator } = setup(918);
    const { child } = createStranded(cp);
    const before = cp.tasks.get(child.task_id);
    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    const after = cp.tasks.get(child.task_id);
    expect(outcome).toMatchObject({
      task_id: before.task_id,
      run_id: before.run_id,
      parent_task_id: before.parent_task_id,
      delegation_depth: before.delegation_depth,
      owner: before.owner,
    });
    expect(after.spec.objective).toBe(before.spec.objective);
    expect(after.spec.scope).toEqual(before.spec.scope);
    cp.close();
  });

  it("reuses the original durable input artifacts and accounts for their bytes", async () => {
    const { cp, clock, orchestrator, fixture } = setup(9181);
    const { child } = createStranded(cp);
    const input = cp.artifacts.publish({
      task_id: child.task_id,
      produced_by: "claude",
      kind: "json",
      name: "recovery-input.json",
      media_type: "application/json",
      inline: '{"proof":true}',
    });
    cp.store.appendEvent(
      {
        type: EventType.DELEGATION_REQUESTED,
        task_id: child.task_id,
        agent: "claude",
        payload: { input_artifacts: [input.artifact_id] },
      },
      clock.now(),
    );

    const outcome = await orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" });
    expect(fixture.seen[0]?.inputs.map((artifact) => artifact.artifact_id)).toEqual([
      input.artifact_id,
    ]);
    expect(outcome.telemetry).toMatchObject({
      input_artifact_count: 1,
      input_artifact_bytes: input.bytes,
    });
    cp.close();
  });

  it("rejects adapters that do not explicitly support persisted-session resume", async () => {
    const { cp, orchestrator } = setup(919, { capabilities: ["structured-deliverable"] });
    const { child } = createStranded(cp);
    await expect(
      orchestrator.resumeTask({ task_id: child.task_id, requested_by: "codex" }),
    ).rejects.toMatchObject({ code: ErrorCode.UNIMPLEMENTED });
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });
});

describe("manager-authorized delegated recovery", () => {
  it("1. lets a direct manager recover its own delegated child", async () => {
    const { cp, orchestrator, child } = setupDelegated(1001);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.error).toBeNull();
    expect(outcome.state).toBe(TaskState.DONE);
    cp.close();
  });

  it("2. keeps child ownership bound to the worker", async () => {
    const { cp, orchestrator, child } = setupDelegated(1002);
    expect(child.owner).toBe("claude");
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.owner).toBe("claude");
    expect(cp.tasks.get(child.task_id).owner).toBe("claude");
    cp.close();
  });

  it("3. invokes the worker adapter and never the manager adapter", async () => {
    const { cp, orchestrator, child, managerFixture, workerFixture } = setupDelegated(1003);
    await orchestrator.resumeDelegatedTask({ task_id: child.task_id, requested_by: "codex" });
    expect(workerFixture.calls()).toBe(1);
    expect(managerFixture.calls()).toBe(0);
    cp.close();
  });

  it("4. resumes the exact persisted execution handle", async () => {
    const { cp, orchestrator, child, workerFixture } = setupDelegated(1004);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(workerFixture.seen[0]).toMatchObject({
      previous_execution_handle: HANDLE,
      resume_required: true,
    });
    expect(outcome.same_execution_handle).toBe(true);
    cp.close();
  });

  it("5. retains the same task id without creating a replacement", async () => {
    const { cp, orchestrator, child } = setupDelegated(1005);
    const taskCount = cp.tasks.list().length;
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.task_id).toBe(child.task_id);
    expect(cp.tasks.list()).toHaveLength(taskCount);
    cp.close();
  });

  it("6. increments the child attempt exactly once", async () => {
    const { cp, orchestrator, child } = setupDelegated(1006);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.recovered_attempt).toBe(1);
    expect(cp.tasks.get(child.task_id).attempt).toBe(1);
    expect(cp.attempts.list(child.task_id)).toHaveLength(2);
    cp.close();
  });

  it("7. records the adjacent resumed_from_attempt", async () => {
    const { cp, orchestrator, child } = setupDelegated(1007);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.resumed_from_attempt).toBe(0);
    expect(cp.attempts.get(child.task_id, 1)?.resumed_from_attempt).toBe(0);
    cp.close();
  });

  it("8. assigns the fresh recovery lease to the child owner", async () => {
    const { cp, orchestrator, child } = setupDelegated(1008);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(cp.store.getLease(outcome.fresh_lease_id)?.holder).toBe("claude");
    cp.close();
  });

  it("9. releases the worker-owned recovery lease", async () => {
    const { cp, orchestrator, child } = setupDelegated(1009);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.lease_state).toBe(LeaseState.RELEASED);
    expect(cp.leases.listLive()).toHaveLength(0);
    cp.close();
  });

  it("10. records recovery telemetry under the child owner", async () => {
    const { cp, orchestrator, child } = setupDelegated(1010);
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome.telemetry?.agent).toBe("claude");
    expect(cp.attempts.queryTelemetry({ task_id: child.task_id, attempt: 1 })[0]?.agent).toBe(
      "claude",
    );
    cp.close();
  });

  it("11. never exports the raw persisted handle", async () => {
    const { cp, orchestrator, child } = setupDelegated(1011);
    const cursor = cp.lastEventId();
    const outcome = await orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    const exported = JSON.stringify({
      outcome,
      events: cp.events({ after: cursor, task_id: child.task_id }),
      telemetry: cp.attempts.queryTelemetry({ task_id: child.task_id, attempt: 1 }),
    });
    expect(exported).not.toContain(HANDLE);
    cp.close();
  });

  it("12. rejects an unrelated manager", async () => {
    const { cp, orchestrator, child, workerFixture } = setupDelegated(1012);
    await expect(
      orchestrator.resumeDelegatedTask({
        task_id: child.task_id,
        requested_by: "supervisor",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_OWNER });
    expect(workerFixture.calls()).toBe(0);
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });

  it("13. rejects a recoverable task that is not a delegated child", async () => {
    const { cp, orchestrator, workerFixture } = setupDelegated(1013);
    const unrelated = cp.tasks.create({
      spec: { ...spec("unrelated/**"), preferred_agent: "claude" },
      created_by: "codex",
      run_id: "run_0000000013",
    });
    strandExistingTask(cp, unrelated.task_id, "claude");
    await expect(
      orchestrator.resumeDelegatedTask({
        task_id: unrelated.task_id,
        requested_by: "codex",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(workerFixture.calls()).toBe(0);
    expect(cp.tasks.get(unrelated.task_id).attempt).toBe(0);
    cp.close();
  });

  it("14. rejects a child whose persisted direct-parent run lineage is wrong", async () => {
    const { cp, orchestrator, child, workerFixture } = setupDelegated(1014);
    corruptPersistedRun(cp, child.task_id, "run_0000000014");
    await expect(
      orchestrator.resumeDelegatedTask({
        task_id: child.task_id,
        requested_by: "codex",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(workerFixture.calls()).toBe(0);
    expect(cp.tasks.get(child.task_id).attempt).toBe(0);
    cp.close();
  });

  it("15. rejects an ancestor that does not own the grandchild's direct parent", async () => {
    const { cp, orchestrator, child, workerFixture } = setupDelegated(1015);
    const grandchild = cp.tasks.create({
      spec: { ...spec("grandchild/**"), preferred_agent: "claude" },
      created_by: "claude",
      parent_task_id: child.task_id,
    });
    strandExistingTask(cp, grandchild.task_id, "claude");
    await expect(
      orchestrator.resumeDelegatedTask({
        task_id: grandchild.task_id,
        requested_by: "codex",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_OWNER });
    expect(workerFixture.calls()).toBe(0);
    expect(cp.tasks.get(grandchild.task_id).attempt).toBe(0);
    cp.close();
  });

  it("16. joins duplicate idempotent manager requests without another attempt", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const invoked = new Promise<void>((resolve) => (started = resolve));
    const { cp, orchestrator, child, workerFixture } = setupDelegated(1016, {
      gate,
      onStart: started,
    });
    const first = orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
      idempotency_key: "delegated-resume-once",
    });
    await invoked;
    const second = orchestrator.resumeDelegatedTask({
      task_id: child.task_id,
      requested_by: "codex",
      idempotency_key: "delegated-resume-once",
    });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.recovered_attempt).toBe(two.recovered_attempt);
    expect(workerFixture.calls()).toBe(1);
    expect(cp.attempts.list(child.task_id)).toHaveLength(2);
    cp.close();
  });

  it("17. leaves direct owner bridge_resume_task behavior unchanged", async () => {
    const { cp, orchestrator, fixture } = setup(1017);
    const { child } = createStranded(cp);
    const outcome = await orchestrator.resumeTask({
      task_id: child.task_id,
      requested_by: "codex",
    });
    expect(outcome).toMatchObject({
      task_id: child.task_id,
      owner: "codex",
      recovered_attempt: 1,
      resumed_from_attempt: 0,
      same_execution_handle: true,
      state: TaskState.DONE,
    });
    expect(fixture.calls()).toBe(1);
    cp.close();
  });
});
