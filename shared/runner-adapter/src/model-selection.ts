/**
 * Model/effort selection for delegated runtimes.
 *
 * Precedence, highest first:
 *   1. the frozen task spec (`spec.model` / `spec.effort`) — a per-delegation override;
 *   2. the persisted per-runtime preference set by a manager (`bridge_set_model_preference`);
 *   3. the runtime's own default — no model/effort flag is passed at all.
 *
 * The values are opaque runtime slugs (e.g. `opus`, `claude-opus-5-5`, `gpt-5.5-codex`,
 * `gemini-4-neon`). They are validated syntactically so they can never be parsed as a CLI
 * flag or smuggle a path or control character; whether a slug exists is for the runtime to
 * decide, and an unknown slug fails that attempt rather than silently falling back.
 */

import { BridgeError, ErrorCode, type TaskInvocation } from "@bridge/protocol";

export const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
export const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export type ModelSelectionSource = "task" | "preference" | "runner-default" | "runtime-default";

export interface ModelSelection {
  /** `null` means "do not pass a model flag": the runtime default applies. */
  readonly model: string | null;
  /** `null` means "do not pass an effort flag": the runtime default applies. */
  readonly effort: string | null;
  readonly model_source: ModelSelectionSource;
  readonly effort_source: ModelSelectionSource;
}

/** A persisted manager preference for one runtime; `null` fields mean "runtime default". */
export interface ModelPreference {
  readonly model: string | null;
  readonly effort: string | null;
}

export type ModelPreferenceReader = () => ModelPreference | undefined;

export function assertModelSlug(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !MODEL_SLUG_PATTERN.test(value)) {
    throw new BridgeError(ErrorCode.INVALID_ARGUMENT,
      `${field} must be a runtime model slug (letters, digits, . _ : @ + -; max 128; no leading dash)`);
  }
  return value;
}

export function assertEffort(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !EFFORT_PATTERN.test(value)) {
    throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `${field} must be a lowercase effort level such as low, medium, high, xhigh or max`);
  }
  return value;
}

/**
 * Resolve the effective selection for one invocation. A failing preference reader never
 * blocks work: it degrades to the next level, because a corrupt preferences file must not
 * stop delegations that did not ask for a specific model.
 */
export function resolveModelSelection(
  invocation: Pick<TaskInvocation, "spec">,
  options: {
    readonly preference?: ModelPreferenceReader;
    readonly runnerDefault?: ModelPreference;
  } = {},
): ModelSelection {
  const spec = invocation.spec as { model?: unknown; effort?: unknown };
  const taskModel = assertModelSlug(spec.model, "TaskSpec.model");
  const taskEffort = assertEffort(spec.effort, "TaskSpec.effort");
  let preference: ModelPreference | undefined;
  try { preference = options.preference?.(); } catch { preference = undefined; }
  const prefModel = preference ? safe(() => assertModelSlug(preference!.model, "preference.model")) : null;
  const prefEffort = preference ? safe(() => assertEffort(preference!.effort, "preference.effort")) : null;
  const defModel = options.runnerDefault?.model ?? null;
  const defEffort = options.runnerDefault?.effort ?? null;
  const pick = (task: string | null, pref: string | null, def: string | null): [string | null, ModelSelectionSource] =>
    task !== null ? [task, "task"] : pref !== null ? [pref, "preference"] : def !== null ? [def, "runner-default"] : [null, "runtime-default"];
  const [model, model_source] = pick(taskModel, prefModel, defModel);
  const [effort, effort_source] = pick(taskEffort, prefEffort, defEffort);
  return { model, effort, model_source, effort_source };
}

function safe(read: () => string | null): string | null {
  try { return read(); } catch { return null; }
}

/**
 * Does a runtime-reported model satisfy the requested one? A bare family alias such as
 * `opus` matches any model id containing that family token; a full id matches itself or a
 * dated/suffixed variant of it. `null` requested means the runtime default: anything goes.
 */
export function modelSatisfiesRequest(requested: string | null, reported: string | null): boolean {
  if (requested === null || reported === null) return true;
  const want = requested.toLowerCase();
  const got = reported.toLowerCase();
  if (got === want) return true;
  if (/^[a-z]+$/u.test(want)) return new RegExp(`(^|[-_/.])${want}([-_/.]|$)`, "u").test(got);
  return got.startsWith(`${want}-`) || got.startsWith(`${want}@`) || got.startsWith(`${want}:`);
}
