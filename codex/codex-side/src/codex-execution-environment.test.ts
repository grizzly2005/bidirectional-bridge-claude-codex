import { describe, expect, it } from "vitest";

import { parseWslWorkspace, resolveCodexExecutionEnvironment } from "./codex-execution-environment.js";

const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\kali\\project with spaces";
const executable = "/home/kali/bin/codex";

describe("Codex Windows/WSL execution environment", () => {
  it.each([
    workspace,
    "\\\\wsl$\\Ubuntu\\home\\kali\\project with spaces",
    "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\kali\\project with spaces",
    "//WSL.LOCALHOST/Ubuntu/home/kali/project with spaces/",
  ])("maps the real distribution and Linux path from %s", path => {
    expect(parseWslWorkspace(path)).toEqual({ distribution: "Ubuntu", path: "/home/kali/project with spaces" });
  });

  it("keeps a local Windows runtime unchanged", () => {
    const env = resolveCodexExecutionEnvironment({ cwd: "C:\\repo" }, "win32");
    expect(env).toMatchObject({ kind: "native", process_cwd: "C:\\repo", runtime_workspace: "C:\\repo" });
    expect(env.toRuntimeCwd("C:\\other")).toBe("C:\\other");
    expect(env.command).toBeUndefined();
    expect(env.toRuntimeConfig({ sandbox: "read-only" })).toEqual({ sandbox: "read-only" });
  });

  it("preserves Node's extended local drive spelling", () => {
    const cwd = "\\\\?\\C:\\repo";
    const env = resolveCodexExecutionEnvironment({ cwd }, "win32");
    expect(env.process_cwd).toBe(cwd);
    expect(env.toRuntimeCwd(cwd)).toBe(cwd);
  });

  it("refuses UNC for native Windows, including a request after a local process cwd", () => {
    expect(() => resolveCodexExecutionEnvironment({ cwd: workspace }, "win32")).toThrow("explicitly select");
    const local = resolveCodexExecutionEnvironment({ cwd: "C:\\repo" }, "win32");
    expect(() => local.toRuntimeCwd(workspace)).toThrow("UNC workspaces");
    expect(() => local.toRuntimeCwd("\\\\fileserver\\share\\repo")).toThrow("UNC workspaces");
  });

  it("constructs a shell-free WSL launch and maps nested permission roots", () => {
    const env = resolveCodexExecutionEnvironment({ cwd: workspace, wsl_executable: executable }, "win32", "C:\\Windows");
    expect(env).toMatchObject({ kind: "wsl", command: "C:\\Windows\\System32\\wsl.exe", process_cwd: "C:\\Windows\\System32",
      runtime_workspace: "/home/kali/project with spaces",
      args: ["--distribution", "Ubuntu", "--cd", "/home/kali/project with spaces", "--exec", executable, "app-server"] });
    const config = { sandbox_workspace_write: { writable_roots: [`${workspace}\\output`] }, sandbox: "read-only" };
    expect(env.toRuntimeConfig(config)).toEqual({ sandbox_workspace_write: { writable_roots: ["/home/kali/project with spaces/output"] }, sandbox: "read-only" });
    expect(config.sandbox_workspace_write.writable_roots[0]).toContain("\\\\wsl.localhost");
    expect(env.toRuntimeCwd(workspace.replace("wsl.localhost", "wsl$"))).toBe(env.runtime_workspace);
  });

  it.each(["\\\\wsl.localhost\\Debian\\home\\kali\\project with spaces", "\\\\wsl$\\Ubuntu\\home\\kali\\other", "C:\\repo", `${workspace}\\subdir`])(
    "refuses a different session root %s", path => {
      const env = resolveCodexExecutionEnvironment({ cwd: workspace, wsl_executable: executable }, "win32");
      expect(() => env.toRuntimeCwd(path)).toThrow();
    });

  it("does not case-fold Linux paths or accept foreign Windows config roots", () => {
    const env = resolveCodexExecutionEnvironment({ cwd: workspace, wsl_executable: executable }, "win32");
    expect(() => env.toRuntimeCwd(workspace.replace("project", "PROJECT"))).toThrow();
    expect(() => env.toRuntimeConfig({ sandbox_workspace_write: { writable_roots: ["C:\\repo"] } })).toThrow();
    expect(() => env.toRuntimeConfig({ sandbox_workspace_write: { writable_roots: ["\\\\?\\C:\\repo"] } })).toThrow();
    expect(() => env.toRuntimeConfig({ sandbox_workspace_write: { writable_roots: ["\\repo"] } })).toThrow();
    expect(() => env.toRuntimeConfig({ shell_environment_policy: { set: { PATH: "C:\\bin;C:\\Windows" } } })).toThrow();
  });

  it.each(["codex", "C:\\codex.exe", "/mnt/c/codex.exe", "/home/kali/../codex", "/tmp/codex\n"])("refuses invalid Linux executable %s", path => {
    expect(() => resolveCodexExecutionEnvironment({ cwd: workspace, wsl_executable: path }, "win32")).toThrow("absolute Linux executable");
  });

  it("rejects unsupported host/workspace combinations and traversal", () => {
    expect(() => resolveCodexExecutionEnvironment({ cwd: workspace, wsl_executable: executable }, "linux")).toThrow("Windows bridge");
    expect(() => resolveCodexExecutionEnvironment({ cwd: "C:\\repo", wsl_executable: executable }, "win32")).toThrow("WSL UNC");
    expect(() => parseWslWorkspace("\\\\wsl$\\Ubuntu\\home\\..\\etc")).toThrow("traversal");
    expect(parseWslWorkspace("\\\\fileserver\\share\\project")).toBeUndefined();
  });
});
