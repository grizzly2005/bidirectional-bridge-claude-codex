#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BridgeMcpServer,
  serve,
  stderrLog,
  type LogSink,
  type ServeHandle,
} from "@bridge/mcp-server-core";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentId } from "@bridge/protocol";

import { CodexAdapter } from "./codex-adapter.js";
import { CodexAppServerProcessClient } from "./codex-app-server-client.js";
import type {
  CodexApprovalPolicy,
  CodexMcpClient,
  CodexSandbox,
} from "./codex-mcp-client.js";

export interface CodexBridgeServerArgs {
  readonly workspace: string;
  readonly database_path?: string;
  readonly agent: AgentId;
  readonly model?: string;
  readonly max_concurrency: number;
  readonly approval_policy: CodexApprovalPolicy;
  readonly sandbox: CodexSandbox;
  readonly runtime_transport: "mcp" | "app-server";
  readonly tool_path?: string | null;
  readonly help: boolean;
}

/** Test/embedder hooks; production callers use the defaults. */
export interface CodexBridgeServerRuntimeOptions {
  readonly client?: CodexMcpClient;
  readonly transport?: Transport;
  readonly handle_signals?: boolean;
  readonly log?: LogSink;
}

const APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(["untrusted", "on-request", "never"]);
const SANDBOXES = new Set<CodexSandbox>(["read-only", "workspace-write", "danger-full-access"]);

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Strict CLI parsing keeps a misspelled safety option from silently using a default. */
export function parseBridgeServerArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): CodexBridgeServerArgs {
  let workspace = resolve(cwd);
  let databasePath: string | undefined;
  let agent: AgentId = "codex";
  let model: string | undefined;
  let maxConcurrency = 2;
  let approvalPolicy: CodexApprovalPolicy = "never";
  let sandbox: CodexSandbox = "workspace-write";
  let runtimeTransport: "mcp" | "app-server" = "mcp";
  let toolPath: string | null | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--workspace":
      case "-w":
        workspace = resolve(valueAfter(argv, index, flag));
        index += 1;
        break;
      case "--db":
        databasePath = resolve(valueAfter(argv, index, flag));
        index += 1;
        break;
      case "--agent":
      case "-a":
        agent = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--model":
        model = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--max-concurrency": {
        const raw = valueAfter(argv, index, flag);
        maxConcurrency = Number(raw);
        if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
          throw new Error("--max-concurrency must be a positive integer");
        }
        index += 1;
        break;
      }
      case "--approval-policy": {
        const raw = valueAfter(argv, index, flag) as CodexApprovalPolicy;
        if (!APPROVAL_POLICIES.has(raw)) {
          throw new Error("--approval-policy must be untrusted, on-request, or never");
        }
        approvalPolicy = raw;
        index += 1;
        break;
      }
      case "--sandbox": {
        const raw = valueAfter(argv, index, flag) as CodexSandbox;
        if (!SANDBOXES.has(raw)) {
          throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access");
        }
        sandbox = raw;
        index += 1;
        break;
      }
      case "--runtime-transport": {
        const raw = valueAfter(argv, index, flag);
        if (raw !== "mcp" && raw !== "app-server") {
          throw new Error("--runtime-transport must be mcp or app-server");
        }
        runtimeTransport = raw;
        index += 1;
        break;
      }
      case "--tool-path":
        if (toolPath === null) throw new Error("--tool-path conflicts with --no-tool-path");
        toolPath = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--no-tool-path":
        if (typeof toolPath === "string") {
          throw new Error("--no-tool-path conflicts with --tool-path");
        }
        toolPath = null;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag ?? "<empty>"}`);
    }
  }

  return {
    workspace,
    ...(databasePath ? { database_path: databasePath } : {}),
    agent,
    ...(model ? { model } : {}),
    max_concurrency: maxConcurrency,
    approval_policy: approvalPolicy,
    sandbox,
    runtime_transport: runtimeTransport,
    ...(toolPath !== undefined ? { tool_path: toolPath } : {}),
    help,
  };
}

export const BRIDGE_SERVER_HELP = `bridge-codex-mcp — coordination MCP server with the real Codex adapter

  --workspace, -w       repository root (default: cwd)
  --db                  SQLite database path (default: <workspace>/.bridge/bridge.db)
  --agent, -a           identity for coordination calls (default: codex)
  --model               optional Codex model override
  --max-concurrency     bounded simultaneous Codex tasks (default: 2)
  --approval-policy     untrusted | on-request | never (default: never)
  --sandbox             read-only | workspace-write | danger-full-access
                        (default: workspace-write)
  --runtime-transport   mcp | app-server (default: mcp). App Server is the
                        telemetry-capable path; certified MCP remains available.
  --tool-path           exact PATH exposed to delegated shell commands
  --no-tool-path        disable automatic safe tool-PATH augmentation
`;

export async function runBridgeServer(
  args: CodexBridgeServerArgs,
  runtime: CodexBridgeServerRuntimeOptions = {},
): Promise<ServeHandle> {
  const log = runtime.log ?? stderrLog;
  const client =
    runtime.client ??
    (args.runtime_transport === "app-server" ? new CodexAppServerProcessClient() : undefined);
  const adapter = new CodexAdapter({
    ...(client ? { client } : {}),
    implementation:
      args.runtime_transport === "app-server"
        ? "official-codex-app-server"
        : "official-codex-cli-mcp",
    ...(args.model ? { model: args.model } : {}),
    max_concurrency: args.max_concurrency,
    approval_policy: args.approval_policy,
    sandbox: args.sandbox,
    ...(args.tool_path !== undefined ? { tool_path: args.tool_path } : {}),
  });
  const server = new BridgeMcpServer({
    workspaceRoot: args.workspace,
    ...(args.database_path ? { databasePath: args.database_path } : {}),
    agent: args.agent,
    adapters: [adapter],
    onWarning: (message) => log(`[bridge-codex] warning: ${message}`),
  });

  const health = await adapter.health();
  log(`[bridge-codex] adapter=${health.status}${health.detail ? ` (${health.detail})` : ""}`);
  return serve({
    server,
    label: "bridge-codex",
    adapters: [adapter],
    ...(runtime.transport ? { transport: runtime.transport } : {}),
    ...(runtime.handle_signals !== undefined
      ? { handleSignals: runtime.handle_signals }
      : {}),
    log,
  });
}

async function main(): Promise<void> {
  const args = parseBridgeServerArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(BRIDGE_SERVER_HELP);
    return;
  }
  await runBridgeServer(args);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`[bridge-codex] fatal: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
