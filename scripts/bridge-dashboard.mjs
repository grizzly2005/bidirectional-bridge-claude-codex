#!/usr/bin/env node
/**
 * bridge-dashboard — local visual task tracking for any client (Claude Code, Codex,
 * Antigravity/Gemini), without an MCP host that renders MCP Apps.
 *
 * Serves the read-only tracking view on 127.0.0.1 only, follows the latest and next root
 * run, and prints a private URL whose fragment carries a temporary reader capability.
 * It never initializes bridge.db, starts a worker, mutates tasks or exposes a writer.
 * Ctrl+C closes the page server; delegated workers keep running.
 *
 *   node scripts/bridge-dashboard.mjs [--workspace <project>] [--db <path>] [--port 4319] [--open]
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_HELP = `bridge-dashboard — private localhost view of bridge delegations

  --workspace <dir>  project whose .bridge state to observe (default: current directory)
  --db <path>        shared SQLite path (default: <workspace>/.bridge/bridge.db)
  --port <n>         fixed loopback port (default: ephemeral)
  --open             open the page in the system browser
  --help             show this help

The page is read-only, bound to 127.0.0.1 and authenticated by a capability in the URL
fragment. Never paste that URL into chats, issues, logs or artifacts.
`;

export function parseDashboardArgs(argv, cwd = process.cwd()) {
  let workspace = cwd;
  let databasePath;
  let port = 0;
  let open = false;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--workspace": workspace = resolve(cwd, value()); break;
      case "--db": databasePath = value(); break;
      case "--port": {
        const raw = value();
        port = Number(raw);
        if (!/^\d{1,5}$/u.test(raw) || port < 1024 || port > 65535) throw new Error("--port must be 1024..65535");
        break;
      }
      case "--open": open = true; break;
      case "--help": case "-h": help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return {
    workspaceRoot: resolve(workspace),
    databasePath: databasePath ? resolve(workspace, databasePath) : undefined,
    principal: "dashboard",
    browserPort: port,
    open,
    help,
  };
}

export async function runDashboard(args) {
  if (args.help) { process.stderr.write(DASHBOARD_HELP); return null; }
  const core = await import(new URL("../shared/mcp-server-core/dist/index.js", import.meta.url).href);
  const server = new core.TrackingMcpServer(args);
  const snapshot = server.tracking.open({ context_key: "dashboard" });
  const url = await server.browser.url(snapshot.view_id);
  // Interactive, explicitly requested output only: this URL carries a reader capability.
  process.stderr.write(`Bridge dashboard (read-only, localhost): ${url}\nCtrl+C to stop the page; workers keep running.\n`);
  if (args.open) {
    try { await core.openTrackingBrowser(url); }
    catch { process.stderr.write("Could not open a browser automatically; open the URL above.\n"); }
  }
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); process.exitCode = 0; };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

function canonicalPath(path) {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  let args;
  try { args = parseDashboardArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n${DASHBOARD_HELP}`); process.exit(2); }
  runDashboard(args).catch(() => {
    process.stderr.write("Dashboard failed; run `npm run build` and check the workspace path.\n");
    process.exitCode = 1;
  });
}
