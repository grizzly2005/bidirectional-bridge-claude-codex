import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "@bridge/control-plane";
import { seededRandom, type AgentAdapter } from "@bridge/protocol";
import { bridgeDiagnostics, captureBridgeIdentity } from "./diagnostics.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(root, "scripts/bridge-doctor.mjs");
const temporary: string[] = [];
const openPlanes: ControlPlane[] = [];

afterEach(() => {
  for (const cp of openPlanes.splice(0)) cp.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function installation(): string {
  const directory = mkdtempSync(join(tmpdir(), "bridge-doctor-tests-"));
  temporary.push(directory);
  for (const pkg of ["shared/protocol", "shared/control-plane", "shared/mcp-server-core", "claude/claude-side", "codex/codex-side"]) {
    for (const kind of ["src", "dist"]) {
      const subdirectory = join(directory, pkg, kind);
      mkdirSync(subdirectory, { recursive: true });
      writeFileSync(join(subdirectory, kind === "src" ? "index.ts" : "index.js"), `export const checkpoint = ${JSON.stringify(pkg)};\n`);
    }
  }
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts/native-bridge-mcp.mjs"), "export const launcher = 1;\n");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.2.0", token: "secret-manifest-field" }));
  mkdirSync(join(directory, "shared/control-plane/src/store"));
  writeFileSync(join(directory, "shared/control-plane/src/store/sqlite-store.ts"), "const SCHEMA_VERSION = 4;\n");
  return directory;
}

function plane(): ControlPlane {
  const cp = ControlPlane.open({ workspaceRoot: "C:/private/customer-secret-workspace", databasePath: ":memory:", rng: seededRandom(88) });
  openPlanes.push(cp);
  return cp;
}

function runDoctor(repository: string, database: string) {
  const result = spawnSync(process.execPath, [script, "--repository", repository, "--db", database],
    { cwd: repository, encoding: "utf8", windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

function hashes(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).sort().map((file) =>
    [file, createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")]));
}

function legacyDatabase(path: string, version: number, wal = false) {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tasks(state TEXT, spec_json TEXT); CREATE TABLE events(event_id INTEGER, payload_json TEXT); CREATE TABLE leases(state TEXT, scope_json TEXT); ");
  db.prepare("INSERT INTO schema_meta VALUES('schema_version', ?)").run(String(version));
  db.prepare("INSERT INTO tasks VALUES('WORKING', ?)").run(JSON.stringify({ objective: "secret-prompt-text", execution_handle: "private-runtime-handle" }));
  db.prepare("INSERT INTO events VALUES(7, ?)").run(JSON.stringify({ auth: "secret-event-auth", absolutePath: "private-project-location" }));
  db.prepare("INSERT INTO leases VALUES('HELD', ?)").run(JSON.stringify({ paths: ["private-output-path/**"] }));
  return db;
}

describe("live support diagnostics", () => {
  it("keeps the startup identity after dist replacement and requires a process restart", () => {
    const repository = installation(), cp = plane();
    const identity = captureBridgeIdentity({ repositoryRoot: repository, serverName: "bridge-native-project", serverVersion: "0.2.0" });
    const before = bridgeDiagnostics(cp, { identity, caller: "codex", delegationPolicy: "allow" });
    expect(before.identity.restart_required).toBe(false);
    expect(before.identity.changed_since_start.distribution).toBe("same");
    writeFileSync(join(repository, "shared/mcp-server-core/dist/index.js"), "export const checkpoint = 'replaced';\n");
    const after = bridgeDiagnostics(cp, { identity });
    expect(after.identity.capture?.disk_at_start.distribution.sha256).toBe(before.identity.capture?.disk_at_start.distribution.sha256);
    expect(after.identity.current_disk.distribution.sha256).not.toBe(before.identity.current_disk.distribution.sha256);
    expect(after.identity.changed_since_start.distribution).toBe("changed");
    expect(after.identity.restart_required).toBe(true);
    expect(after.process.pid).toBe(process.pid);
    expect(after.probes.loaded_modules_rehashed).toBe(false);
  });

  it("does not mistake current source, a fabricated snapshot, or a missing dist for loaded code", () => {
    const repository = installation(), cp = plane();
    const identity = captureBridgeIdentity({ repositoryRoot: repository });
    const untracked = bridgeDiagnostics(cp, { repositoryRoot: repository });
    expect(untracked.identity.capture).toBeNull();
    expect(untracked.identity.restart_required).toBeNull();
    const fabricated = JSON.parse(JSON.stringify(identity));
    expect(bridgeDiagnostics(cp, { identity: fabricated, repositoryRoot: repository }).identity.capture).toBeNull();
    rmSync(join(repository, "codex/codex-side/dist"), { recursive: true });
    const missing = bridgeDiagnostics(cp, { identity });
    expect(missing.identity.current_disk.distribution.complete).toBe(false);
    expect(missing.identity.changed_since_start.distribution).toBe("unknown");
    expect(missing.identity.restart_required).toBeNull();
  });

  it("exports aggregate state without calling adapter health or copying private fields", () => {
    const repository = installation(), cp = plane();
    const task = cp.tasks.create({ created_by: "codex", spec: {
      objective: "secret-prompt-text", scope: { paths: ["secret-output-path/**"] }, dependencies: [],
      expected_deliverable: "secret-deliverable-text", verification_criteria: ["secret-command-text"],
    } });
    cp.tasks.claim(task.task_id, "codex");
    cp.attempts.start(task.task_id, 0, "codex");
    cp.attempts.saveHandle(task.task_id, 0, "codex", "secret-execution-handle");
    let healthCalls = 0;
    cp.adapters.register({ info: { agent: "private-agent-identity", implementation: "secret-runner-command", version: "secret-runtime-version", capabilities: ["secret-capability"], max_concurrency: 2 },
      async health() { healthCalls++; throw new Error("secret-health-error"); },
      async invoke() { throw new Error("must not invoke"); }, async cancel() { throw new Error("must not cancel"); },
    } as AgentAdapter);
    const lastEventId = cp.lastEventId();
    const diagnostic = bridgeDiagnostics(cp, { identity: captureBridgeIdentity({ repositoryRoot: repository }), caller: "private-agent-identity" });
    expect(healthCalls).toBe(0);
    expect(cp.lastEventId()).toBe(lastEventId);
    expect(diagnostic.database.task_count).toBe(1);
    expect(diagnostic.registered_adapters).toEqual([{ agent: "OTHER", version: null, max_concurrency: 2, evidence: "registration_only" }]);
    const serialized = JSON.stringify(diagnostic);
    for (const value of [task.task_id, "secret-", "private-agent", "customer-secret", repository]) expect(serialized).not.toContain(value);
  });

  it("reports storage failures without leaking exception messages", () => {
    const repository = installation(), cp = plane();
    cp.store.close();
    // Avoid closing this deliberately closed fixture a second time in afterEach.
    openPlanes.splice(openPlanes.indexOf(cp), 1);
    const result = bridgeDiagnostics(cp, { repositoryRoot: repository });
    expect(result.database.status).toBe("unavailable");
    expect(result.database.task_count).toBeNull();
    expect(result.database.last_event_id).toBeNull();
  });

  it("redacts arbitrary server metadata, version suffixes and noncanonical policy values", () => {
    const repository = installation(), cp = plane();
    writeFileSync(join(repository, "package.json"), JSON.stringify({ version: "1.2.3+private-credential" }));
    const identity = captureBridgeIdentity({ repositoryRoot: repository, serverName: "secret-server-field", serverVersion: "1.2.3+private-credential" });
    const result = bridgeDiagnostics(cp, { identity, delegationPolicy: "private-policy-value" as "allow" });
    expect(identity.server_name).toBeNull();
    expect(identity.server_version).toBeNull();
    expect(result.identity.current_disk.package_version).toBeNull();
    expect(result.delegation).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/credential|secret-server|private-policy/u);
  });

  it("skips a linked module tree rather than hashing files outside the installation", () => {
    const repository = installation(), cp = plane();
    const external = mkdtempSync(join(tmpdir(), "bridge-doctor-external-"));
    temporary.push(external);
    writeFileSync(join(external, "secret.ts"), "const secret = 'external private value';");
    symlinkSync(external, join(repository, "shared/protocol/src/external"), process.platform === "win32" ? "junction" : "dir");
    const result = bridgeDiagnostics(cp, { repositoryRoot: repository });
    expect(result.identity.current_disk.source.skipped_symlinks).toBe(1);
    expect(result.identity.current_disk.source.complete).toBe(false);
    expect(result.identity.current_disk.source.file_count).toBe(6);
    expect(JSON.stringify(result)).not.toContain(external);
  });
});

describe("offline doctor", () => {
  it("runs without dist and does not create a missing historical database", () => {
    const repository = installation();
    for (const pkg of ["shared/protocol", "shared/control-plane", "shared/mcp-server-core", "claude/claude-side", "codex/codex-side"]) rmSync(join(repository, pkg, "dist"), { recursive: true });
    const path = join(repository, ".bridge/bridge.db");
    const result = runDoctor(repository, path);
    expect(existsSync(join(repository, ".bridge"))).toBe(false);
    expect(result.database.status).toBe("absent_or_unreadable");
    expect(result.identity.capture).toBeNull();
    expect(result.identity.current_disk.distribution.sha256).toBeNull();
    expect(result.probes.running_mcp_process_checked).toBe(false);
  });

  it.each([1, 3, 99])("reads schema %s without migrating, downgrading, or exposing private rows", (version) => {
    const repository = installation(), dataDirectory = join(repository, "history");
    mkdirSync(dataDirectory);
    const path = join(dataDirectory, "old.db"), db = legacyDatabase(path, version);
    db.close();
    const original = hashes(dataDirectory);
    const result = runDoctor(repository, path);
    expect(result.database).toMatchObject({ access: "read_only_disposable_copy", status: "available", schema_version: version,
      task_count: 1, tasks_by_state: { WORKING: 1 }, last_event_id: 7, copy_stability: "unchanged_on_two_reads" });
    expect(result.database.schema_compatibility).toBe(version === 99 ? "newer_than_source" : "legacy");
    expect(hashes(dataDirectory)).toEqual(original);
    expect(JSON.stringify(result)).not.toMatch(/secret-|private-|old\.db|spec_json|payload_json|execution_handle/u);
  });

  it("includes committed WAL rows while leaving the original database and all sidecars byte-identical", () => {
    const repository = installation(), dataDirectory = join(repository, "wal-history");
    mkdirSync(dataDirectory);
    const path = join(dataDirectory, "active.db"), db = legacyDatabase(path, 4, true);
    try {
      const before = hashes(dataDirectory);
      const result = runDoctor(repository, path);
      expect(result.database.status).toBe("available");
      expect(result.database.task_count).toBe(1);
      expect(result.database.last_event_id).toBe(7);
      expect(hashes(dataDirectory)).toEqual(before);
    } finally { db.close(); }
  });

  it("reports corrupt and mid-transaction stores as unknown without repair", () => {
    const repository = installation(), dataDirectory = join(repository, "corrupt-history");
    mkdirSync(dataDirectory);
    const path = join(dataDirectory, "private-db.db");
    writeFileSync(path, "not sqlite; secret-corrupted-record");
    const before = hashes(dataDirectory);
    const result = runDoctor(repository, path);
    expect(result.database.status).toBe("unavailable_or_unsupported");
    expect(result.database.task_count).toBeNull();
    expect(hashes(dataDirectory)).toEqual(before);
    writeFileSync(`${path}-journal`, "private-active-journal");
    const withJournal = hashes(dataDirectory);
    expect(runDoctor(repository, path).database.status).toBe("rollback_journal_present");
    expect(hashes(dataDirectory)).toEqual(withJournal);
  });

  it("bounds the snapshot size before reading a large historical file into memory", () => {
    const repository = installation(), path = join(repository, "oversize.db");
    writeFileSync(path, "");
    truncateSync(path, 128 * 1024 * 1024 + 1);
    const before = statSync(path);
    expect(runDoctor(repository, path).database.status).toBe("copy_size_limit");
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("uses identical code fingerprint semantics for the live and standalone projections", () => {
    const repository = installation(), cp = plane();
    const live = bridgeDiagnostics(cp, { repositoryRoot: repository });
    const offline = runDoctor(repository, join(repository, "absent.db"));
    expect(offline.identity.current_disk).toEqual(live.identity.current_disk);
  });

  it("rejects invalid CLI arguments without echoing their possible secret values", () => {
    const result = spawnSync(process.execPath, [script, "--unknown-private-value", "secret-cli-value"], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_ARGUMENT");
    expect(result.stderr).not.toContain("secret-cli-value");
    expect(result.stderr).not.toContain("unknown-private-value");
  });
});
