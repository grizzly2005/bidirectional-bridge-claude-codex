/**
 * Manager-controlled model/effort preferences per delegated runtime.
 *
 * Any native manager (Claude, Codex or Gemini/Antigravity caller) may change which model a
 * target runtime uses for its next delegated attempts, at any time, without restarting a
 * client: the preference lives in a small JSON file next to the shared database and each
 * adapter re-reads it when a delegation starts. Precedence at execution time is
 * `spec.model`/`spec.effort` (one task) > stored preference > the runtime's own default.
 */

import { z } from "zod";
import { BridgeError, ErrorCode } from "@bridge/protocol";
import { ModelPreferenceStore } from "@bridge/runner-adapter";
import type { ToolDefinition } from "./tools.js";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/u;

/**
 * Non-authoritative hints shown to managers. The runtime CLI remains the authority on
 * which slugs exist for the signed-in account (`claude --help`, Codex `/model`,
 * `agy models`). Kept short and dated so stale hints are recognisable as such.
 */
export const MODEL_HINTS: Readonly<Record<string, { readonly checked: string; readonly examples: readonly string[]; readonly efforts: readonly string[]; readonly authority: string }>> = {
  claude: {
    checked: "2026-11-24",
    examples: ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    efforts: ["low", "medium", "high", "max"],
    authority: "Claude Code `--model` accepts an alias or a full model id; `claude --help` lists effort levels.",
  },
  codex: {
    checked: "2026-11-24",
    examples: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    authority: "Use a slug shown by Codex `/model` for this account; effort maps to `model_reasoning_effort`.",
  },
  gemini: {
    checked: "2026-11-24",
    examples: ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash", "gemini-pro-orchestrator"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    authority: "Run `agy models` for the exact slugs of this account; an unknown slug fails the attempt.",
  },
};

export function modelPreferenceTools(store: ModelPreferenceStore, knownRuntimes: () => readonly string[]): ToolDefinition[] {
  const describe = (): Record<string, unknown> => {
    const stored = store.readAll();
    const runtimes: Record<string, unknown> = {};
    for (const runtime of [...new Set([...knownRuntimes(), ...Object.keys(stored)])].sort()) {
      const preference = stored[runtime];
      runtimes[runtime] = {
        model: preference?.model ?? null,
        effort: preference?.effort ?? null,
        effective_without_task_override: {
          model: preference?.model ?? "runtime default",
          effort: preference?.effort ?? "runtime default",
        },
        updated_at: preference?.updated_at ?? null,
        updated_by: preference?.updated_by ?? null,
        registered: knownRuntimes().includes(runtime),
        hints: MODEL_HINTS[runtime] ?? null,
      };
    }
    return {
      precedence: ["spec.model / spec.effort (one task)", "stored runtime preference", "runtime default (no flag)"],
      applies_to: "new delegated attempts and resumes started after the change; a running attempt keeps its model",
      runtimes,
    };
  };

  return [
    {
      name: "bridge_get_model_preferences",
      title: "Show model/effort preferences per delegated runtime",
      description:
        "Return the stored model/effort preference for each delegated runtime (claude, codex, gemini), " +
        "the precedence rules and non-authoritative model hints. Null means the runtime's own default.",
      inputShape: {},
      handler: () => describe(),
    },
    {
      name: "bridge_set_model_preference",
      title: "Change the model/effort a delegated runtime uses",
      description:
        "Set or clear the model and/or reasoning effort used for future delegations to one runtime, " +
        "e.g. runtime 'claude' model 'opus' or 'claude-opus-5-5'; runtime 'gemini' model 'gemini-4-neon'. " +
        "Pass null to restore the runtime default for that dimension; omit a field to keep it. " +
        "Use only when the user asks to change models or a task genuinely needs it. Takes effect on the next attempt.",
      inputShape: {
        runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u).describe("Target runtime/agent id: claude, codex or gemini."),
        model: z.string().regex(MODEL).nullable().optional().describe("Model slug, or null for the runtime default."),
        effort: z.string().regex(EFFORT).nullable().optional().describe("Effort level, or null for the runtime default."),
      },
      handler: (args, ctx) => {
        if (ctx.delegationPolicy !== "allow") {
          throw new BridgeError(ErrorCode.INVALID_ARGUMENT,
            "delegation is denied by this server's startup policy, so it cannot change delegation models",
            { policy: ctx.delegationPolicy, caller: ctx.defaultAgent });
        }
        const runtime = args["runtime"] as string;
        if (!knownRuntimes().includes(runtime)) {
          throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `unknown runtime '${runtime}'`, { registered: [...knownRuntimes()] });
        }
        if (args["model"] === undefined && args["effort"] === undefined) {
          throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "supply model and/or effort (null restores the runtime default)");
        }
        const update: { model?: string | null; effort?: string | null } = {};
        if (args["model"] !== undefined) update.model = args["model"] as string | null;
        if (args["effort"] !== undefined) update.effort = args["effort"] as string | null;
        const stored = store.set(runtime, update, ctx.defaultAgent);
        return { runtime, preference: stored ?? { model: null, effort: null }, ...describe() };
      },
    },
  ];
}
