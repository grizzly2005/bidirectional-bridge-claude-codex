import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BridgeError,
  ErrorCode,
  type AttemptTelemetryUpdate,
} from "@bridge/protocol";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexMcpResponse {
  readonly thread_id: string;
  readonly content: string;
  /** Present only when the selected official runtime transport exposes per-turn usage. */
  readonly telemetry?: AttemptTelemetryUpdate;
}

export interface CodexStartRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly approval_policy: CodexApprovalPolicy;
  readonly sandbox: CodexSandbox;
  readonly model?: string;
  readonly developer_instructions?: string;
  readonly base_instructions?: string;
  readonly compact_prompt?: string;
  readonly config?: Record<string, unknown>;
  readonly timeout_ms: number;
  readonly signal: AbortSignal;
  /** Called at the first instant the transport exposes the new thread id. */
  readonly on_execution_handle?: (thread_id: string) => Promise<void>;
}

export interface CodexReplyRequest {
  readonly thread_id: string;
  readonly prompt: string;
  readonly timeout_ms: number;
  readonly signal: AbortSignal;
  /** Called after a persisted thread is loaded, before its continuation turn starts. */
  readonly on_execution_handle?: (thread_id: string) => Promise<void>;
}

export type CodexMcpProbeState = "READY" | "DEGRADED" | "UNAVAILABLE";

export interface CodexMcpProbe {
  readonly state: CodexMcpProbeState;
  readonly detail: string;
  readonly tools: readonly string[];
}

export interface CodexMcpClient {
  probe(): Promise<CodexMcpProbe>;
  start(request: CodexStartRequest): Promise<CodexMcpResponse>;
  reply(request: CodexReplyRequest): Promise<CodexMcpResponse>;
  close(): Promise<void>;
}

export interface CodexMcpProcessClientOptions {
  /** Override only for tests or a deliberately pinned Codex launcher. */
  readonly server_command?: string;
  /** Full server argv. Defaults to the bundled `codex mcp-server`. */
  readonly server_args?: readonly string[];
  readonly server_cwd?: string;
  /** Explicit additions to the MCP SDK's conservative inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Override only for tests or a deliberately pinned persistent-resume launcher. */
  readonly resume_command?: string;
  /** Argv prefix before `exec resume`; defaults to the bundled Codex JS launcher. */
  readonly resume_args?: readonly string[];
  readonly connect_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  readonly stderr_tail_chars?: number;
}

interface ConnectedState {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly tools: ReadonlySet<string>;
}

const REQUIRED_TOOLS = ["codex", "codex-reply"] as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STDERR_TAIL_CHARS = 8_000;
const MAX_EXEC_STDOUT_CHARS = 1_000_000;

/**
 * Build the PATH passed to Codex shell commands without inheriting arbitrary secrets.
 *
 * Codex Desktop ships a sandbox-approved Node runtime next to PATH entries such as
 * `dependencies/bin/fallback`, but its `node/bin` directory is not itself on PATH. Prepending
 * that sibling lets delegated TypeScript tasks run while preserving the caller's remaining
 * tool lookup order. On installations without a bundled runtime this is a no-op.
 */
export function buildDefaultCodexToolPath(
  inheritedPath: string | undefined = process.env.PATH,
  pathExists: (candidate: string) => boolean = existsSync,
): string | undefined {
  if (inheritedPath === undefined || inheritedPath.trim().length === 0) return undefined;

  const segments = inheritedPath.split(delimiter).filter((segment) => segment.length > 0);
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const additions: string[] = [];
  for (const segment of segments) {
    const candidate = resolve(segment, "..", "..", "node", "bin", executable);
    if (pathExists(candidate)) additions.push(dirname(candidate));
  }

  const seen = new Set<string>();
  return [...additions, ...segments]
    .filter((segment) => {
      const key = process.platform === "win32" ? segment.toLowerCase() : segment;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(delimiter);
}

/**
 * Resolve the launcher shipped by the official npm package. This avoids depending on
 * the Windows Store app path, whose executable ACL may reject child-process launches.
 */
export function resolveBundledCodexCliLauncher(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@openai/codex/package.json");
  const launcher = resolve(dirname(packageJson), "bin", "codex.js");
  return { command: process.execPath, args: [launcher] };
}

export function resolveBundledCodexLauncher(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const launcher = resolveBundledCodexCliLauncher();
  return { command: launcher.command, args: [...launcher.args, "mcp-server"] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function isServerLocalSessionMiss(error: unknown): boolean {
  return (
    error instanceof BridgeError &&
    error.code === ErrorCode.ADAPTER_FAILURE &&
    /session not found for thread[_ ]?id|thread.*(?:not found|unknown|expired)/i.test(error.message)
  );
}

function parseExecResumeOutput(stdout: string, fallbackThreadId: string): CodexMcpResponse {
  let threadId = fallbackThreadId;
  let content: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (
      record.type === "thread.started" &&
      typeof record.thread_id === "string" &&
      record.thread_id.length > 0
    ) {
      threadId = record.thread_id;
    }
    if (record.type !== "item.completed" || typeof record.item !== "object" || record.item === null) {
      continue;
    }
    const item = record.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      content = item.text;
    }
  }
  if (content === undefined) {
    throw new BridgeError(
      ErrorCode.ADAPTER_FAILURE,
      "Codex persisted exec resume returned no completed agent message",
    );
  }
  return { thread_id: threadId, content };
}

/** Long-lived stdio client for the two tools exposed by `codex mcp-server`. */
export class CodexMcpProcessClient implements CodexMcpClient {
  private readonly options: Required<
    Pick<
      CodexMcpProcessClientOptions,
      "connect_timeout_ms" | "request_timeout_ms" | "stderr_tail_chars"
    >
  > &
    CodexMcpProcessClientOptions;

  private state: ConnectedState | undefined;
  private connecting: Promise<ConnectedState> | undefined;
  private stderrTail = "";
  private closed = false;
  private readonly resumeChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly resumeRuns = new Set<Promise<CodexMcpResponse>>();

  constructor(options: CodexMcpProcessClientOptions = {}) {
    for (const [name, value] of [
      ["connect_timeout_ms", options.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS],
      ["request_timeout_ms", options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS],
      ["stderr_tail_chars", options.stderr_tail_chars ?? DEFAULT_STDERR_TAIL_CHARS],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `${name} must be a positive integer`);
      }
    }
    this.options = {
      ...options,
      connect_timeout_ms: options.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS,
      request_timeout_ms: options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
      stderr_tail_chars: options.stderr_tail_chars ?? DEFAULT_STDERR_TAIL_CHARS,
    };
    if (this.options.resume_command !== undefined && this.options.resume_command.trim().length === 0) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "resume_command must be non-empty");
    }
  }

  async probe(): Promise<CodexMcpProbe> {
    if (this.closed) {
      return { state: "UNAVAILABLE", detail: "Codex MCP client is closed", tools: [] };
    }

    try {
      const state = await this.ensureConnected();
      const tools = [...state.tools].sort();
      const missing = REQUIRED_TOOLS.filter((name) => !state.tools.has(name));
      if (missing.length > 0) {
        return {
          state: "DEGRADED",
          detail: `Codex MCP server is missing required tools: ${missing.join(", ")}`,
          tools,
        };
      }
      return {
        state: "READY",
        detail: "Codex MCP server exposes codex and codex-reply",
        tools,
      };
    } catch (error) {
      return {
        state: "UNAVAILABLE",
        detail: this.describeFailure(error),
        tools: [],
      };
    }
  }

  async start(request: CodexStartRequest): Promise<CodexMcpResponse> {
    const args: Record<string, unknown> = {
      prompt: request.prompt,
      cwd: request.cwd,
      "approval-policy": request.approval_policy,
      sandbox: request.sandbox,
    };
    if (request.model !== undefined) args.model = request.model;
    if (request.developer_instructions !== undefined) {
      args["developer-instructions"] = request.developer_instructions;
    }
    if (request.base_instructions !== undefined) {
      args["base-instructions"] = request.base_instructions;
    }
    if (request.compact_prompt !== undefined) {
      args["compact-prompt"] = request.compact_prompt;
    }
    if (request.config !== undefined) args.config = request.config;

    const response = await this.call("codex", args, request.timeout_ms, request.signal);
    await request.on_execution_handle?.(response.thread_id);
    return response;
  }

  async reply(request: CodexReplyRequest): Promise<CodexMcpResponse> {
    let response: CodexMcpResponse;
    try {
      response = await this.call(
        "codex-reply",
        { prompt: request.prompt, threadId: request.thread_id },
        request.timeout_ms,
        request.signal,
      );
    } catch (error) {
      if (!isServerLocalSessionMiss(error)) throw error;
      // `codex-reply` keeps an in-memory session table in one MCP server process. The
      // official CLI persists the same UUID on disk, so after an adapter/server restart
      // continue it through `codex exec resume` instead of silently starting duplicate work.
      const run = this.resumePersisted(request);
      this.resumeRuns.add(run);
      try {
        response = await run;
      } finally {
        this.resumeRuns.delete(run);
      }
    }
    await request.on_execution_handle?.(response.thread_id);
    return response;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.resumeChildren) child.kill();
    const pending = this.connecting;
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }
    const state = this.state;
    this.state = undefined;
    if (state !== undefined) {
      await state.client.close().catch(() => undefined);
    }
    await Promise.allSettled([...this.resumeRuns]);
  }

  private async resumePersisted(request: CodexReplyRequest): Promise<CodexMcpResponse> {
    if (this.closed) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex MCP client is closed");
    }
    if (request.signal.aborted) {
      throw new BridgeError(ErrorCode.TIMEOUT, "Codex persisted resume was aborted before start");
    }
    if (!Number.isFinite(request.timeout_ms) || request.timeout_ms < 1) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Codex MCP timeout must be positive");
    }

    const bundled = resolveBundledCodexCliLauncher();
    const command = this.options.resume_command ?? bundled.command;
    const prefix = [...(this.options.resume_args ?? bundled.args)];
    const args = [
      ...prefix,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      request.thread_id,
      "-",
    ];
    const env = { ...getDefaultEnvironment(), ...this.options.env };
    const child = spawn(command, args, {
      cwd: this.options.server_cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.resumeChildren.add(child);
    child.stdin.on("error", () => undefined);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: unknown) => {
      stdout = (stdout + String(chunk)).slice(-MAX_EXEC_STDOUT_CHARS);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-this.options.stderr_tail_chars);
    });

    const timeout = Math.max(1, Math.min(request.timeout_ms, this.options.request_timeout_ms));
    let timedOut = false;
    const stop = (): void => {
      timedOut = true;
      child.kill();
    };
    request.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeout);
    timer.unref();

    try {
      child.stdin.end(request.prompt);
      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => resolveExit(code ?? 1));
      });
      this.appendStderr(stderr);
      if (timedOut || request.signal.aborted) {
        throw new BridgeError(ErrorCode.TIMEOUT, "Codex persisted exec resume timed out");
      }
      if (exitCode !== 0) {
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          `Codex persisted exec resume exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
      }
      return parseExecResumeOutput(stdout, request.thread_id);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        `Codex persisted exec resume failed: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", stop);
      this.resumeChildren.delete(child);
      if (!child.killed && child.exitCode === null) child.kill();
    }
  }

  private async call(
    tool: (typeof REQUIRED_TOOLS)[number],
    args: Record<string, unknown>,
    requestedTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<CodexMcpResponse> {
    if (signal.aborted) {
      throw new BridgeError(ErrorCode.TIMEOUT, `Codex MCP ${tool} call was aborted before start`);
    }
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs < 1) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Codex MCP timeout must be positive");
    }

    const state = await this.ensureConnected();
    if (!state.tools.has(tool)) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `Codex MCP tool is unavailable: ${tool}`, {
        tools: [...state.tools],
      });
    }

    const timeout = Math.max(
      1,
      Math.min(requestedTimeoutMs, this.options.request_timeout_ms),
    );

    try {
      const result = await state.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout, maxTotalTimeout: timeout },
      );
      return this.parseToolResult(tool, result);
    } catch (error) {
      const mapped = this.mapFailure(error, `tools/call ${tool}`, signal);
      if (mapped.code === ErrorCode.ADAPTER_FAILURE) {
        await this.invalidateConnection(state);
      }
      throw mapped;
    }
  }

  private parseToolResult(tool: string, result: unknown): CodexMcpResponse {
    if (typeof result !== "object" || result === null) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `${tool} returned a non-object result`);
    }
    const record = result as {
      isError?: unknown;
      structuredContent?: unknown;
      content?: unknown;
    };
    const legacyText = textFromContent(record.content);
    if (record.isError === true) {
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        `${tool} returned an MCP error${legacyText ? `: ${legacyText}` : ""}`,
      );
    }
    if (typeof record.structuredContent !== "object" || record.structuredContent === null) {
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        `${tool} response omitted structuredContent; a thread id is required for lifecycle tracking`,
        { legacy_content: legacyText.slice(0, 1_000) },
      );
    }
    const structured = record.structuredContent as Record<string, unknown>;
    if (typeof structured.threadId !== "string" || structured.threadId.trim().length === 0) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `${tool} response omitted threadId`);
    }
    if (typeof structured.content !== "string") {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `${tool} response omitted textual content`);
    }
    return { thread_id: structured.threadId, content: structured.content };
  }

  private async ensureConnected(): Promise<ConnectedState> {
    if (this.closed) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex MCP client is closed");
    }
    if (this.state !== undefined) return this.state;
    if (this.connecting !== undefined) return this.connecting;

    this.connecting = this.openConnection();
    try {
      const state = await this.connecting;
      if (this.closed) {
        await state.client.close().catch(() => undefined);
        throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex MCP client closed while connecting");
      }
      this.state = state;
      return state;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<ConnectedState> {
    const defaultLauncher = resolveBundledCodexLauncher();
    const command = this.options.server_command ?? defaultLauncher.command;
    const args = [...(this.options.server_args ?? defaultLauncher.args)];
    const env = { ...getDefaultEnvironment(), ...this.options.env };
    const transport = new StdioClientTransport({
      command,
      args,
      cwd: this.options.server_cwd,
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: unknown) => {
      this.appendStderr(String(chunk));
    });
    const client = new Client(
      { name: "bridge-codex-side", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: this.options.connect_timeout_ms });
      const listed = await client.listTools(undefined, {
        timeout: this.options.connect_timeout_ms,
      });
      const tools = new Set(listed.tools.map((tool) => tool.name));
      return { client, transport, tools };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw this.mapFailure(error, "connect", undefined);
    }
  }

  private async invalidateConnection(expected: ConnectedState): Promise<void> {
    if (this.state !== expected) return;
    this.state = undefined;
    await expected.client.close().catch(() => undefined);
  }

  private mapFailure(
    error: unknown,
    operation: string,
    signal: AbortSignal | undefined,
  ): BridgeError {
    if (error instanceof BridgeError) return error;
    const message = errorMessage(error);
    const timeout =
      signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError") ||
      /timed?\s*out|timeout|requesttimeout/i.test(message);
    return new BridgeError(
      timeout ? ErrorCode.TIMEOUT : ErrorCode.ADAPTER_FAILURE,
      `Codex MCP ${operation} failed: ${message}`,
      this.stderrTail ? { stderr_tail: this.stderrTail } : {},
    );
  }

  private describeFailure(error: unknown): string {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError(ErrorCode.ADAPTER_FAILURE, errorMessage(error));
    const stderr = this.stderrTail ? `; stderr: ${this.stderrTail}` : "";
    return `${bridgeError.code}: ${bridgeError.message}${stderr}`;
  }

  private appendStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-this.options.stderr_tail_chars);
  }
}
