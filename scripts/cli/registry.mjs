/**
 * Central installation discovery and the per-user registry of connected projects.
 *
 * Registry directory: options.registryDir ?? $BRIDGE_REGISTRY_DIR ?? ~/.bridge
 *   central-install.json  { root, updated_at }
 *   projects.json         { schema_version: 1, projects: [ ... ] }   (atomic, 0o600)
 *   install/current       default bootstrap target when nothing is installed yet
 *
 * Pure Node ESM. Tests always pass an isolated `registryDir`; nothing here touches the
 * network, and `npm root -g` is only run when no injected resolver is given.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, DEFAULT_SERVER_NAME, LAUNCHER_RELATIVE, canonicalPath, clientConfigPath, pathKey,
  preservedProjectSettings, readProjectConfigs, writeFileAtomic } from "./client-configs.mjs";

export const PACKAGE_NAME = "bidirectional-bridge";
const moduleRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveRegistryDir(options = {}) {
  return resolve(options.registryDir ?? process.env.BRIDGE_REGISTRY_DIR ?? join(homedir(), ".bridge"));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Validate an installation root without executing anything from it. */
export function inspectInstallation(root) {
  if (typeof root !== "string" || root === "") return { root: null, valid: false, built: false, version: null, launcher: null, missing: ["root"] };
  const absolute = canonicalPath(root);
  const manifest = readJson(join(absolute, "package.json"));
  const launcher = join(absolute, ...LAUNCHER_RELATIVE.split("/"));
  const missing = [];
  if (!manifest) missing.push("package.json");
  if (!existsSync(launcher)) missing.push(LAUNCHER_RELATIVE);
  const built = existsSync(join(absolute, "shared", "mcp-server-core", "dist", "index.js"));
  const version = typeof manifest?.version === "string" ? manifest.version : null;
  return { root: absolute, valid: missing.length === 0, built, version, name: manifest?.name ?? null, launcher, missing };
}

function defaultNpmGlobalRoot() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"],
    { encoding: "utf8", timeout: 5000, windowsHide: true, shell: process.platform === "win32" });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim() || null;
}

function resolveNpmGlobalRoot(option) {
  if (option === null || option === false) return null;
  if (typeof option === "string") return option;
  try { return typeof option === "function" ? option() : defaultNpmGlobalRoot(); } catch { return null; }
}

export function readCentralInstallRecord(options = {}) {
  const record = readJson(join(resolveRegistryDir(options), "central-install.json"));
  return record && typeof record.root === "string" ? record : null;
}

export function recordCentralInstallation(root, options = {}) {
  const record = { root: canonicalPath(root), updated_at: new Date(options.now?.() ?? Date.now()).toISOString() };
  const path = join(resolveRegistryDir(options), "central-install.json");
  const previous = readJson(path);
  if (previous?.root && pathKey(previous.root) === pathKey(record.root)) return { ...previous, changed: false };
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, changed: true };
}

/**
 * Locate the central installation, in priority order:
 *   1. options.bridgeHome ?? $BRIDGE_HOME
 *   2. <registryDir>/central-install.json
 *   3. global npm link of `bidirectional-bridge` (symlinks/junctions resolved)
 *   4. options.currentRepoRoot (default: the repository containing this module)
 *   5. <registryDir>/install/current when already populated
 * When none is valid, `found` is false and `targetRoot` names the bootstrap destination.
 */
export function discoverCentralInstallation(options = {}) {
  const registryDir = resolveRegistryDir(options);
  const targetRoot = join(registryDir, "install", "current");
  const candidates = [];
  const explicit = options.bridgeHome ?? process.env.BRIDGE_HOME;
  if (explicit) candidates.push({ source: options.bridgeHome ? "bridge_home" : "env_BRIDGE_HOME", root: resolve(explicit) });
  const record = readCentralInstallRecord(options);
  if (record) candidates.push({ source: "registry", root: record.root });
  const npmRoot = resolveNpmGlobalRoot(options.npmGlobalRoot);
  if (npmRoot) {
    const linked = join(npmRoot, PACKAGE_NAME);
    if (existsSync(linked)) {
      let real = linked;
      try { real = realpathSync(linked); } catch {}
      candidates.push({ source: "npm_global", root: real });
    }
  }
  const current = options.currentRepoRoot === undefined ? moduleRepoRoot : options.currentRepoRoot;
  if (current) candidates.push({ source: "current_repository", root: resolve(current) });
  candidates.push({ source: "registry_install", root: targetRoot });

  const inspected = [];
  for (const candidate of candidates) {
    const info = inspectInstallation(candidate.root);
    inspected.push({ source: candidate.source, root: info.root, valid: info.valid, built: info.built, version: info.version });
    if (info.valid) return { found: true, source: candidate.source, ...info, targetRoot, registryDir, candidates: inspected };
  }
  return { found: false, source: null, root: null, valid: false, built: false, version: null, launcher: null,
    targetRoot, registryDir, candidates: inspected };
}

// ---------------------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------------------

function projectsPath(options) { return join(resolveRegistryDir(options), "projects.json"); }

export function readProjectRegistry(options = {}) {
  const document = readJson(projectsPath(options));
  const projects = Array.isArray(document?.projects) ? document.projects.filter((item) => item && typeof item === "object") : [];
  return { schema_version: 1, projects };
}

function projectKey(entry) { return pathKey(entry.workspace_root ?? entry.config_root); }

/** Insert or merge one project record (deduplicated by canonical workspace/config root). */
export function registerConnectedProject(entry, options = {}) {
  if (!entry || (!entry.workspace_root && !entry.config_root)) throw new Error("registerConnectedProject requires workspace_root or config_root");
  const registry = readProjectRegistry(options);
  const normalized = {
    config_root: entry.config_root ? canonicalPath(entry.config_root) : null,
    workspace_root: entry.workspace_root ? canonicalPath(entry.workspace_root) : null,
    database_path: entry.database_path ?? null,
    clients: [...new Set(entry.clients ?? [])].filter((client) => CLIENTS.includes(client)).sort(),
    codex_wsl_executable: entry.codex_wsl_executable ?? null,
    bridge_root: entry.bridge_root ? canonicalPath(entry.bridge_root) : null,
    updated_at: new Date(options.now?.() ?? Date.now()).toISOString(),
  };
  const key = projectKey(normalized);
  const index = registry.projects.findIndex((project) => projectKey(project) === key
    || (normalized.config_root && project.config_root && pathKey(project.config_root) === pathKey(normalized.config_root)));
  let record = normalized;
  if (index >= 0) {
    const previous = registry.projects[index];
    record = { ...previous, ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null)),
      clients: [...new Set([...(previous.clients ?? []), ...normalized.clients])].sort() };
    registry.projects[index] = record;
  } else {
    registry.projects.push(record);
  }
  registry.projects.sort((a, b) => projectKey(a).localeCompare(projectKey(b)));
  writeFileAtomic(projectsPath(options), `${JSON.stringify(registry, null, 2)}\n`);
  return record;
}

function hasAnyClientConfig(directory) {
  return CLIENTS.some((client) => existsSync(clientConfigPath(client, directory)));
}

/**
 * Scan candidate directories (each root and, by default, its direct children) for existing
 * bridge client configurations. Returns project descriptors; registers them unless
 * `options.register === false`.
 */
export function discoverProjectsOnDisk(roots, options = {}) {
  const depth = options.depth ?? 1;
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const seen = new Set();
  const found = [];
  const visit = (directory, level) => {
    let info;
    try { info = statSync(directory); } catch { return; }
    if (!info.isDirectory()) return;
    if (hasAnyClientConfig(directory)) {
      const configs = readProjectConfigs(directory, serverName);
      const clients = CLIENTS.filter((client) => configs[client].configured);
      if (clients.length > 0) {
        const preserved = preservedProjectSettings(configs, canonicalPath(directory));
        const launcher = clients.map((client) => configs[client].effective.launcherPath).find(Boolean);
        const descriptor = { config_root: canonicalPath(directory), workspace_root: preserved.workspace ?? canonicalPath(directory),
          database_path: preserved.dbPath ?? null, clients, codex_wsl_executable: preserved.codexWslExecutable ?? null,
          bridge_root: launcher ? dirname(dirname(launcher)) : null };
        const key = pathKey(descriptor.config_root);
        if (!seen.has(key)) { seen.add(key); found.push(descriptor); }
      }
    }
    if (level >= depth) return;
    let names = [];
    try { names = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const dirent of names) {
      if (!dirent.isDirectory() || dirent.name === "node_modules" || dirent.name.startsWith(".")) continue;
      visit(join(directory, dirent.name), level + 1);
    }
  };
  for (const root of roots ?? []) visit(resolve(root), 0);
  if (options.register !== false) for (const descriptor of found) registerConnectedProject(descriptor, options);
  return found;
}
