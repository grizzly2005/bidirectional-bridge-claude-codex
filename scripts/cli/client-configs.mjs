/**
 * Read, validate and merge the per-project MCP configurations of the three clients that the
 * bridge serves, without clobbering unrelated servers, tables, comments or settings:
 *
 *   claude  <configRoot>/.mcp.json               mcpServers[<name>]       --caller claude
 *   codex   <configRoot>/.codex/config.toml      [mcp_servers.<name>]     --caller codex
 *   gemini  <configRoot>/.agents/mcp_config.json mcpServers[<name>]       --caller gemini
 *
 * Pure Node ESM. Every write is atomic (temp file + rename, mode 0o600) and keeps the
 * previous content in `<file>.bak`; a semantically identical configuration is never rewritten.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CLIENTS = Object.freeze(["claude", "codex", "gemini"]);
export const CLIENT_LABELS = Object.freeze({ claude: "Claude", codex: "Codex", gemini: "Gemini" });
export const DEFAULT_SERVER_NAME = "bridge";
export const DEFAULT_DB_RELATIVE = ".bridge/bridge.db";
export const LAUNCHER_RELATIVE = "scripts/native-bridge-mcp.mjs";
export const CODEX_TOOL_TIMEOUT_SEC = 2400;
export const CODEX_STARTUP_TIMEOUT_SEC = 30;
export const GEMINI_TIMEOUT_SECONDS = 2400;
export const GEMINI_EAGER_TOOLS = Object.freeze(["bridge_server_info", "bridge_resume_project"]);

const CLIENT_FILES = { claude: [".mcp.json"], codex: [".codex", "config.toml"], gemini: [".agents", "mcp_config.json"] };
const VALUE_FLAGS = new Set(["--caller", "--delegation", "--workspace", "--db", "--codex-wsl-executable",
  "--gemini-command", "--gemini-dialect", "--gemini-auth"]);

// ---------------------------------------------------------------------------------------
// Paths and files
// ---------------------------------------------------------------------------------------

export function isWslUncPath(path) {
  return typeof path === "string" && /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+/iu.test(path);
}

/** Distribution named by `\\wsl.localhost\<Distro>\...` or `\\wsl$\<Distro>\...`, else null. */
export function wslDistribution(path) {
  const match = typeof path === "string" ? /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)/iu.exec(path) : null;
  return match ? match[1] : null;
}

export function canonicalPath(path) {
  const absolute = isWslUncPath(path) ? path.replace(/\//gu, "\\") : resolve(path);
  if (isWslUncPath(absolute)) return absolute.replace(/[\\]+$/u, "");
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

/** Comparison key: canonical, forward slashes, case-folded on Windows and for UNC roots. */
export function pathKey(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const key = canonicalPath(path).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" || isWslUncPath(path) ? key.toLowerCase() : key;
}

export function samePath(left, right) { return pathKey(left) !== "" && pathKey(left) === pathKey(right); }

/** Display a path relative to `base` when it lies inside it, with forward slashes. */
export function displayPath(path, base) {
  if (!path) return "";
  if (base && !isWslUncPath(path) && !isWslUncPath(base)) {
    const rel = relative(canonicalPath(base), canonicalPath(path));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  return path;
}

export function writeFileAtomic(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function clientConfigPath(client, configRoot) {
  if (!CLIENT_FILES[client]) throw new Error(`unknown client: ${client}`);
  return join(configRoot, ...CLIENT_FILES[client]);
}

export function parseClientList(value) {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const list = raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (list.includes("all")) return [...CLIENTS];
  const aliases = { antigravity: "gemini", agy: "gemini", openai: "codex", "claude-code": "claude" };
  const resolved = [...new Set(list.map((item) => aliases[item] ?? item))];
  for (const client of resolved) if (!CLIENTS.includes(client)) throw new Error(`--clients: unknown client '${client}' (expected claude, codex, gemini or all)`);
  if (resolved.length === 0) throw new Error("--clients requires at least one client");
  return CLIENTS.filter((client) => resolved.includes(client));
}

// ---------------------------------------------------------------------------------------
// Launcher arguments
// ---------------------------------------------------------------------------------------

/** Parse the bridge launcher argv found in a client configuration (lenient, never throws). */
export function parseLauncherArgs(args) {
  const result = { launcher: undefined, caller: undefined, delegation: undefined, workspace: undefined, db: undefined,
    codexWslExecutable: undefined, geminiCommand: undefined, geminiDialect: undefined, geminiAuth: undefined,
    geminiSkipPermissions: false, unknown: [] };
  if (!Array.isArray(args)) return result;
  for (let index = 0; index < args.length; index++) {
    const token = String(args[index]);
    if (VALUE_FLAGS.has(token)) {
      const value = args[index + 1];
      index++;
      if (value === undefined) continue;
      const key = { "--caller": "caller", "--delegation": "delegation", "--workspace": "workspace", "--db": "db",
        "--codex-wsl-executable": "codexWslExecutable", "--gemini-command": "geminiCommand",
        "--gemini-dialect": "geminiDialect", "--gemini-auth": "geminiAuth" }[token];
      result[key] = String(value);
    } else if (token === "--gemini-skip-permissions") {
      result.geminiSkipPermissions = true;
    } else if (result.launcher === undefined && /native-bridge-mcp\.mjs$/u.test(token)) {
      result.launcher = token;
    } else {
      result.unknown.push(token);
    }
  }
  return result;
}

/** Expand `${CLAUDE_PROJECT_DIR:-.}`-style placeholders that Claude Code resolves itself. */
export function expandClientPlaceholders(value, configRoot) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}/gu, configRoot).replace(/\$CLAUDE_PROJECT_DIR\b/gu, configRoot);
}

function resolveFrom(base, value) {
  if (typeof value !== "string" || value === "") return undefined;
  if (isWslUncPath(value)) return value.replace(/\//gu, "\\");
  if (isWslUncPath(base) && !isAbsolute(value)) {
    // Keep WSL UNC joins platform-independent (POSIX `resolve` would treat them as relative).
    const parts = `${base}\\${value}`.replace(/\//gu, "\\").split("\\").slice(2);
    const out = [];
    for (const part of parts) { if (part === "" || part === ".") continue; if (part === "..") { if (out.length > 2) out.pop(); } else out.push(part); }
    return `\\\\${out.join("\\")}`;
  }
  return resolve(base, value);
}

/** Resolve `value` against `base` exactly like the launcher (WSL UNC aware). */
export function resolveAgainst(base, value) { return resolveFrom(base, value); }

/** Effective launcher, workspace and database exactly as native-bridge-mcp.mjs resolves them. */
export function effectiveSettings(entry, configRoot) {
  const args = Array.isArray(entry?.args) ? entry.args.map((arg) => expandClientPlaceholders(String(arg), configRoot)) : [];
  const parsed = parseLauncherArgs(args);
  const cwd = resolveFrom(configRoot, expandClientPlaceholders(entry?.cwd, configRoot)) ?? configRoot;
  const workspace = parsed.workspace !== undefined ? resolveFrom(cwd, parsed.workspace) : cwd;
  const database = parsed.db !== undefined
    ? (isAbsolute(parsed.db) || isWslUncPath(parsed.db) ? resolveFrom(cwd, parsed.db) : resolveFrom(workspace, parsed.db))
    : resolveFrom(workspace, DEFAULT_DB_RELATIVE);
  return { ...parsed, cwd, launcherPath: parsed.launcher ? resolveFrom(cwd, parsed.launcher) : undefined,
    workspacePath: workspace, databasePath: database, rawArgs: args };
}

// ---------------------------------------------------------------------------------------
// Minimal TOML (only what MCP server tables need), with surgical section replacement
// ---------------------------------------------------------------------------------------

function scanValueEnd(text, start) {
  // Returns the index just past a TOML value starting at `start`, honouring strings,
  // arrays and inline tables that may span several lines.
  let depth = 0, index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), index);
      const close = triple ? char.repeat(3) : char;
      index += close.length;
      while (index < text.length && !text.startsWith(close, index)) {
        if (char === '"' && text[index] === "\\") index++;
        if (!triple && text[index] === "\n") break;
        index++;
      }
      index += close.length;
      if (depth === 0) return index;
      continue;
    }
    if (char === "#" && depth > 0) { while (index < text.length && text[index] !== "\n") index++; continue; }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") { depth--; if (depth === 0) return index + 1; }
    else if (depth === 0 && (char === "\n" || char === "#")) return index;
    index++;
  }
  return index;
}

export function parseTomlValue(raw) {
  const text = String(raw).trim();
  let position = 0;
  function skip() {
    while (position < text.length) {
      if (/\s|,/u.test(text[position])) position++;
      else if (text[position] === "#") { while (position < text.length && text[position] !== "\n") position++; }
      else break;
    }
  }
  function value() {
    skip();
    const char = text[position];
    if (char === '"') {
      if (text.startsWith('"""', position)) {
        const end = text.indexOf('"""', position + 3);
        const body = text.slice(position + 3, end).replace(/^\r?\n/u, "");
        position = end + 3;
        return body;
      }
      let out = "";
      position++;
      while (position < text.length && text[position] !== '"') {
        if (text[position] === "\\") {
          const next = text[++position];
          const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
          if (next === "u" || next === "U") {
            const length = next === "u" ? 4 : 8;
            out += String.fromCodePoint(parseInt(text.slice(position + 1, position + 1 + length), 16));
            position += length;
          } else out += map[next] ?? next;
          position++;
        } else out += text[position++];
      }
      position++;
      return out;
    }
    if (char === "'") {
      const triple = text.startsWith("'''", position);
      const close = triple ? "'''" : "'";
      const end = text.indexOf(close, position + close.length);
      const body = text.slice(position + close.length, end);
      position = end + close.length;
      return triple ? body.replace(/^\r?\n/u, "") : body;
    }
    if (char === "[") {
      position++;
      const items = [];
      for (;;) { skip(); if (position >= text.length || text[position] === "]") { position++; break; } items.push(value()); }
      return items;
    }
    if (char === "{") {
      position++;
      const table = {};
      for (;;) {
        skip();
        if (position >= text.length || text[position] === "}") { position++; break; }
        const eq = text.indexOf("=", position);
        const key = text.slice(position, eq).trim().replace(/^["']|["']$/gu, "");
        position = eq + 1;
        table[key] = value();
      }
      return table;
    }
    const match = /^[^,\]}\s#]+/u.exec(text.slice(position));
    const token = match ? match[0] : "";
    position += token.length;
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?\d[\d_]*$/u.test(token)) return Number(token.replace(/_/gu, ""));
    if (/^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) return Number(token.replace(/_/gu, ""));
    return token;
  }
  return value();
}

function tomlString(value) { return JSON.stringify(String(value)); }
function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return tomlString(value);
}

function sectionHeaderName(line) {
  const match = /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(?:#.*)?$/u.exec(line) ?? /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/u.exec(line);
  if (!match) return null;
  return match[1].split(".").map((part) => part.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1")).join(".");
}

/**
 * Split a TOML document into top-level units: header lines and key/value entries (which may
 * span lines). Each unit keeps its exact source text so unrelated content is reproduced verbatim.
 */
function tomlUnits(text) {
  const units = [];
  let index = 0, table = "";
  while (index < text.length) {
    const lineEnd = text.indexOf("\n", index) === -1 ? text.length : text.indexOf("\n", index) + 1;
    const line = text.slice(index, lineEnd);
    const header = sectionHeaderName(line.replace(/\r?\n$/u, ""));
    if (header !== null) { table = header; units.push({ kind: "header", table, text: line }); index = lineEnd; continue; }
    const kv = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*/u.exec(line);
    if (kv) {
      const valueStart = index + kv[0].length;
      let end = scanValueEnd(text, valueStart);
      const nl = text.indexOf("\n", end);
      end = nl === -1 ? text.length : nl + 1;
      const rawValue = text.slice(valueStart, end).replace(/\s*(?:#[^\n]*)?\r?\n?$/u, "");
      units.push({ kind: "kv", table, key: kv[1].replace(/^["']|["']$/gu, ""), text: text.slice(index, end), rawValue });
      index = end;
      continue;
    }
    units.push({ kind: "other", table, text: line });
    index = lineEnd;
  }
  return units;
}

export function readTomlTable(text, tableName) {
  const result = {};
  let found = false;
  for (const unit of tomlUnits(text)) {
    if (unit.kind === "header" && unit.table === tableName) found = true;
    if (unit.kind === "kv" && unit.table === tableName) {
      try { result[unit.key] = parseTomlValue(unit.rawValue); } catch { result[unit.key] = unit.rawValue; }
    }
  }
  return found ? result : undefined;
}

/**
 * Replace the managed keys of `[tableName]` in place, keep its other keys and comments,
 * append missing keys, or append the whole table when absent. Every other table is untouched.
 */
export function upsertTomlTable(text, tableName, values) {
  const units = tomlUnits(text);
  const headerIndex = units.findIndex((unit) => unit.kind === "header" && unit.table === tableName);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const render = (key) => `${key} = ${tomlValue(values[key])}${eol}`;
  if (headerIndex === -1) {
    const prefix = text.length === 0 ? "" : text.endsWith("\n") ? (text.endsWith(`${eol}${eol}`) ? "" : eol) : `${eol}${eol}`;
    const segment = /^[A-Za-z0-9_-]+$/u.test(tableName.split(".").at(-1)) ? tableName : tableName;
    return `${text}${prefix}[${segment}]${eol}${Object.keys(values).map(render).join("")}`;
  }
  const remaining = new Set(Object.keys(values));
  let lastKv = headerIndex;
  for (let index = headerIndex + 1; index < units.length; index++) {
    const unit = units[index];
    if (unit.kind === "header") break;
    if (unit.kind !== "kv") continue;
    lastKv = index;
    if (remaining.has(unit.key)) { unit.text = render(unit.key); remaining.delete(unit.key); }
  }
  if (remaining.size > 0) {
    const anchor = units[lastKv];
    if (!anchor.text.endsWith("\n")) anchor.text += eol;
    anchor.text += [...remaining].map(render).join("");
  }
  return units.map((unit) => unit.text).join("");
}

// ---------------------------------------------------------------------------------------
// Reading client configurations
// ---------------------------------------------------------------------------------------

/** Inspect one client's configuration in `configRoot`. Never throws on malformed content. */
export function readClientConfig(client, configRoot, serverName = DEFAULT_SERVER_NAME) {
  const path = clientConfigPath(client, configRoot);
  const base = { client, path, exists: false, text: "", parseError: null, entry: undefined, configured: false, effective: null };
  if (!existsSync(path)) return base;
  const text = readFileSync(path, "utf8");
  const result = { ...base, exists: true, text };
  try {
    if (client === "codex") {
      const table = readTomlTable(text, `mcp_servers.${serverName}`);
      result.entry = table;
    } else {
      const config = text.trim() === "" ? {} : JSON.parse(text);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not a JSON object");
      const servers = config.mcpServers ?? {};
      if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers is not an object");
      result.document = config;
      result.entry = servers[serverName];
    }
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
    return result;
  }
  if (result.entry && typeof result.entry === "object") {
    result.configured = true;
    result.effective = effectiveSettings(result.entry, configRoot);
  }
  return result;
}

export function readProjectConfigs(configRoot, serverName = DEFAULT_SERVER_NAME) {
  return Object.fromEntries(CLIENTS.map((client) => [client, readClientConfig(client, configRoot, serverName)]));
}

/**
 * Settings to preserve across a reinstall: custom --workspace (including WSL UNC), custom
 * --db, --codex-wsl-executable and --gemini-* flags. Conflicts between clients are reported.
 */
export function preservedProjectSettings(configs, configRoot) {
  const workspaces = [], databases = [], wsl = [], gemini = {};
  for (const client of CLIENTS) {
    const config = configs[client];
    if (!config?.configured) continue;
    const effective = config.effective;
    if (effective.workspace !== undefined) workspaces.push({ client, raw: effective.workspace, path: effective.workspacePath });
    if (effective.db !== undefined) databases.push({ client, raw: effective.db, path: effective.databasePath });
    if (effective.codexWslExecutable !== undefined) wsl.push({ client, raw: effective.codexWslExecutable });
    gemini[client] = { command: effective.geminiCommand, dialect: effective.geminiDialect, auth: effective.geminiAuth,
      skipPermissions: effective.geminiSkipPermissions };
  }
  const distinct = (items, keyOf) => [...new Map(items.map((item) => [keyOf(item), item])).values()];
  const workspaceDistinct = distinct(workspaces, (item) => pathKey(item.path));
  const databaseDistinct = distinct(databases, (item) => pathKey(item.path));
  const wslDistinct = distinct(wsl, (item) => item.raw);
  return {
    workspace: workspaceDistinct[0]?.path,
    workspaceConflict: workspaceDistinct.length > 1 ? workspaces : null,
    db: databaseDistinct[0]?.raw,
    dbPath: databaseDistinct[0]?.path,
    dbConflict: databaseDistinct.length > 1 ? databases : null,
    codexWslExecutable: wslDistinct[0]?.raw,
    wslConflict: wslDistinct.length > 1 ? wsl : null,
    gemini,
    configRoot,
  };
}

// ---------------------------------------------------------------------------------------
// Desired entries and planning
// ---------------------------------------------------------------------------------------

function looksLikeNode(command) {
  return typeof command === "string" && /^node(?:\.exe)?$/iu.test(basename(command.replace(/\\/gu, "/")));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
export function semanticallyEqual(left, right) { return stableStringify(left) === stableStringify(right); }

/**
 * Desired launcher argv for one client. When an existing raw value designates the same path
 * (e.g. `${CLAUDE_PROJECT_DIR:-.}` or a relative `.`), it is kept verbatim so a ready project
 * stays byte-identical.
 */
export function desiredLauncherArgs(client, settings, existing) {
  const configRoot = settings.configRoot;
  const prior = existing?.configured ? existing.effective : null;
  const rawArgs = Array.isArray(existing?.entry?.args) ? existing.entry.args.map(String) : [];
  const rawOf = (flag) => { const at = rawArgs.indexOf(flag); return at >= 0 ? rawArgs[at + 1] : undefined; };
  const launcherRaw = rawArgs.find((arg) => /native-bridge-mcp\.mjs$/u.test(arg));
  const launcher = prior?.launcherPath && samePath(prior.launcherPath, settings.launcher) && launcherRaw ? launcherRaw : settings.launcher;
  const workspace = prior && samePath(prior.workspacePath, settings.workspace) && rawOf("--workspace") !== undefined
    ? rawOf("--workspace") : settings.workspace;
  const args = [launcher, "--caller", client, "--delegation", settings.delegation ?? prior?.delegation ?? "allow", "--workspace", workspace];
  if (settings.db !== undefined) {
    const sameDb = prior?.db !== undefined && samePath(prior.databasePath, settings.dbPath ?? settings.db);
    args.push("--db", sameDb ? rawOf("--db") : settings.db);
  }
  if (settings.codexWslExecutable !== undefined) args.push("--codex-wsl-executable", settings.codexWslExecutable);
  const gemini = { ...(settings.preservedGemini?.[client] ?? {}), ...(settings.geminiOverrides ?? {}) };
  if (gemini.command !== undefined) args.push("--gemini-command", gemini.command);
  if (gemini.dialect !== undefined) args.push("--gemini-dialect", gemini.dialect);
  if (gemini.auth !== undefined) args.push("--gemini-auth", gemini.auth);
  if (gemini.skipPermissions) args.push("--gemini-skip-permissions");
  return args;
}

function desiredCommand(existingEntry, settings) {
  if (!settings.force && looksLikeNode(existingEntry?.command)) return existingEntry.command;
  return settings.nodePath ?? process.execPath;
}

function desiredCwd(existingEntry, settings) {
  const raw = existingEntry?.cwd;
  const target = isWslUncPath(settings.workspace) ? settings.configRoot : settings.workspace;
  if (typeof raw === "string" && samePath(resolveFrom(settings.configRoot, expandClientPlaceholders(raw, settings.configRoot)), target)) return raw;
  return target;
}

/** Plan one client: returns { changed, text, path, existed, reasons }. Pure: writes nothing. */
export function planClientConfig(client, existing, settings) {
  const serverName = settings.serverName ?? DEFAULT_SERVER_NAME;
  const path = clientConfigPath(client, settings.configRoot);
  if (existing.parseError && !settings.force) {
    return { client, path, existed: true, changed: false, blocked: true, text: existing.text,
      reasons: [`configuration illisible (${existing.parseError}) ; relancer avec --force pour la remplacer`] };
  }
  const entry = existing.parseError ? undefined : existing.entry;
  const args = desiredLauncherArgs(client, settings, existing.parseError ? null : existing);
  const reasons = [];
  if (!existing.configured) reasons.push(existing.exists ? `serveur '${serverName}' ajouté` : "fichier créé");
  if (client === "codex") {
    const previous = entry ?? {};
    const values = {
      command: desiredCommand(previous, settings),
      args,
      cwd: desiredCwd(previous, settings),
      enabled: true,
      required: true,
      startup_timeout_sec: Math.max(Number(previous.startup_timeout_sec) || 0, CODEX_STARTUP_TIMEOUT_SEC),
      tool_timeout_sec: Math.max(Number(previous.tool_timeout_sec) || 0, CODEX_TOOL_TIMEOUT_SEC),
    };
    const managedBefore = Object.fromEntries(Object.keys(values).map((key) => [key, previous[key]]));
    const changed = !existing.configured || !semanticallyEqual(managedBefore, values) || Boolean(existing.parseError);
    if (existing.configured) for (const key of Object.keys(values)) if (!semanticallyEqual(previous[key], values[key])) reasons.push(`${key} mis à jour`);
    const base = existing.parseError ? "" : existing.text;
    return { client, path, existed: existing.exists, changed, text: changed ? upsertTomlTable(base, `mcp_servers.${serverName}`, values) : existing.text, reasons };
  }
  const document = existing.parseError || !existing.document ? {} : existing.document;
  const previous = entry && typeof entry === "object" ? entry : {};
  const next = { ...previous };
  if (client === "claude") next.type = "stdio";
  next.command = desiredCommand(previous, settings);
  next.args = args;
  if (client === "gemini") next.cwd = desiredCwd(previous, settings);
  next.env = previous.env && typeof previous.env === "object" && !Array.isArray(previous.env) ? previous.env : {};
  if (client === "gemini") {
    next.disabled = false;
    next.timeoutSeconds = Math.max(Number(previous.timeoutSeconds) || 0, GEMINI_TIMEOUT_SECONDS);
    const tools = previous.tools && typeof previous.tools === "object" && !Array.isArray(previous.tools) ? { ...previous.tools } : {};
    for (const tool of GEMINI_EAGER_TOOLS) tools[tool] = { ...(tools[tool] ?? {}), eager: true };
    next.tools = tools;
  }
  const changed = !existing.configured || !semanticallyEqual(previous, next) || Boolean(existing.parseError);
  if (existing.configured) for (const key of Object.keys(next)) if (!semanticallyEqual(previous[key], next[key])) reasons.push(`${key} mis à jour`);
  const servers = document.mcpServers && typeof document.mcpServers === "object" ? document.mcpServers : {};
  const merged = { ...document, mcpServers: { ...servers, [serverName]: next } };
  return { client, path, existed: existing.exists, changed, text: changed ? `${JSON.stringify(merged, null, 2)}\n` : existing.text, reasons };
}

/** Apply a plan: no-op when unchanged; otherwise `.bak` (0o600) + atomic replace. */
export function applyClientPlan(plan) {
  if (!plan.changed || plan.blocked) return { written: false, backup: null };
  let backup = null;
  if (existsSync(plan.path)) {
    backup = `${plan.path}.bak`;
    writeFileSync(backup, readFileSync(plan.path), { mode: 0o600 });
  }
  writeFileAtomic(plan.path, plan.text, 0o600);
  return { written: true, backup };
}
