/**
 * Claude-side adapter.
 *
 * Two ways Claude participates in the bridge:
 *
 *  A. Claude as the *delegate* — some other agent hands Claude a task. Claude Code /
 *     Cowork is not an HTTP endpoint you can call synchronously, so the task is handed to
 *     a Claude session through an injected runner. The production implementation is
 *     `ClaudeCodeRunner`, which drives a bounded `claude -p` subprocess; `functionRunner`
 *     remains as a test seam.
 *
 *  B. Claude as the *caller* — Claude is already running and records its own work in the
 *     control plane through `ClaudeWorkSession`.
 *
 * The admission, cancellation, telemetry and honesty-gate logic is runtime-neutral and
 * lives in `@bridge/runner-adapter`, shared with the Antigravity/Gemini runtime. This
 * subclass only fixes the Claude identity, so diagnostics stay byte-identical.
 */

import {
  RunnerAdapter,
  type AgentRunResult,
  type AgentRunner,
  type RunnerAdapterOptions,
} from "@bridge/runner-adapter";

export { functionRunner, projectTelemetryUpdate } from "@bridge/runner-adapter";

/** How a Claude session gets driven; identical to the runtime-neutral runner contract. */
export type ClaudeRunner = AgentRunner;
export type ClaudeRunResult = AgentRunResult;
export type ClaudeAdapterOptions = Omit<RunnerAdapterOptions, "label" | "slug">;

export class ClaudeAdapter extends RunnerAdapter {
  constructor(options: ClaudeAdapterOptions) {
    super({ ...options, label: "Claude", slug: "claude" });
  }
}
