/**
 * Parsing of the headless JSONL stream emitted by Google's agent CLIs.
 *
 * Two dialects are understood, because both binaries can coexist on one machine:
 *
 *  - Antigravity CLI (`agy -p … --output-format stream-json`), the supported CLI for Google
 *    AI Pro/Ultra accounts since June 2026. Each line is `{ "event": <name>, <name>: {…} }`
 *    with `init`, `step_update` and `result` events; `result` carries `conversation_id`,
 *    `status`, `response`, `num_turns`, `duration_seconds` and `usage`.
 *  - legacy Gemini CLI (`gemini -p … -o stream-json`), still served to some enterprise and
 *    API-key users. Each line is `{ "type": <name>, … }` with `init` (`session_id`, `model`),
 *    `message`, `tool_use`, `tool_result`, `error` and `result` (`stats`).
 *
 * Only fields the runtime stated are kept; nothing is inferred from model-authored text.
 * Unknown fields and events are ignored so additive CLI releases do not break the bridge.
 */

export type GoogleCliDialect = "antigravity" | "gemini-cli";

export interface StreamObservation {
  /** Runtime conversation/session id, first seen. Opaque; persisted as the execution handle. */
  sessionId: string | null;
  /** Model named by the runtime itself (init or result), when it states one. */
  model: string | null;
  /** Concatenated assistant text deltas, a fallback when `result.response` is absent. */
  assistantText: string;
  /** Final response text from the result envelope. */
  response: string | null;
  /** Result status as reported (e.g. SUCCESS, ERROR, CANCELED, success, error). */
  status: string | null;
  /** Runtime-reported error message, if any (never echoed to other agents unbounded). */
  error: string | null;
  turns: number | null;
  durationMs: number | null;
  usage: StreamUsage;
  sawResult: boolean;
  sawOutput: boolean;
}

export interface StreamUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  cached_input_tokens: number | null;
  total_tokens: number | null;
}

export function emptyObservation(): StreamObservation {
  return {
    sessionId: null, model: null, assistantText: "", response: null, status: null, error: null,
    turns: null, durationMs: null, sawResult: false, sawOutput: false,
    usage: { input_tokens: null, output_tokens: null, thinking_tokens: null, cached_input_tokens: null, total_tokens: null },
  };
}

const MAX_TEXT = 2_000_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown, max = 4_096): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function sessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

function appendText(observation: StreamObservation, text: unknown): void {
  if (typeof text !== "string" || text.length === 0) return;
  observation.sawOutput = true;
  if (observation.assistantText.length < MAX_TEXT) {
    observation.assistantText = (observation.assistantText + text).slice(0, MAX_TEXT);
  }
}

function mergeUsage(target: StreamUsage, raw: unknown): void {
  const usage = record(raw);
  if (!usage) return;
  const pick = (...names: string[]): number | null => {
    for (const name of names) {
      const value = count(usage[name]);
      if (value !== null) return value;
    }
    return null;
  };
  const input = pick("input_tokens", "inputTokens", "prompt_tokens", "input");
  const output = pick("output_tokens", "outputTokens", "candidates_tokens", "output");
  const thinking = pick("thinking_tokens", "thoughts_tokens", "thoughtsTokens", "reasoning_tokens");
  const cached = pick("cache_read_tokens", "cached_tokens", "cached", "cachedContentTokenCount");
  const total = pick("total_tokens", "totalTokens", "total");
  if (input !== null) target.input_tokens = input;
  if (output !== null) target.output_tokens = output;
  if (thinking !== null) target.thinking_tokens = thinking;
  if (cached !== null) target.cached_input_tokens = cached;
  if (total !== null) target.total_tokens = total;
}

/** Fold one decoded JSONL line into the observation. Returns the event name, if any. */
export function observeStreamLine(observation: StreamObservation, line: unknown): string | null {
  const frame = record(line);
  if (!frame) return null;
  const event = str(frame["event"], 64) ?? str(frame["type"], 64);
  if (!event) return null;
  // Antigravity nests the payload under the event name; Gemini CLI keeps it flat.
  const payload = record(frame[event]) ?? frame;
  observation.sessionId ??= sessionId(frame["conversation_id"]) ?? sessionId(payload["conversation_id"])
    ?? sessionId(frame["session_id"]) ?? sessionId(payload["session_id"]);
  switch (event) {
    case "init":
      observation.model ??= str(payload["model"], 256);
      break;
    case "step_update": {
      const stepType = str(payload["step_type"], 64);
      if (stepType === "agent_response") appendText(observation, payload["text_delta"]);
      if (payload["text_delta"] !== undefined || stepType === "tool") observation.sawOutput = true;
      break;
    }
    case "message": {
      if (payload["role"] === "assistant") appendText(observation, payload["content"]);
      break;
    }
    case "tool_use":
    case "tool_result":
      observation.sawOutput = true;
      break;
    case "error":
      observation.error ??= str(payload["message"], 2_000) ?? str(payload["error"], 2_000);
      break;
    case "result": {
      observation.sawResult = true;
      observation.status = str(payload["status"], 64);
      const response = typeof payload["response"] === "string" ? payload["response"] : null;
      if (response !== null) observation.response = response.slice(0, MAX_TEXT);
      const error = record(payload["error"]);
      observation.error = str(payload["error"], 2_000) ?? str(error?.["message"], 2_000) ?? observation.error;
      observation.turns = count(payload["num_turns"]) ?? observation.turns;
      const seconds = typeof payload["duration_seconds"] === "number" ? payload["duration_seconds"] : null;
      const stats = record(payload["stats"]);
      observation.durationMs = seconds !== null && Number.isFinite(seconds) && seconds >= 0
        ? Math.round(seconds * 1000) : count(stats?.["duration_ms"]) ?? count(payload["duration_ms"]) ?? observation.durationMs;
      mergeUsage(observation.usage, payload["usage"]);
      mergeUsage(observation.usage, stats);
      observation.model ??= str(payload["model"], 256);
      break;
    }
    default:
      break;
  }
  return event;
}

/** Final text the structured result is parsed from. */
export function finalText(observation: StreamObservation): string {
  return observation.response ?? observation.assistantText;
}

const FAILED_STATUSES = new Set(["error", "invalid", "canceled", "cancelled", "interrupted", "failed", "failure"]);

export function resultFailed(observation: StreamObservation): boolean {
  return observation.status !== null && FAILED_STATUSES.has(observation.status.toLowerCase());
}

/** Coarse, retry-relevant classification of a runtime failure from runtime-stated text. */
export function classifyFailure(text: string): "quota" | "auth" | "transient" | "profile" | "unknown" {
  const value = text.toLowerCase();
  if (/(quota|rate.?limit|resource.?exhausted|429|credits? (?:exhausted|depleted)|usage limit)/u.test(value)) return "quota";
  if (/(unauthori[sz]ed|unauthenticated|not (?:logged|signed) in|login required|401|403|permission denied|oauth)/u.test(value)) return "auth";
  if (/(unknown model|invalid model|model .*not (?:found|available|supported))/u.test(value)) return "profile";
  if (/(timeout|timed out|econnreset|unavailable|503|502|overloaded|network)/u.test(value)) return "transient";
  return "unknown";
}
