#!/usr/bin/env node
/**
 * Claude's launcher for the coordination bridge.
 *
 * Claude-specific only: argument parsing, Claude's identity, and (optionally) registering a
 * Claude adapter. The MCP server, tool surface, and shutdown sequence come from
 * `@bridge/mcp-server-core`, which both agents share.
 *
 * Register with Claude Code:
 *   claude mcp add bridge -- node /abs/path/claude/claude-side/dist/server/main.js \
 *     --workspace /abs/path --agent claude
 *
 * stdout carries MCP protocol frames and nothing else. Every diagnostic goes to stderr;
 * a stray stdout write desynchronises the peer's JSON-RPC parser.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeMcpServer, serve, stderrLog } from "@bridge/mcp-server-core";
import {
  DEFAULT_TASK_MAX_TURNS,
  MAX_TASK_MAX_TURNS,
  MIN_TASK_MAX_TURNS,
  type AgentAdapter,
} from "@bridge/protocol";
import { ClaudeAdapter } from "../adapters/claude-adapter.js";
import {
  CLAUDE_REQUESTED_EFFORT,
  CLAUDE_REQUESTED_MODEL,
  ClaudeCodeRunner,
} from "../adapters/claude-code-runner.js";

export interface ClaudeLauncherArgs {
  readonly workspace: string;
  readonly db?: string;
  readonly agent: string;
  readonly help: boolean;
  /** Register the real Claude Code adapter so other agents can delegate to Claude. */
  readonly withAdapter: boolean;
  readonly claudeBin: string;
  readonly maxTurns: number;
  readonly permissionMode: string;
}

export const CLAUDE_LAUNCHER_HELP = `bridge-mcp — Claude <-> Codex coordination bridge (MCP stdio)

  --workspace, -w     repository root the agents operate on (default: cwd)
  --db                database path (default: <workspace>/.bridge/bridge.db)
  --agent, -a         identity asserted for calls that omit 'agent' (default: claude)
  --with-adapter      register the real Claude Code adapter so other agents can
                      delegate work to Claude (default: off)
  --claude-bin        Claude Code executable to drive (default: claude)
  --max-turns         conservative default turn ceiling; tasks may request a bounded value
                      (${MIN_TASK_MAX_TURNS}-${MAX_TASK_MAX_TURNS}, default: ${DEFAULT_TASK_MAX_TURNS})
  --permission-mode   plan | acceptEdits | dontAsk | default (default: plan, read-only)
  Claude profile      bridge-owned: --model ${CLAUDE_REQUESTED_MODEL} --effort ${CLAUDE_REQUESTED_EFFORT}
  --help, -h          show this message
`;

export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): ClaudeLauncherArgs {
  let workspace = resolve(cwd);
  let db: string | undefined;
  let agent = "claude";
  let help = false;
  let withAdapter = false;
  let claudeBin = "claude";
  let maxTurns = DEFAULT_TASK_MAX_TURNS;
  let permissionMode = "plan";

  const requireValue = (value: string | undefined, flag: string): string => {
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--workspace":
      case "-w":
        workspace = resolve(requireValue(value, flag));
        i++;
        break;
      case "--db":
        db = resolve(requireValue(value, flag));
        i++;
        break;
      case "--agent":
      case "-a":
        agent = requireValue(value, flag);
        i++;
        break;
      case "--with-adapter":
        withAdapter = true;
        break;
      case "--claude-bin":
        claudeBin = requireValue(value, flag);
        i++;
        break;
      case "--max-turns": {
        const raw = requireValue(value, flag);
        maxTurns = Number(raw);
        if (
          !Number.isInteger(maxTurns) ||
          maxTurns < MIN_TASK_MAX_TURNS ||
          maxTurns > MAX_TASK_MAX_TURNS
        ) {
          throw new Error(
            `--max-turns must be an integer from ${MIN_TASK_MAX_TURNS} through ${MAX_TASK_MAX_TURNS}`,
          );
        }
        i++;
        break;
      }
      case "--permission-mode": {
        permissionMode = requireValue(value, flag);
        // bypassPermissions would let a delegated task write anywhere, defeating the
        // lease system the bridge is built on. Refuse it here rather than at runtime.
        if (permissionMode === "bypassPermissions") {
          throw new Error(
            "--permission-mode bypassPermissions is refused: it disables the write-scope " +
              "guarantees the bridge depends on. Use plan, acceptEdits, or dontAsk.",
          );
        }
        i++;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        // Failing loudly beats silently serving with a default the operator did not intend.
        throw new Error(`unknown option: ${flag ?? "<empty>"}`);
    }
  }

  return {
    workspace,
    ...(db ? { db } : {}),
    agent,
    help,
    withAdapter,
    claudeBin,
    maxTurns,
    permissionMode,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    // stderr, not stdout: this binary's stdout belongs to the MCP transport.
    process.stderr.write(CLAUDE_LAUNCHER_HELP);
    return;
  }

  // The real Claude execution path. Off by default: registering an adapter advertises to
  // the other agent that delegations to `claude` will be executed, and that promise should
  // be made explicitly by whoever starts the process.
  const adapters: AgentAdapter[] = [];
  if (args.withAdapter) {
    const runner = new ClaudeCodeRunner({
      command: args.claudeBin,
      maxTurns: args.maxTurns,
      permissionMode: args.permissionMode,
      log: (line) => stderrLog(line),
    });
    const health = await runner.probe();
    stderrLog(
      `[bridge-claude] claude runtime: ${health.ok ? "ready" : "UNAVAILABLE"}` +
        `${health.detail ? ` (${health.detail})` : ""}`,
    );
    adapters.push(new ClaudeAdapter({ runner, agent: args.agent }));
  }

  const server = new BridgeMcpServer({
    workspaceRoot: args.workspace,
    ...(args.db ? { databasePath: args.db } : {}),
    agent: args.agent,
    adapters,
    onWarning: (message) => stderrLog(`[bridge-claude] warning: ${message}`),
  });

  await serve({ server, label: "bridge-claude", adapters });
  stderrLog(
    `[bridge-claude] workspace=${args.workspace}; agent=${args.agent}; ` +
      `adapter=${args.withAdapter ? `claude-code(${args.claudeBin}, model=${CLAUDE_REQUESTED_MODEL}, effort=${CLAUDE_REQUESTED_EFFORT}, max-turns=${args.maxTurns}, ${args.permissionMode})` : "none"}`,
  );
}

/**
 * Only run when this file IS the process entry point.
 *
 * `@bridge/claude-side` re-exports `parseArgs` from here, so without this guard merely
 * importing the library booted an MCP server and opened a database — observed live, where
 * a verification script printed "[bridge-claude] serving 22 tools" before doing anything.
 */
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[bridge-claude] fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
