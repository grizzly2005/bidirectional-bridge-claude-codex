import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ControlPlane } from "@bridge/control-plane";
import { BridgeMcpServer } from "./server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("exposes a cold-start project resume tool with live schema and verified worker attribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-resume-tool-"));
  const cp = ControlPlane.open({ workspaceRoot: root, databasePath: ":memory:" });
  const server = new BridgeMcpServer({ workspaceRoot: root, controlPlane: cp, agent: "gemini", delegationPolicy: "deny" });
  const client = new Client({ name: "resume-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); cp.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find(block => block.type === "text");
    return { error: result.isError === true, data: JSON.parse(text?.type === "text" ? text.text : "{}") };
  };
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain("bridge_resume_project");
  expect((await call("bridge_resume_project")).data.project.schema_version).toBe(6);
  expect((await call("bridge_doctor")).data.database.schema_version).toBe(6);
  const manager = cp.tasks.create({ created_by: "gemini", spec: { objective: "manager", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "note", verification_criteria: ["fixture"] } });
  const worker = cp.tasks.create({ created_by: "claude", spec: { objective: "worker", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "note", verification_criteria: ["fixture"] } });
  cp.tasks.claim(manager.task_id, "gemini"); cp.tasks.transition({ task_id: manager.task_id, agent: "gemini", to: "WORKING" });
  cp.tasks.claim(worker.task_id, "claude"); cp.tasks.transition({ task_id: worker.task_id, agent: "claude", to: "WORKING" });
  const scope = { namespace: "development", context_id: "BELIEF" };
  const saved = await call("memory_upsert", { task_id: manager.task_id, scope, key: "handoff", expected_revision: 0,
    idempotency_key: "handoff", note: { kind: "decision", title: "Handoff", summary: "Worker inspected the core.",
      contributed_by: "claude", related_task_ids: [worker.task_id] } });
  expect(saved.error).toBe(false);
  const card = (await call("bridge_resume_project", {})).data;
  expect(card.project.scopes).toHaveLength(1);
  expect(card.decisions[0]).toMatchObject({ recorded_by: "gemini", contributed_by: "claude", resolved_authors: ["claude"] });
  const rejected = await call("memory_upsert", { task_id: manager.task_id, scope, key: "forged", expected_revision: 0,
    idempotency_key: "forged", note: { kind: "decision", title: "Forged", summary: "No proof", contributed_by: "codex" } });
  expect(rejected.error).toBe(true); expect(rejected.data.error.code).toBe("INVALID_ARGUMENT");
});
