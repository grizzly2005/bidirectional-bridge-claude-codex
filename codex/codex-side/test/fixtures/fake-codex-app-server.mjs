#!/usr/bin/env node

import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const omitUsage = process.argv.includes("--omit-usage");
const multiUsage = process.argv.includes("--multi-usage");
const failedWithoutUsage = process.argv.includes("--failed-without-usage");
let threadCounter = 0;
let turnCounter = 0;
const cumulative = new Map();
const permissions = new Map();
const capturePath = process.argv.find(arg => arg.startsWith("--capture="))?.slice("--capture=".length);
const linux = process.argv.includes("--linux-platform");
const threadSettings = params => ({
  cwd: params.cwd,
  runtimeWorkspaceRoots: process.argv.includes("--foreign-root") ? ["C:\\foreign"] : params.runtimeWorkspaceRoots,
  approvalPolicy: params.approvalPolicy,
  sandbox: params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
    : { type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
});

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

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const record = process.argv.find(arg => arg.startsWith("--record="))?.slice("--record=".length);
  if (record && ["thread/start", "thread/resume", "turn/start"].includes(message.method)) {
    appendFileSync(record, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  }
  if (capturePath) appendFileSync(capturePath, `${line}\n`);
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        codexHome: "C:/redacted",
        platformFamily: "windows",
        platformOs: linux ? "linux" : "windows",
        userAgent: "Codex Desktop/0.147.0 (fixture)",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    const threadId = `thread_app_${++threadCounter}`;
    cumulative.set(threadId, 0);
    permissions.set(threadId, threadSettings(message.params));
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: threadId }, model: message.params.model ?? "incompatible-desktop-model",
        ...(linux ? permissions.get(threadId) : {}) },
    });
    return;
  }

  if (message.method === "config/read") {
    send({ id: message.id, result: { config: { model: "incompatible-desktop-model", model_provider: "openai",
      ...(linux && !process.argv.includes("--without-project-bridge") ? { mcp_servers: { bridge: { command: "fixture-bridge" } } } : {}) } } });
    return;
  }
  if (message.method === "model/list") {
    const response = { id: message.id, result: { data: [{ id: "gpt-fixture", model: "gpt-fixture", isDefault: true, hidden: false }], nextCursor: null } };
    if (process.argv.includes("--slow-catalog")) setTimeout(() => send(response), 150);
    else send(response);
    return;
  }

  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    cumulative.set(threadId, cumulative.get(threadId) ?? 45);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: threadId }, model: "gpt-fixture", ...(linux ? threadSettings(message.params) : {}) },
    });
    return;
  }

  if (message.method === "thread/read") {
    const cwd = process.argv.includes("--foreign-stored-workspace") ? "/home/kali/other-project"
      : permissions.get(message.params.threadId)?.cwd ?? process.argv.find(arg => arg.startsWith("--read-cwd="))?.slice("--read-cwd=".length);
    send({ id: message.id, result: { thread: { id: message.params.threadId, cwd } } });
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
    const badFrame = process.argv.find(arg => arg.startsWith("--bad-frame="))?.slice("--bad-frame=".length);
    if (badFrame) {
      send(badFrame === "null" ? null : badFrame === "array" ? []
        : { method: "turn/completed", params: { threadId, turn: { id: turnId }, private: "SENSITIVE_FRAME_MARKER" } });
      return;
    }
    if (process.argv.includes("--delayed-turn")) await new Promise(resolve => setTimeout(resolve, 180));
    if (failedWithoutUsage) {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "failed",
            startedAt: 1700000000,
            completedAt: 1700000001,
            durationMs: 10,
            error: { message: "fixture credits unavailable" },
            items: [],
          },
        },
      });
      return;
    }
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
