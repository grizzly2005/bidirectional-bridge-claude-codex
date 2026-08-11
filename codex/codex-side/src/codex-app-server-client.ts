import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  AttemptTerminationKind,
  BridgeError,
  ErrorCode,
  TelemetryCostSemantics,
  type AttemptTelemetryUpdate,
} from "@bridge/protocol";

import {
  resolveBundledCodexCliLauncher,
  type CodexMcpClient,
  type CodexMcpProbe,
  type CodexMcpResponse,
  type CodexReplyRequest,
  type CodexStartRequest,
} from "./codex-mcp-client.js";

export interface CodexAppServerProcessClientOptions {
  /** Override only for deterministic tests or a deliberately pinned runtime. */
  readonly command?: string;
  /** Argv prefix; defaults to the bundled Codex launcher followed by `app-server`. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly connect_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  readonly now?: () => number;
}

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface TokenUsageBreakdown {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

interface ThreadTokenUsage {
  readonly last: TokenUsageBreakdown;
  readonly total: TokenUsageBreakdown;
}

interface CompletedTurn {
  readonly id: string;
  readonly status: string;
  readonly items: readonly unknown[];
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly durationMs?: number | null;
  readonly error?: { readonly message?: unknown } | null;
}

interface TurnWaiter {
  readonly threadId: string;
  readonly resolve: (value: { turn: CompletedTurn; usage: ThreadTokenUsage; firstOutputAt: number | null }) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface InitializedRuntime {
  readonly userAgent: string;
  readonly version: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex App Server returned a non-object payload");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `Codex App Server response omitted ${key}`);
  }
  return value;
}

function finiteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `Codex App Server emitted invalid ${label}`);
  }
  return value as number;
}

function parseBreakdown(value: unknown, label: string): TokenUsageBreakdown {
  const record = asRecord(value);
  return {
    totalTokens: finiteInteger(record["totalTokens"], `${label}.totalTokens`),
    inputTokens: finiteInteger(record["inputTokens"], `${label}.inputTokens`),
    cachedInputTokens: finiteInteger(record["cachedInputTokens"], `${label}.cachedInputTokens`),
    cacheWriteInputTokens:
      record["cacheWriteInputTokens"] === undefined
        ? 0
        : finiteInteger(record["cacheWriteInputTokens"], `${label}.cacheWriteInputTokens`),
    outputTokens: finiteInteger(record["outputTokens"], `${label}.outputTokens`),
    reasoningOutputTokens: finiteInteger(
      record["reasoningOutputTokens"],
      `${label}.reasoningOutputTokens`,
    ),
  };
}

function parseUsage(value: unknown): ThreadTokenUsage {
  const record = asRecord(value);
  return {
    last: parseBreakdown(record["last"], "tokenUsage.last"),
    total: parseBreakdown(record["total"], "tokenUsage.total"),
  };
}

function addBreakdowns(
  left: TokenUsageBreakdown,
  right: TokenUsageBreakdown,
): TokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens:
      (left.cacheWriteInputTokens ?? 0) + (right.cacheWriteInputTokens ?? 0),
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function extractAgentMessage(turn: CompletedTurn): string {
  const messages = turn.items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    return record["type"] === "agentMessage" && typeof record["text"] === "string"
      ? [record["text"] as string]
      : [];
  });
  const content = messages.at(-1)?.trim();
  if (!content) {
    throw new BridgeError(
      ErrorCode.ADAPTER_FAILURE,
      "Codex App Server completed the turn without a final agent message",
    );
  }
  return content;
}

function runtimeVersion(userAgent: string): string | null {
  // App Server prefixes this with the client name under its minimal inherited environment
  // (for example `bridge-codex-telemetry/0.147.0`), while Desktop inheritance yields
  // `Codex Desktop/0.147.0`. In both cases the first product/version pair is authoritative.
  return /^[^/]+\/([0-9]+(?:\.[0-9]+)+)\b/u.exec(userAgent)?.[1] ?? null;
}

/**
 * Official Codex App Server transport used only when authoritative token telemetry is
 * required. The certified `codex mcp-server` client remains available and unchanged as the
 * default execution path.
 */
export class CodexAppServerProcessClient implements CodexMcpClient {
  private readonly options: Required<
    Pick<CodexAppServerProcessClientOptions, "connect_timeout_ms" | "request_timeout_ms" | "now">
  > &
    CodexAppServerProcessClientOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private connecting: Promise<InitializedRuntime> | undefined;
  private initialized: InitializedRuntime | undefined;
  private closed = false;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrSeen = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly loadedThreads = new Set<string>();
  private readonly modelByThread = new Map<string, string>();
  private readonly usageByTurn = new Map<string, { threadId: string; usage: ThreadTokenUsage }>();
  private readonly completedByTurn = new Map<string, { threadId: string; turn: CompletedTurn }>();
  private readonly firstOutputByTurn = new Map<string, { threadId: string; at: number }>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();

  constructor(options: CodexAppServerProcessClientOptions = {}) {
    for (const [name, value] of [
      ["connect_timeout_ms", options.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS],
      ["request_timeout_ms", options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `${name} must be a positive integer`);
      }
    }
    this.options = {
      ...options,
      connect_timeout_ms: options.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS,
      request_timeout_ms: options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
      now: options.now ?? Date.now,
    };
  }

  async probe(): Promise<CodexMcpProbe> {
    if (this.closed) {
      return { state: "UNAVAILABLE", detail: "Codex App Server client is closed", tools: [] };
    }
    try {
      const initialized = await this.ensureConnected();
      return {
        state: "READY",
        detail: `Codex App Server ${initialized.version ?? "unknown version"} exposes correlated token usage`,
        tools: ["thread/start", "thread/resume", "turn/start", "thread/tokenUsage/updated"],
      };
    } catch (error) {
      return {
        state: "UNAVAILABLE",
        detail: error instanceof Error ? error.message : String(error),
        tools: [],
      };
    }
  }

  async start(request: CodexStartRequest): Promise<CodexMcpResponse> {
    const initialized = await this.ensureConnected();
    const response = asRecord(
      await this.request(
        "thread/start",
        {
          cwd: request.cwd,
          approvalPolicy: request.approval_policy,
          sandbox: request.sandbox,
          ephemeral: false,
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.developer_instructions !== undefined
            ? { developerInstructions: request.developer_instructions }
            : {}),
          ...(request.base_instructions !== undefined
            ? { baseInstructions: request.base_instructions }
            : {}),
          ...(request.config !== undefined ? { config: request.config } : {}),
        },
        request.timeout_ms,
        request.signal,
      ),
    );
    const thread = asRecord(response["thread"]);
    const threadId = requiredString(thread, "id");
    const model = requiredString(response, "model");
    this.loadedThreads.add(threadId);
    this.modelByThread.set(threadId, model);
    // App Server exposes the handle before a turn begins. Persist it now, so a crash during
    // generation remains resumable rather than waiting for the result path.
    await request.on_execution_handle?.(threadId);
    return this.runTurn(
      threadId,
      request.prompt,
      model,
      initialized,
      request.timeout_ms,
      request.signal,
    );
  }

  async reply(request: CodexReplyRequest): Promise<CodexMcpResponse> {
    const initialized = await this.ensureConnected();
    let model = this.modelByThread.get(request.thread_id);
    if (!this.loadedThreads.has(request.thread_id)) {
      const response = asRecord(
        await this.request(
          "thread/resume",
          { threadId: request.thread_id },
          request.timeout_ms,
          request.signal,
        ),
      );
      const thread = asRecord(response["thread"]);
      const resumedId = requiredString(thread, "id");
      if (resumedId !== request.thread_id) {
        throw new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          "Codex App Server resumed a different thread than requested",
        );
      }
      model = requiredString(response, "model");
      this.loadedThreads.add(resumedId);
      this.modelByThread.set(resumedId, model);
    }
    await request.on_execution_handle?.(request.thread_id);
    return this.runTurn(
      request.thread_id,
      request.prompt,
      model ?? null,
      initialized,
      request.timeout_ms,
      request.signal,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.initialized = undefined;
    this.rejectAll(new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex App Server client closed"));
    if (child === undefined || child.exitCode !== null) return;

    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill();
      await exited;
    }
  }

  private async runTurn(
    threadId: string,
    prompt: string,
    model: string | null,
    initialized: InitializedRuntime,
    requestedTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<CodexMcpResponse> {
    const response = asRecord(
      await this.request(
        "turn/start",
        { threadId, input: [{ type: "text", text: prompt }] },
        requestedTimeoutMs,
        signal,
      ),
    );
    const turn = asRecord(response["turn"]);
    const turnId = requiredString(turn, "id");
    const observed = await this.waitForTurn(threadId, turnId, requestedTimeoutMs, signal);
    if (observed.turn.status !== "completed") {
      const detail =
        typeof observed.turn.error?.message === "string"
          ? `: ${observed.turn.error.message.slice(0, 300)}`
          : "";
      throw new BridgeError(
        observed.turn.status === "interrupted" ? ErrorCode.TIMEOUT : ErrorCode.ADAPTER_FAILURE,
        `Codex App Server turn ${observed.turn.status}${detail}`,
      );
    }

    const last = observed.usage.last;
    const telemetry: AttemptTelemetryUpdate = {
      runtime: "codex-app-server",
      runtime_version: initialized.version,
      model,
      runtime_started_at:
        typeof observed.turn.startedAt === "number" ? observed.turn.startedAt * 1_000 : null,
      first_output_at: observed.firstOutputAt,
      runtime_ended_at:
        typeof observed.turn.completedAt === "number" ? observed.turn.completedAt * 1_000 : null,
      runtime_duration_ms:
        typeof observed.turn.durationMs === "number" ? observed.turn.durationMs : null,
      input_tokens: last.inputTokens,
      output_tokens: last.outputTokens,
      cached_input_tokens: last.cachedInputTokens,
      cache_creation_input_tokens: last.cacheWriteInputTokens ?? 0,
      total_tokens: last.totalTokens,
      turn_count: 1,
      cumulative_session_tokens: observed.usage.total.totalTokens,
      reported_cost_usd: null,
      cost_semantics: TelemetryCostSemantics.UNAVAILABLE,
      billing_mode_known: false,
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      termination_kind: AttemptTerminationKind.COMPLETED,
      process_exit_code: null,
    };
    return {
      thread_id: threadId,
      content: extractAgentMessage(observed.turn),
      telemetry,
    };
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    requestedTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ turn: CompletedTurn; usage: ThreadTokenUsage; firstOutputAt: number | null }> {
    if (signal.aborted) {
      return Promise.reject(new BridgeError(ErrorCode.TIMEOUT, "Codex App Server turn was aborted"));
    }
    const timeout = Math.max(1, Math.min(requestedTimeoutMs, this.options.request_timeout_ms));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.removeTurnWaiter(turnId);
        reject(new BridgeError(ErrorCode.TIMEOUT, "Codex App Server turn was aborted"));
      };
      const timer = setTimeout(() => {
        this.removeTurnWaiter(turnId);
        reject(new BridgeError(ErrorCode.TIMEOUT, "Codex App Server token-usage wait timed out"));
      }, timeout);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      this.turnWaiters.set(turnId, { threadId, resolve, reject, timer, signal, onAbort });
      this.maybeFinishTurn(turnId);
    });
  }

  private maybeFinishTurn(turnId: string): void {
    const waiter = this.turnWaiters.get(turnId);
    const completed = this.completedByTurn.get(turnId);
    const usage = this.usageByTurn.get(turnId);
    if (
      waiter === undefined ||
      completed === undefined ||
      usage === undefined ||
      completed.threadId !== waiter.threadId ||
      usage.threadId !== waiter.threadId
    ) {
      return;
    }
    const first = this.firstOutputByTurn.get(turnId);
    this.removeTurnWaiter(turnId);
    waiter.resolve({
      turn: completed.turn,
      usage: usage.usage,
      firstOutputAt: first?.threadId === waiter.threadId ? first.at : null,
    });
  }

  private removeTurnWaiter(turnId: string): void {
    const waiter = this.turnWaiters.get(turnId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.turnWaiters.delete(turnId);
    }
    this.completedByTurn.delete(turnId);
    this.usageByTurn.delete(turnId);
    this.firstOutputByTurn.delete(turnId);
  }

  private async ensureConnected(): Promise<InitializedRuntime> {
    if (this.closed) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex App Server client is closed");
    }
    if (this.initialized !== undefined) return this.initialized;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.openConnection();
    try {
      this.initialized = await this.connecting;
      return this.initialized;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<InitializedRuntime> {
    const bundled = resolveBundledCodexCliLauncher();
    const command = this.options.command ?? bundled.command;
    const args = [...(this.options.args ?? [...bundled.args, "app-server"])];
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...getDefaultEnvironment(), ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: unknown) => this.onStdout(String(chunk)));
    child.stderr.on("data", () => {
      this.stderrSeen = true;
    });
    child.once("error", (error) => this.rejectAll(error));
    child.once("close", (code) => {
      if (this.child === child) {
        this.child = undefined;
        this.initialized = undefined;
        this.loadedThreads.clear();
      }
      if (!this.closed) {
        this.rejectAll(
          new BridgeError(
            ErrorCode.ADAPTER_FAILURE,
            `Codex App Server exited with code ${code ?? "unknown"}` +
              (this.stderrSeen ? " (stderr was present and redacted)" : ""),
          ),
        );
      }
    });

    const response = asRecord(
      await this.request(
        "initialize",
        {
          clientInfo: { name: "bridge-codex-telemetry", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
        this.options.connect_timeout_ms,
      ),
    );
    const userAgent = requiredString(response, "userAgent");
    this.notify("initialized", {});
    return { userAgent, version: runtimeVersion(userAgent) };
  }

  private request(
    method: string,
    params: unknown,
    requestedTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      return Promise.reject(new BridgeError(ErrorCode.TIMEOUT, `${method} was aborted before start`));
    }
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      return Promise.reject(new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex App Server is not running"));
    }
    const id = this.nextId++;
    const timeout = Math.max(1, Math.min(requestedTimeoutMs, this.options.request_timeout_ms));
    return new Promise((resolve, reject) => {
      const onAbort = signal
        ? () => {
            this.settlePending(id);
            reject(new BridgeError(ErrorCode.TIMEOUT, `${method} was aborted`));
          }
        : undefined;
      const timer = setTimeout(() => {
        this.settlePending(id);
        reject(new BridgeError(ErrorCode.TIMEOUT, `${method} timed out`));
      }, timeout);
      timer.unref();
      signal?.addEventListener("abort", onAbort!, { once: true });
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, "Codex App Server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(message);
      if (typeof record["id"] === "number") {
        this.onResponse(record as unknown as JsonRpcResponse);
      } else if (typeof record["method"] === "string") {
        this.onNotification(record["method"], record["params"]);
      }
    }
  }

  private onResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.settlePending(response.id);
    if (response.error !== undefined) {
      pending.reject(
        new BridgeError(
          ErrorCode.ADAPTER_FAILURE,
          `Codex App Server RPC failed (${String(response.error.code ?? "unknown")}): ` +
            String(response.error.message ?? "unknown error").slice(0, 500),
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const record = params as Record<string, unknown>;
    const threadId = typeof record["threadId"] === "string" ? record["threadId"] : null;
    const turnId = typeof record["turnId"] === "string" ? record["turnId"] : null;
    if (method === "item/agentMessage/delta" && threadId && turnId) {
      if (!this.firstOutputByTurn.has(turnId)) {
        this.firstOutputByTurn.set(turnId, { threadId, at: this.options.now() });
      }
      return;
    }
    if (method === "thread/tokenUsage/updated" && threadId && turnId) {
      const incoming = parseUsage(record["tokenUsage"]);
      const previous = this.usageByTurn.get(turnId);
      // `last` is one model call, while a single Codex turn may make several calls around
      // tool use. Sum each strictly newer cumulative update so attempt usage covers the
      // whole turn; equal-total duplicate notifications are replay-safe no-ops.
      const usage =
        previous !== undefined &&
        previous.threadId === threadId &&
        incoming.total.totalTokens > previous.usage.total.totalTokens
          ? { last: addBreakdowns(previous.usage.last, incoming.last), total: incoming.total }
          : previous !== undefined &&
              previous.threadId === threadId &&
              incoming.total.totalTokens === previous.usage.total.totalTokens
            ? { last: previous.usage.last, total: incoming.total }
            : incoming;
      this.usageByTurn.set(turnId, { threadId, usage });
      this.maybeFinishTurn(turnId);
      return;
    }
    if (method === "turn/completed" && threadId) {
      const turn = asRecord(record["turn"]);
      const completedTurn: CompletedTurn = {
        id: requiredString(turn, "id"),
        status: requiredString(turn, "status"),
        items: Array.isArray(turn["items"]) ? turn["items"] : [],
        startedAt: typeof turn["startedAt"] === "number" ? turn["startedAt"] : null,
        completedAt: typeof turn["completedAt"] === "number" ? turn["completedAt"] : null,
        durationMs: typeof turn["durationMs"] === "number" ? turn["durationMs"] : null,
        error:
          typeof turn["error"] === "object" && turn["error"] !== null
            ? (turn["error"] as { message?: unknown })
            : null,
      };
      this.completedByTurn.set(completedTurn.id, { threadId, turn: completedTurn });
      this.maybeFinishTurn(completedTurn.id);
    }
  }

  private settlePending(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(id);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.settlePending(id);
      pending.reject(error);
    }
    for (const [turnId, waiter] of this.turnWaiters) {
      this.removeTurnWaiter(turnId);
      waiter.reject(error);
    }
  }
}
