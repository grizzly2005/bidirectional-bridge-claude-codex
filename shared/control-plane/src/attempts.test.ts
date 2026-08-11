/**
 * Attempt records and execution handles.
 *
 * The handle exists so a crashed run can be resumed instead of redone. The guards exist
 * because the same field is an obvious place to accidentally park a token or a transcript,
 * in a database both agents and any supervisor can read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EXECUTION_HANDLE_MAX_LENGTH, ErrorCode, seededRandom, type TaskSpec } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";

function spec(): TaskSpec {
  return {
    objective: "work that may need resuming",
    scope: { paths: ["claude/**"] },
    dependencies: [],
    expected_deliverable: "artifact",
    verification_criteria: ["tests pass"],
  };
}

let cp: ControlPlane;
let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-attempts",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(5),
  });
});

function newTask(): string {
  return cp.tasks.create({ spec: spec(), created_by: "claude" }).task_id;
}

describe("attempt records", () => {
  it("opens an attempt with no handle yet", () => {
    const id = newTask();
    const attempt = cp.attempts.start(id, 0, "claude");
    expect(attempt.attempt).toBe(0);
    expect(attempt.execution_handle).toBeNull();
    expect(cp.events({ types: ["attempt.started"] })).toHaveLength(1);
  });

  it("is idempotent, so a retried start does not reset the record", () => {
    const id = newTask();
    const first = cp.attempts.start(id, 0, "claude");
    cp.attempts.saveHandle(id, 0, "claude", "session_1");
    clock.advance(1000);
    cp.attempts.start(id, 0, "claude");

    expect(cp.attempts.get(id, 0)?.execution_handle).toBe("session_1");
    expect(cp.attempts.get(id, 0)?.started_at).toBe(first.started_at);
    expect(cp.events({ types: ["attempt.started"] })).toHaveLength(1);
  });

  it("keeps handles per attempt, so a retry does not reuse a dead session", () => {
    const id = newTask();
    cp.attempts.saveHandle(id, 0, "claude", "session_attempt_0");
    cp.attempts.saveHandle(id, 1, "claude", "session_attempt_1");

    expect(cp.attempts.get(id, 0)?.execution_handle).toBe("session_attempt_0");
    expect(cp.attempts.get(id, 1)?.execution_handle).toBe("session_attempt_1");
    expect(cp.attempts.list(id)).toHaveLength(2);
  });

  it("offers the nearest earlier handle for resuming", () => {
    const id = newTask();
    cp.attempts.saveHandle(id, 0, "claude", "session_0");
    cp.attempts.saveHandle(id, 1, "claude", "session_1");

    expect(cp.attempts.previousHandle(id, 2)).toBe("session_1");
    expect(cp.attempts.previousHandle(id, 1)).toBe("session_0");
    expect(cp.attempts.previousHandle(id, 0)).toBeNull();
  });

  it("records the outcome when an attempt ends but keeps the handle", () => {
    const id = newTask();
    cp.attempts.saveHandle(id, 0, "claude", "session_0");
    const ended = cp.attempts.end(id, 0, "claude", "TIMEOUT");

    expect(ended?.outcome).toBe("TIMEOUT");
    expect(ended?.ended_at).toBe(clock.now());
    // The handle outliving the failed attempt is the entire point.
    expect(cp.attempts.get(id, 0)?.execution_handle).toBe("session_0");
  });
});

describe("execution handle guards", () => {
  it("rejects a handle long enough to be a transcript", () => {
    const id = newTask();
    let thrown: any;
    try {
      cp.attempts.saveHandle(id, 0, "claude", "x".repeat(EXECUTION_HANDLE_MAX_LENGTH + 1));
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(thrown.message).toMatch(/not a place to store a transcript/);
  });

  it("accepts a handle exactly at the limit", () => {
    const id = newTask();
    expect(() =>
      cp.attempts.saveHandle(id, 0, "claude", "x".repeat(EXECUTION_HANDLE_MAX_LENGTH)),
    ).not.toThrow();
  });

  it.each([
    ["OpenAI-style key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["Anthropic-style key", "sk-ant-abcdefghijklmnopqrstuvwxyz01"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["bearer token", "Bearer abcdefghijklmnopqrstuvwxyz"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("rejects a handle containing a %s", (_label, candidate) => {
    const id = newTask();
    let thrown: any;
    try {
      cp.attempts.saveHandle(id, 0, "claude", candidate);
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(thrown.message).toMatch(/credential/);
  });

  it("rejects multi-line content, which is what a pasted transcript looks like", () => {
    const id = newTask();
    expect(() => cp.attempts.saveHandle(id, 0, "claude", "user: hi\nassistant: hello")).toThrow(
      /validation/i,
    );
  });

  it("accepts the identifier shapes agents actually use", () => {
    const id = newTask();
    for (const handle of [
      "thread_01JABCDEF0123456789",
      "claude-session-9f2b1c",
      "codex:conv/8172",
      "job-1234-5678",
    ]) {
      expect(() => cp.attempts.saveHandle(id, 0, "claude", handle)).not.toThrow();
    }
  });

  it("never writes the handle itself into the event log", () => {
    // A supervisor tailing events should not be able to harvest session ids from the
    // stream; the value lives in exactly one place.
    const id = newTask();
    cp.attempts.saveHandle(id, 0, "claude", "session_secret_pointer");
    const events = cp.events({ types: ["attempt.handle_set"] });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload)).not.toContain("session_secret_pointer");
    expect(events[0]!.payload["handle_length"]).toBe("session_secret_pointer".length);
  });
});

describe("durability", () => {
  it("survives closing and reopening the database", () => {
    // A fresh directory per run: a fixed path plus a seeded id generator would collide with
    // the previous run's rows and fail for a reason unrelated to durability.
    const dir = mkdtempSync(join(tmpdir(), "bridge-attempts-"));
    const dbPath = join(dir, "bridge.db");
    try {
      const fresh = ControlPlane.open({
        workspaceRoot: dir,
        databasePath: dbPath,
        clock,
        rng: seededRandom(6),
      });
      const id = fresh.tasks.create({ spec: spec(), created_by: "claude" }).task_id;
      fresh.attempts.saveHandle(id, 0, "claude", "session_durable");
      fresh.close();

      const reopened = ControlPlane.open({ workspaceRoot: dir, databasePath: dbPath, clock });
      expect(reopened.attempts.get(id, 0)?.execution_handle).toBe("session_durable");
      expect(reopened.tasks.get(id).task_id).toBe(id);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
