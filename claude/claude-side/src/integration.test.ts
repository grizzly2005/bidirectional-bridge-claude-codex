/**
 * End-to-end: the two behaviours the bridge exists to provide.
 *
 *  1. Claude delegates a bounded task to Codex, gets a structured deliverable back, and
 *     the write scope is free again afterwards.
 *  2. Claude and Codex work concurrently without stepping on each other, and an attempt
 *     to cross into the other's scope is refused rather than silently allowed.
 *
 * Codex is represented by `MockCodexAdapter` — the real adapter is codex's to write.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlane,
  ManualClock,
  Orchestrator,
} from "@bridge/control-plane";
import {
  BridgeError,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  seededRandom,
  type TaskSpec,
} from "@bridge/protocol";
import { MockCodexAdapter, failingCheck, passingCheck } from "./adapters/mock-codex-adapter.js";
import { ClaudeAdapter, functionRunner } from "./adapters/claude-adapter.js";
import { ClaudeWorkSession } from "./work-session.js";


const CODEX_SCOPE = { paths: ["codex/**"] };
const CLAUDE_SCOPE = { paths: ["claude/**", "shared/**"] };

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    objective: "implement the codex adapter",
    scope: CODEX_SCOPE,
    dependencies: [],
    expected_deliverable: "an adapter module plus tests",
    verification_criteria: ["npm test passes"],
    ...overrides,
  };
}

let cp: ControlPlane;
let clock: ManualClock;
let orchestrator: Orchestrator;

beforeEach(() => {
  clock = new ManualClock();
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-integration",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(99),
  });
  orchestrator = new Orchestrator(cp);
});

describe("claude delegates to codex", () => {
  it("returns a structured deliverable and releases the scope", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [
          {
            artifacts: [{ name: "adapter-notes.md", content: "# how the adapter works" }],
            verifications: [passingCheck("test", "npm test -w @bridge/codex-side")],
          },
        ],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.error).toBeNull();
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
    expect(outcome.deliverable?.artifacts).toHaveLength(1);
    expect(cp.tasks.get(outcome.task_id).state).toBe(TaskState.DONE);

    // The lease must be gone, or claude could never touch codex/** again.
    expect(cp.leases.listLive()).toHaveLength(0);
  });

  it("passes inputs as artifacts, not conversation history", async () => {
    const adapter = new MockCodexAdapter({ now: () => clock.now(), sleep: (ms) => clock.sleep(ms) });
    cp.adapters.register(adapter);

    const seed = cp.tasks.create({ spec: spec({ scope: CLAUDE_SCOPE }), created_by: "claude" });
    const input = cp.artifacts.publish({
      task_id: seed.task_id,
      produced_by: "claude",
      kind: "report",
      name: "interface-contract.md",
      inline: "AgentAdapter { invoke(...) }",
    });

    await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [input.artifact_id],
      deadline_ms: 60_000,
    });

    const received = adapter.invocations[0]!;
    expect(received.inputs).toHaveLength(1);
    expect(received.inputs[0]!.inline).toContain("AgentAdapter");
    expect(received.lease_id).toBeTruthy();
    expect(received.deadline_at).toBe(clock.now() + 60_000);
  });

  it("records a blocker and returns PARTIAL instead of looping for clarification", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [{ blocker: "protocol change needed in shared/protocol, which claude owns" }],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    const task = cp.tasks.get(outcome.task_id);
    expect(task.state).toBe(TaskState.BLOCKED);
    expect(task.blockers[0]).toContain("protocol change needed");
    expect(cp.leases.listLive()).toHaveLength(0);
  });

  it("refuses to mark a task DONE when the delegate's checks failed", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [{ verifications: [failingCheck("test", "npm test")] }],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.error?.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(cp.tasks.get(outcome.task_id).state).toBe(TaskState.FAILED);
  });

  it("retries a retryable failure up to the budget, then stops", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [
          { throwError: { code: ErrorCode.INTERNAL, message: "transient crash" } },
          { verifications: [passingCheck("test", "npm test")] },
        ],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
      max_attempts: 1,
    });

    expect(outcome.attempts).toBe(2);
    expect(outcome.deliverable?.status).toBe(DeliverableStatus.COMPLETE);
  });

  it("does not retry a non-retryable failure", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [{ throwError: { code: ErrorCode.INVALID_ARGUMENT, message: "bad spec" } }],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
      max_attempts: 3,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.error?.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it("fails fast when no adapter is registered for the target agent", async () => {
    await expect(
      orchestrator.delegate({
        from: "claude",
        to: "codex",
        spec: spec(),
        input_artifacts: [],
        deadline_ms: 1000,
      }),
    ).rejects.toThrow(/no adapter registered/);
  });

  it("leaves a full audit trail an external supervisor can replay", async () => {
    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [
          {
            artifacts: [{ name: "out.md", content: "done" }],
            verifications: [passingCheck("test", "npm test")],
          },
        ],
      }),
    );

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    const types = cp.events({ task_id: outcome.task_id }).map((e) => e.type);
    expect(types).toContain("delegation.requested");
    expect(types).toContain("lease.acquired");
    expect(types).toContain("status.reported");
    expect(types).toContain("artifact.published");
    expect(types).toContain("verification.recorded");
    expect(types).toContain("deliverable.submitted");
    expect(types).toContain("lease.released");
    expect(types).toContain("delegation.completed");
  });
});

describe("concurrent work without collisions", () => {
  it("lets both agents hold disjoint scopes at the same time", async () => {
    const claudeSession = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const claudeTask = claudeSession.declareTask(spec({ scope: CLAUDE_SCOPE, objective: "protocol work" }));
    claudeSession.beginWork(claudeTask.task_id);

    cp.adapters.register(
      new MockCodexAdapter({
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        script: [{ verifications: [passingCheck("test", "npm test")] }],
      }),
    );

    // Codex works in codex/** while claude still holds claude/** + shared/**.
    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec(),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.error).toBeNull();
    expect(cp.tasks.get(claudeTask.task_id).state).toBe(TaskState.WORKING);
  });

  it("refuses a delegation into a scope claude is actively holding", async () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const held = session.declareTask(spec({ scope: { paths: ["shared/protocol/**"] } }));
    session.beginWork(held.task_id);

    cp.adapters.register(new MockCodexAdapter({ now: () => clock.now(), sleep: (ms) => clock.sleep(ms) }));

    const outcome = await orchestrator.delegate({
      from: "claude",
      to: "codex",
      spec: spec({ scope: { paths: ["shared/protocol/src/adapter.ts"] } }),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.error?.code).toBe(ErrorCode.SCOPE_CONFLICT);
  });

  it("tells claude who owns a path before it writes", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const t = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.tasks.claim(t.task_id, "codex");
    cp.leases.acquire({ task_id: t.task_id, holder: "codex", scope: CODEX_SCOPE, ttl_ms: 60_000 });

    expect(session.whoOwns("codex/codex-side/src/adapter.ts")[0]?.holder).toBe("codex");
    expect(session.whoOwns("claude/control-plane/src/x.ts")).toHaveLength(0);
  });

  it("hides work from availableWork when its scope is already leased by the other agent", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const contested = cp.tasks.create({ spec: spec(), created_by: "claude" });
    expect(session.availableWork().map((t) => t.task_id)).toContain(contested.task_id);

    const codexTask = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.tasks.claim(codexTask.task_id, "codex");
    cp.leases.acquire({ task_id: codexTask.task_id, holder: "codex", scope: CODEX_SCOPE, ttl_ms: 60_000 });

    expect(session.availableWork().map((t) => t.task_id)).not.toContain(contested.task_id);
  });
});

describe("ClaudeWorkSession", () => {
  it("rolls the claim back when the lease cannot be taken", () => {
    const codexTask = cp.tasks.create({ spec: spec(), created_by: "codex" });
    cp.tasks.claim(codexTask.task_id, "codex");
    cp.leases.acquire({ task_id: codexTask.task_id, holder: "codex", scope: CODEX_SCOPE, ttl_ms: 60_000 });

    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const contested = session.declareTask(spec());

    expect(() => session.beginWork(contested.task_id)).toThrow(/conflict/i);
    // Left owned-but-unstartable, codex would think claude is working on it.
    expect(cp.tasks.get(contested.task_id).owner).toBeNull();
  });

  it("enforces the lease on every write it is asked about", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const task = session.declareTask(spec({ scope: CLAUDE_SCOPE }));
    session.beginWork(task.task_id);

    expect(() => session.assertCanWrite(task.task_id, "claude/control-plane/src/x.ts")).not.toThrow();
    expect(() => session.assertCanWrite(task.task_id, "codex/adapter.ts")).toThrow(/outside the leased scope/);
  });

  it("releases the lease even when the deliverable is rejected", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const task = session.declareTask(spec({ scope: CLAUDE_SCOPE }));
    session.beginWork(task.task_id);

    expect(() =>
      session.complete(task.task_id, { summary: "no evidence", status: DeliverableStatus.COMPLETE }),
    ).toThrow(/no passing verification/);
    expect(cp.leases.listLive()).toHaveLength(0);
  });

  it("completes cleanly with real evidence and frees the scope", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const task = session.declareTask(spec({ scope: CLAUDE_SCOPE }));
    session.beginWork(task.task_id);
    session.publishArtifact(task.task_id, "notes.md", "what changed");
    session.recordVerification(task.task_id, passingCheck("typecheck", "tsc --build"));

    const deliverable = session.complete(task.task_id, { summary: "protocol landed" });
    expect(deliverable.status).toBe(DeliverableStatus.COMPLETE);
    expect(cp.tasks.get(task.task_id).state).toBe(TaskState.DONE);
    expect(cp.leases.listLive()).toHaveLength(0);
  });

  it("files a request to the other agent as a dependency rather than doing its work", () => {
    const session = new ClaudeWorkSession({ controlPlane: cp, agent: "claude" });
    const mine = session.declareTask(spec({ scope: CLAUDE_SCOPE }));
    const requested = session.requestFromAgent(mine.task_id, "codex", spec());

    expect(cp.tasks.get(mine.task_id).spec.dependencies).toContain(requested);
    expect(cp.tasks.get(requested).spec.preferred_agent).toBe("codex");
    // And the dependency actually gates claude's own progress.
    session.beginWork; // (no-op reference; beginWork would fail the dependency gate below)
    cp.tasks.claim(mine.task_id, "claude");
    expect(() =>
      cp.tasks.transition({ task_id: mine.task_id, agent: "claude", to: TaskState.WORKING }),
    ).toThrow(/cannot start/);
  });
});

describe("ClaudeAdapter", () => {
  it("downgrades to PARTIAL when the runner produced no verification evidence", async () => {
    const adapter = new ClaudeAdapter({
      now: () => clock.now(),
      runner: functionRunner("test-runner", async () => ({ summary: "did some work" })),
    });
    cp.adapters.register(adapter);

    const outcome = await orchestrator.delegate({
      from: "codex",
      to: "claude",
      spec: spec({ scope: CLAUDE_SCOPE }),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(outcome.deliverable?.status).toBe(DeliverableStatus.PARTIAL);
    expect(outcome.deliverable?.remaining_risks).toContain("no verification evidence was produced");
  });

  it("reports UNAVAILABLE rather than throwing when the probe fails", async () => {
    const adapter = new ClaudeAdapter({
      now: () => clock.now(),
      runner: functionRunner("broken", async () => ({ summary: "unused" }), {
        probe: async () => {
          throw new Error("session gone");
        },
      }),
    });
    const health = await adapter.health();
    expect(health.status).toBe("UNAVAILABLE");
    expect(health.detail).toContain("session gone");
  });

  it("persists its resumable session id before running, not after", async () => {
    // Saving the handle only on success would make it useless: the one time anyone needs
    // to resume is when the run died partway through.
    const seen: string[] = [];
    const adapter = new ClaudeAdapter({
      now: () => clock.now(),
      runner: functionRunner(
        "session-runner",
        async (invocation) => {
          // By the time the runner body executes, the handle must already be persisted.
          seen.push(...cp.attempts.list(invocation.task_id).map((a) => a.execution_handle ?? ""));
          throw new Error("crashed after the session was registered");
        },
        { sessionId: () => "claude_session_abc" },
      ),
    });
    cp.adapters.register(adapter);

    const outcome = await orchestrator.delegate({
      from: "codex",
      to: "claude",
      spec: spec({ scope: CLAUDE_SCOPE }),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    expect(seen).toContain("claude_session_abc");
    expect(outcome.error).not.toBeNull();
    // And it survives the failed attempt, so a retry can reconnect.
    expect(cp.attempts.get(outcome.task_id, 0)?.execution_handle).toBe("claude_session_abc");
  });

  it("offers the previous attempt's handle to the next attempt", async () => {
    const handlesSeen: Array<string | null | undefined> = [];
    const adapter = new ClaudeAdapter({
      now: () => clock.now(),
      runner: functionRunner(
        "resuming-runner",
        async (invocation) => {
          handlesSeen.push(invocation.previous_execution_handle);
          // INTERNAL is retryable; a bare Error would become ADAPTER_FAILURE, which is not,
          // and the orchestrator would correctly refuse to try again.
          if (invocation.attempt === 0) {
            throw new BridgeError(ErrorCode.INTERNAL, "transient runner fault");
          }
          return {
            summary: "resumed",
            verification_results: [passingCheck("test", "npm test")],
          };
        },
        { sessionId: (invocation) => `claude_session_attempt_${invocation.attempt}` },
      ),
    });
    cp.adapters.register(adapter);

    const outcome = await orchestrator.delegate({
      from: "codex",
      to: "claude",
      spec: spec({ scope: CLAUDE_SCOPE }),
      input_artifacts: [],
      deadline_ms: 60_000,
      max_attempts: 1,
    });

    expect(outcome.attempts).toBe(2);
    expect(handlesSeen[0]).toBeNull();
    expect(handlesSeen[1]).toBe("claude_session_attempt_0");
  });

  it("refuses a credential-shaped execution handle", async () => {
    const rejected: string[] = [];
    const adapter = new ClaudeAdapter({
      now: () => clock.now(),
      runner: functionRunner(
        "leaky-runner",
        async () => ({ summary: "done", verification_results: [passingCheck("test", "npm test")] }),
        { sessionId: () => "sk-ant-abcdefghijklmnopqrstuvwxyz012345" },
      ),
    });
    cp.adapters.register(adapter);

    const outcome = await orchestrator.delegate({
      from: "codex",
      to: "claude",
      spec: spec({ scope: CLAUDE_SCOPE }),
      input_artifacts: [],
      deadline_ms: 60_000,
    });

    // The task still completes — a rejected handle costs resumability, not the work — but
    // the credential never reaches the shared database.
    expect(cp.attempts.get(outcome.task_id, 0)?.execution_handle).toBeNull();
    rejected.push("checked");
    expect(rejected).toHaveLength(1);
  });
});
