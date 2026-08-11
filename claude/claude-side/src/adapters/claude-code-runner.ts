/**
 * The real Claude execution path: a bounded Claude Code subprocess.
 *
 * Before this file, `ClaudeAdapter` could only be driven by an injected `functionRunner` —
 * a test seam, not a runtime. This runner closes that gap by driving the supported
 * non-interactive programmatic interface of the Claude Code CLI:
 *
 *   claude -p <prompt> --output-format stream-json --verbose \
 *     --model opus --effort high --max-turns N ...
 *
 * ## Facts this implementation relies on
 *
 * The stream shape was captured from 2.1.222; the protected model/effort flags were also
 * confirmed in the installed 2.1.226 CLI help without starting a paid model invocation.
 *
 * `--output-format stream-json --verbose` emits newline-delimited JSON. The first line is
 * always the session init frame:
 *
 *   {"type":"system","subtype":"init","cwd":...,"session_id":"<uuid>","tools":[...],...}
 *
 * and the last is the result frame:
 *
 *   {"type":"result","subtype":"success","session_id":...,"result":"<text>",
 *    "is_error":false,"num_turns":N,"total_cost_usd":...,"duration_ms":...}
 *
 * The session id therefore arrives *before any model work happens*, which is what makes
 * requirement 3 (persist the handle the moment it exists) satisfiable rather than
 * best-effort. Note the `type` key is not first in the object, so frames must be parsed as
 * JSON rather than prefix-matched.
 *
 * ## Bounding
 *
 * Every axis of "how far can this run get" is closed:
 *  - contract  — the prompt is generated from the `TaskSpec`, not free text
 *  - cwd       — the child runs in `invocation.workspace_root`
 *  - scope     — `--add-dir` limits tool access to the leased paths
 *  - turns     — `--max-turns`
 *  - time      — the child is killed at `invocation.deadline_at`
 *  - cancel    — `ctx.signal` triggers SIGTERM then SIGKILL
 *  - prompts   — `-p` with stdin closed and an explicit non-interactive permission mode,
 *                so the child can never block waiting for a human
 *  - output    — a fenced JSON block parsed into a structured result
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  AttemptTerminationKind,
  BridgeError,
  DEFAULT_TASK_MAX_TURNS,
  ErrorCode,
  MAX_TASK_MAX_TURNS,
  MIN_TASK_MAX_TURNS,
  TaskState,
  TelemetryCostSemantics,
  type AttemptTelemetryUpdate,
  type ArtifactId,
  type InvocationContext,
  type TaskInvocation,
  type VerificationResult,
} from "@bridge/protocol";
import type { ClaudeRunResult, ClaudeRunner } from "./claude-adapter.js";

/* ------------------------------------------------------------------ *
 * Stream protocol
 * ------------------------------------------------------------------ */

export interface ClaudeInitFrame {
  readonly type: "system";
  readonly subtype: "init";
  readonly session_id: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly tools?: readonly string[];
  /** Emitted by 2.1.x as `claude_code_version`; `version` is tolerated for older builds. */
  readonly claude_code_version?: string;
  readonly version?: string;
}

/**
 * The token accounting the runtime attaches to its result frame.
 *
 * The names are Anthropic's, and they are *categories of input*, not independent totals:
 * `input_tokens` counts only the uncached part of the prompt, with the cached part split
 * between `cache_read_input_tokens` (reused) and `cache_creation_input_tokens` (written).
 * A consumer that reads `input_tokens` alone therefore under-reports a cached run by
 * orders of magnitude — 2 instead of 20566 on the run this parser was verified against.
 */
export interface ClaudeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  /** Per-TTL breakdown of the cache write; summed when the flat field is absent. */
  readonly cache_creation?: Readonly<Record<string, unknown>>;
}

export interface ClaudeResultFrame {
  readonly type: "result";
  readonly subtype?: string;
  readonly session_id: string;
  readonly result?: string;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  /** Time spent inside the model API, as opposed to the whole run. */
  readonly duration_api_ms?: number;
  readonly usage?: ClaudeUsage;
  /** Per-model breakdown, used only as a fallback source for the model identifier. */
  readonly modelUsage?: Readonly<Record<string, unknown>>;
  readonly terminal_reason?: string;
  readonly permission_denials?: readonly unknown[];
}

export type ClaudeFrame = ClaudeInitFrame | ClaudeResultFrame | { type: string; [k: string]: unknown };

/**
 * Permission modes safe for unattended execution.
 *
 * `bypassPermissions` is deliberately absent: a delegated task running with all checks
 * disabled could write anywhere on the machine, which defeats the lease system the bridge
 * is built on. A caller who truly wants it must pass it explicitly as a raw string and
 * accept the consequence.
 */
export const SAFE_PERMISSION_MODES = ["plan", "acceptEdits", "dontAsk", "default"] as const;
export type ClaudePermissionMode = (typeof SAFE_PERMISSION_MODES)[number] | string;

export interface ClaudeCodeRunnerOptions {
  /** Executable to spawn. Override to test against a stand-in. Default `claude`. */
  readonly command?: string;
  /** Extra args appended last, for flags this wrapper does not model. */
  readonly extraArgs?: readonly string[];
  /**
   * Turn ceiling. A delegated task that cannot finish in this many turns should come back
   * PARTIAL rather than run until the deadline. This is the conservative default; a task's
   * validated `spec.max_turns` may request a larger or smaller bounded value.
   */
  readonly maxTurns?: number;
  /** Default `plan` — read-only. Callers that need edits opt in explicitly. */
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Grant tool access to the task's leased scope directories. Default true. */
  readonly addScopeDirs?: boolean;
  /** Pass `--resume` when a previous attempt left a handle. Default true. */
  readonly allowResume?: boolean;
  /** Milliseconds between SIGTERM and SIGKILL when cancelling. Default 5000. */
  readonly killGraceMs?: number;
  /** Diagnostics sink. Never stdout — a launcher's stdout is the MCP transport. */
  readonly log?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ClaudeStructuredOutput {
  readonly summary?: string;
  /** Canonical durable deliverable field. */
  readonly changed_scope?: readonly string[];
  /** Legacy Claude-runner alias retained for existing resumable sessions. */
  readonly changed_files?: readonly string[];
  /** Canonical structured evidence field from the protocol Deliverable. */
  readonly verification_results?: readonly VerificationResult[];
  /** Legacy Claude-runner alias retained for existing resumable sessions. */
  readonly verifications?: readonly VerificationResult[];
  readonly remaining_risks?: readonly string[];
  readonly recommended_next_action?: string;
  readonly blocker?: string;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

/** Bridge-owned Claude profile. Delegation payloads and launcher defaults cannot replace it. */
export const CLAUDE_REQUESTED_MODEL = "opus";
export const CLAUDE_REQUESTED_EFFORT = "high";
export const CLAUDE_AUDIT_RECOMMENDED_MAX_TURNS = 32;
/** Keep summaries concise; the complete long-form output is preserved as report artifacts. */
export const CLAUDE_SUMMARY_MAX_CHARS = 4_000;
/** Leave headroom below ArtifactRegistry's default 64 KiB inline ceiling. */
export const CLAUDE_REPORT_CHUNK_MAX_BYTES = 60 * 1024;

const PROTECTED_CLAUDE_FLAGS = ["--model", "--effort", "--max-turns"] as const;

function validatedMaxTurns(value: number, source: string): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_TASK_MAX_TURNS ||
    value > MAX_TASK_MAX_TURNS
  ) {
    throw new BridgeError(
      ErrorCode.INVALID_ARGUMENT,
      `${source} must be an integer from ${MIN_TASK_MAX_TURNS} through ${MAX_TASK_MAX_TURNS}`,
      { source, value, minimum: MIN_TASK_MAX_TURNS, maximum: MAX_TASK_MAX_TURNS },
    );
  }
  return value;
}

function assertNoProtectedExtraArgs(extraArgs: readonly string[]): void {
  const protectedArg = extraArgs.find((arg) =>
    PROTECTED_CLAUDE_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (protectedArg) {
    throw new BridgeError(
      ErrorCode.INVALID_ARGUMENT,
      `extraArgs cannot override bridge-owned Claude option '${protectedArg}'`,
      { protected_option: protectedArg },
    );
  }
}

/** Accept aliases and versioned identifiers only when `opus` is a complete family token. */
export function isOpusFamilyModel(model: string): boolean {
  return /(^|[-_.:/])opus($|[-_.:/])/iu.test(model.trim());
}

/* ------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------ */

/** Identifies the runtime in the neutral record, independent of the binary's path. */
export const CLAUDE_RUNTIME_NAME = "claude-code";

/**
 * Token counts after the Claude categories have been collapsed into neutral ones.
 *
 * `input_tokens` here is the *whole* prompt — uncached + cache read + cache creation — so
 * it is comparable with a runtime that never caches. The two cache dimensions are kept
 * alongside it as subdimensions, not addends: adding them to `input_tokens` again would
 * double-count.
 */
export interface NormalizedClaudeUsage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
  readonly total_tokens: number | null;
}

export const EMPTY_CLAUDE_USAGE: NormalizedClaudeUsage = {
  input_tokens: null,
  output_tokens: null,
  cached_input_tokens: null,
  cache_creation_input_tokens: null,
  total_tokens: null,
};

/** A count is only usable if it is a finite, non-negative number. `null` otherwise. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Sum the counts that are actually present; `null` when none of them are. */
function sumPresent(parts: readonly (number | null)[]): number | null {
  const present = parts.filter((p): p is number => p !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * Collapse a Claude `usage` object into the neutral shape.
 *
 * Tolerant by design: a runtime upgrade that drops or renames a field must degrade to
 * `null` rather than throw or silently produce a wrong number, because this feeds a
 * benchmark where a plausible-but-wrong token count is worse than a missing one.
 */
export function normalizeClaudeUsage(usage: unknown): NormalizedClaudeUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return EMPTY_CLAUDE_USAGE;
  const u = usage as ClaudeUsage;

  const uncached = count(u.input_tokens);
  const cacheRead = count(u.cache_read_input_tokens);
  // 2.1.x emits the flat field; the per-TTL map is the fallback for builds that do not.
  const cacheCreation =
    count(u.cache_creation_input_tokens) ??
    (u.cache_creation && typeof u.cache_creation === "object"
      ? sumPresent(Object.values(u.cache_creation).map(count))
      : null);

  const input = sumPresent([uncached, cacheRead, cacheCreation]);
  const output = count(u.output_tokens);

  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    // Deliberately not `usage.total_tokens` (the runtime emits none): a total that does not
    // equal its own parts would make every derived cost-per-token figure unauditable.
    total_tokens: input !== null && output !== null ? input + output : null,
  };
}

/**
 * Everything the Claude runtime authoritatively reported about one attempt.
 *
 * A Claude-shaped superset of the neutral update: it keeps `api_duration_ms`, which has no
 * neutral counterpart, for diagnostics and the live sample. What it deliberately does not
 * carry is the session id, the prompt, or any raw frame — the execution handle travels
 * through `saveExecutionHandle`, and telemetry is a shared, supervisor-readable record.
 */
export interface ClaudeRunnerTelemetry {
  readonly runtime: typeof CLAUDE_RUNTIME_NAME;
  readonly runtime_version: string | null;
  readonly requested_model: typeof CLAUDE_REQUESTED_MODEL;
  readonly requested_effort: typeof CLAUDE_REQUESTED_EFFORT;
  readonly model: string | null;
  readonly runtime_started_at: number;
  readonly first_output_at: number | null;
  readonly runtime_ended_at: number | null;
  readonly runtime_duration_ms: number | null;
  /** `duration_api_ms` from the result frame; no neutral field exists for it. */
  readonly api_duration_ms: number | null;
  readonly usage: NormalizedClaudeUsage;
  readonly turn_count: number | null;
  readonly reported_cost_usd: number | null;
  readonly cost_semantics: TelemetryCostSemantics;
  readonly billing_mode_known: boolean;
  readonly prompt_bytes: number;
  readonly termination_kind: AttemptTerminationKind;
  readonly process_exit_code: number | null;
}

/** Project the Claude-shaped record onto the runtime-neutral update the bridge stores. */
export function toTelemetryUpdate(t: ClaudeRunnerTelemetry): AttemptTelemetryUpdate {
  return {
    runtime: t.runtime,
    runtime_version: t.runtime_version,
    requested_model: t.requested_model,
    requested_effort: t.requested_effort,
    model: t.model,
    runtime_started_at: t.runtime_started_at,
    first_output_at: t.first_output_at,
    runtime_ended_at: t.runtime_ended_at,
    runtime_duration_ms: t.runtime_duration_ms,
    input_tokens: t.usage.input_tokens,
    output_tokens: t.usage.output_tokens,
    cached_input_tokens: t.usage.cached_input_tokens,
    cache_creation_input_tokens: t.usage.cache_creation_input_tokens,
    total_tokens: t.usage.total_tokens,
    turn_count: t.turn_count,
    reported_cost_usd: t.reported_cost_usd,
    cost_semantics: t.cost_semantics,
    billing_mode_known: t.billing_mode_known,
    prompt_bytes: t.prompt_bytes,
    termination_kind: t.termination_kind,
    process_exit_code: t.process_exit_code,
  };
}

/**
 * Build the task contract handed to the runtime.
 *
 * Generated from the `TaskSpec` rather than accepting free-form text: the delegate must
 * receive the same contract the control plane will judge the deliverable against, or the
 * verification gate rejects work the agent thought it had finished.
 */
export function buildPrompt(invocation: TaskInvocation, resuming: boolean): string {
  const { spec } = invocation;
  const lines: string[] = [];

  if (resuming) {
    lines.push(
      "You are resuming a previously interrupted task in this same session.",
      "Continue from where you left off; do not restart work that is already done.",
      "",
    );
  }

  lines.push(
    "You are executing a bounded task delegated through a multi-agent coordination bridge.",
    "",
    `## Objective`,
    spec.objective,
    "",
    `## Expected deliverable`,
    spec.expected_deliverable,
    "",
    `## Verification criteria`,
    ...spec.verification_criteria.map((c) => `- ${c}`),
    "",
    `## Write scope (STRICT)`,
    "You may only modify files matching these repo-relative globs:",
    ...spec.scope.paths.map((p) => `- ${p}`),
    "",
    "Writing outside this scope is a contract violation: another agent holds a lease on",
    "those paths and your changes would be discarded or would corrupt their work.",
    "If the task cannot be completed within this scope, stop and report a blocker.",
    "",
    "## Rules",
    "- Do not ask interactive questions; you will receive no answer.",
    "- Only claim a verification passed if you actually ran the command and saw its exit code.",
    "- If you cannot finish, report what you did and set a blocker rather than guessing.",
    "- For a substantial audit or report, put the detailed report before the final JSON block.",
    "  Keep the JSON summary concise; the bridge preserves long final output as report artifacts.",
    "",
    "## Required final output",
    "End your final message with a fenced JSON block in exactly this shape:",
    "",
    "```json",
    "{",
    '  "summary": "concise synthesis, one paragraph",',
    '  "changed_scope": ["repo/relative/path.ts"],',
    '  "verification_results": [',
    '    {"kind": "test", "command": "npm test", "passed": true, "exit_code": 0, "summary": "12 passed"}',
    "  ],",
    '  "remaining_risks": [],',
    '  "recommended_next_action": "what should happen next",',
    '  "blocker": null',
    "}",
    "```",
    "",
    "`kind` must be one of: test, typecheck, build, lint, static_analysis, benchmark, manual.",
    "Use an empty verification_results array if you genuinely ran no checks — do not invent them.",
    "Do not emit verification_performed; the bridge derives it from verification_results.",
  );

  return lines.join("\n");
}

/**
 * Extract the trailing fenced JSON block.
 *
 * Scans from the end because the model may legitimately show JSON earlier while explaining
 * its work; the contract block is the last one. A missing or malformed block is not fatal —
 * the caller degrades to an unstructured summary, which the honesty gate then treats as
 * unverified.
 */
export function parseStructuredOutput(text: string): ClaudeStructuredOutput | null {
  if (!text) return null;
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  const blocks: string[] = [];
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) {
    if (m[1]) blocks.push(m[1]);
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i]!) as ClaudeStructuredOutput;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next-most-recent block.
    }
  }
  // Last resort: a bare JSON object with no fence.
  const start = text.lastIndexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as ClaudeStructuredOutput;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* genuinely unstructured */
    }
  }
  return null;
}

/** Only keep verification entries that carry real evidence of having run. */
function sanitizeVerifications(input: unknown): VerificationResult[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(["test", "typecheck", "build", "lint", "static_analysis", "benchmark", "manual"]);
  const out: VerificationResult[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    if (typeof v["kind"] !== "string" || !allowed.has(v["kind"] as string)) continue;
    if (typeof v["command"] !== "string" || v["command"].length < 1 || v["command"].length > 2_000) continue;
    if (typeof v["passed"] !== "boolean") continue;
    if (!(v["exit_code"] === null || Number.isInteger(v["exit_code"]))) continue;
    if (typeof v["summary"] !== "string" || v["summary"].length > 4_000) continue;
    out.push({
      kind: v["kind"] as VerificationResult["kind"],
      command: v["command"],
      passed: v["passed"],
      exit_code: v["exit_code"] as number | null,
      summary: v["summary"],
      ...(Number.isInteger(v["duration_ms"]) && (v["duration_ms"] as number) >= 0
        ? { duration_ms: v["duration_ms"] as number }
        : {}),
      ...(typeof v["output_excerpt"] === "string" && v["output_excerpt"].length <= 20_000
        ? { output_excerpt: v["output_excerpt"] }
        : {}),
    });
  }
  return out;
}

function boundedSummary(value: string | undefined): string {
  const normalized = value?.trim() || "claude runtime completed";
  return normalized.slice(0, CLAUDE_SUMMARY_MAX_CHARS);
}

/** Split on Unicode code-point boundaries so every inline chunk remains valid UTF-8. */
function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  if (current || value.length === 0) chunks.push(current);
  return chunks;
}

async function preserveDetailedReport(text: string, ctx: InvocationContext): Promise<ArtifactId[]> {
  if (text.length <= CLAUDE_SUMMARY_MAX_CHARS) return [];
  const chunks = splitUtf8(text, CLAUDE_REPORT_CHUNK_MAX_BYTES);
  const reportSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const artifacts: ArtifactId[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const sequence = index + 1;
    const name =
      chunks.length === 1
        ? "claude-report.md"
        : `claude-report.part-${String(sequence).padStart(3, "0")}-of-${String(chunks.length).padStart(3, "0")}.md`;
    artifacts.push(
      await ctx.publishArtifact({
        kind: "report",
        name,
        media_type: "text/markdown",
        inline: chunks[index]!,
        metadata: {
          source: "claude-final-output",
          sequence,
          total_chunks: chunks.length,
          complete_report_sha256: reportSha256,
        },
      }),
    );
  }
  return artifacts;
}

export class ClaudeCodeRunner implements ClaudeRunner {
  readonly description: string;
  private readonly options: ClaudeCodeRunnerOptions;
  private readonly command: string;
  private readonly log: (line: string) => void;
  private readonly defaultMaxTurns: number;
  /** Session ids seen per task, so `cancel` and diagnostics can reference them. */
  readonly lastSessionId = new Map<string, string>();
  /**
   * Telemetry for the last run of each task.
   *
   * Kept here as well as on the result because the failure paths do not return a result at
   * all: a run that produced no result frame throws, and that attempt is exactly the one a
   * benchmark must still be able to account for.
   */
  readonly lastTelemetry = new Map<string, ClaudeRunnerTelemetry>();

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    assertNoProtectedExtraArgs(options.extraArgs ?? []);
    this.options = options;
    this.command = options.command ?? "claude";
    this.log = options.log ?? (() => {});
    this.defaultMaxTurns = validatedMaxTurns(
      options.maxTurns ?? DEFAULT_TASK_MAX_TURNS,
      "Claude default maxTurns",
    );
    this.description = `claude-code-cli(${this.command})`;
  }

  /** Cheap readiness probe: the binary exists and reports a version. */
  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const child = spawn(this.command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      let err = "";
      child.stderr.on("data", (c: Buffer) => (err += c.toString()));
      const [code] = (await once(child, "exit")) as [number | null];
      if (code !== 0) return { ok: false, detail: err.trim() || `exit ${code}` };
      return { ok: true, detail: out.trim() };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  buildArgs(invocation: TaskInvocation, prompt: string): string[] {
    const o = this.options;
    const maxTurns = validatedMaxTurns(
      invocation.spec.max_turns ?? this.defaultMaxTurns,
      "TaskSpec.max_turns",
    );
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      // stream-json requires verbose; without it the CLI refuses the combination.
      "--verbose",
      "--model",
      CLAUDE_REQUESTED_MODEL,
      "--effort",
      CLAUDE_REQUESTED_EFFORT,
      "--max-turns",
      String(maxTurns),
      "--permission-mode",
      o.permissionMode ?? "plan",
    ];

    // Resume the previous attempt's session rather than starting cold.
    const resume = o.allowResume !== false && invocation.previous_execution_handle;
    if (resume) args.push("--resume", invocation.previous_execution_handle as string);

    if (o.addScopeDirs !== false) {
      // Grant tool access to the leased scope. Glob metacharacters are stripped to the
      // containing directory, since --add-dir takes directories, not patterns.
      const dirs = new Set<string>();
      for (const p of invocation.spec.scope.paths) {
        const dir = p.replace(/\/?\*\*.*$/, "").replace(/\/[^/]*[*?].*$/, "");
        if (dir && !dir.includes("*") && !dir.includes("?")) dirs.add(dir);
      }
      for (const d of dirs) args.push("--add-dir", d);
    }

    if (o.allowedTools?.length) args.push("--allowed-tools", ...o.allowedTools);
    if (o.disallowedTools?.length) args.push("--disallowed-tools", ...o.disallowedTools);
    if (o.extraArgs?.length) args.push(...o.extraArgs);

    return args;
  }

  async run(invocation: TaskInvocation, ctx: InvocationContext): Promise<ClaudeRunResult> {
    if (
      invocation.resume_required === true &&
      (this.options.allowResume === false || !invocation.previous_execution_handle)
    ) {
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        "strict resume requires Claude Code resume support and a persisted session id",
        { task_id: invocation.task_id, attempt: invocation.attempt },
      );
    }
    const resuming = this.options.allowResume !== false && Boolean(invocation.previous_execution_handle);
    const prompt = buildPrompt(invocation, resuming);
    const args = this.buildArgs(invocation, prompt);

    // stdin is "ignore", not a pipe: a non-interactive run must be structurally incapable
    // of blocking on input. That makes `stdin` null, hence the narrower child type here.
    const startedAt = Date.now();
    const child = spawn(this.command, args, {
      cwd: invocation.workspace_root,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.options.env ?? process.env,
    });

    let sessionId: string | null = null;
    let resultFrame: ClaudeResultFrame | null = null;
    let stderr = "";
    let stdoutTail = "";
    let buffer = "";
    let killedForDeadline = false;
    let killedForCancel = false;

    // Runtime identity, taken from the frames that authoritatively carry it.
    let runtimeVersion: string | null = null;
    let model: string | null = null;
    let firstOutputAt: number | null = null;

    const frames: ClaudeFrame[] = [];

    /* ---- bounding: deadline and cancellation both terminate the child ---- */

    const killGrace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const hardKill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(hardKill, killGrace).unref?.();
    };

    const remaining = invocation.deadline_at - Date.now();
    const deadlineTimer =
      remaining > 0
        ? setTimeout(() => {
            killedForDeadline = true;
            this.log(`[claude-runner] deadline reached for ${invocation.task_id}; terminating`);
            stop();
          }, remaining)
        : null;
    // A deadline already in the past means the orchestrator handed us no budget at all.
    if (remaining <= 0) {
      killedForDeadline = true;
      stop();
    }

    const onAbort = (): void => {
      killedForCancel = true;
      this.log(`[claude-runner] cancelled ${invocation.task_id}; terminating`);
      stop();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    /* ---- stream parsing ---- */

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    const handleFrame = async (frame: ClaudeFrame): Promise<void> => {
      frames.push(frame);
      const id = (frame as { session_id?: unknown }).session_id;

      // Requirement 3: persist the real session id the instant it exists. The init frame
      // arrives before any model work, so a run that dies mid-task is still resumable.
      if (typeof id === "string" && id && sessionId === null) {
        sessionId = id;
        this.lastSessionId.set(invocation.task_id, id);
        try {
          await ctx.saveExecutionHandle(id);
          this.log(`[claude-runner] session ${id} persisted for ${invocation.task_id}`);
        } catch (err) {
          // Losing resumability is bad but not fatal; the task itself can still succeed.
          this.log(`[claude-runner] could not persist session id: ${(err as Error).message}`);
        }
      }

      // Runtime and model come from the init frame when the runtime emits them; nothing is
      // inferred from assistant text, which is model-authored and therefore not evidence.
      if (frame.type === "system" && (frame as ClaudeInitFrame).subtype === "init") {
        const init = frame as ClaudeInitFrame;
        runtimeVersion = init.claude_code_version ?? init.version ?? runtimeVersion;
        model = init.model ?? model;
      }

      // First model output — not the init frame, which is emitted at startup before any
      // model work and would make time-to-first-output indistinguishable from spawn time.
      if (frame.type === "assistant" || frame.type === "result") {
        firstOutputAt ??= Date.now();
        if (model === null) {
          const m = (frame as { message?: { model?: unknown } }).message?.model;
          if (typeof m === "string" && m) model = m;
        }
      }

      if (frame.type === "result") {
        resultFrame = frame as ClaudeResultFrame;
      }
    };

    // Frames are handled sequentially: `saveExecutionHandle` is async and two concurrent
    // init frames would otherwise race to write the handle.
    let chain: Promise<void> = Promise.resolve();
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      stdoutTail = (stdoutTail + chunk).slice(-8_000);
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let frame: ClaudeFrame;
        try {
          frame = JSON.parse(line) as ClaudeFrame;
        } catch {
          continue; // non-JSON noise on stdout is ignored, not fatal
        }
        chain = chain.then(() => handleFrame(frame));
      }
    });

    /* ---- await completion ---- */

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    try {
      const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
      exitCode = code;
      exitSignal = signal;
      await chain; // drain any frame still being handled
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      ctx.signal.removeEventListener("abort", onAbort);
    }

    /* ---- telemetry: what the runtime itself reported about this attempt ---- */

    const endedAt = Date.now();
    let telemetry = buildRunnerTelemetry({
      frame: resultFrame,
      runtime_version: runtimeVersion,
      model,
      started_at: startedAt,
      first_output_at: firstOutputAt,
      ended_at: endedAt,
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      exit_code: exitCode,
      exit_signal: exitSignal,
      cancelled: killedForCancel,
      timed_out: killedForDeadline,
    });
    const profileMismatch =
      telemetry.model !== null && !isOpusFamilyModel(telemetry.model);
    if (profileMismatch) {
      telemetry = { ...telemetry, termination_kind: AttemptTerminationKind.FAILED };
    }
    this.lastTelemetry.set(invocation.task_id, telemetry);
    const telemetryUpdate = toTelemetryUpdate(telemetry);

    /* ---- map the run onto a structured result ---- */

    if (killedForCancel) {
      return {
        summary: "cancelled before the Claude runtime finished",
        blocker: "run cancelled by the coordination bridge",
        telemetry: telemetryUpdate,
        ...(sessionId ? { commit_or_diff: null } : {}),
      };
    }

    if (killedForDeadline) {
      return {
        summary: `Claude runtime exceeded its ${invocation.spec.deadline_ms ?? "allotted"}ms budget and was terminated`,
        blocker: "deadline exceeded before the task produced a result",
        remaining_risks: ["partial edits may exist inside the leased scope"],
        telemetry: telemetryUpdate,
      };
    }

    if (profileMismatch) {
      throw new BridgeError(
        ErrorCode.RUNTIME_PROFILE_MISMATCH,
        `Claude runtime profile mismatch: requested '${CLAUDE_REQUESTED_MODEL}' but runtime reported '${telemetry.model}'`,
        {
          task_id: invocation.task_id,
          requested_model: CLAUDE_REQUESTED_MODEL,
          requested_effort: CLAUDE_REQUESTED_EFFORT,
          actual_model: telemetry.model,
        },
      );
    }

    if (!resultFrame) {
      // No result frame means the CLI failed before it could produce one — a missing
      // binary, a bad flag, an auth failure at startup. Surface stderr, which is where the
      // reason lives; retryability is decided by the code we pick here.
      throw new BridgeError(
        ErrorCode.ADAPTER_FAILURE,
        `claude produced no result frame (exit ${exitCode ?? "null"}${exitSignal ? `, signal ${exitSignal}` : ""}): ` +
          (stderr.trim() || stdoutTail.trim() || "no diagnostic output"),
        {
          task_id: invocation.task_id,
          exit_code: exitCode,
          ...(sessionId ? { session_id: sessionId } : {}),
        },
      );
    }

    const frame: ClaudeResultFrame = resultFrame;
    const text = typeof frame.result === "string" ? frame.result : "";

    if (frame.is_error === true) {
      // The runtime ran but reported failure (auth, API error, refusal). PARTIAL rather
      // than a throw: the attempt is real, the session id is persisted, and a retry can
      // resume it. Reporting COMPLETE here would be a false claim of success.
      return {
        summary: `Claude runtime reported an error: ${text || frame.terminal_reason || "unknown"}`,
        blocker: text || frame.terminal_reason || "claude runtime error",
        remaining_risks: [
          frame.terminal_reason === "api_error"
            ? "the Claude runtime could not reach the API or is not authenticated"
            : "the runtime terminated abnormally",
        ],
        telemetry: telemetryUpdate,
      };
    }

    const structured = parseStructuredOutput(text);
    const verifications = sanitizeVerifications(
      structured?.verification_results ?? structured?.verifications,
    );
    const artifacts = await preserveDetailedReport(text, ctx);

    await ctx.report({
      state: TaskState.VERIFYING,
      current_action: `claude runtime finished in ${frame.num_turns ?? "?"} turn(s)`,
      owned_scope: invocation.spec.scope.paths,
      progress: 1,
      artifacts,
      blockers: structured?.blocker ? [String(structured.blocker)] : [],
      next_action: "submit deliverable",
    });

    const result: ClaudeRunResult = {
      summary: boundedSummary(structured?.summary ?? text),
      ...(structured?.changed_scope ?? structured?.changed_files
        ? { changed_scope: structured?.changed_scope ?? structured?.changed_files }
        : {}),
      artifacts,
      verification_results: verifications,
      ...(structured?.remaining_risks ? { remaining_risks: structured.remaining_risks } : {}),
      ...(structured?.recommended_next_action
        ? { recommended_next_action: structured.recommended_next_action }
        : {}),
      ...(structured?.blocker ? { blocker: String(structured.blocker) } : {}),
      commit_or_diff: null,
      telemetry: telemetryUpdate,
    };
    return result;
  }

  /** Session ids observed for a task, exposed for diagnostics and resume tooling. */
  sessionFor(task_id: string): string | undefined {
    return this.lastSessionId.get(task_id);
  }

  /** The Claude-shaped telemetry for a task's last run, including non-neutral fields. */
  claudeTelemetryFor(task_id: string): ClaudeRunnerTelemetry | undefined {
    return this.lastTelemetry.get(task_id);
  }

  /**
   * The neutral update for a task's last run.
   *
   * Part of the `ClaudeRunner` contract so the adapter can report telemetry for a run that
   * ended by throwing, where there is no result object to carry it.
   */
  telemetry(invocation: TaskInvocation): AttemptTelemetryUpdate | undefined {
    const t = this.lastTelemetry.get(invocation.task_id);
    return t ? toTelemetryUpdate(t) : undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Telemetry assembly
 * ------------------------------------------------------------------ */

export interface BuildRunnerTelemetryInput {
  /** The final result frame, or `null` when the runtime never produced one. */
  readonly frame: ClaudeResultFrame | null;
  readonly runtime_version: string | null;
  readonly model: string | null;
  readonly started_at: number;
  readonly first_output_at: number | null;
  readonly ended_at: number;
  readonly prompt_bytes: number;
  readonly exit_code: number | null;
  readonly exit_signal: NodeJS.Signals | null;
  readonly cancelled: boolean;
  readonly timed_out: boolean;
}

/**
 * Decide how the attempt ended.
 *
 * Order matters: the bridge's own reasons for stopping the child (cancel, deadline) are
 * checked first, because a killed run also looks like a crash from the outside and
 * reporting CRASH for a deliberate cancellation would corrupt reliability statistics.
 */
function terminationKind(input: BuildRunnerTelemetryInput): AttemptTerminationKind {
  if (input.cancelled) return AttemptTerminationKind.CANCELLED;
  if (input.timed_out) return AttemptTerminationKind.TIMEOUT;
  if (!input.frame) {
    // No result frame: the CLI died before it could summarize. A signal means the OS ended
    // it; a plain non-zero exit means it gave up on its own.
    return input.exit_signal !== null ? AttemptTerminationKind.CRASH : AttemptTerminationKind.FAILED;
  }
  if (input.frame.is_error === true) return AttemptTerminationKind.FAILED;
  if (typeof input.frame.subtype === "string" && input.frame.subtype.startsWith("error")) {
    // e.g. `error_max_turns`: the runtime stopped cleanly but did not finish the task.
    return AttemptTerminationKind.FAILED;
  }
  return AttemptTerminationKind.COMPLETED;
}

/** The single model the attempt ran on, when the runtime names exactly one. */
function modelFromUsage(frame: ClaudeResultFrame | null): string | null {
  const usage = frame?.modelUsage;
  if (!usage || typeof usage !== "object") return null;
  const names = Object.keys(usage);
  // More than one name means helper models were involved too; picking one would be a guess.
  return names.length === 1 ? (names[0] as string) : null;
}

/**
 * Assemble one attempt's telemetry from the result frame and the measured process facts.
 *
 * Exported so the mapping can be tested against captured frames without spawning anything.
 * Every field is either something the runtime stated or something this process measured;
 * nothing is inferred from model-authored text.
 */
export function buildRunnerTelemetry(input: BuildRunnerTelemetryInput): ClaudeRunnerTelemetry {
  const frame = input.frame;
  const cost = count(frame?.total_cost_usd);
  const apiDuration = count(frame?.duration_api_ms);
  const reportedDuration = count(frame?.duration_ms) ?? apiDuration;

  return {
    runtime: CLAUDE_RUNTIME_NAME,
    runtime_version: input.runtime_version,
    requested_model: CLAUDE_REQUESTED_MODEL,
    requested_effort: CLAUDE_REQUESTED_EFFORT,
    model: input.model ?? modelFromUsage(frame),
    runtime_started_at: input.started_at,
    first_output_at: input.first_output_at,
    runtime_ended_at: input.ended_at,
    // Prefer the runtime's own figure; fall back to what this process measured, which is
    // the only number available for a run that was killed before it could report.
    runtime_duration_ms: reportedDuration ?? Math.max(0, input.ended_at - input.started_at),
    api_duration_ms: apiDuration,
    usage: normalizeClaudeUsage(frame?.usage),
    turn_count: count(frame?.num_turns),
    reported_cost_usd: cost,
    cost_semantics:
      cost === null ? TelemetryCostSemantics.UNAVAILABLE : TelemetryCostSemantics.RUNTIME_REPORTED,
    // `total_cost_usd` is an API-price equivalent the CLI computes locally. It is not an
    // invoice line: a subscription run is billed against a quota, and the frame does not
    // say which regime applied, so the bridge must not claim the billing mode is known.
    billing_mode_known: false,
    prompt_bytes: input.prompt_bytes,
    termination_kind: terminationKind(input),
    process_exit_code: input.exit_code,
  };
}
