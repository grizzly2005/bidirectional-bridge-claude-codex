/**
 * `@bridge/gemini-side` — Gemini/Antigravity runtime for the coordination bridge.
 *
 * Depends only on `@bridge/protocol` and the runtime-neutral `@bridge/runner-adapter`;
 * it imports neither the Claude nor the Codex side.
 */

export { GeminiAdapter } from "./gemini-adapter.js";
export type { GeminiAdapterOptions } from "./gemini-adapter.js";
export {
  AntigravityRunner,
  DEFAULT_MAX_ARGV_PROMPT_CHARS,
  GEMINI_RUNTIME_NAMES,
  GEMINI_SUMMARY_MAX_CHARS,
  buildGeminiTelemetry,
  redact,
} from "./antigravity-runner.js";
export type { AntigravityRunnerOptions, BuildGeminiTelemetryInput, GeminiAuthMode } from "./antigravity-runner.js";
export {
  classifyFailure,
  emptyObservation,
  finalText,
  observeStreamLine,
  resultFailed,
} from "./antigravity-stream.js";
export type { GoogleCliDialect, StreamObservation, StreamUsage } from "./antigravity-stream.js";
