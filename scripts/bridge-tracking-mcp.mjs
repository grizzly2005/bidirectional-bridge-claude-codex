#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseTrackingArgs(argv, cwd = process.cwd()) {
  let workspace = cwd; let databasePath; let browser = false; let help = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--browser") browser = true;
    else if (flag === "--help" || flag === "-h") help = true;
    else if (flag === "--workspace" || flag === "--db") {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--workspace") workspace = resolve(cwd, value); else databasePath = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return { workspaceRoot: resolve(workspace), databasePath: databasePath ? resolve(workspace, databasePath) : undefined, principal: "observer", browser, help };
}
export async function runTracking(args) {
  if (args.help) { process.stderr.write("bridge-tracking-mcp --workspace <project> [--db <path>] [--browser]\nIndependent read-only observer. Default: MCP stdio; --browser prints a private loopback URL. Never initializes bridge.db or starts a worker.\n"); return null; }
  const { TrackingMcpServer } = await import("../shared/mcp-server-core/dist/index.js");
  const server = new TrackingMcpServer(args);
  if (args.browser) {
    const snapshot = server.tracking.open();
    // Explicit interactive invocation only. This URL includes a temporary reader capability.
    process.stderr.write(`${await server.browser.url(snapshot.view_id)}\n`);
  } else await server.connect();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); process.exitCode = 0; };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  if (!args.browser) process.stdin.once("end", close);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTracking(parseTrackingArgs(process.argv.slice(2))).catch(() => { process.stderr.write("Tracking observer failed; check the build and workspace configuration.\n"); process.exitCode = 1; });
}
