#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
export const nativeBridgeRepositoryRoot = resolve(dirname(launcherPath), "..");
const bridgeVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const CALLERS = new Set(["codex", "claude", "gemini"]);
const GEMINI_DIALECTS = new Set(["antigravity", "gemini-cli"]);
const GEMINI_AUTH_MODES = new Set(["api-key", "enterprise"]);
const DELEGATION_POLICIES = new Set(["allow", "deny"]);

export const NATIVE_BRIDGE_HELP = `native-bridge-mcp — project-scoped neutral bridge MCP server

  --caller          codex | claude | gemini (required; bound for the process lifetime)
  --delegation      allow | deny (required; enforced server-side)
  --workspace       project root (default: current working directory)
  --db              shared SQLite path (default: <workspace>/.bridge/bridge.db)
  --codex-wsl-executable  absolute Linux Codex executable; explicitly use the WSL
                         distribution named by a Windows WSL UNC workspace
  --gemini-command  Gemini worker executable (default: $BRIDGE_GEMINI_COMMAND or agy)
  --gemini-dialect  antigravity | gemini-cli (default: antigravity)
  --gemini-auth     api-key | enterprise — enables the Gemini worker. Without it the
                         worker stays disabled: Google does not support driving a
                         consumer Antigravity login from Claude Code or Codex.
  --gemini-skip-permissions  opt in to auto-approving every Gemini worker tool
                         (--dangerously-skip-permissions); off by default
  --help            write this help to stderr and exit

  Models: each worker uses its runtime's default model unless a manager stores a
  preference (bridge_set_model_preference) or a task sets spec.model / spec.effort.
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
  let codexWslExecutable;
  let geminiCommand;
  let geminiDialect;
  let geminiSkipPermissions = false;
  let geminiAuth;
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
      case "--codex-wsl-executable":
        codexWslExecutable = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--gemini-command":
        geminiCommand = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--gemini-dialect":
        geminiDialect = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--gemini-auth":
        geminiAuth = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--gemini-skip-permissions":
        geminiSkipPermissions = true;
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
    throw new Error("--caller must be codex, claude or gemini");
  }
  if (geminiAuth !== undefined && !GEMINI_AUTH_MODES.has(geminiAuth)) {
    throw new Error("--gemini-auth must be api-key or enterprise");
  }
  if (geminiDialect !== undefined && !GEMINI_DIALECTS.has(geminiDialect)) {
    throw new Error("--gemini-dialect must be antigravity or gemini-cli");
  }
  if (!help && !DELEGATION_POLICIES.has(delegation)) {
    throw new Error("--delegation must be allow or deny");
  }

  const workspace = workspaceRaw ? resolve(cwd, workspaceRaw) : resolve(cwd);
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
    ...(codexWslExecutable !== undefined ? { codexWslExecutable } : {}),
    ...(geminiCommand !== undefined ? { geminiCommand } : {}),
    ...(geminiDialect !== undefined ? { geminiDialect } : {}),
    ...(geminiSkipPermissions ? { geminiSkipPermissions } : {}),
    ...(geminiAuth !== undefined ? { geminiAuth } : {}),
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
  if (process.env.BRIDGE_DELEGATED_WORKER === "1") {
    // A delegated worker inherits this marker from the bridge runner. Starting a nested
    // coordination server here would hand the worker a manager identity and let it mutate
    // or re-delegate tasks; refuse instead. The worker's contract is its only authority.
    throw new Error("refusing to start a bridge coordination server inside a delegated worker");
  }
  if (!statSync(args.workspace).isDirectory()) {
    throw new Error(`workspace is not a directory: ${args.workspace}`);
  }

  const diagnostics = await import(new URL("../shared/mcp-server-core/dist/diagnostics.js", import.meta.url).href);
  const startupIdentity = diagnostics.captureBridgeIdentity({ repositoryRoot: nativeBridgeRepositoryRoot,
    entrypointPath: launcherPath, serverName: "bridge-native-project", serverVersion: bridgeVersion });
  const [core, claudeSide, codexSide, geminiSide] = await Promise.all([
    import(new URL("../shared/mcp-server-core/dist/index.js", import.meta.url).href),
    import(new URL("../claude/claude-side/dist/index.js", import.meta.url).href),
    import(new URL("../codex/codex-side/dist/index.js", import.meta.url).href),
    import(new URL("../gemini/gemini-side/dist/index.js", import.meta.url).href),
  ]);
  // Shared by every native process of this workspace; re-read at each delegation.
  const modelPreferences = core.ModelPreferenceStore.forDatabase(args.databasePath);

  const log = (line) => core.stderrLog(`[bridge-native:${args.caller}] ${line}`);
  const codexExecution = codexSide.resolveCodexExecutionEnvironment({ cwd: args.workspace,
    ...(args.codexWslExecutable !== undefined ? { wsl_executable: args.codexWslExecutable } : {}),
  });
  const claudeRunner = new claudeSide.ClaudeCodeRunner({
    permissionMode: "acceptEdits",
    // Model/effort: task spec, then the stored manager preference, then Claude Code's own
    // default (no --model/--effort flag). A validated TaskSpec.max_turns may raise or lower
    // only the turn ceiling.
    defaultProfile: { model: null, effort: null },
    modelPreference: modelPreferences.reader("claude"),
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
  const codexClient = new codexSide.CodexAppServerProcessClient({ cwd: args.workspace,
    ...(args.codexWslExecutable !== undefined ? { wsl_executable: args.codexWslExecutable } : {}),
  });
  const codexAdapter = new codexSide.CodexAdapter({
    client: codexClient,
    implementation: "official-codex-app-server",
    approval_policy: "never",
    sandbox: "workspace-write",
    model_preference: modelPreferences.reader("codex"),
  });

  // Gemini worker: Antigravity CLI (`agy`) by default; legacy Gemini CLI on request.
  // Runtime default model unless a preference or task selects one; risky tools stay
  // soft-denied unless --gemini-skip-permissions was explicitly given at startup.
  const geminiRunner = new geminiSide.AntigravityRunner({
    ...(args.geminiCommand !== undefined ? { command: args.geminiCommand } : {}),
    ...(args.geminiDialect !== undefined ? { dialect: args.geminiDialect } : {}),
    ...(args.geminiSkipPermissions === true ? { skipPermissions: true } : {}),
    ...(args.geminiAuth !== undefined ? { authMode: args.geminiAuth } : {}),
    modelPreference: modelPreferences.reader("gemini"),
    log: (line) => log(`gemini: ${line}`),
  });
  const geminiAdapter = new geminiSide.GeminiAdapter({ runner: geminiRunner, agent: "gemini" });

  const adapters = [claudeAdapter, codexAdapter, geminiAdapter];
  const server = new core.BridgeMcpServer({
    workspaceRoot: args.workspace,
    databasePath: args.databasePath,
    agent: args.caller,
    delegationPolicy: args.delegation,
    adapters,
    serverName: "bridge-native-project",
    startupIdentity,
    extraTools: core.modelPreferenceTools(modelPreferences, () => adapters.map((adapter) => adapter.info.agent)),
    onWarning: (message) => log(`warning: ${message}`),
  });

  log(`caller=${args.caller} delegation=${args.delegation} workspace=${args.workspace}`);
  log(`codex_environment=${codexExecution.kind} codex_workspace=${codexExecution.runtime_workspace}`);
  log(`gemini_runtime=${geminiRunner.description} gemini_worker=${geminiRunner.authorizationProblem() === null ? "enabled" : "disabled"}`);
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

function canonicalPath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

const invokedPath = process.argv[1] ? canonicalPath(process.argv[1]) : "";
if (invokedPath === canonicalPath(launcherPath)) {
  main().catch((error) => {
    process.stderr.write(`[bridge-native] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
