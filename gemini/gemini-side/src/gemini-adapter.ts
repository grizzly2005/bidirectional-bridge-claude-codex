/**
 * Gemini-side adapter: Google's agent CLI (Antigravity `agy`, or legacy `gemini`) as a
 * delegated bridge worker. All admission, cancellation, telemetry projection and honesty
 * gating come from the shared `RunnerAdapter`; only the identity is fixed here.
 */

import { RunnerAdapter, type RunnerAdapterOptions } from "@bridge/runner-adapter";

export type GeminiAdapterOptions = Omit<RunnerAdapterOptions, "label" | "slug">;

export class GeminiAdapter extends RunnerAdapter {
  constructor(options: GeminiAdapterOptions) {
    super({
      ...options,
      label: "Gemini",
      slug: "gemini",
      capabilities: options.capabilities ?? ["code", "tests", "docs", "review", "analysis", "resume"],
    });
  }
}
