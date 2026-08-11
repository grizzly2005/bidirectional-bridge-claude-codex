import {
  BridgeError,
  ErrorCode,
  type TaskInvocation,
} from "@bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  buildResumePrompt,
  buildTaskPrompt,
  parseCodexTaskResult,
} from "./prompt.js";

function invocation(): TaskInvocation {
  return {
    task_id: "task_0000000000",
    spec: {
      objective: "create a bounded report",
      scope: { paths: ["codex/**"] },
      dependencies: [],
      expected_deliverable: "report",
      verification_criteria: ["test command exits zero"],
    },
    inputs: [],
    workspace_root: "C:\\repo",
    lease_id: "lease_0000000000",
    deadline_at: Date.now() + 60_000,
    attempt: 0,
    idempotency_key: "prompt-test",
  };
}

function validResult(): Record<string, unknown> {
  return {
    status: "COMPLETE",
    summary: "done",
    changed_scope: ["codex/result.txt"],
    artifacts: [
      {
        kind: "report",
        name: "result",
        media_type: "text/plain",
        path: "codex/result.txt",
      },
    ],
    commit_or_diff: null,
    verification_results: [
      {
        kind: "test",
        command: "npm test",
        passed: true,
        exit_code: 0,
        summary: "passed",
      },
    ],
    remaining_risks: [],
    recommended_next_action: "review",
  };
}

describe("Codex task prompt and result validation", () => {
  it("contains task records and artifacts, not a chat-history field", () => {
    const prompt = buildTaskPrompt(invocation());
    expect(prompt).toContain("task_0000000000");
    expect(prompt).toContain("allowed_write_scope");
    expect(prompt).not.toContain("chat_history");
  });

  it("builds a bounded restart prompt that forbids duplicate work", () => {
    const prompt = buildResumePrompt({
      ...invocation(),
      attempt: 1,
      previous_execution_handle: "thread_saved",
    });
    expect(prompt).toContain("after a process restart");
    expect(prompt).toContain("Do not restart or duplicate work");
    expect(prompt).toContain("task_0000000000");
  });

  it("accepts a schema-valid, in-scope deliverable", () => {
    const parsed = parseCodexTaskResult(JSON.stringify(validResult()), invocation());
    expect(parsed.status).toBe("COMPLETE");
    expect(parsed.artifacts[0]?.path).toBe("codex/result.txt");
  });

  it("rejects a reported scope violation", () => {
    const result = validResult();
    result.changed_scope = ["claude/control-plane/src/owned.ts"];

    expect(() => parseCodexTaskResult(JSON.stringify(result), invocation())).toThrowError(
      expect.objectContaining<Partial<BridgeError>>({ code: ErrorCode.INVALID_ARGUMENT }),
    );
  });

  it("rejects contradictory verification evidence", () => {
    const result = validResult();
    result.verification_results = [
      {
        kind: "test",
        command: "npm test",
        passed: true,
        exit_code: 1,
        summary: "contradiction",
      },
    ];

    expect(() => parseCodexTaskResult(JSON.stringify(result), invocation())).toThrowError(
      expect.objectContaining<Partial<BridgeError>>({ code: ErrorCode.INVALID_ARGUMENT }),
    );
  });

  it("rejects COMPLETE without successful verification evidence", () => {
    const result = validResult();
    result.verification_results = [];

    expect(() => parseCodexTaskResult(JSON.stringify(result), invocation())).toThrow(
      /requires at least one real verification/,
    );
  });

  it("rejects COMPLETE while any verification is failing", () => {
    const result = validResult();
    result.verification_results = [
      {
        kind: "test",
        command: "npm test",
        passed: false,
        exit_code: 1,
        summary: "failed",
      },
    ];

    expect(() => parseCodexTaskResult(JSON.stringify(result), invocation())).toThrow(
      /failing verification evidence/,
    );
  });
});
