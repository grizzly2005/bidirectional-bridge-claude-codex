import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskInvocation } from "@bridge/protocol";
import {
  ModelPreferenceStore,
  buildContractPrompt,
  modelSatisfiesRequest,
  parseStructuredOutput,
  resolveModelSelection,
  sanitizeChangedPaths,
  sanitizeVerificationClaims,
} from "./index.js";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "runner-adapter-")); directories.push(d); return d; };

const spec = (extra: Record<string, unknown> = {}) => ({
  objective: "o", scope: { paths: ["src/**"] }, dependencies: [], expected_deliverable: "d", verification_criteria: ["c"], ...extra,
});

describe("model selection precedence", () => {
  it("prefers task, then stored preference, then runner default, then runtime default", () => {
    const pref = () => ({ model: "pref-model", effort: "medium" });
    expect(resolveModelSelection({ spec: spec({ model: "task-model" }) } as never, { preference: pref }))
      .toMatchObject({ model: "task-model", model_source: "task", effort: "medium", effort_source: "preference" });
    expect(resolveModelSelection({ spec: spec() } as never, { runnerDefault: { model: "opus", effort: "high" } }))
      .toMatchObject({ model: "opus", model_source: "runner-default" });
    expect(resolveModelSelection({ spec: spec() } as never))
      .toEqual({ model: null, effort: null, model_source: "runtime-default", effort_source: "runtime-default" });
  });

  it("degrades a broken or flag-shaped preference instead of passing it to a CLI", () => {
    expect(resolveModelSelection({ spec: spec() } as never, { preference: () => { throw new Error("corrupt"); } }).model).toBeNull();
    expect(resolveModelSelection({ spec: spec() } as never, { preference: () => ({ model: "-rf", effort: "X" }) }))
      .toMatchObject({ model: null, effort: null });
    expect(() => resolveModelSelection({ spec: spec({ model: "--yolo" }) } as never)).toThrow(/model slug/);
  });

  it("matches family aliases and dated ids, and accepts anything under the runtime default", () => {
    expect(modelSatisfiesRequest("opus", "claude-opus-5-5")).toBe(true);
    expect(modelSatisfiesRequest("opus", "claude-sonnet-5-5")).toBe(false);
    expect(modelSatisfiesRequest("opus", "superopus")).toBe(false);
    expect(modelSatisfiesRequest("gemini-4-neon", "gemini-4-neon-xhigh")).toBe(true);
    expect(modelSatisfiesRequest("gemini-4-neon", "gemini-4-hydrogen")).toBe(false);
    expect(modelSatisfiesRequest(null, "anything")).toBe(true);
    expect(modelSatisfiesRequest("opus", null)).toBe(true);
  });
});

describe("ModelPreferenceStore", () => {
  it("persists, merges and clears per-runtime preferences atomically", () => {
    const store = new ModelPreferenceStore(temp(), () => 42);
    expect(store.readAll()).toEqual({});
    store.set("claude", { model: "opus" }, "codex");
    store.set("gemini", { model: "gemini-4-neon", effort: "high" }, "claude");
    store.set("claude", { effort: "max" }, "gemini");
    expect(store.get("claude")).toEqual({ model: "opus", effort: "max", updated_at: 42, updated_by: "gemini" });
    expect(store.reader("gemini")()).toMatchObject({ model: "gemini-4-neon" });
    expect(store.set("claude", { model: null, effort: null }, "codex")).toBeNull();
    expect(Object.keys(store.readAll())).toEqual(["gemini"]);
  });

  it("refuses invalid ids and ignores hand-edited invalid entries", () => {
    const directory = temp();
    const store = new ModelPreferenceStore(directory);
    expect(() => store.set("Claude", { model: "x" }, "codex")).toThrow();
    expect(() => store.set("claude", { model: "--x" }, "codex")).toThrow(/model slug/);
    writeFileSync(join(directory, "model-preferences.json"), JSON.stringify({ schema_version: 1, runtimes: {
      claude: { model: "--evil", effort: null }, codex: { model: "gpt-5.6-terra", effort: "high", updated_at: 1, updated_by: "claude" },
    } }));
    expect(store.readAll()).toEqual({ codex: { model: "gpt-5.6-terra", effort: "high", updated_at: 1, updated_by: "claude" } });
    expect(readFileSync(store.path, "utf8")).toContain("--evil");
  });
});

describe("contract helpers", () => {
  const invocation = (scope: string[]): TaskInvocation => ({
    task_id: "task_aaaaaaaaaa", spec: spec({ scope: { paths: scope } }) as never, inputs: [], workspace_root: "/w",
    lease_id: "lease_aaaaaaaaaa", deadline_at: 0, attempt: 0, idempotency_key: "k",
  });

  it("builds a read-only contract without write globs", () => {
    const prompt = buildContractPrompt(invocation(["(no-write)/**"]), { runtimeLabel: "Gemini", resuming: false });
    expect(prompt).toMatch(/READ-ONLY/);
    expect(prompt).not.toMatch(/may only modify files/);
    expect(buildContractPrompt(invocation(["src/**"]), { runtimeLabel: "Gemini", resuming: true, turnCeiling: 20 }))
      .toMatch(/resuming[\s\S]*src\/\*\*[\s\S]*about 20 agent turns/);
  });

  it("parses the last JSON block and separates rejected verification claims", () => {
    const parsed = parseStructuredOutput("```json\n{\"summary\":\"old\"}\n```\ntext\n```json\n{\"summary\":\"new\"}\n```\n");
    expect(parsed?.summary).toBe("new");
    const { accepted, rejected } = sanitizeVerificationClaims([
      { kind: "test", command: "npm test", passed: true, exit_code: 0, summary: "ok" },
      { kind: "test", command: "npm test", passed: true, exit_code: 1, summary: "lie" },
      { kind: "shell", command: "x", passed: true, exit_code: 0, summary: "bad kind" },
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected.map((r) => r.index)).toEqual([1]);
  });

  it("drops absolute, traversal and control-character paths", () => {
    expect(sanitizeChangedPaths(["src/a.ts", "/etc/passwd", "../x", "C:/x", "a\\b", "ok/b.ts", "a\u0000b", 3]))
      .toEqual(["src/a.ts", "ok/b.ts"]);
  });
});
