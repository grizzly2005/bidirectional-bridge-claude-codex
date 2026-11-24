#!/usr/bin/env node
// Stand-in for the Antigravity CLI (`agy`) and legacy Gemini CLI headless stream protocols.
// Behaviour is selected with FAKE_AGY_MODE; argv/env are recorded to FAKE_AGY_RECORD.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE ?? "success";
const dialect = process.env.FAKE_AGY_DIALECT ?? "antigravity";
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] === "--version") { process.stdout.write("agy 1.1.8 (go1.24, test)\n"); process.exit(0); }

if (process.env.FAKE_AGY_RECORD) {
  appendFileSync(process.env.FAKE_AGY_RECORD, `${JSON.stringify({ argv, cwd: process.cwd(),
    worker: process.env.BRIDGE_DELEGATED_WORKER ?? null })}\n`);
}

const prompt = flag("-p") ?? "";
const pointer = /workspace file (\S+\.md)/u.exec(prompt)?.[1];
const contract = pointer ? readFileSync(pointer, "utf8") : prompt;
const conversation = flag("--conversation") ?? flag("--resume") ?? flag("--session-id") ?? "conv-0001-abcdef";
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const finalJson = {
  summary: process.env.FAKE_AGY_SUMMARY ?? "implemented the bounded change",
  changed_scope: mode === "readonly-violation" ? ["src/x.ts"] : JSON.parse(process.env.FAKE_AGY_CHANGED ?? '["src/a.ts"]'),
  verification_results: mode === "contradiction"
    ? [{ kind: "test", command: "npm test", passed: true, exit_code: 1, summary: "claimed" }]
    : mode === "noverify" ? [] : [{ kind: "test", command: "npm test", passed: true, exit_code: 0, summary: "3 passed" }],
  remaining_risks: [],
  recommended_next_action: "review",
  blocker: null,
};
const response = mode === "unstructured" ? "I did some work but forgot the JSON." :
  `${mode === "long" ? "x".repeat(6000) + "\n" : ""}Done.\n\n\`\`\`json\n${JSON.stringify(finalJson, null, 2)}\n\`\`\`\n`;

if (mode === "write" && process.env.FAKE_AGY_WRITE) writeFileSync(process.env.FAKE_AGY_WRITE, contract.length > 0 ? "ok" : "");

if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "noresult") {
  process.stderr.write("Error: not logged in. Run agy to authenticate.\n");
  process.exit(1);
} else if (dialect === "gemini-cli") {
  emit({ type: "init", session_id: conversation, model: "gemini-4-neon" });
  emit({ type: "message", role: "assistant", content: response, delta: true });
  emit({ type: "result", status: "success", stats: { total_tokens: 150, input_tokens: 100, output_tokens: 50, cached: 20, duration_ms: 1234 } });
} else {
  const init = { cwd: process.cwd(), tools: [], permission_mode: "request-review" };
  const requested = flag("--model");
  if (requested) init.model = mode === "wrongmodel" ? "gemini-4-hydrogen" : requested;
  emit({ event: "init", conversation_id: conversation, init });
  emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "agent_response", text_delta: response } });
  if (mode === "fail-auth") {
    emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: "unauthenticated: login required", duration_seconds: 0.5, num_turns: 0 } });
  } else {
    emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response, duration_seconds: 2.5, num_turns: 3,
      usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1250 } } });
  }
  void contract;
}
