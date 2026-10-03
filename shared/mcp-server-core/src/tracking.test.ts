import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import type { DatabaseSync as DatabaseCtor } from "node:sqlite";
import { ControlPlane, ManualClock } from "@bridge/control-plane";
import { seededRandom, type TaskSpec } from "@bridge/protocol";
import { TrackingCoordinator } from "./tracking.js";
import { TrackingReader, TRACKING_EVENT_LIMIT } from "./tracking-reader.js";
import { TrackingMcpServer } from "./tracking-server.js";
import { TrackingHttpServer } from "./tracking-http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseCtor };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const spec: TaskSpec = { objective: "PRIVATE_PROMPT sk-secret C:\\private\\person", scope: { paths: ["private/**"] }, dependencies: [], expected_deliverable: "PRIVATE_PROMPT", verification_criteria: ["check"] };
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "bridge-tracking-test-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const clock = new ManualClock(1000);
  const cp = ControlPlane.open({ workspaceRoot: workspace, clock, rng: seededRandom(621) });
  cleanups.push(() => cp.close());
  const databasePath = join(workspace, ".bridge", "bridge.db");
  const tracking = new TrackingCoordinator({ workspaceRoot: workspace, principal: "codex", now: () => clock.now() });
  cleanups.push(() => tracking.close());
  const root = () => { clock.advance(1); return cp.tasks.create({ spec, created_by: "codex" }); };
  return { workspace, cp, tracking, clock, databasePath, root };
}

describe("read-only tracking and authority", () => {
  it("follows insertion order even when root timestamps tie", () => {
    const f = fixture(); const a = f.root(); const b = f.root();
    const db = new DatabaseSync(f.databasePath); cleanups.push(() => db.close());
    db.prepare("UPDATE tasks SET created_at=1000").run();
    expect(f.tracking.reader.latestRun()).toBe(b.run_id);
    expect(f.tracking.open().run_id).toBe(b.run_id);
    expect(b.run_id).not.toBe(a.run_id);
  });

  it("does not initialize a missing bridge DB, bind a root, or start a worker merely to view", () => {
    const workspace = mkdtempSync(join(tmpdir(), "bridge-tracking-test-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const tracking = new TrackingCoordinator({ workspaceRoot: workspace, principal: "observer" });
    cleanups.push(() => tracking.close());
    tracking.followRun("run_0000000000");
    expect(existsSync(join(workspace, ".bridge"))).toBe(false);
    const view = tracking.open();
    expect(view.run_id).toBeNull(); expect(view.tasks).toEqual([]);
    expect(existsSync(join(workspace, ".bridge", "bridge.db"))).toBe(false);
  });

  it("deduplicates context, preserves preferences across processes, follows roots and pins history", () => {
    const f = fixture(); const first = f.root(); const opened = f.tracking.open();
    expect(f.tracking.open().view_id).toBe(opened.view_id);
    const other = new TrackingCoordinator({ workspaceRoot: f.workspace, principal: "codex", now: () => f.clock.now() });
    cleanups.push(() => other.close());
    expect(other.read({ view_id: opened.view_id }).run_id).toBe(first.run_id);
    const second = f.root(); f.tracking.followRun(second.run_id);
    expect(other.read({ view_id: opened.view_id }).run_id).toBe(second.run_id);
    f.tracking.bind({ view_id: opened.view_id, run_id: first.run_id });
    const third = f.root(); f.tracking.followRun(third.run_id);
    expect(f.tracking.read({ view_id: opened.view_id }).run_id).toBe(first.run_id);
    expect(f.tracking.bind({ view_id: opened.view_id, run_id: null }).run_id).toBe(third.run_id);
  });

  it("preserves an explicit concurrent run association until a genuinely new root appears", () => {
    const f = fixture(); const first = f.root(); const view = f.tracking.open();
    const second = f.root();
    f.tracking.followRun(first.run_id);
    const observer = new TrackingCoordinator({ workspaceRoot: f.workspace, principal: "codex", now: () => f.clock.now() });
    cleanups.push(() => observer.close());
    const associated = observer.read({ view_id: view.view_id, after: view.next_cursor });
    expect(associated.run_id).toBe(first.run_id);
    expect(associated.run_id).not.toBe(second.run_id);
    expect(f.tracking.read({ view_id: view.view_id, after: associated.next_cursor }).run_id).toBe(first.run_id);
    expect(f.tracking.open({ context_key: "selected", run_id: first.run_id, follow_current: true }).run_id).toBe(first.run_id);

    // No manager hook: the separate observer still discovers a future root from SQLite.
    const third = f.root();
    expect(() => observer.read({ view_id: view.view_id, after: associated.next_cursor })).toThrow("CURSOR_RESET_REQUIRED");
    expect(observer.read({ view_id: view.view_id }).run_id).toBe(third.run_id);
    expect(f.tracking.read({ view_id: view.view_id }).run_id).toBe(third.run_id);
  });

  it("reclaims closed view slots immediately while retaining the limit on live contexts", () => {
    const f = fixture(); const task = f.root(); f.cp.tasks.claim(task.task_id, "codex");
    const eventHead = f.cp.lastEventId(); const viewIds = new Set<string>();
    for (let n = 0; n < 40; n++) {
      const view = f.tracking.open(); const token = f.tracking.browserToken(view.view_id);
      viewIds.add(view.view_id);
      f.tracking.closeView({ view_id: view.view_id });
      expect(f.tracking.authorizeBrowser(token, view.view_id)).toBe(false);
      expect(() => f.tracking.read({ view_id: view.view_id })).toThrow("VIEW_CLOSED_OR_EXPIRED");
    }
    expect(viewIds.size).toBe(40);
    for (let n = 0; n < 32; n++) f.tracking.open({ context_key: `live_${n}` });
    expect(() => f.tracking.open({ context_key: "one_too_many" })).toThrow("VIEW_LIMIT");
    expect(f.cp.tasks.get(task.task_id).state).toBe("CLAIMED");
    expect(f.cp.lastEventId()).toBe(eventHead);
  });

  it("projects a resumed child without private JSON, handles, paths, prompts or unknown-as-zero", () => {
    const f = fixture(); const root = f.root();
    const child = f.cp.tasks.create({ spec, created_by: "codex", run_id: root.run_id, parent_task_id: root.task_id, delegation_depth: 1 });
    const db = new DatabaseSync(f.databasePath); cleanups.push(() => db.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      db.prepare("INSERT INTO task_attempts VALUES(?,?,?,?,?,?,?,?,?)").run(child.task_id, attempt, "claude", attempt ? 0 : null, "PRIVATE_HANDLE", 1000, 1001, attempt ? null : 1001, attempt ? null : "PARTIAL");
      db.prepare("INSERT INTO attempt_observations VALUES(?,?,?)").run(child.task_id, attempt, JSON.stringify({ status: "INCOMPLETE", accepted: false, strict_required: false, category: "USAGE_UNAVAILABLE", PRIVATE_PROMPT: "PRIVATE_HANDLE" }));
    }
    db.prepare("UPDATE tasks SET attempt=1,owner='claude' WHERE task_id=?").run(child.task_id);
    db.prepare("INSERT INTO task_executions VALUES(?,?,?,?)").run(child.task_id, "claude", "QUARANTINED", JSON.stringify({ generation: "PRIVATE_GENERATION", executor_pid: 9999, runtime_stop_confirmed: false, cancel_requested_at: 1001 }));
    db.prepare("INSERT INTO attempt_telemetry VALUES(?,?,?,?,?)").run(child.task_id, 0, root.run_id, "claude", JSON.stringify({ input_tokens: 0, output_tokens: null, attempt_wall_duration_ms: 5, runtime_failure: { category: "auth", source: "PRIVATE_OAUTH_SESSION" }, PRIVATE_PROMPT: "secret" }));
    db.prepare("INSERT INTO deliverables VALUES(?,?,?,?,?)").run(child.task_id, "claude", "COMPLETE", 1001, '{"summary":"PRIVATE_PROMPT"}');
    const before = db.prepare("SELECT * FROM events ORDER BY event_id").all();
    const snapshot = f.tracking.open({ run_id: root.run_id });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|sk-secret|C:\\\\private|execution_handle|generation|executor_pid|scope|spec_json/u);
    expect(snapshot.tasks.find(t => t.task_id === child.task_id)).toMatchObject({ business_status: "COMPLETE", execution_phase: "QUARANTINED", runtime_stop_confirmed: false, observation: { status: "INCOMPLETE", accepted: false } });
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts.find(a => a.attempt === 1)).toMatchObject({ task_id: child.task_id, resumed_from_attempt: 0, telemetry: null });
    expect(snapshot.attempts.find(a => a.attempt === 0)?.telemetry).toMatchObject({ input_tokens: 0, output_tokens: null, total_tokens: null, attempt_wall_duration_ms: 5 });
    expect(snapshot.attempts.find(a => a.attempt === 0)?.failure_category).toBe("auth");
    expect(snapshot.links).toEqual([{ from: root.task_id, to: child.task_id, kind: "delegation" }]);
    f.tracking.read({ view_id: snapshot.view_id }); f.tracking.history({ view_id: snapshot.view_id }); f.tracking.closeView({ view_id: snapshot.view_id });
    expect(db.prepare("SELECT * FROM events ORDER BY event_id").all()).toEqual(before);
    expect(f.cp.tasks.get(child.task_id).attempt).toBe(1);
    expect(db.prepare("SELECT phase FROM task_executions WHERE task_id=?").get(child.task_id)).toMatchObject({ phase: "QUARANTINED" });
  });

  it("refuses old/future schemas without migrating or writing their content", () => {
    const f = fixture(); f.root(); const reader = new TrackingReader(f.databasePath); cleanups.push(() => reader.close());
    reader.snapshot(null);
    const db = new DatabaseSync(f.databasePath); cleanups.push(() => db.close());
    for (const version of ["3", "99", "4junk"]) {
      db.prepare("UPDATE schema_meta SET value=? WHERE key='schema_version'").run(version);
      expect(() => reader.snapshot(null)).toThrow("UNSUPPORTED_SCHEMA");
      expect((db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as Record<string, unknown>).value).toBe(version);
    }
  });

  it("refuses an incompatible sidecar before any schema initialization", () => {
    const f = fixture(); f.root();
    const original = new DatabaseSync(f.tracking.statePath);
    original.exec("CREATE TABLE tracking_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    original.prepare("INSERT INTO tracking_meta VALUES(?,?)").run("version", "99");
    original.close();
    expect(() => f.tracking.open()).toThrow("UNSUPPORTED_TRACKING_STATE");
    const inspect = new DatabaseSync(f.tracking.statePath, { readOnly: true }); cleanups.push(() => inspect.close());
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "tracking_meta" }]);
    expect(inspect.prepare("SELECT value FROM tracking_meta WHERE key='version'").get()).toEqual({ value: "99" });
  });

  it("upgrades only a supported sidecar to persist the run-association watermark", () => {
    const f = fixture(); const root = f.root(); const viewId = `view_${"a".repeat(32)}`;
    const original = new DatabaseSync(f.tracking.statePath);
    original.exec(`CREATE TABLE tracking_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE tracking_preferences(principal TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
      CREATE TABLE tracking_views(view_id TEXT PRIMARY KEY,principal TEXT NOT NULL,context_key TEXT NOT NULL,
        run_id TEXT,follow_current INTEGER NOT NULL,closed INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
    original.prepare("INSERT INTO tracking_meta VALUES(?,?)").run("version", "1");
    original.prepare("INSERT INTO tracking_views VALUES(?,?,?,?,?,?,?)").run(viewId, "codex", "legacy", root.run_id, 1, 0, f.clock.now() + 60000);
    original.close();
    const eventHead = f.cp.lastEventId();
    expect(f.tracking.read({ view_id: viewId }).run_id).toBe(root.run_id);
    const inspect = new DatabaseSync(f.tracking.statePath, { readOnly: true }); cleanups.push(() => inspect.close());
    expect(inspect.prepare("SELECT latest_seen_run FROM tracking_views WHERE view_id=?").get(viewId)).toEqual({ latest_seen_run: root.run_id });
    expect(f.cp.lastEventId()).toBe(eventHead);
  });

  it("binds signed cursors/capabilities to view, principal, workspace and current run", () => {
    const f = fixture(); const first = f.root(); const a = f.tracking.open({ context_key: "one" }); const b = f.tracking.open({ context_key: "two" });
    expect(() => f.tracking.read({ view_id: b.view_id, after: a.next_cursor })).toThrow("CURSOR_RESET_REQUIRED");
    expect(() => f.tracking.read({ view_id: a.view_id, after: a.next_cursor.slice(0, -4) + "AAAA" })).toThrow("INVALID_CURSOR");
    const foreign = new TrackingCoordinator({ workspaceRoot: f.workspace, principal: "claude" }); cleanups.push(() => foreign.close());
    expect(() => foreign.read({ view_id: a.view_id })).toThrow("VIEW_CLOSED_OR_EXPIRED");
    const token = f.tracking.browserToken(a.view_id);
    expect(f.tracking.authorizeBrowser(token, a.view_id)).toBe(true); expect(f.tracking.authorizeBrowser(token, b.view_id)).toBe(false);
    const second = f.root(); f.tracking.followRun(second.run_id);
    expect(() => f.tracking.read({ view_id: a.view_id, after: a.next_cursor })).toThrow("CURSOR_RESET_REQUIRED");
    expect(f.tracking.read({ view_id: a.view_id }).run_id).not.toBe(first.run_id);
    f.clock.advance(24 * 60 * 60 * 1000);
    expect(f.tracking.authorizeBrowser(token, a.view_id)).toBe(false);
  });

  it("never skips matching events when other runs interleave or catchup is truncated", () => {
    const f = fixture(); const root = f.root(); const unrelated = f.root();
    const view = f.tracking.open({ run_id: root.run_id });
    const db = new DatabaseSync(f.databasePath); cleanups.push(() => db.close());
    const add = db.prepare("INSERT INTO events(type,task_id,agent,at,payload_json) VALUES('task.state_changed',?,'codex',1000,'{}')");
    for (let n = 0; n < TRACKING_EVENT_LIMIT + 8; n++) { add.run(root.task_id); add.run(unrelated.task_id); }
    const page1 = f.tracking.read({ view_id: view.view_id, after: view.next_cursor });
    expect(page1.has_more).toBe(true);
    const decoded = JSON.parse(Buffer.from(page1.next_cursor.split(".")[0]!, "base64url").toString());
    expect(decoded.event).toBeLessThan(page1.snapshot_event_id);
    const page2 = f.tracking.read({ view_id: view.view_id, after: page1.next_cursor });
    expect(page2.has_more).toBe(false); expect(page2.next_cursor).not.toBe(page1.next_cursor);
    expect(page2.tasks).toHaveLength(1); expect(page2.tasks[0]?.run_id).toBe(root.run_id);
  });

  it("paginates a stable history and rejects changing filters under the same token", () => {
    const f = fixture(); for (let n = 0; n < 5; n++) f.root();
    const view = f.tracking.open(); const first = f.tracking.history({ view_id: view.view_id, limit: 2 });
    f.root();
    const second = f.tracking.history({ view_id: view.view_id, limit: 2, page_token: first.next_page_token! });
    const third = f.tracking.history({ view_id: view.view_id, limit: 2, page_token: second.next_page_token! });
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.run_id)).size).toBe(5);
    expect(third.has_more).toBe(false);
    expect(() => f.tracking.history({ view_id: view.view_id, owner: "claude", page_token: first.next_page_token! })).toThrow("INVALID_CURSOR");
  });

  it("closing/disabling revokes capabilities without cancelling a live task", () => {
    const f = fixture(); const task = f.root(); f.cp.tasks.claim(task.task_id, "codex");
    const a = f.tracking.open({ context_key: "one" }); const b = f.tracking.open({ context_key: "two" }); const token = f.tracking.browserToken(a.view_id);
    const eventHead = f.cp.lastEventId();
    f.tracking.closeView({ view_id: a.view_id, disable: true });
    expect(f.tracking.authorizeBrowser(token, a.view_id)).toBe(false);
    expect(() => f.tracking.read({ view_id: b.view_id })).toThrow("VIEW_CLOSED_OR_EXPIRED");
    expect(f.cp.tasks.get(task.task_id).state).toBe("CLAIMED"); expect(f.cp.lastEventId()).toBe(eventHead);
  });
});

describe("MCP Apps registration and loopback fallback", () => {
  it("serves the compiled observer over real stdio without initializing or exposing a writer", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bridge-tracking-test-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    const client = new Client({ name: "tracking-stdio-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../../../scripts/bridge-tracking-mcp.mjs", import.meta.url)), "--workspace", workspace], stderr: "pipe" });
    cleanups.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain("bridge_delegate");
    expect(existsSync(join(workspace, ".bridge"))).toBe(false);
    const open = await client.callTool({ name: "bridge_tracking_open", arguments: {} });
    expect(open.isError).not.toBe(true);
    expect(open.structuredContent).toMatchObject({ run_id: null, task_count: 0, attempt_count: 0 });
    expect((open._meta as Record<string, unknown>)?.tracking_snapshot).toMatchObject({ tasks: [], attempts: [] });
    expect(existsSync(join(workspace, ".bridge", "bridge.db"))).toBe(false);
  });

  it("exposes actual structuredContent, outputSchema, ui metadata and only observer tools", async () => {
    const f = fixture(); f.root();
    const server = new TrackingMcpServer({ workspaceRoot: f.workspace, principal: "observer" }); cleanups.push(() => server.close());
    const client = new Client({ name: "tracking-test-host", version: "1" }); cleanups.push(() => client.close());
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(5); expect(tools.every(t => t.name.startsWith("bridge_tracking_"))).toBe(true);
    const open = tools.find(t => t.name === "bridge_tracking_open")!;
    expect(open.outputSchema).toBeDefined(); expect(open._meta?.["ui"]).toMatchObject({ resourceUri: "ui://bridge/delegation-tracking.html" });
    const result = await client.callTool({ name: open.name, arguments: {} });
    expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ schema_version: 1 });
    expect(result.structuredContent).not.toHaveProperty("tasks");
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(1024);
    expect((result._meta as Record<string, unknown>)?.tracking_snapshot).toHaveProperty("tasks");
    expect(result.content).not.toMatchObject([{ text: expect.stringContaining("browser_url") }]);
    expect(JSON.stringify(result)).not.toMatch(/browser_url|token=/u);
    const resource = await client.readResource({ uri: "ui://bridge/delegation-tracking.html" });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app"); expect(resource.contents[0]).toHaveProperty("text");
    const refused = await client.callTool({ name: "bridge_tracking_read", arguments: { view_id: (result.structuredContent as Record<string, unknown>).view_id, databasePath: "foreign" } });
    expect(refused.isError).toBe(true);
  });

  it("requires a scoped header capability and blocks foreign origins, hosts, paths and mutations", async () => {
    const f = fixture(); f.root(); const view = f.tracking.open();
    const browser = new TrackingHttpServer(f.tracking); cleanups.push(() => browser.close());
    const url = new URL(await browser.url(view.view_id)); const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    const body = { name: "bridge_tracking_read", arguments: { view_id: view.view_id } };
    const request = (overrides: Record<string, string> = {}, payload: unknown = body, path = "/api") => fetch(`${url.origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...overrides }, body: JSON.stringify(payload) });
    expect((await request()).status).toBe(200);
    expect((await request({ Authorization: "" })).status).toBe(401);
    expect((await request({ Origin: "https://attacker.example" })).status).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url.origin, { method: "GET", headers: { Host: "attacker.example" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end();
    });
    expect(foreignHost).toBe(403);
    expect((await request({}, { name: "bridge_cancel_task", arguments: { view_id: view.view_id } })).status).toBe(400);
    expect((await request({}, body, `/api?token=${token}`)).status).toBe(404);
    expect((await request({}, { ...body, arguments: { ...body.arguments, workspace: "../foreign" } })).status).toBe(400);
    expect((await fetch(url.origin)).headers.get("cache-control")).toBe("no-store");
  });
});
