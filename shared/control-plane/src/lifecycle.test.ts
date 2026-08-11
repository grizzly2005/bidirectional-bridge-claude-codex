/**
 * Task lifecycle, ownership, and dependency gating.
 *
 * These are the guarantees the CLAUDE.md operating rules depend on: an agent cannot take
 * work another agent owns, cannot start before its dependencies land, and cannot claim
 * completion without evidence.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DeliverableStatus,
  MAX_TASK_MAX_TURNS,
  TaskState,
  canTransition,
  seededRandom,
  type TaskSpec,
} from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    objective: "do a bounded unit of work",
    scope: { paths: ["claude/**"] },
    dependencies: [],
    expected_deliverable: "a report artifact",
    verification_criteria: ["npm test passes"],
    ...overrides,
  };
}

function passing(command = "npm test") {
  return { kind: "test" as const, command, passed: true, exit_code: 0, summary: "3 passed" };
}

let cp: ControlPlane;
let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-test",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(42),
  });
});

describe("task creation", () => {
  it("starts unowned and PENDING", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    expect(task.state).toBe(TaskState.PENDING);
    expect(task.owner).toBeNull();
    expect(task.version).toBe(1);
  });

  it("rejects a spec with no verification criteria", () => {
    expect(() =>
      cp.tasks.create({ spec: spec({ verification_criteria: [] }), created_by: "claude" }),
    ).toThrow(/validation/i);
  });

  it("rejects a malformed task id in dependencies at the schema boundary", () => {
    expect(() =>
      cp.tasks.create({ spec: spec({ dependencies: ["not-a-task-id"] }), created_by: "claude" }),
    ).toThrow(/validation/i);
  });

  it("rejects a well-formed dependency id that refers to no existing task", () => {
    expect(() =>
      cp.tasks.create({ spec: spec({ dependencies: ["task_zzzzzzzzzz"] }), created_by: "claude" }),
    ).toThrow(/does not exist/);
  });

  it("writes a task.created event carrying the full contract", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const events = cp.events({ task_id: task.task_id });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task.created");
    expect(events[0]!.payload["verification_criteria"]).toEqual(["npm test passes"]);
  });

  it("persists an allowed finite turn budget and rejects values outside the contract", () => {
    const task = cp.tasks.create({ spec: spec({ max_turns: 32 }), created_by: "claude" });
    expect(task.spec.max_turns).toBe(32);

    for (const max_turns of [0, MAX_TASK_MAX_TURNS + 1, 1.5]) {
      expect(() =>
        cp.tasks.create({ spec: spec({ max_turns }), created_by: "claude" }),
      ).toThrow(/validation/i);
    }
  });

  it("rejects manager attempts to add model or effort to a task contract", () => {
    const attemptedOverride = { ...spec(), model: "sonnet", effort: "low" } as TaskSpec;
    expect(() =>
      cp.tasks.create({ spec: attemptedOverride, created_by: "claude" }),
    ).toThrow(/validation/i);
  });
});

describe("ownership", () => {
  it("lets the first claimer win and refuses the second", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const claimed = cp.tasks.claim(task.task_id, "claude");
    expect(claimed.owner).toBe("claude");
    expect(() => cp.tasks.claim(task.task_id, "codex")).toThrow(/already owned by claude/);
  });

  it("refuses a state change from a non-owner", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    expect(() =>
      cp.tasks.transition({ task_id: task.task_id, agent: "codex", to: TaskState.WORKING }),
    ).toThrow(/does not own/);
  });

  it("returns a released task to the pool for the other agent", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    const released = cp.tasks.release(task.task_id, "claude", "over budget");
    expect(released.owner).toBeNull();
    expect(released.state).toBe(TaskState.PENDING);
    expect(cp.tasks.claim(task.task_id, "codex").owner).toBe("codex");
  });
});

describe("state machine", () => {
  it("refuses an illegal transition and names the legal ones", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    expect(() =>
      cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.DONE }),
    ).toThrow(/not a legal transition/);
  });

  it("refuses any transition out of a terminal state", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.FAILED });
    expect(() =>
      cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING }),
    ).toThrow(/terminal/);
  });

  it("treats a repeated transition as a no-op so a retried call is safe", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    const first = cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    const second = cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    expect(second.version).toBe(first.version);
  });

  it("records blockers and clears them on unblock", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    const blocked = cp.tasks.block(task.task_id, "claude", "needs the codex adapter");
    expect(blocked.state).toBe(TaskState.BLOCKED);
    expect(blocked.blockers).toEqual(["needs the codex adapter"]);
    expect(cp.tasks.unblock(task.task_id, "claude", "codex landed").blockers).toEqual([]);
  });
});

describe("dependencies", () => {
  it("blocks WORKING until every dependency is DONE", () => {
    const upstream = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const downstream = cp.tasks.create({
      spec: spec({ dependencies: [upstream.task_id], scope: { paths: ["docs/**"] } }),
      created_by: "claude",
    });
    cp.tasks.claim(downstream.task_id, "codex");
    expect(() =>
      cp.tasks.transition({ task_id: downstream.task_id, agent: "codex", to: TaskState.WORKING }),
    ).toThrow(/cannot start/);
  });

  it("allows WORKING once the dependency reaches DONE", () => {
    const upstream = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const downstream = cp.tasks.create({
      spec: spec({ dependencies: [upstream.task_id], scope: { paths: ["docs/**"] } }),
      created_by: "claude",
    });

    cp.tasks.claim(upstream.task_id, "claude");
    cp.tasks.transition({ task_id: upstream.task_id, agent: "claude", to: TaskState.WORKING });
    cp.deliverables.submit({
      task_id: upstream.task_id,
      agent: "claude",
      status: DeliverableStatus.COMPLETE,
      summary: "done",
      changed_scope: ["claude/**"],
      artifacts: [],
      commit_or_diff: null,
      verification_performed: ["npm test"],
      verification_results: [passing()],
      remaining_risks: [],
      dependencies_unblocked: [],
      recommended_next_action: "none",
      at: clock.now(),
    });

    cp.tasks.claim(downstream.task_id, "codex");
    expect(
      cp.tasks.transition({ task_id: downstream.task_id, agent: "codex", to: TaskState.WORKING }).state,
    ).toBe(TaskState.WORKING);
  });

  it("refuses a dependency edge that would create a cycle", () => {
    const a = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const b = cp.tasks.create({ spec: spec({ dependencies: [a.task_id] }), created_by: "claude" });
    expect(() => cp.tasks.addDependency(a.task_id, b.task_id, "claude")).toThrow(/cycle/);
  });

  it("refuses a self-dependency", () => {
    const a = cp.tasks.create({ spec: spec(), created_by: "claude" });
    expect(() => cp.tasks.addDependency(a.task_id, a.task_id, "claude")).toThrow(/cannot depend on itself/);
  });

  it("reports only dependency-satisfied tasks as ready", () => {
    const upstream = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.create({ spec: spec({ dependencies: [upstream.task_id] }), created_by: "claude" });
    expect(cp.tasks.readyTasks().map((t) => t.task_id)).toEqual([upstream.task_id]);
  });
});

describe("verification gate", () => {
  const base = (task_id: string) => ({
    task_id,
    agent: "claude",
    changed_scope: ["claude/**"],
    artifacts: [],
    commit_or_diff: null,
    remaining_risks: [],
    dependencies_unblocked: [],
    recommended_next_action: "none",
    at: clock.now(),
  });

  function working() {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    return task.task_id;
  }

  it("refuses COMPLETE with no evidence at all", () => {
    const id = working();
    expect(() =>
      cp.deliverables.submit({
        ...base(id),
        status: DeliverableStatus.COMPLETE,
        summary: "trust me",
        verification_performed: [],
        verification_results: [],
      }),
    ).toThrow(/no passing verification/);
  });

  it("refuses COMPLETE while a check is failing", () => {
    const id = working();
    expect(() =>
      cp.deliverables.submit({
        ...base(id),
        status: DeliverableStatus.COMPLETE,
        summary: "mostly works",
        verification_performed: ["npm test"],
        verification_results: [
          { kind: "test", command: "npm test", passed: false, exit_code: 1, summary: "1 failed" },
        ],
      }),
    ).toThrow(/failing/);
  });

  it("accepts COMPLETE with passing evidence and reaches DONE via VERIFYING", () => {
    const id = working();
    cp.deliverables.submit({
      ...base(id),
      status: DeliverableStatus.COMPLETE,
      summary: "done",
      verification_performed: ["npm test"],
      verification_results: [passing()],
    });
    expect(cp.tasks.get(id).state).toBe(TaskState.DONE);
    const states = cp
      .events({ task_id: id, types: ["task.state_changed"] })
      .map((e) => e.payload["to"]);
    expect(states).toEqual([TaskState.WORKING, TaskState.VERIFYING, TaskState.DONE]);
  });

  it("allows an explicitly waived COMPLETE and records the waiver", () => {
    const id = working();
    cp.deliverables.submit(
      {
        ...base(id),
        status: DeliverableStatus.COMPLETE,
        summary: "design decision, nothing executable to check",
        verification_performed: [],
        verification_results: [],
      },
      { allowUnverified: true, waiver_reason: "documentation-only task" },
    );
    const submitted = cp.events({ task_id: id, types: ["deliverable.submitted"] })[0]!;
    expect(submitted.payload["waiver_reason"]).toBe("documentation-only task");
  });

  it("sends a PARTIAL deliverable to BLOCKED rather than DONE", () => {
    const id = working();
    cp.deliverables.submit({
      ...base(id),
      status: DeliverableStatus.PARTIAL,
      summary: "needs codex",
      verification_performed: [],
      verification_results: [],
      remaining_risks: ["codex adapter missing"],
    });
    const task = cp.tasks.get(id);
    expect(task.state).toBe(TaskState.BLOCKED);
    expect(task.blockers).toEqual(["codex adapter missing"]);
  });

  it("refuses a deliverable from an agent that does not own the task", () => {
    const id = working();
    expect(() =>
      cp.deliverables.submit({
        ...base(id),
        agent: "codex",
        status: DeliverableStatus.COMPLETE,
        summary: "stolen",
        verification_performed: ["npm test"],
        verification_results: [passing()],
      }),
    ).toThrow(/cannot submit a deliverable/);
  });
});

describe("deliverable outcomes from VERIFYING", () => {
  // Regression for codex req_codex_partial_from_verifying_001: an adapter that reported a
  // VERIFYING milestone could not submit an honest PARTIAL, because VERIFYING -> BLOCKED
  // was not a legal edge. The workaround was to detour through WORKING first.
  const base = (task_id: string) => ({
    task_id,
    agent: "claude",
    changed_scope: ["claude/**"],
    artifacts: [],
    commit_or_diff: null,
    dependencies_unblocked: [],
    recommended_next_action: "none",
    at: clock.now(),
  });

  /** A task parked in VERIFYING, the state an adapter reaches before submitting. */
  function verifying() {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.VERIFYING });
    return task.task_id;
  }

  it("VERIFYING + COMPLETE -> DONE", () => {
    const id = verifying();
    cp.deliverables.submit({
      ...base(id),
      status: DeliverableStatus.COMPLETE,
      summary: "verified",
      verification_performed: ["npm test"],
      verification_results: [passing()],
      remaining_risks: [],
    });
    expect(cp.tasks.get(id).state).toBe(TaskState.DONE);
  });

  it("VERIFYING + PARTIAL -> BLOCKED, with no WORKING detour", () => {
    const id = verifying();
    cp.deliverables.submit({
      ...base(id),
      status: DeliverableStatus.PARTIAL,
      summary: "checks ran, work incomplete",
      verification_performed: [],
      verification_results: [],
      remaining_risks: ["needs the codex adapter"],
    });

    const task = cp.tasks.get(id);
    expect(task.state).toBe(TaskState.BLOCKED);
    expect(task.blockers).toContain("needs the codex adapter");

    // The old workaround is gone: the task must never have re-entered WORKING.
    const visited = cp
      .events({ task_id: id })
      .filter((e) => e.type === "task.state_changed" || e.type === "task.blocked")
      .map((e) => e.payload["to"]);
    expect(visited).toEqual([TaskState.WORKING, TaskState.VERIFYING, TaskState.BLOCKED]);
  });

  it("VERIFYING + FAILED -> FAILED", () => {
    const id = verifying();
    cp.deliverables.submit({
      ...base(id),
      status: DeliverableStatus.FAILED,
      summary: "could not complete",
      verification_performed: [],
      verification_results: [],
      remaining_risks: ["unrecoverable"],
    });
    expect(cp.tasks.get(id).state).toBe(TaskState.FAILED);
  });

  it("declares VERIFYING -> BLOCKED legal in the shared transition table", () => {
    // Codex reads this table to predict what the control plane will accept, so the edge
    // must be advertised, not merely tolerated by the deliverable path.
    expect(canTransition(TaskState.VERIFYING, TaskState.BLOCKED)).toBe(true);
    expect(canTransition(TaskState.VERIFYING, TaskState.DONE)).toBe(true);
    expect(canTransition(TaskState.VERIFYING, TaskState.FAILED)).toBe(true);
  });

  it("commits the deliverable and the state change together", () => {
    // A deliverable stored as COMPLETE beside a task still marked WORKING would let an
    // agent read a finished result for work the control plane thinks is in flight.
    const id = verifying();
    const before = cp.lastEventId();
    expect(() =>
      cp.deliverables.submit({
        ...base(id),
        status: DeliverableStatus.COMPLETE,
        summary: "no evidence, will be rejected",
        verification_performed: [],
        verification_results: [],
        remaining_risks: [],
      }),
    ).toThrow(/no passing verification/);

    expect(cp.deliverables.get(id)).toBeUndefined();
    expect(cp.tasks.get(id).state).toBe(TaskState.VERIFYING);
    expect(cp.lastEventId()).toBe(before);
  });

  it("still routes a submission straight from WORKING through VERIFYING", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    cp.deliverables.submit({
      ...base(task.task_id),
      status: DeliverableStatus.COMPLETE,
      summary: "done",
      verification_performed: ["npm test"],
      verification_results: [passing()],
      remaining_risks: [],
    });

    const visited = cp
      .events({ task_id: task.task_id, types: ["task.state_changed"] })
      .map((e) => e.payload["to"]);
    expect(visited).toEqual([TaskState.WORKING, TaskState.VERIFYING, TaskState.DONE]);
  });
});

describe("retry budget", () => {
  it("refuses to retry a task that did not fail", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    expect(() => cp.tasks.retry(task.task_id, "claude", 3)).toThrow(/only FAILED tasks/);
  });

  it("stops retrying once the budget is exhausted, instead of looping forever", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.FAILED });

    const retried = cp.tasks.retry(task.task_id, "claude", 2);
    expect(retried.attempt).toBe(1);
    expect(retried.owner).toBeNull();

    cp.tasks.claim(task.task_id, "claude");
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.FAILED });
    expect(() => cp.tasks.retry(task.task_id, "claude", 2)).toThrow(/budget exhausted/);
  });
});

describe("event log", () => {
  it("is append-only and monotonic, and can be tailed incrementally", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    const firstBatch = cp.events();
    const cursor = cp.lastEventId();
    cp.tasks.transition({ task_id: task.task_id, agent: "claude", to: TaskState.WORKING });

    const secondBatch = cp.events({ after: cursor });
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]!.event_id).toBeGreaterThan(cursor);
    expect(cp.events().slice(0, firstBatch.length)).toEqual(firstBatch);
  });
});
