#!/usr/bin/env node
/**
 * `bridge doctor`: concrete per-client verification of one project — central installation,
 * Claude/Codex/Gemini configuration (caller identity, launcher, workspace), effective SQLite
 * database(s) and schema, WSL Codex wiring/login, and running MCP sessions still loaded from an
 * older installation. Each problem carries one exact French remediation.
 *
 * Every external probe is injectable (`execCommand`, `listProcesses`, `inspectDatabase`,
 * `registryDir`, `bridgeHome`) so all scenarios are deterministic in tests. Databases are only
 * read through bridge-doctor's disposable copy; nothing is migrated, repaired or written.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDatabaseCopy, supportedSchemaVersion } from "../bridge-doctor.mjs";
import { CLIENTS, CLIENT_LABELS, DEFAULT_DB_RELATIVE, DEFAULT_SERVER_NAME, canonicalPath, displayPath, isWslUncPath,
  parseClientList, parseLauncherArgs, pathKey, readClientConfig, readProjectConfigs, resolveAgainst, samePath,
  wslDistribution } from "./client-configs.mjs";
import { discoverCentralInstallation } from "./registry.mjs";

export const CURRENT_SCHEMA_VERSION = 6;
const MIN_TOOL_TIMEOUT = 600;

export const DOCTOR_CLI_HELP = `bridge doctor — per-client verification of a connected project

  --project <dir>        project configuration root (default: current directory)
  --clients <csv|all>    restrict to claude,codex,gemini (default: all)
  --bridge-home <dir>    central installation to compare against
  --registry-dir <dir>   bridge registry (default: $BRIDGE_REGISTRY_DIR or ~/.bridge)
  --no-processes         skip the running MCP process scan
  --no-wsl-probe         skip wsl.exe probes (binary and login status)
  --json                 machine-readable report
  --help

Read-only: no migration, repair, model call or network access. Exit code 1 when an error is found.
`;

export function parseDoctorCliArgs(argv, cwd = process.cwd()) {
  const args = { project: resolve(cwd), clients: undefined, bridgeHome: undefined, registryDir: undefined, json: false,
    processes: true, wslProbe: true, help: false, serverName: DEFAULT_SERVER_NAME };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--project": args.project = resolve(cwd, value()); break;
      case "--clients": args.clients = parseClientList(value()); break;
      case "--bridge-home": args.bridgeHome = resolve(cwd, value()); break;
      case "--registry-dir": args.registryDir = resolve(cwd, value()); break;
      case "--server-name": args.serverName = value(); break;
      case "--no-processes": args.processes = false; break;
      case "--no-wsl-probe": args.wslProbe = false; break;
      case "--json": args.json = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------------------
// Probes (defaults; all injectable)
// ---------------------------------------------------------------------------------------

function defaultExecCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 15_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** Split a process command line (Windows or POSIX quoting) into tokens. */
export function splitCommandLine(text) {
  const tokens = [];
  let current = "", quoted = false, started = false;
  for (const char of String(text ?? "")) {
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/u.test(char)) { if (started) { tokens.push(current); current = ""; started = false; } continue; }
    current += char; started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Keep only bridge launcher facts from a process; nothing else from the command line leaks. */
export function parseBridgeProcess(item) {
  const tokens = Array.isArray(item?.args) ? item.args.map(String) : splitCommandLine(item?.commandLine);
  const at = tokens.findIndex((token) => /native-bridge-mcp\.mjs$/u.test(token));
  if (at < 0) return null;
  const parsed = parseLauncherArgs(tokens.slice(at));
  const pid = Number(item.pid ?? item.ProcessId);
  return { pid: Number.isSafeInteger(pid) ? pid : null, caller: parsed.caller ?? null, workspace: parsed.workspace ?? null,
    db: parsed.db ?? null, launcher: parsed.launcher ?? null };
}

export function defaultListProcesses() {
  try {
    if (process.platform === "win32") {
      const command = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (result.status !== 0 || !result.stdout?.trim()) return [];
      const parsed = JSON.parse(result.stdout);
      return (Array.isArray(parsed) ? parsed : [parsed])
        .filter((row) => typeof row?.CommandLine === "string" && row.CommandLine.includes("native-bridge-mcp.mjs"))
        .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine }));
    }
    const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return [];
    return result.stdout.split("\n").filter((line) => line.includes("native-bridge-mcp.mjs")).map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
    }).filter(Boolean);
  } catch { return []; }
}

function readVersion(root) {
  try { const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version; return typeof value === "string" ? value : null; }
  catch { return null; }
}

function compareVersions(left, right) {
  const parse = (value) => String(value ?? "").split(/[.-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------------------

export async function runBridgeDoctor(input = {}) {
  const options = { serverName: DEFAULT_SERVER_NAME, ...input };
  const exec = options.execCommand ?? defaultExecCommand;
  const inspectDatabase = options.inspectDatabase ?? inspectDatabaseCopy;
  const configRoot = canonicalPath(options.project ?? process.cwd());
  const findings = [];
  const add = (severity, code, message, remediation = null, clients = []) => {
    findings.push({ severity, code, message, remediation, clients: [...new Set(clients)] });
  };
  const setupFix = (clients, extra = "") => `bridge setup --project "${configRoot}" --clients ${clients.join(",")}${extra} --force`;

  // Central installation.
  const central = discoverCentralInstallation(options);
  const centralReport = central.found
    ? { found: true, root: central.root, version: central.version, built: central.built, launcher: central.launcher, source: central.source }
    : { found: false, root: null, version: null, built: false, launcher: null, source: null, target_root: central.targetRoot };
  if (!central.found) add("error", "central_missing", "Installation centrale introuvable", `bridge setup --project "${configRoot}" --bootstrap-archive <archive.zip>`);
  else if (!central.built) add("error", "central_not_built", `Installation centrale non construite (${central.root})`, `cd "${central.root}" && npm ci && npm run build`);
  const supported = options.supportedSchemaVersion ?? (central.found ? supportedSchemaVersion(central.root) : null) ?? CURRENT_SCHEMA_VERSION;

  // Clients.
  const selected = options.clients ?? [...CLIENTS];
  const configs = options.clients ? Object.fromEntries(selected.map((client) => [client, readClientConfig(client, configRoot, options.serverName)]))
    : readProjectConfigs(configRoot, options.serverName);
  const clients = [];
  for (const client of selected) {
    const label = CLIENT_LABELS[client];
    const config = configs[client];
    const relPath = displayPath(config.path, configRoot);
    const item = { client, label, path: config.path, configured: config.configured, status: "absent", caller: null,
      workspace: null, database: null, database_display: null, launcher: null, version: null };
    clients.push(item);
    if (config.parseError) {
      item.status = "invalid";
      add("error", "config_invalid", `${label} mal configuré : ${relPath} illisible (${config.parseError})`, setupFix([client]), [client]);
      continue;
    }
    if (!config.configured) {
      if (config.exists) add("warning", "server_missing", `${label} : serveur '${options.serverName}' absent de ${relPath}`, `bridge setup --project "${configRoot}" --clients ${client}`, [client]);
      else if (options.clients) add("info", "client_absent", `${label} non configuré (${relPath} absent)`, `bridge setup --project "${configRoot}" --clients ${client}`, [client]);
      continue;
    }
    const effective = config.effective;
    Object.assign(item, { status: "configured", caller: effective.caller ?? null, workspace: effective.workspacePath,
      database: effective.databasePath, launcher: effective.launcherPath ?? null });
    item.database_display = displayPath(effective.databasePath, effective.workspacePath);
    if (effective.caller !== client) {
      add("error", "caller_mismatch", `${label} mal configuré : déclaré avec --caller ${effective.caller ?? "(absent)"} au lieu de ${client}`, setupFix([client]), [client]);
    }
    if (!effective.launcherPath) {
      add("error", "launcher_missing", `${label} mal configuré : native-bridge-mcp.mjs absent des arguments`, setupFix([client]), [client]);
    } else if (!existsSync(effective.launcherPath)) {
      add("error", "launcher_not_found", `${label} : lanceur introuvable (${effective.launcherPath})`, setupFix([client]), [client]);
    } else {
      const launcherRoot = dirname(dirname(effective.launcherPath));
      item.version = readVersion(launcherRoot);
      if (central.found && !samePath(effective.launcherPath, central.launcher)) {
        add("warning", "launcher_not_central", `${label} pointe vers une autre installation (${launcherRoot}, v${item.version ?? "?"}) au lieu de la centrale (v${central.version ?? "?"})`, setupFix([client]), [client]);
      }
    }
    const workspace = effective.workspacePath;
    if (isWslUncPath(workspace)) {
      add("info", "workspace_wsl", `${label} : workspace WSL externe (${wslDistribution(workspace)}) ${workspace} servi depuis le dossier hôte ${configRoot}`, null, [client]);
    } else if (!existsSync(workspace)) {
      add("error", "workspace_missing", `${label} : workspace introuvable (${workspace})`, `bridge setup --project "${configRoot}" --workspace "${configRoot}" --clients ${client} --force`, [client]);
    } else if (!samePath(workspace, configRoot)) {
      const other = readProjectConfigs(workspace, options.serverName);
      const ownProject = CLIENTS.some((name) => other[name].configured && samePath(other[name].effective.workspacePath, workspace));
      if (ownProject) {
        add("warning", "workspace_other_project", `${label} : --workspace pointe vers un autre projet connecté (${workspace}) au lieu de ${configRoot}`, `bridge setup --project "${configRoot}" --workspace "${configRoot}" --clients ${client} --force`, [client]);
      } else {
        add("info", "workspace_external", `${label} : workspace externe ${workspace} (dossier hôte ${configRoot})`, null, [client]);
      }
    }
    if (client !== "claude" && config.entry.cwd !== undefined && !samePath(effective.cwd, workspace) && !samePath(effective.cwd, configRoot)) {
      add("warning", "cwd_mismatch", `${label} : cwd (${effective.cwd}) ne correspond ni au workspace ni au dossier du projet`, setupFix([client]), [client]);
    }
    if (client === "gemini") {
      const timeout = Number(config.entry.timeoutSeconds);
      if (!Number.isFinite(timeout) || timeout < MIN_TOOL_TIMEOUT) {
        add("warning", "gemini_timeout", `Gemini : timeoutSeconds ${Number.isFinite(timeout) ? timeout : "absent"} < ${MIN_TOOL_TIMEOUT} dans .agents/mcp_config.json (délégations longues interrompues)`, setupFix(["gemini"]), [client]);
      }
      if (config.entry.disabled === true) add("warning", "gemini_disabled", "Gemini : serveur bridge désactivé (disabled: true)", setupFix(["gemini"]), [client]);
    }
    if (client === "codex") {
      const timeout = Number(config.entry.tool_timeout_sec);
      if (Number.isFinite(timeout) && timeout < MIN_TOOL_TIMEOUT) add("warning", "codex_timeout", `Codex : tool_timeout_sec ${timeout} < ${MIN_TOOL_TIMEOUT} dans .codex/config.toml`, setupFix(["codex"]), [client]);
      if (config.entry.enabled === false) add("warning", "codex_disabled", "Codex : serveur bridge désactivé (enabled = false)", setupFix(["codex"]), [client]);
    }
  }
  const active = clients.filter((item) => item.status === "configured");

  // Workspaces across clients.
  const workspaceGroups = new Map();
  for (const item of active) workspaceGroups.set(pathKey(item.workspace), [...(workspaceGroups.get(pathKey(item.workspace)) ?? []), item]);
  if (workspaceGroups.size > 1) {
    const list = active.map((item) => `${item.label} : ${item.workspace}`).join(", ");
    add("error", "workspace_divergence", `Workspaces divergents entre clients (${list})`, `bridge setup --project "${configRoot}" --workspace "<chemin>" --force`, active.map((item) => item.client));
  }

  // Databases.
  const groups = new Map();
  for (const item of active) {
    const key = pathKey(item.database);
    if (!groups.has(key)) groups.set(key, { path: item.database, display: item.database_display, clients: [] });
    groups.get(key).clients.push(item.client);
  }
  const databases = [];
  for (const group of groups.values()) {
    const info = inspectDatabase(group.path, supported) ?? {};
    databases.push({ path: group.path, display: group.display, clients: group.clients, status: info.status ?? "unknown",
      schema_version: info.schema_version ?? null, task_count: info.task_count ?? null });
  }
  if (databases.length > 1) {
    const ranked = [...databases].sort((a, b) => (b.schema_version ?? -1) - (a.schema_version ?? -1));
    const best = ranked[0];
    const describe = (db) => `${db.display} [${db.schema_version === null ? db.status === "absent_or_unreadable" ? "absente" : "schéma ?" : `schéma ${db.schema_version}`}]`;
    const list = databases.flatMap((db) => db.clients.map((client) => `${CLIENT_LABELS[client]} : ${describe(db)}`)).join(", ");
    add("error", "database_divergence", `Bases SQLite divergentes entre clients (${list})`, `bridge setup --project "${configRoot}" --db "${best.display}" --force`, active.map((item) => item.client));
  }
  for (const db of databases) {
    if (db.status === "absent_or_unreadable") {
      add("info", "database_absent", `Base SQLite absente (${db.display}) : créée au premier démarrage`, null, db.clients);
    } else if (db.schema_version !== null && db.schema_version < supported) {
      add("warning", "database_legacy", `Base SQLite en schéma ${db.schema_version} (migration vers schéma ${supported} à l'ouverture) : ${db.display}`,
        `sauvegarder "${db.path}" (copie vers "${db.path}.schema${db.schema_version}.bak") puis recharger le serveur MCP pour migrer`, db.clients);
    } else if (db.schema_version !== null && db.schema_version > supported) {
      add("error", "database_newer", `Base SQLite en schéma ${db.schema_version}, plus récente que l'installation centrale (schéma ${supported}) : ${db.display}`,
        central.found ? `mettre à jour l'installation centrale (${central.root}) puis bridge setup --project "${configRoot}" --force` : null, db.clients);
    } else if (db.status !== "available") {
      add("warning", "database_unreadable", `Base SQLite non inspectable (${db.status}) : ${db.display}`, "relancer bridge doctor quand aucune écriture n'est en cours", db.clients);
    }
  }
  const candidateDefaultDbs = new Set();
  if (active[0]?.workspace) candidateDefaultDbs.add(resolveAgainst(active[0].workspace, DEFAULT_DB_RELATIVE));
  candidateDefaultDbs.add(resolveAgainst(configRoot, DEFAULT_DB_RELATIVE));
  for (const defaultDb of candidateDefaultDbs) {
    if (!groups.has(pathKey(defaultDb)) && (isWslUncPath(defaultDb) || existsSync(defaultDb))) {
      const info = inspectDatabase(defaultDb, supported) ?? {};
      if (info.status === "available") {
        const shown = displayPath(defaultDb, configRoot);
        const legacyHint = info.schema_version !== null && info.schema_version < supported ? `, migration requise vers schéma ${supported} si réutilisée` : "";
        add("info", "database_orphan", `Base secondaire ${shown}${info.schema_version !== null && info.schema_version !== undefined ? ` (schéma ${info.schema_version}${legacyHint})` : ""} présente mais utilisée par aucun client`, null, []);
      }
    }
  }

  // Native Codex platform binary check (catches missing @openai/codex-<platform> optional dependency).
  if (central.found && active.some((item) => item.client === "codex" && !isWslUncPath(item.workspace))) {
    const codexPkgPath = join(central.root, "codex", "codex-side", "node_modules", "@openai", "codex", "package.json");
    if (existsSync(codexPkgPath)) {
      const targetMap = { "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
        "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
        "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
        "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
        "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
        "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"] };
      const spec = targetMap[`${process.platform}:${process.arch}`];
      if (spec) {
        const [pkgName, triple, exeName] = spec;
        const candidates = [
          join(central.root, "node_modules", ...pkgName.split("/"), "vendor", triple, "bin", exeName),
          join(central.root, "codex", "codex-side", "node_modules", ...pkgName.split("/"), "vendor", triple, "bin", exeName),
        ];
        if (!candidates.some((candidate) => existsSync(candidate))) {
          add("error", "codex_platform_binary_missing",
            `Codex natif incomplet dans l'installation centrale : dépendance optionnelle ${pkgName} absente`,
            `cd "${central.root}" && npm install --no-save ${pkgName}`, ["codex"]);
        }
      }
    }
  }

  // WSL Codex wiring and login.
  let wsl = null;
  const uncItems = active.filter((item) => isWslUncPath(item.workspace));
  if (uncItems.length > 0) {
    const distro = wslDistribution(uncItems[0].workspace);
    const executables = uncItems.map((item) => configs[item.client].effective.codexWslExecutable).filter(Boolean);
    const missing = uncItems.filter((item) => !configs[item.client].effective.codexWslExecutable);
    wsl = { distribution: distro, executable: executables[0] ?? null, installed: null, logged_in: null };
    if (missing.length > 0) {
      const which = missing.length === uncItems.length ? "" : ` (${missing.map((item) => item.label).join(", ")})`;
      add("error", "wsl_codex_unwired", `Codex WSL non raccordé : workspace UNC (${distro}) sans --codex-wsl-executable${which}`,
        `bridge setup --project "${configRoot}" --codex-wsl-executable /usr/local/bin/codex --force`, missing.map((item) => item.client));
    }
    const exe = executables[0];
    if (exe && (!exe.startsWith("/") || exe.startsWith("/mnt/"))) {
      add("error", "wsl_codex_windows_path", `Codex WSL mal configuré : ${exe} n'est pas un binaire Linux de ${distro} (chemin Windows /mnt/... ou relatif)`,
        `bridge setup --project "${configRoot}" --codex-wsl-executable /usr/local/bin/codex --force`, uncItems.map((item) => item.client));
    } else if (exe && options.wslProbe !== false) {
      const installed = exec("wsl.exe", ["--distribution", distro, "--exec", "test", "-x", exe], { timeout: 15_000 });
      if (installed.error || installed.status === null) {
        add("warning", "wsl_unavailable", `WSL indisponible sur cet hôte (wsl.exe ne répond pas pour ${distro})`, `wsl.exe --install -d ${distro}`, ["codex"]);
      } else if (installed.status !== 0) {
        wsl.installed = false;
        add("error", "wsl_codex_missing", `Codex introuvable dans ${distro} (${exe})`, `wsl.exe --distribution ${distro} -- npm install -g @openai/codex`, ["codex"]);
      } else {
        wsl.installed = true;
        const login = exec("wsl.exe", ["--distribution", distro, "--exec", exe, "login", "status"], { timeout: 15_000 });
        wsl.logged_in = login.status === 0;
        if (login.status === 0) add("info", "wsl_codex_ready", `Codex ${distro} installé et connecté (${exe})`, null, []);
        else add("error", "wsl_codex_login", `Codex ${distro} installé, connexion requise`, `wsl.exe --distribution ${distro} -- ${exe} login`, ["codex"]);
      }
    }
  }

  // Running MCP sessions.
  const processes = [];
  if (options.processes !== false && options.listProcesses !== false) {
    let listed = [];
    try { listed = await (options.listProcesses ?? defaultListProcesses)(); } catch { listed = []; }
    const workspaceKeys = new Set(active.map((item) => pathKey(item.workspace)));
    const databaseKeys = new Set(active.map((item) => pathKey(item.database)));
    for (const row of listed ?? []) {
      const proc = parseBridgeProcess(row);
      if (!proc) continue;
      const procWorkspace = proc.workspace && (isAbsolute(proc.workspace) || isWslUncPath(proc.workspace)) ? proc.workspace : null;
      const procDb = proc.db ? (isAbsolute(proc.db) || isWslUncPath(proc.db) ? proc.db : procWorkspace ? resolveAgainst(procWorkspace, proc.db) : null)
        : procWorkspace ? resolveAgainst(procWorkspace, DEFAULT_DB_RELATIVE) : null;
      const matches = (procWorkspace && workspaceKeys.has(pathKey(procWorkspace))) || (procDb && databaseKeys.has(pathKey(procDb)));
      if (!matches) continue;
      const launcherRoot = proc.launcher && isAbsolute(proc.launcher) ? dirname(dirname(resolve(proc.launcher))) : null;
      const version = launcherRoot ? readVersion(launcherRoot) : null;
      const label = CLIENT_LABELS[proc.caller] ?? proc.caller ?? "Client";
      const entry = { pid: proc.pid, caller: proc.caller, version, launcher_root: launcherRoot, stale: false };
      processes.push(entry);
      if (!central.found) continue;
      const reload = `recharger le serveur MCP ou rouvrir la session ${label} sur ce projet`;
      if (version !== central.version) {
        entry.stale = true;
        const relation = compareVersions(version, central.version) < 0 ? "la version précédente" : "une autre version";
        add("error", "stale_session", `${label} utilise encore ${relation} (${version ?? "inconnue"} en mémoire, PID ${proc.pid}, centrale ${central.version}), rouvrir la session`, reload, [proc.caller]);
      } else if (launcherRoot && !samePath(launcherRoot, central.root)) {
        entry.stale = true;
        add("warning", "foreign_session", `${label} exécute le bridge depuis une autre installation (${launcherRoot}, PID ${proc.pid})`, reload, [proc.caller]);
      }
    }
  }

  // Per-client verdicts.
  const ready = [];
  for (const item of active) {
    const blocking = findings.some((finding) => finding.severity !== "info" && finding.clients.includes(item.client));
    const global = findings.some((finding) => finding.severity === "error" && finding.clients.length === 0);
    const db = databases.find((entry) => entry.clients.includes(item.client));
    const schema = db?.schema_version !== null && db?.schema_version !== undefined ? `schéma ${db.schema_version}` : "base absente";
    if (!blocking && !global) {
      item.status = "ready";
      ready.push(`${item.label} prêt (v${item.version ?? central.version ?? "?"}, caller=${item.client}, db=${item.database_display} [${schema}])`);
    } else item.status = "needs_attention";
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  return { command: "doctor", config_root: configRoot, status: errors > 0 ? "error" : warnings > 0 ? "warning" : "ok",
    central: centralReport, supported_schema_version: supported, clients, databases, wsl, processes, findings, ready,
    counts: { errors, warnings } };
}

const MARKERS = { error: "[ERREUR]", warning: "[ATTENTION]", info: "[INFO]" };

export function formatDoctorReport(report) {
  const lines = [`bridge doctor — ${report.config_root}`];
  const central = report.central;
  lines.push(central.found
    ? `Installation centrale : ${central.root} (v${central.version ?? "?"}, ${central.built ? "construite" : "non construite"}, source ${central.source})`
    : "Installation centrale : introuvable");
  for (const line of report.ready) lines.push(`[OK] ${line}`);
  for (const severity of ["error", "warning", "info"]) {
    for (const finding of report.findings.filter((item) => item.severity === severity)) {
      lines.push(`${MARKERS[severity]} ${finding.message}`);
      if (finding.remediation) lines.push(`  Correction : ${finding.remediation}`);
    }
  }
  lines.push(`Résultat : ${report.counts.errors} erreur(s), ${report.counts.warnings} avertissement(s)`);
  return `${lines.join("\n")}\n`;
}

export function doctorExitCode(report) { return report.counts.errors > 0 ? 1 : 0; }

async function main() {
  let args;
  try { args = parseDoctorCliArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`bridge doctor: ${error.message}; run --help\n`); process.exitCode = 2; return; }
  if (args.help) { process.stdout.write(DOCTOR_CLI_HELP); return; }
  const report = await runBridgeDoctor(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  process.exitCode = doctorExitCode(report);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(selfPath)) {
  main().catch((error) => { process.stderr.write(`bridge doctor: ${error.message}\n`); process.exitCode = 1; });
}
