import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCompatibility, compareVersions, defaultDownloadFile, defaultFetchJson, extractVerifiedZip, fetchReleaseAssets, getReleases, selectRelease } from "./github-release.mjs";
import { parseUpdateArgs, runBridgeUpdate, startupSmoke, updateExitCode } from "./update.mjs";

const scratch: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "bridge-update-test-")); scratch.push(path); return path; }
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function crc32(bytes: Buffer) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320); } return (crc ^ 0xffffffff) >>> 0; }
/** Small standards-compliant deflated ZIP writer, independent of the extraction implementation. */
function zip(files: Record<string, Buffer | string>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), plain = Buffer.isBuffer(value) ? value : Buffer.from(value), compressed = deflateRawSync(plain), crc = crc32(plain);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(plain.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(plain.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes); offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function server(version: string, mode: "good" | "bad-help" | "bad-version" = "good") {
  return `import readline from 'node:readline';
if (process.argv.includes('--help')) process.exit(${mode === "bad-help" ? 1 : 0});
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const msg=JSON.parse(line);if(msg.id===undefined)return;
let data=msg.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'test',version:'${version}'}}:
msg.params.name==='bridge_server_info'?{caller:'gemini',delegation:'allow'}:
{identity:{capture:{server_version:'${mode === "bad-version" ? "0.0.0" : version}'}}};
let result=msg.method==='tools/call'?{content:[{type:'text',text:JSON.stringify(data)}]}:data;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');});`;
}
function fixture(opts: { version?: string; schema?: number; mode?: "good" | "bad-help" | "bad-version"; tamper?: string; extra?: Record<string, string> } = {}) {
  const root = temp(), registryDir = join(root, "registry"), install = join(registryDir, "install", "current"), assetsDir = join(root, "assets");
  mkdirSync(install, { recursive: true }); mkdirSync(assetsDir);
  writeFileSync(join(install, "package.json"), JSON.stringify({ version: "0.5.0" }));
  const version = opts.version ?? "0.5.1", tag = `v${version}`;
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "bidirectional-bridge", version, type: "module" }),
    "scripts/native-bridge-mcp.mjs": server(version, opts.mode), ...opts.extra };
  const manifest = { schema_version: 1, version, tag, node_requirement: ">=22.13.0", protocol_version: "1.5.0",
    database_schema_version: opts.schema ?? 6, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])) };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const packed = zip(Object.fromEntries(Object.entries({ ...files, "RELEASE.json": manifestText }).map(([name, content]) =>
    [`bidirectional-bridge-${version}/${name}`, name === opts.tamper ? `${content}tampered` : content])));
  const zipName = `bidirectional-bridge-${version}-compiled.zip`;
  writeFileSync(join(assetsDir, "RELEASE.json"), manifestText); writeFileSync(join(assetsDir, zipName), packed);
  writeFileSync(join(assetsDir, "SHA256SUMS.txt"), `${hash(manifestText)}  RELEASE.json\n${hash(packed)}  ${zipName}\n`);
  const feedFile = join(root, "feed.json"), release = { tag_name: tag, draft: false, prerelease: false, assets: [] };
  writeFileSync(feedFile, JSON.stringify([release]));
  const options = { bridgeHome: install, registryDir, assetsDir, feedFile, currentSchemaVersion: 6, currentProtocolVersion: "1.5.0",
    listProcesses: () => [], skipNpmCi: true, prelinkedNodeModules: true,
    installDependencies: (stage: string) => { mkdirSync(join(stage, "node_modules")); } };
  return { root, install, registryDir, assetsDir, feedFile, release, manifest, packed, options };
}
function database(path: string, schema: number, work: "none" | "task" | "execution" = "none") {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE tasks(state TEXT); CREATE TABLE task_executions(phase TEXT)");
  db.prepare("INSERT INTO schema_meta VALUES('schema_version',?)").run(String(schema));
  if (work === "task") db.exec("INSERT INTO tasks VALUES('WORKING')");
  if (work === "execution") db.exec("INSERT INTO task_executions VALUES('RUNNING')");
  db.close();
}
function registry(f: ReturnType<typeof fixture>, projects: Array<Record<string, unknown>>) {
  writeFileSync(join(f.registryDir, "projects.json"), JSON.stringify({ projects }));
}

describe("bridge update release preflight", () => {
  it("selects the highest stable non-draft release and an exact tag", () => {
    const feed = [{ tag_name: "v0.5.0" }, { tag_name: "v0.7.0", prerelease: true }, { tag_name: "v0.6.0", draft: true }, { tag_name: "v0.5.2" }];
    expect(selectRelease(feed)?.tag_name).toBe("v0.5.2");
    expect(selectRelease(feed, { tag: "v0.5.0" })?.tag_name).toBe("v0.5.0");
    expect(selectRelease(feed, { includePrerelease: true })?.tag_name).toBe("v0.7.0");
  });
  it("compares versions and detects compatible versus schema migration candidates", () => {
    expect(compareVersions("0.5.1", "0.5.0")).toBe(1);
    const f = fixture();
    expect(assessCompatibility(f.manifest, { currentSchemaVersion: 6, currentProtocolVersion: "1.4.0" })).toBe("compatible");
    expect(assessCompatibility(f.manifest, { currentSchemaVersion: 4, currentProtocolVersion: "1.4.0" })).toBe("migration_required");
    expect(assessCompatibility({ ...f.manifest, protocol_version: "2.0.0" }, { currentSchemaVersion: 6, currentProtocolVersion: "1.4.0" })).toBe("breaking_or_incompatible");
  });
  it("reports an up-to-date central version in check mode", async () => {
    const f = fixture({ version: "0.5.0" });
    const report = await runBridgeUpdate(f.options);
    expect(report.status).toBe("up_to_date"); expect(report.applied).toBe(false);
  });
  it("reports a compatible update without changing the installation", async () => {
    const f = fixture();
    const report = await runBridgeUpdate(f.options);
    expect(report.status).toBe("upgrade_available"); expect(report.compatibility).toBe("compatible");
    expect(JSON.parse(readFileSync(join(f.install, "package.json"), "utf8")).version).toBe("0.5.0");
  });
  it("reports a central schema migration before applying", async () => {
    const f = fixture();
    const report = await runBridgeUpdate({ ...f.options, currentSchemaVersion: 4, autoCompatible: true });
    expect(report.compatibility).toBe("migration_required"); expect(report.status).toBe("check_only_blocked");
  });
  it("rejects a SHA256SUMS mismatch before parsing the manifest", async () => {
    const f = fixture();
    writeFileSync(join(f.assetsDir, "SHA256SUMS.txt"), `${"0".repeat(64)}  RELEASE.json\n${hash(f.packed)}  bidirectional-bridge-0.5.1-compiled.zip\n`);
    await expect(fetchReleaseAssets(f.release, f.options)).rejects.toThrow(/SHA-256 mismatch/u);
  });
  it("rejects tampered ZIP contents against RELEASE.json.files", async () => {
    const f = fixture({ tamper: "package.json" });
    const assets = await fetchReleaseAssets(f.release, f.options, true);
    expect(() => extractVerifiedZip(assets.zipBytes, assets.manifest, join(f.root, "stage"))).toThrow(/RELEASE.json.files mismatch/u);
  });
  it("rejects ZIP slip members before writing staging files", async () => {
    const f = fixture();
    const archive = zip({ "bidirectional-bridge-0.5.1/../escape.txt": "bad", "bidirectional-bridge-0.5.1/RELEASE.json": JSON.stringify(f.manifest) });
    expect(() => extractVerifiedZip(archive, f.manifest, join(f.root, "stage"))).toThrow(/unsafe ZIP entry/u);
    expect(existsSync(join(f.root, "escape.txt"))).toBe(false);
  });
  it("inventories schema-4 sibling DB, WORKING tasks and stale native sessions", async () => {
    const f = fixture(), project = join(f.root, "tracassin"), legacy = join(project, ".bridge", "bridge.db"), current = join(project, ".bridge", "release-0.4.0.db");
    database(legacy, 4, "task"); database(current, 6);
    registry(f, [{ config_root: project, workspace_root: project, database_path: current, clients: ["claude"], bridge_root: f.install }]);
    const old = join(f.root, "old"); mkdirSync(old); writeFileSync(join(old, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const report = await runBridgeUpdate({ ...f.options, listProcesses: () => [{ pid: 35272, commandLine: `node ${join(old, "scripts", "native-bridge-mcp.mjs")} --caller claude --workspace ${project} --db ${legacy}` }] });
    expect(report.projects[0].databases).toHaveLength(2);
    expect(report.projects[0].databases.find((db: any) => db.schema_version === 4)?.needs_migration).toBe(true);
    expect(report.projects[0].has_active_work).toBe(true);
    expect(report.sessions[0]).toMatchObject({ pid: 35272, running_version: "0.4.0", status: "stale_version" });
  });
  it("passes a real stdio initialize, server_info and doctor startup smoke", async () => {
    const root = temp(); mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts", "native-bridge-mcp.mjs"), server("0.5.1"));
    expect(await startupSmoke(root, "0.5.1")).toMatchObject({ passed: true, caller: "gemini", server_version: "0.5.1" });
  });
  it("auto-applies a verified compatible ZIP after the real startup smoke", async () => {
    const f = fixture(); const report = await runBridgeUpdate({ ...f.options, autoCompatible: true });
    expect(report.status).toBe("applied"); expect(report.staging_smoke).toMatchObject({ passed: true, server_version: "0.5.1" });
    expect(JSON.parse(readFileSync(join(f.install, "package.json"), "utf8")).version).toBe("0.5.1");
    expect(existsSync(report.previous_installation)).toBe(true);
  });
  it("keeps auto-compatible check-only when a connected DB needs migration", async () => {
    const f = fixture(), project = join(f.root, "project"); database(join(project, ".bridge", "bridge.db"), 4);
    registry(f, [{ config_root: project, workspace_root: project, bridge_root: f.install }]);
    const report = await runBridgeUpdate({ ...f.options, autoCompatible: true });
    expect(report.status).toBe("check_only_blocked"); expect(report.blockers.some((b: any) => b.code === "migration_required")).toBe(true);
    expect(JSON.parse(readFileSync(join(f.install, "package.json"), "utf8")).version).toBe("0.5.0");
  });
  it("keeps auto-compatible check-only for a RUNNING execution", async () => {
    const f = fixture(), project = join(f.root, "project"); database(join(project, ".bridge", "bridge.db"), 6, "execution");
    registry(f, [{ config_root: project, workspace_root: project, bridge_root: f.install }]);
    const report = await runBridgeUpdate({ ...f.options, autoCompatible: true });
    expect(report.blockers.some((b: any) => b.code === "active_work" && b.active_executions.RUNNING === 1)).toBe(true);
    expect(report.applied).toBe(false);
  });
  it("leaves the active installation intact when staged MCP help fails", async () => {
    const f = fixture({ mode: "bad-help" }); const report = await runBridgeUpdate({ ...f.options, apply: true });
    expect(report.status).toBe("activation_failed"); expect(report.staging_smoke).toBeNull();
    expect(JSON.parse(readFileSync(join(f.install, "package.json"), "utf8")).version).toBe("0.5.0");
  });
  it("refuses the unsafe npm bypass without an injected pre-linked node_modules", async () => {
    const f = fixture();
    await expect(runBridgeUpdate({ ...f.options, apply: true, prelinkedNodeModules: false })).rejects.toThrow(/pre-linked node_modules/u);
  });
  it("parses repeatable scan roots and rejects contradictory activation flags", () => {
    const root = temp();
    expect(parseUpdateArgs(["--scan-root", "one", "--scan-root", "two", "--auto-compatible"], root).scanRoots).toEqual([join(root, "one"), join(root, "two")]);
    expect(() => parseUpdateArgs(["--apply", "--auto-compatible"], root)).toThrow(/mutually exclusive/u);
  });
  it("sends GitHub JSON Accept header, follows allowed 302 asset redirects stripping Authorization, and rejects untrusted redirect hosts", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch = async (url: string, init: any) => {
      seen.push({ url, headers: init.headers });
      if (url.startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify([{ tag_name: "v0.5.1" }]), { status: 200, headers: { "content-length": "23" } });
      }
      if (url.startsWith("https://github.com/")) {
        return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset.zip" } });
      }
      return new Response(Buffer.from("payload"), { status: 200 });
    };
    const json = await defaultFetchJson("https://api.github.com/repos/grizzly2005/bidirectional-bridge-claude-codex/releases", { fetchImpl: mockFetch, githubToken: "secret-tok" });
    expect(json).toEqual([{ tag_name: "v0.5.1" }]);
    expect(seen[0].headers.Accept).toBe("application/vnd.github+json");
    expect(seen[0].headers.Authorization).toBe("Bearer secret-tok");

    const bytes = await defaultDownloadFile("https://github.com/grizzly2005/bidirectional-bridge-claude-codex/releases/download/v0.5.1/a.zip", "a.zip", { fetchImpl: mockFetch, githubToken: "secret-tok" });
    expect(bytes.toString()).toBe("payload");
    expect(seen[1].headers.Authorization).toBe("Bearer secret-tok");
    expect(seen[2].url).toBe("https://release-assets.githubusercontent.com/asset.zip");
    expect(seen[2].headers.Authorization).toBeUndefined();

    const evilRedirect = async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/a.zip" } });
    await expect(defaultDownloadFile("https://github.com/grizzly2005/bidirectional-bridge-claude-codex/releases/download/v0.5.1/a.zip", "a.zip", { fetchImpl: evilRedirect })).rejects.toThrow(/allowed HTTPS host/u);
  });
  it("returns exit code 1 when --auto-compatible fails activation and blocks unreadable existing DBs", async () => {
    const failed = fixture({ mode: "bad-help" });
    const report = await runBridgeUpdate({ ...failed.options, autoCompatible: true });
    expect(report.status).toBe("activation_failed");
    expect(updateExitCode(report, { autoCompatible: true })).toBe(1);

    const unreadable = fixture(), project = join(unreadable.root, "proj"), dbPath = join(project, ".bridge", "bridge.db");
    mkdirSync(join(project, ".bridge"), { recursive: true });
    writeFileSync(dbPath, "corrupt-bytes");
    registry(unreadable, [{ config_root: project, workspace_root: project, database_path: dbPath, bridge_root: unreadable.install }]);
    const blocked = await runBridgeUpdate({ ...unreadable.options, inspectDatabase: () => ({ status: "absent_or_unreadable", schema_version: null }), autoCompatible: true });
    expect(blocked.status).toBe("check_only_blocked");
    expect(blocked.blockers.some((b: any) => b.code === "database_uninspected")).toBe(true);
  });
});
