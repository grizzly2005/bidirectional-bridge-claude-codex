import {
  AdapterHealth,
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  type InvocationContext,
  type AttemptTelemetryUpdate,
  type TaskInvocation,
  type VerificationResult,
} from "@bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  CODEX_SHELL_ENVIRONMENT_FILTERS,
  CodexAdapter,
} from "./codex-adapter.js";
import type {
  CodexMcpClient,
  CodexMcpProbe,
  CodexMcpResponse,
  CodexReplyRequest,
  CodexStartRequest,
} from "./codex-mcp-client.js";

function resultJson(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    status: "COMPLETE",
    summary: "Codex completed the bounded task",
    changed_scope: [],
    artifacts: [],
    commit_or_diff: null,
    verification_results: [
      {
        kind: "test",
        command: "fixture verification",
        passed: true,
        exit_code: 0,
        summary: "fixture passed",
      },
    ],
    remaining_risks: [],
    recommended_next_action: "review",
    ...overrides,
  });
}

class FakeCodexClient implements CodexMcpClient {
  readonly starts: CodexStartRequest[] = [];
  readonly replies: CodexReplyRequest[] = [];
  closed = false;

  startImpl: (request: CodexStartRequest) => Promise<CodexMcpResponse> = async () => ({
    thread_id: "thread_1",
    content: resultJson(),
  });

  replyImpl: (request: CodexReplyRequest) => Promise<CodexMcpResponse> = async (
    request,
  ) => ({ thread_id: request.thread_id, content: resultJson() });

  async probe(): Promise<CodexMcpProbe> {
    return {
      state: "READY",
      detail: "fake ready",
      tools: ["codex", "codex-reply"],
    };
  }

  async start(request: CodexStartRequest): Promise<CodexMcpResponse> {
    this.starts.push(request);
    return this.startImpl(request);
  }

  async reply(request: CodexReplyRequest): Promise<CodexMcpResponse> {
    this.replies.push(request);
    return this.replyImpl(request);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface CapturedContext {
  readonly ctx: InvocationContext;
  readonly reports: Array<Parameters<InvocationContext["report"]>[0]>;
  readonly artifacts: Array<Parameters<InvocationContext["publishArtifact"]>[0]>;
  readonly verifications: VerificationResult[];
  readonly blockers: string[];
  readonly executionHandles: string[];
  readonly telemetry: AttemptTelemetryUpdate[];
}

function context(signal?: AbortSignal): CapturedContext {
  const reports: CapturedContext["reports"] = [];
  const artifacts: CapturedContext["artifacts"] = [];
  const verifications: VerificationResult[] = [];
  const blockers: string[] = [];
  const executionHandles: string[] = [];
  const telemetry: AttemptTelemetryUpdate[] = [];
  const controller = signal === undefined ? new AbortController() : undefined;
  return {
    reports,
    artifacts,
    verifications,
    blockers,
    executionHandles,
    telemetry,
    ctx: {
      async saveExecutionHandle(handle): Promise<void> {
        executionHandles.push(handle);
      },
      async reportTelemetry(update): Promise<void> {
        telemetry.push(update);
      },
      async report(update): Promise<void> {
        reports.push(update);
      },
      async publishArtifact(artifact): Promise<string> {
        artifacts.push(artifact);
        return `art_${String(artifacts.length).padStart(10, "0")}`;
      },
      async recordVerification(result): Promise<void> {
        verifications.push(result);
      },
      async raiseBlocker(reason): Promise<void> {
        blockers.push(reason);
      },
      signal: signal ?? controller!.signal,
    },
  };
}

function invocation(
  taskId = "task_0000000001",
  idempotencyKey = `key-${taskId}`,
): TaskInvocation {
  return {
    task_id: taskId,
    spec: {
      objective: "produce one bounded artifact",
      scope: { paths: ["codex/**"] },
      dependencies: [],
      expected_deliverable: "one report",
      verification_criteria: ["run npm test"],
    },
    inputs: [],
    workspace_root: process.cwd(),
    lease_id: "lease_0000000001",
    deadline_at: Date.now() + 5_000,
    attempt: 0,
    idempotency_key: idempotencyKey,
  };
}

describe("CodexAdapter", () => {
  it("implements the shared adapter contract and registers real evidence", async () => {
    const client = new FakeCodexClient();
    client.startImpl = async () => ({
      thread_id: "thread_success",
      telemetry: {
        runtime: "codex-app-server",
        runtime_version: "0.147.0",
        model: "gpt-5.6-sol",
        input_tokens: 120,
        output_tokens: 30,
        cached_input_tokens: 20,
        total_tokens: 150,
        turn_count: 1,
      },
      content: resultJson({
        changed_scope: ["codex/result.txt"],
        artifacts: [
          {
            kind: "report",
            name: "result",
            media_type: "text/plain",
            path: "codex/result.txt",
          },
        ],
        verification_results: [
          {
            kind: "test",
            command: "npm test",
            passed: true,
            exit_code: 0,
            summary: "tests passed",
          },
        ],
      }),
    });
    const captured = context();
    const adapter = new CodexAdapter({ client, max_concurrency: 2 });

    const health = await adapter.health();
    const deliverable = await adapter.invoke(invocation(), captured.ctx);

    expect(health.status).toBe(AdapterHealth.READY);
    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(deliverable.artifacts).toEqual(["art_0000000001"]);
    expect(captured.artifacts[0]).toMatchObject({ path: "codex/result.txt" });
    expect(captured.verifications[0]).toMatchObject({ command: "npm test", passed: true });
    expect(captured.reports.map((report) => report.state)).toContain("VERIFYING");
    expect(captured.executionHandles).toEqual(["thread_success"]);
    expect(captured.telemetry).toHaveLength(1);
    expect(captured.telemetry[0]).toMatchObject({
      runtime: "codex-app-server",
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      turn_count: 1,
    });
    expect(client.starts[0]?.developer_instructions).toContain("bounded");
  });

  it("excludes secret environment variables with the canonical filters allowlist", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAdapter({ client, tool_path: "C:\\safe-tools" });

    await adapter.invoke(invocation(), context().ctx);

    expect(client.starts[0]?.config).toEqual({
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        filters: CODEX_SHELL_ENVIRONMENT_FILTERS,
        set: { PATH: "C:\\safe-tools" },
      },
    });
    const serialized = JSON.stringify(client.starts[0]?.config);
    expect(serialized).not.toContain("BRIDGE_TEST_SECRET_TOKEN");
    expect(Object.keys(CODEX_SHELL_ENVIRONMENT_FILTERS)).not.toContain("OPENAI_API_KEY");
  });

  it("keeps the safe allowlist when callers disable only the PATH augmentation", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAdapter({ client, tool_path: null });

    await adapter.invoke(invocation(), context().ctx);

    expect(client.starts[0]?.config).toEqual({
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        filters: CODEX_SHELL_ENVIRONMENT_FILTERS,
      },
    });
  });

  it("persists the thread id before fallible result parsing", async () => {
    const client = new FakeCodexClient();
    client.startImpl = async () => ({
      thread_id: "thread_before_parse",
      content: "not valid bridge JSON",
    });
    const captured = context();
    const adapter = new CodexAdapter({ client, max_structure_repairs: 0 });

    const deliverable = await adapter.invoke(invocation(), captured.ctx);

    expect(captured.executionHandles).toEqual(["thread_before_parse"]);
    expect(deliverable.status).toBe(DeliverableStatus.FAILED);
  });

  it("resumes a persisted thread id with codex-reply after adapter restart", async () => {
    const client = new FakeCodexClient();
    client.replyImpl = async (request) => ({
      thread_id: request.thread_id,
      content: resultJson(),
    });
    const captured = context();
    const adapterAfterRestart = new CodexAdapter({ client });
    const resumed: TaskInvocation = {
      ...invocation("task_0000000007", "restart-key"),
      attempt: 1,
      previous_execution_handle: "thread_persisted_7",
    };

    const deliverable = await adapterAfterRestart.invoke(resumed, captured.ctx);

    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(client.starts).toHaveLength(0);
    expect(client.replies).toHaveLength(1);
    expect(client.replies[0]?.thread_id).toBe("thread_persisted_7");
    expect(client.replies[0]?.prompt).toContain("after a process restart");
    expect(captured.executionHandles).toEqual(["thread_persisted_7"]);
  });

  it("starts one replacement thread only when a persisted handle is explicitly stale", async () => {
    const client = new FakeCodexClient();
    client.replyImpl = async () => {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex thread not found");
    };
    client.startImpl = async () => ({
      thread_id: "thread_replacement",
      content: resultJson(),
    });
    const captured = context();
    const adapter = new CodexAdapter({ client });
    const resumed: TaskInvocation = {
      ...invocation("task_0000000008", "stale-key"),
      attempt: 1,
      previous_execution_handle: "thread_stale",
    };

    const deliverable = await adapter.invoke(resumed, captured.ctx);

    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(client.replies).toHaveLength(1);
    expect(client.starts).toHaveLength(1);
    expect(captured.executionHandles).toEqual(["thread_replacement"]);
  });

  it("never starts a replacement thread when strict recovery finds a stale handle", async () => {
    const client = new FakeCodexClient();
    client.replyImpl = async () => {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex thread not found");
    };
    const captured = context();
    const adapter = new CodexAdapter({ client });
    const resumed: TaskInvocation = {
      ...invocation("task_0000000009", "strict-stale-key"),
      attempt: 1,
      previous_execution_handle: "thread_stranded",
      resume_required: true,
    };

    await expect(adapter.invoke(resumed, captured.ctx)).rejects.toMatchObject({
      code: ErrorCode.ADAPTER_FAILURE,
    });
    expect(client.replies).toHaveLength(1);
    expect(client.starts).toHaveLength(0);
    expect(captured.executionHandles).toEqual([]);
  });

  it("uses codex-reply once to repair structure without rerunning the task", async () => {
    const client = new FakeCodexClient();
    client.startImpl = async () => ({
      thread_id: "thread_repair",
      content: "not json",
      telemetry: { input_tokens: 5, output_tokens: 2, total_tokens: 7, turn_count: 1 },
    });
    client.replyImpl = async (request) => ({
      thread_id: request.thread_id,
      content: resultJson(),
      telemetry: { input_tokens: 3, output_tokens: 1, total_tokens: 4, turn_count: 1 },
    });
    const adapter = new CodexAdapter({ client, max_structure_repairs: 1 });
    const captured = context();

    const deliverable = await adapter.invoke(invocation(), captured.ctx);

    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(client.starts).toHaveLength(1);
    expect(client.replies).toHaveLength(1);
    expect(client.replies[0]?.thread_id).toBe("thread_repair");
    expect(captured.telemetry[0]).toMatchObject({
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11,
      turn_count: 2,
    });
  });

  it("fails closed after an invalid out-of-scope result and one repair", async () => {
    const client = new FakeCodexClient();
    const invalid = resultJson({ changed_scope: ["claude/owned.ts"] });
    client.startImpl = async () => ({ thread_id: "thread_bad", content: invalid });
    client.replyImpl = async (request) => ({
      thread_id: request.thread_id,
      content: invalid,
    });
    const captured = context();
    const adapter = new CodexAdapter({ client, max_structure_repairs: 1 });

    const deliverable = await adapter.invoke(invocation(), captured.ctx);

    expect(deliverable.status).toBe(DeliverableStatus.FAILED);
    expect(deliverable.changed_scope).toEqual([]);
    expect(captured.artifacts).toHaveLength(0);
    expect(client.replies).toHaveLength(1);
  });

  it("rejects duplicate idempotency keys with a different invocation payload", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAdapter({ client });
    const firstInvocation = invocation();
    const first = await adapter.invoke(firstInvocation, context().ctx);
    const replay = await adapter.invoke(firstInvocation, context().ctx);

    expect(replay).toEqual(first);
    expect(client.starts).toHaveLength(1);

    const changed: TaskInvocation = {
      ...firstInvocation,
      spec: { ...firstInvocation.spec, objective: "different objective" },
    };
    await expect(adapter.invoke(changed, context().ctx)).rejects.toMatchObject<
      Partial<BridgeError>
    >({ code: ErrorCode.IDEMPOTENCY_MISMATCH });
  });

  it("replays a settled transport failure instead of duplicating work for the same key", async () => {
    const client = new FakeCodexClient();
    let calls = 0;
    client.startImpl = async () => {
      calls += 1;
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "transport lost after dispatch");
    };
    const adapter = new CodexAdapter({ client });
    const task = invocation();

    await expect(adapter.invoke(task, context().ctx)).rejects.toMatchObject({
      code: ErrorCode.ADAPTER_FAILURE,
    });
    await expect(adapter.invoke(task, context().ctx)).rejects.toMatchObject({
      code: ErrorCode.ADAPTER_FAILURE,
    });

    expect(calls).toBe(1);
  });

  it("cancels one task without cancelling a concurrent task", async () => {
    const client = new FakeCodexClient();
    let callIndex = 0;
    let active = 0;
    let maxActive = 0;
    client.startImpl = (request) => {
      const index = callIndex;
      callIndex += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const waitMs = index === 0 ? 300 : 40;
      return new Promise<CodexMcpResponse>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          active -= 1;
          request.signal.removeEventListener("abort", onAbort);
          action();
        };
        const timer = setTimeout(() => {
          finish(() => resolve({ thread_id: `thread_${index}`, content: resultJson() }));
        }, waitMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          const error = new Error("cancelled");
          error.name = "AbortError";
          finish(() => reject(error));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const adapter = new CodexAdapter({ client, max_concurrency: 2 });
    const taskOne = invocation("task_0000000001", "concurrent-1");
    const taskTwo = invocation("task_0000000002", "concurrent-2");

    const first = adapter.invoke(taskOne, context().ctx);
    const second = adapter.invoke(taskTwo, context().ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adapter.cancel(taskOne.task_id, "supervisor cancelled only task one");

    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(DeliverableStatus.PARTIAL);
    expect(two.status).toBe(DeliverableStatus.COMPLETE);
    expect(maxActive).toBe(2);
  });

  it("returns PARTIAL without launching Codex when the deadline already elapsed", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAdapter({ client });
    const expired: TaskInvocation = {
      ...invocation(),
      deadline_at: Date.now() - 1,
    };

    const deliverable = await adapter.invoke(expired, context().ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(client.starts).toHaveLength(0);
  });

  it("honors a control-plane signal that was aborted before invoke", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAdapter({ client });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));

    const deliverable = await adapter.invoke(invocation(), context(controller.signal).ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.summary).toContain("cancelled before dispatch");
    expect(client.starts).toHaveLength(0);
  });

  it("aborts and drains an active invocation before dispose resolves", async () => {
    const client = new FakeCodexClient();
    client.startImpl = (request) =>
      new Promise<CodexMcpResponse>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted by dispose");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const adapter = new CodexAdapter({ client });
    const run = adapter.invoke(invocation(), context().ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await adapter.dispose();
    const deliverable = await run;

    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.summary).toContain("adapter disposed");
    expect(client.closed).toBe(true);
  });
});
