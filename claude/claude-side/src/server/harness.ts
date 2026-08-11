/**
 * Test harness for driving the bridge server as a real child process over stdio.
 *
 * Exported (not inlined in the test) because the shutdown ordering it implements is the
 * fix for a real Windows defect, and Codex needs the same sequence for its own launcher.
 *
 * ## Why a hand-rolled client rather than the SDK's `StdioClientTransport`
 *
 * The SDK's stdio client transport spawns and owns the child process and does not expose
 * it. That makes it impossible to *await the child's exit* before deleting the workspace —
 * which is precisely the bug being fixed: Windows refuses to unlink `bridge.db` while the
 * child still holds the SQLite handle, so the test must own the process lifecycle.
 *
 * ## Shutdown order (each step exists because skipping it produced a real failure)
 *
 *   1. close the MCP client      — reject in-flight requests deterministically instead of
 *                                  letting them time out against a dying process
 *   2. close the transport/stdin — EOF on stdin is the graceful "no more requests" signal;
 *                                  a well-behaved MCP server exits on it without a signal
 *   3. await child exit, bounded — the child closes SQLite during its own shutdown; this
 *                                  is the step whose absence caused EBUSY on Windows
 *   4. terminate if still alive  — SIGTERM then SIGKILL, so a wedged child cannot hang CI
 *   5. close SQLite handles      — any handle the *test* opened, after the child released its
 *   6. remove the temp dir       — with bounded retries, because Windows can hold a file
 *                                  briefly after the owning process exits
 *
 * There is no unconditional sleep anywhere: every wait is on an observable event with a
 * bounded fallback.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface HarnessOptions {
  readonly entry: string;
  readonly workspace: string;
  readonly agent?: string;
  readonly requestTimeoutMs?: number;
  /** How long to wait for the child to exit on its own before signalling. Default 5s. */
  readonly exitTimeoutMs?: number;
}

export class ServerClosedError extends Error {
  constructor(message = "MCP client is closed") {
    super(message);
    this.name = "ServerClosedError";
  }
}

export class BridgeServerHarness {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  private readonly requestTimeoutMs: number;
  private readonly exitTimeoutMs: number;
  private stdoutBuffer = "";
  private nextId = 1;
  private clientClosed = false;

  /** Every raw line the server wrote to stdout, for protocol-purity assertions. */
  readonly stdoutLines: string[] = [];
  /** Everything the server wrote to stderr, where all diagnostics belong. */
  readonly stderrChunks: string[] = [];
  /** Resolves with the child's exit code once it terminates. */
  readonly exited: Promise<number | null>;

  constructor(options: HarnessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.exitTimeoutMs = options.exitTimeoutMs ?? 5_000;

    const args = [options.entry, "--workspace", options.workspace];
    if (options.agent) args.push("--agent", options.agent);

    this.child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.exited = new Promise<number | null>((resolve) => {
      this.child.once("exit", (code) => resolve(code));
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderrChunks.push(chunk));

    // A child that dies mid-request must fail the request, not hang until the timeout.
    this.child.once("exit", (code) => {
      const err = new ServerClosedError(`server exited with code ${code ?? "null"}`);
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this.stdoutLines.push(line);

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Kept in `stdoutLines` so the purity test can report exactly what was written.
        continue;
      }
      if (msg.id === undefined) continue;
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  }

  notify(method: string, params: unknown = {}): void {
    if (this.clientClosed) throw new ServerClosedError();
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    if (this.clientClosed) return Promise.reject(new ServerClosedError());
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, this.requestTimeoutMs);
      const settle = {
        resolve: (m: JsonRpcMessage) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.pending.set(id, settle);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** MCP handshake. Returns the server's `initialize` result. */
  async initialize(): Promise<JsonRpcMessage> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bridge-harness", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
    const res = await this.request("tools/call", { name, arguments: args });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError ?? false, data: JSON.parse(result.content[0]!.text) };
  }

  /** Step 1: stop issuing requests and fail anything in flight. */
  closeClient(): void {
    if (this.clientClosed) return;
    this.clientClosed = true;
    const err = new ServerClosedError();
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  /** Step 2: EOF on stdin — the graceful "no more requests" signal for a stdio server. */
  closeTransport(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  /** Step 3: wait for a real exit event, bounded. Returns false if still running. */
  async awaitExit(timeoutMs = this.exitTimeoutMs): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true;
    const timedOut = Symbol("timeout");
    const winner = await Promise.race([
      this.exited.then(() => "exited" as const),
      delay(timeoutMs, timedOut),
    ]);
    return winner !== timedOut;
  }

  /** Step 4: escalate SIGTERM -> SIGKILL. Only reached if the graceful path failed. */
  async terminate(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    if (await this.awaitExit(this.exitTimeoutMs)) return;
    this.child.kill("SIGKILL");
    await this.awaitExit(this.exitTimeoutMs);
  }

  /** Steps 1-4 in order. Idempotent. */
  async shutdown(): Promise<void> {
    this.closeClient();
    this.closeTransport();
    if (await this.awaitExit()) return;
    await this.terminate();
  }
}

/**
 * Delete a directory, tolerating the Windows window where a just-exited process still
 * holds a handle.
 *
 * `fs.rm`'s own `maxRetries`/`retryDelay` handle EBUSY/ENOTEMPTY/EPERM, and the outer loop
 * covers the case where even that budget is exhausted. Bounded and event-free: it retries a
 * real failed operation rather than sleeping on the assumption that time will fix it.
 */
export function removeDirWithRetries(
  dir: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): void {
  const attempts = options.attempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 100;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: retryDelayMs });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      // Only these are worth retrying; anything else will not fix itself.
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw err;
      }
    }
  }
  throw new Error(
    `could not remove ${dir} after ${attempts} attempts: ${(lastError as Error)?.message ?? "unknown"}`,
  );
}
