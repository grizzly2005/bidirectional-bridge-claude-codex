import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ControlPlane, Orchestrator } from "../../dist/index.js";
const [workspace, database, key, mode = "success", scope = `${key}/**`] = process.argv.slice(2);
const cp = ControlPlane.open({ workspaceRoot: workspace, databasePath: database });
if (mode === "queued-crash") {
  const task = cp.tasks.create({ spec: { objective: "lost queued work", scope: { paths: ["lost/**"] },
    dependencies: [], expected_deliverable: "fixture", verification_criteria: ["fixture"] }, created_by: "claude" });
  cp.tasks.claim(task.task_id, "codex"); cp.executions.queue(task.task_id, 0, "codex", 1); process.exit(53);
}
cp.adapters.register({
  info: { agent: "codex", implementation: "local-fixture", version: "1.0.0", max_concurrency: 1,
    capabilities: ["stop-confirmation", "resume"] },
  health: async () => ({ status: "READY", checked_at: Date.now() }), cancel: async () => {},
  invoke: async (invocation, ctx) => {
    // Exit immediately after launch authorization, before any simulated work or handle.
    if (mode === "crash-before-handle") process.exit(51);
    await ctx.reportRuntimeState("running");
    await ctx.saveExecutionHandle(`fixture_${invocation.task_id}`);
    const log = join(workspace, "runtime.log");
    appendFileSync(log, JSON.stringify({ type: "start", task_id: invocation.task_id, at: Date.now() }) + "\n");
    if (mode === "crash") process.exit(52);
    await new Promise(resolve => {
      const timer = setTimeout(resolve, mode === "cancel" ? 20_000 : 160);
      ctx.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    appendFileSync(log, JSON.stringify({ type: "stop", task_id: invocation.task_id, at: Date.now() }) + "\n");
    await ctx.reportRuntimeState("stopped");
    await ctx.reportTelemetry({ runtime: "fixture", input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    const verification = { kind: "test", command: "local fixture", passed: true, exit_code: 0, summary: "checked" };
    return { task_id: invocation.task_id, agent: "codex", status: ctx.signal.aborted ? "PARTIAL" : "COMPLETE",
      summary: "Fixture finished", changed_scope: [], artifacts: [], commit_or_diff: null,
      verification_performed: [verification.command], verification_results: [verification],
      remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: Date.now() };
  },
});
try {
  const result = await new Orchestrator(cp).delegate({ from: "claude", to: "codex", idempotency_key: key,
    spec: { objective: "durable fixture", scope: { paths: [scope] }, dependencies: [],
      expected_deliverable: "fixture", verification_criteria: ["fixture"] }, input_artifacts: [], deadline_ms: 5000 });
  process.stdout.write(JSON.stringify(result));
} finally { cp.close(); }
