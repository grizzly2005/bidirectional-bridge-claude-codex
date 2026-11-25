#!/usr/bin/env node
/**
 * Register the bridge MCP server for Google Antigravity (App, IDE and `agy` CLI) in one
 * workspace: `<workspace>/.agents/mcp_config.json`.
 *
 * Antigravity documents absolute paths for stdio servers, so this writes the absolute Node
 * executable, launcher and workspace of *this* machine. The file is therefore local and is
 * git-ignored by the bridge repository. Existing servers are preserved; an existing
 * `bridge` entry is replaced only with --force. Nothing is written with --dry-run.
 *
 *   node scripts/install-antigravity.mjs [--workspace <project>] [--server-name bridge]
 *        [--gemini-command <path>] [--gemini-auth api-key|enterprise] [--dry-run] [--force]
 *
 * Antigravity is the *manager* here (it calls the bridge tools); that is ordinary MCP use.
 * The Gemini *worker* (bridge → agy) stays disabled unless --gemini-auth is given.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "scripts", "native-bridge-mcp.mjs");

export function parseInstallArgs(argv, cwd = process.cwd()) {
  const args = { workspace: cwd, serverName: "bridge", geminiCommand: undefined, geminiAuth: undefined, dryRun: false, force: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--workspace": args.workspace = resolve(cwd, value()); break;
      case "--server-name": args.serverName = value(); break;
      case "--gemini-command": args.geminiCommand = resolve(cwd, value()); break;
      case "--gemini-auth": args.geminiAuth = value(); break;
      case "--dry-run": args.dryRun = true; break;
      case "--force": args.force = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(args.serverName)) throw new Error("--server-name must be 1-64 letters, digits, _ or -");
  if (args.geminiAuth !== undefined && !["api-key", "enterprise"].includes(args.geminiAuth)) throw new Error("--gemini-auth must be api-key or enterprise");
  return args;
}

export function antigravityServerEntry(args) {
  const workspace = realpathSync(args.workspace);
  return {
    command: process.execPath,
    args: [launcher, "--caller", "gemini", "--delegation", "allow", "--workspace", workspace,
      ...(args.geminiCommand !== undefined ? ["--gemini-command", args.geminiCommand] : []),
      ...(args.geminiAuth !== undefined ? ["--gemini-auth", args.geminiAuth] : [])],
    cwd: workspace,
    env: {},
    disabled: false,
    // Delegated tasks can run for many minutes; Antigravity's default tool timeout is short.
    timeoutSeconds: 2400,
    // Load the identity and resume tools eagerly so a new session can orient itself.
    tools: { bridge_server_info: { eager: true }, bridge_resume_project: { eager: true } },
  };
}

export function mergeConfig(existingText, serverName, entry, force) {
  const config = existingText ? JSON.parse(existingText) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("existing mcp_config.json is not a JSON object");
  const servers = config.mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("existing mcpServers is not an object");
  if (servers[serverName] !== undefined && !force) {
    throw new Error(`server '${serverName}' already exists; rerun with --force to replace it`);
  }
  return { ...config, mcpServers: { ...servers, [serverName]: entry } };
}

function main() {
  const args = parseInstallArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write("install-antigravity --workspace <project> [--server-name bridge] [--gemini-command <path>] [--gemini-auth api-key|enterprise] [--dry-run] [--force]\n");
    return;
  }
  if (!existsSync(join(repoRoot, "shared", "mcp-server-core", "dist", "index.js"))) {
    throw new Error("build the bridge first: npm ci && npm run build");
  }
  const target = join(realpathSync(args.workspace), ".agents", "mcp_config.json");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const merged = mergeConfig(existing, args.serverName, antigravityServerEntry(args), args.force);
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (args.dryRun) { process.stdout.write(text); return; }
  mkdirSync(dirname(target), { recursive: true });
  if (existing) writeFileSync(`${target}.bak`, existing, { mode: 0o600 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, target);
  process.stderr.write(`Wrote ${target}${existing ? ` (previous version saved as ${target}.bak)` : ""}.\n` +
    "Reload MCP servers in Antigravity (/mcp in agy) and check that bridge_server_info reports caller=gemini.\n");
}

function canonicalPath(path) {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) { process.stderr.write(`install-antigravity: ${error.message}\n`); process.exitCode = 1; }
}
