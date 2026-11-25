#!/usr/bin/env node
/**
 * `bridge setup`: one command to (1) find or bootstrap the central bridge installation and
 * (2) wire a project for Claude Code, Codex and Antigravity/Gemini idempotently, preserving
 * custom --workspace (including WSL UNC), --db, --codex-wsl-executable and --gemini-* flags.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, CLIENT_LABELS, DEFAULT_DB_RELATIVE, DEFAULT_SERVER_NAME, applyClientPlan, canonicalPath, displayPath,
  isWslUncPath, parseClientList, pathKey, planClientConfig, preservedProjectSettings, readProjectConfigs,
  resolveAgainst, wslDistribution } from "./client-configs.mjs";
import { discoverCentralInstallation, inspectInstallation, recordCentralInstallation, registerConnectedProject } from "./registry.mjs";
import { extractVerifiedZip, fetchReleaseAssets, getReleases, selectRelease } from "./github-release.mjs";

export const SETUP_HELP = `bridge setup — install or align the bridge MCP server for a project

  --project <dir>                 project configuration root (default: current directory)
  --workspace <path>              bridge workspace (default: preserved --workspace, else --project)
  --clients <csv|all>             claude,codex,gemini (default: already configured clients, else all)
  --db <path>                     SQLite database (default: preserved --db, else .bridge/bridge.db)
  --codex-wsl-executable <path>   absolute Linux Codex path for a WSL UNC workspace
  --gemini-auth <api-key|enterprise>, --gemini-command <path>
  --bridge-home <dir>             central installation to use
  --bootstrap-archive <zip|dir>   first install into <registry>/install/current
  --bootstrap-url <https-url>     same, downloading the release archive first
  --sync-skills                   copy skills/using-bridge into each selected client
  --dry-run  --force  --json  --help

A ready, aligned project is left byte-identical. Changed files keep <file>.bak.
`;

const SKILL_TARGETS = { claude: [".claude", "skills", "using-bridge"], codex: [".codex", "skills", "using-bridge"], gemini: [".agents", "skills", "using-bridge"] };

export function parseSetupArgs(argv, cwd = process.cwd()) {
  const args = { project: resolve(cwd), workspace: undefined, clients: undefined, db: undefined, codexWslExecutable: undefined,
    geminiAuth: undefined, geminiCommand: undefined, bridgeHome: undefined, bootstrapArchive: undefined, bootstrapUrl: undefined,
    autoBootstrap: true, serverName: DEFAULT_SERVER_NAME, syncSkills: false, dryRun: false, force: false, json: false, help: false, cwd: resolve(cwd) };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      if (seen.has(flag)) throw new Error(`${flag} given twice`);
      seen.add(flag);
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--project": args.project = resolve(cwd, value()); break;
      case "--workspace": { const raw = value(); args.workspace = isWslUncPath(raw) ? raw : resolve(cwd, raw); break; }
      case "--clients": args.clients = parseClientList(value()); break;
      case "--db": args.db = value(); break;
      case "--codex-wsl-executable": args.codexWslExecutable = value(); break;
      case "--gemini-auth": args.geminiAuth = value(); break;
      case "--gemini-command": args.geminiCommand = resolve(cwd, value()); break;
      case "--bridge-home": args.bridgeHome = resolve(cwd, value()); break;
      case "--bootstrap-archive": args.bootstrapArchive = resolve(cwd, value()); break;
      case "--bootstrap-url": args.bootstrapUrl = value(); break;
      case "--no-auto-bootstrap": args.autoBootstrap = false; break;
      case "--server-name": args.serverName = value(); break;
      case "--sync-skills": args.syncSkills = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--force": args.force = true; break;
      case "--json": args.json = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(args.serverName)) throw new Error("--server-name must be 1-64 letters, digits, _ or -");
  if (args.geminiAuth !== undefined && !["api-key", "enterprise"].includes(args.geminiAuth)) throw new Error("--gemini-auth must be api-key or enterprise");
  if (args.bootstrapUrl !== undefined && !/^https:\/\//iu.test(args.bootstrapUrl)) throw new Error("--bootstrap-url must be an https URL");
  return args;
}

// ---------------------------------------------------------------------------------------
// Bootstrap of the central installation
// ---------------------------------------------------------------------------------------

function defaultExecCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 600_000,
    cwd: options.cwd, shell: options.shell ?? false });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function findInstallRoot(directory) {
  if (existsSync(join(directory, "package.json"))) return directory;
  const children = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (children.length === 1 && existsSync(join(directory, children[0].name, "package.json"))) return join(directory, children[0].name);
  throw new Error("archive de bootstrap invalide : package.json introuvable");
}

/** Verify SHA256SUMS.txt and RELEASE.json when the release ships them. */
export function verifyReleaseIntegrity(root) {
  const checked = { sums: 0, release: false };
  const sumsPath = join(root, "SHA256SUMS.txt");
  if (existsSync(sumsPath)) {
    for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/u)) {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line.trim());
      if (!match) continue;
      const target = resolve(root, match[2]);
      const rel = relative(root, target);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`SHA256SUMS.txt référence un chemin hors installation : ${match[2]}`);
      if (!existsSync(target)) {
        // Archives are often listed alongside the tree; only installed files must match.
        if (/\.(zip|tgz|tar\.gz)$/iu.test(match[2])) continue;
        throw new Error(`fichier manquant listé dans SHA256SUMS.txt : ${match[2]}`);
      }
      const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
      if (actual.toLowerCase() !== match[1].toLowerCase()) throw new Error(`empreinte SHA-256 invalide : ${match[2]}`);
      checked.sums++;
    }
  }
  const releasePath = join(root, "RELEASE.json");
  if (existsSync(releasePath)) {
    let release;
    try { release = JSON.parse(readFileSync(releasePath, "utf8")); } catch { throw new Error("RELEASE.json illisible"); }
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    if (release?.version !== undefined && release.version !== version) throw new Error(`RELEASE.json (${release.version}) ne correspond pas à package.json (${version})`);
    checked.release = true;
  }
  return checked;
}

async function bootstrapCentralInstallation(options, discovery, exec) {
  const target = discovery.targetRoot;
  const scratch = mkdtempSync(join(tmpdir(), "bridge-bootstrap-"));
  try {
    let source = options.bootstrapArchive;
    if (options.bootstrapUrl) {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      const response = await fetchImpl(options.bootstrapUrl);
      if (!response.ok) throw new Error(`téléchargement impossible (${response.status})`);
      source = join(scratch, "bridge-release.zip");
      writeFileSync(source, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    }
    if (!source || !existsSync(source)) throw new Error("archive de bootstrap introuvable");
    let tree = source;
    if (statSync(source).isFile()) {
      tree = join(scratch, "extracted");
      mkdirSync(tree);
      let result = exec("tar", ["-xf", source, "-C", tree], { timeout: 120_000 });
      if (result.status !== 0 && process.platform !== "win32") result = exec("unzip", ["-q", source, "-d", tree], { timeout: 120_000 });
      if (result.status !== 0) throw new Error("extraction de l'archive impossible (tar/unzip)");
    }
    const root = findInstallRoot(tree);
    const integrity = verifyReleaseIntegrity(root);
    const staging = `${target}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(root, staging, { recursive: true });
    if (existsSync(target)) renameSync(target, `${target}.previous-${Date.now()}`);
    renameSync(staging, target);
    let info = inspectInstallation(target);
    if (!info.valid) throw new Error(`installation amorcée invalide (manquant : ${info.missing.join(", ")})`);
    if (!info.built) {
      const shell = process.platform === "win32";
      for (const step of [["ci"], ["run", "build"]]) {
        const result = exec(shell ? "npm.cmd" : "npm", step, { cwd: target, shell, timeout: 900_000 });
        if (result.status !== 0) throw new Error(`npm ${step.join(" ")} a échoué dans ${target}`);
      }
      info = inspectInstallation(target);
      if (!info.built) throw new Error("dist absent après npm run build");
    }
    return { ...info, integrity };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------

function syncDirectory(source, destination, dryRun) {
  let written = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) { written += syncDirectory(from, to, dryRun); continue; }
    if (!entry.isFile()) continue;
    const content = readFileSync(from);
    if (existsSync(to) && readFileSync(to).equals(content)) continue;
    written++;
    if (!dryRun) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, content); }
  }
  return written;
}

// ---------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------

function preferredConflictValue(conflict, workspace) {
  const defaultDb = pathKey(resolveAgainst(workspace, DEFAULT_DB_RELATIVE));
  return conflict.find((item) => pathKey(item.path) !== defaultDb) ?? conflict[0];
}

export async function runBridgeSetup(input = {}) {
  const options = { serverName: DEFAULT_SERVER_NAME, ...input };
  const exec = options.execCommand ?? defaultExecCommand;
  const configRoot = canonicalPath(options.project ?? process.cwd());
  const report = { command: "setup", status: "ready", dry_run: Boolean(options.dryRun), config_root: configRoot,
    central: null, project: null, clients: [], skills: [], warnings: [], errors: [], message: "" };
  const fail = (status, message) => { report.status = status; report.errors.push(message); report.message = message; return report; };

  // 1. Central installation.
  let central = discoverCentralInstallation(options);
  const canAutoBootstrap = Boolean(options.autoBootstrap || options.feedFile || options.fetchJson);
  if (!central.found || options.bootstrapArchive || options.bootstrapUrl) {
    if (!options.bootstrapArchive && !options.bootstrapUrl && !canAutoBootstrap) {
      return fail("error", `Aucune installation centrale trouvée. Correction : bridge setup --bootstrap-archive <archive.zip> (installe dans ${central.targetRoot}) ou --bridge-home <dossier>`);
    }
    if (options.dryRun) {
      report.warnings.push(`Simulation : l'installation serait amorcée dans ${central.targetRoot}`);
    } else {
      try {
        let installed;
        if (!options.bootstrapArchive && !options.bootstrapUrl && canAutoBootstrap) {
          const releases = await getReleases(options);
          const release = selectRelease(releases, options);
          if (!release) throw new Error("aucune release stable disponible sur GitHub");
          const assets = await fetchReleaseAssets(release, options, true);
          const staging = `${central.targetRoot}.staging-${process.pid}`;
          rmSync(staging, { recursive: true, force: true });
          mkdirSync(staging, { recursive: true });
          try {
            extractVerifiedZip(assets.zipBytes, assets.manifest, staging);
            if (!options.skipNpmCi) {
              const shell = process.platform === "win32";
              const ci = exec(shell ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--omit=dev"], { cwd: staging, shell, timeout: 600_000 });
              if (ci.status !== 0) throw new Error(`npm ci a échoué dans ${staging}`);
            } else if (options.installDependencies) {
              await options.installDependencies(staging);
            }
            mkdirSync(dirname(central.targetRoot), { recursive: true });
            if (existsSync(central.targetRoot)) renameSync(central.targetRoot, `${central.targetRoot}.previous-${Date.now()}`);
            renameSync(staging, central.targetRoot);
          } finally {
            if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
          }
          const info = inspectInstallation(central.targetRoot);
          if (!info.valid || !info.built) throw new Error(`installation amorcée invalide (${central.targetRoot})`);
          installed = { ...info, integrity: { sums: 2, release: true } };
        } else {
          installed = await bootstrapCentralInstallation(options, central, exec);
        }
        recordCentralInstallation(installed.root, options);
        central = { ...installed, found: true, source: "bootstrap", targetRoot: central.targetRoot };
      } catch (error) {
        return fail("error", `Amorçage de l'installation centrale impossible : ${error.message}`);
      }
    }
  }
  report.central = central.found ? { root: central.root, version: central.version, built: central.built, source: central.source, launcher: central.launcher } : null;
  if (!central.found) return report;
  if (!central.built) {
    return fail("error", `Installation centrale non construite (${central.root}). Correction : cd "${central.root}" && npm ci && npm run build`);
  }

  // 2. Project inspection and preserved settings.
  const configs = readProjectConfigs(configRoot, options.serverName);
  const configured = CLIENTS.filter((client) => configs[client].configured);
  const clients = options.clients ?? (configured.length > 0 ? configured : [...CLIENTS]);
  const preserved = preservedProjectSettings(configs, configRoot);

  let workspace = options.workspace ?? preserved.workspace ?? configRoot;
  if (!options.workspace && preserved.workspaceConflict) {
    const list = preserved.workspaceConflict.map((item) => `${CLIENT_LABELS[item.client]} : ${item.path}`).join(", ");
    if (!options.force) return fail("conflict", `Workspaces divergents entre clients (${list}). Correction : bridge setup --project "${configRoot}" --workspace <chemin> --force`);
    report.warnings.push(`Workspaces divergents (${list}) alignés sur ${workspace}`);
  }
  workspace = isWslUncPath(workspace) ? workspace : canonicalPath(workspace);

  let db = options.db ?? preserved.db;
  if (!options.db && preserved.dbConflict) {
    const list = preserved.dbConflict.map((item) => `${CLIENT_LABELS[item.client]} : ${item.raw}`).join(", ");
    const chosen = preferredConflictValue(preserved.dbConflict, workspace);
    if (!options.force) return fail("conflict", `Bases SQLite divergentes entre clients (${list}). Correction : bridge setup --project "${configRoot}" --db "${chosen.raw}" --force`);
    db = chosen.raw;
    report.warnings.push(`Bases SQLite divergentes (${list}) alignées sur ${db}`);
  }
  const dbPath = db === undefined ? undefined : (isAbsolute(db) || isWslUncPath(db) ? db : resolveAgainst(workspace, db));
  if (db !== undefined && !options.db) {
    const implicit = configured.filter((client) => clients.includes(client) && configs[client].effective.db === undefined);
    if (implicit.length > 0) report.warnings.push(`${implicit.map((client) => CLIENT_LABELS[client]).join(", ")} aligné(s) sur la base ${db} (auparavant ${DEFAULT_DB_RELATIVE} par défaut)`);
  }

  const codexWslExecutable = options.codexWslExecutable ?? preserved.codexWslExecutable;
  if (codexWslExecutable !== undefined) {
    if (!codexWslExecutable.startsWith("/") || codexWslExecutable.startsWith("/mnt/")) {
      return fail("error", `--codex-wsl-executable doit être un chemin Linux absolu dans la distribution (pas un chemin Windows /mnt/...) : ${codexWslExecutable}`);
    }
    if (!isWslUncPath(workspace)) return fail("error", "--codex-wsl-executable exige un workspace WSL UNC (\\\\wsl.localhost\\<Distro>\\... ou \\\\wsl$\\<Distro>\\...)");
  } else if (isWslUncPath(workspace)) {
    report.warnings.push(`Workspace WSL UNC (${wslDistribution(workspace)}) sans --codex-wsl-executable : les délégations Codex échoueront. Correction : bridge setup --project "${configRoot}" --codex-wsl-executable /usr/local/bin/codex --force`);
  }
  if (!isWslUncPath(workspace) && !existsSync(workspace)) return fail("error", `Workspace introuvable : ${workspace}`);

  const geminiOverrides = {};
  if (options.geminiAuth !== undefined) geminiOverrides.auth = options.geminiAuth;
  if (options.geminiCommand !== undefined) geminiOverrides.command = options.geminiCommand;
  const settings = { configRoot, workspace, db, dbPath, codexWslExecutable, preservedGemini: preserved.gemini, geminiOverrides,
    launcher: central.launcher, nodePath: options.nodePath ?? process.execPath, force: Boolean(options.force), serverName: options.serverName };
  report.project = { config_root: configRoot, workspace_root: workspace, database: db ?? DEFAULT_DB_RELATIVE,
    database_path: dbPath ?? resolveAgainst(workspace, DEFAULT_DB_RELATIVE), clients, codex_wsl_executable: codexWslExecutable ?? null };

  // 3. Plan every selected client before writing anything.
  const plans = clients.map((client) => planClientConfig(client, configs[client], settings));
  const blocked = plans.filter((plan) => plan.blocked);
  if (blocked.length > 0) {
    for (const plan of blocked) report.clients.push({ client: plan.client, path: plan.path, action: "blocked", reasons: plan.reasons, backup: null });
    return fail("error", `${blocked.map((plan) => `${CLIENT_LABELS[plan.client]} : ${plan.reasons[0]}`).join(" ; ")}. Correction : bridge setup --project "${configRoot}" --clients ${blocked.map((plan) => plan.client).join(",")} --force`);
  }
  for (const plan of plans) {
    let action = plan.changed ? (plan.existed && configs[plan.client].configured ? "updated" : "created") : "unchanged";
    let backup = null;
    if (plan.changed && options.dryRun) action = `would_${action === "updated" ? "update" : "create"}`;
    else if (plan.changed) backup = applyClientPlan(plan).backup;
    report.clients.push({ client: plan.client, path: plan.path, action, reasons: plan.reasons, backup, ...(options.dryRun && plan.changed ? { preview: plan.text } : {}) });
  }

  // 4. Optional skill sync.
  if (options.syncSkills) {
    const source = join(central.root, "skills", "using-bridge");
    if (!existsSync(source)) report.warnings.push(`Skill using-bridge absent de l'installation centrale (${source})`);
    else for (const client of clients) {
      const destination = join(configRoot, ...SKILL_TARGETS[client]);
      report.skills.push({ client, path: destination, files_written: syncDirectory(source, destination, options.dryRun) });
    }
  }

  // 5. Registry.
  const changed = report.clients.some((item) => item.action !== "unchanged") || report.skills.some((item) => item.files_written > 0);
  if (!options.dryRun) {
    recordCentralInstallation(central.root, options);
    registerConnectedProject({ config_root: configRoot, workspace_root: workspace, database_path: report.project.database_path,
      clients: [...new Set([...configured, ...clients])], codex_wsl_executable: codexWslExecutable ?? null, bridge_root: central.root }, options);
  }
  report.status = options.dryRun ? "dry_run" : changed ? "updated" : "ready";
  report.message = options.dryRun ? "Simulation (--dry-run) : aucune écriture"
    : changed ? "Configuration mise à jour — recharger les serveurs MCP (/mcp) ou rouvrir les sessions des clients modifiés"
      : "Projet déjà prêt — aucune modification requise";
  return report;
}

const ACTION_LABELS = { unchanged: "inchangé", updated: "mis à jour", created: "créé", would_update: "serait mis à jour",
  would_create: "serait créé", blocked: "bloqué" };

export function formatSetupReport(report) {
  const lines = [`bridge setup — ${report.config_root}`];
  if (report.central) lines.push(`Installation centrale : ${report.central.root} (v${report.central.version ?? "?"}, source ${report.central.source})`);
  if (report.project) {
    lines.push(`Workspace : ${report.project.workspace_root}`);
    lines.push(`Base SQLite : ${report.project.database}`);
  }
  if (report.message) lines.push(report.message);
  for (const item of report.clients) {
    const file = displayPath(item.path, report.config_root);
    const detail = item.reasons.length > 0 && item.action !== "unchanged" ? ` — ${item.reasons.join(", ")}` : "";
    const backup = item.backup ? ` ; sauvegarde ${displayPath(item.backup, report.config_root)}` : "";
    lines.push(`  ${CLIENT_LABELS[item.client]} : ${ACTION_LABELS[item.action] ?? item.action} (${file}${backup})${detail}`);
  }
  for (const item of report.skills) lines.push(`  Skill ${CLIENT_LABELS[item.client]} : ${item.files_written} fichier(s) synchronisé(s)`);
  for (const warning of report.warnings) lines.push(`Attention : ${warning}`);
  for (const error of report.errors) if (error !== report.message) lines.push(`Erreur : ${error}`);
  return `${lines.join("\n")}\n`;
}

export function setupExitCode(report) { return ["ready", "updated", "dry_run"].includes(report.status) ? 0 : 1; }

async function main() {
  let args;
  try { args = parseSetupArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`bridge setup: ${error.message}; run --help\n`); process.exitCode = 2; return; }
  if (args.help) { process.stdout.write(SETUP_HELP); return; }
  const report = await runBridgeSetup(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatSetupReport(report));
  process.exitCode = setupExitCode(report);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(selfPath)) {
  main().catch((error) => { process.stderr.write(`bridge setup: ${error.message}\n`); process.exitCode = 1; });
}
