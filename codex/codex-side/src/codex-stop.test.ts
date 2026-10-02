import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProcessClient } from "./codex-app-server-client.js";
const clients: CodexAppServerProcessClient[] = [];
const dirs: string[] = [];
const fixture = resolve("codex/codex-side/test/fixtures/fake-codex-stop.mjs");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function setup(mode?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-stop-")); dirs.push(dir);
  const log = join(dir, "calls.txt");
  const client = new CodexAppServerProcessClient({ command: process.execPath, args: [fixture, log, mode ?? "normal"], request_timeout_ms: 1_000, stop_timeout_ms: 150 });
  clients.push(client);
  return { client, log };
}
function req(signal: AbortSignal) {
  return { signal, prompt: "fixture", cwd: process.cwd(), approval_policy: "never" as const, sandbox: "read-only" as const, timeout_ms: 1_000 };
}
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(c => c.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("targeted remote stop", () => {
  it("waits for the interrupted notification, preserves another active turn, and ignores late events", async () => {
    const { client, log } = setup(); await client.probe();
    const a = new AbortController(); const b = new AbortController();
    const first = client.start(req(a.signal)).catch(e => e);
    const second = client.start(req(b.signal)).catch(e => e);
    await pause(90); a.abort();
    const stopped = await first;
    expect(stopped.details?.runtime_stop_confirmed).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("stopped:thread_1:turn_1");
    const before = readFileSync(log, "utf8").match(/write:thread_2/g)?.length ?? 0;
    await pause(70);
    const after = readFileSync(log, "utf8").match(/write:thread_2/g)?.length ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(readFileSync(log, "utf8")).not.toContain("interrupt:thread_2");
    b.abort(); await second;
  });
  it("does not accept the interrupt RPC acknowledgement alone as proof of stop", async () => {
    const { client, log } = setup("ignore-stop"); await client.probe();
    const controller = new AbortController();
    const pending = client.start(req(controller.signal)).catch(e => e);
    await pause(70); controller.abort();
    const error = await pending;
    expect(error.code).toBe("RUNTIME_STOP_UNCONFIRMED");
    expect(error.details?.runtime_stop_confirmed).toBe(false);
    const before = readFileSync(log, "utf8").length;
    await pause(30); expect(readFileSync(log, "utf8").length).toBeGreaterThan(before);
  });
  it("interrupts the correlated turn even when the turn/start response was lost", async () => {
    const { client, log } = setup("lost-start"); await client.probe();
    const controller = new AbortController();
    const pending = client.start(req(controller.signal)).catch(e => e);
    await pause(70); controller.abort();
    const error = await pending;
    expect(error.details?.runtime_stop_confirmed).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("stopped:thread_1:turn_1");
  });
  it("does not accept an unknown completion status while the runtime keeps writing", async () => {
    const { client, log } = setup("invalid-status"); await client.probe();
    const controller = new AbortController();
    const pending = client.start(req(controller.signal)).catch(e => e);
    await pause(70); controller.abort();
    const error = await pending;
    expect(error.code).toBe("RUNTIME_STOP_UNCONFIRMED");
    const before = readFileSync(log, "utf8").length;
    await pause(25); expect(readFileSync(log, "utf8").length).toBeGreaterThan(before);
  });
  it("interrupts a turn identified after local abandonment and emits late positive stop evidence", async () => {
    const { client, log } = setup("late-start"); await client.probe();
    const controller = new AbortController(); const states: string[] = [];
    const pending = client.start({ ...req(controller.signal), on_runtime_state: async state => { states.push(state); } }).catch(e => e);
    await pause(70); controller.abort();
    expect((await pending).code).toBe("RUNTIME_STOP_UNCONFIRMED");
    await pause(400);
    expect(readFileSync(log, "utf8")).toContain("stopped:thread_1:turn_1");
    expect(states).toContain("unconfirmed"); expect(states.at(-1)).toBe("stopped");
  });
  it("does not use an earlier nonterminal completion frame as positive proof when abort fires", async () => {
    const { client, log } = setup("invalid-early"); await client.probe();
    const controller = new AbortController();
    const pending = client.start(req(controller.signal)).catch(e => e);
    await pause(70); controller.abort();
    const failure = await pending;
    expect(failure.code).toBe("RUNTIME_STOP_UNCONFIRMED");
    expect(failure.details?.runtime_stop_confirmed).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("interrupt:thread_1:turn_1");
  });
});
