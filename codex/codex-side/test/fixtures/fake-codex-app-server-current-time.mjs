#!/usr/bin/env node

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const serverRequestId = 7_001;
let threadId = null;
let turnId = null;

const resultText = JSON.stringify({
  status: "COMPLETE",
  summary: "current-time request answered",
  changed_scope: [],
  artifacts: [],
  commit_or_diff: null,
  verification_results: [
    {
      kind: "test",
      command: "fake currentTime/read handshake",
      passed: true,
      exit_code: 0,
      summary: "passed",
    },
  ],
  remaining_risks: [],
  recommended_next_action: "none",
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        codexHome: "C:/redacted",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "Codex Desktop/0.147.0 (current-time fixture)",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    threadId = "thread_current_time_1";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: threadId }, model: "gpt-fixture" },
    });
    return;
  }

  if (message.method === "turn/start") {
    turnId = "turn_current_time_1";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { turn: { id: turnId, items: [], status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      id: serverRequestId,
      method: "currentTime/read",
      params: { threadId },
    });
    return;
  }

  if (message.id === serverRequestId && message.method === undefined) {
    if (!Number.isSafeInteger(message.result?.currentTimeAt)) {
      process.stderr.write("invalid currentTime/read response\n");
      process.exitCode = 2;
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item_1", delta: "{" },
    });
    send({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: {
            totalTokens: 12,
            inputTokens: 10,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
          total: {
            totalTokens: 12,
            inputTokens: 10,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_001,
          durationMs: 500,
          items: [{ id: "message_1", type: "agentMessage", text: resultText }],
        },
      },
    });
  }
});
