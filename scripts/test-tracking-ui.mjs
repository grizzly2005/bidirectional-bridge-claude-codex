#!/usr/bin/env node
/** Reproducible local browser + official MCP Apps host harness. No provider/model calls. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { chromium } from "playwright";
import { ControlPlane } from "../shared/control-plane/dist/index.js";
import { BridgeMcpServer, TrackingMcpServer } from "../shared/mcp-server-core/dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(repo, "tmp", "tracking-browser-evidence");
const workspace = await mkdtemp(join(tmpdir(), "bridge-tracking-browser-"));
const clients = []; let browser; let web; let manager; let observer; let db; let cp; let release; let pending;
const stats = { reads: 0, mutations: 0, console: [], checks: [] };
const record = name => stats.checks.push(name);
const spec = { objective: "PRIVATE_TEST_PROMPT", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "simulation", verification_criteria: ["test harness"] };
function content(result) { assert.notEqual(result.isError, true); return result.structuredContent ?? JSON.parse(result.content[0].text); }
async function connect(server, name) {
  const client = new Client({ name, version: "1" }); clients.push(client);
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct); return client;
}
async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return `http://127.0.0.1:${server.address().port}`; }
try {
  await mkdir(evidence, { recursive: true });
  cp = ControlPlane.open({ workspaceRoot: workspace });
  let invoked; const started = new Promise(resolve => { invoked = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = {
    info: { agent: "claude", implementation: "browser-fixture", version: "1", capabilities: ["structured-deliverable"], max_concurrency: 1 },
    async health() { return { status: "READY", checked_at: Date.now() }; },
    async invoke(invocation, context) {
      invoked(invocation.task_id); await gate;
      const check = { kind: "manual", command: "local browser fixture", passed: true, exit_code: 0, summary: "fixture finished" };
      await context.recordVerification(check);
      return { task_id: invocation.task_id, agent: "claude", status: "COMPLETE", summary: "PRIVATE_TEST_PROMPT", changed_scope: [], artifacts: [], commit_or_diff: null,
        verification_performed: [check.command], verification_results: [check], remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: Date.now() };
    }, async cancel() { stats.mutations++; },
  };
  manager = new BridgeMcpServer({ workspaceRoot: workspace, controlPlane: cp, agent: "codex", adapters: [adapter] });
  const managerClient = await connect(manager, "browser-manager-fixture");
  const root = content(await managerClient.callTool({ name: "bridge_create_task", arguments: { spec } }));
  await managerClient.callTool({ name: "bridge_claim_task", arguments: { task_id: root.task_id } });
  await managerClient.callTool({ name: "bridge_set_state", arguments: { task_id: root.task_id, to: "WORKING" } });
  observer = new TrackingMcpServer({ workspaceRoot: workspace, principal: "browser-test-observer" });
  const observerClient = await connect(observer, "browser-observer-fixture");
  const initialResult = await observerClient.callTool({ name: "bridge_tracking_open", arguments: {} });
  const view = content(initialResult);
  assert(!JSON.stringify(initialResult).includes("token="));
  const localUrl = await observer.browser.url(view.view_id);
  db = new DatabaseSync(join(workspace, ".bridge", "bridge.db"));

  pending = managerClient.callTool({ name: "bridge_delegate", arguments: { to: "claude", spec, run_id: root.run_id, parent_task_id: root.task_id,
    delegation_depth: 1, deadline_ms: 60_000, total_deadline_ms: 60_000, max_attempts: 0, idempotency_key: "browser-fixture-one-child" } });
  const childId = await started;
  assert.equal(cp.tasks.get(childId).state, "WORKING");

  const launch = { headless: true };
  if (process.env.BRIDGE_TEST_BROWSER_EXECUTABLE) launch.executablePath = process.env.BRIDGE_TEST_BROWSER_EXECUTABLE;
  else if (process.platform === "win32") launch.channel = "msedge";
  browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("console", item => stats.console.push({ type: item.type(), text: item.text() }));
  page.on("request", request => {
    const url = new URL(request.url());
    assert(!url.search.includes("token"));
    if (url.pathname === "/api") stats.reads++;
  });
  await page.goto(localUrl);
  await page.getByRole("heading", { name: "Suivi des délégations" }).waitFor();
  await page.locator(".bt-card").nth(1).waitFor();
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal((await page.locator("body").textContent()).includes("PRIVATE_TEST_PROMPT"), false);
  assert.equal(await page.locator(".bt-card").count(), 2);
  await page.locator(".bt-card").first().focus();
  await page.locator(".bt-card").first().press("ArrowRight");
  assert.equal(await page.locator(".bt-card").nth(1).evaluate(node => document.activeElement === node), true);
  await page.locator(".bt-card").nth(1).click();
  await page.getByRole("button", { name: "Liste", exact: true }).click();
  await page.getByRole("button", { name: "Graphe", exact: true }).click();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api" && response.status() === 200);
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();
  await refreshed;
  await page.waitForFunction(() => !!document.querySelector("svg path"));
  assert(stats.reads >= 2); assert.equal(cp.tasks.get(childId).state, "WORKING");
  record("standalone refresh and graph while real MCP delegation awaits a simulated adapter");

  db.prepare("UPDATE task_executions SET phase='QUARANTINED',json=json_set(json,'$.phase','QUARANTINED','$.runtime_stop_confirmed',json('false')) WHERE task_id=?").run(childId);
  db.prepare("INSERT OR REPLACE INTO attempt_observations VALUES(?,?,?)").run(childId, 0, JSON.stringify({ status: "INCOMPLETE", strict_required: false, accepted: false, category: "USAGE_UNAVAILABLE" }));
  db.prepare("INSERT OR REPLACE INTO task_attempts VALUES(?,?,?,?,?,?,?,?,?)").run(childId, 1, "claude", 0, "PRIVATE_TEST_HANDLE", Date.now(), Date.now(), null, null);
  db.prepare("UPDATE tasks SET attempt=1 WHERE task_id=?").run(childId);
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("Reprise") || document.body.textContent.includes("reprise de la tentative"));
  assert.equal(await page.locator(".bt-card").count(), 2);
  assert(!await page.locator("body").textContent().then(text => text.includes("PRIVATE_TEST_HANDLE")));
  record("resume remains one child, quarantined execution and incomplete observation remain distinct");
  await page.evaluate(() => { document.getElementById("bridge-tracking").style.display = "none"; });
  await page.waitForTimeout(150);
  const readsHidden = stats.reads;
  await page.waitForTimeout(4200);
  assert.equal(stats.reads, readsHidden);
  await page.evaluate(() => { document.getElementById("bridge-tracking").style.display = ""; });
  await page.locator(".bt-card").first().waitFor();
  record("offscreen widget pauses reads and returns without overlap");
  await page.screenshot({ path: join(evidence, "standalone-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Liste", exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  assert.equal(overflow, false);
  await page.screenshot({ path: join(evidence, "standalone-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Historique", exact: true }).click();
  await page.locator(".bt-history-item").first().waitFor();
  record("390px accessible list and history render");
  const headBeforeClose = cp.lastEventId();
  await page.getByRole("button", { name: "Fermer le suivi ; les délégations continuent" }).click();
  await page.getByRole("heading", { name: "Suivi fermé" }).waitFor();
  assert.equal(stats.mutations, 0); assert.equal(cp.lastEventId(), headBeforeClose); assert.equal(cp.tasks.get(childId).state, "WORKING");
  record("closing standalone view leaves live task, leases and events unchanged");

  // Real Apps initialize/tool-result/tools-call handshake through the official host bridge.
  const appOpen = await observerClient.callTool({ name: "bridge_tracking_open", arguments: { context_key: "app-harness", run_id: root.run_id } });
  const widgetHtml = (await observerClient.readResource({ uri: "ui://bridge/delegation-tracking.html" })).contents[0].text;
  const hostSource = `import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge'; (async()=>{
    const frame=document.getElementById('widget'); const bridge=new AppBridge(null,{name:'Local test host',version:'1'},{serverTools:{},logging:{}},{hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});
    bridge.oncalltool=async params=>{const response=await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});return response.json();};
    bridge.onrequestdisplaymode=async({mode})=>({mode});
    bridge.onrequestteardown=async()=>{window.teardownRequested=true;};
    bridge.oninitialized=async()=>{window.appInitialized=true;await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await(await fetch('/result')).json());};
    window.testBridge=bridge; await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/widget';})();`;
  const builtHost = await build({ stdin: { contents: hostSource, resolveDir: repo, sourcefile: "local-host.mjs" }, bundle: true, write: false, format: "iife", target: "es2022", drop: ["console", "debugger"] });
  const hostHtml = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><iframe id="widget" title="Bridge tracking" sandbox="allow-scripts" style="width:100%;height:900px;border:0"></iframe><script>${builtHost.outputFiles[0].text.replace(/<\/script/giu, "<\\/script")}</script></body></html>`;
  web = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/host") { res.setHeader("Content-Type", "text/html"); res.end(hostHtml); }
    else if (req.url === "/widget") { res.setHeader("Content-Type", "text/html"); res.end(widgetHtml); }
    else if (req.url === "/result") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(appOpen)); }
    else if (req.url === "/tool" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const params = JSON.parse(body); assert(params.name.startsWith("bridge_tracking_")); stats.reads++;
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await observerClient.callTool(params)));
    } else res.writeHead(404).end();
  });
  const hostOrigin = await listen(web);
  await page.setViewportSize({ width: 1050, height: 950 });
  await page.goto(`${hostOrigin}/host`);
  const frame = page.frameLocator("#widget");
  await frame.getByRole("heading", { name: "Suivi des délégations" }).waitFor();
  await frame.locator(".bt-card").nth(1).waitFor();
  assert.equal(await page.evaluate(() => window.appInitialized), true);
  assert.equal(await frame.locator(".bt-panel").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(21, 27, 39)");
  await page.evaluate(() => window.testBridge.setHostContext({ theme: "light" }));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator(".bt-panel").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(255, 255, 255)");
  await page.evaluate(() => window.testBridge.setHostContext({ theme: "dark" }));
  await page.evaluate(() => window.testBridge.setHostContext({ displayMode: "fullscreen" }));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator(".bt-panel").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(21, 27, 39)");
  await frame.getByRole("button", { name: "Agrandir", exact: true }).click();
  await frame.getByRole("button", { name: "Historique", exact: true }).click();
  await frame.locator(".bt-history-item").first().waitFor();
  await page.screenshot({ path: join(evidence, "mcp-app-dark.png"), fullPage: true });
  await frame.getByRole("button", { name: "Fermer le suivi ; les délégations continuent" }).click();
  await page.waitForFunction(() => window.teardownRequested === true);
  assert.equal(cp.tasks.get(childId).state, "WORKING"); assert.equal(stats.mutations, 0);
  record("MCP Apps official initialize, tool result, calls, display mode, dark context and teardown");
  assert(!stats.console.some(item => /PRIVATE_TEST_|token=|Parsed message|Sending message/u.test(item.text)));
  assert.equal(stats.console.filter(item => item.type === "error").length, 0);
  record("no private test content or protocol frames in browser console");

  // Restore the simulated execution to the orchestrator's current attempt before releasing it.
  db.prepare("UPDATE tasks SET attempt=0 WHERE task_id=?").run(childId);
  db.prepare("UPDATE task_executions SET phase='RUNNING',json=json_set(json,'$.phase','RUNNING') WHERE task_id=?").run(childId);
  release(); const completed = content(await pending); pending = undefined;
  assert.equal(completed.deliverable.status, "COMPLETE"); assert.equal(cp.tasks.get(childId).state, "DONE");
  record("simulated worker completes normally after both views close");
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks: stats.checks, observed_reads: stats.reads, mutations: stats.mutations, browser: await browser.version(), console_errors: stats.console.filter(item => item.type === "error").length,
    scope: "Local loopback + official AppBridge harness; no real ChatGPT/native host account or provider call" }, null, 2) + "\n");
  process.stdout.write(`${stats.checks.length} browser integration checks passed; evidence in tmp/tracking-browser-evidence/\n`);
} finally {
  release?.(); if (pending) await pending.catch(() => undefined);
  await browser?.close();
  if (web) { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); }
  for (const client of clients.reverse()) await client.close();
  await observer?.close(); await manager?.close(); db?.close(); cp?.close();
  // workspace comes directly from mkdtemp under tmpdir, never from an input or project path.
  assert(workspace.startsWith(join(tmpdir(), "bridge-tracking-browser-")));
  await rm(workspace, { recursive: true, force: true });
}
