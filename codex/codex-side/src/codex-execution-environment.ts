import { posix, win32 } from "node:path";

import { BridgeError, ErrorCode } from "@bridge/protocol";

export interface WslWorkspace {
  readonly distribution: string;
  readonly path: string;
}

/** Parse both WSL share aliases and Node's extended UNC spelling on any host. */
export function parseWslWorkspace(path: string): WslWorkspace | undefined {
  const unc = path.replace(/\\/gu, "/").replace(/^\/\/\?\/UNC\//iu, "//");
  const match = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/iu.exec(unc);
  if (!match) return undefined;
  const distribution = match[1]!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(distribution) || /[\x00-\x1f]/u.test(unc)) {
    throw unsupported("Invalid WSL distribution or workspace path");
  }
  const tail = match[2] ?? "/";
  if (tail.split("/").some(segment => segment === "." || segment === "..")) {
    throw unsupported("WSL workspace paths must not contain traversal segments");
  }
  return { distribution, path: posix.normalize(tail).replace(/\/$/u, "") || "/" };
}

function isUnc(path: string): boolean {
  // Extended local drive paths are not UNC shares (Node may return this spelling).
  return /^[\\/]{2}/u.test(path) && !/^[\\/]{2}\?[\\/][a-z]:[\\/]/iu.test(path);
}

function unsupported(message: string): BridgeError {
  return new BridgeError(ErrorCode.RUNTIME_PROFILE_MISMATCH, message, {
    runtime_stop_confirmed: true,
    runtime_failure: { category: "profile", source: "runtime_code", retryable: false, retry_after_at: null },
  });
}

export interface CodexExecutionEnvironment {
  readonly kind: "native" | "wsl";
  readonly process_cwd: string;
  readonly runtime_workspace: string;
  readonly command?: string;
  readonly args?: readonly string[];
  toRuntimeCwd(path: string): string;
  toRuntimeConfig(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
}

/** No copying, shell interpolation, implicit distro switch, or Windows sandbox bypass. */
export function resolveCodexExecutionEnvironment(
  options: { readonly cwd: string; readonly wsl_executable?: string },
  platform: NodeJS.Platform = process.platform,
  windowsDirectory: string = process.env["SystemRoot"] ?? "C:\\Windows",
): CodexExecutionEnvironment {
  const workspace = parseWslWorkspace(options.cwd);
  if (options.wsl_executable === undefined) {
    const validate = (path: string): string => {
      if (platform === "win32" && isUnc(path)) {
        throw unsupported("Native Windows Codex does not support UNC workspaces. For a WSL share, explicitly select --codex-wsl-executable with an absolute Linux Codex path; otherwise run the bridge inside WSL or select a real local checkout.");
      }
      return path;
    };
    return { kind: "native", process_cwd: validate(options.cwd), runtime_workspace: options.cwd,
      toRuntimeCwd: validate, toRuntimeConfig: config => config };
  }
  if (platform !== "win32" || workspace === undefined) {
    throw unsupported("--codex-wsl-executable requires a Windows bridge and a WSL UNC workspace (\\\\wsl.localhost\\<distribution>\\... or \\\\wsl$\\<distribution>\\...)");
  }
  const executable = options.wsl_executable;
  if (!executable.startsWith("/") || executable.startsWith("//") ||
      /[\\\x00-\x1f]/u.test(executable) || /\.(?:exe|cmd|bat)$/iu.test(executable) ||
      executable.split("/").some(segment => segment === ".." || segment === ".")) {
    throw unsupported("--codex-wsl-executable must be an absolute Linux executable path (a Windows Codex binary is unsupported)");
  }
  const insideWorkspace = (path: string): boolean => {
    const relative = posix.relative(workspace.path, path);
    return relative === "" || (!relative.startsWith("../") && relative !== ".." && !posix.isAbsolute(relative));
  };
  const translate = (path: string): string => {
    const candidate = parseWslWorkspace(path);
    if (candidate && candidate.distribution.toLowerCase() === workspace.distribution.toLowerCase() && insideWorkspace(candidate.path)) {
      return candidate.path;
    }
    throw unsupported("Codex WSL paths must refer to the selected distribution and repository; foreign UNC/Windows paths are unsupported");
  };
  const mapValue = (value: unknown): unknown => {
    if (typeof value === "string" && /^(?:[\\/]{2}|[a-z]:|\\)/iu.test(value)) return translate(value);
    if (Array.isArray(value)) return value.map(mapValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValue(item)]));
    }
    return value;
  };
  return {
    kind: "wsl",
    // Only the Windows bootstrap runs here. wsl.exe --cd and every session root name the
    // real Linux repository; this directory is never a replacement workspace.
    process_cwd: win32.join(windowsDirectory, "System32"),
    runtime_workspace: workspace.path,
    command: win32.join(windowsDirectory, "System32", "wsl.exe"),
    args: ["--distribution", workspace.distribution, "--cd", workspace.path, "--exec", executable, "app-server"],
    toRuntimeCwd(path) {
      const mapped = translate(path);
      if (mapped !== workspace.path) throw unsupported("A Codex WSL client is bound to one repository root");
      return mapped;
    },
    toRuntimeConfig(config) {
      return config === undefined ? undefined : mapValue(config) as Record<string, unknown>;
    },
  };
}
