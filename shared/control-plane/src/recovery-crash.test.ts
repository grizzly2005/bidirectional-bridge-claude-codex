import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeError, ErrorCode, EventType, LeaseState, TaskState,
  type AgentAdapter, type TaskInvocation, type TaskSpec,
} from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { Orchestrator } from "./orchestrator.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup(persistent = false, strict = false) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-recovery-crash-"));
  const db = persistent ? join(dir, "fixture.db") : ":memory:";
  cleanup.push(() => {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture directory");
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const cp = ControlPlane.open({ workspaceRoot: dir, databasePath: db });
  cleanup.push(() => cp.close());
  const spec: TaskSpec = { objective: "resume crash fixture", scope: { paths: ["recovery/**"] },
    dependencies: [], expected_deliverable: "result", verification_criteria: ["fixture"],
    deadline_ms: 5_000, telemetry_mode: strict ? "strict" : "operational" };
  const task = cp.tasks.create({ spec, created_by: "codex" });
  cp.tasks.claim(task.task_id, "codex");
  cp.tasks.transition({ task_id: task.task_id, agent: "codex", to: TaskState.WORKING });
  cp.attempts.start(task.task_id, 0, "codex");
  cp.attempts.saveHandle(task.task_id, 0, "codex", "fixture_existing_session");
  cp.tasks.block(task.task_id, "codex", "fixture interruption");
  const request = { task_id: task.task_id, requested_by: "codex", idempotency_key: "fixture-resume" };
  return { cp, dir, db, task, request, orchestrator: new Orchestrator(cp) };
}

function complete(invocation: TaskInvocation) {
  const check = { kind: "test" as const, command: "fixture", passed: true, exit_code: 0, summary: "checked" };
  return { task_id: invocation.task_id, agent: "codex", status: "COMPLETE" as const, summary: "resumed fixture",
    changed_scope: [], artifacts: [], commit_or_diff: null, verification_performed: [check.command],
    verification_results: [check], remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: Date.now() };
}

function register(cp: ControlPlane, invoke: AgentAdapter["invoke"], native = false) {
  cp.adapters.register({ info: { agent: "codex", implementation: "local-crash-fixture", version: "1.0.0",
    max_concurrency: 1, capabilities: native ? ["resume", "stop-confirmation"] : ["resume"] }, invoke,
    health: async () => ({ status: "READY", checked_at: Date.now() }), cancel: async () => {} });
}

/** A fixture process exits after durable preparation, without calling any model or CLI. */
function crashPrepared(dir: string, db: string, taskId: string, phase: "QUEUED" | "RUNNING" | "QUARANTINED") {
  const entry = pathToFileURL(resolve("shared/control-plane/dist/index.js")).href;
  const source = `
    import { ControlPlane, Orchestrator } from ${JSON.stringify(entry)};
    const [workspaceRoot, databasePath, task_id, phase] = process.argv.slice(1);
    const cp = ControlPlane.open({ workspaceRoot, databasePath });
    cp.adapters.register({ info: { agent: "codex", implementation: "crash-fixture", version: "1.0.0",
      capabilities: ["resume"], max_concurrency: 1 }, health: async () => ({ status: "READY", checked_at: Date.now() }),
      invoke: async () => { throw new Error("A preparation fixture must not invoke"); }, cancel: async () => {} });
    new Orchestrator(cp).prepareRecovery({ task_id, requested_by: "codex", idempotency_key: "fixture-resume" }, "owner");
    const execution = cp.store.getExecution(task_id);
    if (phase !== "QUEUED") cp.executions.update(execution, { phase, runtime_stop_confirmed: false, admitted_at: Date.now() });
    if (phase === "QUARANTINED") cp.leases.quarantine(execution.lease_id, "codex");
    process.exit(57);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, dir, db, taskId, phase],
    { windowsHide: true, timeout: 10_000, encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(57);
}

describe("recovery crash and replay invariants", () => {
  it.each(["RUNNING", "QUARANTINED"] as const)("never relaunches or invents stop evidence while replaying %s", async phase => {
    const { cp, dir, db, task, request, orchestrator } = setup(true);
    let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation); });
    crashPrepared(dir, db, task.task_id, phase);
    const execution = cp.store.getExecution(task.task_id)!;
    const lease = cp.store.getLease(execution.lease_id!)!;
    const cursor = cp.lastEventId();
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.OPERATION_IN_PROGRESS });
    expect(calls).toBe(0);
    expect(cp.store.getExecution(task.task_id)).toMatchObject({ ...execution, phase: "QUARANTINED", updated_at: expect.any(Number) });
    expect(cp.store.getLease(lease.lease_id)).toEqual({ ...lease, state: LeaseState.QUARANTINED });
    expect(cp.attempts.get(task.task_id, 1)).toBeUndefined();
    expect(cp.events({ after: cursor }).map(event => event.type)).toEqual(
      phase === "RUNNING" ? [EventType.LEASE_QUARANTINED] : []);
    expect(execution.runtime_stop_confirmed).toBe(false);
    const quarantined = cp.store.getExecution(task.task_id);
    const frozenCursor = cp.lastEventId();
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.OPERATION_IN_PROGRESS });
    expect(cp.store.getExecution(task.task_id)).toEqual(quarantined);
    expect(cp.lastEventId()).toBe(frozenCursor);
    expect(calls).toBe(0);
  });

  it("closes only a dead prelaunch reservation and releases its unused lease without invoking", async () => {
    const { cp, dir, db, task, request, orchestrator } = setup(true);
    let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation); });
    crashPrepared(dir, db, task.task_id, "QUEUED");
    const leaseId = cp.store.getExecution(task.task_id)!.lease_id!;
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
    expect(cp.store.getExecution(task.task_id)).toMatchObject({ phase: "STOPPED", runtime_stop_confirmed: true });
    expect(cp.store.getLease(leaseId)?.state).toBe(LeaseState.RELEASED);
    expect(cp.tasks.get(task.task_id).state).toBe(TaskState.BLOCKED);
    expect(cp.tasks.get(task.task_id).attempt).toBe(0);
    expect(cp.attempts.get(task.task_id, 1)).toBeUndefined();
    const stopped = cp.store.getExecution(task.task_id);
    const cursor = cp.lastEventId();
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
    expect(cp.store.getExecution(task.task_id)).toEqual(stopped);
    expect(cp.lastEventId()).toBe(cursor);
    expect(calls).toBe(0);
    expect(cp.events({ task_id: task.task_id }).filter(e => e.type === EventType.RUNTIME_STOP_CONFIRMED)).toHaveLength(0);
  });

  it("rejects changed input bytes before reserving a recovery attempt or lease", async () => {
    const { cp, dir, task, request, orchestrator } = setup();
    let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation); });
    writeFileSync(join(dir, "input.txt"), "published fixture");
    const artifact = cp.artifacts.publish({ task_id: task.task_id, produced_by: "codex", kind: "file", name: "input", path: "input.txt" });
    cp.store.appendEvent({ type: EventType.DELEGATION_REQUESTED, task_id: task.task_id, agent: "codex",
      payload: { input_artifacts: [artifact.artifact_id] } }, Date.now());
    writeFileSync(join(dir, "input.txt"), "changed fixture");
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(cp.leases.listLive()).toEqual([]);
    expect(cp.tasks.get(task.task_id)).toMatchObject({ attempt: 0, state: TaskState.BLOCKED });
    expect(cp.attempts.get(task.task_id, 1)).toBeUndefined();
    expect(cp.store.getExecution(task.task_id)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("cancels an abandoned queued recovery and immediately releases its unused lease", async () => {
    const { cp, dir, db, task, request, orchestrator } = setup(true);
    let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation); });
    crashPrepared(dir, db, task.task_id, "QUEUED");
    const leaseId = cp.store.getExecution(task.task_id)!.lease_id!;
    const result = await orchestrator.cancelTask(task.task_id, "codex", 0);
    expect(result).toMatchObject({ cancelled: true, state: TaskState.CANCELLED, runtime_stop_confirmed: true });
    expect(cp.store.getLease(leaseId)?.state).toBe(LeaseState.RELEASED);
    expect(cp.leases.findConflicts(task.spec.scope, "claude")).toEqual([]);
    expect(cp.tasks.get(task.task_id).attempt).toBe(0);
    expect(cp.attempts.get(task.task_id, 1)).toBeUndefined();
    const cursor = cp.lastEventId();
    expect(await orchestrator.cancelTask(task.task_id, "codex", 0)).toEqual(result);
    expect(cp.lastEventId()).toBe(cursor);
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.TASK_CANCELLED });
    const replayCursor = cp.lastEventId();
    await expect(orchestrator.resumeTask(request)).rejects.toMatchObject({ code: ErrorCode.TASK_CANCELLED });
    expect(cp.lastEventId()).toBe(replayCursor);
    expect(cp.attempts.get(task.task_id, 1)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("preserves an unconfirmed runtime stop and its observation when replaying the same key", async () => {
    const { cp, task, request, orchestrator } = setup();
    let calls = 0;
    register(cp, async (_invocation, ctx) => {
      calls++;
      await ctx.reportRuntimeState?.("running");
      throw new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED, "fixture stop unknown", { runtime_stop_confirmed: false });
    }, true);
    const first = await orchestrator.resumeTask(request);
    const execution = cp.store.getExecution(task.task_id)!;
    const lease = cp.store.getLease(first.fresh_lease_id)!;
    const replay = await new Orchestrator(cp).resumeTask(request);
    expect(replay.error?.code).toBe(ErrorCode.RUNTIME_STOP_UNCONFIRMED);
    expect(replay.observation).toEqual(first.observation);
    expect(cp.store.getExecution(task.task_id)).toEqual(execution);
    expect(cp.store.getLease(first.fresh_lease_id)).toEqual(lease);
    expect(lease.state).toBe(LeaseState.QUARANTINED);
    expect(calls).toBe(1);
  });

  it("preserves strict incomplete observation on a successful recovery replay", async () => {
    const { cp, request, orchestrator } = setup(false, true);
    let calls = 0;
    register(cp, async (invocation, ctx) => {
      calls++;
      await ctx.saveExecutionHandle(invocation.previous_execution_handle!);
      return complete(invocation);
    });
    const first = await orchestrator.resumeTask(request);
    expect(first.deliverable?.status).toBe("COMPLETE");
    expect(first.error?.code).toBe(ErrorCode.TELEMETRY_INCOMPLETE);
    const replay = await new Orchestrator(cp).resumeTask(request);
    expect(replay.error?.code).toBe(ErrorCode.TELEMETRY_INCOMPLETE);
    expect(replay.observation).toEqual(first.observation);
    expect(calls).toBe(1);
  });
});
