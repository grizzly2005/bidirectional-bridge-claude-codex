#!/usr/bin/env node

import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
export const nativeBridgeRepositoryRoot = resolve(dirname(launcherPath), "..");

const CALLERS = new Set(["codex", "claude"]);
const DELEGATION_POLICIES = new Set(["allow", "deny"]);

export const NATIVE_BRIDGE_HELP = `native-bridge-mcp — project-scoped neutral bridge MCP server

  --caller          codex | claude (required; bound for the process lifetime)
  --delegation      allow | deny (required; enforced server-side)
  --workspace       project root (default: repository containing this launcher)
  --db              shared SQLite path (default: <workspace>/.bridge/bridge.db)
  --help            write this help to stderr and exit
`;

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseNativeBridgeArgs(argv, cwd = process.cwd()) {
  let caller;
  let delegation;
  let workspaceRaw;
  let databaseRaw;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--caller":
        caller = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--delegation":
        delegation = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--workspace":
        workspaceRaw = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--db":
        databaseRaw = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag ?? "<empty>"}`);
    }
  }

  if (!help && !CALLERS.has(caller)) {
    throw new Error("--caller must be codex or claude");
  }
  if (!help && !DELEGATION_POLICIES.has(delegation)) {
    throw new Error("--delegation must be allow or deny");
  }

  const workspace = resolve(cwd, workspaceRaw ?? nativeBridgeRepositoryRoot);
  const databasePath = databaseRaw
    ? isAbsolute(databaseRaw)
      ? resolve(databaseRaw)
      : resolve(workspace, databaseRaw)
    : resolve(workspace, ".bridge", "bridge.db");

  return {
    caller,
    delegation,
    workspace,
    databasePath,
    help,
  };
}

function redactedClaudeLog(line) {
  return line.replace(/session\s+\S+/iu, "session [redacted]");
}

export async function runNativeBridge(args) {
  if (args.help) {
    process.stderr.write(NATIVE_BRIDGE_HELP);
    return null;
  }
  if (!CALLERS.has(args.caller) || !DELEGATION_POLICIES.has(args.delegation)) {
    throw new Error("native bridge requires validated startup identity and delegation policy");
  }
  if (!statSync(args.workspace).isDirectory()) {
    throw new Error(`workspace is not a directory: ${args.workspace}`);
  }

  const [core, claudeSide, codexSide] = await Promise.all([
    import(new URL("../shared/mcp-server-core/dist/index.js", import.meta.url).href),
    import(new URL("../claude/claude-side/dist/index.js", import.meta.url).href),
    import(new URL("../codex/codex-side/dist/index.js", import.meta.url).href),
  ]);

  const log = (line) => core.stderrLog(`[bridge-native:${args.caller}] ${line}`);
  const claudeRunner = new claudeSide.ClaudeCodeRunner({
    permissionMode: "acceptEdits",
    // ClaudeCodeRunner owns the protected opus/high profile and conservative bounded
    // default. A validated TaskSpec.max_turns may raise or lower only the turn ceiling.
    // Delegated Claude runs are non-interactive, so permission prompts cannot be answered.
    // Use Claude Code's documented allowlist instead of bypassPermissions. Read/Edit/Write
    // remain project-confined by Claude Code; the task contract and lease bound the scope.
    allowedTools: ["Read", "Edit", "Write", "Bash"],
    log: (line) => log(redactedClaudeLog(line)),
  });
  const claudeAdapter = new claudeSide.ClaudeAdapter({
    runner: claudeRunner,
    agent: "claude",
  });

  // App Server is the already-proven Codex path that exposes per-thread token events.
  // The certified official-codex-cli-mcp adapter remains available in codex-side; native
  // bridge composition selects App Server only so delegated attempts keep benchmark-grade
  // telemetry rather than introducing a second telemetry subsystem.
  const codexClient = new codexSide.CodexAppServerProcessClient({ cwd: args.workspace });
  const codexAdapter = new codexSide.CodexAdapter({
    client: codexClient,
    implementation: "official-codex-app-server",
    approval_policy: "never",
    sandbox: "workspace-write",
  });

  const adapters = [claudeAdapter, codexAdapter];
  const server = new core.BridgeMcpServer({
    workspaceRoot: args.workspace,
    databasePath: args.databasePath,
    agent: args.caller,
    delegationPolicy: args.delegation,
    adapters,
    serverName: "bridge-native-project",
    onWarning: (message) => log(`warning: ${message}`),
  });

  log(`caller=${args.caller} delegation=${args.delegation} workspace=${args.workspace}`);
  return core.serve({
    server,
    label: `bridge-native-${args.caller}`,
    adapters,
    log,
  });
}

async function main() {
  const args = parseNativeBridgeArgs(process.argv.slice(2));
  await runNativeBridge(args);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(launcherPath)) {
  main().catch((error) => {
    process.stderr.write(`[bridge-native] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
