/**
 * Crash/retry safety.
 *
 * An MCP call that times out leaves the caller unable to tell whether the mutation landed.
 * The only safe answer is for a replay to be a no-op that returns the original result —
 * otherwise a retried `create_task` silently forks the work into two tasks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, seededRandom, type TaskSpec } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { hashRequest, stableStringify } from "./idempotency.js";

function spec(objective = "work"): TaskSpec {
  return {
    objective,
    scope: { paths: ["claude/**"] },
    dependencies: [],
    expected_deliverable: "artifact",
    verification_criteria: ["tests pass"],
  };
}

let cp: ControlPlane;

beforeEach(() => {
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-test",
    databasePath: ":memory:",
    clock: new ManualClock(),
    rng: seededRandom(11),
  });
});

describe("stableStringify", () => {
  it("hashes key-order-independently, so a reordered payload is not a new request", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1, b: [1, 2] })).toBe(hashRequest({ b: [1, 2], a: 1 }));
  });

  it("still distinguishes genuinely different payloads", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("treats array order as significant", () => {
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});

describe("task creation replay", () => {
  it("creates exactly one task when the same key is replayed", () => {
    const first = cp.tasks.create({ spec: spec(), created_by: "claude", idempotency_key: "k1" });
    const second = cp.tasks.create({ spec: spec(), created_by: "claude", idempotency_key: "k1" });
    expect(second.task_id).toBe(first.task_id);
    expect(cp.tasks.list()).toHaveLength(1);
    expect(cp.events({ types: ["task.created"] })).toHaveLength(1);
  });

  it("creates two tasks without a key, since the caller opted out of replay safety", () => {
    cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.create({ spec: spec(), created_by: "claude" });
    expect(cp.tasks.list()).toHaveLength(2);
  });

  it("rejects a key reused for a different request instead of returning the wrong answer", () => {
    cp.tasks.create({ spec: spec("first objective"), created_by: "claude", idempotency_key: "k2" });
    let thrown: any;
    try {
      cp.tasks.create({ spec: spec("different objective"), created_by: "claude", idempotency_key: "k2" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe(ErrorCode.IDEMPOTENCY_MISMATCH);
  });
});

describe("claim and transition replay", () => {
  it("makes a replayed claim a no-op rather than a second version bump", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    const first = cp.tasks.claim(task.task_id, "claude", "claim-1");
    const second = cp.tasks.claim(task.task_id, "claude", "claim-1");
    expect(second).toEqual(first);
    expect(cp.events({ types: ["task.claimed"] })).toHaveLength(1);
  });

  it("makes a replayed transition a no-op", () => {
    const task = cp.tasks.create({ spec: spec(), created_by: "claude" });
    cp.tasks.claim(task.task_id, "claude");
    const args = { task_id: task.task_id, agent: "claude", to: "WORKING" as const, idempotency_key: "t-1" };
    const first = cp.tasks.transition(args);
    const second = cp.tasks.transition(args);
    expect(second.version).toBe(first.version);
    expect(cp.events({ types: ["task.state_changed"] })).toHaveLength(1);
  });
});

describe("rollback", () => {
  it("does not cache a response for an operation that threw", () => {
    // A dependency on a missing task makes creation fail; the key must stay unused so a
    // corrected retry can succeed rather than replaying a failure forever.
    expect(() =>
      cp.tasks.create({
        spec: { ...spec(), dependencies: ["task_missing0000"] },
        created_by: "claude",
        idempotency_key: "k3",
      }),
    ).toThrow();

    const recovered = cp.tasks.create({ spec: spec(), created_by: "claude", idempotency_key: "k3" });
    expect(recovered.task_id).toBeTruthy();
    expect(cp.tasks.list()).toHaveLength(1);
  });

  it("leaves no partial state behind when a transaction aborts", () => {
    const before = cp.tasks.list().length;
    expect(() =>
      cp.store.transaction(() => {
        cp.tasks.create({ spec: spec(), created_by: "claude" });
        throw new Error("simulated crash mid-transaction");
      }),
    ).toThrow(/simulated crash/);
    expect(cp.tasks.list()).toHaveLength(before);
    expect(cp.events({ types: ["task.created"] })).toHaveLength(0);
  });
});
