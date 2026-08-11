/**
 * The real Claude execution path, exercised as a subprocess.
 *
 * These are not mock-adapter tests. The adapter spawns a child process and parses the
 * actual Claude Code stream-json protocol; the child is a stand-in that emits frames
 * captured from the real binary (2.1.222). Everything between the control plane and the
 * model is under test: argv contract, session capture, resume, bounding, cancellation,
 * error mapping, and structured-result parsing.
 *
 * The one step these cannot cover is the model call itself — that is what
 * `scripts/live-claude-delegation.mjs` does, and it needs credentials.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane, Orchestrator } from "@bridge/control-plane";
import {
  AttemptTerminationKind,
  DEFAULT_TASK_MAX_TURNS,
  DeliverableStatus,
  ErrorCode,
  MAX_TASK_MAX_TURNS,
  TelemetryCostSemantics,
  seededRandom,
  type AttemptTelemetryUpdate,
  type TaskInvocation,
  type TaskSpec,
} from "@bridge/protocol";
import { ClaudeAdapter } from "./claude-adapter.js";
import {
  ClaudeCodeRunner,
  CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS,
  CLAUDE_REQUESTED_EFFORT,
  CLAUDE_REQUESTED_MODEL,
  buildPrompt,
  buildRunnerTelemetry,
  isOpusFamilyModel,
  normalizeClaudeUsage,
  parseStructuredOutput,
  type BuildRunnerTelemetryInput,
} from "./claude-code-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(here, "..", "..", "test", "fixtures", "fake-claude-cli.mjs");

const SCOPE = { paths: ["claude/**", "docs/*.md"] };

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    objective: "report runtime information without modifying any source",
    scope: SCOPE,
    dependencies: [],
    expected_deliverable: "a summary of the runtime",
    verification_criteria: ["node --version runs"],
    ...overrides,
  };
}

let cp: ControlPlane;
let orchestrator: Orchestrator;
let workspace: string;
let argvFile: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "claude-runner-"));
  argvFile = join(workspace, "argv.json");
  cp = ControlPlane.open({
    workspaceRoot: workspace,
    databasePath: ":memory:",
    rng: seededRandom(31),
  });
  orchestrator = new Orchestrator(cp);
});

afterEach(() => {
  cp.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A runner wired to the protocol stand-in, spawned exactly like the real CLI. */
function runner(mode: string, extra: Record<string, string> = {}) {
  return new ClaudeCodeRunner({
    command: process.execPath,
    extraArgs: [],
    // Node runs the fixture; from the adapter's perspective this is just "the binary".
    ...{},
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_ARGV_FILE: argvFile, ...extra },
    maxTurns: 4,
    permissionMode: "plan",
  });
}

/**
 * The adapter builds argv as `<command> <args...>`; to run the fixture through `node` we
 * put the script path first via a small subclass rather than weakening the production API.
 */
class FixtureRunner extends ClaudeCodeRunner {
  override buildArgs(invocation: Parameters<ClaudeCodeRunner["buildArgs"]>[0], prompt: string): string[] {
    return [fakeCli, ...super.buildArgs(invocation, prompt)];
  }
}

function fixtureRunner(mode: string, opts: Record<string, unknown> = {}) {
  return new FixtureRunner({
    command: process.execPath,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_ARGV_FILE: argvFile },
    maxTurns: 4,
    permissionMode: "plan",
    ...opts,
  });
}

async function delegate(mode: string, opts: Record<string, unknown> = {}, deadline_ms = 20_000) {
  const adapter = new ClaudeAdapter({ runner: fixtureRunner(mode, opts), agent: "claude" });
  cp.adapters.register(adapter);
  return orchestrator.delegate({
    from: "codex",
    to: "claude",
    spec: spec(),
    input_artifacts: [],
    deadline_ms,
  });
}

const readArgv = (): { args: string[]; cwd: string } => JSON.parse(readFileSync(argvFile, "utf8"));

/** A full invocation, so a test can drive the adapter without the orchestrator. */
function invocationFor(overrides: Partial<TaskInvocation> = {}): TaskInvocation {
  return {
    task_id: "task_aaaaaaaaaa",
    spec: spec(),
    inputs: [],
    workspace_root: workspace,
    lease_id: "lease_aaaaaaaaaa",
    deadline_at: Date.now() + 20_000,
    attempt: 0,
    idempotency_key: "k",
    previous_execution_handle: null,
    ...overrides,
  } as TaskInvocation;
}

/**
 * Run one invocation straight through the adapter, capturing what it reported.
 *
 * Deliberately not through the orchestrator: these assertions are about the exact values
 * the Claude side produces, and going through the control plane would test its sealing
 * logic instead.
 */
async function runCapturing(
  mode: string,
  opts: Record<string, unknown> = {},
  overrides: Partial<TaskInvocation> = {},
): Promise<{
  telemetry: AttemptTelemetryUpdate[];
  handles: string[];
  invocation: TaskInvocation;
  error: unknown;
}> {
  const adapter = new ClaudeAdapter({ runner: fixtureRunner(mode, opts), agent: "claude" });
  const invocation = invocationFor(overrides);
  const telemetry: AttemptTelemetryUpdate[] = [];
  const handles: string[] = [];
  let error: unknown;
  try {
    await adapter.invoke(invocation, {
      report: async () => {},
      publishArtifact: async () => "art_0000000000",
      recordVerification: async () => {},
      raiseBlocker: async () => {},
      saveExecutionHandle: async (h) => {
        handles.push(h);
      },
      reportTelemetry: async (u) => {
        telemetry.push(u);
      },
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e;
  }
  return { telemetry, handles, invocation, error };
}

/* ------------------------------------------------------------------ *
 * The path the task requires: control plane -> adapter -> runtime -> deliverable
 * ------------------------------------------------------------------ */

describe("control plane -> ClaudeAdapter -> Claude Code subprocess -> Deliverable", () => {
  it("completes a delegation and returns a structured deliverable", async () => {
    const outcome = await delegate("ok");

    expect(outcome.error).toBeNull();
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
    expect(outcome.deliverable?.summary).toContain("runtime info collected");
    expect(cp.tasks.get(outcome.task_id).state).toBe("DONE");

    // The structured contract survived the round trip as real evidence.
    const evidence = outcome.deliverable!.verification_results;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.command).toBe("node --version");
    expect(evidence[0]!.passed).toBe(true);
  });

  it("drops a claimed verification that carries no command", async () => {
    // The fixture emits one verification with no `command`. An unauditable, unreproducible
    // claim is not evidence, and letting it through would let a task reach DONE on a
    // fabricated check.
    const outcome = await delegate("ok");
    expect(outcome.deliverable!.verification_results.map((v) => v.command)).toEqual(["node --version"]);
  });

  it("degrades to PARTIAL when the runtime returns no structured block", async () => {
    const outcome = await delegate("unstructured");
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    expect(outcome.deliverable?.remaining_risks).toContain("no verification evidence was produced");
    expect(cp.tasks.get(outcome.task_id).state).toBe("BLOCKED");
  });

  it("rejects checks claimed only in the summary or verification_performed strings", async () => {
    const outcome = await delegate("summaryonly");
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    expect(outcome.deliverable?.summary).toContain("runtime info collected");
    expect(outcome.deliverable?.verification_performed).toEqual([]);
    expect(outcome.deliverable?.verification_results).toEqual([]);
    expect(cp.tasks.get(outcome.task_id).state).toBe("BLOCKED");
  });

  it("keeps mixed structured evidence but leaves the task PARTIAL/BLOCKED", async () => {
    const outcome = await delegate("mixed");
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    expect(outcome.deliverable?.verification_results.map((item) => item.passed)).toEqual([
      true,
      false,
    ]);
    expect(outcome.deliverable?.remaining_risks).toContain(
      "1 structured verification check(s) failed",
    );
    expect(cp.tasks.get(outcome.task_id).state).toBe("BLOCKED");
  });

  it("preserves a large verified report as a durable artifact and reaches DONE", async () => {
    const outcome = await delegate("large");
    expect(outcome.error).toBeNull();
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
    expect(outcome.deliverable?.summary.length).toBeLessThanOrEqual(4_000);
    expect(outcome.deliverable?.artifacts.length).toBeGreaterThan(0);

    const recovered = outcome.deliverable!.artifacts
      .map((artifactId) => cp.artifacts.read(artifactId))
      .join("");
    expect(recovered).toContain("AUDIT_EVIDENCE_".repeat(900));
    expect(recovered).toContain("FULL_REPORT_END");
    expect(Buffer.byteLength(recovered, "utf8")).toBeGreaterThan(8_000);
    expect(cp.tasks.get(outcome.task_id).state).toBe("DONE");
  });

  it("tolerates non-JSON noise on the runtime's stdout", async () => {
    const outcome = await delegate("noisy");
    expect(outcome.error).toBeNull();
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 3: persist the real session id as soon as it exists
 * ------------------------------------------------------------------ */

describe("session handle persistence", () => {
  it("persists the runtime's session id from the first stream frame", async () => {
    const outcome = await delegate("ok");
    const attempt = cp.attempts.get(outcome.task_id, 0);
    expect(attempt?.execution_handle).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("persists the session id even when the run then fails", async () => {
    // The whole point of saving early: a run that dies must still leave something to
    // resume from. `error` mode emits init (with the id) and then an is_error result.
    const outcome = await delegate("error");
    const attempt = cp.attempts.get(outcome.task_id, 0);
    expect(attempt?.execution_handle).toBe("11111111-2222-4333-8444-555555555555");
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
  });

  it("persists the session id when the runtime is killed mid-run", async () => {
    // `hang` emits init then never finishes; the deadline terminates it. The handle must
    // already be in the database.
    const outcome = await delegate("hang", {}, 1_500);
    const attempt = cp.attempts.get(outcome.task_id, 0);
    expect(attempt?.execution_handle).toBe("11111111-2222-4333-8444-555555555555");
  }, 30_000);

  it("records the handle length in the event log, never the handle", async () => {
    const outcome = await delegate("ok");
    const events = cp.events({ task_id: outcome.task_id, types: ["attempt.handle_set"] });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload)).not.toContain("11111111");
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 4: resumption
 * ------------------------------------------------------------------ */

describe("session resumption", () => {
  it("passes --resume with the previous attempt's session id", async () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.attempts.saveHandle(task.task_id, 0, "claude", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    const adapter = new ClaudeAdapter({ runner: fixtureRunner("ok"), agent: "claude" });
    cp.adapters.register(adapter);

    // Attempt 1 must see attempt 0's handle and hand it to the CLI.
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: "WORKING" });
    const lease = cp.leases.acquire({
      task_id: task.task_id,
      holder: "claude",
      scope: SCOPE,
      ttl_ms: 60_000,
    });

    const ctxHandles: string[] = [];
    await adapter.invoke(
      {
        task_id: task.task_id,
        spec: spec({ max_turns: CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS }),
        inputs: [],
        workspace_root: workspace,
        lease_id: lease.lease_id,
        deadline_at: Date.now() + 20_000,
        attempt: 1,
        idempotency_key: `${task.task_id}:1`,
        previous_execution_handle: cp.attempts.previousHandle(task.task_id, 1),
        resume_required: true,
      },
      {
        report: async () => {},
        publishArtifact: async () => "art_0000000000",
        recordVerification: async () => {},
        raiseBlocker: async () => {},
        saveExecutionHandle: async (h) => {
          ctxHandles.push(h);
        },
        signal: new AbortController().signal,
      },
    );

    const { args } = readArgv();
    const resumeIdx = args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(args[args.indexOf("--model") + 1]).toBe(CLAUDE_REQUESTED_MODEL);
    expect(args[args.indexOf("--effort") + 1]).toBe(CLAUDE_REQUESTED_EFFORT);
    expect(args[args.indexOf("--max-turns") + 1]).toBe(
      String(CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS),
    );

    // And the resumed session reports the same id back, which is what gets persisted.
    expect(ctxHandles).toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("tells the runtime it is resuming, so it does not restart finished work", () => {
    const invocation = {
      task_id: "task_aaaaaaaaaa",
      spec: spec(),
      inputs: [],
      workspace_root: workspace,
      lease_id: "lease_aaaaaaaaaa",
      deadline_at: Date.now() + 1000,
      attempt: 1,
      idempotency_key: "k",
      previous_execution_handle: "prev-session",
    };
    expect(buildPrompt(invocation as never, true)).toContain("resuming");
    expect(buildPrompt(invocation as never, false)).not.toContain("resuming");
  });

  it("starts cold when resumption is disabled", async () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.attempts.saveHandle(task.task_id, 0, "claude", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const r = fixtureRunner("ok", { allowResume: false });
    const built = r.buildArgs(
      {
        task_id: task.task_id,
        spec: spec(),
        inputs: [],
        workspace_root: workspace,
        lease_id: "lease_x",
        deadline_at: Date.now() + 1000,
        attempt: 1,
        idempotency_key: "k",
        previous_execution_handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      } as never,
      "prompt",
    );
    expect(built).not.toContain("--resume");
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 5: bounding
 * ------------------------------------------------------------------ */

describe("execution bounding", () => {
  it("runs in the task workspace, not the launcher's cwd", async () => {
    await delegate("ok");
    // realpath differences on macOS temp dirs make an exact compare brittle.
    expect(readArgv().cwd).toContain("claude-runner-");
  });

  it("passes the protected profile, turn ceiling, and non-interactive permission mode", async () => {
    await delegate("ok");
    const { args } = readArgv();
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("4");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("-p");
  });

  it("does not accept a manager-supplied model or effort from the task contract", () => {
    const r = fixtureRunner("ok");
    const untrustedSpec = { ...spec(), model: "sonnet", effort: "low" } as TaskSpec;
    const args = r.buildArgs(invocationFor({ spec: untrustedSpec }), "prompt");

    expect(args[args.indexOf("--model") + 1]).toBe(CLAUDE_REQUESTED_MODEL);
    expect(args[args.indexOf("--effort") + 1]).toBe(CLAUDE_REQUESTED_EFFORT);
    expect(args).not.toContain("sonnet");
    expect(args).not.toContain("low");
  });

  it("refuses extra arguments that could replace the protected profile or turn ceiling", () => {
    for (const protectedArg of ["--model=sonnet", "--effort", "--max-turns"]) {
      expect(() => new ClaudeCodeRunner({ extraArgs: [protectedArg] })).toThrow(/cannot override/);
    }
  });

  it("keeps a conservative finite default and permits an explicitly bounded audit budget", () => {
    const defaultRunner = new ClaudeCodeRunner();
    const defaultArgs = defaultRunner.buildArgs(invocationFor(), "prompt");
    expect(defaultArgs[defaultArgs.indexOf("--max-turns") + 1]).toBe(
      String(DEFAULT_TASK_MAX_TURNS),
    );

    const auditArgs = defaultRunner.buildArgs(
      invocationFor({ spec: spec({ max_turns: CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS }) }),
      "prompt",
    );
    expect(auditArgs[auditArgs.indexOf("--max-turns") + 1]).toBe(
      String(CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS),
    );
    expect(CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS).toBeLessThanOrEqual(MAX_TASK_MAX_TURNS);
  });

  it("rejects invalid or excessive turn budgets instead of removing the hard limit", () => {
    const r = new ClaudeCodeRunner();
    for (const max_turns of [0, MAX_TASK_MAX_TURNS + 1, 1.5]) {
      expect(() =>
        r.buildArgs(invocationFor({ spec: spec({ max_turns }) }), "prompt"),
      ).toThrow(/must be an integer/);
    }
    expect(() => new ClaudeCodeRunner({ maxTurns: MAX_TASK_MAX_TURNS + 1 })).toThrow(
      /must be an integer/,
    );
  });

  it("grants tool access only to the leased scope directories", async () => {
    await delegate("ok");
    const { args } = readArgv();
    const dirs = args.reduce<string[]>((acc, a, i) => (a === "--add-dir" ? [...acc, args[i + 1]!] : acc), []);
    // `claude/**` -> `claude`, `docs/*.md` -> `docs`; nothing outside the lease.
    expect(dirs.sort()).toEqual(["claude", "docs"]);
  });

  it("embeds the task contract in the prompt, not free text", async () => {
    await delegate("ok");
    const { args } = readArgv();
    const prompt = args[args.indexOf("-p") + 1]!;
    expect(prompt).toContain("report runtime information without modifying any source");
    expect(prompt).toContain("node --version runs");
    expect(prompt).toContain("claude/**");
    expect(prompt).toContain("Do not ask interactive questions");
  });

  it("terminates a hung runtime at the deadline instead of running forever", async () => {
    const started = Date.now();
    const outcome = await delegate("hang", {}, 1_500);
    const elapsed = Date.now() - started;

    // Bounded: the child is killed rather than inheriting the test timeout.
    expect(elapsed).toBeLessThan(20_000);

    // The orchestrator owns the deadline and reports TIMEOUT for the delegation. The
    // adapter's PARTIAL is superseded by that error — a run that blew its budget did not
    // deliver, and reporting a deliverable would suggest otherwise.
    expect(outcome.error?.code).toBe(ErrorCode.TIMEOUT);
    expect(cp.tasks.get(outcome.task_id).state).toBe("FAILED");

    // What must survive is the resumable pointer and a released lease, so the next
    // attempt can pick the session back up and the scope is not stranded.
    expect(cp.attempts.get(outcome.task_id, 0)?.execution_handle).toBeTruthy();
    expect(cp.leases.listLive()).toHaveLength(0);
  }, 30_000);

  it("stops the runtime when the invocation is cancelled", async () => {
    const adapter = new ClaudeAdapter({ runner: fixtureRunner("hang"), agent: "claude" });
    const controller = new AbortController();
    const task = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.tasks.claim(task.task_id, "claude");

    const invocation = {
      task_id: task.task_id,
      spec: spec(),
      inputs: [],
      workspace_root: workspace,
      lease_id: "lease_x",
      deadline_at: Date.now() + 60_000,
      attempt: 0,
      idempotency_key: "k",
      previous_execution_handle: null,
    };

    const pending = adapter.invoke(invocation as never, {
      report: async () => {},
      publishArtifact: async () => "art_0000000000",
      recordVerification: async () => {},
      raiseBlocker: async () => {},
      saveExecutionHandle: async () => {},
      signal: controller.signal,
    });

    // Cancel once the child is definitely up (it has emitted its init frame by now).
    setTimeout(() => controller.abort(), 500);
    const deliverable = await pending;

    expect(deliverable.status).toBe(DeliverableStatus.PARTIAL);
    expect(deliverable.summary.toLowerCase()).toContain("cancel");
  }, 30_000);

  it("refuses to fabricate success when the runtime never returns a result frame", async () => {
    const outcome = await delegate("noresult");
    expect(outcome.error?.code).toBe(ErrorCode.ADAPTER_FAILURE);
    expect(outcome.error?.message).toMatch(/no result frame/);
  });

  it("maps a runtime error frame to PARTIAL with the reason preserved", async () => {
    const outcome = await delegate("error");
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    expect(outcome.deliverable?.summary).toContain("Not logged in");
    // This is exactly what an unauthenticated real CLI produces, so the shape is verified.
    expect(outcome.deliverable?.remaining_risks.join(" ")).toMatch(/authenticated|abnormally/);
  });
});

/* ------------------------------------------------------------------ *
 * Structured output parsing
 * ------------------------------------------------------------------ */

describe("parseStructuredOutput", () => {
  it("reads the last fenced JSON block, ignoring earlier illustrative ones", () => {
    const text = [
      "Here is an example of what I might return:",
      "```json",
      '{"summary":"not the real one"}',
      "```",
      "And here is the actual result:",
      "```json",
      '{"summary":"the real one"}',
      "```",
    ].join("\n");
    expect(parseStructuredOutput(text)?.summary).toBe("the real one");
  });

  it("falls back to an unfenced trailing object", () => {
    expect(parseStructuredOutput('done\n{"summary":"bare"}')?.summary).toBe("bare");
  });

  it("returns null for genuinely unstructured prose", () => {
    expect(parseStructuredOutput("I looked at the repo and everything seems fine.")).toBeNull();
  });

  it("returns null rather than throwing on malformed JSON", () => {
    expect(parseStructuredOutput("```json\n{not valid}\n```")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Telemetry: token normalization
 * ------------------------------------------------------------------ */

describe("normalizeClaudeUsage", () => {
  // The numbers below are the ones the real 2.1.226 binary reported for a one-word prompt.
  const REAL_USAGE = {
    input_tokens: 2,
    cache_creation_input_tokens: 8140,
    cache_read_input_tokens: 12424,
    output_tokens: 9,
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 8140, ephemeral_5m_input_tokens: 0 },
  };

  it("counts every input category, not just the uncached one", () => {
    const usage = normalizeClaudeUsage(REAL_USAGE);
    // 2 + 12424 + 8140. Reading `input_tokens` alone would report 2 — a 10,000x error that
    // would make Claude look almost free next to an uncached runtime.
    expect(usage.input_tokens).toBe(20_566);
    expect(usage.output_tokens).toBe(9);
  });

  it("keeps the cache dimensions as subdimensions of the input total", () => {
    const usage = normalizeClaudeUsage(REAL_USAGE);
    expect(usage.cached_input_tokens).toBe(12_424);
    expect(usage.cache_creation_input_tokens).toBe(8_140);
    // Subdimensions, not addends: they are already inside `input_tokens`.
    expect(usage.cached_input_tokens! + usage.cache_creation_input_tokens!).toBeLessThan(
      usage.input_tokens!,
    );
  });

  it("makes the total equal its own parts", () => {
    const usage = normalizeClaudeUsage(REAL_USAGE);
    expect(usage.total_tokens).toBe(usage.input_tokens! + usage.output_tokens!);
    expect(usage.total_tokens).toBe(20_575);
  });

  it("falls back to the per-TTL cache map when the flat field is absent", () => {
    const usage = normalizeClaudeUsage({
      input_tokens: 5,
      cache_read_input_tokens: 10,
      output_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 },
    });
    expect(usage.cache_creation_input_tokens).toBe(10);
    expect(usage.input_tokens).toBe(25);
  });

  it("reports null rather than zero when a category is simply absent", () => {
    const usage = normalizeClaudeUsage({ input_tokens: 4, output_tokens: 2 });
    expect(usage.input_tokens).toBe(4);
    expect(usage.cached_input_tokens).toBeNull();
    expect(usage.cache_creation_input_tokens).toBeNull();
    expect(usage.total_tokens).toBe(6);
  });

  it("degrades to all-null for missing, null, or non-numeric usage", () => {
    for (const bad of [undefined, null, "usage", 42, [], { input_tokens: "many" }]) {
      const usage = normalizeClaudeUsage(bad);
      expect(usage.input_tokens).toBeNull();
      expect(usage.output_tokens).toBeNull();
      expect(usage.total_tokens).toBeNull();
    }
  });

  it("has no total when only one side of it is known", () => {
    expect(normalizeClaudeUsage({ input_tokens: 4 }).total_tokens).toBeNull();
    expect(normalizeClaudeUsage({ output_tokens: 4 }).total_tokens).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Telemetry: result-frame mapping
 * ------------------------------------------------------------------ */

describe("buildRunnerTelemetry", () => {
  const base: BuildRunnerTelemetryInput = {
    frame: null,
    runtime_version: "2.1.226",
    model: "claude-opus-5",
    started_at: 1_000,
    first_output_at: 1_400,
    ended_at: 3_000,
    prompt_bytes: 512,
    exit_code: 0,
    exit_signal: null,
    cancelled: false,
    timed_out: false,
  };
  const frame = {
    type: "result" as const,
    subtype: "success",
    session_id: "11111111-2222-4333-8444-555555555555",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.088442,
    duration_ms: 1740,
    duration_api_ms: 2412,
    usage: { input_tokens: 2, cache_read_input_tokens: 12_424, cache_creation_input_tokens: 8_140, output_tokens: 9 },
  };

  it("maps the durations, turn count, cost, and exit code the runtime reported", () => {
    const t = buildRunnerTelemetry({ ...base, frame });
    expect(t.runtime).toBe("claude-code");
    expect(t.runtime_version).toBe("2.1.226");
    expect(t.model).toBe("claude-opus-5");
    expect(t.runtime_duration_ms).toBe(1740);
    expect(t.api_duration_ms).toBe(2412);
    expect(t.turn_count).toBe(2);
    expect(t.reported_cost_usd).toBe(0.088442);
    expect(t.process_exit_code).toBe(0);
    expect(t.prompt_bytes).toBe(512);
    expect(t.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
  });

  it("never claims to know the billing mode behind a reported cost", () => {
    const t = buildRunnerTelemetry({ ...base, frame });
    // The CLI computes an API-price equivalent; a subscription run is billed differently
    // and the frame does not say which applied.
    expect(t.cost_semantics).toBe(TelemetryCostSemantics.RUNTIME_REPORTED);
    expect(t.billing_mode_known).toBe(false);
  });

  it("marks cost unavailable when the runtime reported none", () => {
    const t = buildRunnerTelemetry({ ...base, frame: { ...frame, total_cost_usd: undefined } });
    expect(t.reported_cost_usd).toBeNull();
    expect(t.cost_semantics).toBe(TelemetryCostSemantics.UNAVAILABLE);
    expect(t.billing_mode_known).toBe(false);
  });

  it("tolerates a frame whose optional metadata is missing or null", () => {
    const t = buildRunnerTelemetry({
      ...base,
      runtime_version: null,
      model: null,
      frame: {
        type: "result",
        session_id: "s",
        is_error: false,
        num_turns: undefined,
        total_cost_usd: undefined,
        duration_ms: undefined,
        duration_api_ms: undefined,
        usage: undefined,
      },
    });
    expect(t.runtime_version).toBeNull();
    expect(t.model).toBeNull();
    expect(t.turn_count).toBeNull();
    expect(t.api_duration_ms).toBeNull();
    expect(t.usage.input_tokens).toBeNull();
    expect(t.usage.total_tokens).toBeNull();
    // Measured rather than reported: the wall time is still a real observation.
    expect(t.runtime_duration_ms).toBe(2000);
    expect(t.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
  });

  it("falls back to the api duration, then to measured wall time", () => {
    expect(
      buildRunnerTelemetry({ ...base, frame: { ...frame, duration_ms: undefined } })
        .runtime_duration_ms,
    ).toBe(2412);
    expect(
      buildRunnerTelemetry({
        ...base,
        frame: { ...frame, duration_ms: undefined, duration_api_ms: undefined },
      }).runtime_duration_ms,
    ).toBe(2000);
  });

  it("names the model from the usage breakdown when only one model ran", () => {
    const one = buildRunnerTelemetry({
      ...base,
      model: null,
      frame: { ...frame, modelUsage: { "claude-opus-5": { inputTokens: 2 } } },
    });
    expect(one.model).toBe("claude-opus-5");

    // Two models means helper models were involved; picking one would be a guess.
    const two = buildRunnerTelemetry({
      ...base,
      model: null,
      frame: { ...frame, modelUsage: { "claude-opus-5": {}, "claude-haiku-4-5": {} } },
    });
    expect(two.model).toBeNull();
  });

  it("distinguishes the ways an attempt can end", () => {
    const kind = (over: Partial<BuildRunnerTelemetryInput>): AttemptTerminationKind =>
      buildRunnerTelemetry({ ...base, frame, ...over }).termination_kind;

    expect(kind({ frame: { ...frame, is_error: true } })).toBe(AttemptTerminationKind.FAILED);
    // Stopped cleanly at the turn ceiling, but the task is not done.
    expect(kind({ frame: { ...frame, subtype: "error_max_turns" } })).toBe(
      AttemptTerminationKind.FAILED,
    );
    expect(kind({ frame: null, exit_code: 3 })).toBe(AttemptTerminationKind.FAILED);
    expect(kind({ frame: null, exit_code: null, exit_signal: "SIGSEGV" })).toBe(
      AttemptTerminationKind.CRASH,
    );
    // A run the bridge itself stopped is not a crash, however the child died.
    expect(kind({ frame: null, exit_signal: "SIGKILL", cancelled: true })).toBe(
      AttemptTerminationKind.CANCELLED,
    );
    expect(kind({ frame: null, exit_signal: "SIGKILL", timed_out: true })).toBe(
      AttemptTerminationKind.TIMEOUT,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Telemetry: end to end through a real subprocess
 * ------------------------------------------------------------------ */

describe("telemetry from a real Claude Code stream", () => {
  it("reports the runtime's own numbers, parsed from the result frame", async () => {
    const { telemetry, invocation } = await runCapturing("ok");

    expect(telemetry).toHaveLength(1);
    const t = telemetry[0]!;
    expect(t.runtime).toBe("claude-code");
    expect(t.runtime_version).toBe("2.1.222");
    expect(t.requested_model).toBe("opus");
    expect(t.requested_effort).toBe("high");
    expect(t.model).toBe("claude-opus-5");
    expect(t.input_tokens).toBe(20_566);
    expect(t.output_tokens).toBe(9);
    expect(t.cached_input_tokens).toBe(12_424);
    expect(t.cache_creation_input_tokens).toBe(8_140);
    expect(t.total_tokens).toBe(20_575);
    expect(t.turn_count).toBe(2);
    expect(t.runtime_duration_ms).toBe(1740);
    expect(t.reported_cost_usd).toBeCloseTo(0.088442, 6);
    expect(t.cost_semantics).toBe(TelemetryCostSemantics.RUNTIME_REPORTED);
    expect(t.billing_mode_known).toBe(false);
    expect(t.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
    expect(t.process_exit_code).toBe(0);
    // The prompt is measured, not carried: bytes of the contract the runtime received.
    expect(t.prompt_bytes).toBe(Buffer.byteLength(buildPrompt(invocation, false), "utf8"));
  });

  it("times the run from the process, not from the model's account of it", async () => {
    const { telemetry } = await runCapturing("ok");
    const t = telemetry[0]!;
    expect(t.runtime_started_at).toBeGreaterThan(0);
    expect(t.runtime_ended_at).toBeGreaterThanOrEqual(t.runtime_started_at!);
    // First output is the first model frame, which cannot precede the spawn.
    expect(t.first_output_at).toBeGreaterThanOrEqual(t.runtime_started_at!);
    expect(t.first_output_at).toBeLessThanOrEqual(t.runtime_ended_at!);
  });

  it("reports nulls, not zeros, when the runtime omits its optional metadata", async () => {
    const { telemetry } = await runCapturing("sparse");
    const t = telemetry[0]!;
    expect(t.input_tokens).toBeNull();
    expect(t.output_tokens).toBeNull();
    expect(t.total_tokens).toBeNull();
    expect(t.cached_input_tokens).toBeNull();
    expect(t.turn_count).toBeNull();
    expect(t.reported_cost_usd).toBeNull();
    expect(t.cost_semantics).toBe(TelemetryCostSemantics.UNAVAILABLE);
    // What is still knowable stays populated.
    expect(t.process_exit_code).toBe(0);
    expect(t.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
    expect(t.runtime_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps requested profile evidence but does not invent a missing actual model", async () => {
    const { telemetry, error } = await runCapturing("nomodel");
    expect(error).toBeUndefined();
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      requested_model: CLAUDE_REQUESTED_MODEL,
      requested_effort: CLAUDE_REQUESTED_EFFORT,
      model: null,
    });
  });

  it("rejects a runtime-reported non-Opus model as an explicit profile mismatch", async () => {
    const outcome = await delegate("wrongmodel");
    expect(outcome.deliverable).toBeNull();
    expect(outcome.error?.code).toBe(ErrorCode.RUNTIME_PROFILE_MISMATCH);
    expect(outcome.error?.message).toMatch(/profile mismatch/i);

    const [telemetry] = cp.attempts.queryTelemetry({ task_id: outcome.task_id });
    expect(telemetry).toMatchObject({
      requested_model: CLAUDE_REQUESTED_MODEL,
      requested_effort: CLAUDE_REQUESTED_EFFORT,
      model: "claude-sonnet-4-5",
      termination_kind: AttemptTerminationKind.FAILED,
    });
  });

  it("records a max-turns stop as a failed attempt that still cost tokens", async () => {
    const { telemetry } = await runCapturing("maxturns");
    const t = telemetry[0]!;
    expect(t.termination_kind).toBe(AttemptTerminationKind.FAILED);
    expect(t.input_tokens).toBe(20_566);
    expect(t.turn_count).toBe(4);
  });

  it("reports the runtime's error result as a failed attempt", async () => {
    const { telemetry } = await runCapturing("error");
    const t = telemetry[0]!;
    expect(t.termination_kind).toBe(AttemptTerminationKind.FAILED);
    expect(t.process_exit_code).toBe(0);
    expect(t.turn_count).toBe(1);
  });

  it("still reports telemetry for a run that produced no result frame", async () => {
    // This is the attempt most likely to be lost: the runner throws, so there is no result
    // object to carry telemetry, yet the attempt consumed a real process and real time.
    const { telemetry, error } = await runCapturing("noresult");
    expect((error as { code?: string }).code).toBe(ErrorCode.ADAPTER_FAILURE);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.termination_kind).toBe(AttemptTerminationKind.FAILED);
    expect(telemetry[0]!.process_exit_code).toBe(3);
    expect(telemetry[0]!.input_tokens).toBeNull();
  });

  it("reports telemetry for a resumed session, keyed to the same task", async () => {
    const handle = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { telemetry, handles, invocation } = await runCapturing(
      "ok",
      {},
      { attempt: 1, previous_execution_handle: handle },
    );

    // The fixture echoes back the resumed session id, so this really is the resumed run.
    expect(handles).toContain(handle);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.input_tokens).toBe(20_566);
    expect(telemetry[0]!.termination_kind).toBe(AttemptTerminationKind.COMPLETED);
    // A resumed run is prompted differently, and the byte count must reflect that.
    expect(telemetry[0]!.prompt_bytes).toBe(
      Buffer.byteLength(buildPrompt(invocation, true), "utf8"),
    );
  });

  it("carries no session id, prompt text, or runtime output", async () => {
    const { telemetry } = await runCapturing("ok");
    const serialized = JSON.stringify(telemetry[0]);
    expect(serialized).not.toContain("11111111-2222-4333-8444-555555555555");
    expect(serialized).not.toContain("report runtime information");
    expect(serialized).not.toContain("runtime info collected");
  });
});

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

describe("runtime health", () => {
  it("reports ready when the binary answers --version", async () => {
    const r = new ClaudeCodeRunner({ command: process.execPath, extraArgs: [] });
    // node --version succeeds, standing in for a present, working CLI.
    const health = await r.probe();
    expect(health.ok).toBe(true);
  });

  it("reports unavailable rather than throwing when the binary is missing", async () => {
    const r = new ClaudeCodeRunner({ command: "definitely-not-a-real-binary-xyz" });
    const health = await r.probe();
    expect(health.ok).toBe(false);
  });
});

describe("Opus family verification", () => {
  it("accepts aliases and versioned Opus identifiers but not adjacent family names", () => {
    expect(isOpusFamilyModel("opus")).toBe(true);
    expect(isOpusFamilyModel("claude-opus-5")).toBe(true);
    expect(isOpusFamilyModel("claude-3-opus-20240229")).toBe(true);
    expect(isOpusFamilyModel("claude-sonnet-4-5")).toBe(false);
    expect(isOpusFamilyModel("superopus-preview")).toBe(false);
  });
});
