/**
 * Static guard: nothing on the stdio server path may write to stdout.
 *
 * The live smoke test proves stdout is clean for the paths it exercises. This one covers
 * the paths it does not — an error branch, a rarely-hit warning — by rejecting the call
 * itself at review time. `console.log` in a stdio MCP server is a silent, intermittent
 * protocol corruption that is miserable to debug from the symptom end.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

/** Packages whose code can end up in a process that owns an MCP stdio transport. */
const GUARDED_DIRS = [
  join(repoRoot, "shared", "mcp-server-core", "src"),
  join(repoRoot, "shared", "control-plane", "src"),
  join(repoRoot, "shared", "protocol", "src"),
  join(repoRoot, "claude", "claude-side", "src"),
];
const GUARDED_FILES = [join(repoRoot, "scripts", "native-bridge-mcp.mjs")];

const FORBIDDEN: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bconsole\s*\.\s*(log|info|debug|dir|table|trace)\s*\(/, what: "console.log-family call" },
  { pattern: /\bprocess\s*\.\s*stdout\s*\.\s*write\s*\(/, what: "process.stdout.write" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      // Test files may print freely: they do not run inside the server process.
      if (entry.endsWith(".test.ts")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe("stdout purity on the MCP stdio path", () => {
  const files = [...GUARDED_DIRS.flatMap(sourceFiles), ...GUARDED_FILES];

  it("scans a non-trivial number of files, so a path change cannot silently disable it", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("contains no stdout writes anywhere on the server path", () => {
    const offences: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Skip comments: the rule is about executed code, and the surrounding docs
        // legitimately discuss `process.stdout.write` when explaining why it is banned.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(line)) {
            offences.push(`${relative(repoRoot, file)}:${i + 1} — ${what}`);
          }
        }
      });
    }

    expect(
      offences,
      `stdout is the MCP transport; these writes would corrupt the protocol stream:\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("permits stderr, so diagnostics are not simply absent", () => {
    const lifecycle = readFileSync(join(here, "lifecycle.ts"), "utf8");
    expect(lifecycle).toContain("process.stderr.write");
  });
});
