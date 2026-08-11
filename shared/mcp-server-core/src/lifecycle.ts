/**
 * Agent-neutral server lifecycle: boot recovery, signal handling, ordered shutdown.
 *
 * Both agents' launchers need the same sequence, and getting it wrong is expensive in a
 * specific way — a process that exits before SQLite closes leaves a locked database file
 * that Windows will not let the next run delete. So the ordering lives here once:
 *
 *   1. run crash recovery (frees leases orphaned by a previous process);
 *   2. connect the transport;
 *   3. on signal: stop protocol traffic, dispose adapters, close the control plane;
 *   4. only then let the process exit.
 *
 * Every diagnostic goes to stderr. stdout is the MCP transport: one stray byte there and
 * the peer's JSON-RPC parser desynchronises.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentAdapter } from "@bridge/protocol";
import type { BridgeMcpServer } from "./server.js";

export type LogSink = (line: string) => void;

/** Default diagnostics sink: stderr, never stdout. */
export const stderrLog: LogSink = (line) => {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
};

export interface ServeOptions {
  readonly server: BridgeMcpServer;
  /** Prefix for log lines, e.g. "bridge-claude". */
  readonly label: string;
  readonly log?: LogSink;
  /** Adapters to dispose before the control plane closes. */
  readonly adapters?: readonly AgentAdapter[];
  readonly transport?: Transport;
  /** Register SIGINT/SIGTERM handlers. Off in tests that drive shutdown directly. */
  readonly handleSignals?: boolean;
  /** Injected for tests; defaults to `process`. */
  readonly processRef?: NodeJS.Process;
}

export interface ServeHandle {
  /** Idempotent ordered shutdown. Safe to call from a signal handler and a test. */
  shutdown(reason: string): Promise<void>;
  readonly recovery: { expired_leases: readonly string[]; in_flight_count: number };
}

/**
 * Boot a server: recover, connect, and wire shutdown. Returns a handle so an embedder can
 * shut down explicitly rather than only via signals.
 */
export async function serve(options: ServeOptions): Promise<ServeHandle> {
  const log = options.log ?? stderrLog;
  const proc = options.processRef ?? process;
  const { server, label } = options;

  // Expire leases orphaned by a previous crash before serving, so a dead session's scope
  // does not stay locked against the surviving agent.
  const recovery = server.cp.recover();
  if (recovery.expired_leases.length > 0 || recovery.in_flight_tasks.length > 0) {
    log(
      `[${label}] recovery: expired ${recovery.expired_leases.length} lease(s), ` +
        `${recovery.in_flight_tasks.length} task(s) were in flight`,
    );
  }

  let shutting: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    // Collapse concurrent calls: a SIGTERM arriving during a SIGINT shutdown must join the
    // in-flight sequence rather than starting a second one against a half-closed database.
    if (shutting) return shutting;
    shutting = (async () => {
      log(`[${label}] ${reason}, shutting down`);
      try {
        for (const adapter of options.adapters ?? []) {
          try {
            await adapter.dispose?.();
          } catch (err) {
            log(`[${label}] adapter dispose failed: ${(err as Error).message}`);
          }
        }
      } finally {
        await server.close();
      }
    })();
    return shutting;
  };

  if (options.handleSignals !== false) {
    const onSignal = (signal: string): void => {
      void shutdown(signal)
        .catch((err: unknown) => {
          log(`[${label}] shutdown failed: ${(err as Error).stack ?? String(err)}`);
          proc.exitCode = 1;
        })
        .finally(() => {
          proc.exit(proc.exitCode ?? 0);
        });
    };
    proc.once("SIGINT", () => onSignal("SIGINT"));
    proc.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  try {
    await server.connect(options.transport);
  } catch (err) {
    await shutdown("startup failure").catch(() => undefined);
    throw err;
  }

  /**
   * Exit when the peer closes the transport.
   *
   * For a stdio server, EOF on stdin means the client is gone. Without this the process
   * lingers holding an open SQLite file, and on Windows the parent cannot delete the
   * database — the exact failure behind codex req_codex_windows_smoke_cleanup_001. Closing
   * on EOF is also the graceful path that makes a SIGKILL fallback almost never necessary.
   */
  if (options.handleSignals !== false) {
    const underlying = server.mcp.server;
    const previousOnClose = underlying.onclose?.bind(underlying);
    underlying.onclose = (): void => {
      previousOnClose?.();
      void shutdown("transport closed")
        .catch((err: unknown) => {
          log(`[${label}] shutdown failed: ${(err as Error).stack ?? String(err)}`);
          proc.exitCode = 1;
        })
        .finally(() => {
          proc.exit(proc.exitCode ?? 0);
        });
    };
  }

  log(`[${label}] serving ${server.toolNames.length} tools`);

  return {
    shutdown,
    recovery: {
      expired_leases: recovery.expired_leases,
      in_flight_count: recovery.in_flight_tasks.length,
    },
  };
}
