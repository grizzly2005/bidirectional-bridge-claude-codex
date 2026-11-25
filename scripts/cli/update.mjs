#!/usr/bin/env node
/** Release preflight and managed-install activation. Check mode never changes an installation. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDatabaseCopy, supportedSchemaVersion } from "../bridge-doctor.mjs";
import { defaultListProcesses, parseBridgeProcess } from "./doctor.mjs";
import { CLIENTS, pathKey, readProjectConfigs } from "./client-configs.mjs";
import { discoverCentralInstallation } from "./registry.mjs";
import { assessCompatibility, compareVersions, downloadVerifiedZip, extractVerifiedZip, fetchReleaseAssets, getReleases, selectRelease } from "./github-release.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TASKS = ["WORKING", "CLAIMED", "VERIFYING"];
const ACTIVE_EXECUTIONS = ["QUEUED", "RUNNING", "QUARANTINED"];
export const UPDATE_HELP = `bridge update — check GitHub Releases and connected project impact

  --apply                  verify, smoke test and activate an update
  --auto-compatible        activate only when every compatibility and preflight gate passes
  --allow-migration        permit documented SQLite migration after making DB backups
  --allow-active           permit active tasks or executions (manual override)
  --allow-downgrade        permit an explicitly selected older release
  --include-prerelease     include prereleases in the release feed
  --tag <vX.Y.Z>           select an exact release tag
  --repo <owner/name>      override the GitHub repository
  --bridge-home <dir>      central installation
  --registry-dir <dir>     connected project registry
  --scan-root <dir>        scan a project root and its direct children (repeatable)
  --feed-file <path>       offline release feed JSON
  --assets-dir <dir>       offline release assets
  --skip-npm-ci            test-only; requires injected pre-linked node_modules
  --json                   JSON report
  --help                   show this help
`;

export function parseUpdateArgs(argv, cwd = process.cwd()) {
  const options = { apply: false, autoCompatible: false, allowMigration: false, allowActive: false, allowDowngrade: false,
    includePrerelease: false, skipNpmCi: false, json: false, help: false, scanRoots: [] };
  const values = { "--tag": "tag", "--repo": "repo", "--bridge-home": "bridgeHome", "--registry-dir": "registryDir",
    "--feed-file": "feedFile", "--assets-dir": "assetsDir", "--scan-root": "scanRoots" };
  const booleans = { "--apply": "apply", "--auto-compatible": "autoCompatible", "--allow-migration": "allowMigration", "--allow-active": "allowActive",
    "--allow-downgrade": "allowDowngrade", "--include-prerelease": "includePrerelease", "--skip-npm-ci": "skipNpmCi", "--json": "json", "--help": "help", "-h": "help" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in booleans) { options[booleans[flag]] = true; continue; }
    if (!(flag in values)) throw new Error(`unknown update option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--scan-root") options.scanRoots.push(resolve(cwd, value));
    else options[values[flag]] = ["--tag", "--repo"].includes(flag) ? value : resolve(cwd, value);
  }
  if (options.apply && options.autoCompatible) throw new Error("--apply and --auto-compatible are mutually exclusive");
  if (options.tag && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.tag)) throw new Error("--tag must be vX.Y.Z");
  return options;
}

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function installedVersion(root) { return root ? readJson(join(root, "package.json"))?.version ?? null : null; }
function centralInstallation(options, registryDir) {
  if (options.bridgeHome) {
    const root = resolve(options.bridgeHome);
    return { root, version: installedVersion(root), source: "bridge_home" };
  }
  const discovered = discoverCentralInstallation({ ...options, registryDir });
  if (discovered.found) {
    return { root: resolve(discovered.root), version: discovered.version, source: discovered.source };
  }
  const fallback = resolve(discovered.targetRoot ?? join(registryDir, "install", "current"));
  return { root: fallback, version: installedVersion(fallback), source: "target_root" };
}
function protocolVersion(root) {
  const manifest = readJson(join(root, "RELEASE.json"));
  if (typeof manifest?.protocol_version === "string") return manifest.protocol_version;
  try { return /\bPROTOCOL_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/u.exec(readFileSync(join(root, "shared/protocol/src/index.ts"), "utf8"))?.[1] ?? null; }
  catch { return null; }
}
function projectEntries(registryDir, scanRoots, centralRoot) {
  const document = readJson(join(registryDir, "projects.json"));
  const projects = Array.isArray(document?.projects) ? document.projects : document?.projects && typeof document.projects === "object" ? Object.values(document.projects) : [];
  const entries = new Map();
  for (const entry of projects) {
    if (!entry || typeof entry !== "object" || !entry.config_root && !entry.workspace_root) continue;
    const root = resolve(entry.config_root ?? entry.workspace_root);
    entries.set(pathKey(root), { ...entry, config_root: root, workspace_root: resolve(entry.workspace_root ?? root) });
  }
  for (const scanRoot of scanRoots ?? []) {
    let candidates = [scanRoot];
    try { candidates = candidates.concat(readdirSync(scanRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => join(scanRoot, item.name))); }
    catch {}
    for (const root of candidates) {
      let configs;
      try { configs = readProjectConfigs(root); } catch { continue; }
      const linked = CLIENTS.filter((client) => configs[client]?.configured && pathKey(dirname(dirname(configs[client].effective.launcherPath ?? ""))) === pathKey(centralRoot));
      if (!linked.length) continue;
      const first = configs[linked[0]].effective;
      const key = pathKey(root);
      entries.set(key, { ...(entries.get(key) ?? {}), config_root: resolve(root), workspace_root: first.workspacePath ?? resolve(root),
        database_path: first.databasePath ?? null, clients: [...new Set([...(entries.get(key)?.clients ?? []), ...linked])], bridge_root: centralRoot });
    }
  }
  return [...entries.values()].sort((a, b) => a.config_root.localeCompare(b.config_root));
}
function projectDatabases(entry) {
  const paths = new Set();
  if (entry.database_path) paths.add(resolve(entry.workspace_root, entry.database_path));
  const siblingDir = join(entry.config_root, ".bridge");
  try { for (const name of readdirSync(siblingDir)) if (name.endsWith(".db")) paths.add(join(siblingDir, name)); } catch {}
  if (!paths.size) paths.add(join(entry.workspace_root, ".bridge", "bridge.db"));
  return [...paths].sort();
}
async function inventoryProjects(entries, targetSchema, inspectDatabase) {
  const results = [];
  for (const entry of entries) {
    const databases = [];
    for (const path of projectDatabases(entry)) {
      const info = await inspectDatabase(path, targetSchema);
      const rawStatus = info?.status ?? "unknown";
      const status = rawStatus === "absent_or_unreadable" && existsSync(path) ? "unreadable_existing_file" : rawStatus;
      const schema = info?.schema_version ?? null;
      const active_tasks = Object.fromEntries(ACTIVE_TASKS.map((state) => [state, Number(info?.tasks_by_state?.[state] ?? 0)]));
      const active_executions = Object.fromEntries(ACTIVE_EXECUTIONS.map((phase) => [phase, Number(info?.executions_by_phase?.[phase] ?? 0)]));
      databases.push({ path, status, schema_version: schema, needs_migration: schema !== null && schema < targetSchema,
        newer_schema: schema !== null && schema > targetSchema, active_tasks, active_executions,
        has_active_work: Object.values(active_tasks).some(Boolean) || Object.values(active_executions).some(Boolean) });
    }
    results.push({ config_root: entry.config_root, workspace_root: entry.workspace_root, bridge_root: entry.bridge_root ?? null,
      clients: entry.clients ?? [], databases, needs_migration: databases.some((db) => db.needs_migration),
      has_active_work: databases.some((db) => db.has_active_work) });
  }
  return results;
}
function processInventory(items, centralRoot, targetVersion) {
  const sessions = [];
  for (const item of items ?? []) {
    const parsed = parseBridgeProcess(item);
    if (!parsed) continue;
    const root = parsed.launcher ? dirname(dirname(parsed.launcher)) : null;
    const version = root ? installedVersion(root) : null;
    const stale = !version || compareVersions(version, targetVersion) < 0 || pathKey(root) !== pathKey(centralRoot);
    sessions.push({ pid: parsed.pid, caller: parsed.caller, workspace: parsed.workspace, database_path: parsed.db,
      running_version: version, status: stale ? "stale_version" : "current_version" });
  }
  return sessions.sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0));
}
function blockersFor(projects, compatibility, sessions = []) {
  const blockers = [];
  if (compatibility !== "compatible") blockers.push({ code: compatibility });
  for (const project of projects) {
    const projectSessions = sessions.filter((s) => s.workspace && pathKey(s.workspace) === pathKey(project.workspace_root));
    for (const db of project.databases) {
      if (db.needs_migration) {
        blockers.push({ code: "migration_required", project: project.config_root, database_path: db.path, schema_version: db.schema_version });
        if (projectSessions.length) blockers.push({ code: "active_sessions_during_migration", project: project.config_root, database_path: db.path, pids: projectSessions.map((s) => s.pid) });
      }
      if (db.newer_schema) blockers.push({ code: "newer_database_schema", project: project.config_root, database_path: db.path, schema_version: db.schema_version });
      if (db.has_active_work) blockers.push({ code: "active_work", project: project.config_root, database_path: db.path,
        active_tasks: db.active_tasks, active_executions: db.active_executions });
      if (db.status !== "available" && db.status !== "absent_or_unreadable") blockers.push({ code: "database_uninspected", project: project.config_root, database_path: db.path, status: db.status });
    }
  }
  return blockers;
}
function npmCi(root) {
  const windows = process.platform === "win32";
  const executable = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "npm";
  const args = windows ? ["/d", "/s", "/c", "npm.cmd ci --ignore-scripts --omit=dev"] : ["ci", "--ignore-scripts", "--omit=dev"];
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 180_000, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`npm ci failed: ${result.error?.message ?? result.stderr?.slice(-800) ?? result.status}`);
}
function toolData(message, name) {
  if (message.error || message.result?.isError || !Array.isArray(message.result?.content)) throw new Error(`MCP smoke ${name} failed`);
  return JSON.parse(message.result.content.find((part) => part.type === "text")?.text ?? "null");
}
/** Mandatory real child-process MCP stdio exchange; injectable only as an entire gate in narrow tests. */
export async function startupSmoke(root, targetVersion) {
  const launcher = join(root, "scripts", "native-bridge-mcp.mjs");
  const help = spawnSync(process.execPath, [launcher, "--help"], { cwd: root, windowsHide: true, timeout: 15_000, encoding: "utf8" });
  if (help.error || help.status !== 0) throw new Error(`staged native MCP --help failed: ${help.error?.message ?? help.stderr?.slice(-500) ?? help.status}`);
  const workspace = join(root, ".update-smoke");
  mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, [launcher, "--caller", "gemini", "--delegation", "allow", "--workspace", workspace,
    "--db", join(workspace, ".bridge", "smoke.db")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map(); let nextId = 1, buffer = "", stderr = "", exited = false;
  const exit = new Promise((done) => { child.once("exit", (code) => { exited = true; for (const reject of pending.values()) reject(new Error(`MCP exited ${code}: ${stderr.slice(-500)}`)); pending.clear(); done(code); });
    child.once("error", (error) => { for (const reject of pending.values()) reject(error); pending.clear(); done(null); }); });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { child.kill(); return; }
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(null, message); pending.delete(message.id); } } catch {}
    }
  });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const timer = setTimeout(() => child.kill(), 25_000);
  function request(method, params) {
    const id = nextId++;
    return new Promise((done, fail) => {
      pending.set(id, (error, result) => error ? fail(error) : done(result));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  try {
    const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-update-smoke", version: "1.0.0" } });
    if (initialized.error) throw new Error("MCP initialize failed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const info = toolData(await request("tools/call", { name: "bridge_server_info", arguments: {} }), "bridge_server_info");
    const doctor = toolData(await request("tools/call", { name: "bridge_doctor", arguments: {} }), "bridge_doctor");
    if (info.caller !== "gemini" || doctor.identity?.capture?.server_version !== targetVersion) throw new Error("MCP smoke identity/version mismatch");
    child.stdin.end();
    const code = await exit;
    if (code !== 0) throw new Error(`MCP smoke exit ${code}: ${stderr.slice(-500)}`);
    return { passed: true, caller: info.caller, server_version: doctor.identity.capture.server_version };
  } finally {
    clearTimeout(timer);
    if (!exited) { child.kill(); await exit; }
    rmSync(workspace, { recursive: true, force: true });
  }
}
function isGitCheckout(root) { return existsSync(join(root, ".git")); }
function backupDatabases(projects, targetVersion) {
  const backups = [];
  for (const project of projects) for (const db of project.databases.filter((item) => item.needs_migration)) {
    if (!existsSync(db.path)) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${db.path}${suffix}`;
      if (!existsSync(source)) continue;
      const backup = `${source}.before-bridge-${targetVersion}-${process.pid}`;
      cpSync(source, backup, { errorOnExist: true, force: false });
      backups.push({ source, backup });
    }
  }
  return backups;
}
function activate(staging, current, oldVersion) {
  const previous = existsSync(current) ? join(dirname(current), `.previous-${oldVersion ?? "unknown"}-${process.pid}`) : null;
  if (previous && existsSync(previous)) throw new Error("previous-install backup path already exists");
  if (previous) renameSync(current, previous);
  try { renameSync(staging, current); }
  catch (error) { if (previous) renameSync(previous, current); throw error; }
  return previous;
}

export async function runBridgeUpdate(input = {}) {
  const options = { ...input };
  const registryDir = resolve(options.registryDir ?? process.env.BRIDGE_REGISTRY_DIR ?? join(homedir(), ".bridge"));
  const central = centralInstallation(options, registryDir);
  const releases = await getReleases(options);
  const release = selectRelease(releases, options);
  const report = { status: "no_release", current: central, candidate: null, compatibility: null, projects: [], sessions: [], blockers: [], applied: false,
    staging_smoke: null, previous_installation: null, database_backups: [] };
  if (!release) return report;
  const candidateVersion = release.tag_name.replace(/^v/u, "");
  report.candidate = { tag: release.tag_name, version: candidateVersion };
  const comparison = central.version ? compareVersions(candidateVersion, central.version) : 1;
  report.status = comparison === 0 ? "up_to_date" : comparison < 0 && !options.allowDowngrade ? "downgrade_refused" : "upgrade_available";
  if (report.status === "downgrade_refused") return report;
  const assets = await fetchReleaseAssets(release, options);
  const currentSchema = options.currentSchemaVersion ?? supportedSchemaVersion(central.root);
  const currentProtocol = options.currentProtocolVersion ?? protocolVersion(central.root);
  report.candidate = { ...report.candidate, database_schema_version: assets.manifest.database_schema_version, protocol_version: assets.manifest.protocol_version,
    node_requirement: assets.manifest.node_requirement };
  report.compatibility = assessCompatibility(assets.manifest, { currentSchemaVersion: currentSchema, currentProtocolVersion: currentProtocol,
    nodeVersion: options.nodeVersion });
  const entries = projectEntries(registryDir, options.scanRoots, central.root);
  report.projects = await inventoryProjects(entries, assets.manifest.database_schema_version, options.inspectDatabase ?? inspectDatabaseCopy);
  report.sessions = processInventory(await (options.listProcesses ?? defaultListProcesses)(), central.root, candidateVersion);
  report.blockers = blockersFor(report.projects, report.compatibility, report.sessions);
  if (report.status === "up_to_date") return report;
  const auto = options.autoCompatible === true;
  const shouldApply = options.apply === true || auto && report.blockers.length === 0;
  if (!shouldApply) { if (auto && report.blockers.length) report.status = "check_only_blocked"; return report; }
  const hard = report.blockers.filter((item) => item.code === "breaking_or_incompatible" || item.code === "newer_database_schema" || item.code === "database_uninspected" ||
    item.code === "migration_required" && !options.allowMigration && !auto ||
    (item.code === "active_work" || item.code === "active_sessions_during_migration") && !options.allowActive && !auto);
  if (hard.length || auto && report.blockers.length) { report.status = "check_only_blocked"; return report; }
  if (isGitCheckout(central.root)) { report.status = "check_only_blocked"; report.blockers.push({ code: "git_checkout", path: central.root }); return report; }
  if (options.skipNpmCi && (!options.installDependencies || !options.prelinkedNodeModules)) throw new Error("--skip-npm-ci requires injected pre-linked node_modules");
  const parent = dirname(central.root), staging = join(parent, `.staging-${candidateVersion}-${process.pid}`);
  if (existsSync(staging)) throw new Error("staging path already exists");
  mkdirSync(staging, { recursive: true });
  try {
    const zipBytes = await downloadVerifiedZip(release, assets, options);
    extractVerifiedZip(zipBytes, assets.manifest, staging);
    if (options.skipNpmCi) {
      await options.installDependencies(staging);
      if (!existsSync(join(staging, "node_modules"))) throw new Error("pre-linked node_modules missing");
    } else await (options.installDependencies ?? npmCi)(staging);
    report.staging_smoke = await (options.startupSmoke ?? startupSmoke)(staging, candidateVersion);
    if (!report.staging_smoke?.passed) throw new Error("staging startup smoke failed");
    if (report.projects.some((project) => project.needs_migration)) report.database_backups = backupDatabases(report.projects, candidateVersion);
    report.previous_installation = activate(staging, central.root, central.version);
    report.status = "applied"; report.applied = true;
    return report;
  } catch (error) { report.status = "activation_failed"; report.error = error.message; return report; }
  finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}

export function formatUpdateReport(report) {
  const lines = [`bridge update: ${report.status}`, `Installation: ${report.current.root} (${report.current.version ?? "absente"})`];
  if (report.candidate) lines.push(`Release: ${report.candidate.tag} — ${report.compatibility ?? "non évaluée"}`);
  for (const project of report.projects) {
    lines.push(`Projet: ${project.config_root}`);
    for (const db of project.databases) lines.push(`  DB ${db.path}: schéma ${db.schema_version ?? "?"}${db.needs_migration ? " — migration requise" : ""}${db.has_active_work ? " — travail actif" : ""}`);
  }
  for (const session of report.sessions) if (session.status === "stale_version") lines.push(`Session PID ${session.pid} (${session.caller ?? "?"}, ${session.workspace ?? "?"}) sur ${session.running_version ?? "?"} — rouvrir après mise à jour`);
  for (const blocker of report.blockers) lines.push(`Blocage: ${blocker.code}${blocker.project ? ` — ${blocker.project}` : ""}${blocker.database_path ? ` — ${blocker.database_path}` : ""}`);
  if (report.error) lines.push(`Erreur: ${report.error}`);
  return `${lines.join("\n")}\n`;
}

export function updateExitCode(report, options = {}) {
  if (report.status === "activation_failed") return 1;
  if (report.status === "check_only_blocked" && options.apply) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseUpdateArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(UPDATE_HELP);
  else runBridgeUpdate(options).then((report) => { process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatUpdateReport(report));
    process.exitCode = updateExitCode(report, options);
  }).catch((error) => { process.stderr.write(`bridge update: ${error.message}\n`); process.exitCode = 1; });
}
