import { afterEach, expect, it, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { ClaudeCodeRunner } from "./claude-code-runner.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
  vi.mocked(execFile).mockReset();
});

class ProbeRunner extends ClaudeCodeRunner {
  inspectClosedRoot(): Promise<boolean> {
    const child = { pid: 999_999, exitCode: 0, signalCode: null } as ChildProcess;
    return this.ensureProcessTreeStopped(child, Date.now() - 100, () => Date.now());
  }
}

it.each([
  { budget: 15_000, expected: true, name: "accepts a successful slow inspection inside its declared window" },
  { budget: 4_000, expected: false, name: "cannot certify a stop when inspection exceeds the declared window" },
])("$name", async ({ budget, expected }) => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const options = args[2] as { timeout: number };
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    // The observed CI cold CIM query exceeded 5s. Model a 6s query with real timeout
    // semantics; an empty process table is useful evidence only if inspection succeeds.
    setTimeout(() => {
      if (options.timeout < 6_000) callback(Object.assign(new Error("inspection timed out"), { code: "ETIMEDOUT" }), "", "");
      else callback(null, "[]", "");
    }, Math.min(options.timeout, 6_000));
    return {} as ChildProcess;
  });
  const stopped = new ProbeRunner({ stopTimeoutMs: budget }).inspectClosedRoot();
  await vi.advanceTimersByTimeAsync(6_001);
  expect(await stopped).toBe(expected);
  expect(execFile).toHaveBeenCalledTimes(1);
});
