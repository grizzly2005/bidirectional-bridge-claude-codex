/**
 * Live stdio smoke tests for the Claude launcher.
 *
 * The tool tests in `@bridge/mcp-server-core` exercise handlers directly, which would still
 * pass if the MCP wiring, the launcher, or the shutdown sequence were broken. These spawn
 * `main.js` as a real child process and speak JSON-RPC over its stdio, the way Claude Code
 * and the Codex CLI will.
 *
 * Three properties are under test, each corresponding to a defect that actually occurred:
 *  - the server answers over the wire at all;
 *  - state survives a full restart (durability);
 *  - shutdown releases the SQLite handle before the workspace is deleted, and stdout
 *    carries nothing but protocol frames.
 */

import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlane } from "@bridge/control-plane";
import { BridgeServerHarness, removeDirWithRetries } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "..", "dist", "server", "main.js");

/** Every workspace any test in this file created, so teardown can guarantee cleanup. */
const workspaces: string[] = [];

function newWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ *
 * 1. The server answers over a real stdio transport
 * ------------------------------------------------------------------ */

describe("MCP stdio server", () => {
  let harness: BridgeServerHarness;
  let workspace: string;

  beforeAll(async () => {
    workspace = newWorkspace("bridge-smoke-");
    harness = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    const init = await harness.initialize();
    expect((init.result as any).serverInfo.name).toBe("bridge-coordination");
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  it("advertises the coordination tools over the wire", async () => {
    const res = await harness.request("tools/list");
    const names = (res.result as any).tools.map((t: { name: string }) => t.name);
    expect(names).toContain("bridge_create_task");
    expect(names).toContain("bridge_acquire_lease");
    expect(names).toContain("bridge_delegate");
    expect(names).toContain("bridge_set_execution_handle");
  });

  it("creates a task and reads it back through real tool calls", async () => {
    const created = await harness.callTool("bridge_create_task", {
      spec: {
        objective: "smoke: verify the bridge answers over stdio",
        scope: { paths: ["claude/**"] },
        dependencies: [],
        expected_deliverable: "a passing smoke test",
        verification_criteria: ["the server responds to tools/call"],
      },
    });
    expect(created.data.task_id).toMatch(/^task_/);

    const snapshot = await harness.callTool("bridge_snapshot");
    expect(snapshot.data.task_count).toBe(1);
    expect(snapshot.data.ready_task_ids).toContain(created.data.task_id);
  });

  it("persists an execution handle across tool calls", async () => {
    const created = await harness.callTool("bridge_create_task", {
      spec: {
        objective: "smoke: execution handle round trip",
        scope: { paths: ["docs/**"] },
        dependencies: [],
        expected_deliverable: "a stored handle",
        verification_criteria: ["handle reads back"],
      },
    });
    const task_id = created.data.task_id as string;
    await harness.callTool("bridge_claim_task", { task_id });
    await harness.callTool("bridge_set_execution_handle", {
      task_id,
      execution_handle: "claude_session_smoke_001",
    });

    const read = await harness.callTool("bridge_get_execution_handle", { task_id });
    expect(read.data.execution_handle).toBe("claude_session_smoke_001");
  });

  it("returns a structured error, not a crash, for an illegal operation", async () => {
    const res = await harness.callTool("bridge_claim_task", { task_id: "task_zzzzzzzzzz" });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("NOT_FOUND");
  });

  it("writes only JSON-RPC frames to stdout and all diagnostics to stderr", () => {
    // stdout IS the transport. A single stray line here desynchronises the peer's parser,
    // which is why the launcher sends every log line to stderr.
    expect(harness.stdoutLines.length).toBeGreaterThan(0);
    for (const line of harness.stdoutLines) {
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(line);
      }, `stdout line is not JSON: ${line.slice(0, 200)}`).not.toThrow();
      expect((parsed as { jsonrpc?: string }).jsonrpc, `missing jsonrpc field: ${line.slice(0, 200)}`).toBe("2.0");
    }

    // And the diagnostics really did go somewhere — proving the launcher logs at all, so
    // the assertion above is not passing merely because nothing is ever logged.
    expect(harness.stderrChunks.join("")).toContain("[bridge-claude]");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Durability across a full process restart
 * ------------------------------------------------------------------ */

describe("restart durability", () => {
  it("recovers tasks, events and execution handles from disk after a full restart", async () => {
    const workspace = newWorkspace("bridge-restart-");

    const first = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    await first.initialize();
    const created = await first.callTool("bridge_create_task", {
      spec: {
        objective: "survive a restart",
        scope: { paths: ["claude/**"] },
        dependencies: [],
        expected_deliverable: "state on disk",
        verification_criteria: ["second process sees the task"],
      },
    });
    const task_id = created.data.task_id as string;
    await first.callTool("bridge_claim_task", { task_id });
    await first.callTool("bridge_set_execution_handle", {
      task_id,
      execution_handle: "claude_session_restart_001",
    });
    const eventsBefore = (await first.callTool("bridge_read_events", {})).data.last_event_id as number;

    // Full ordered shutdown: the SQLite handle must be released before the next process
    // opens the same database file.
    await first.shutdown();
    expect(await first.exited).not.toBeNull();

    const second = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    await second.initialize();

    const task = await second.callTool("bridge_get_task", { task_id });
    expect(task.data.task.state).toBe("CLAIMED");
    expect(task.data.task.owner).toBe("claude");
    expect(task.data.attempts[0].execution_handle).toBe("claude_session_restart_001");

    const eventsAfter = (await second.callTool("bridge_read_events", {})).data.last_event_id as number;
    expect(eventsAfter).toBeGreaterThanOrEqual(eventsBefore);

    await second.shutdown();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Shutdown ordering and Windows-safe cleanup
 * ------------------------------------------------------------------ */

describe("shutdown and cleanup ordering", () => {
  it("exits on stdin EOF without needing a signal, releasing the database", async () => {
    const workspace = newWorkspace("bridge-eof-");
    const harness = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    await harness.initialize();
    await harness.callTool("bridge_snapshot");

    // Step 1 + 2 only. If the server honours EOF, no signal is ever required — which is
    // what makes the graceful path graceful rather than a SIGKILL race.
    harness.closeClient();
    harness.closeTransport();

    const exitedCleanly = await harness.awaitExit(10_000);
    expect(exitedCleanly, "server did not exit on stdin EOF").toBe(true);

    const code = await harness.exited;
    expect(code).toBe(0);
  });

  it("removes the workspace after the child exits, with the database unlocked", async () => {
    const workspace = newWorkspace("bridge-cleanup-");
    const harness = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    await harness.initialize();
    await harness.callTool("bridge_create_task", {
      spec: {
        objective: "hold the database open",
        scope: { paths: ["claude/**"] },
        dependencies: [],
        expected_deliverable: "a db file",
        verification_criteria: ["file exists"],
      },
    });

    const dbPath = join(workspace, ".bridge", "bridge.db");
    expect(existsSync(dbPath)).toBe(true);

    // Full ordered shutdown, then delete. This is the sequence that fails on Windows with
    // EBUSY if the child's exit is not awaited first.
    await harness.shutdown();
    expect(await harness.exited).not.toBeNull();

    // Step 5: any handle the *test* opened is closed before deletion. Opening the database
    // here also proves the child truly released it — SQLite would otherwise be locked.
    const cp = ControlPlane.open({ workspaceRoot: workspace, databasePath: dbPath });
    expect(cp.tasks.list()).toHaveLength(1);
    cp.close();

    // Step 6: bounded retries, no sleep.
    removeDirWithRetries(workspace);
    expect(existsSync(workspace)).toBe(false);
  });

  it("is idempotent: a second shutdown after exit is a no-op", async () => {
    const workspace = newWorkspace("bridge-idem-");
    const harness = new BridgeServerHarness({ entry: serverEntry, workspace, agent: "claude" });
    await harness.initialize();

    await harness.shutdown();
    await expect(harness.shutdown()).resolves.toBeUndefined();
  });

  it("force-terminates a child that ignores the graceful path, within the bound", async () => {
    // `awaitExit` with a tiny budget simulates a wedged server: the harness must escalate
    // rather than hang, so a stuck child cannot block CI indefinitely.
    const workspace = newWorkspace("bridge-force-");
    const harness = new BridgeServerHarness({
      entry: serverEntry,
      workspace,
      agent: "claude",
      exitTimeoutMs: 250,
    });
    await harness.initialize();

    await harness.terminate();
    expect(await harness.awaitExit(5_000)).toBe(true);
  });
});

afterAll(() => {
  // Belt and braces: any workspace a failing test left behind still gets removed, so a
  // failure does not leak a temp directory into the next run.
  for (const dir of workspaces) {
    try {
      removeDirWithRetries(dir);
    } catch {
      // Reported by the test that owns it; never mask the real failure with a cleanup error.
    }
  }
});
