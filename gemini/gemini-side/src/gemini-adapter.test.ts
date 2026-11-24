/**
 * The Gemini execution path, exercised as a real subprocess speaking the Antigravity CLI
 * (and legacy Gemini CLI) headless stream-json protocol. The child is a protocol stand-in;
 * the model call itself needs credentials and is outside these tests.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane, Orchestrator } from "@bridge/control-plane";
import {
  AttemptTerminationKind,
  DeliverableStatus,
  ErrorCode,
  seededRandom,
  type AttemptTelemetryUpdate,
  type InvocationContext,
  type TaskInvocation,
  type TaskSpec,
} from "@bridge/protocol";
import { ModelPreferenceStore } from "@bridge/runner-adapter";
import { AntigravityRunner, type AntigravityRunnerOptions, GeminiAdapter, buildGeminiTelemetry, emptyObservation, observeStreamLine, redact } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(here, "..", "test", "fixtures", "fake-agy.mjs");

class FixtureRunner extends AntigravityRunner {
  override buildArgs(...args: Parameters<AntigravityRunner["buildArgs"]>): string[] {
    return [fakeCli, ...super.buildArgs(...args)];
  }
}

let workspace: string;
let record: string;
let settings: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gemini-runner-"));
  record = join(workspace, "record.jsonl");
  settings = join(workspace, "agy-settings.json");
  writeFileSync(settings, JSON.stringify({ modelProvider: "gemini" }));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    objective: "apply a bounded change",
    scope: { paths: ["src/**"] },
    dependencies: [],
    expected_deliverable: "the change and its test evidence",
    verification_criteria: ["npm test passes"],
    ...overrides,
  };
}

function runner(mode: string, options: Partial<AntigravityRunnerOptions> = {}, env: Record<string, string> = {}): FixtureRunner {
  return new FixtureRunner({
    command: process.execPath,
    authMode: "api-key",
    settingsPath: settings,
    env: { FAKE_AGY_MODE: mode, FAKE_AGY_RECORD: record, GEMINI_API_KEY: "test-key-not-real", ...env },
    killGraceMs: 200,
    stopTimeoutMs: 5_000,
    ...options,
  });
}

function invocation(overrides: Partial<TaskInvocation> = {}): TaskInvocation {
  return {
    task_id: "task_gggggggggg",
    spec: spec(),
    inputs: [],
    workspace_root: workspace,
    lease_id: "lease_gggggggggg",
    deadline_at: Date.now() + 20_000,
    attempt: 0,
    idempotency_key: "k",
    previous_execution_handle: null,
    ...overrides,
  } as TaskInvocation;
}

interface Captured {
  telemetry: AttemptTelemetryUpdate[]; handles: string[]; states: string[]; artifacts: string[]; blockers: string[];
}

function context(signal: AbortSignal = new AbortController().signal): { ctx: InvocationContext; seen: Captured } {
  const seen: Captured = { telemetry: [], handles: [], states: [], artifacts: [], blockers: [] };
  let n = 0;
  return {
    seen,
    ctx: {
      report: async () => {},
      publishArtifact: async (input) => { seen.artifacts.push(input.name); n += 1; return `art_${String(n).padStart(10, "0")}`; },
      recordVerification: async () => {},
      raiseBlocker: async (reason) => { seen.blockers.push(reason); },
      saveExecutionHandle: async (handle) => { seen.handles.push(handle); },
      reportTelemetry: async (update) => { seen.telemetry.push(update); },
      reportRuntimeState: async (state) => { seen.states.push(state); },
      signal,
    },
  };
}

const recorded = (): Array<{ argv: string[]; cwd: string; worker: string | null }> =>
  readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("Gemini worker authorization", () => {
  it("stays disabled without an explicit supported auth mode and never spawns", async () => {
    const { ctx, seen } = context();
    const deliverable = await new GeminiAdapter({ runner: runner("success", { authMode: undefined }) }).invoke(invocation(), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(seen.blockers[0]).toMatch(/consumer Antigravity\/Gemini login/);
    expect(seen.states).toEqual(["stopped"]);
    expect(existsSync(record)).toBe(false);
    expect((await new GeminiAdapter({ runner: runner("success", { authMode: undefined }) }).health()).status).toBe("UNAVAILABLE");
  });

  it("requires an API key and the Antigravity API-key provider in api-key mode", async () => {
    const noKey = runner("success", {}, { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" });
    expect(noKey.authorizationProblem()).toMatch(/GEMINI_API_KEY/);
    writeFileSync(settings, JSON.stringify({ modelProvider: "account" }));
    expect(runner("success").authorizationProblem()).toMatch(/modelProvider/);
    expect(runner("success", { dialect: "gemini-cli" }).authorizationProblem()).toBeNull();
    expect(runner("success", { authMode: "enterprise" }).authorizationProblem()).toBeNull();
  });
});

describe("GeminiAdapter over the Antigravity CLI protocol", () => {
  it("completes with verified evidence, saves the conversation handle and reports telemetry", async () => {
    const adapter = new GeminiAdapter({ runner: runner("success") });
    const { ctx, seen } = context();
    const deliverable = await adapter.invoke(invocation(), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(deliverable.agent).toBe("gemini");
    expect(deliverable.changed_scope).toEqual(["src/a.ts"]);
    expect(deliverable.verification_results).toHaveLength(1);
    expect(seen.handles).toEqual(["conv-0001-abcdef"]);
    expect(seen.states).toEqual(["running", "stopped"]);
    const t = seen.telemetry[0]!;
    expect(t.runtime).toBe("antigravity-cli");
    expect(t.input_tokens).toBe(1000);
    expect(t.output_tokens).toBe(250); // thinking folded in only because the stated total includes it
    expect(t.cached_input_tokens).toBe(400);
    expect(t.total_tokens).toBe(1250);
    expect(t.turn_count).toBe(3);
    expect(t.runtime_duration_ms).toBe(2500);
    expect(t.requested_model).toBeNull();
    expect(t.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
    const call = recorded()[0]!;
    expect(call.worker).toBe("1");
    expect(call.argv).toContain("stream-json");
    expect(call.argv).not.toContain("--model"); // runtime default
    expect(call.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("passes the task model/effort first, then the stored preference", async () => {
    const store = new ModelPreferenceStore(workspace);
    store.set("gemini", { model: "gemini-4-hydrogen", effort: "medium" }, "codex");
    const adapter = new GeminiAdapter({ runner: runner("success", { modelPreference: store.reader("gemini") }) });
    await adapter.invoke(invocation(), context().ctx);
    await adapter.invoke(invocation({ task_id: "task_hhhhhhhhhh", spec: spec({ model: "gemini-4-neon", effort: "xhigh" }) }), context().ctx);
    const [first, second] = recorded();
    expect(first!.argv.slice(first!.argv.indexOf("--model"), first!.argv.indexOf("--model") + 2)).toEqual(["--model", "gemini-4-hydrogen"]);
    expect(first!.argv[first!.argv.indexOf("--effort") + 1]).toBe("medium");
    expect(second!.argv[second!.argv.indexOf("--model") + 1]).toBe("gemini-4-neon");
    expect(second!.argv[second!.argv.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("refuses a runtime that reports a different model than requested", async () => {
    const adapter = new GeminiAdapter({ runner: runner("wrongmodel") });
    await expect(adapter.invoke(invocation({ spec: spec({ model: "gemini-4-neon" }) }), context().ctx))
      .rejects.toMatchObject({ code: ErrorCode.RUNTIME_PROFILE_MISMATCH });
  });

  it("runs read-only tasks in plan mode and blocks a read-only task that claims writes", async () => {
    const adapter = new GeminiAdapter({ runner: runner("readonly-violation") });
    const { ctx, seen } = context();
    const deliverable = await adapter.invoke(invocation({ spec: spec({ scope: { paths: ["(no-write)/**"] } }) }), ctx);
    expect(recorded()[0]!.argv).toContain("--mode=plan");
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.changed_scope).toEqual([]);
    expect(seen.blockers[0]).toMatch(/read-only task reported changed files/);
  });

  it("resumes the same conversation and never mints a replacement", async () => {
    const adapter = new GeminiAdapter({ runner: runner("success") });
    const { ctx, seen } = context();
    await adapter.invoke(invocation({ previous_execution_handle: "conv-0001-abcdef", resume_required: true }), ctx);
    const argv = recorded()[0]!.argv;
    expect(argv[argv.indexOf("--conversation") + 1]).toBe("conv-0001-abcdef");
    expect(seen.handles).toEqual([]);
  });

  it("fails strict resume without a persisted handle before spawning", async () => {
    const adapter = new GeminiAdapter({ runner: runner("success") });
    await expect(adapter.invoke(invocation({ resume_required: true }), context().ctx))
      .rejects.toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
    expect(existsSync(record)).toBe(false);
  });

  it("rejects contradictory verification claims and preserves the candidate", async () => {
    const adapter = new GeminiAdapter({ runner: runner("contradiction") });
    const { ctx, seen } = context();
    const deliverable = await adapter.invoke(invocation(), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.verification_results).toEqual([]);
    expect(seen.artifacts).toEqual(["gemini-rejected-result.json"]);
  });

  it("returns PARTIAL without verification and preserves long reports", async () => {
    const noVerify = await new GeminiAdapter({ runner: runner("noverify") }).invoke(invocation(), context().ctx);
    expect(noVerify.status).toBe(DeliverableStatus.PARTIAL);
    const { ctx, seen } = context();
    const long = await new GeminiAdapter({ runner: runner("long") }).invoke(invocation(), ctx);
    expect(long.status).toBe(DeliverableStatus.COMPLETE);
    expect(seen.artifacts).toEqual(["gemini-report.md"]);
  });

  it("maps a runtime auth failure to a blocked PARTIAL with a classified failure", async () => {
    const { ctx, seen } = context();
    const deliverable = await new GeminiAdapter({ runner: runner("fail-auth") }).invoke(invocation(), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(seen.blockers[0]).toMatch(/auth/);
    expect(seen.telemetry[0]!.runtime_failure?.category).toBe("auth");
  });

  it("surfaces a launch without any result as an adapter failure", async () => {
    await expect(new GeminiAdapter({ runner: runner("noresult") }).invoke(invocation(), context().ctx))
      .rejects.toMatchObject({ code: ErrorCode.ADAPTER_FAILURE });
  });

  it("stops a hung runtime at its deadline with positive stop evidence", async () => {
    const { ctx, seen } = context();
    const deliverable = await new GeminiAdapter({ runner: runner("hang") })
      .invoke(invocation({ deadline_at: Date.now() + 1_500 }), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(seen.states.at(-1)).toBe("stopped");
    expect(seen.telemetry[0]!.termination_kind).toBe(AttemptTerminationKind.TIMEOUT);
  }, 20_000);

  it("hands long contracts over through a private prompt file that is removed afterwards", async () => {
    const adapter = new GeminiAdapter({ runner: runner("success", { maxArgvPromptChars: 200 }) });
    const deliverable = await adapter.invoke(invocation(), context().ctx);
    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(recorded()[0]!.argv[recorded()[0]!.argv.indexOf("-p") + 1]).toMatch(/\.bridge\/worker-prompts\//);
    expect(readdirSync(join(workspace, ".bridge", "worker-prompts"))).toEqual([]);
  });

  it("refuses extra args that would override bridge-owned flags", () => {
    expect(() => new AntigravityRunner({ extraArgs: ["--dangerously-skip-permissions"] })).toThrow(/bridge-owned flag/);
    expect(() => new AntigravityRunner({ extraArgs: ["--model=x"] })).toThrow(/bridge-owned flag/);
  });

  it("supports the legacy Gemini CLI dialect with a pre-minted session id", async () => {
    const adapter = new GeminiAdapter({ runner: runner("success", { dialect: "gemini-cli" }, { FAKE_AGY_DIALECT: "gemini-cli" }) });
    const { ctx, seen } = context();
    const deliverable = await adapter.invoke(invocation(), ctx);
    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    const argv = recorded()[0]!.argv;
    expect(argv).toContain("--approval-mode");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("auto_edit");
    expect(seen.handles).toHaveLength(1);
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(seen.handles[0]);
    expect(seen.telemetry[0]!.runtime).toBe("gemini-cli");
    expect(seen.telemetry[0]!.cached_input_tokens).toBe(20);
  });
});

describe("Gemini delegation through the control plane", () => {
  it("delegates from Codex to Gemini and reaches DONE with verification", async () => {
    const cp = ControlPlane.open({ workspaceRoot: workspace, databasePath: ":memory:", rng: seededRandom(7) });
    try {
      cp.adapters.register(new GeminiAdapter({ runner: runner("success") }));
      const outcome = await new Orchestrator(cp).delegate({
        from: "codex", to: "gemini", spec: spec(), input_artifacts: [], deadline_ms: 20_000,
      });
      expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
      expect(cp.tasks.get(outcome.task_id).state).toBe("DONE");
    } finally {
      cp.close();
    }
  });
});

describe("stream and telemetry helpers", () => {
  it("does not fold thinking tokens when the stated total excludes them", () => {
    const observation = emptyObservation();
    observeStreamLine(observation, { event: "result", result: { status: "SUCCESS", response: "x",
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 50, total_tokens: 15 } } });
    const t = buildGeminiTelemetry({ dialect: "antigravity", runtimeVersion: null,
      selection: { model: null, effort: null, model_source: "runtime-default", effort_source: "runtime-default" },
      observation, startedAt: 0, firstOutputAt: null, endedAt: 10, promptBytes: 1, exitCode: 0, exitSignal: null,
      cancelled: false, timedOut: false, failed: false, runtimeFailure: null });
    expect(t.output_tokens).toBe(5);
    expect(t.cached_input_tokens).toBeNull(); // larger than the stated input: not a subdimension
  });

  it("redacts credential-shaped text from runtime errors", () => {
    expect(redact("token AIzaSyD-abcdefghijklmnopqrstuvwx failed")).not.toMatch(/AIza/);
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[redacted]");
  });
});
