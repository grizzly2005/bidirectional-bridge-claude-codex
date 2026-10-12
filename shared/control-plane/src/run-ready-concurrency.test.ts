/** Shared SQLite + two local Node processes, with synthetic adapters and no providers. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ControlPlane } from "./control-plane.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function start(script: string, directory: string, database: string) {
  const child: ChildProcess = spawn(process.execPath, [script, directory, database], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "", stderr = "";
  let announce!: () => void;
  let rejectReady!: (error: Error) => void;
  let announced = false;
  const ready = new Promise<void>((resolve, reject) => {
    announce = () => { announced = true; resolve(); };
    rejectReady = reject;
    child.once("error", reject);
  });
  child.stdout!.on("data", data => { stdout += String(data); if (stdout.startsWith("ready\n")) announce(); });
  child.stderr!.on("data", data => { stderr += String(data); });
  child.stdin!.on("error", () => {});
  const done = new Promise<{ candidates: number; invokes: number; outcomes: Array<{ task_id: string; error: unknown }> }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      if (!announced) rejectReady(new Error(`Local scheduler exited before ready (${code}): ${stderr}`));
      if (code !== 0) { reject(new Error(`Local scheduler process exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)); } catch (error) { reject(error); }
    });
  });
  // Attach rejection handlers immediately so an early fixture startup failure stays bounded.
  void ready.catch(() => undefined); void done.catch(() => undefined);
  return { ready, done, go: () => child.stdin!.end("go\n") };
}

it("reports a scheduler startup failure instead of leaving the ready barrier pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-run-ready-startup-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const script = join(directory, "failed-fixture.mjs");
  writeFileSync(script, "process.stderr.write('fixture startup rejected'); process.exit(3);");
  const process = start(script, directory, join(directory, "unused.db"));
  await expect(process.ready).rejects.toThrow("Local scheduler exited before ready (3): fixture startup rejected");
  await expect(process.done).rejects.toThrow("Local scheduler process exited 3");
});

it("executes one existing task once when independent processes observed the same PENDING set", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-run-ready-processes-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const database = join(directory, "fixture.db");
  const cp = ControlPlane.open({ workspaceRoot: directory, databasePath: database, journalMode: "DELETE" });
  const task = cp.tasks.create({ created_by: "codex", spec: { objective: "process scheduler fixture", scope: { paths: ["(no-write)/scheduler/**"] },
    dependencies: [], expected_deliverable: "fixture outcome", verification_criteria: ["fixture assertions pass"], preferred_agent: "claude" } });
  cp.close();
  const module = pathToFileURL(fileURLToPath(new URL("../dist/index.js", import.meta.url))).href;
  const script = join(directory, "scheduler-fixture.mjs");
  writeFileSync(script, `import { ControlPlane, Orchestrator } from ${JSON.stringify(module)};
    const cp = ControlPlane.open({ workspaceRoot: process.argv[2], databasePath: process.argv[3], journalMode: 'DELETE' });
    const candidates = cp.tasks.readyTasks();
    // Both candidates are real SQLite snapshots captured before either reservation.
    cp.tasks.readyTasks = () => candidates;
    let invokes = 0;
    cp.adapters.register({ info: { agent: 'claude', implementation: 'local-fixture', version: '1',
      capabilities: ['structured-deliverable'], max_concurrency: 2 }, health: async () => ({ status: 'READY', checked_at: Date.now() }),
      cancel: async () => {}, invoke: async invocation => {
        invokes++;
        await new Promise(resolve => setTimeout(resolve, 20));
        const check = { kind: 'test', command: 'local process fixture', passed: true, exit_code: 0, summary: 'synthetic pass' };
        return { task_id: invocation.task_id, agent: 'claude', status: 'COMPLETE', summary: 'local fixture result',
          artifacts: [], changed_scope: [], commit_or_diff: null, verification_performed: [check.command], verification_results: [check],
          remaining_risks: [], dependencies_unblocked: [], recommended_next_action: 'none', at: Date.now() };
      } });
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    try {
      const outcomes = await new Orchestrator(cp).runReady('claude', 3000);
      process.stdout.write(JSON.stringify({ candidates: candidates.length, invokes, outcomes }) + '\\n');
    } finally { cp.close(); }
  `);
  const first = start(script, directory, database), second = start(script, directory, database);
  await Promise.all([first.ready, second.ready]); first.go(); second.go();
  const results = await Promise.all([first.done, second.done]);
  expect(results.map(result => result.candidates)).toEqual([1, 1]);
  expect(results.reduce((sum, result) => sum + result.invokes, 0)).toBe(1);
  const outcomes = results.flatMap(result => result.outcomes);
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes.every(outcome => outcome.task_id === task.task_id && outcome.error === null)).toBe(true);
  const observed = ControlPlane.open({ workspaceRoot: directory, databasePath: database, journalMode: "DELETE" });
  try {
    expect(observed.store.listTasks()).toHaveLength(1);
    expect(observed.tasks.get(task.task_id)).toMatchObject({ state: "DONE", run_id: task.run_id, parent_task_id: null, spec: task.spec });
    expect(observed.attempts.list(task.task_id)).toHaveLength(1);
    expect(observed.events({ task_id: task.task_id, types: ["delegation.requested"] })).toHaveLength(1);
    expect(observed.store.getExecution(task.task_id)).toMatchObject({ phase: "STOPPED", runtime_stop_confirmed: true });
    expect(observed.leases.listLive()).toEqual([]);
  } finally { observed.close(); }
});
