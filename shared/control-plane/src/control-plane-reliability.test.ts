/** Local SQLite and adapter fixtures. These checks do not invoke providers or web targets. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterHealth, BridgeError, DeliverableStatus, ErrorCode, seededRandom,
  type AgentAdapter, type Deliverable, type InvocationContext, type TaskInvocation,
  type TaskSpec, type VerificationResult,
} from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { Orchestrator } from "./orchestrator.js";
import { DelegationOperations } from "./delegation-operation.js";

const spec: TaskSpec = { objective: "bounded reliability fixture", scope: { paths: ["fixtures/**"] },
  dependencies: [], expected_deliverable: "fixture report", verification_criteria: ["fixture assertions pass"] };
const passing = (command = "fresh fixture check"): VerificationResult => ({ kind: "test", command, passed: true, exit_code: 0, summary: "fixture passed" });
const failing = (command = "old fixture check"): VerificationResult => ({ kind: "test", command, passed: false, exit_code: 1, summary: "fixture failed" });
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const clock = new ManualClock();
  const cp = ControlPlane.open({ workspaceRoot: "/tmp/bridge-reliability", databasePath: ":memory:", clock, rng: seededRandom(971) });
  cleanups.push(() => cp.close());
  return { cp, clock, orch: new Orchestrator(cp) };
}
function complete(invocation: TaskInvocation, checks: VerificationResult[], artifacts: string[] = []): Deliverable {
  return { task_id: invocation.task_id, agent: "claude", status: DeliverableStatus.COMPLETE,
    summary: "retained fixture report", changed_scope: [], artifacts, commit_or_diff: null,
    verification_performed: checks.map(check => check.command), verification_results: checks,
    remaining_risks: ["original fixture risk"], dependencies_unblocked: [], recommended_next_action: "none", at: 1_700_000_000_000 };
}
function register(cp: ControlPlane, invoke: (invocation: TaskInvocation, ctx: InvocationContext) => Promise<Deliverable>, capabilities = ["structured-deliverable"]) {
  cp.adapters.register({ info: { agent: "claude", implementation: "local-fixture", version: "1", capabilities, max_concurrency: 2 },
    health: async () => ({ status: AdapterHealth.READY, checked_at: cp.clock.now() }), invoke, cancel: async () => {} } as AgentAdapter);
}
const request = { from: "codex", to: "claude", spec, input_artifacts: [], deadline_ms: 2000, max_attempts: 1 };

describe("attempt-scoped verification and result preservation", () => {
  it("accepts a fresh pass after a different check failed in the prior retryable attempt", async () => {
    const { cp, orch } = fixture();
    register(cp, async (invocation, ctx) => {
      if (invocation.attempt === 0) {
        await ctx.recordVerification(failing());
        throw new BridgeError(ErrorCode.INTERNAL, "retryable local fixture failure");
      }
      await ctx.recordVerification(passing());
      return complete(invocation, [passing()]);
    });
    const result = await orch.delegate(request);
    expect(result).toMatchObject({ error: null, attempts: 2, deliverable: { status: "COMPLETE", verification_results: [passing()] } });
    expect(cp.tasks.get(result.task_id)).toMatchObject({ state: "DONE", attempt: 1 });
    expect(cp.deliverables.listVerifications(result.task_id, 0)).toEqual([failing()]);
    expect(cp.deliverables.listVerifications(result.task_id, 1)).toEqual([passing()]);
    expect(cp.deliverables.listVerifications(result.task_id)).toEqual([failing(), passing()]);
    expect(cp.events({ task_id: result.task_id, types: ["verification.recorded"] }).map(event => event.payload["attempt"])).toEqual([0, 1]);
  });

  it("refuses empty COMPLETE after an old pass and retains an honest PARTIAL", async () => {
    const { cp, orch } = fixture();
    register(cp, async (invocation, ctx) => {
      if (invocation.attempt === 0) {
        await ctx.recordVerification(passing("old passing fixture"));
        throw new BridgeError(ErrorCode.INTERNAL, "retryable local fixture failure");
      }
      return complete(invocation, []);
    });
    const result = await orch.delegate(request);
    expect(result).toMatchObject({ error: { code: "INVALID_ARGUMENT" }, attempts: 2,
      deliverable: { status: "PARTIAL", verification_results: [] } });
    expect(cp.tasks.get(result.task_id).state).toBe("BLOCKED");
    expect(result.deliverable?.remaining_risks[0]).toContain("no passing verification");
    expect(cp.store.getExecution(result.task_id)).toMatchObject({ phase: "STOPPED", runtime_stop_confirmed: true });
  });

  it("retains linked artifacts and current failures when COMPLETE is rejected, then resumes in place", async () => {
    const { cp, orch } = fixture();
    register(cp, async (invocation, ctx) => {
      await ctx.saveExecutionHandle("fixture-session");
      if (invocation.attempt === 0) {
        const artifact = await ctx.publishArtifact({ kind: "report", name: "fixture-report.txt", inline: "useful preserved output" });
        await ctx.recordVerification(failing());
        return complete(invocation, [passing()], [artifact]);
      }
      expect(invocation).toMatchObject({ previous_execution_handle: "fixture-session", resume_required: true });
      return complete(invocation, [passing("recovery fixture")]);
    }, ["structured-deliverable", "resume"]);
    const first = await orch.delegate({ ...request, spec: { ...spec, scope: { paths: ["(no-write)/recovery-fixture/**"] } }, max_attempts: 0 });
    expect(first).toMatchObject({ error: { code: "INVALID_ARGUMENT" }, deliverable: { status: "PARTIAL" } });
    expect(first.deliverable?.verification_results).toEqual([failing(), passing()]);
    expect(first.deliverable?.remaining_risks).toEqual([expect.stringContaining("COMPLETE refused"), "original fixture risk"]);
    expect(cp.artifacts.get(first.deliverable!.artifacts[0]!).inline).toBe("useful preserved output");
    expect(cp.tasks.get(first.task_id).state).toBe("BLOCKED");
    expect(cp.leases.listLive()).toEqual([]);
    const recovered = await orch.resumeTask({ task_id: first.task_id, requested_by: "claude", idempotency_key: "fixture-recovery" });
    expect(recovered).toMatchObject({ task_id: first.task_id, state: "DONE", recovered_attempt: 1,
      same_execution_handle: true, error: null, deliverable: { status: "COMPLETE", verification_results: [passing("recovery fixture")] } });
    expect(cp.store.listTasks()).toHaveLength(1);
  });

  it("keeps the explicit submitted kind/command override within one attempt", async () => {
    const { cp, orch } = fixture();
    register(cp, async (invocation, ctx) => { await ctx.recordVerification(failing("same check")); return complete(invocation, [passing("same check")]); });
    const result = await orch.delegate({ ...request, max_attempts: 0 });
    expect(result.error).toBeNull();
    expect(result.deliverable?.verification_results).toEqual([passing("same check")]);
    expect(cp.deliverables.listVerifications(result.task_id, 0)).toEqual([failing("same check")]);
  });

  it("rejects an explicitly stale attempt even when owner identity is unchanged", () => {
    const { cp } = fixture(); const task = cp.tasks.create({ spec, created_by: "codex" });
    cp.tasks.claim(task.task_id, "claude"); cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    cp.deliverables.recordVerification(task.task_id, "claude", passing(), 0);
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "FAILED" }); cp.tasks.retry(task.task_id, "codex", 2);
    cp.tasks.claim(task.task_id, "claude"); cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    expect(() => cp.deliverables.recordVerification(task.task_id, "claude", passing(), 0)).toThrow(/obsolete/);
    const deliverable = complete({ task_id: task.task_id } as TaskInvocation, [passing()]);
    expect(() => cp.deliverables.submit(deliverable, { attempt: 0 })).toThrow(/obsolete/);
    expect(cp.deliverables.listVerifications(task.task_id, 1)).toEqual([]);
    expect(cp.deliverables.get(task.task_id)).toBeUndefined();
  });

  it.each(["storage", "schema", "authority", "owner"])("does not turn a %s error into PARTIAL", async kind => {
    const { cp, orch } = fixture();
    if (kind === "storage") vi.spyOn(cp.store, "insertDeliverable").mockImplementation(() => { throw new Error("fixture storage rejection"); });
    if (kind === "owner") vi.spyOn(cp.deliverables, "submit").mockImplementationOnce(() => { throw new BridgeError(ErrorCode.NOT_OWNER, "fixture authority rejection"); });
    register(cp, async invocation => {
      const value = complete(invocation, [passing()]);
      return kind === "schema" ? { ...value, recommended_next_action: null } as unknown as Deliverable
        : kind === "authority" ? { ...value, agent: "intruder" } : value;
    });
    const result = await orch.delegate({ ...request, max_attempts: 0 });
    expect(result.deliverable).toBeNull();
    expect(result.error?.code).toBe(kind === "storage" ? "INTERNAL" : kind === "schema" ? "INVALID_ARGUMENT" : kind === "owner" ? "NOT_OWNER" : "ADAPTER_FAILURE");
    expect(cp.deliverables.get(result.task_id)).toBeUndefined();
    expect(cp.tasks.get(result.task_id).state).toBe("FAILED");
    expect(cp.leases.listLive()).toEqual([]);
  });

  it("never preserves a rejected COMPLETE when stop evidence is unconfirmed", async () => {
    const { cp, orch } = fixture();
    register(cp, async (invocation, ctx) => { await ctx.recordVerification(failing()); return complete(invocation, []); }, ["structured-deliverable", "stop-confirmation"]);
    const result = await orch.delegate({ ...request, max_attempts: 0 });
    expect(result).toMatchObject({ error: { code: "RUNTIME_STOP_UNCONFIRMED" }, deliverable: null });
    expect(cp.tasks.get(result.task_id).state).toBe("BLOCKED");
    expect(cp.store.getExecution(result.task_id)?.phase).toBe("QUARANTINED");
    expect(cp.leases.listLive()[0]?.state).toBe("QUARANTINED");
  });
});

describe("runReady executes existing tasks", () => {
  it("preserves identity, lineage, dependency order, preferred agent and explicit input context across passes", async () => {
    const { cp, orch } = fixture(); const invocations: TaskInvocation[] = [];
    register(cp, async invocation => { invocations.push(invocation); return complete(invocation, [passing()]); });
    const root = cp.tasks.create({ spec: { ...spec, scope: { paths: ["(no-write)/**"] } }, created_by: "codex" });
    cp.tasks.claim(root.task_id, "codex"); cp.tasks.transition({ task_id: root.task_id, agent: "codex", to: "WORKING" });
    const input = cp.artifacts.publish({ task_id: root.task_id, produced_by: "codex", kind: "report", name: "input.txt", inline: "expected input sentinel" });
    const first = cp.tasks.create({ spec: { ...spec, preferred_agent: "claude" }, created_by: "codex", parent_task_id: root.task_id });
    const dependent = cp.tasks.create({ spec: { ...spec, preferred_agent: "claude", dependencies: [first.task_id] }, created_by: "codex", parent_task_id: root.task_id });
    const unrelated = cp.tasks.create({ spec, created_by: "other-manager" });
    const options = { run_id: root.run_id, input_artifacts: { [first.task_id]: [input.artifact_id] } };
    expect((await orch.runReady("unregistered-default", 2000, options)).map(outcome => outcome.task_id)).toEqual([first.task_id]);
    expect(cp.tasks.get(dependent.task_id).state).toBe("PENDING");
    expect((await orch.runReady("unregistered-default", 2000, options)).map(outcome => outcome.task_id)).toEqual([dependent.task_id]);
    expect(await orch.runReady("claude", 2000, options)).toEqual([]);
    expect(cp.store.listTasks()).toHaveLength(4);
    expect(cp.tasks.get(unrelated.task_id).state).toBe("PENDING");
    expect(invocations[0]).toMatchObject({ task_id: first.task_id, run_id: root.run_id, parent_task_id: root.task_id, delegation_depth: 1,
      spec: first.spec, inputs: [{ artifact_id: input.artifact_id, inline: "expected input sentinel", sha256: input.sha256 }] });
    expect(invocations[1]?.spec.dependencies).toEqual([first.task_id]);
    expect(cp.store.firstDelegationOperation(first.task_id)?.request.input_artifacts).toEqual([input.artifact_id]);
  });

  it("does not duplicate a ready task across concurrent orchestrators", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation, [passing()]); });
    const task = cp.tasks.create({ spec, created_by: "codex" });
    const outcomes = (await Promise.all([orch.runReady("claude", 2000), new Orchestrator(cp).runReady("claude", 2000)])).flat();
    expect(outcomes.map(outcome => outcome.task_id)).toEqual([task.task_id]); expect(calls).toBe(1);
    expect(cp.store.listTasks()).toHaveLength(1);
  });

  it("keeps the same task and advanced attempt after an explicit retry", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async invocation => { calls++; if (calls === 1) throw new BridgeError(ErrorCode.INTERNAL, "fixture failure"); return complete(invocation, [passing()]); });
    const task = cp.tasks.create({ spec, created_by: "codex" });
    expect((await orch.runReady("claude", 2000))[0]).toMatchObject({ task_id: task.task_id, attempts: 1, error: { code: "INTERNAL" } });
    cp.tasks.retry(task.task_id, "codex", 2);
    expect((await orch.runReady("claude", 2000))[0]).toMatchObject({ task_id: task.task_id, attempts: 1, error: null });
    expect(cp.tasks.get(task.task_id)).toMatchObject({ state: "DONE", attempt: 1 });
    expect(cp.attempts.list(task.task_id).map(attempt => attempt.attempt)).toEqual([0, 1]);
  });

  it("leaves unknown adapters PENDING and returns the real task identity and error", async () => {
    const { cp, orch } = fixture(); const task = cp.tasks.create({ spec: { ...spec, preferred_agent: "missing" }, created_by: "codex" });
    expect((await orch.runReady("claude", 2000))[0]).toMatchObject({ task_id: task.task_id, delegate: "missing", error: { code: "NOT_FOUND" }, attempts: 0 });
    expect(cp.tasks.get(task.task_id).state).toBe("PENDING"); expect(cp.store.listTasks()).toHaveLength(1);
  });

  it("does not adopt an existing native prelaunch reservation", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation, [passing()]); });
    const reserved = new DelegationOperations(cp).reserve({ ...request, max_attempts: 0, idempotency_key: "native-prelaunch" });
    expect(await orch.runReady("claude", 2000)).toEqual([]);
    expect(cp.tasks.get(reserved.operation.task_id).state).toBe("PENDING"); expect(calls).toBe(0);
  });

  it("reconciles its own dead prelaunch reservation without making a replacement task", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation, [passing()]); });
    const task = cp.tasks.create({ spec, created_by: "codex" });
    const frozenRequest = { ...request, max_attempts: 0, run_id: task.run_id, parent_task_id: null, delegation_depth: 0,
      idempotency_key: `run-ready:${task.task_id}:0` };
    const { operation } = new DelegationOperations(cp).reserveExisting(task.task_id, frozenRequest);
    cp.store.putDelegationOperation({ ...operation, executor_id: "dead-fixture-executor", executor_pid: 2_000_000_000 });
    expect((await orch.runReady("claude", 2000))[0]).toMatchObject({ task_id: task.task_id, error: null });
    expect(cp.store.listTasks()).toHaveLength(1); expect(calls).toBe(1);
  });

  it("rejects a preferred agent in the ancestor chain without claiming or duplicating the task", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async invocation => { calls++; return complete(invocation, [passing()]); });
    const root = cp.tasks.create({ spec, created_by: "claude" }); cp.tasks.claim(root.task_id, "claude");
    cp.tasks.transition({ task_id: root.task_id, agent: "claude", to: "WORKING" });
    const child = cp.tasks.create({ spec: { ...spec, preferred_agent: "claude" }, created_by: "claude", parent_task_id: root.task_id });
    expect((await orch.runReady("claude", 2000, { run_id: root.run_id }))[0]).toMatchObject({ task_id: child.task_id, attempts: 0, error: { code: "INVALID_ARGUMENT" } });
    expect(cp.tasks.get(child.task_id).state).toBe("PENDING"); expect(calls).toBe(0); expect(cp.store.listTasks()).toHaveLength(2);
  });

  it("refuses to replace frozen inputs after an explicit retry", async () => {
    const { cp, orch } = fixture(); let calls = 0;
    register(cp, async () => { calls++; throw new BridgeError(ErrorCode.INTERNAL, "fixture failed"); });
    const task = cp.tasks.create({ spec, created_by: "codex" });
    const input = cp.artifacts.publish({ task_id: task.task_id, produced_by: "codex", kind: "report", name: "input", inline: "frozen context" });
    await orch.runReady("claude", 2000, { input_artifacts: { [task.task_id]: [input.artifact_id] } });
    cp.tasks.retry(task.task_id, "codex", 2);
    expect((await orch.runReady("claude", 2000, { input_artifacts: { [task.task_id]: [] } }))[0])
      .toMatchObject({ task_id: task.task_id, attempts: 0, error: { code: "IDEMPOTENCY_MISMATCH" } });
    expect(cp.tasks.get(task.task_id).state).toBe("PENDING"); expect(calls).toBe(1);
  });
});

describe("read-only lease semantics retain execution fences", () => {
  it("grants no writable path and permits simultaneous read-only tasks beside a real writer", () => {
    const { cp } = fixture();
    const a = cp.tasks.create({ spec: { ...spec, scope: { paths: ["(no-write)/**"] } }, created_by: "codex" });
    const b = cp.tasks.create({ spec: { ...spec, scope: { paths: ["(no-write)/child-unique/**"] } }, created_by: "codex" });
    const first = cp.leases.acquire({ task_id: a.task_id, holder: "claude", scope: a.spec.scope, ttl_ms: 1000 });
    cp.leases.acquire({ task_id: b.task_id, holder: "codex", scope: b.spec.scope, ttl_ms: 1000 });
    const writer = cp.leases.acquire({ task_id: "task_0000000001", holder: "writer", scope: { paths: ["**"] }, ttl_ms: 1000 });
    expect(() => cp.leases.assertWritable(first.lease_id, "claude", "(no-write)/fake-file")).toThrow(/outside/);
    expect(() => cp.leases.acquire({ task_id: "task_0000000002", holder: "other-writer", scope: spec.scope, ttl_ms: 1000 })).toThrow(/conflicts/);
    expect(cp.store.getLease(writer.lease_id)?.state).toBe("HELD");
  });

  it("retains quarantine, stop evidence and same-task fencing for a read-only execution", () => {
    const { cp, clock } = fixture();
    const task = cp.tasks.create({ spec: { ...spec, scope: { paths: ["(no-write)/**"] } }, created_by: "codex" });
    const lease = cp.leases.acquire({ task_id: task.task_id, holder: "claude", scope: task.spec.scope, ttl_ms: 1000 });
    const execution = cp.executions.queue(task.task_id, 0, "claude", 1); expect(cp.executions.tryAdmit(execution)).toBe(true);
    cp.executions.update(execution, { lease_id: lease.lease_id, runtime_stop_confirmed: false }); cp.leases.quarantine(lease.lease_id, "claude");
    clock.advance(2000); cp.leases.reapExpired();
    expect(cp.leases.listLive()[0]?.state).toBe("QUARANTINED");
    expect(() => cp.leases.release(lease.lease_id, "claude")).toThrow(/stop evidence/);
    expect(() => cp.leases.acquire({ task_id: task.task_id, holder: "claude", scope: { paths: ["(no-write)/next/**"] }, ttl_ms: 1000 })).toThrow(/conflicts/);
    const next = cp.executions.queue("task_0000000001", 0, "claude", 1); expect(cp.executions.tryAdmit(next)).toBe(false);
    cp.executions.update(execution, { phase: "STOPPED", runtime_stop_confirmed: true }); cp.leases.confirmStopped(lease.lease_id, "claude");
    expect(cp.executions.tryAdmit(next)).toBe(true);
  });

  it("rejects a read-only deliverable claiming changed paths without converting that contract error", async () => {
    const { cp, orch } = fixture();
    register(cp, async invocation => ({ ...complete(invocation, [passing()]), changed_scope: ["fixtures/unauthorized.txt"] }));
    const result = await orch.delegate({ ...request, spec: { ...spec, scope: { paths: ["(no-write)/**"] } }, max_attempts: 0 });
    expect(result).toMatchObject({ deliverable: null, error: { code: "INVALID_ARGUMENT" } });
    expect(cp.tasks.get(result.task_id).state).toBe("FAILED");
  });

  it("makes the configured inline byte budget available to adapters", async () => {
    const cp = ControlPlane.open({ workspaceRoot: "/tmp/bridge-budget", databasePath: ":memory:", inlineArtifactLimitBytes: 321 });
    cleanups.push(() => cp.close());
    register(cp, async (invocation, ctx) => { expect(ctx.max_inline_artifact_bytes).toBe(321); return complete(invocation, [passing()]); });
    expect(cp.artifacts.maxInlineBytes).toBe(321);
    expect((await new Orchestrator(cp).delegate({ ...request, max_attempts: 0 })).error).toBeNull();
  });
});
