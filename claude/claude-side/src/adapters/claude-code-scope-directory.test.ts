import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import type { TaskInvocation } from "@bridge/protocol";
import { ClaudeCodeRunner } from "./claude-code-runner.js";

it("keeps directory grants for nested wildcards and omits unresolved markers", () => {
  const cases: Array<[string, string[]]> = [
    ["src/**", ["src"]],
    ["src/**/*.ts", ["src"]],
    ["docs/*.md", ["docs"]],
    ["src/feature?/deep/file.ts", ["src"]],
    ["src/feature*/deep/*.ts", ["src"]],
    ["src/part**name/deep", ["src/part"]],
    ["root*/deep/file?.ts", []],
    ["**/*.ts", []],
    ["(no-write)/inspection/**", []],
  ];
  for (const [pattern, expected] of cases) {
    const invocation = { spec: { scope: { paths: [pattern] } } } as TaskInvocation;
    const args = new ClaudeCodeRunner().buildArgs(invocation, "");
    expect(args.filter((_, index) => args[index - 1] === "--add-dir")).toEqual(expected);
  }
});

it("bounds long wildcard input followed by a Unicode line separator in the compiled runner", () => {
  // The old expression exceeds a 2s subprocess probe on this repo-relative path.
  // Keep this regression in a child so a future backtracking bug cannot hang Vitest.
  const module = new URL("../../dist/adapters/claude-code-runner.js", import.meta.url).href;
  const script = `import {ClaudeCodeRunner} from ${JSON.stringify(module)};
    const path = 'src/' + '*'.repeat(150000) + '\\u2028x';
    const args = new ClaudeCodeRunner().buildArgs({spec:{scope:{paths:[path]}}}, '');
    console.log(JSON.stringify(args.filter((_,index) => args[index-1] === '--add-dir')));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(JSON.parse(output)).toEqual(["src"]);
});
