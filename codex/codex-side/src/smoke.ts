import {
  DeliverableStatus,
  type InvocationContext,
  type TaskInvocation,
} from "@bridge/protocol";

import { CodexAdapter } from "./codex-adapter.js";
import { CodexMcpProcessClient } from "./codex-mcp-client.js";

const invoke = process.argv.includes("--invoke");
const client = new CodexMcpProcessClient(
  invoke
    ? {
        // A synthetic sentinel, not a credential. The delegated shell must not receive it.
        env: { BRIDGE_TEST_SECRET_TOKEN: "synthetic-regression-sentinel" },
      }
    : {},
);

try {
  const report = await client.probe();
  const output: Record<string, unknown> = { probe: report };
  if (report.state !== "READY") {
    process.exitCode = 1;
  } else if (invoke) {
    const controller = new AbortController();
    const deadlineAt = Date.now() + 90_000;
    const timer = setTimeout(
      () => controller.abort(new Error("live smoke deadline elapsed")),
      90_000,
    );
    timer.unref();
    const invocation: TaskInvocation = {
      task_id: "task_c0d3xsm0k3",
      spec: {
        objective:
          "Run exactly this command once and no other command: node -e \"if (process.env.BRIDGE_TEST_SECRET_TOKEN) { console.error('SECRET_LEAKED'); process.exit(9); } console.log('SECRET_EXCLUDED')\". Do not read or modify repository files. Return a valid COMPLETE bridge deliverable with no artifacts and the real verification result.",
        scope: { paths: ["codex/codex-side/.smoke-never-write/**"] },
        dependencies: [],
        expected_deliverable: "A structured deliverable proving the Codex MCP request and response path works.",
        verification_criteria: [
          "The exact node -e command exits zero and prints SECRET_EXCLUDED, proving the synthetic secret-named variable was filtered from the delegated shell.",
        ],
      },
      inputs: [],
      workspace_root: process.cwd(),
      lease_id: "lease_c0d3xsm0k3",
      deadline_at: deadlineAt,
      attempt: 0,
      idempotency_key: `live-smoke-${deadlineAt}`,
    };
    const statuses: unknown[] = [];
    const verifications: unknown[] = [];
    const executionHandles: string[] = [];
    const ctx: InvocationContext = {
      async saveExecutionHandle(handle): Promise<void> {
        executionHandles.push(handle);
      },
      async report(update): Promise<void> {
        statuses.push(update);
      },
      async publishArtifact(): Promise<string> {
        throw new Error("live smoke must not publish artifacts");
      },
      async recordVerification(result): Promise<void> {
        verifications.push(result);
      },
      async raiseBlocker(): Promise<void> {
        // The returned deliverable captures any blocker.
      },
      signal: controller.signal,
    };
    const adapter = new CodexAdapter({
      client,
      sandbox: "read-only",
      approval_policy: "never",
      max_concurrency: 1,
    });
    try {
      const deliverable = await adapter.invoke(invocation, ctx);
      output.invocation = { deliverable, statuses, verifications, executionHandles };
      if (
        deliverable.status !== DeliverableStatus.COMPLETE ||
        deliverable.verification_results.length === 0 ||
        deliverable.verification_results.some((result) => !result.passed)
      ) {
        process.exitCode = 1;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await client.close();
}
