/**
 * Runner that executes one bounded bridge task in Google's headless agent CLI.
 *
 *   agy -p <contract> --output-format stream-json [--model m] [--effort e]
 *       [--mode plan] [--conversation <id>] [--print-timeout Ns]
 *
 * Antigravity CLI (`agy`) is the default: Gemini CLI stopped serving Google AI Pro/Ultra
 * accounts on 2026-06-18. The legacy `gemini` binary remains selectable (`dialect:
 * "gemini-cli"`) for enterprise/API-key installations that still serve it.
 *
 * Contract and safety properties, mirroring the Claude runner:
 *  - the task contract is generated from the frozen TaskSpec; long contracts are handed
 *    over through a private file under `.bridge/worker-prompts/` instead of the argv;
 *  - model/effort follow task > stored preference > runtime default (no flag);
 *  - read-only `(no-write)` tasks run in the CLI's read-only plan mode and must report
 *    `changed_scope: []`;
 *  - the runtime session id is persisted as soon as the stream reveals it, so a crash
 *    leaves something to resume; resumption reuses that same conversation;
 *  - deadlines and cancellation stop the whole process tree, and "stopped" is reported
 *    only with positive evidence; otherwise the scope stays quarantined;
 *  - a delegated worker gets `BRIDGE_DELEGATED_WORKER=1`, which the native bridge
 *    launcher refuses, so a worker cannot open a nested coordination server.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AttemptTerminationKind,
  BridgeError,
  ErrorCode,
  TelemetryCostSemantics,
  isReadOnlyScope,
  splitUtf8,
  type ArtifactId,
  type AttemptTelemetryUpdate,
  type InvocationContext,
  type RuntimeFailure,
  type TaskInvocation,
} from "@bridge/protocol";
import {
  boundedStrings,
  buildContractPrompt,
  modelSatisfiesRequest,
  parseStructuredOutput,
  resolveModelSelection,
  sanitizeChangedPaths,
  sanitizeVerificationClaims,
  type AgentRunResult,
  type AgentRunner,
  type ModelPreference,
  type ModelPreferenceReader,
  type ModelSelection,
} from "@bridge/runner-adapter";
import {
  classifyFailure,
  emptyObservation,
  finalText,
  observeStreamLine,
  resultFailed,
  type GoogleCliDialect,
  type StreamObservation,
} from "./antigravity-stream.js";

export const GEMINI_RUNTIME_NAMES: Readonly<Record<GoogleCliDialect, string>> = {
  antigravity: "antigravity-cli",
  "gemini-cli": "gemini-cli",
};
export const GEMINI_SUMMARY_MAX_CHARS = 4_000;
const REPORT_CHUNK_MAX_BYTES = 60 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
/** Above this many characters the contract travels through a private prompt file. */
export const DEFAULT_MAX_ARGV_PROMPT_CHARS = 16_000;

/** Flags the runner owns; `extraArgs` may not override them. */
const PROTECTED_FLAGS = [
  "-p", "--print", "--prompt", "--output-format", "-o", "--input-format", "--model", "-m", "--effort",
  "--mode", "--conversation", "--continue", "-c", "--resume", "-r", "--session-id", "--approval-mode",
  "--yolo", "-y", "--dangerously-skip-permissions", "--print-timeout",
] as const;

/**
 * How the Gemini worker is authorized. Google's Antigravity FAQ states that wrapping `agy`
 * inside third-party coding agents or applications is not supported under consumer plans
 * (Free/Pro/Ultra login) and recommends a Google AI Studio (Gemini API) key or Gemini
 * Enterprise; Google staff have reported suspensions for such use. The bridge therefore
 * never drives a consumer login: the worker stays disabled until one of these is chosen.
 *
 *  - `api-key`: the worker uses a Gemini API key (`GEMINI_API_KEY`/`GOOGLE_API_KEY` in its
 *    environment). For Antigravity, `~/.gemini/antigravity-cli/settings.json` must also set
 *    `"modelProvider": "gemini"`, so the CLI never opens an account session.
 *  - `enterprise`: the user states the CLI is signed in with Gemini Enterprise / Vertex AI.
 */
export type GeminiAuthMode = "api-key" | "enterprise";

export interface AntigravityRunnerOptions {
  /** Required for any launch; see `GeminiAuthMode`. Undefined keeps the worker disabled. */
  readonly authMode?: GeminiAuthMode;
  /** Antigravity CLI settings file checked in `api-key` mode (test seam). */
  readonly settingsPath?: string;
  /** Executable; default `$BRIDGE_GEMINI_COMMAND`, else `agy` (or `gemini` for that dialect). */
  readonly command?: string;
  readonly dialect?: GoogleCliDialect;
  /** Antigravity `--mode` for write tasks; default none (the CLI's headless default, `auto`). */
  readonly writeMode?: string | null;
  /** Mode for `(no-write)` tasks; default `plan` (read-only planning). */
  readonly readOnlyMode?: string;
  /**
   * Opt-in only: auto-approve every tool (`--dangerously-skip-permissions`, or Gemini CLI
   * `--approval-mode yolo`). Without it, risky actions are soft-denied in headless mode.
   */
  readonly skipPermissions?: boolean;
  /** Enable the CLI terminal sandbox (`--sandbox`). */
  readonly sandbox?: boolean;
  /** Default model/effort when no task or stored preference selects one; default runtime default. */
  readonly defaultProfile?: ModelPreference;
  readonly modelPreference?: ModelPreferenceReader;
  /** Resume the previous attempt's conversation when a handle exists. Default true. */
  readonly allowResume?: boolean;
  readonly extraArgs?: readonly string[];
  readonly maxArgvPromptChars?: number;
  /** Milliseconds between SIGTERM and SIGKILL when stopping. Default 5000. */
  readonly killGraceMs?: number;
  /** Upper bound for proving process-tree termination. Default 15000. */
  readonly stopTimeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

interface RunnerTelemetry extends AttemptTelemetryUpdate {}

export class AntigravityRunner implements AgentRunner {
  readonly description: string;
  readonly supportsStopConfirmation = true;
  readonly dialect: GoogleCliDialect;
  private readonly command: string;
  private readonly options: AntigravityRunnerOptions;
  private readonly log: (line: string) => void;
  private readonly platform: NodeJS.Platform;
  private readonly lastTelemetry = new Map<string, AttemptTelemetryUpdate>();
  private readonly presetSessions = new Map<string, string>();
  private runtimeVersion: string | null = null;

  constructor(options: AntigravityRunnerOptions = {}) {
    this.options = options;
    this.dialect = options.dialect ?? "antigravity";
    if (this.dialect !== "antigravity" && this.dialect !== "gemini-cli") {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Gemini dialect must be antigravity or gemini-cli");
    }
    this.command = options.command ?? process.env["BRIDGE_GEMINI_COMMAND"] ?? (this.dialect === "gemini-cli" ? "gemini" : "agy");
    if (this.command.length === 0 || /[\x00-\x1f]/u.test(this.command)) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Gemini command is invalid");
    }
    this.log = options.log ?? (() => {});
    this.platform = options.platform ?? process.platform;
    this.description = `${GEMINI_RUNTIME_NAMES[this.dialect]}(${this.command})`;
    assertNoProtectedExtraArgs(options.extraArgs ?? []);
    for (const mode of [options.writeMode, options.readOnlyMode]) {
      if (mode !== undefined && mode !== null && !/^[a-z][a-z_-]{0,31}$/u.test(mode)) {
        throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Gemini mode must be a lowercase mode name");
      }
    }
    const grace = options.killGraceMs ?? 5_000;
    const stop = options.stopTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(grace) || grace < 0 || grace > 60_000 || !Number.isSafeInteger(stop) || stop < 1 || stop > 120_000) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Gemini stop timeouts must be bounded milliseconds");
    }
  }

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    const problem = this.authorizationProblem();
    if (problem !== null) return { ok: false, detail: problem };
    return new Promise((resolveProbe) => {
      execFile(this.command, ["--version"], { timeout: 15_000, windowsHide: true, env: this.childEnv() }, (error, stdout) => {
        if (error) {
          resolveProbe({ ok: false, detail: `${this.command} --version failed: ${(error as Error).message.slice(0, 300)}` });
          return;
        }
        const version = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(String(stdout))?.[0] ?? null;
        this.runtimeVersion = version;
        resolveProbe({ ok: true, detail: `${GEMINI_RUNTIME_NAMES[this.dialect]} ${version ?? "version unknown"}` });
      });
    });
  }

  /** Gemini CLI accepts a caller-minted session id, so the handle exists before spawn. */
  sessionId(invocation: TaskInvocation): string | undefined {
    if (this.dialect !== "gemini-cli" || this.resumeHandle(invocation) !== null) return undefined;
    const id = randomUUID();
    this.presetSessions.set(invocation.task_id, id);
    return id;
  }

  /**
   * Refuse to drive a consumer Google login. Returns a reason when the worker must not
   * launch, or null when the configured authorization is a supported automation path.
   */
  authorizationProblem(): string | null {
    const mode = this.options.authMode;
    if (mode === undefined) {
      return "Gemini worker disabled: driving a consumer Antigravity/Gemini login from Claude Code or Codex " +
        "is not supported by Google (Antigravity FAQ) and can lead to account suspension. Start the bridge with " +
        "--gemini-auth api-key (Google AI Studio key, billed per use) or --gemini-auth enterprise. " +
        "To use a Google AI Pro/Ultra plan, run Antigravity itself as the manager and delegate to Claude or Codex.";
    }
    if (mode === "enterprise") return null;
    if (mode !== "api-key") return `unknown Gemini auth mode '${String(mode)}'`;
    const env = this.childEnv();
    if (!(env["GEMINI_API_KEY"]?.trim() || env["GOOGLE_API_KEY"]?.trim())) {
      return "Gemini api-key mode requires GEMINI_API_KEY (or GOOGLE_API_KEY) in the bridge environment";
    }
    if (this.dialect === "antigravity") {
      const path = this.options.settingsPath ?? join(homedir(), ".gemini", "antigravity-cli", "settings.json");
      let provider: unknown;
      try { provider = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["modelProvider"]; }
      catch { provider = undefined; }
      if (provider !== "gemini") {
        return `Gemini api-key mode requires "modelProvider": "gemini" in ${path}, so agy uses the API key and never the signed-in account`;
      }
    }
    return null;
  }

  telemetry(invocation: TaskInvocation): AttemptTelemetryUpdate | undefined {
    return this.lastTelemetry.get(invocation.task_id);
  }

  modelSelectionFor(invocation: TaskInvocation): ModelSelection {
    return resolveModelSelection(invocation, {
      ...(this.options.modelPreference ? { preference: this.options.modelPreference } : {}),
      runnerDefault: this.options.defaultProfile ?? { model: null, effort: null },
    });
  }

  private resumeHandle(invocation: TaskInvocation): string | null {
    const handle = invocation.previous_execution_handle?.trim();
    return this.options.allowResume !== false && handle ? handle : null;
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.options.env,
      // The native bridge launcher refuses to start under this marker: a delegated worker
      // must never open a nested coordination server with its own identity.
      BRIDGE_DELEGATED_WORKER: "1",
      BRIDGE_DELEGATED_RUNTIME: "gemini",
    };
  }

  /** Exact argv for one attempt. `promptArg` is the contract or the prompt-file pointer. */
  buildArgs(invocation: TaskInvocation, promptArg: string, selection: ModelSelection, remainingMs: number): string[] {
    const readOnly = isReadOnlyScope(invocation.spec.scope);
    const resume = this.resumeHandle(invocation);
    const args: string[] = [];
    if (this.dialect === "antigravity") {
      args.push("-p", promptArg, "--output-format", "stream-json");
      if (selection.model !== null) args.push("--model", selection.model);
      if (selection.effort !== null) args.push("--effort", selection.effort);
      const mode = readOnly ? this.options.readOnlyMode ?? "plan" : this.options.writeMode ?? null;
      if (mode !== null) args.push(`--mode=${mode}`);
      if (!readOnly && this.options.skipPermissions === true) args.push("--dangerously-skip-permissions");
      if (resume !== null) args.push("--conversation", resume);
      const seconds = Math.floor((remainingMs - 5_000) / 1000);
      if (seconds >= 5) args.push("--print-timeout", `${seconds}s`);
    } else {
      args.push("-p", promptArg, "--output-format", "stream-json", "--skip-trust");
      if (selection.model !== null) args.push("--model", selection.model);
      const approval = readOnly ? "plan" : this.options.skipPermissions === true ? "yolo" : "auto_edit";
      args.push("--approval-mode", approval);
      if (resume !== null) args.push("--resume", resume);
      else {
        const preset = this.presetSessions.get(invocation.task_id);
        if (preset) args.push("--session-id", preset);
      }
    }
    if (this.options.sandbox === true) args.push("--sandbox");
    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);
    return args;
  }

  async run(invocation: TaskInvocation, ctx: InvocationContext): Promise<AgentRunResult> {
    this.lastTelemetry.delete(invocation.task_id);
    const authProblem = this.authorizationProblem();
    if (authProblem !== null) {
      await ctx.reportRuntimeState?.("stopped"); // nothing was launched
      return { summary: "Gemini worker not launched", blocker: authProblem,
        remaining_risks: ["no Gemini work was performed"] };
    }
    const resume = this.resumeHandle(invocation);
    if (invocation.resume_required === true && resume === null) {
      await ctx.reportRuntimeState?.("stopped");
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE,
        "strict resume requires Gemini resume support and a persisted conversation id",
        { task_id: invocation.task_id, attempt: invocation.attempt });
    }
    let selection: ModelSelection;
    let contract: string;
    try {
      selection = this.modelSelectionFor(invocation);
      if (this.dialect === "gemini-cli" && selection.effort !== null) {
        this.log(`gemini-cli has no effort flag; requested effort '${selection.effort}' is not applied`);
        selection = { ...selection, effort: null, effort_source: "runtime-default" };
      }
      contract = buildContractPrompt(invocation, {
        runtimeLabel: "Gemini", resuming: resume !== null,
        ...(invocation.spec.max_turns !== undefined ? { turnCeiling: invocation.spec.max_turns } : {}),
      });
    } catch (error) {
      await ctx.reportRuntimeState?.("stopped");
      throw error;
    }
    const remainingMs = invocation.deadline_at - Date.now();
    if (ctx.signal.aborted || remainingMs <= 0) {
      await ctx.reportRuntimeState?.("stopped");
      return { summary: "Gemini task stopped before launch", blocker: ctx.signal.aborted
        ? "run cancelled by the coordination bridge" : "deadline exceeded before launch" };
    }

    const { promptArg, cleanup } = this.deliverPrompt(invocation, contract);
    let args: string[];
    try { args = this.buildArgs(invocation, promptArg, selection, remainingMs); }
    catch (error) { cleanup(); await ctx.reportRuntimeState?.("stopped"); throw error; }

    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(this.command, args, {
        cwd: invocation.workspace_root,
        env: this.childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: this.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      cleanup();
      await ctx.reportRuntimeState?.("stopped");
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `Gemini runtime launch failed: ${(error as Error).message}`,
        { task_id: invocation.task_id, runtime_stop_confirmed: true });
    }

    const observation = emptyObservation();
    let launchError: Error | null = null;
    let firstOutputAt: number | null = null;
    let stderrTail = "";
    let killedForCancel = false;
    let killedForDeadline = false;
    let handleChain: Promise<void> = Promise.resolve();
    let savedHandle: string | null = resume ?? this.presetSessions.get(invocation.task_id) ?? null;

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    child.once("error", (error) => { launchError = error; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    if (child.pid !== undefined) {
      try { await ctx.reportRuntimeState?.("running"); }
      catch (error) { this.log(`runtime state report failed: ${(error as Error).message}`); }
    }

    const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
    const reading = (async () => {
      if (!lines) return;
      for await (const line of lines) {
        if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const before = observation.sessionId;
        observeStreamLine(observation, parsed);
        if (observation.sawOutput) firstOutputAt ??= Date.now();
        if (observation.sessionId !== null && observation.sessionId !== before && observation.sessionId !== savedHandle) {
          const handle = observation.sessionId;
          savedHandle = handle;
          handleChain = handleChain.then(() => ctx.saveExecutionHandle(handle)).catch((error: unknown) => {
            this.log(`execution handle rejected: ${(error as Error).message}`);
          });
        }
      }
    })();

    let stopPromise: Promise<boolean> | null = null;
    let resolveStopFailed: () => void = () => {};
    const stopFailed = new Promise<null>((r) => { resolveStopFailed = () => r(null); });
    const stopTree = (): Promise<boolean> => stopPromise ??= this.stopProcessTree(child, closed)
      .then((ok) => { if (!ok) resolveStopFailed(); return ok; }, () => { resolveStopFailed(); return false; });
    const onAbort = (): void => { killedForCancel = !killedForDeadline; void stopTree(); };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const deadlineTimer = setTimeout(() => { killedForDeadline = !killedForCancel; void stopTree(); },
      Math.max(1, invocation.deadline_at - Date.now()));

    let exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    try {
      // Never wait unboundedly on a root that refused to die: a failed stop ends the wait.
      exit = await Promise.race([closed, stopFailed]);
      if (exit !== null) {
        await Promise.race([reading.catch(() => {}), sleep(5_000)]);
        await handleChain;
      }
    } finally {
      clearTimeout(deadlineTimer);
      ctx.signal.removeEventListener("abort", onAbort);
      cleanup();
    }
    const endedAt = Date.now();

    // Positive stop evidence: the root closed and its process group/tree is gone.
    const stopped = exit === null ? false : launchError !== null && child.pid === undefined ? true : await stopTree();
    exit ??= { code: null, signal: null };
    try { await ctx.reportRuntimeState?.(stopped ? "stopped" : "unconfirmed"); }
    catch (error) { if (stopped) throw error; }

    const failureText = `${observation.error ?? ""}\n${stderrTail}`;
    const failed = !killedForCancel && !killedForDeadline
      && (launchError !== null || resultFailed(observation) || (!observation.sawResult && exit.code !== 0));
    const category = failed ? classifyFailure(failureText) : null;
    const profileMismatch = !modelSatisfiesRequest(selection.model, observation.model);
    const runtimeFailure: RuntimeFailure | null = profileMismatch
      ? { category: "profile", source: "runtime_code", retryable: false, retry_after_at: null }
      : category === null ? null
        : { category, source: "runtime_text", retryable: category === "transient" || category === "quota", retry_after_at: null };
    const telemetry: RunnerTelemetry = buildGeminiTelemetry({
      dialect: this.dialect, runtimeVersion: this.runtimeVersion, selection, observation,
      startedAt, firstOutputAt, endedAt, promptBytes: Buffer.byteLength(contract, "utf8"),
      exitCode: exit.code, exitSignal: exit.signal, cancelled: killedForCancel, timedOut: killedForDeadline,
      failed: failed || profileMismatch, runtimeFailure,
    });
    this.lastTelemetry.set(invocation.task_id, telemetry);

    if (!stopped) {
      throw new BridgeError(ErrorCode.RUNTIME_STOP_UNCONFIRMED,
        "Gemini runtime process tree did not confirm its stop; scope retained in quarantine",
        { task_id: invocation.task_id, runtime_stop_confirmed: false });
    }
    if (launchError !== null) {
      throw new BridgeError(ErrorCode.ADAPTER_FAILURE,
        `Gemini runtime launch failed (${this.command}): ${(launchError as Error).message}. ` +
        "Install the Antigravity CLI or pass --gemini-command with its absolute path.",
        { task_id: invocation.task_id, runtime_stop_confirmed: true });
    }
    if (killedForCancel) {
      return { summary: "cancelled before the Gemini runtime finished", blocker: "run cancelled by the coordination bridge", telemetry };
    }
    if (killedForDeadline) {
      return { summary: "Gemini runtime exceeded its deadline and was terminated", blocker: "deadline exceeded before the task produced a result",
        remaining_risks: ["partial edits may exist inside the leased scope"], telemetry };
    }
    if (profileMismatch) {
      throw new BridgeError(ErrorCode.RUNTIME_PROFILE_MISMATCH,
        `Gemini runtime profile mismatch: requested '${selection.model}' but runtime reported '${observation.model}'`,
        { task_id: invocation.task_id, requested_model: selection.model, actual_model: observation.model, runtime_stop_confirmed: true });
    }
    const text = finalText(observation);
    if (failed) {
      const reason = redact(observation.error ?? (stderrTail.trim() || `exit ${exit.code ?? "null"}`)).slice(0, 1_000);
      if (!observation.sawResult && text.length === 0) {
        throw new BridgeError(ErrorCode.ADAPTER_FAILURE, `Gemini runtime produced no result: ${reason}`,
          { task_id: invocation.task_id, failure_category: category, runtime_stop_confirmed: true });
      }
      return { summary: boundedSummary(text || `Gemini runtime failed: ${reason}`),
        blocker: `Gemini runtime reported failure (${category ?? "unknown"}): ${reason}`, telemetry };
    }
    return this.mapResult(invocation, ctx, text, telemetry);
  }

  private async mapResult(invocation: TaskInvocation, ctx: InvocationContext, text: string, telemetry: AttemptTelemetryUpdate): Promise<AgentRunResult> {
    const structured = parseStructuredOutput(text);
    const { accepted, rejected } = sanitizeVerificationClaims(structured?.verification_results);
    const artifacts = await preserveReport(text, ctx, rejected.map(({ index, error }) => ({ index, ...error.toJSON() })));
    if (!structured) {
      return { summary: boundedSummary(text || "Gemini runtime returned no final text"), artifacts,
        remaining_risks: ["Gemini did not return the structured final JSON block"], telemetry };
    }
    const changed = sanitizeChangedPaths(structured.changed_scope);
    const readOnly = isReadOnlyScope(invocation.spec.scope);
    const summary = boundedSummary(typeof structured.summary === "string" ? structured.summary : text);
    const risks = boundedStrings(structured.remaining_risks);
    const next = typeof structured.recommended_next_action === "string" ? structured.recommended_next_action.slice(0, 2_000) : undefined;
    const declaredBlocker = typeof structured.blocker === "string" && structured.blocker.trim().length > 0
      ? structured.blocker.trim().slice(0, 2_000) : null;
    const blocker = readOnly && changed.length > 0
      ? "a read-only task reported changed files; review the workspace before accepting"
      : rejected.length > 0
        ? `${rejected.length} verification claim(s) contradicted their exit code and were rejected`
        : declaredBlocker;
    return {
      summary,
      changed_scope: readOnly ? [] : changed,
      artifacts,
      verification_results: accepted,
      remaining_risks: risks,
      ...(next !== undefined ? { recommended_next_action: next } : {}),
      ...(blocker !== null ? { blocker } : {}),
      telemetry,
    };
  }

  /** Long contracts go through a private file; the argv carries a fixed pointer only. */
  private deliverPrompt(invocation: TaskInvocation, contract: string): { promptArg: string; cleanup: () => void } {
    const limit = this.options.maxArgvPromptChars ?? DEFAULT_MAX_ARGV_PROMPT_CHARS;
    if (contract.length <= limit) return { promptArg: contract, cleanup: () => {} };
    const directory = resolve(invocation.workspace_root, ".bridge", "worker-prompts");
    const safeTask = invocation.task_id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
    const name = `${safeTask}-a${invocation.attempt}-${createHash("sha256").update(contract).digest("hex").slice(0, 12)}.md`;
    const file = join(directory, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, contract, { encoding: "utf8", mode: 0o600 });
    const relative = `.bridge/worker-prompts/${name}`;
    return {
      promptArg: [
        "You are a delegated worker of the multi-agent coordination bridge.",
        `Read the complete task contract from the workspace file ${relative} first, then execute it exactly.`,
        "That file is the authoritative contract: its write scope, rules and required final JSON block all apply.",
        "Do not modify or delete that file.",
      ].join("\n"),
      cleanup: () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } },
    };
  }

  /**
   * Stop the runtime and prove the stop. POSIX runtimes run in their own process group, so
   * the group's disappearance is the evidence. On Windows `taskkill /T /F` ends the tree
   * while the root is alive; after a normal root exit the closed root is the evidence.
   */
  private async stopProcessTree(child: ChildProcess, closed: Promise<unknown>): Promise<boolean> {
    const pid = child.pid;
    if (pid === undefined) return true;
    const grace = this.options.killGraceMs ?? 5_000;
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 15_000);
    const rootClosed = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const waitClosed = (ms: number): Promise<boolean> => Promise.race([
      closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), Math.max(0, ms))),
    ]);
    if (this.platform === "win32") {
      if (!rootClosed()) {
        // Resolve the system binary explicitly: a bare name could be shadowed by the workspace.
        const root = process.env["SystemRoot"];
        const taskkill = root && /^[A-Za-z]:[\\/]/u.test(root) ? join(root, "System32", "taskkill.exe") : "taskkill.exe";
        await new Promise<void>((r) => execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, () => r()));
      }
      return waitClosed(deadline - Date.now());
    }
    const groupAlive = (): boolean => {
      try { process.kill(-pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    };
    const signalGroup = (signal: NodeJS.Signals): void => { try { process.kill(-pid, signal); } catch { /* gone */ } };
    if (groupAlive()) {
      signalGroup("SIGTERM");
      const termUntil = Date.now() + grace;
      while (groupAlive() && Date.now() < termUntil) await sleep(50);
      if (groupAlive()) signalGroup("SIGKILL");
    }
    while (groupAlive() && Date.now() < deadline) await sleep(50);
    const closedInTime = rootClosed() || await waitClosed(deadline - Date.now());
    return closedInTime && !groupAlive();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assertNoProtectedExtraArgs(extraArgs: readonly string[]): void {
  for (const arg of extraArgs) {
    const flag = arg.split("=", 1)[0]!;
    if ((PROTECTED_FLAGS as readonly string[]).includes(flag)) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `Gemini extra args cannot override bridge-owned flag ${flag}`);
    }
  }
}

function boundedSummary(value: string): string {
  return (value.trim() || "Gemini runtime completed").slice(0, GEMINI_SUMMARY_MAX_CHARS);
}

/** Guardrail against echoing credentials from runtime errors into shared task state. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})/gu, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/giu, "$1[redacted]")
    .replace(/(conversation|session)(\s*(?:id)?\s*[:=]?\s*)[A-Za-z0-9._:-]{8,}/giu, "$1$2[redacted]");
}

async function preserveReport(text: string, ctx: InvocationContext, diagnostics: readonly Record<string, unknown>[]): Promise<ArtifactId[]> {
  if (diagnostics.length === 0 && text.length <= GEMINI_SUMMARY_MAX_CHARS) return [];
  const body = diagnostics.length > 0
    ? JSON.stringify({ schema_version: 1, validation_status: "rejected", candidate: text, diagnostics }, null, 2)
    : text;
  const chunks = splitUtf8(body, Math.min(REPORT_CHUNK_MAX_BYTES, ctx.max_inline_artifact_bytes ?? REPORT_CHUNK_MAX_BYTES));
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const prefix = diagnostics.length > 0 ? "gemini-rejected-result" : "gemini-report";
  const extension = diagnostics.length > 0 ? "json" : "md";
  const artifacts: ArtifactId[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const sequence = index + 1;
    const name = chunks.length === 1 ? `${prefix}.${extension}`
      : `${prefix}.part-${String(sequence).padStart(3, "0")}-of-${String(chunks.length).padStart(3, "0")}.${extension}`;
    artifacts.push(await ctx.publishArtifact({
      kind: "report", name, media_type: diagnostics.length > 0 ? "application/json" : "text/markdown",
      inline: chunks[index]!,
      metadata: { source: prefix, sequence, total_chunks: chunks.length, complete_report_sha256: sha256 },
    }));
  }
  return artifacts;
}

export interface BuildGeminiTelemetryInput {
  readonly dialect: GoogleCliDialect;
  readonly runtimeVersion: string | null;
  readonly selection: ModelSelection;
  readonly observation: StreamObservation;
  readonly startedAt: number;
  readonly firstOutputAt: number | null;
  readonly endedAt: number;
  readonly promptBytes: number;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly failed: boolean;
  readonly runtimeFailure: RuntimeFailure | null;
}

/**
 * Neutral telemetry from runtime-stated usage. Thinking tokens are folded into output only
 * when the runtime also states a total that includes them; otherwise they are not guessed.
 * Cached tokens are kept only as a subdimension of the stated input.
 */
export function buildGeminiTelemetry(input: BuildGeminiTelemetryInput): AttemptTelemetryUpdate {
  const usage = input.observation.usage;
  let output = usage.output_tokens;
  if (output !== null && usage.thinking_tokens !== null && usage.total_tokens !== null && usage.input_tokens !== null
      && usage.input_tokens + output + usage.thinking_tokens === usage.total_tokens) {
    output += usage.thinking_tokens;
  }
  const cached = usage.cached_input_tokens !== null && usage.input_tokens !== null && usage.cached_input_tokens <= usage.input_tokens
    ? usage.cached_input_tokens : null;
  const termination = input.cancelled ? AttemptTerminationKind.CANCELLED
    : input.timedOut ? AttemptTerminationKind.TIMEOUT
      : input.exitSignal !== null && !input.observation.sawResult ? AttemptTerminationKind.CRASH
        : input.failed ? AttemptTerminationKind.FAILED : AttemptTerminationKind.COMPLETED;
  return {
    runtime: GEMINI_RUNTIME_NAMES[input.dialect],
    runtime_version: input.runtimeVersion,
    requested_model: input.selection.model,
    requested_effort: input.selection.effort,
    model: input.observation.model,
    runtime_started_at: input.startedAt,
    first_output_at: input.firstOutputAt,
    runtime_ended_at: input.endedAt,
    runtime_duration_ms: input.observation.durationMs ?? Math.max(0, input.endedAt - input.startedAt),
    runtime_duration_source: input.observation.durationMs !== null ? "provider_wall" : "local_span",
    runtime_failure: input.cancelled || input.timedOut ? null : input.runtimeFailure,
    input_tokens: usage.input_tokens,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_creation_input_tokens: null,
    total_tokens: usage.total_tokens,
    turn_count: input.observation.turns,
    reported_cost_usd: null,
    cost_semantics: TelemetryCostSemantics.UNAVAILABLE,
    billing_mode_known: false,
    prompt_bytes: input.promptBytes,
    termination_kind: termination,
    process_exit_code: input.exitCode,
  };
}
