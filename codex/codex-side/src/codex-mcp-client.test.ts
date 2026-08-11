import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BridgeError, ErrorCode } from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDefaultCodexToolPath,
  CodexMcpProcessClient,
  type CodexMcpProcessClientOptions,
} from "./codex-mcp-client.js";

const fixture = fileURLToPath(
  new URL("../test/fixtures/fake-codex-mcp-server.mjs", import.meta.url),
);
const execResumeFixture = fileURLToPath(
  new URL("../test/fixtures/fake-codex-exec-resume.mjs", import.meta.url),
);

const clients: CodexMcpProcessClient[] = [];

function makeClient(
  mode = "normal",
  extraEnv: Readonly<Record<string, string>> = {},
  overrides: CodexMcpProcessClientOptions = {},
): CodexMcpProcessClient {
  const client = new CodexMcpProcessClient({
    server_command: process.execPath,
    server_args: [fixture],
    env: { FAKE_CODEX_MCP_MODE: mode, ...extraEnv },
    connect_timeout_ms: 2_000,
    request_timeout_ms: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("CodexMcpProcessClient", () => {
  it("rejects invalid timeout and stderr bounds at construction", () => {
    expect(() => new CodexMcpProcessClient({ connect_timeout_ms: 0 })).toThrowError(
      expect.objectContaining<Partial<BridgeError>>({ code: ErrorCode.INVALID_ARGUMENT }),
    );
    expect(() => new CodexMcpProcessClient({ stderr_tail_chars: 0 })).toThrowError(
      expect.objectContaining<Partial<BridgeError>>({ code: ErrorCode.INVALID_ARGUMENT }),
    );
  });

  it("prepends a discovered Codex runtime Node directory without duplicating PATH entries", () => {
    const runtime = join(process.cwd(), ".fake-runtime", "dependencies");
    const fallback = join(runtime, "bin", "fallback");
    const other = join(process.cwd(), ".fake-tools");
    const nodeExecutable = join(
      runtime,
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );

    const built = buildDefaultCodexToolPath(
      [fallback, other, fallback].join(delimiter),
      (candidate) => candidate === nodeExecutable,
    );

    expect(built?.split(delimiter)).toEqual([dirname(nodeExecutable), fallback, other]);
  });

  it("starts and continues the same Codex thread over stdio MCP", async () => {
    const client = makeClient();
    const signal = new AbortController().signal;

    const first = await client.start({
      prompt: "bounded task",
      cwd: process.cwd(),
      approval_policy: "never",
      sandbox: "workspace-write",
      timeout_ms: 1_000,
      signal,
    });
    const reply = await client.reply({
      thread_id: first.thread_id,
      prompt: "format only",
      timeout_ms: 1_000,
      signal,
    });

    expect(first.thread_id).toBe("thread_fake_1");
    expect(reply.thread_id).toBe(first.thread_id);
    expect(JSON.parse(reply.content)).toMatchObject({ status: "COMPLETE" });
  });

  it("resumes the persisted CLI session when a replacement MCP server forgot the thread", async () => {
    const firstClient = makeClient();
    const signal = new AbortController().signal;
    const first = await firstClient.start({
      prompt: "bounded task",
      cwd: process.cwd(),
      approval_policy: "never",
      sandbox: "read-only",
      timeout_ms: 1_000,
      signal,
    });
    await firstClient.close();

    const expected = JSON.stringify({
      status: "PARTIAL",
      summary: "recalled prior result",
      changed_scope: [],
      artifacts: [],
      commit_or_diff: null,
      verification_results: [],
      remaining_risks: [],
      recommended_next_action: "none",
    });
    const restartedClient = makeClient(
      "stale-reply",
      {
        FAKE_CODEX_EXEC_CONTENT: expected,
      },
      {
        resume_command: process.execPath,
        resume_args: [execResumeFixture],
      },
    );

    const resumed = await restartedClient.reply({
      thread_id: first.thread_id,
      prompt: "continue without repeating work",
      timeout_ms: 1_000,
      signal,
    });

    expect(resumed.thread_id).toBe(first.thread_id);
    expect(JSON.parse(resumed.content)).toMatchObject({
      status: "PARTIAL",
      summary: "recalled prior result",
    });
  });

  it("terminates a persisted CLI resume when its signal is cancelled", async () => {
    const client = makeClient(
      "stale-reply",
      { FAKE_CODEX_EXEC_MODE: "hang" },
      { resume_command: process.execPath, resume_args: [execResumeFixture] },
    );
    const controller = new AbortController();
    const call = client.reply({
      thread_id: "thread_persisted",
      prompt: "continue",
      timeout_ms: 1_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);

    await expect(call).rejects.toMatchObject<Partial<BridgeError>>({
      code: ErrorCode.TIMEOUT,
    });
  });

  it("reports a degraded health state when codex-reply is absent", async () => {
    const report = await makeClient("missing-reply").probe();
    expect(report.state).toBe("DEGRADED");
    expect(report.detail).toContain("codex-reply");
  });

  it("maps a request deadline to the stable TIMEOUT code", async () => {
    const client = makeClient("slow", { FAKE_CODEX_MCP_DELAY_MS: "300" });
    const call = client.start({
      prompt: "slow task",
      cwd: process.cwd(),
      approval_policy: "never",
      sandbox: "workspace-write",
      timeout_ms: 40,
      signal: new AbortController().signal,
    });

    await expect(call).rejects.toMatchObject<Partial<BridgeError>>({
      code: ErrorCode.TIMEOUT,
    });
  });

  it("fails closed when structuredContent omits the thread id", async () => {
    const client = makeClient("malformed");
    const call = client.start({
      prompt: "task",
      cwd: process.cwd(),
      approval_policy: "never",
      sandbox: "workspace-write",
      timeout_ms: 1_000,
      signal: new AbortController().signal,
    });

    await expect(call).rejects.toMatchObject<Partial<BridgeError>>({
      code: ErrorCode.ADAPTER_FAILURE,
    });
  });

  it("reports an unavailable health state when the server process exits", async () => {
    const client = new CodexMcpProcessClient({
      server_command: process.execPath,
      server_args: ["-e", "process.exit(7)"],
      connect_timeout_ms: 500,
    });
    clients.push(client);

    const report = await client.probe();
    expect(report.state).toBe("UNAVAILABLE");
    expect(report.detail).toContain("ADAPTER_FAILURE");
  });
});
