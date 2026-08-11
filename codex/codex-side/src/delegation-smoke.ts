import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textContent(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function parsedText<T>(result: unknown): T {
  const text = textContent(result);
  if ((result as { isError?: unknown } | null)?.isError === true) {
    throw new Error(`neutral bridge tool returned an error: ${text}`);
  }
  return JSON.parse(text) as T;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const tempRoot = await mkdtemp(resolve(packageRoot, ".delegation-smoke-"));
const relativeTemp = relative(packageRoot, tempRoot);
if (
  relativeTemp.length === 0 ||
  relativeTemp.startsWith("..") ||
  resolve(packageRoot, relativeTemp) !== tempRoot ||
  !tempRoot.startsWith(`${packageRoot}${sep}`)
) {
  throw new Error(`refusing unsafe smoke directory: ${tempRoot}`);
}

// Keep verification setup inside Codex's owned subtree. The live checkout can have stale
// root workspace links while another agent changes the root install; these disposable
// junctions model the final workspace dependency graph without mutating root node_modules.
const runtimeBridgeRoot = resolve(tempRoot, "node_modules", "@bridge");
try {
  await mkdir(runtimeBridgeRoot, { recursive: true });
  for (const [name, target] of [
    ["codex-side", packageRoot],
    ["mcp-server-core", resolve(repositoryRoot, "shared", "mcp-server-core")],
    ["control-plane", resolve(repositoryRoot, "shared", "control-plane")],
    ["protocol", resolve(repositoryRoot, "shared", "protocol")],
  ] as const) {
    await symlink(target, resolve(runtimeBridgeRoot, name), "junction");
  }
} catch (error) {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  throw error;
}

let stderrTail = "";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    resolve(runtimeBridgeRoot, "codex-side", "dist", "bridge-server.js"),
    "--workspace",
    repositoryRoot,
    "--db",
    resolve(tempRoot, "bridge.db"),
    "--agent",
    "supervisor",
    "--sandbox",
    "read-only",
    "--approval-policy",
    "never",
    "--max-concurrency",
    "1",
  ],
  cwd: repositoryRoot,
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk: unknown) => {
  stderrTail = (stderrTail + String(chunk)).slice(-8_000);
});

const client = new Client(
  { name: "bridge-codex-neutral-delegation-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport, { timeout: 20_000 });
  const listed = await client.listTools(undefined, { timeout: 20_000 });
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  for (const required of ["bridge_delegate", "bridge_get_task", "bridge_snapshot"]) {
    if (!toolNames.includes(required)) {
      throw new Error(`neutral server omitted required tool: ${required}`);
    }
  }

  const idempotencyKey = `neutral-real-delegation-${Date.now()}`;
  const delegated = await client.callTool(
    {
      name: "bridge_delegate",
      arguments: {
        to: "codex",
        spec: {
          objective:
            "Run exactly node --version once. Do not read or modify repository files. Return a COMPLETE structured deliverable with the real exit code and output.",
          scope: {
            paths: ["codex/codex-side/.delegation-smoke-never-write/**"],
            note: "Must remain empty; the final neutral server runs Codex read-only",
          },
          dependencies: [],
          expected_deliverable:
            "A COMPLETE Codex deliverable with no changed paths and one passing node --version verification.",
          verification_criteria: [
            "The exact command node --version ran once and returned exit code 0",
            "No repository file was created or modified",
          ],
          preferred_agent: "codex",
          tags: ["neutral-server", "real-delegation", "read-only", "codex"],
        },
        input_artifacts: [],
        deadline_ms: 90_000,
        max_attempts: 0,
        idempotency_key: idempotencyKey,
      },
    },
    undefined,
    { timeout: 120_000, maxTotalTimeout: 120_000 },
  );
  const outcome = parsedText<{
    task_id: string;
    deliverable: {
      status: string;
      changed_scope: string[];
      verification_results: Array<{ passed: boolean; exit_code: number | null }>;
    } | null;
    error: { code: string; message: string } | null;
  }>(delegated);

  if (
    outcome.error !== null ||
    outcome.deliverable?.status !== "COMPLETE" ||
    outcome.deliverable.changed_scope.length !== 0 ||
    outcome.deliverable.verification_results.length === 0 ||
    outcome.deliverable.verification_results.some(
      (result) => !result.passed || result.exit_code !== 0,
    )
  ) {
    throw new Error(`real neutral delegation did not complete safely: ${JSON.stringify(outcome)}`);
  }

  const taskResult = await client.callTool(
    { name: "bridge_get_task", arguments: { task_id: outcome.task_id } },
    undefined,
    { timeout: 20_000, maxTotalTimeout: 20_000 },
  );
  const task = parsedText<{
    task: { state: string };
    attempts: Array<{
      attempt: number;
      execution_handle: string | null;
      outcome?: string;
    }>;
  }>(taskResult);
  if (
    task.task.state !== "DONE" ||
    task.attempts.length === 0 ||
    !task.attempts.some((attempt) => Boolean(attempt.execution_handle))
  ) {
    throw new Error(`neutral control plane did not persist the Codex attempt: ${JSON.stringify(task)}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        server: "@bridge/mcp-server-core",
        runtime_resolution: "disposable Codex-local workspace junctions",
        tools: toolNames,
        outcome,
        task_state: task.task.state,
        attempts: task.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          execution_handle_persisted: Boolean(attempt.execution_handle),
          execution_handle_length: attempt.execution_handle?.length ?? 0,
          outcome: attempt.outcome ?? null,
        })),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        stderr_tail: stderrTail,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
