/**
 * Scope semantics are the load-bearing part of conflict prevention: if `globsOverlap`
 * returns false when two patterns can actually match the same file, both agents get a
 * lease over the same file and the bridge fails at its one job.
 */

import { describe, expect, it } from "vitest";
import { conflictingPairs, globsOverlap, matchesGlob, normalizePath, normalizeScope, scopeAllows, scopesConflict } from "./scope.js";

describe("normalizePath", () => {
  it("canonicalises separators, prefixes and trailing slashes", () => {
    expect(normalizePath("./a\\b/c/")).toBe("a/b/c");
    expect(normalizePath("/a//b")).toBe("a/b");
  });

  it("rejects traversal, which could otherwise escape a leased scope", () => {
    expect(() => normalizePath("a/../../etc/passwd")).toThrow(/\.\./);
  });

  it("rejects empty input", () => {
    expect(() => normalizePath("")).toThrow();
  });
});

describe("matchesGlob", () => {
  it("matches * within a single segment only", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false);
  });

  it("matches ** across segments", () => {
    expect(matchesGlob("src/deep/nested/a.ts", "src/**")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**")).toBe(true);
  });

  it("treats dir/** as covering the directory itself", () => {
    expect(matchesGlob("src", "src/**")).toBe(true);
  });

  it("matches ? as exactly one non-separator character", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a12.ts", "a?.ts")).toBe(false);
    expect(matchesGlob("a/1.ts", "a?1.ts")).toBe(false);
  });

  it("does not treat regex metacharacters as patterns", () => {
    expect(matchesGlob("a.b.ts", "a.b.ts")).toBe(true);
    expect(matchesGlob("axbxts", "a.b.ts")).toBe(false);
  });
});

describe("globsOverlap", () => {
  it("detects identical patterns", () => {
    expect(globsOverlap("claude/**", "claude/**")).toBe(true);
  });

  it("detects containment in both directions", () => {
    expect(globsOverlap("claude/**", "claude/control-plane/src/x.ts")).toBe(true);
    expect(globsOverlap("claude/control-plane/src/x.ts", "claude/**")).toBe(true);
  });

  it("separates sibling directories — the case that lets both agents work at once", () => {
    expect(globsOverlap("claude/**", "codex/**")).toBe(false);
    expect(globsOverlap("shared/protocol/**", "codex/codex-side/**")).toBe(false);
  });

  it("separates siblings that share a parent prefix", () => {
    expect(globsOverlap("packages/alpha/**", "packages/beta/**")).toBe(false);
  });

  it("reports overlap when a wildcard could span both", () => {
    expect(globsOverlap("packages/*/src/**", "packages/alpha/src/x.ts")).toBe(true);
  });

  it("treats a root-level wildcard as overlapping everything", () => {
    expect(globsOverlap("**", "claude/control-plane/src/x.ts")).toBe(true);
  });

  it("distinguishes distinct files in the same directory", () => {
    expect(globsOverlap("src/a.ts", "src/b.ts")).toBe(false);
  });
});

describe("scopesConflict", () => {
  const claude = { paths: ["shared/protocol/**", "claude/**"] };
  const codex = { paths: ["codex/**"] };

  it("lets the declared agent split coexist", () => {
    expect(scopesConflict(claude, codex)).toBe(false);
  });

  it("flags an incursion into another agent's tree and says which pair collided", () => {
    const intruder = { paths: ["claude/control-plane/src/task-service.ts"] };
    expect(scopesConflict(claude, intruder)).toBe(true);
    expect(conflictingPairs(claude, intruder)).toEqual([
      ["claude/**", "claude/control-plane/src/task-service.ts"],
    ]);
  });
});

describe("scopeAllows", () => {
  it("permits paths inside the scope and refuses those outside", () => {
    const scope = { paths: ["claude/**", "docs/*.md"] };
    expect(scopeAllows(scope, "claude/claude-side/src/index.ts")).toBe(true);
    expect(scopeAllows(scope, "docs/PROTOCOL.md")).toBe(true);
    expect(scopeAllows(scope, "docs/nested/deep.md")).toBe(false);
    expect(scopeAllows(scope, "codex/adapter.ts")).toBe(false);
  });
});

describe("normalizeScope", () => {
  it("deduplicates, sorts and canonicalises so equal scopes compare equal", () => {
    expect(normalizeScope({ paths: ["./b/", "a", "b"] }).paths).toEqual(["a", "b"]);
  });

  it("requires at least one path", () => {
    expect(() => normalizeScope({ paths: [] })).toThrow(/at least one path/);
  });
});
