#!/usr/bin/env node

import { createInterface } from "node:readline";

const omitUsage = process.argv.includes("--omit-usage");
const multiUsage = process.argv.includes("--multi-usage");
let threadCounter = 0;
let turnCounter = 0;
const cumulative = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const resultText = () =>
  JSON.stringify({
    status: "COMPLETE",
    summary: "fixture complete",
    changed_scope: [],
    artifacts: [],
    commit_or_diff: null,
    verification_results: [
      {
        kind: "test",
        command: "fixture verification",
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
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        codexHome: "C:/redacted",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "Codex Desktop/0.147.0 (fixture)",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = `thread_app_${++threadCounter}`;
    cumulative.set(threadId, 0);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: threadId }, model: "gpt-fixture" },
    });
    return;
  }

  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    cumulative.set(threadId, cumulative.get(threadId) ?? 45);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: threadId }, model: "gpt-fixture" },
    });
    return;
  }

  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = `turn_app_${++turnCounter}`;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { turn: { id: turnId, items: [], status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item_1", delta: "{" },
    });
    const previous = cumulative.get(threadId) ?? 0;
    const firstIncrement = multiUsage ? 20 : 0;
    if (!omitUsage && multiUsage) {
      send({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: {
              totalTokens: 20,
              inputTokens: 18,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
            total: {
              totalTokens: previous + 20,
              inputTokens: previous + 18,
              cachedInputTokens: 2,
              cacheWriteInputTokens: 0,
              outputTokens: 2,
              reasoningOutputTokens: 0,
            },
          },
        },
      });
    }
    const current = previous + firstIncrement + 45;
    cumulative.set(threadId, current);
    if (!omitUsage) {
      send({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: {
              totalTokens: 45,
              inputTokens: 40,
              cachedInputTokens: 3,
              cacheWriteInputTokens: 1,
              outputTokens: 5,
              reasoningOutputTokens: 1,
            },
            total: {
              totalTokens: current,
              inputTokens: current - (multiUsage ? 7 : 5),
              cachedInputTokens: multiUsage ? 5 : 3,
              cacheWriteInputTokens: 1,
              outputTokens: multiUsage ? 7 : 5,
              reasoningOutputTokens: 1,
            },
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          startedAt: 1700000000,
          completedAt: 1700000001,
          durationMs: 750,
          items: [{ id: "message_1", type: "agentMessage", text: resultText() }],
        },
      },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  });
});
