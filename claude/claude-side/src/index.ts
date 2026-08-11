/**
 * `@bridge/claude-side` — Claude-specific integration with the coordination bridge.
 *
 * Scope after the BRIDGE-CONVERGENCE-SHARED-001 split: adapter and session logic plus
 * Claude's launcher. The MCP server, tool surface, adapter registry, and shutdown sequence
 * now live in the agent-neutral `@bridge/mcp-server-core`, which Codex depends on directly.
 *
 * Two entry points, for the two ways Claude shows up:
 *  - `ClaudeWorkSession`: participate from inside an already-running Claude turn;
 *  - `ClaudeAdapter`: be driven as a delegate by the orchestrator.
 *
 * `MockCodexAdapter` is the reference implementation of the contract Codex satisfies; it is
 * test scaffolding for this package, not the real Codex integration.
 */

export { ClaudeWorkSession } from "./work-session.js";
export type { BeginWorkResult, ClaudeWorkSessionOptions } from "./work-session.js";

export { ClaudeAdapter, functionRunner, projectTelemetryUpdate } from "./adapters/claude-adapter.js";
export type { ClaudeAdapterOptions, ClaudeRunResult, ClaudeRunner } from "./adapters/claude-adapter.js";

/** The real Claude execution path: a bounded Claude Code CLI subprocess. */
export {
  ClaudeCodeRunner,
  CLAUDE_RUNTIME_NAME,
  buildPrompt,
  buildRunnerTelemetry,
  normalizeClaudeUsage,
  parseStructuredOutput,
  SAFE_PERMISSION_MODES,
  toTelemetryUpdate,
} from "./adapters/claude-code-runner.js";
export type {
  BuildRunnerTelemetryInput,
  ClaudeCodeRunnerOptions,
  ClaudeFrame,
  ClaudeInitFrame,
  ClaudePermissionMode,
  ClaudeResultFrame,
  ClaudeRunnerTelemetry,
  ClaudeStructuredOutput,
  ClaudeUsage,
  NormalizedClaudeUsage,
} from "./adapters/claude-code-runner.js";

export { MockCodexAdapter, failingCheck, passingCheck } from "./adapters/mock-codex-adapter.js";
export type { MockBehaviour, MockCodexAdapterOptions } from "./adapters/mock-codex-adapter.js";

export { parseArgs as parseClaudeLauncherArgs, CLAUDE_LAUNCHER_HELP } from "./server/main.js";
export type { ClaudeLauncherArgs } from "./server/main.js";

export { BridgeServerHarness, removeDirWithRetries } from "./server/harness.js";

/*
 * The deprecated `BridgeMcpServer` re-export from `@bridge/mcp-server-core` was removed in
 * BRIDGE-LIVE-CLAUDE-001, after codex confirmed migration in
 * `COORDINATION/REQUESTS/ack-req-002-codex.md` and a repository-wide search found no
 * remaining consumers. Import the server from `@bridge/mcp-server-core` directly.
 */
