import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeError, ErrorCode, TaskState, type AgentAdapter, type DelegationRequest, type TaskInvocation } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { Orchestrator } from "./orchestrator.js";
import { ManualClock } from "./clock.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-contracts-"));
  const db = persistent ? join(dir, "bridge.db") : ":memory:";
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const cp = ControlPlane.open({ workspaceRoot: dir, databasePath: db });
  cleanup.push(() => cp.close());
  return { cp, dir, db, orchestrator: new Orchestrator(cp) };
}
function request(key = "same", scope = "work/**"): DelegationRequest {
  return { from: "claude", to: "codex", idempotency_key: key, deadline_ms: 5000, input_artifacts: [],
    spec: { objective: "verify durable execution", scope: { paths: [scope] }, dependencies: [], expected_deliverable: "result", verification_criteria: ["fixture"] } };
}
function complete(invocation: TaskInvocation) {
  return { task_id: invocation.task_id, agent: "codex", status: "COMPLETE" as const, summary: "fixture",
    artifacts: [], changed_scope: [], commit_or_diff: null, verification_performed: ["fixture"],
    verification_results: [{ kind: "test" as const, command: "fixture", passed: true, exit_code: 0, summary: "passed" }],
    remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: Date.now() };
}
function register(cp: ControlPlane, invoke: AgentAdapter["invoke"], concurrency = 1, native = false) {
  cp.adapters.register({ info: { agent: "codex", implementation: "fixture", version: "1.0.0", max_concurrency: concurrency,
    capabilities: native ? ["stop-confirmation", "resume"] : ["resume"] }, invoke, health: async () => ({ status: "READY", checked_at: Date.now() }), cancel: async () => {} });
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 160; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Fixture condition was not reached");
}
function worker(dir: string, db: string, key: string, mode = "success", scope?: string) {
  const child = spawn(process.execPath, [resolve("shared/control-plane/test/fixtures/durable-worker.mjs"), dir, db, key, mode, ...(scope ? [scope] : [])], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += String(d); }); child.stderr.on("data", d => { stderr += String(d); });
  const ended = new Promise<{ code: number | null; result: any }>((done, reject) => {
    child.once("error", reject); child.once("close", code => {
      if (code === 0) { try { done({ code, result: JSON.parse(stdout) }); } catch { reject(new Error(`Fixture output missing (${stderr.slice(0, 100)})`)); } }
      else done({ code, result: null });
    });
  });
  cleanup.push(() => { if (child.exitCode === null) child.kill(); });
  return ended;
}

describe("durable execution contracts", () => {
  it.each(["transient", "quota", "auth"] as const)("retries only a typed transient runtime failure: %s", async category => {
    const { cp, orchestrator } = setup(); let calls = 0;
    const failure = { category, source: "runtime_code" as const, retryable: category === "transient", retry_after_at: null };
    register(cp, async (invocation, ctx) => {
      calls++; await ctx.saveExecutionHandle("same_runtime_thread");
      if (calls === 1) {
        await ctx.reportTelemetry?.({ runtime_failure: failure });
        throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "typed fixture failure", { runtime_failure: failure });
      }
      return complete(invocation);
    });
    const result = await orchestrator.delegate({ ...request(), max_attempts: 1 });
    expect(calls).toBe(category === "transient" ? 2 : 1);
    expect(result.error?.code ?? null).toBe(category === "transient" ? null : ErrorCode.ADAPTER_FAILURE);
    expect(cp.tasks.list()).toHaveLength(1); expect(cp.leases.listLive()).toHaveLength(0);
  });

  it("does not retry before a provider-supplied recovery time", async () => {
    const { cp, orchestrator } = setup(); let calls = 0;
    const failure = { category: "transient" as const, source: "runtime_code" as const, retryable: true, retry_after_at: Date.now() + 60000 };
    register(cp, async (_invocation, ctx) => { calls++; await ctx.saveExecutionHandle("known_runtime_thread");
      await ctx.reportTelemetry?.({ runtime_failure: failure });
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "provider wait", { runtime_failure: failure });
    });
    const outcome = await orchestrator.delegate({ ...request(), max_attempts: 1 });
    expect(outcome.attempts).toBe(1); expect(calls).toBe(1);
    expect(() => cp.tasks.assertRecoverable(cp.tasks.get(outcome.task_id))).toThrow(/recovery time/);
  });

  it("measures observation sealing separately and keeps a completed repair idempotent", async () => {
    const { dir } = setup(); const clock = new ManualClock(10000);
    const cp = ControlPlane.open({ workspaceRoot: dir, databasePath: ":memory:", clock }); cleanup.push(() => cp.close());
    const orchestrator = new Orchestrator(cp);
    const insert = cp.store.insertAttemptTelemetry.bind(cp.store);
    vi.spyOn(cp.store, "insertAttemptTelemetry").mockImplementation(t => { insert(t); clock.advance(7); });
    register(cp, async (invocation, ctx) => { await ctx.reportTelemetry?.({ input_tokens: 1, output_tokens: 2 }); return complete(invocation); });
    const result = await orchestrator.delegate(request());
    expect(result.observation).toMatchObject({ seal_started_at: 10000, sealed_at: 10007, seal_duration_ms: 7, seal_measurement_version: 1 });
    expect(cp.attempts.queryTelemetry()[0]?.seal_duration_ms).toBeNull();
    clock.advance(100);
    expect(orchestrator.repairObservation(result.task_id, "codex")).toEqual(result.observation);
  });
  it("does not turn an aborted promise return into positive native stop evidence", async () => {
    const { cp, orchestrator } = setup();
    register(cp, async (invocation, ctx) => {
      await ctx.reportRuntimeState?.("running");
      await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      return complete(invocation);
    }, 1, true);
    const running = orchestrator.delegate(request());
    await until(() => cp.store.listExecutions().some(e => e.phase === "RUNNING" && e.runtime_stop_confirmed === false));
    const task = cp.tasks.list()[0]!;
    expect(await orchestrator.cancelTask(task.task_id, "codex")).toMatchObject({ cancelled: false, runtime_stop_confirmed: false });
    expect((await running).error?.code).toBe(ErrorCode.RUNTIME_STOP_UNCONFIRMED);
    expect(cp.leases.listLive()[0]?.state).toBe("QUARANTINED");
  });
  it("joins duplicate same-process requests and replays after reopen without another invoke", async () => {
    const { cp, dir, db, orchestrator } = setup(true);
    let calls = 0;
    register(cp, async invocation => { calls++; await new Promise(r => setTimeout(r, 50)); return complete(invocation); });
    const [a, b] = await Promise.all([orchestrator.delegate(request()), orchestrator.delegate(request())]);
    expect(a).toEqual(b); expect(calls).toBe(1); expect(cp.tasks.list()).toHaveLength(1);
    const reopened = ControlPlane.open({ workspaceRoot: dir, databasePath: db }); cleanup.push(() => reopened.close());
    register(reopened, async () => { throw new Error("Replay invoked a model"); });
    expect(await new Orchestrator(reopened).delegate(request())).toEqual(a);
  });
  it.each(["budget", "scope", "inputs", "turns", "mode", "lineage"])("rejects full-contract changes under the same key: %s", async kind => {
    const { cp, orchestrator } = setup(); register(cp, async invocation => complete(invocation));
    await orchestrator.delegate(request());
    const modified = request();
    const source = cp.tasks.create({ spec: request().spec, created_by: "claude" });
    const artifact = cp.artifacts.publish({ task_id: source.task_id, produced_by: "claude", kind: "file", name: "input", inline: "input" });
    const next = kind === "budget" ? { ...modified, max_attempts: 1 }
      : kind === "scope" ? { ...modified, spec: { ...modified.spec, scope: { paths: ["another/**"] } } }
      : kind === "inputs" ? { ...modified, input_artifacts: [artifact.artifact_id] }
      : kind === "turns" ? { ...modified, spec: { ...modified.spec, max_turns: 3 } }
      : kind === "mode" ? { ...modified, spec: { ...modified.spec, telemetry_mode: "strict" as const } }
      : { ...modified, run_id: "run_1234567890" };
    await expect(orchestrator.delegate(next)).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_MISMATCH });
  });
  it("preserves the business result when telemetry storage fails, then repairs without another runtime", async () => {
    const { cp, orchestrator } = setup(); let calls = 0;
    register(cp, async (invocation, ctx) => { calls++; await ctx.reportTelemetry?.({ input_tokens: 2, output_tokens: 3, total_tokens: 5 }); return complete(invocation); });
    const insertion = vi.spyOn(cp.store, "insertAttemptTelemetry").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    const outcome = await orchestrator.delegate(request());
    expect(outcome.error).toBeNull(); expect(outcome.deliverable?.status).toBe("COMPLETE");
    expect(cp.tasks.get(outcome.task_id).state).toBe(TaskState.DONE);
    expect(outcome.observation).toMatchObject({ status: "INCOMPLETE", category: "STORAGE", accepted: true });
    insertion.mockRestore();
    expect(orchestrator.repairObservation(outcome.task_id, "codex")).toMatchObject({ status: "COMPLETE" });
    expect(orchestrator.repairObservation(outcome.task_id, "codex")).toMatchObject({ status: "COMPLETE" });
    expect(cp.attempts.queryTelemetry()).toHaveLength(1); expect(calls).toBe(1);
    expect(await orchestrator.delegate(request())).toEqual(outcome);
  });
  it.each(["operational", "strict"] as const)("keeps secrets out of rejected observation drafts in %s mode", async mode => {
    const { cp, orchestrator } = setup(); const secret = "sk-abcdefghijklmnopqrstuv";
    register(cp, async (invocation, ctx) => { await ctx.reportTelemetry?.({ model: secret }); return complete(invocation); });
    const outcome = await orchestrator.delegate({ ...request(), spec: { ...request().spec, telemetry_mode: mode } });
    expect(outcome.deliverable?.status).toBe("COMPLETE"); expect(cp.tasks.get(outcome.task_id).state).toBe("DONE");
    expect(outcome.observation).toMatchObject({ status: "REJECTED", category: "PRIVACY", accepted: mode === "operational" });
    expect(JSON.stringify(cp.store.listObservations())).not.toContain(secret);
    expect(cp.attempts.queryTelemetry()).toHaveLength(0);
    expect(outcome.error?.code ?? null).toBe(mode === "strict" ? ErrorCode.TELEMETRY_INCOMPLETE : null);
  });
  it("quarantines unconfirmed stops beyond lease expiry and fences all late worker writes", async () => {
    const { cp, orchestrator } = setup(); let saved!: Parameters<AgentAdapter["invoke"]>[1];
    register(cp, async (_invocation, ctx) => { saved = ctx; await ctx.reportRuntimeState?.("running");
      throw new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED, "fixture lost stop", { runtime_stop_confirmed: false }); }, 1, true);
    const outcome = await orchestrator.delegate(request());
    expect(outcome.error?.code).toBe(ErrorCode.RUNTIME_STOP_UNCONFIRMED);
    const held = cp.leases.listLive()[0]!; expect(held.state).toBe("QUARANTINED");
    expect(cp.leases.isLive(held, held.expires_at + 1_000_000)).toBe(true);
    await expect(saved.saveExecutionHandle("late_handle")).rejects.toMatchObject({ code: ErrorCode.LEASE_INVALID });
    await expect(saved.recordVerification({ kind: "test", command: "late", passed: true, exit_code: 0, summary: "late" })).rejects.toMatchObject({ code: ErrorCode.LEASE_INVALID });
    expect(() => cp.leases.release(held.lease_id, "codex")).toThrow(/stop evidence/);
    await saved.reportRuntimeState?.("stopped"); expect(cp.leases.listLive()).toHaveLength(0);
  });
  it("cancels queued work without consuming an attempt or cancelling the active task", async () => {
    const { cp, orchestrator } = setup(); let release!: () => void; let calls = 0;
    register(cp, async invocation => { calls++; await new Promise<void>(r => { release = r; }); return complete(invocation); });
    const first = orchestrator.delegate(request("first", "a/**")); await until(() => calls === 1);
    const queued = orchestrator.delegate(request("queued", "b/**"));
    await until(() => cp.store.listExecutions().some(e => e.phase === "QUEUED"));
    const task = cp.tasks.list().find(t => t.task_id !== cp.store.listExecutions().find(e => e.phase === "RUNNING")!.task_id)!;
    expect(await orchestrator.cancelTask(task.task_id, "codex")).toMatchObject({ cancelled: true, runtime_stop_confirmed: true });
    const outcome = await queued; expect(outcome.attempts).toBe(0); expect(calls).toBe(1);
    release(); expect((await first).error).toBeNull();
  });
  it("continues the same prelaunch-blocked task and preserves the original cached contention outcome", async () => {
    const { cp, orchestrator } = setup(); register(cp, async invocation => complete(invocation));
    const owner = cp.tasks.create({ spec: request().spec, created_by: "other" }); cp.tasks.claim(owner.task_id, "other");
    const lease = cp.leases.acquire({ task_id: owner.task_id, holder: "other", scope: request().spec.scope, ttl_ms: 10000 });
    const blocked = await orchestrator.delegate(request()); expect(blocked.error?.code).toBe(ErrorCode.SCOPE_CONFLICT); expect(blocked.attempts).toBe(0);
    cp.leases.release(lease.lease_id, "other");
    const resumed = await orchestrator.continueTask(blocked.task_id, "codex", "continue-one");
    expect(resumed.task_id).toBe(blocked.task_id); expect(resumed.error).toBeNull(); expect(resumed.attempts).toBe(1);
    expect(await orchestrator.delegate(request())).toEqual(blocked);
    expect(await orchestrator.continueTask(blocked.task_id, "codex", "continue-one")).toEqual(resumed);
  });
  it("freezes input files before worker launch and rejects changed published content", async () => {
    const { cp, dir, orchestrator } = setup(); const source = cp.tasks.create({ spec: request().spec, created_by: "claude" });
    writeFileSync(join(dir, "input.txt"), "published");
    const artifact = cp.artifacts.publish({ task_id: source.task_id, produced_by: "claude", kind: "file", name: "input", path: "input.txt" });
    register(cp, async invocation => { writeFileSync(join(dir, "input.txt"), "mutated after launch");
      expect(readFileSync(join(dir, invocation.inputs[0]!.path!), "utf8")).toBe("published"); return complete(invocation); });
    expect((await orchestrator.delegate({ ...request(), input_artifacts: [artifact.artifact_id] })).error).toBeNull();
    const changed = await orchestrator.delegate({ ...request("changed"), input_artifacts: [artifact.artifact_id] });
    expect(changed.attempts).toBe(0); expect(changed.error?.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
  it("one durable key invokes once between two actual MCP-style processes", async () => {
    const { cp, dir, db } = setup(true);
    const [a, b] = await Promise.all([worker(dir, db, "race"), worker(dir, db, "race")]);
    expect(a.code).toBe(0); expect(b.code).toBe(0); expect(a.result).toEqual(b.result);
    const events = readFileSync(join(dir, "runtime.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(e => e.type === "start")).toHaveLength(1); expect(cp.tasks.list()).toHaveLength(1);
  });
  it("shares runtime capacity across processes and admits separate tasks in sequence", async () => {
    const { dir, db } = setup(true);
    const [a, b] = await Promise.all([worker(dir, db, "one"), worker(dir, db, "two")]);
    expect(a.code).toBe(0); expect(b.code).toBe(0);
    const events = readFileSync(join(dir, "runtime.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.type)).toEqual(["start", "stop", "start", "stop"]);
  });
  it("removes dead prelaunch queue entries without replaying their key or blocking later work", async () => {
    const { cp, dir, db } = setup(true);
    expect((await worker(dir, db, "lost", "queued-crash")).code).toBe(53);
    expect((await worker(dir, db, "new-work")).result.error).toBeNull();
    expect(cp.store.listExecutions().filter(e => e.phase === "QUEUED")).toHaveLength(0);
  });
  it.each(["crash", "crash-before-handle"])("never auto-relaunches an authorized operation after %s", async mode => {
    const { cp, dir, db, orchestrator } = setup(true);
    expect((await worker(dir, db, "stranded", mode, "work/**")).code).not.toBe(0);
    register(cp, async () => { throw new Error("Uncertain work was duplicated"); });
    const original: DelegationRequest = { ...request("stranded"), spec: { objective: "durable fixture", scope: { paths: ["work/**"] }, dependencies: [], expected_deliverable: "fixture", verification_criteria: ["fixture"] } };
    const outcome = await orchestrator.delegate(original);
    expect(outcome.error?.code).toBe(ErrorCode.RUNTIME_STOP_UNCONFIRMED); expect(cp.tasks.list()).toHaveLength(1);
    expect(cp.leases.listLive()[0]?.state).toBe("QUARANTINED");
  });
  it("an owner can cancel a runtime in another process without sharing its adapter", async () => {
    const { cp, dir, db, orchestrator } = setup(true);
    const running = worker(dir, db, "cancel", "cancel");
    await until(() => cp.tasks.list().some(t => cp.attempts.get(t.task_id, 0)?.execution_handle));
    const task = cp.tasks.list()[0]!;
    expect(await orchestrator.cancelTask(task.task_id, "codex")).toMatchObject({ cancelled: true, runtime_stop_confirmed: true });
    expect((await running).result.error.code).toBe(ErrorCode.TASK_CANCELLED);
    expect(cp.leases.listLive()).toHaveLength(0);
  });
  it("unknown and inverted clocks never fabricate component durations", () => {
    // Existing report regressions cover attempt and delegation spans; component timings
    // must remain null when the runtime has not provided their source timestamps.
    expect(cpDurations()).toMatchObject({ queue_duration_ms: null, startup_duration_ms: null, work_duration_ms: null,
      delegation_elapsed_ms: null, attempt_wall_duration_ms: null, runtime_duration_ms: null, runtime_duration_source: null });
  });
});

import { normalizeAttemptTelemetry } from "./attempt-service.js";
function cpDurations() {
  return normalizeAttemptTelemetry({ task_id: "task_1234567890", run_id: "run_1234567890", parent_task_id: null,
    delegation_depth: 0, attempt: 0, agent: "codex", orchestration_started_at: 200, attempt_started_at: 200,
    observed_runtime_started_at: null, observed_runtime_ended_at: null, completed_at: 100,
    input_artifact_count: 0, input_artifact_bytes: 0, termination_kind: "unknown", update: {} });
}
