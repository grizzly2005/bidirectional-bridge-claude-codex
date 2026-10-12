import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ControlPlane } from "@bridge/control-plane";
import { ErrorCode, seededRandom } from "@bridge/protocol";
import { BridgeMcpServer } from "./server.js";

let cp: ControlPlane, dir: string;
const close: Array<() => Promise<void>> = [];
const scope = { namespace: "development", context_id: "fixture-project" };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bridge-memory-tools-")); cp = ControlPlane.open({ workspaceRoot: dir, databasePath: ":memory:", rng: seededRandom(951) }); });
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); cp.close(); rmSync(dir, { recursive: true, force: true }); });
async function peer(agent: string) {
  const server = new BridgeMcpServer({ workspaceRoot: dir, controlPlane: cp, agent, delegationPolicy: "deny" });
  const client = new Client({ name: `memory-test-${agent}`, version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  close.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const block = result.content.find(value => value.type === "text");
    const text = block?.type === "text" ? block.text : "";
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    return { error: result.isError === true, data, text };
  };
  const root = await call("bridge_create_task", { spec: { objective: "memory test", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "note", verification_criteria: ["fixture"] } });
  const taskId = root.data.task_id as string;
  await call("bridge_claim_task", { task_id: taskId }); await call("bridge_set_state", { task_id: taskId, to: "WORKING" });
  return { client, call, taskId };
}

describe("shared memory through real MCP validation", () => {
  it("exposes three operations and normalizes scope/draft defaults without loading notes into instructions", async () => {
    const codex = await peer("codex"); const names = (await codex.client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith("memory_"));
    expect(names.sort()).toEqual(["memory_get_changes", "memory_get_context", "memory_upsert"]);
    const saved = await codex.call("memory_upsert", { task_id: codex.taskId, scope, key: "architecture", expected_revision: 0, idempotency_key: "create", note: { kind: "decision", title: "Keep canonical artifacts", summary: "Reuse SQLite for notes." } });
    expect(saved.error).toBe(false); expect(saved.data.lifecycle).toBe("active");
    expect(saved.data.scope).toEqual({ ...scope, branch: null, application_version: null, epoch: null });
    expect(saved.data.provenance.agent).toBe("codex");
    const context = await codex.call("memory_get_context", { scope });
    expect(context.data.notes[0].key).toBe("architecture");
    const history = await codex.call("memory_get_changes", { scope });
    expect(history.data.changes.map((note: { revision: number }) => note.revision)).toEqual([1]);
  });

  it("allows the other caller to read, enrich and receive an explicit stale revision conflict", async () => {
    const codex = await peer("codex"), claude = await peer("claude");
    const first = await codex.call("memory_upsert", { task_id: codex.taskId, scope, key: "track", expected_revision: 0, idempotency_key: "codex-track", note: { kind: "observation", title: "Track", summary: "Needs a witness." } });
    expect((await claude.call("memory_get_context", { scope })).data.notes[0].revision).toBe(1);
    const enriched = await claude.call("memory_upsert", { task_id: claude.taskId, scope, key: "track", expected_revision: 1, idempotency_key: "claude-track", note: { kind: "observation", title: "Track", summary: "A workflow prerequisite is missing." } });
    expect(enriched.data.provenance.agent).toBe("claude");
    const changes = await codex.call("memory_get_changes", { scope, change_cursor: first.data.change_cursor });
    expect(changes.data.changes.map((note: { revision: number }) => note.revision)).toEqual([2]);
    const stale = await codex.call("memory_upsert", { task_id: codex.taskId, scope, key: "track", expected_revision: 1, idempotency_key: "stale", note: { kind: "decision", title: "Stale", summary: "Old state." } });
    expect(stale.error).toBe(true); expect(stale.data.error.code).toBe(ErrorCode.REVISION_CONFLICT);
    const foreign = await claude.call("memory_upsert", { task_id: codex.taskId, scope, key: "foreign", expected_revision: 0, idempotency_key: "foreign", note: { kind: "decision", title: "Foreign", summary: "Cannot use old author's authority." } });
    expect(foreign.data.error.code).toBe(ErrorCode.NOT_OWNER);
  });

  it("rejects forged metadata and finding fields through the wire schema", async () => {
    const codex = await peer("codex");
    for (const extra of [{ provenance: { agent: "claude" } }, { verdict: "confirmed-with-evidence" }, { bodyBase64: "raw" }]) {
      const rejected = await codex.call("memory_upsert", { task_id: codex.taskId, scope, key: "invalid", expected_revision: 0, idempotency_key: "invalid", note: { kind: "observation", title: "Invalid", summary: "Text", ...extra } });
      expect(rejected.error).toBe(true);
    }
    expect((await codex.call("memory_get_context", { scope })).data.notes).toEqual([]);
  });

  it("bounds the actual MCP text payload and retains explicit oversized-note omissions", async () => {
    const codex = await peer("codex");
    await codex.call("memory_upsert", { task_id: codex.taskId, scope, key: "long", expected_revision: 0, idempotency_key: "long", note: { kind: "decision", title: "Unicode", summary: "😀".repeat(800) } });
    const small = await codex.call("memory_get_context", { scope, max_bytes: 2048 });
    expect(Buffer.byteLength(small.text, "utf8")).toBeLessThanOrEqual(2048);
    expect(small.data.omitted[0].key).toBe("long"); expect(small.data.notes).toEqual([]);
    const full = await codex.call("memory_get_context", { scope, keys: ["long"], max_bytes: 16384 });
    expect(full.data.notes[0].summary).toBe("😀".repeat(800));
    const blocked = await codex.call("memory_get_changes", { scope, max_bytes: 2048 });
    expect(blocked.data.error.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(blocked.data.error.details.change_cursor).toBe(0);
  });
});
