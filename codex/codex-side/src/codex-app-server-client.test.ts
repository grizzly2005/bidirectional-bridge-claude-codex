import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { ErrorCode } from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerProcessClient } from "./codex-app-server-client.js";

const fixture = resolve(
  process.cwd(),
  "codex/codex-side/test/fixtures/fake-codex-app-server.mjs",
);
const currentTimeFixture = resolve(
  process.cwd(),
  "codex/codex-side/test/fixtures/fake-codex-app-server-current-time.mjs",
);
const clients: CodexAppServerProcessClient[] = [];
const temporaryDirectories: string[] = [];

const request = (signal: AbortSignal) => ({
  prompt: "return one fixture result",
  cwd: process.cwd(),
  approval_policy: "never" as const,
  sandbox: "read-only" as const,
  timeout_ms: 2_000,
  signal,
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Codex Windows WSL session boundary", () => {
  const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\kali\\worker-test";
  const runtimeCwd = "/home/kali/worker-test";
  function setup(extraArgs: string[] = []) {
    const directory = mkdtempSync(join(tmpdir(), "bridge-wsl-rpc-"));
    temporaryDirectories.push(directory);
    const capture = join(directory, "requests.jsonl");
    const make = () => {
      const client = new CodexAppServerProcessClient({ cwd: workspace, wsl_executable: "/usr/local/bin/codex",
        command: process.execPath, args: [fixture, "--linux-platform", `--capture=${capture}`, `--read-cwd=${runtimeCwd}`, ...extraArgs] });
      clients.push(client);
      return client;
    };
    return { make, messages: () => readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
  }

  it.each(["read-only", "workspace-write"] as const)("keeps Linux cwd, roots and %s policy across start and same-thread restart", async sandbox => {
    const { make, messages } = setup();
    const first = make();
    const started = await first.start({ ...request(new AbortController().signal), cwd: workspace, sandbox,
      config: { sandbox_workspace_write: { writable_roots: [`${workspace}\\output`] } } });
    await first.close();
    const second = make();
    const resumed = await second.reply({ thread_id: started.thread_id, cwd: workspace, sandbox, approval_policy: "never",
      config: { mcp_servers: { bridge: { enabled: false } } }, prompt: "continue same child", timeout_ms: 2000, signal: new AbortController().signal });
    expect(resumed.thread_id).toBe(started.thread_id);
    const wire = messages();
    for (const message of wire.filter(item => ["config/read", "thread/start", "thread/resume", "turn/start"].includes(item.method))) {
      expect(message.params.cwd).toBe(runtimeCwd);
      expect(JSON.stringify(message.params)).not.toContain("wsl.localhost");
      if (message.method !== "config/read") {
        expect(message.params.runtimeWorkspaceRoots).toEqual([runtimeCwd]);
        expect(message.params.approvalPolicy).toBe("never");
      }
    }
    expect(wire.find(item => item.method === "thread/start").params.config.sandbox_workspace_write.writable_roots).toEqual([`${runtimeCwd}/output`]);
    expect(wire.filter(item => item.method === "turn/start").every(item => item.params.sandboxPolicy.type === (sandbox === "read-only" ? "readOnly" : "workspaceWrite"))).toBe(true);
    expect(wire.find(item => item.method === "thread/resume").params.config.mcp_servers.bridge.enabled).toBe(false);
  });

  it("rejects a retained foreign permission root before a turn", async () => {
    const { make, messages } = setup(["--foreign-root"]);
    let handles = 0;
    await expect(make().start({ ...request(new AbortController().signal), cwd: workspace,
      on_execution_handle: async () => { handles++; } })).rejects.toMatchObject({ code: "RUNTIME_PROFILE_MISMATCH", details: { runtime_stop_confirmed: true } });
    expect(handles).toBe(0);
    expect(messages().some(item => item.method === "turn/start")).toBe(false);
  });

  it("does not relocate a persisted thread from another repository on resume", async () => {
    const { make, messages } = setup(["--foreign-stored-workspace"]);
    await expect(make().reply({ thread_id: "previous_thread", cwd: workspace, sandbox: "read-only", approval_policy: "never",
      prompt: "continue", timeout_ms: 2000, signal: new AbortController().signal })).rejects.toMatchObject({ code: "RUNTIME_PROFILE_MISMATCH" });
    expect(messages().some(item => item.method === "thread/resume" || item.method === "turn/start")).toBe(false);
  });

  it("does not create an invalid disabled bridge entry in a separate Linux config", async () => {
    const { make, messages } = setup(["--without-project-bridge"]);
    await make().start({ ...request(new AbortController().signal), cwd: workspace, config: {
      mcp_servers: { bridge: { enabled: false }, peer: { command: "/usr/local/bin/peer" } },
    } });
    expect(messages().find(item => item.method === "thread/start").params.config.mcp_servers).toEqual({ peer: { command: "/usr/local/bin/peer" } });
  });

  it("rejects Windows Codex launched through WSL interop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-wsl-interop-"));
    temporaryDirectories.push(directory);
    const capture = join(directory, "requests.jsonl");
    const client = new CodexAppServerProcessClient({ cwd: workspace, wsl_executable: "/usr/local/bin/codex",
      command: process.execPath, args: [fixture, `--capture=${capture}`] });
    clients.push(client);
    await expect(client.start({ ...request(new AbortController().signal), cwd: workspace })).rejects.toMatchObject({ code: "RUNTIME_PROFILE_MISMATCH" });
    expect(readFileSync(capture, "utf8")).not.toContain("thread/start");
  });

  it("refuses native UNC even when the bootstrap cwd is local", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture], cwd: process.cwd() });
    clients.push(client);
    await expect(client.start({ ...request(new AbortController().signal), cwd: workspace })).rejects.toMatchObject({ code: "RUNTIME_PROFILE_MISMATCH", details: { runtime_stop_confirmed: true } });
  });
});

describe("CodexAppServerProcessClient", () => {
  it("preserves read-only overrides on persisted resume and another loaded-thread turn", async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "codex-sandbox-"));
    const log = resolve(workspace, "requests.jsonl");
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture, `--record=${log}`] });
    clients.push(client);
    try {
      const reply = { thread_id: "persisted-read-only", prompt: "fixture", cwd: process.cwd(),
        sandbox: "read-only" as const, timeout_ms: 2_000, signal: new AbortController().signal };
      await client.reply(reply); await client.reply(reply);
      const messages = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(messages.filter(m => m.method === "thread/resume")).toHaveLength(1);
      expect(messages.find(m => m.method === "thread/resume").params.sandbox).toBe("read-only");
      const turns = messages.filter(m => m.method === "turn/start");
      expect(turns).toHaveLength(2);
      expect(turns.every(m => m.params.sandboxPolicy?.type === "readOnly")).toBe(true);
    } finally {
      await client.close();
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it.each(["null", "array", "notification"])("contains malformed %s stdout frames without fabricating stop proof", async bad => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture, `--bad-frame=${bad}`], stop_timeout_ms: 100 });
    clients.push(client);
    const error = await client.start(request(new AbortController().signal)).then(() => null, error => error);
    expect(error).toMatchObject({ code: "RUNTIME_STOP_UNCONFIRMED", details: { original_code: "ADAPTER_FAILURE", runtime_stop_confirmed: false } });
    expect(JSON.stringify(error)).not.toContain("SENSITIVE_FRAME_MARKER");
    await expect(client.start(request(new AbortController().signal))).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
  });

  it("allows a turn to outlive the RPC acknowledgement timeout", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture, "--delayed-turn"], request_timeout_ms: 75 });
    clients.push(client);
    const result = await client.start({ ...request(new AbortController().signal), timeout_ms: 1000 });
    expect(result.content).toContain("fixture complete");
  });
  it("does not let one caller abort another caller's shared model-catalog preflight", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture, "--slow-catalog"] });
    clients.push(client); await client.probe();
    const first = new AbortController();
    const cancelled = client.start(request(first.signal)).catch(error => error);
    const independent = client.start(request(new AbortController().signal));
    const observed = independent.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 35)); first.abort();
    expect((await cancelled).details?.runtime_stop_confirmed).toBe(true);
    expect(await observed).toMatchObject({ thread_id: "thread_app_1", telemetry: { model: "gpt-fixture" } });
  });
  it("uses the runtime catalog default when an implicit desktop model is unavailable", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    const result = await client.start(request(new AbortController().signal));
    expect(result.telemetry?.model).toBe("gpt-fixture");
  });

  it("rejects an explicit unavailable model before any worker thread is created", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    let handles = 0;
    const lifecycle: string[] = [];
    await expect(client.start({ ...request(new AbortController().signal), model: "unavailable-explicit",
      on_execution_handle: async () => { handles++; }, on_runtime_state: async state => { lifecycle.push(state); } }))
      .rejects.toMatchObject({ code: "RUNTIME_PROFILE_MISMATCH", details: { runtime_stop_confirmed: true,
        runtime_failure: { category: "profile", retryable: false } } });
    expect(handles).toBe(0);
    expect(lifecycle).toEqual(["stopped"]);
  });
  it("answers bidirectional currentTime/read requests without hanging the turn", async () => {
    const client = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [currentTimeFixture],
      now: () => 1_800_000_000_123,
    });
    clients.push(client);

    const response = await client.start(request(new AbortController().signal));

    expect(response.content).toContain("current-time request answered");
    expect(response.telemetry).toMatchObject({
      runtime: "codex-app-server",
      total_tokens: 12,
      turn_count: 1,
    });
  });

  it("persists the thread before generation and captures correlated numeric usage", async () => {
    let now = 1_800_000_000_000;
    const client = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [fixture],
      request_timeout_ms: 2_000,
      now: () => ++now,
    });
    clients.push(client);
    const order: string[] = [];
    const response = await client.start({
      ...request(new AbortController().signal),
      on_execution_handle: async (threadId) => {
        order.push(`handle:${threadId}`);
      },
    });
    order.push("result");

    expect(order).toEqual(["handle:thread_app_1", "result"]);
    expect(response.content).toContain("fixture complete");
    expect(response.telemetry).toMatchObject({
      runtime: "codex-app-server",
      runtime_version: "0.147.0",
      model: "gpt-fixture",
      input_tokens: 40,
      output_tokens: 5,
      cached_input_tokens: 3,
      cache_creation_input_tokens: 1,
      total_tokens: 45,
      cumulative_session_tokens: 45,
      turn_count: 1,
      runtime_duration_ms: 750,
      process_exit_code: null,
    });
    expect(typeof response.telemetry?.first_output_at).toBe("number");
    expect(JSON.stringify(response.telemetry)).not.toContain(response.thread_id);
  });

  it("resumes a persisted thread in a fresh App Server process", async () => {
    const first = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture] });
    clients.push(first);
    const started = await first.start(request(new AbortController().signal));
    await first.close();

    const restarted = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [fixture],
    });
    clients.push(restarted);
    const handles: string[] = [];
    const resumed = await restarted.reply({
      thread_id: started.thread_id,
      prompt: "continue fixture",
      timeout_ms: 2_000,
      signal: new AbortController().signal,
      on_execution_handle: async (threadId) => {
        handles.push(threadId);
      },
    });

    expect(resumed.thread_id).toBe(started.thread_id);
    expect(handles).toEqual([started.thread_id]);
    expect(resumed.telemetry?.total_tokens).toBe(45);
    expect(resumed.telemetry?.cumulative_session_tokens).toBe(90);
  });

  it("sums every model-usage update in one tool-using Codex turn", async () => {
    const client = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [fixture, "--multi-usage"],
    });
    clients.push(client);
    const response = await client.start(request(new AbortController().signal));

    expect(response.telemetry).toMatchObject({
      input_tokens: 58,
      output_tokens: 7,
      cached_input_tokens: 5,
      cache_creation_input_tokens: 1,
      total_tokens: 65,
      cumulative_session_tokens: 65,
      turn_count: 1,
    });
  });

  it("preserves a completed result with unknown usage in operational mode", async () => {
    const client = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [fixture, "--omit-usage"],
      request_timeout_ms: 100,
    });
    clients.push(client);

    const result = await client.start(request(new AbortController().signal));
    expect(result.content).toContain("fixture complete");
    expect(result.telemetry?.total_tokens).toBeNull();
    expect(result.telemetry?.input_tokens).toBeNull();
  });

  it("enforces explicit strict metrics without calling a completed turn a runtime timeout", async () => {
    const client = new CodexAppServerProcessClient({
      command: process.execPath, args: [fixture, "--omit-usage"], request_timeout_ms: 100,
    });
    clients.push(client);
    await expect(client.start({ ...request(new AbortController().signal), telemetry_mode: "strict" }))
      .rejects.toMatchObject({ code: "TELEMETRY_INCOMPLETE", details: { runtime_stop_confirmed: true } });
  });

  it("reports a failed turn immediately when the runtime emits no usage", async () => {
    const client = new CodexAppServerProcessClient({
      command: process.execPath,
      args: [fixture, "--failed-without-usage"],
      request_timeout_ms: 2_000,
    });
    clients.push(client);

    await expect(client.start(request(new AbortController().signal))).rejects.toMatchObject({
      code: ErrorCode.ADAPTER_FAILURE,
      message: "Codex App Server turn failed: fixture credits unavailable",
    });
  });

  it("closes the child and becomes unavailable", async () => {
    const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    expect((await client.probe()).state).toBe("READY");
    await client.close();
    expect((await client.probe()).state).toBe("UNAVAILABLE");
  });
});
