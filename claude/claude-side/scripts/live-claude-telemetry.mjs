#!/usr/bin/env node
/**
 * Live proof that the telemetry the bridge records is the telemetry the runtime reported.
 *
 *   ClaudeAdapter -> real `claude` runtime -> result frame -> ctx.reportTelemetry
 *
 * The deterministic tests parse captured frames; this parses whatever the installed binary
 * emits today. That difference is the point: a Claude Code upgrade that renames a usage
 * field would leave every unit test green and silently turn the benchmark's token counts
 * into nulls. Here, nulls fail the run.
 *
 * The delegated task is harmless and read-only — say one word, use no tool — and runs with
 * `--permission-mode plan`, so the runtime cannot edit anything even if it tried.
 *
 * ## Output discipline
 *
 * Only two things are printed: the normalized telemetry sample and the assertions over it.
 * The sample is the neutral record itself, which by construction contains no prompt, no
 * conversation, no session id and no credential — and the last assertion re-checks that
 * rather than trusting it. The runtime's own answer is never printed.
 *
 * Usage:
 *   npm --workspace @bridge/claude-side run live:telemetry
 *   node claude/claude-side/scripts/live-claude-telemetry.mjs [--claude-bin <path>]
 *
 * Requires an authenticated Claude Code (`claude` then /login, or ANTHROPIC_API_KEY).
 *
 * Exit codes:
 *   0  a real run reported complete, self-consistent, numeric telemetry
 *   1  an exception escaped
 *   2  the claude binary is not runnable
 *   3  the run produced no telemetry at all
 *   4  telemetry arrived but at least one assertion failed
 *   5  the runtime did not complete (unauthenticated, rate limited, refused)
 */

import { writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter, ClaudeCodeRunner } from "@bridge/claude-side";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const claudeBin = flag("--claude-bin", "claude");

/**
 * Write straight to fd 1.
 *
 * Under `npm run` stdout is a pipe, so `console.log` buffers asynchronously and a process
 * that exits promptly afterwards can lose its last lines — which for this script would be
 * the assertions.
 */
const say = (line = "") => {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    /* stdout closed by a supervisor; nothing useful left to do */
  }
};

/** Diagnostics go to stderr so stdout stays a clean, pasteable sample. */
const log = (line) => process.stderr.write(`${line}\n`);

/** The exact key set the neutral telemetry contract defines. */
const NEUTRAL_KEYS = new Set([
  "runtime",
  "runtime_version",
  "requested_model",
  "requested_effort",
  "model",
  "runtime_started_at",
  "first_output_at",
  "runtime_ended_at",
  "runtime_duration_ms",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "turn_count",
  "cumulative_session_tokens",
  "reported_cost_usd",
  "cost_semantics",
  "billing_mode_known",
  "prompt_bytes",
  "termination_kind",
  "process_exit_code",
]);

/**
 * Absolute timestamps are wall-clock facts about this machine, not measurements. The
 * sample keeps the derived offsets, which are what a benchmark actually compares.
 */
function redactSample(t) {
  const offset = (at) =>
    typeof at === "number" && typeof t.runtime_started_at === "number" ? at - t.runtime_started_at : null;
  return {
    runtime: t.runtime,
    runtime_version: t.runtime_version,
    requested_model: t.requested_model,
    requested_effort: t.requested_effort,
    model: t.model,
    time_to_first_output_ms: offset(t.first_output_at),
    observed_wall_ms: offset(t.runtime_ended_at),
    runtime_duration_ms: t.runtime_duration_ms,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cached_input_tokens: t.cached_input_tokens,
    cache_creation_input_tokens: t.cache_creation_input_tokens,
    total_tokens: t.total_tokens,
    turn_count: t.turn_count,
    reported_cost_usd: t.reported_cost_usd,
    cost_semantics: t.cost_semantics,
    billing_mode_known: t.billing_mode_known,
    prompt_bytes: t.prompt_bytes,
    termination_kind: t.termination_kind,
    process_exit_code: t.process_exit_code,
  };
}

const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

let exitCode = 1;

try {
  const runner = new ClaudeCodeRunner({
    command: claudeBin,
    maxTurns: 1,
    permissionMode: "plan",
    log,
  });

  const health = await runner.probe();
  log(`[live] claude runtime: ${health.ok ? "ready" : "UNAVAILABLE"} ${health.detail ?? ""}`);
  if (!health.ok) {
    log("[live] FAILED: the claude binary is not runnable");
    process.exit(2);
  }

  const adapter = new ClaudeAdapter({ runner, agent: "claude" });

  const invocation = {
    task_id: "task_livetelem",
    spec: {
      objective:
        "Reply with exactly the word LIVE_TELEMETRY_OK and nothing else. Do not use any tool " +
        "and do not modify any file.",
      // Nothing is written, so the scope is nominal; `plan` mode enforces that regardless.
      scope: { paths: ["docs/**"] },
      dependencies: [],
      expected_deliverable: "the single word LIVE_TELEMETRY_OK",
      verification_criteria: ["the reply is exactly LIVE_TELEMETRY_OK"],
    },
    inputs: [],
    workspace_root: repoRoot,
    lease_id: "lease_livetelem",
    deadline_at: Date.now() + 180_000,
    attempt: 0,
    idempotency_key: "live-telemetry:0",
    previous_execution_handle: null,
  };

  /** Capture exactly what the adapter pushes through the neutral callback. */
  const reported = [];
  let handleLength = 0;
  const deliverable = await adapter.invoke(invocation, {
    report: async () => {},
    publishArtifact: async () => "art_0000000000",
    recordVerification: async () => {},
    raiseBlocker: async () => {},
    saveExecutionHandle: async (h) => {
      handleLength = h.length;
    },
    reportTelemetry: async (u) => {
      reported.push(u);
    },
    signal: new AbortController().signal,
  });

  log(`[live] deliverable status : ${deliverable.status}`);
  log(`[live] execution handle   : ${handleLength} chars (never printed)`);

  if (reported.length === 0) {
    log("[live] FAILED: the run reported no telemetry");
    process.exit(3);
  }

  const t = reported[reported.length - 1];
  const sample = redactSample(t);

  say("# live claude telemetry — normalized, redacted");
  say(JSON.stringify(sample, null, 2));
  say("");

  if (t.termination_kind !== "completed") {
    say(`# ABORTED: termination_kind=${t.termination_kind}; the runtime never completed a turn.`);
    say("# Authenticate Claude Code (`claude` then /login, or ANTHROPIC_API_KEY) and re-run.");
    process.exit(5);
  }

  /*
   * Assertions, not a report. Each one is a property that must hold of any run on any
   * bridge-owned profile, so a runtime change that breaks the mapping fails here instead of quietly
   * degrading the benchmark.
   */
  const checks = [
    ["reportTelemetry called exactly once", reported.length === 1],
    ["input_tokens is a positive count", isCount(t.input_tokens) && t.input_tokens > 0],
    ["output_tokens is a positive count", isCount(t.output_tokens) && t.output_tokens > 0],
    ["total_tokens is a positive count", isCount(t.total_tokens) && t.total_tokens > 0],
    ["total_tokens === input_tokens + output_tokens", t.total_tokens === t.input_tokens + t.output_tokens],
    [
      "cached_input_tokens is a count within input_tokens",
      isCount(t.cached_input_tokens) && t.cached_input_tokens <= t.input_tokens,
    ],
    [
      "cache_creation_input_tokens is a count within input_tokens",
      isCount(t.cache_creation_input_tokens) && t.cache_creation_input_tokens <= t.input_tokens,
    ],
    [
      "cache categories do not exceed the input total",
      t.cached_input_tokens + t.cache_creation_input_tokens <= t.input_tokens,
    ],
    ["turn_count is a positive count", isCount(t.turn_count) && t.turn_count > 0],
    ["runtime_duration_ms is a non-negative number", typeof t.runtime_duration_ms === "number" && t.runtime_duration_ms >= 0],
    ["prompt_bytes is a positive count", isCount(t.prompt_bytes) && t.prompt_bytes > 0],
    ["process_exit_code === 0", t.process_exit_code === 0],
    ["runtime is claude-code", t.runtime === "claude-code"],
    ["runtime_version was reported", typeof t.runtime_version === "string" && t.runtime_version.length > 0],
    ["requested_model === opus", t.requested_model === "opus"],
    ["requested_effort === high", t.requested_effort === "high"],
    ["model was reported", typeof t.model === "string" && t.model.length > 0],
    [
      "reported_cost_usd is a non-negative number",
      typeof t.reported_cost_usd === "number" && t.reported_cost_usd >= 0,
    ],
    ["cost_semantics === runtime_reported", t.cost_semantics === "runtime_reported"],
    ["billing_mode_known === false", t.billing_mode_known === false],
    ["no key outside the neutral contract", Object.keys(t).every((k) => NEUTRAL_KEYS.has(k))],
    [
      "no prompt text, session id, or credential in the record",
      !/LIVE_TELEMETRY_OK|Objective|sk-ant-|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(
        JSON.stringify(t),
      ),
    ],
  ];

  say("# assertions");
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed += 1;
    say(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  say("");
  say(`# ${checks.length - failed}/${checks.length} passed`);

  exitCode = failed === 0 ? 0 : 4;
} catch (err) {
  log(`[live] FAILED with an exception: ${err?.stack ?? String(err)}`);
  exitCode = 1;
}

process.exit(exitCode);
