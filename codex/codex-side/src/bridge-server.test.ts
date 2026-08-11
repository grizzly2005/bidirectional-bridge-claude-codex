import { resolve } from "node:path";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_SERVER_HELP,
  parseBridgeServerArgs,
  runBridgeServer,
} from "./bridge-server.js";
import type { CodexMcpClient } from "./codex-mcp-client.js";

describe("parseBridgeServerArgs", () => {
  it("uses bounded, non-interactive defaults for the Codex-facing server", () => {
    expect(parseBridgeServerArgs([], "C:/bridge")).toEqual({
      workspace: resolve("C:/bridge"),
      agent: "codex",
      max_concurrency: 2,
      approval_policy: "never",
      sandbox: "workspace-write",
      runtime_transport: "mcp",
      help: false,
    });
  });

  it("accepts explicit lifecycle and Codex execution options", () => {
    expect(
      parseBridgeServerArgs(
        [
          "--workspace",
          "C:/repo",
          "--db",
          "C:/state/bridge.db",
          "--agent",
          "claude",
          "--model",
          "gpt-5.6-codex",
          "--max-concurrency",
          "3",
          "--approval-policy",
          "on-request",
          "--sandbox",
          "read-only",
          "--runtime-transport",
          "app-server",
          "--tool-path",
          "C:/safe-tools",
        ],
        "C:/unused",
      ),
    ).toMatchObject({
      workspace: resolve("C:/repo"),
      database_path: resolve("C:/state/bridge.db"),
      agent: "claude",
      model: "gpt-5.6-codex",
      max_concurrency: 3,
      approval_policy: "on-request",
      sandbox: "read-only",
      runtime_transport: "app-server",
      tool_path: "C:/safe-tools",
    });
  });

  it.each([
    [["--max-concurrency", "0"], "positive integer"],
    [["--approval-policy", "always"], "approval-policy"],
    [["--sandbox", "host"], "sandbox"],
    [["--runtime-transport", "sidecar"], "runtime-transport"],
    [["--workspace"], "requires a value"],
    [["--no-tool-path", "--tool-path", "C:/tools"], "conflicts"],
    [["--mystery"], "unknown option"],
  ] as const)("rejects unsafe or ambiguous argv %j", (argv, message) => {
    expect(() => parseBridgeServerArgs(argv, "C:/bridge")).toThrow(message);
  });

  it("documents the safety and concurrency controls", () => {
    expect(BRIDGE_SERVER_HELP).toContain("--approval-policy");
    expect(BRIDGE_SERVER_HELP).toContain("--sandbox");
    expect(BRIDGE_SERVER_HELP).toContain("--max-concurrency");
    expect(BRIDGE_SERVER_HELP).toContain("--tool-path");
    expect(BRIDGE_SERVER_HELP).toContain("--runtime-transport");
  });

  it("shuts down the Codex adapter when neutral-server startup fails", async () => {
    let clientClosed = false;
    const client: CodexMcpClient = {
      async probe() {
        return { state: "READY", detail: "fixture ready", tools: ["codex", "codex-reply"] };
      },
      async start() {
        throw new Error("not invoked");
      },
      async reply() {
        throw new Error("not invoked");
      },
      async close() {
        clientClosed = true;
      },
    };
    const failingTransport: Transport = {
      async start() {
        throw new Error("simulated transport startup failure");
      },
      async send() {
        // The transport fails before a message can be sent.
      },
      async close() {
        // No external resource in this fixture.
      },
    };
    const args = {
      ...parseBridgeServerArgs([], process.cwd()),
      database_path: ":memory:",
    };

    await expect(
      runBridgeServer(args, {
        client,
        transport: failingTransport,
        handle_signals: false,
        log: () => undefined,
      }),
    ).rejects.toThrow("simulated transport startup failure");

    expect(clientClosed).toBe(true);
  });
});
