#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary that speaks the REAL stream-json protocol.
 *
 * Not a mock of the adapter — the adapter under test spawns this exactly as it spawns the
 * real CLI, parses the same NDJSON frames, and gets the same argv contract. The frame
 * shapes below were captured from Claude Code 2.1.222 by running:
 *
 *   claude -p x --output-format stream-json --verbose --session-id <uuid>
 *
 * so the parser is tested against the protocol as it actually is, not as documented.
 * What this cannot exercise is the model itself; that is the live run's job.
 *
 * Behaviour is scripted through FAKE_CLAUDE_MODE:
 *   ok            emit init + assistant + successful result with a fenced JSON contract
 *   error         is_error result frame (what an unauthenticated real CLI produces)
 *   hang          emit init, then never finish — for deadline and cancellation tests
 *   noresult      exit without a result frame — a crashed/misinvoked CLI
 *   noisy         write non-JSON to stdout before valid frames
 *   unstructured  succeed but omit the fenced JSON block
 *   sparse        succeed with every optional metadata field missing or null
 *   maxturns      the `error_max_turns` result frame: stopped cleanly, task unfinished
 *   wrongmodel    report a non-Opus model despite the requested profile
 *   nomodel       omit runtime-reported model identity everywhere
 *   summaryonly   claim a check in prose/verification_performed, without structured evidence
 *   mixed         emit one passing and one failing structured verification
 *   large         emit a report larger than the deliverable summary bound
 */

import { argv, env, stdout } from "node:process";

const args = argv.slice(2);

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

// Record the invocation so the test can assert the argv contract.
if (env.FAKE_CLAUDE_ARGV_FILE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    env.FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify({ args, cwd: process.cwd(), stdinIsTTY: process.stdin.isTTY ?? false }, null, 2),
  );
}

if (has("--version")) {
  stdout.write("2.1.222 (Claude Code)\n");
  process.exit(0);
}

const mode = env.FAKE_CLAUDE_MODE ?? "ok";
const omitModel = mode === "nomodel";
const reportedModel = mode === "wrongmodel" ? "claude-sonnet-4-5" : "claude-opus-5";
// A resumed run must reuse the session id it was given; a fresh one mints its own.
const resumeId = flag("--resume");
const sessionId = resumeId ?? env.FAKE_CLAUDE_SESSION_ID ?? "11111111-2222-4333-8444-555555555555";

const emit = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);

if (mode === "noisy") {
  stdout.write("some non-JSON diagnostic noise\n");
}

// Frame 1: init. Session id is available here, before any model work.
emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
  tools: ["Bash", "Read", "Write"],
  mcp_servers: [],
  ...(omitModel ? {} : { model: reportedModel }),
  permissionMode: flag("--permission-mode") ?? "default",
  apiKeySource: "none",
  claude_code_version: "2.1.222",
  uuid: "2cf21c75-ea12-42d4-ac74-550b8c2e05b4",
});

if (mode === "hang") {
  // Hold stdout open forever; the adapter must terminate us on deadline or cancel.
  setInterval(() => {}, 1 << 30);
} else if (mode === "noresult") {
  process.exit(3);
} else if (mode === "error") {
  emit({
    is_error: true,
    duration_api_ms: 0,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0,
    terminal_reason: "api_error",
    subtype: "success",
    result: "Not logged in · Please run /login",
    type: "result",
    duration_ms: 64,
  });
} else {
  const resumedNote = resumeId ? " (resumed)" : "";
  const passingVerification = {
    kind: "manual",
    command: "node --version",
    passed: true,
    exit_code: 0,
    summary: "v22",
  };
  const verificationResults =
    mode === "mixed"
      ? [
          passingVerification,
          { kind: "test", command: "npm test", passed: false, exit_code: 1, summary: "1 failed" },
        ]
      : [
          passingVerification,
          // Deliberately missing a command: the adapter must drop it as non-evidence.
          { kind: "test", passed: true, exit_code: 0, summary: "no command given" },
        ];
  const detailedReport =
    mode === "large"
      ? [
          "# RELEASE_BLOCKERS",
          "No release blocker found in the deterministic fixture.",
          "# EVIDENCE",
          "AUDIT_EVIDENCE_".repeat(900),
          "FULL_REPORT_END",
          "",
        ].join("\n")
      : "";
  const contract =
    mode === "unstructured"
      ? `I inspected the repository${resumedNote}. Node is present and the tree is clean.`
      : [
          ...(detailedReport ? [detailedReport] : []),
          `Collected runtime information${resumedNote}.`,
          "",
          "```json",
          JSON.stringify(
            {
              summary: `runtime info collected${resumedNote}`,
              changed_scope: [],
              ...(mode === "summaryonly"
                ? { verification_performed: ["npm test"] }
                : { verification_results: verificationResults }),
              remaining_risks: [],
              recommended_next_action: "none",
              blocker: null,
            },
            null,
            2,
          ),
          "```",
        ].join("\n");

  emit({
    type: "assistant",
    message: {
      ...(omitModel ? {} : { model: reportedModel }),
      role: "assistant",
      content: [{ type: "text", text: contract }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 8140, cache_read_input_tokens: 12424, output_tokens: 1 },
    },
    session_id: sessionId,
  });

  if (mode === "sparse") {
    // Everything optional is absent or null. A runtime upgrade that stops emitting usage
    // must degrade to nulls, not to a wrong number or a crash.
    emit({
      is_error: false,
      session_id: sessionId,
      total_cost_usd: null,
      num_turns: null,
      usage: null,
      subtype: "success",
      result: contract,
      type: "result",
    });
  } else if (mode === "maxturns") {
    emit({
      is_error: false,
      duration_api_ms: 2412,
      num_turns: 4,
      session_id: sessionId,
      total_cost_usd: 0.02,
      usage: { input_tokens: 2, cache_creation_input_tokens: 8140, cache_read_input_tokens: 12424, output_tokens: 9 },
      terminal_reason: "max_turns",
      subtype: "error_max_turns",
      result: contract,
      type: "result",
      duration_ms: 1740,
    });
  } else {
    // Field-for-field the shape Claude Code 2.1.226 emits, including the token categories:
    // `input_tokens` is the UNCACHED part only, which is why 2 sits next to a 12424-token
    // cache read. Anything reading `input_tokens` as "the input" fails this fixture.
    emit({
      is_error: false,
      duration_api_ms: 2412,
      num_turns: 2,
      stop_reason: "end_turn",
      session_id: sessionId,
      total_cost_usd: 0.08844199999999999,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 8140,
        cache_read_input_tokens: 12424,
        output_tokens: 9,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 8140, ephemeral_5m_input_tokens: 0 },
      },
      ...(omitModel
        ? {}
        : {
            modelUsage: {
              [reportedModel]: {
                inputTokens: 2,
                outputTokens: 9,
                cacheReadInputTokens: 12424,
                cacheCreationInputTokens: 8140,
                costUSD: 0.087847,
              },
            },
          }),
      permission_denials: [],
      terminal_reason: "completed",
      subtype: "success",
      api_error_status: null,
      result: contract,
      type: "result",
      ttft_ms: 1697,
      duration_ms: 1740,
    });
  }
}
