/**
 * The coordination tool surface, tested without either agent.
 *
 * These tests moved here from `@bridge/claude-side` during the shared/Claude convergence:
 * the tool surface is what both agents call, so it must be verifiable without importing a
 * Claude- or Codex-specific package. If this file ever needs one, the extraction leaked.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlane,
  ManualClock,
  Orchestrator,
  normalizeAttemptTelemetry,
} from "@bridge/control-plane";
import {
  AdapterHealth,
  AttemptTerminationKind,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  seededRandom,
  type AgentAdapter,
  type TaskSpec,
  type VerificationResult,
} from "@bridge/protocol";
import { TOOLS, runTool, type ToolContext } from "./tools.js";

const CLAUDE_SCOPE = { paths: ["claude/**", "shared/**"] };
const CODEX_SCOPE = { paths: ["codex/**"] };

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    objective: "a bounded unit of work",
    scope: CODEX_SCOPE,
    dependencies: [],
    expected_deliverable: "an artifact",
    verification_criteria: ["npm test passes"],
    ...overrides,
  };
}

const passing = (command = "npm test"): VerificationResult => ({
  kind: "test",
  command,
  passed: true,
  exit_code: 0,
  summary: "ok",
});

let cp: ControlPlane;
let clock: ManualClock;
let orchestrator: Orchestrator;

beforeEach(() => {
  clock = new ManualClock();
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-tools",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(99),
  });
  orchestrator = new Orchestrator(cp);
});

const ctx = (
  defaultAgent = "claude",
  delegationPolicy: "allow" | "deny" = "allow",
): ToolContext => ({ cp, orchestrator, defaultAgent, delegationPolicy });

const call = async (
  name: string,
  args: Record<string, unknown> = {},
  toolContext: ToolContext = ctx(),
) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const res = await runTool(tool, args, toolContext);
  return { isError: res.isError ?? false, data: JSON.parse(res.content[0]!.text) };
};

describe("MCP tool surface", () => {
  it("exposes every coordination primitive an agent needs", () => {
    const names = TOOLS.map((t) => t.name);
    for (const required of [
      "bridge_create_task",
      "bridge_server_info",
      "bridge_claim_task",
      "bridge_acquire_lease",
      "bridge_check_scope",
      "bridge_submit_deliverable",
      "bridge_delegate",
      "bridge_snapshot",
      "bridge_read_events",
      "bridge_set_execution_handle",
      "bridge_resume_task",
      "bridge_resume_delegated_task",
      "bridge_query_telemetry",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("is agent-neutral: no tool name or description mentions a specific agent vendor", () => {
    // The surface is shared. A tool called `claude_*`, or a description telling the caller
    // to behave like one particular agent, would make the neutral package neutral in name
    // only and re-couple Codex to Claude's assumptions.
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^bridge_/);
      expect(tool.name).not.toMatch(/claude|codex|anthropic|openai/i);
    }
  });

  it("drives a whole task through create -> claim -> lease -> verify -> submit", async () => {
    const created = await call("bridge_create_task", { spec: spec({ scope: CLAUDE_SCOPE }) });
    const task_id = created.data.task_id as string;

    expect((await call("bridge_claim_task", { task_id })).data.owner).toBe("claude");
    const lease = await call("bridge_acquire_lease", { task_id, scope: CLAUDE_SCOPE, ttl_ms: 60_000 });
    expect(lease.data.lease_id).toBeTruthy();

    await call("bridge_set_state", { task_id, to: "WORKING" });
    await call("bridge_record_verification", { task_id, result: passing() });
    const submitted = await call("bridge_submit_deliverable", {
      task_id,
      status: "COMPLETE",
      summary: "finished",
      verification_results: [passing()],
    });

    expect(submitted.data.state).toBe("DONE");
  });

  it("binds caller identity at server startup and rejects contradictory agent arguments", async () => {
    const session = await call("bridge_server_info");
    expect(session.data).toEqual({ caller: "claude", delegation: "allow" });

    const omitted = await call("bridge_create_task", { spec: spec() });
    expect(cp.tasks.get(omitted.data.task_id).created_by).toBe("claude");

    const matching = await call("bridge_claim_task", {
      task_id: omitted.data.task_id,
      agent: "claude",
    });
    expect(matching.isError).toBe(false);

    const spoofed = await call("bridge_create_task", { spec: spec(), agent: "codex" });
    expect(spoofed.isError).toBe(true);
    expect(spoofed.data.error).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
      details: { supplied_agent: "codex", bound_agent: "claude" },
    });
  });

  it("enforces delegation allow and deny policies before runtime invocation", async () => {
    let calls = 0;
    const adapter: AgentAdapter = {
      info: {
        agent: "codex",
        implementation: "policy-fixture",
        version: "1.0.0",
        capabilities: ["structured-deliverable"],
        max_concurrency: 1,
      },
      async health() {
        return { status: AdapterHealth.READY, checked_at: clock.now() };
      },
      async invoke(invocation, invocationContext) {
        calls += 1;
        const check = passing("policy fixture");
        await invocationContext.recordVerification(check);
        return {
          task_id: invocation.task_id,
          agent: "codex",
          status: DeliverableStatus.COMPLETE,
          summary: "allowed",
          changed_scope: invocation.spec.scope.paths,
          artifacts: [],
          commit_or_diff: null,
          verification_performed: [check.command],
          verification_results: [check],
          remaining_risks: [],
          dependencies_unblocked: [],
          recommended_next_action: "none",
          at: clock.now(),
        };
      },
      async cancel() {},
    };
    cp.adapters.register(adapter);

    const denied = await call(
      "bridge_delegate",
      {
        to: "codex",
        spec: spec(),
        deadline_ms: 5_000,
      },
      ctx("claude", "deny"),
    );
    expect(denied.isError).toBe(true);
    expect(denied.data.error).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
      details: { policy: "deny", caller: "claude", target: "codex" },
    });
    expect(calls).toBe(0);
    expect(cp.tasks.list()).toHaveLength(0);

    const deniedFromCodex = await call(
      "bridge_delegate",
      {
        to: "claude",
        spec: spec({ scope: CLAUDE_SCOPE }),
        deadline_ms: 5_000,
      },
      ctx("codex", "deny"),
    );
    expect(deniedFromCodex.isError).toBe(true);
    expect(deniedFromCodex.data.error).toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
      details: { policy: "deny", caller: "codex", target: "claude" },
    });
    expect(calls).toBe(0);
    expect(cp.tasks.list()).toHaveLength(0);

    const root = await call("bridge_create_task", {
      spec: spec({ scope: CLAUDE_SCOPE }),
      run_id: "run_0000000001",
    });
    const allowed = await call("bridge_delegate", {
      to: "codex",
      spec: spec(),
      run_id: root.data.run_id,
      parent_task_id: root.data.task_id,
      delegation_depth: 1,
      deadline_ms: 5_000,
    });
    expect(allowed.isError).toBe(false);
    expect(allowed.data.error).toBeNull();
    expect(allowed.data.deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(calls).toBe(1);
  });

  it("returns structured errors an agent can branch on, not prose", async () => {
    const created = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.tasks.claim(created.task_id, "codex");
    const stolen = await call("bridge_claim_task", { task_id: created.task_id });

    expect(stolen.isError).toBe(true);
    expect(stolen.data.error.code).toBe(ErrorCode.NOT_OWNER);
    expect(stolen.data.error.retryable).toBe(false);
  });

  it("answers 'is this scope free?' without mutating anything", async () => {
    const before = cp.lastEventId();
    const free = await call("bridge_check_scope", { scope: CODEX_SCOPE });
    expect(free.data.free).toBe(true);
    expect(cp.lastEventId()).toBe(before);
  });

  it("summarises the whole system for a supervisor in one call", async () => {
    await call("bridge_create_task", { spec: spec() });
    const snap = await call("bridge_snapshot");
    expect(snap.data.task_count).toBe(1);
    expect(snap.data.tasks_by_state.PENDING).toBe(1);
  });

  it("streams the event log incrementally from a cursor", async () => {
    await call("bridge_create_task", { spec: spec() });
    const first = await call("bridge_read_events", {});
    const cursor = first.data.last_event_id as number;
    await call("bridge_create_task", { spec: spec({ objective: "second" }) });

    const next = await call("bridge_read_events", { after: cursor });
    expect(next.data.events).toHaveLength(1);
    expect(next.data.events[0].payload.objective).toBe("second");
  });

  it("persists and returns an execution handle for the current attempt", async () => {
    const created = await call("bridge_create_task", { spec: spec({ scope: CLAUDE_SCOPE }) });
    const task_id = created.data.task_id as string;
    await call("bridge_claim_task", { task_id });

    const saved = await call("bridge_set_execution_handle", {
      task_id,
      execution_handle: "thread_abc123",
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.attempt).toBe(0);

    const fetched = await call("bridge_get_task", { task_id });
    expect(fetched.data.attempts[0].execution_handle).toBe("thread_abc123");
  });

  it("resumes an existing task through a minimal owner-bound MCP operation", async () => {
    const adapter: AgentAdapter = {
      info: {
        agent: "codex",
        implementation: "resume-tool-fixture",
        version: "1.0.0",
        capabilities: ["resume", "structured-deliverable"],
        max_concurrency: 1,
      },
      async health() {
        return { status: AdapterHealth.READY, checked_at: clock.now() };
      },
      async invoke(invocation, invocationContext) {
        await invocationContext.saveExecutionHandle(invocation.previous_execution_handle!);
        await invocationContext.reportTelemetry?.({ input_tokens: 4, output_tokens: 1, total_tokens: 5 });
        const check = passing("resume tool fixture");
        await invocationContext.recordVerification(check);
        return {
          task_id: invocation.task_id,
          agent: "codex",
          status: DeliverableStatus.COMPLETE,
          summary: "resumed",
          changed_scope: [],
          artifacts: [],
          commit_or_diff: null,
          verification_performed: [check.command],
          verification_results: [check],
          remaining_risks: [],
          dependencies_unblocked: [],
          recommended_next_action: "none",
          at: clock.now(),
        };
      },
      async cancel() {},
    };
    cp.adapters.register(adapter);
    const parent = cp.tasks.create({
      spec: spec({ scope: CLAUDE_SCOPE, preferred_agent: "claude" }),
      created_by: "claude",
      run_id: "run_0000000001",
    });
    const child = cp.tasks.create({
      spec: spec({ preferred_agent: "codex" }),
      created_by: "claude",
      parent_task_id: parent.task_id,
    });
    cp.tasks.claim(child.task_id, "codex");
    cp.tasks.transition({ task_id: child.task_id, agent: "codex", to: "WORKING" });
    cp.attempts.start(child.task_id, 0, "codex");
    cp.attempts.saveHandle(child.task_id, 0, "codex", "thread_resume_tool");
    cp.tasks.block(child.task_id, "codex", "stranded");

    const tool = TOOLS.find((candidate) => candidate.name === "bridge_resume_task")!;
    expect(Object.keys(tool.inputShape).sort()).toEqual(["idempotency_key", "task_id"]);
    const denied = await call(
      "bridge_resume_task",
      { task_id: child.task_id },
      ctx("claude"),
    );
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe(ErrorCode.NOT_OWNER);

    const resumed = await call(
      "bridge_resume_task",
      { task_id: child.task_id, idempotency_key: "resume-tool-once" },
      ctx("codex"),
    );
    expect(resumed.isError).toBe(false);
    expect(resumed.data).toMatchObject({
      task_id: child.task_id,
      previous_attempt: 0,
      recovered_attempt: 1,
      resumed_from_attempt: 0,
      same_execution_handle: true,
      state: TaskState.DONE,
    });
    expect(cp.tasks.list()).toHaveLength(2);
  });

  it("resumes a direct delegated child through a minimal manager-bound MCP operation", async () => {
    const invoked: string[] = [];
    const adapterFor = (agent: "claude" | "codex"): AgentAdapter => ({
      info: {
        agent,
        implementation: `${agent}-delegated-resume-tool-fixture`,
        version: "1.0.0",
        capabilities: ["resume", "structured-deliverable"],
        max_concurrency: 1,
      },
      async health() {
        return { status: AdapterHealth.READY, checked_at: clock.now() };
      },
      async invoke(invocation, invocationContext) {
        invoked.push(agent);
        await invocationContext.saveExecutionHandle(invocation.previous_execution_handle!);
        const check = passing("delegated resume tool fixture");
        await invocationContext.recordVerification(check);
        return {
          task_id: invocation.task_id,
          agent,
          status: DeliverableStatus.COMPLETE,
          summary: "delegated child resumed",
          changed_scope: [],
          artifacts: [],
          commit_or_diff: null,
          verification_performed: [check.command],
          verification_results: [check],
          remaining_risks: [],
          dependencies_unblocked: [],
          recommended_next_action: "none",
          at: clock.now(),
        };
      },
      async cancel() {},
    });
    cp.adapters.register(adapterFor("codex"));
    cp.adapters.register(adapterFor("claude"));

    const parent = cp.tasks.create({
      spec: spec({ preferred_agent: "codex" }),
      created_by: "codex",
      run_id: "run_0000000001",
    });
    cp.tasks.claim(parent.task_id, "codex");
    const child = cp.tasks.create({
      spec: spec({ scope: CLAUDE_SCOPE, preferred_agent: "claude" }),
      created_by: "codex",
      parent_task_id: parent.task_id,
    });
    cp.tasks.claim(child.task_id, "claude");
    cp.tasks.transition({ task_id: child.task_id, agent: "claude", to: TaskState.WORKING });
    cp.attempts.start(child.task_id, 0, "claude");
    cp.attempts.saveHandle(child.task_id, 0, "claude", "session_delegated_resume_tool");
    cp.tasks.block(child.task_id, "claude", "stranded");

    const tool = TOOLS.find(
      (candidate) => candidate.name === "bridge_resume_delegated_task",
    )!;
    expect(Object.keys(tool.inputShape).sort()).toEqual(["idempotency_key", "task_id"]);
    const resumed = await call(
      "bridge_resume_delegated_task",
      { task_id: child.task_id, idempotency_key: "delegated-resume-tool-once" },
      ctx("codex"),
    );
    expect(resumed.isError).toBe(false);
    expect(resumed.data).toMatchObject({
      task_id: child.task_id,
      owner: "claude",
      previous_attempt: 0,
      recovered_attempt: 1,
      resumed_from_attempt: 0,
      same_execution_handle: true,
      state: TaskState.DONE,
    });
    expect(invoked).toEqual(["claude"]);
    expect(cp.tasks.get(child.task_id).owner).toBe("claude");
    expect(cp.tasks.list()).toHaveLength(2);
  });

  it("creates child lineage and queries normalized telemetry without exporting handles", async () => {
    const root = await call("bridge_create_task", { spec: spec(), run_id: "run_0000000001" });
    const child = await call("bridge_create_task", {
      spec: spec({ scope: CLAUDE_SCOPE }),
      parent_task_id: root.data.task_id,
      delegation_depth: 1,
    });
    expect(child.data).toMatchObject({
      run_id: "run_0000000001",
      parent_task_id: root.data.task_id,
      delegation_depth: 1,
    });

    const task = cp.tasks.get(child.data.task_id as string);
    cp.attempts.start(task.task_id, 0, "claude");
    cp.attempts.saveHandle(task.task_id, 0, "claude", "session_not_exported");
    cp.attempts.recordTelemetry(
      normalizeAttemptTelemetry({
        task_id: task.task_id,
        run_id: task.run_id,
        parent_task_id: task.parent_task_id,
        delegation_depth: task.delegation_depth,
        attempt: 0,
        agent: "claude",
        orchestration_started_at: clock.now(),
        observed_runtime_started_at: clock.now(),
        observed_runtime_ended_at: clock.now(),
        completed_at: clock.now(),
        input_artifact_count: 0,
        input_artifact_bytes: 0,
        termination_kind: AttemptTerminationKind.COMPLETED,
        update: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    );

    const queried = await call("bridge_query_telemetry", {
      run_id: task.run_id,
      task_id: task.task_id,
      agent: "claude",
      attempt: 0,
    });
    expect(queried.data.count).toBe(1);
    expect(queried.data.records[0].total_tokens).toBe(5);
    expect(JSON.stringify(queried.data)).not.toContain("session_not_exported");
  });

  it("refuses an execution handle large enough to be a transcript", async () => {
    const created = await call("bridge_create_task", { spec: spec({ scope: CLAUDE_SCOPE }) });
    const task_id = created.data.task_id as string;
    await call("bridge_claim_task", { task_id });

    const res = await call("bridge_set_execution_handle", {
      task_id,
      execution_handle: "x".repeat(1024),
    });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});
