#!/usr/bin/env node

/**
 * Passive support export. It works without a compiled bridge and never opens the original
 * database through the application store (which would migrate it). SQLite may write SHM
 * bookkeeping even for read-only WAL readers, so all SQL runs against a disposable copy.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");
const PACKAGES = ["shared/protocol", "shared/control-plane", "shared/mcp-server-core", "claude/claude-side", "codex/codex-side"];
const FINGERPRINT_DOMAIN = "bridge-runtime-fingerprint-v1";
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const STATES = new Set(["PENDING", "CLAIMED", "WORKING", "VERIFYING", "BLOCKED", "DONE", "FAILED", "CANCELLED"]);
const OBSERVATIONS = new Set(["PENDING", "COMPLETE", "INCOMPLETE", "REJECTED", "LEGACY_UNKNOWN"]);
const SEMVER = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-(?:alpha|beta|rc|dev)\.\d{1,8})?(?:\+[a-f0-9]{7,40})?$/u;

export const DOCTOR_HELP = `bridge-doctor — observer-only, redacted JSON diagnostic

  --repository   bridge installation root (default: this script's repository)
  --workspace    managed project root (default: current working directory)
  --db           database path, relative to workspace (default: .bridge/bridge.db)
  --help         show this help; no probes or database access

No model invocation, authentication probe, migration, repair, cancellation, or network call.
Only a stable disposable copy of the database is opened read-only. JSON contains aggregate
counts and code fingerprints, never task text, handles, paths, environment, or raw errors.
The offline command cannot identify an already-running native MCP process. Call bridge_doctor
in that process to compare its retained startup capture with its current installation files.
`;

export function parseDoctorArgs(argv, cwd = process.cwd()) {
  let repository = defaultRepositoryRoot, workspace = cwd, database, help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { help = true; continue; }
    if (!["--repository", "--workspace", "--db"].includes(flag)) throw new Error("INVALID_ARGUMENT");
    if (seen.has(flag)) throw new Error("INVALID_ARGUMENT");
    seen.add(flag);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("INVALID_ARGUMENT");
    if (flag === "--repository") repository = resolve(cwd, value);
    if (flag === "--workspace") workspace = resolve(cwd, value);
    if (flag === "--db") database = value;
  }
  return { repositoryRoot: resolve(repository), workspaceRoot: resolve(workspace),
    databasePath: resolve(workspace, database ?? ".bridge/bridge.db"), help };
}

function digest(content) { return createHash("sha256").update(content).digest("hex"); }
function fileDigest(path) {
  try { return lstatSync(path).isFile() ? digest(readFileSync(path)) : null; }
  catch { return null; }
}
function packageVersion(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return typeof value === "string" && value.length <= 96 && SEMVER.test(value) ? value : null;
  } catch { return null; }
}

function fingerprint(root, kind) {
  const files = [];
  let missing = 0, empty = 0, unreadable = 0, symlinks = 0, bytes = 0;
  function visit(relative) {
    const absolute = join(root, ...relative.split("/"));
    try {
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) { symlinks++; return; }
      if (info.isDirectory()) for (const name of readdirSync(absolute)) visit(`${relative}/${name}`);
      else if (info.isFile() && (kind === "src" ? relative.endsWith(".ts") && !relative.endsWith(".test.ts") : relative.endsWith(".js"))) files.push({ relative, absolute });
    } catch { unreadable++; }
  }
  for (const pkg of PACKAGES) {
    const relative = `${pkg}/${kind}`;
    try { lstatSync(join(root, ...relative.split("/"))); }
    catch { missing++; continue; }
    const before = files.length;
    visit(relative);
    if (files.length === before) empty++;
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  const hash = createHash("sha256").update(`${FINGERPRINT_DOMAIN}\0`);
  let count = 0;
  for (const file of files) {
    try {
      const content = readFileSync(file.absolute), pathBytes = Buffer.from(file.relative), header = Buffer.alloc(12);
      header.writeUInt32BE(pathBytes.length, 0);
      header.writeBigUInt64BE(BigInt(content.length), 4);
      hash.update(header.subarray(0, 4)).update(pathBytes).update(header.subarray(4)).update(content);
      bytes += content.length; count++;
    } catch { unreadable++; }
  }
  return { algorithm: "sha256", domain: FINGERPRINT_DOMAIN, sha256: count > 0 ? hash.digest("hex") : null,
    file_count: count, bytes, missing_roots: missing, empty_roots: empty, unreadable_entries: unreadable,
    skipped_symlinks: symlinks, complete: missing === 0 && empty === 0 && unreadable === 0 && symlinks === 0 && count > 0 };
}

function emptyDatabase(status) {
  return { access: "read_only_disposable_copy", status, schema_version: null, schema_compatibility: "unknown",
    task_count: null, tasks_by_state: {}, leases_by_state: {}, executions_by_phase: {}, observations_by_status: {},
    last_event_id: null, copy_stability: "unconfirmed" };
}

function sourceSchemaVersion(root) {
  try {
    const text = readFileSync(join(root, "shared/control-plane/src/store/sqlite-store.ts"), "utf8");
    const match = /\bconst SCHEMA_VERSION\s*=\s*(\d+)\s*;/u.exec(text);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

function grouped(db, sql, allowed) {
  const counts = {};
  for (const row of db.prepare(sql).all()) {
    const bucket = allowed.has(row.bucket) ? row.bucket : "OTHER";
    counts[bucket] = (counts[bucket] ?? 0) + Number(row.count);
  }
  return counts;
}

function failCopy(status) {
  const error = new Error(status);
  error.doctorStatus = status;
  throw error;
}

/** Bound allocation and reads even if the file grows after the first path-level stat. */
function readLimited(path, remaining) {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) failCopy("not_regular_file");
    if (before.size > remaining) failCopy("copy_size_limit");
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const read = readSync(fd, content, offset, content.length - offset, offset);
      if (read === 0) failCopy("changing_store");
      offset += read;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) failCopy("changing_store");
    return content;
  } finally { closeSync(fd); }
}

function readDatabase(originalPath, supportedVersion) {
  let scratch, db;
  try {
    let originalInfo;
    try { originalInfo = lstatSync(originalPath); } catch { return emptyDatabase("absent_or_unreadable"); }
    if (!originalInfo.isFile()) return emptyDatabase("not_regular_file");
    const paths = [originalPath, `${originalPath}-wal`];
    const contents = [];
    let total = 0;
    for (const path of paths) {
      try {
        const info = lstatSync(path);
        if (!info.isFile()) return emptyDatabase("not_regular_file");
        total += info.size;
        if (total > MAX_DATABASE_BYTES) return emptyDatabase("copy_size_limit");
        contents.push(readLimited(path, MAX_DATABASE_BYTES - total + info.size));
      } catch (error) {
        if (error?.doctorStatus) throw error;
        if (path === originalPath || error?.code !== "ENOENT") return emptyDatabase("absent_or_unreadable");
        contents.push(null);
      }
    }
    // A DELETE-mode rollback journal can cover uncommitted database pages. Refuse to
    // guess at such a snapshot; ask the operator to retry after its writer has settled.
    try { if (lstatSync(`${originalPath}-journal`).size > 0) return emptyDatabase("rollback_journal_present"); }
    catch (error) { if (error?.code !== "ENOENT") return emptyDatabase("absent_or_unreadable"); }
    scratch = mkdtempSync(join(tmpdir(), "bridge-doctor-"));
    const copy = join(scratch, "observer.db");
    writeFileSync(copy, contents[0], { mode: 0o600 });
    if (contents[1] !== null) writeFileSync(`${copy}-wal`, contents[1], { mode: 0o600 });
    // Require unchanged file contents and unchanged WAL presence before trusting the
    // copy. This is a bounded stability check, not a global transaction with the writer.
    for (let index = 0; index < paths.length; index++) {
      let current = null;
      try { current = digest(readLimited(paths[index], MAX_DATABASE_BYTES)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const captured = contents[index] === null ? null : digest(contents[index]);
      if (current !== captured) return emptyDatabase("changing_store");
    }
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    db = new DatabaseSync(copy, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const versionRow = tables.has("schema_meta") ? db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() : null;
    const parsedVersion = Number(versionRow?.value);
    const version = versionRow && Number.isSafeInteger(parsedVersion) && parsedVersion >= 0 ? parsedVersion : null;
    const result = emptyDatabase("available");
    result.copy_stability = "unchanged_on_two_reads";
    result.schema_version = version;
    result.schema_compatibility = version === null || supportedVersion === null ? "unknown"
      : version > supportedVersion ? "newer_than_source" : version < supportedVersion ? "legacy" : "matches_source";
    if (tables.has("tasks")) {
      result.task_count = Number(db.prepare("SELECT COUNT(*) count FROM tasks").get().count);
      result.tasks_by_state = grouped(db, "SELECT state bucket, COUNT(*) count FROM tasks GROUP BY state", STATES);
    }
    if (tables.has("leases")) result.leases_by_state = grouped(db,
      "SELECT state bucket, COUNT(*) count FROM leases WHERE state IN ('HELD', 'QUARANTINED') GROUP BY state",
      new Set(["HELD", "QUARANTINED"]));
    if (tables.has("task_executions")) result.executions_by_phase = grouped(db,
      "SELECT phase bucket, COUNT(*) count FROM task_executions GROUP BY phase",
      new Set(["QUEUED", "RUNNING", "STOPPED", "QUARANTINED"]));
    if (tables.has("attempt_observations")) result.observations_by_status = grouped(db,
      "SELECT CASE WHEN json_valid(json) THEN json_extract(json, '$.status') ELSE 'OTHER' END bucket, COUNT(*) count FROM attempt_observations GROUP BY bucket", OBSERVATIONS);
    if (tables.has("events")) result.last_event_id = Number(db.prepare("SELECT COALESCE(MAX(event_id), 0) value FROM events").get().value);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    const known = ["not_regular_file", "copy_size_limit", "changing_store"];
    return emptyDatabase(known.includes(error?.doctorStatus) ? error.doctorStatus : "unavailable_or_unsupported");
  }
  finally {
    if (db) { try { db.close(); } catch {} }
    if (scratch && dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith("bridge-doctor-")) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    }
  }
}

export function offlineBridgeDiagnostics(options = {}) {
  const root = resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const supportedVersion = sourceSchemaVersion(root);
  return {
    diagnostic_schema_version: 1, mode: "offline", observed_at: Date.now(),
    observer_process: { pid: process.pid, node_version: process.versions.node, platform: process.platform },
    identity: { capture: null, current_disk: { package_version: packageVersion(root), source: fingerprint(root, "src"),
      distribution: fingerprint(root, "dist"), entrypoint_sha256: fileDigest(join(root, "scripts/native-bridge-mcp.mjs")) },
      changed_since_start: { source: "unknown", distribution: "unknown", entrypoint: "unknown", package_version: "unknown" },
      restart_required: null },
    database: readDatabase(resolve(options.databasePath ?? join(workspace, ".bridge", "bridge.db")), supportedVersion),
    source_supported_schema_version: supportedVersion,
    probes: { model_invoked: false, authentication_checked: false, adapter_health_checked: false,
      runtime_worker_versions_checked: false, loaded_modules_rehashed: false, running_mcp_process_checked: false },
    limits: [
      "Offline disk inspection cannot identify the code loaded in a running MCP process.",
      "Source and distribution hashes cannot establish build freshness or runtime correctness.",
      "Database SQL runs on a stable disposable copy; it is not an atomic capture with a concurrent writer.",
      "Copies are bounded to 128 MiB including WAL; absent, changing, larger, or incompatible stores remain unknown.",
      "Only code fingerprints and aggregate counts are exported; original databases are never migrated or opened by SQLite.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    const args = parseDoctorArgs(process.argv.slice(2));
    if (args.help) process.stderr.write(DOCTOR_HELP);
    else process.stdout.write(`${JSON.stringify(offlineBridgeDiagnostics(args), null, 2)}\n`);
  } catch {
    process.stderr.write("bridge-doctor: INVALID_ARGUMENT; run --help\n");
    process.exitCode = 2;
  }
}
