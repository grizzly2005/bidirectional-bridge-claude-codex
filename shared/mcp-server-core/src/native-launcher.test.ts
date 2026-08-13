import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const launcher = join(repoRoot, "scripts", "native-bridge-mcp.mjs");

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

class NativeHarness {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { readonly resolve: (message: JsonRpcMessage) => void; readonly reject: (error: Error) => void }
  >();
  private nextId = 1;
  private buffer = "";
  readonly stdoutLines: string[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(
    caller: "codex" | "claude",
    policy: "allow" | "deny",
    workspace?: string,
    db?: string,
    cwd = repoRoot,
  ) {
    const args = [launcher, "--caller", caller, "--delegation", policy];
    if (workspace !== undefined) args.push("--workspace", workspace);
    if (db !== undefined) args.push("--db", db);
    this.child = spawn(
      process.execPath,
      args,
      { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    this.exited = new Promise((done) => this.child.once("exit", done));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.child.once("exit", (code) => {
      const error = new Error(`native launcher exited with ${code ?? "null"}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.stdoutLines.push(line);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`timeout waiting for ${method}: ${this.stderr.join("").slice(-1000)}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolveRequest(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "native-launcher-test", version: "1.0.0" },
    });
    expect(response.error).toBeUndefined();
    this.notify("notifications/initialized");
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    const result = response.result as {
      readonly isError?: boolean;
      readonly content: ReadonlyArray<{ readonly text: string }>;
    };
    return {
      isError: result.isError ?? false,
      data: JSON.parse(result.content[0]!.text) as Record<string, any>,
    };
  }

  async shutdown(): Promise<number | null> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timeout = Symbol("timeout");
    const result = await Promise.race([
      this.exited,
      new Promise<typeof timeout>((resolveTimeout) => setTimeout(() => resolveTimeout(timeout), 5_000)),
    ]);
    if (result !== timeout) return result;
    this.child.kill("SIGTERM");
    const terminated = await Promise.race([
      this.exited,
      new Promise<typeof timeout>((resolveTimeout) => setTimeout(() => resolveTimeout(timeout), 5_000)),
    ]);
    if (terminated !== timeout) return terminated;
    this.child.kill("SIGKILL");
    return this.exited;
  }
}

function recursiveFileHashes(root: string): Array<{ readonly path: string; readonly sha256: string }> {
  const files: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`unexpected non-file skill entry: ${relative}`);
    }
  };
  visit(root);
  return files.sort().map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(join(root, ...path.split("/")))).digest("hex"),
  }));
}

function taskSpec() {
  return {
    objective: "prove shared native MCP state",
    scope: { paths: ["BENCHMARK/native-mcp/**"] },
    dependencies: [],
    expected_deliverable: "a durable root task",
    verification_criteria: ["the other stdio process can read it"],
  };
}

describe("native project MCP launcher", () => {
  it("strictly parses startup-bound identity and delegation policy", async () => {
    const module = await import("../../../scripts/native-bridge-mcp.mjs");
    const suppliedCwd = resolve(repoRoot, "external-default-workspace-fixture");
    expect(module.parseNativeBridgeArgs(
      ["--caller", "codex", "--delegation", "allow"],
      suppliedCwd,
    )).toMatchObject({
      caller: "codex",
      delegation: "allow",
      workspace: suppliedCwd,
      databasePath: join(suppliedCwd, ".bridge", "bridge.db"),
    });
    expect(module.parseNativeBridgeArgs(
      ["--caller", "codex", "--delegation", "allow", "--workspace", "managed", "--db", "state/custom.db"],
      suppliedCwd,
    )).toMatchObject({
      workspace: join(suppliedCwd, "managed"),
      databasePath: join(suppliedCwd, "managed", "state", "custom.db"),
    });
    expect(() => module.parseNativeBridgeArgs(["--caller", "claude"]))
      .toThrow("--delegation must be allow or deny");
    expect(() => module.parseNativeBridgeArgs(["--caller", "supervisor", "--delegation", "allow"]))
      .toThrow("--caller must be codex or claude");
  });

  it("exposes a portable linked command with a Unix shebang", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      readonly private?: boolean;
      readonly bin?: Record<string, string>;
    };
    expect(rootPackage.private).toBe(true);
    expect(rootPackage.bin).toEqual({
      "claude-codex-bridge": "./scripts/native-bridge-mcp.mjs",
    });
    expect(readFileSync(launcher, "utf8").split(/\r?\n/u)[0]).toBe("#!/usr/bin/env node");
    if (process.platform !== "win32") expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it("runs when npm-style linking reaches the launcher through a symlinked checkout", () => {
    const temp = mkdtempSync(join(tmpdir(), "bridge-linked-launcher-"));
    const linkedRoot = join(temp, "bidirectional-bridge");
    try {
      symlinkSync(repoRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      const result = spawnSync(
        process.execPath,
        [join(linkedRoot, "scripts", "native-bridge-mcp.mjs"), "--help"],
        { cwd: temp, encoding: "utf8", windowsHide: true },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("default: current working directory");
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("uses portable project configurations that target the same launcher", () => {
    const codexText = readFileSync(join(repoRoot, ".codex", "config.toml"), "utf8");
    const claudePath = join(repoRoot, ".mcp.json");
    expect(existsSync(claudePath), ".mcp.json must be produced by the delegated Claude task").toBe(true);
    const claudeText = readFileSync(claudePath, "utf8");
    const claudeConfig = JSON.parse(claudeText) as {
      readonly mcpServers?: Record<string, { readonly command?: string; readonly args?: readonly string[] }>;
    };

    expect(codexText).toContain("[mcp_servers.bridge]");
    expect(codexText).toMatch(/command\s*=\s*"node"/u);
    const codexArgsMatch = codexText.match(/args\s*=\s*\[([^\]]+)\]/u);
    expect(codexArgsMatch).not.toBeNull();
    const codexArgs = JSON.parse(`[${codexArgsMatch![1]}]`) as string[];
    const claudeEntry = claudeConfig.mcpServers?.["bridge"];
    expect(claudeEntry?.command).toBe("node");
    expect(codexArgs[0]).toBe("scripts/native-bridge-mcp.mjs");
    expect(claudeEntry?.args?.[0]).toMatch(/scripts[\\/]native-bridge-mcp\.mjs$/u);
    expect(codexArgs).toEqual([
      "scripts/native-bridge-mcp.mjs",
      "--caller",
      "codex",
      "--delegation",
      "allow",
      "--workspace",
      ".",
    ]);
    expect(claudeEntry?.args).toEqual(
      expect.arrayContaining(["--caller", "claude", "--delegation", "allow"]),
    );

    const combined = `${codexText}\n${claudeText}`;
    expect(combined).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(combined).not.toMatch(/api[_-]?key|credential|password|secret|token/iu);

    const externalCodex = readFileSync(
      join(repoRoot, "codex", "codex-side", "examples", "codex-project-config.toml"),
      "utf8",
    );
    const externalClaudePath = join(
      repoRoot,
      "claude",
      "claude-side",
      "examples",
      "claude-project-mcp.json",
    );
    expect(existsSync(externalClaudePath)).toBe(true);
    const externalClaude = readFileSync(externalClaudePath, "utf8");
    const externalClaudeConfig = JSON.parse(externalClaude) as {
      readonly mcpServers?: Record<string, { readonly command?: string; readonly args?: string[] }>;
    };
    expect(externalCodex).toContain('[mcp_servers.bridge]');
    expect(externalCodex).toMatch(/command\s*=\s*"claude-codex-bridge"/u);
    expect(externalCodex).toContain('cwd = "."');
    expect(externalCodex).toContain('tool_timeout_sec = 1800');
    expect(externalCodex).toContain('"--workspace", "."');
    expect(externalClaudeConfig.mcpServers?.["bridge"]?.command).toBe("claude-codex-bridge");
    expect(externalClaudeConfig.mcpServers?.["bridge"]?.args).toEqual(
      expect.arrayContaining(["--caller", "claude", "--delegation", "allow", "--workspace", "${CLAUDE_PROJECT_DIR:-.}"]),
    );
    const externalCombined = `${externalCodex}\n${externalClaude}`;
    expect(externalCombined).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(externalCombined).not.toMatch(/api[_-]?key|credential|password|secret|token/iu);
    expect(externalCombined).not.toContain("scripts/native-bridge-mcp.mjs");
  });

  it("keeps the Claude and Codex using-bridge skill mirrors byte-identical", () => {
    const codexSkill = join(repoRoot, ".codex", "skills", "using-bridge");
    const claudeSkill = join(repoRoot, ".claude", "skills", "using-bridge");
    const codexFiles = recursiveFileHashes(codexSkill);
    const claudeFiles = recursiveFileHashes(claudeSkill);
    expect(codexFiles).toEqual(claudeFiles);
    expect(codexFiles.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["SKILL.md", "agents/openai.yaml", "references/routing-policy.md"]),
    );
  });

  it("starts from an external workspace without a local scripts tree and stores state there", async () => {
    const externalWorkspace = mkdtempSync(join(tmpdir(), "bridge-external-workspace-"));
    expect(existsSync(join(externalWorkspace, "scripts"))).toBe(false);
    const harness = new NativeHarness("codex", "allow", undefined, undefined, externalWorkspace);
    try {
      await harness.initialize();
      expect((await harness.callTool("bridge_server_info")).data).toEqual({
        caller: "codex",
        delegation: "allow",
      });
      expect(existsSync(join(externalWorkspace, ".bridge", "bridge.db"))).toBe(true);
      expect(existsSync(join(externalWorkspace, "scripts", "native-bridge-mcp.mjs"))).toBe(false);
    } finally {
      const exit = await harness.shutdown();
      rmSync(externalWorkspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      expect(exit, `external launcher stderr: ${harness.stderr.join("").slice(-1000)}`).toBe(0);
    }
  }, 30_000);

  it("shares state across separate stdio processes with pure JSON-RPC stdout", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bridge-native-launcher-"));
    const db = join(workspace, ".bridge", "shared.db");
    const codex = new NativeHarness("codex", "allow", workspace, db);
    const claude = new NativeHarness("claude", "deny", workspace, db);
    const codexDenied = new NativeHarness("codex", "deny", workspace, db);
    try {
      await codex.initialize();
      await claude.initialize();
      await codexDenied.initialize();
      expect((await codex.callTool("bridge_server_info")).data)
        .toEqual({ caller: "codex", delegation: "allow" });
      expect((await claude.callTool("bridge_server_info")).data)
        .toEqual({ caller: "claude", delegation: "deny" });
      expect((await codexDenied.callTool("bridge_server_info")).data)
        .toEqual({ caller: "codex", delegation: "deny" });

      const root = await codex.callTool("bridge_create_task", {
        spec: taskSpec(),
        run_id: "run_0000000001",
      });
      expect(root.data).toMatchObject({
        run_id: "run_0000000001",
        parent_task_id: null,
        delegation_depth: 0,
      });
      const observed = await claude.callTool("bridge_get_task", { task_id: root.data.task_id });
      expect(observed.data.task).toMatchObject({
        task_id: root.data.task_id,
        created_by: "codex",
      });

      const spoof = await codex.callTool("bridge_claim_task", {
        task_id: root.data.task_id,
        agent: "claude",
      });
      expect(spoof.isError).toBe(true);
      expect(spoof.data.error.code).toBe("INVALID_ARGUMENT");

      const denied = await claude.callTool("bridge_delegate", {
        to: "codex",
        spec: taskSpec(),
        deadline_ms: 5_000,
      });
      expect(denied.isError).toBe(true);
      expect(denied.data.error.details).toMatchObject({ policy: "deny", caller: "claude" });

      const deniedByCodex = await codexDenied.callTool("bridge_delegate", {
        to: "claude",
        spec: taskSpec(),
        deadline_ms: 5_000,
      });
      expect(deniedByCodex.isError).toBe(true);
      expect(deniedByCodex.data.error.details).toMatchObject({
        policy: "deny",
        caller: "codex",
      });

      for (const line of [...codex.stdoutLines, ...claude.stdoutLines, ...codexDenied.stdoutLines]) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      }
    } finally {
      const exits = await Promise.all([
        codex.shutdown(),
        claude.shutdown(),
        codexDenied.shutdown(),
      ]);
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      expect(
        exits,
        [
          `codex stderr: ${codex.stderr.join("").slice(-1000)}`,
          `claude stderr: ${claude.stderr.join("").slice(-1000)}`,
          `codex-deny stderr: ${codexDenied.stderr.join("").slice(-1000)}`,
        ].join("\n"),
      ).toEqual([0, 0, 0]);
    }
  }, 30_000);
});
