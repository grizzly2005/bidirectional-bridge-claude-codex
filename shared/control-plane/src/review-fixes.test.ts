import { afterEach, describe, expect, it } from "vitest";
import { type AgentAdapter, type Deliverable, type TaskSpec, type VerificationResult } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { Orchestrator } from "./orchestrator.js";

const spec: TaskSpec = { objective: "review fixture", scope: { paths: ["fixture/**"] }, dependencies: [],
  expected_deliverable: "fixture result", verification_criteria: ["fixture assertions"] };
const planes: ControlPlane[] = [];
afterEach(() => { planes.splice(0).forEach(cp => cp.close()); });
function fixture() {
  const cp = ControlPlane.open({ workspaceRoot: process.cwd(), databasePath: ":memory:" });
  planes.push(cp); return { cp, orch: new Orchestrator(cp) };
}
function partial(task_id: string): Deliverable {
  return { task_id, agent: "claude", status: "PARTIAL", summary: "fixture", artifacts: [], changed_scope: [],
    commit_or_diff: null, verification_performed: [], verification_results: [], remaining_risks: [],
    dependencies_unblocked: [], recommended_next_action: "none", at: Date.now() };
}
function runningFixture(cp: ControlPlane, confirmStop = true) {
  let started!: (taskId: string) => void;
  const ready = new Promise<string>(resolve => { started = resolve; });
  let invokes = 0;
  const adapter: AgentAdapter = {
    info: { agent: "claude", implementation: "fixture", version: "1", capabilities: ["stop-confirmation", "resume"], max_concurrency: 1 },
    async health() { return { status: "READY", checked_at: Date.now() }; },
    async invoke(inv, ctx) {
      invokes++; await ctx.reportRuntimeState?.("running");
      return new Promise<Deliverable>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          if (!confirmStop) { resolve(partial(inv.task_id)); return; }
          void Promise.resolve(ctx.reportRuntimeState?.("stopped")).then(() => reject(new Error("retryable fixture failure")));
        }, { once: true });
        started(inv.task_id);
      });
    }, async cancel() {},
  };
  cp.adapters.register(adapter); return { ready, invokes: () => invokes };
}

describe("durable cancellation and shutdown", () => {
  it("gives cancellation priority over retry and preserves replay without another launch", async () => {
    const { cp, orch } = fixture(); const runtime = runningFixture(cp);
    const request = { from: "codex", to: "claude", spec, input_artifacts: [], deadline_ms: 2000,
      max_attempts: 1, idempotency_key: "cancel-retry" };
    const pending = orch.delegate(request); void pending.catch(() => undefined);
    const taskId = await runtime.ready;
    await expect(orch.cancelTask(taskId, "outsider", 0)).rejects.toThrow();
    await expect(orch.resumeDelegatedTask({ task_id: taskId, requested_by: "codex" })).rejects.toThrow(/not a delegated child/);
    expect(cp.tasks.get(taskId).state).toBe("WORKING");
    expect((await orch.cancelTask(taskId, "codex", 1000)).runtime_stop_confirmed).toBe(true);
    const outcome = await pending;
    expect(outcome.error?.code).toBe("TASK_CANCELLED");
    expect(cp.tasks.get(taskId).state).toBe("CANCELLED");
    expect(cp.store.getDelegationOperation("codex", "cancel-retry")).toMatchObject({ phase: "FINISHED", outcome });
    expect(await orch.delegate(request)).toEqual(outcome); expect(runtime.invokes()).toBe(1);
  });
  it("does not give the creator of a manually authored task cancellation authority", async () => {
    const { cp, orch } = fixture(); const task = cp.tasks.create({ spec, created_by: "codex" });
    cp.tasks.claim(task.task_id, "claude"); cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    await expect(orch.cancelTask(task.task_id, "codex", 0)).rejects.toThrow(/not a delegated child/);
    expect(cp.tasks.get(task.task_id).state).toBe("WORKING");
  });
  it("drains a pending invocation before closing SQLite and refuses another launch", async () => {
    const { cp, orch } = fixture(); const runtime = runningFixture(cp);
    const request = { from: "codex", to: "claude", spec, input_artifacts: [], deadline_ms: 2000 };
    const pending = orch.delegate(request); void pending.catch(() => undefined);
    const taskId = await runtime.ready;
    const stop = orch.shutdown(); expect(orch.shutdown()).toBe(stop); await stop;
    expect((await pending).error?.code).toBe("TASK_CANCELLED");
    expect(cp.store.getExecution(taskId)).toMatchObject({ phase: "STOPPED", runtime_stop_confirmed: true });
    expect(cp.leases.listLive()).toEqual([]);
    await expect(orch.delegate(request)).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    expect(runtime.invokes()).toBe(1); cp.close(); cp.close(); expect(cp.isClosed).toBe(true);
  });
  it("retains quarantine when shutdown lacks positive stop evidence", async () => {
    const { cp, orch } = fixture(); const runtime = runningFixture(cp, false);
    const pending = orch.delegate({ from: "codex", to: "claude", spec, input_artifacts: [], deadline_ms: 2000, max_attempts: 1 });
    const taskId = await runtime.ready; await orch.shutdown();
    expect((await pending).error?.code).toBe("RUNTIME_STOP_UNCONFIRMED");
    expect(cp.store.getExecution(taskId)).toMatchObject({ phase: "QUARANTINED", runtime_stop_confirmed: false });
    expect(cp.leases.listLive().some(lease => lease.state === "QUARANTINED")).toBe(true);
    expect(runtime.invokes()).toBe(1);
  });
});

describe("shared verification honesty", () => {
  it.each([{ kind: "test", passed: true, exit_code: 1 }, { kind: "test", passed: false, exit_code: 0 },
    { kind: "test", passed: true, exit_code: null }] as const)("rejects contradictory or unknown command evidence: %j", value => {
    const { cp } = fixture(); const task = cp.tasks.create({ spec, created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude"); cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    const evidence: VerificationResult = { ...value, command: "fixture check", summary: "fixture" };
    expect(() => cp.deliverables.recordVerification(task.task_id, "claude", evidence)).toThrow();
    expect(() => cp.deliverables.submit({ ...partial(task.task_id), status: "COMPLETE", verification_results: [evidence] })).toThrow();
    expect(cp.deliverables.get(task.task_id)).toBeUndefined(); expect(cp.deliverables.listVerifications(task.task_id)).toEqual([]);
    expect(cp.tasks.get(task.task_id).state).toBe("WORKING");
  });
  it("accepts exit code zero and an explicit manual check without a process exit code", () => {
    const { cp } = fixture(); const task = cp.tasks.create({ spec, created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude"); cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    cp.deliverables.recordVerification(task.task_id, "claude", { kind: "test", command: "fixture assertions", summary: "passed", passed: true, exit_code: 0 });
    const result = cp.deliverables.submit({ ...partial(task.task_id), status: "COMPLETE", verification_results: [
      { kind: "manual", command: "inspect fixture output", summary: "inspected", passed: true, exit_code: null }] });
    expect(result.verification_results).toHaveLength(2); expect(cp.tasks.get(task.task_id).state).toBe("DONE");
  });
});
