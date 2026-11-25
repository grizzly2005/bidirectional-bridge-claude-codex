import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore -- plain ESM modules without type declarations
import { canonicalPath, parseLauncherArgs, readClientConfig, readTomlTable, upsertTomlTable } from "./client-configs.mjs";
// @ts-ignore -- plain ESM modules without type declarations
import { discoverCentralInstallation, discoverProjectsOnDisk, readProjectRegistry, registerConnectedProject, resolveRegistryDir } from "./registry.mjs";
// @ts-ignore -- plain ESM modules without type declarations
import { formatSetupReport, parseSetupArgs, runBridgeSetup } from "./setup.mjs";
// @ts-ignore -- plain ESM modules without type declarations
import { formatDoctorReport, parseBridgeProcess, parseDoctorCliArgs, runBridgeDoctor } from "./doctor.mjs";
// @ts-ignore -- plain ESM modules without type declarations
import { antigravityServerEntry, mergeConfig, parseInstallArgs } from "../install-antigravity.mjs";
// @ts-ignore -- plain ESM modules without type declarations
import { inspectDatabaseCopy } from "../bridge-doctor.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const temporary: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const UNC = "\\\\wsl.localhost\\Ubuntu\\home\\kali\\tracassin-labs\\app";

beforeEach(() => {
  for (const key of ["BRIDGE_HOME", "BRIDGE_REGISTRY_DIR"]) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tmp(prefix = "bridge-cli-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return canonicalPath(directory);
}

function makeInstall(version = "0.5.0", { built = true, skills = false } = {}): string {
  const root = tmp("bridge-install-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bidirectional-bridge", version }));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "native-bridge-mcp.mjs"), "// launcher fixture\n");
  mkdirSync(join(root, "shared", "control-plane", "src", "store"), { recursive: true });
  writeFileSync(join(root, "shared", "control-plane", "src", "store", "sqlite-store.ts"), "const SCHEMA_VERSION = 6;\n");
  if (built) {
    mkdirSync(join(root, "shared", "mcp-server-core", "dist"), { recursive: true });
    writeFileSync(join(root, "shared", "mcp-server-core", "dist", "index.js"), "export {};\n");
  }
  if (skills) {
    mkdirSync(join(root, "skills", "using-bridge", "references"), { recursive: true });
    writeFileSync(join(root, "skills", "using-bridge", "SKILL.md"), "---\nname: using-bridge\n---\n");
    writeFileSync(join(root, "skills", "using-bridge", "references", "notes.md"), "notes\n");
  }
  return root;
}

function makeDb(path: string, version: number, wal = false): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tasks(state TEXT)");
  db.prepare("INSERT INTO schema_meta VALUES('schema_version', ?)").run(String(version));
  db.prepare("INSERT INTO tasks VALUES('DONE')").run();
  if (!wal) db.close();
  else (makeDb as any).open = db;
}

function context(central: string, registryDir = tmp("bridge-registry-")) {
  return { bridgeHome: central, registryDir, npmGlobalRoot: null, currentRepoRoot: null, nodePath: process.execPath };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function launcherOf(root: string): string { return join(root, "scripts", "native-bridge-mcp.mjs"); }

function snapshot(project: string): Record<string, { text: string; mtime: number }> {
  const out: Record<string, { text: string; mtime: number }> = {};
  for (const file of [".mcp.json", ".codex/config.toml", ".agents/mcp_config.json"]) {
    const path = join(project, file);
    if (existsSync(path)) out[file] = { text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
  }
  return out;
}

describe("registry: central installation discovery", () => {
  it("resolves the registry directory from options, then BRIDGE_REGISTRY_DIR", () => {
    const dir = tmp();
    expect(resolveRegistryDir({ registryDir: dir })).toBe(dir);
    process.env.BRIDGE_REGISTRY_DIR = dir;
    expect(resolveRegistryDir({})).toBe(dir);
  });

  it("honours bridgeHome > registry record > npm global link > current repository > bootstrap target", () => {
    const home = makeInstall("0.5.0"), recorded = makeInstall("0.4.9"), linked = makeInstall("0.4.8"), current = makeInstall("0.4.7");
    const registryDir = tmp("bridge-registry-");
    const npmRoot = tmp("bridge-npm-");
    symlinkSync(linked, join(npmRoot, "bidirectional-bridge"), process.platform === "win32" ? "junction" : "dir");
    const base = { registryDir, npmGlobalRoot: () => npmRoot, currentRepoRoot: current };
    expect(discoverCentralInstallation(base)).toMatchObject({ found: true, source: "npm_global", root: linked, version: "0.4.8" });
    writeJson(join(registryDir, "central-install.json"), { root: recorded, updated_at: "2026-11-01T00:00:00.000Z" });
    expect(discoverCentralInstallation(base)).toMatchObject({ source: "registry", root: recorded, built: true });
    expect(discoverCentralInstallation({ ...base, bridgeHome: home })).toMatchObject({ source: "bridge_home", root: home, version: "0.5.0" });
    process.env.BRIDGE_HOME = home;
    expect(discoverCentralInstallation(base)).toMatchObject({ source: "env_BRIDGE_HOME", root: home });
    delete process.env.BRIDGE_HOME;
    expect(discoverCentralInstallation({ registryDir: tmp(), npmGlobalRoot: null, currentRepoRoot: current })).toMatchObject({ source: "current_repository", root: current });
    const empty = discoverCentralInstallation({ registryDir, npmGlobalRoot: null, currentRepoRoot: null, bridgeHome: tmp() });
    expect(empty).toMatchObject({ source: "registry" });
    const none = discoverCentralInstallation({ registryDir: tmp(), npmGlobalRoot: null, currentRepoRoot: null });
    expect(none.found).toBe(false);
    expect(none.targetRoot).toBe(join(none.registryDir, "install", "current"));
  });

  it("deduplicates connected projects and discovers pre-existing client configs on disk", () => {
    const central = makeInstall(), registryDir = tmp("bridge-registry-"), parent = tmp("bridge-projects-");
    const alpha = join(parent, "alpha"), beta = join(parent, "beta"), plain = join(parent, "plain");
    for (const dir of [alpha, beta, plain]) mkdirSync(dir);
    writeJson(join(alpha, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", alpha] } } });
    writeJson(join(beta, ".agents", "mcp_config.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "gemini", "--delegation", "allow", "--workspace", UNC, "--db", ".bridge/release-0.4.0.db"] } } });
    const found = discoverProjectsOnDisk([parent], { registryDir });
    expect(found.map((item: any) => item.config_root).sort()).toEqual([canonicalPath(alpha), canonicalPath(beta)].sort());
    expect(found.find((item: any) => item.config_root === canonicalPath(beta))).toMatchObject({ workspace_root: UNC, clients: ["gemini"], bridge_root: central });
    registerConnectedProject({ config_root: alpha, workspace_root: alpha, clients: ["codex"] }, { registryDir });
    const registry = readProjectRegistry({ registryDir });
    expect(registry.projects).toHaveLength(2);
    expect(registry.projects.find((item: any) => item.config_root === canonicalPath(alpha)).clients).toEqual(["claude", "codex"]);
    if (process.platform !== "win32") expect(statSync(join(registryDir, "projects.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(registryDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("client configs", () => {
  it("parses multi-line TOML args and replaces one table surgically", () => {
    const text = [
      "# user comment", 'model = "gpt-5"', "", "[mcp_servers.other]", 'command = "other"', "",
      "[mcp_servers.bridge]", "# keep me", 'command = "node"', "args = [", '  "/old/scripts/native-bridge-mcp.mjs",', '  "--caller", "claude", # wrong',
      '  "--workspace", "/w",', "]", 'env_vars = ["CUSTOM"]', "", "[profiles.fast]", 'model = "mini"', "",
    ].join("\n");
    const table = readTomlTable(text, "mcp_servers.bridge");
    expect(parseLauncherArgs(table.args)).toMatchObject({ launcher: "/old/scripts/native-bridge-mcp.mjs", caller: "claude", workspace: "/w" });
    const next = upsertTomlTable(text, "mcp_servers.bridge", { command: "node", args: ["/new/scripts/native-bridge-mcp.mjs", "--caller", "codex"], enabled: true });
    expect(next).toContain("# user comment\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n");
    expect(next).toContain("# keep me");
    expect(next).toContain('env_vars = ["CUSTOM"]');
    expect(readTomlTable(next, "profiles.fast")).toEqual({ model: "mini" });
    expect(readTomlTable(next, "mcp_servers.bridge")).toMatchObject({ args: ["/new/scripts/native-bridge-mcp.mjs", "--caller", "codex"], enabled: true, env_vars: ["CUSTOM"] });
    expect(next.match(/\[mcp_servers\.bridge\]/gu)).toHaveLength(1);
  });

  it("keeps install-antigravity exports compatible and adds the long timeout with eager tools", () => {
    const workspace = tmp();
    const args = parseInstallArgs(["--workspace", workspace, "--gemini-auth", "api-key"], workspace);
    const entry = antigravityServerEntry(args);
    expect(entry).toMatchObject({ args: expect.arrayContaining(["--caller", "gemini", "--gemini-auth", "api-key"]), disabled: false, timeoutSeconds: 2400,
      tools: { bridge_server_info: { eager: true }, bridge_resume_project: { eager: true } } });
    expect(() => mergeConfig(JSON.stringify({ mcpServers: { bridge: {} } }), "bridge", entry, false)).toThrow(/--force/u);
    expect(mergeConfig("", "bridge", entry, false).mcpServers.bridge.timeoutSeconds).toBe(2400);
  });
});

describe("bridge setup", () => {
  it("wires all three clients, registers the project, then is a byte-identical no-op", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    const first = await runBridgeSetup({ ...ctx, project });
    expect(first.status).toBe("updated");
    expect(first.clients.map((item: any) => item.action)).toEqual(["created", "created", "created"]);
    for (const client of ["claude", "codex", "gemini"]) {
      const config = readClientConfig(client, project);
      expect(config.effective).toMatchObject({ caller: client, launcherPath: launcherOf(central), workspacePath: project });
    }
    const codex = readTomlTable(readFileSync(join(project, ".codex", "config.toml"), "utf8"), "mcp_servers.bridge");
    expect(codex).toMatchObject({ enabled: true, required: true, startup_timeout_sec: 30, tool_timeout_sec: 2400, cwd: project });
    const gemini = JSON.parse(readFileSync(join(project, ".agents", "mcp_config.json"), "utf8")).mcpServers.bridge;
    expect(gemini).toMatchObject({ disabled: false, timeoutSeconds: 2400, tools: { bridge_server_info: { eager: true }, bridge_resume_project: { eager: true } } });
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers.bridge).toMatchObject({ type: "stdio", env: {} });
    expect(readProjectRegistry(ctx).projects).toEqual([expect.objectContaining({ config_root: project, clients: ["claude", "codex", "gemini"], bridge_root: central })]);

    const before = snapshot(project);
    const second = await runBridgeSetup({ ...ctx, project });
    expect(second.status).toBe("ready");
    expect(second.clients.every((item: any) => item.action === "unchanged")).toBe(true);
    expect(formatSetupReport(second)).toContain("Projet déjà prêt — aucune modification requise");
    expect(snapshot(project)).toEqual(before);
    expect(existsSync(join(project, ".mcp.json.bak"))).toBe(false);
  });

  it("fixes a Codex entry declared as Claude while preserving workspace, DB, comments and other tables", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), external = tmp("bridge-external-"), ctx = context(central);
    const original = [
      "# Codex project settings", 'model = "gpt-5"', "", "[mcp_servers.other]", 'command = "other-server"', "",
      "[mcp_servers.bridge]", "# managed by bridge", 'command = "node"', "args = [",
      `  ${JSON.stringify("C:/old/bridge/scripts/native-bridge-mcp.mjs")},`, '  "--caller", "claude",', '  "--delegation", "allow",',
      `  "--workspace", ${JSON.stringify(external)},`, '  "--db", ".bridge/release-0.4.0.db",', "]", `cwd = ${JSON.stringify(project)}`,
      "tool_timeout_sec = 1800", 'env_vars = ["CUSTOM"]', "", "[profiles.fast]", 'model = "gpt-5-mini"', "",
    ].join("\n");
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), original);
    const report = await runBridgeSetup({ ...ctx, project });
    expect(report.status).toBe("updated");
    expect(report.clients).toEqual([expect.objectContaining({ client: "codex", action: "updated" })]);
    const text = readFileSync(join(project, ".codex", "config.toml"), "utf8");
    const parsed = readClientConfig("codex", project);
    expect(parsed.effective).toMatchObject({ caller: "codex", launcherPath: launcherOf(central), workspacePath: external, db: ".bridge/release-0.4.0.db" });
    expect(parsed.entry).toMatchObject({ command: "node", enabled: true, required: true, tool_timeout_sec: 2400, env_vars: ["CUSTOM"] });
    for (const kept of ["# Codex project settings", "[mcp_servers.other]", "# managed by bridge", "[profiles.fast]"]) expect(text).toContain(kept);
    expect(readFileSync(join(project, ".codex", "config.toml.bak"), "utf8")).toBe(original);
    expect(readdirSync(join(project, ".codex")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("propagates a WSL UNC workspace, custom DB and Linux Codex executable to newly added clients", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    writeJson(join(project, ".agents", "mcp_config.json"), { mcpServers: {
      keep: { command: "x" },
      bridge: { command: "node", cwd: project, args: [launcherOf(central), "--caller", "gemini", "--delegation", "allow", "--workspace", UNC,
        "--db", ".bridge/release-0.4.0.db", "--codex-wsl-executable", "/usr/local/bin/codex", "--gemini-auth", "api-key"] } } });
    const report = await runBridgeSetup({ ...ctx, project, clients: ["claude", "codex", "gemini"] });
    expect(report.status).toBe("updated");
    expect(report.project).toMatchObject({ workspace_root: UNC, database: ".bridge/release-0.4.0.db", codex_wsl_executable: "/usr/local/bin/codex" });
    for (const client of ["claude", "codex"]) {
      expect(readClientConfig(client, project).effective).toMatchObject({ caller: client, workspace: UNC, db: ".bridge/release-0.4.0.db", codexWslExecutable: "/usr/local/bin/codex", geminiAuth: undefined });
    }
    const gemini = JSON.parse(readFileSync(join(project, ".agents", "mcp_config.json"), "utf8"));
    expect(gemini.mcpServers.keep).toEqual({ command: "x" });
    expect(gemini.mcpServers.bridge.args).toContain("--gemini-auth");
  });

  it("refuses diverging explicit databases without --force, then aligns on the custom one", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    const entry = (caller: string, db: string) => ({ command: "node", args: [launcherOf(central), "--caller", caller, "--delegation", "allow", "--workspace", project, "--db", db] });
    writeJson(join(project, ".mcp.json"), { mcpServers: { bridge: entry("claude", ".bridge/release-0.4.0.db") } });
    writeJson(join(project, ".agents", "mcp_config.json"), { mcpServers: { bridge: { ...entry("gemini", ".bridge/bridge.db"), cwd: project } } });
    const before = snapshot(project);
    const refused = await runBridgeSetup({ ...ctx, project });
    expect(refused.status).toBe("conflict");
    expect(refused.message).toBe(`Bases SQLite divergentes entre clients (Claude : .bridge/release-0.4.0.db, Gemini : .bridge/bridge.db). Correction : bridge setup --project "${project}" --db ".bridge/release-0.4.0.db" --force`);
    expect(snapshot(project)).toEqual(before);
    const forced = await runBridgeSetup({ ...ctx, project, force: true });
    expect(forced.status).toBe("updated");
    expect(readClientConfig("gemini", project).effective.db).toBe(".bridge/release-0.4.0.db");
    expect(forced.warnings.join("\n")).toContain("alignées sur .bridge/release-0.4.0.db");
  });

  it("rejects a Windows /mnt interop Codex path and does not write in dry-run", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    const bad = await runBridgeSetup({ ...ctx, project, workspace: UNC, codexWslExecutable: "/mnt/c/Users/me/AppData/Roaming/npm/codex" });
    expect(bad.status).toBe("error");
    expect(bad.message).toContain("pas un chemin Windows /mnt/");
    const dry = await runBridgeSetup({ ...ctx, project, dryRun: true });
    expect(dry.status).toBe("dry_run");
    expect(dry.clients.map((item: any) => item.action)).toEqual(["would_create", "would_create", "would_create"]);
    expect(snapshot(project)).toEqual({});
    expect(readProjectRegistry(ctx).projects).toEqual([]);
    expect(parseSetupArgs(["--clients", "antigravity,codex", "--dry-run"], project)).toMatchObject({ clients: ["codex", "gemini"], dryRun: true, project });
    expect(() => parseSetupArgs(["--clients", "cursor"], project)).toThrow(/unknown client/u);
  });

  it("bootstraps a verified release into the registry when no central installation exists", async () => {
    const release = makeInstall("0.5.0"), project = tmp("bridge-project-"), registryDir = tmp("bridge-registry-");
    writeFileSync(join(release, "RELEASE.json"), JSON.stringify({ version: "0.5.0" }));
    const sum = (file: string) => createHash("sha256").update(readFileSync(join(release, file))).digest("hex");
    writeFileSync(join(release, "SHA256SUMS.txt"), `${sum("package.json")}  package.json\n${sum("scripts/native-bridge-mcp.mjs")}  scripts/native-bridge-mcp.mjs\n`);
    const base = { project, registryDir, npmGlobalRoot: null, currentRepoRoot: null, nodePath: process.execPath };
    const missing = await runBridgeSetup(base);
    expect(missing.status).toBe("error");
    expect(missing.message).toContain("--bootstrap-archive");
    const report = await runBridgeSetup({ ...base, bootstrapArchive: release });
    expect(report.status).toBe("updated");
    const target = join(registryDir, "install", "current");
    expect(report.central).toMatchObject({ source: "bootstrap", version: "0.5.0", built: true });
    expect(canonicalPath(report.central.root)).toBe(canonicalPath(target));
    expect(discoverCentralInstallation({ registryDir, npmGlobalRoot: null, currentRepoRoot: null })).toMatchObject({ source: "registry" });
    expect(readClientConfig("claude", project).effective.launcherPath).toBe(launcherOf(canonicalPath(target)));

    const tampered = makeInstall("0.5.0");
    writeFileSync(join(tampered, "SHA256SUMS.txt"), `${"0".repeat(64)}  package.json\n`);
    const refused = await runBridgeSetup({ ...base, registryDir: tmp(), bootstrapArchive: tampered });
    expect(refused.status).toBe("error");
    expect(refused.message).toContain("empreinte SHA-256 invalide");
  });

  it("syncs the using-bridge skill for the selected clients idempotently", async () => {
    const central = makeInstall("0.5.0", { skills: true }), project = tmp("bridge-project-"), ctx = context(central);
    const first = await runBridgeSetup({ ...ctx, project, clients: ["claude", "gemini"], syncSkills: true });
    expect(first.skills.map((item: any) => [item.client, item.files_written])).toEqual([["claude", 2], ["gemini", 2]]);
    expect(readFileSync(join(project, ".agents", "skills", "using-bridge", "references", "notes.md"), "utf8")).toBe("notes\n");
    expect(existsSync(join(project, ".codex"))).toBe(false);
    const second = await runBridgeSetup({ ...ctx, project, syncSkills: true });
    expect(second.status).toBe("ready");
    expect(second.skills.every((item: any) => item.files_written === 0)).toBe(true);
  });
});

describe("bridge doctor", () => {
  const noProbes = { listProcesses: () => [] };

  async function readyProject() {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    await runBridgeSetup({ ...ctx, project });
    makeDb(join(project, ".bridge", "bridge.db"), 6);
    return { central, project, ctx };
  }

  it("reports each ready client with version, caller and effective schema", async () => {
    const { project, ctx } = await readyProject();
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project });
    expect(report.status).toBe("ok");
    expect(report.ready).toEqual([
      "Claude prêt (v0.5.0, caller=claude, db=.bridge/bridge.db [schéma 6])",
      "Codex prêt (v0.5.0, caller=codex, db=.bridge/bridge.db [schéma 6])",
      "Gemini prêt (v0.5.0, caller=gemini, db=.bridge/bridge.db [schéma 6])",
    ]);
    expect(formatDoctorReport(report)).toContain("[OK] Gemini prêt (v0.5.0, caller=gemini, db=.bridge/bridge.db [schéma 6])");
    expect(parseDoctorCliArgs(["--project", project, "--clients", "codex", "--no-wsl-probe"], project)).toMatchObject({ project, clients: ["codex"], wslProbe: false });
  });

  it("catches Codex declared as Claude with the exact setup correction", async () => {
    const { project, ctx } = await readyProject();
    const path = join(project, ".codex", "config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace('"--caller", "codex"', '"--caller", "claude"'));
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project });
    expect(report.status).toBe("error");
    const text = formatDoctorReport(report);
    expect(text).toContain(`[ERREUR] Codex mal configuré : déclaré avec --caller claude au lieu de codex\n  Correction : bridge setup --project "${project}" --clients codex --force`);
    expect(report.ready.map((line: string) => line.split(" ")[0])).toEqual(["Claude", "Gemini"]);
  });

  it("flags a running session still loaded from the previous version, ignoring unrelated processes", async () => {
    const { project, ctx } = await readyProject();
    const old = makeInstall("0.4.0"), elsewhere = tmp("bridge-elsewhere-");
    const listProcesses = () => [
      { pid: 4242, commandLine: `"${process.execPath}" "${launcherOf(old)}" --caller claude --delegation allow --workspace "${project}"` },
      { pid: 5151, commandLine: `node ${launcherOf(old)} --caller codex --delegation allow --workspace ${elsewhere}` },
      { pid: 6161, commandLine: "node server.js --token secret-value" },
    ];
    const report = await runBridgeDoctor({ ...ctx, project, listProcesses });
    expect(report.processes).toEqual([{ pid: 4242, caller: "claude", version: "0.4.0", launcher_root: old, stale: true }]);
    expect(formatDoctorReport(report)).toContain("[ERREUR] Claude utilise encore la version précédente (0.4.0 en mémoire, PID 4242, centrale 0.5.0), rouvrir la session\n  Correction : recharger le serveur MCP ou rouvrir la session Claude sur ce projet");
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(parseBridgeProcess({ pid: 1, commandLine: "node server.js" })).toBeNull();
  });

  it("detects a WSL UNC workspace without --codex-wsl-executable and a Windows /mnt path", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    writeJson(join(project, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", UNC, "--db", ".bridge/release-0.4.0.db"] } } });
    const absentDb = () => ({ status: "absent_or_unreadable", schema_version: null });
    const execCommand = () => { throw new Error("must not probe WSL without an executable"); };
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project, inspectDatabase: absentDb, execCommand });
    const text = formatDoctorReport(report);
    expect(text).toContain(`[ERREUR] Codex WSL non raccordé : workspace UNC (Ubuntu) sans --codex-wsl-executable\n  Correction : bridge setup --project "${project}" --codex-wsl-executable /usr/local/bin/codex --force`);
    expect(text).toContain(`[INFO] Claude : workspace WSL externe (Ubuntu) ${UNC} servi depuis le dossier hôte ${project}`);
    writeJson(join(project, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", UNC, "--codex-wsl-executable", "/mnt/c/Users/me/codex"] } } });
    const interop = await runBridgeDoctor({ ...ctx, ...noProbes, project, inspectDatabase: absentDb, execCommand });
    expect(interop.findings.map((item: any) => item.code)).toContain("wsl_codex_windows_path");
  });

  it("reports an installed but logged-out Linux Codex with the exact login command", async () => {
    const central = makeInstall(), project = tmp("bridge-project-"), ctx = context(central);
    writeJson(join(project, ".agents", "mcp_config.json"), { mcpServers: { bridge: { command: "node", cwd: project, timeoutSeconds: 2400,
      args: [launcherOf(central), "--caller", "gemini", "--delegation", "allow", "--workspace", UNC, "--codex-wsl-executable", "/usr/local/bin/codex"] } } });
    const calls: string[][] = [];
    const execCommand = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return args.includes("test") ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "Not logged in\n", stderr: "" };
    };
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project, execCommand, inspectDatabase: () => ({ status: "absent_or_unreadable", schema_version: null }) });
    expect(calls).toEqual([
      ["wsl.exe", "--distribution", "Ubuntu", "--exec", "test", "-x", "/usr/local/bin/codex"],
      ["wsl.exe", "--distribution", "Ubuntu", "--exec", "/usr/local/bin/codex", "login", "status"],
    ]);
    expect(report.wsl).toEqual({ distribution: "Ubuntu", executable: "/usr/local/bin/codex", installed: true, logged_in: false });
    expect(formatDoctorReport(report)).toContain("[ERREUR] Codex Ubuntu installé, connexion requise\n  Correction : wsl.exe --distribution Ubuntu -- /usr/local/bin/codex login");
    const missing = await runBridgeDoctor({ ...ctx, ...noProbes, project, execCommand: () => ({ status: 1, stdout: "", stderr: "" }), inspectDatabase: () => ({ status: "absent_or_unreadable", schema_version: null }) });
    expect(missing.findings.map((item: any) => item.code)).toContain("wsl_codex_missing");
  });

  it("explains a cross-client database split and an unmigrated legacy schema", async () => {
    const { central, project, ctx } = await readyProject();
    makeDb(join(project, ".bridge", "release-0.4.0.db"), 6);
    rmSync(join(project, ".bridge", "bridge.db"));
    makeDb(join(project, ".bridge", "bridge.db"), 4);
    writeJson(join(project, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", project, "--db", ".bridge/release-0.4.0.db"] } } });
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project, clients: ["claude", "gemini"] });
    const text = formatDoctorReport(report);
    expect(text).toContain("[ERREUR] Bases SQLite divergentes entre clients (Claude : .bridge/release-0.4.0.db [schéma 6], Gemini : .bridge/bridge.db [schéma 4])");
    expect(text).toContain(`Correction : bridge setup --project "${project}" --db ".bridge/release-0.4.0.db" --force`);
    expect(text).toContain("[ATTENTION] Base SQLite en schéma 4 (migration vers schéma 6 à l'ouverture) : .bridge/bridge.db");
    expect(report.ready).toEqual([]);
  });

  it("warns about a short Antigravity timeout and a workspace pointing at another connected project", async () => {
    const { central, project, ctx } = await readyProject();
    const other = tmp("bridge-other-");
    writeJson(join(other, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", other] } } });
    const path = join(project, ".agents", "mcp_config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.mcpServers.bridge.timeoutSeconds = 60;
    writeJson(path, config);
    writeJson(join(project, ".mcp.json"), { mcpServers: { bridge: { command: "node", args: [launcherOf(central), "--caller", "claude", "--delegation", "allow", "--workspace", other] } } });
    const report = await runBridgeDoctor({ ...ctx, ...noProbes, project });
    const text = formatDoctorReport(report);
    expect(text).toContain(`[ATTENTION] Gemini : timeoutSeconds 60 < 600 dans .agents/mcp_config.json (délégations longues interrompues)\n  Correction : bridge setup --project "${project}" --clients gemini --force`);
    expect(text).toContain(`[ATTENTION] Claude : --workspace pointe vers un autre projet connecté (${other}) au lieu de ${project}`);
    expect(report.findings.map((item: any) => item.code)).toContain("workspace_divergence");
  });

  it("reads an uncheckpointed WAL through a disposable copy without touching the original", () => {
    const dir = tmp("bridge-wal-"), path = join(dir, "live.db");
    makeDb(path, 6, true);
    const handle = (makeDb as any).open;
    try {
      expect(existsSync(`${path}-wal`)).toBe(true);
      const hashes = () => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
      const before = hashes();
      const result = inspectDatabaseCopy(path, 6);
      expect(result).toMatchObject({ status: "available", schema_version: 6, schema_compatibility: "matches_source", task_count: 1 });
      expect(hashes()).toEqual(before);
    } finally { handle.close(); }
  });
});
