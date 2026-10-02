/**
 * Observer-only support export. Never include task text, handles, artifact paths, event
 * payloads, environment variables, command lines, or raw exceptions in this projection.
 *
 * The startup snapshot is deliberately kept separate from the current files. A new build
 * on disk does not reload modules in a process which was already running.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlPlane } from "@bridge/control-plane";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const FINGERPRINT_DOMAIN = "bridge-runtime-fingerprint-v1";
const PACKAGES = [
  "shared/protocol", "shared/control-plane", "shared/mcp-server-core",
  "claude/claude-side", "codex/codex-side",
] as const;
const STATES = new Set(["PENDING", "CLAIMED", "WORKING", "VERIFYING", "BLOCKED", "DONE", "FAILED", "CANCELLED"]);
const OBSERVATIONS = new Set(["PENDING", "COMPLETE", "INCOMPLETE", "REJECTED", "LEGACY_UNKNOWN"]);
// Never pass through arbitrary prerelease/build strings which could hide credentials.
const SEMVER = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-(?:alpha|beta|rc|dev)\.\d{1,8})?(?:\+[a-f0-9]{7,40})?$/u;
const SERVER_NAMES = new Set(["bridge-coordination", "bridge-native-project", "bridge-codex-side", "bridge-claude-side"]);
const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface TreeFingerprint {
  readonly algorithm: "sha256";
  readonly domain: typeof FINGERPRINT_DOMAIN;
  readonly sha256: string | null;
  readonly file_count: number;
  readonly bytes: number;
  readonly missing_roots: number;
  readonly empty_roots: number;
  readonly unreadable_entries: number;
  readonly skipped_symlinks: number;
  readonly complete: boolean;
}

export interface DiskIdentity {
  readonly package_version: string | null;
  readonly source: TreeFingerprint;
  readonly distribution: TreeFingerprint;
  readonly entrypoint_sha256: string | null;
}

export interface BridgeIdentityOptions {
  /** Installation root, which may differ from the managed workspace. Never exported. */
  readonly repositoryRoot?: string;
  /** Actual launcher supplied by the embedding process. Never export its path. */
  readonly entrypointPath?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export interface BridgeProcessIdentity {
  readonly captured_at: number;
  readonly pid: number;
  readonly node_version: string;
  readonly server_name: string | null;
  readonly server_version: string | null;
  readonly evidence: "startup_disk_snapshot";
  readonly disk_at_start: DiskIdentity;
}

const installationLocations = new WeakMap<BridgeProcessIdentity, { root: string; entrypoint: string | null }>();

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= 96 && SEMVER.test(value) ? value : null;
}

function sha256File(path: string | null): string | null {
  if (!path) return null;
  try {
    if (!lstatSync(path).isFile()) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch { return null; }
}

function packageVersion(root: string): string | null {
  try { return safeVersion((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>)["version"]); }
  catch { return null; }
}

/** Hash only bridge module trees; skip symlinks rather than following an arbitrary path. */
function fingerprint(root: string, kind: "src" | "dist"): TreeFingerprint {
  const files: Array<{ relative: string; absolute: string }> = [];
  let missing = 0, empty = 0, unreadable = 0, symlinks = 0, bytes = 0;
  const visit = (relative: string) => {
    const absolute = join(root, ...relative.split("/"));
    try {
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) { symlinks++; return; }
      if (info.isDirectory()) {
        for (const name of readdirSync(absolute)) visit(`${relative}/${name}`);
      } else if (info.isFile() && (kind === "src"
        ? relative.endsWith(".ts") && !relative.endsWith(".test.ts")
        : relative.endsWith(".js"))) files.push({ relative, absolute });
    } catch { unreadable++; }
  };
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
      const content = readFileSync(file.absolute);
      const pathBytes = Buffer.from(file.relative);
      const header = Buffer.alloc(12);
      header.writeUInt32BE(pathBytes.length, 0);
      header.writeBigUInt64BE(BigInt(content.length), 4);
      hash.update(header.subarray(0, 4)).update(pathBytes).update(header.subarray(4)).update(content);
      bytes += content.length;
      count++;
    } catch { unreadable++; }
  }
  return Object.freeze({
    algorithm: "sha256", domain: FINGERPRINT_DOMAIN, sha256: count > 0 ? hash.digest("hex") : null,
    file_count: count, bytes, missing_roots: missing, empty_roots: empty, unreadable_entries: unreadable,
    skipped_symlinks: symlinks, complete: missing === 0 && empty === 0 && unreadable === 0 && symlinks === 0 && count > 0,
  });
}

function diskIdentity(root: string, entrypoint: string | null): DiskIdentity {
  return Object.freeze({
    package_version: packageVersion(root), source: fingerprint(root, "src"),
    distribution: fingerprint(root, "dist"), entrypoint_sha256: sha256File(entrypoint),
  });
}

/** Call exactly once at server startup and retain the result for that process lifetime. */
export function captureBridgeIdentity(options: BridgeIdentityOptions = {}): BridgeProcessIdentity {
  const root = resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const suppliedEntrypoint = options.entrypointPath ?? process.argv[1];
  let entrypoint = suppliedEntrypoint ? resolve(suppliedEntrypoint) : null;
  if (entrypoint) { try { entrypoint = realpathSync(entrypoint); } catch {} }
  const identity: BridgeProcessIdentity = Object.freeze({
    captured_at: Date.now(), pid: process.pid, node_version: process.versions.node,
    server_name: options.serverName && SERVER_NAMES.has(options.serverName) ? options.serverName : null,
    server_version: safeVersion(options.serverVersion), evidence: "startup_disk_snapshot",
    disk_at_start: diskIdentity(root, entrypoint),
  });
  installationLocations.set(identity, { root, entrypoint });
  return identity;
}

type Comparison = "same" | "changed" | "unknown";
function compareHash(old: string | null, current: string | null, complete = true): Comparison {
  if (!old || !current || !complete) return "unknown";
  return old === current ? "same" : "changed";
}

function knownBucket(value: string, known: ReadonlySet<string>): string {
  return known.has(value) ? value : "OTHER";
}
function increment(counts: Record<string, number>, bucket: string): void {
  counts[bucket] = (counts[bucket] ?? 0) + 1;
}

export interface BridgeDiagnosticOptions {
  readonly identity?: BridgeProcessIdentity;
  /** Used only if no startup capture is available. */
  readonly repositoryRoot?: string;
  readonly caller?: string;
  readonly delegationPolicy?: "allow" | "deny";
  /** Actual store schema version, if exposed by its backend. Never infer it from source. */
  readonly databaseSchemaVersion?: number;
}

/** No health() calls: some adapter probes start subprocesses or consult authentication. */
export function bridgeDiagnostics(cp: ControlPlane, options: BridgeDiagnosticOptions = {}) {
  const location = options.identity ? installationLocations.get(options.identity) : undefined;
  // A deserialized or fabricated snapshot is not evidence about this loaded process.
  const identity = location && options.identity?.pid === process.pid ? options.identity : null;
  const root = location?.root ?? resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const current = diskIdentity(root, location ? location.entrypoint : join(root, "scripts", "native-bridge-mcp.mjs"));
  const changes = {
    source: identity ? compareHash(identity.disk_at_start.source.sha256, current.source.sha256,
      identity.disk_at_start.source.complete && current.source.complete) : "unknown" as Comparison,
    distribution: identity ? compareHash(identity.disk_at_start.distribution.sha256, current.distribution.sha256,
      identity.disk_at_start.distribution.complete && current.distribution.complete) : "unknown" as Comparison,
    entrypoint: identity ? compareHash(identity.disk_at_start.entrypoint_sha256, current.entrypoint_sha256) : "unknown" as Comparison,
    package_version: identity ? compareHash(identity.disk_at_start.package_version, current.package_version) : "unknown" as Comparison,
  };
  let database: { access: "existing_control_plane"; status: "available" | "unavailable";
    schema_version: number | null; task_count: number | null; tasks_by_state: Record<string, number>;
    leases_by_state: Record<string, number>; executions_by_phase: Record<string, number>;
    observations_by_status: Record<string, number>; last_event_id: number | null };
  try {
    const tasks = cp.store.listTasks();
    const tasksByState: Record<string, number> = {};
    for (const task of tasks) increment(tasksByState, knownBucket(task.state, STATES));
    const leasesByState: Record<string, number> = {};
    for (const lease of cp.store.listHeldLeases()) increment(leasesByState,
      lease.state === "HELD" || lease.state === "QUARANTINED" ? lease.state : "OTHER");
    const executions: Record<string, number> = {};
    for (const execution of cp.store.listExecutions()) increment(executions,
      ["QUEUED", "RUNNING", "STOPPED", "QUARANTINED"].includes(execution.phase) ? execution.phase : "OTHER");
    const observations: Record<string, number> = {};
    for (const observation of cp.store.listObservations()) increment(observations, knownBucket(observation.status, OBSERVATIONS));
    database = { access: "existing_control_plane", status: "available",
      schema_version: Number.isSafeInteger(options.databaseSchemaVersion) && options.databaseSchemaVersion! >= 0
        ? options.databaseSchemaVersion! : null,
      task_count: tasks.length, tasks_by_state: tasksByState, leases_by_state: leasesByState,
      executions_by_phase: executions, observations_by_status: observations, last_event_id: cp.store.lastEventId() };
  } catch {
    database = { access: "existing_control_plane", status: "unavailable", schema_version: null,
      task_count: null, tasks_by_state: {}, leases_by_state: {}, executions_by_phase: {},
      observations_by_status: {}, last_event_id: null };
  }
  const adapters = cp.adapters.list().map((adapter) => ({
    agent: ["codex", "claude", "bridge"].includes(adapter.info.agent) ? adapter.info.agent : "OTHER",
    version: safeVersion(adapter.info.version),
    max_concurrency: Number.isInteger(adapter.info.max_concurrency) && adapter.info.max_concurrency > 0
      ? adapter.info.max_concurrency : null,
    evidence: "registration_only" as const,
  }));
  const knownChanges = Object.values(changes).some((state) => state === "changed");
  const runtimeKnown = changes.distribution !== "unknown" && changes.entrypoint !== "unknown" && changes.package_version !== "unknown";
  return {
    diagnostic_schema_version: DIAGNOSTIC_SCHEMA_VERSION, mode: "live" as const, observed_at: Date.now(),
    process: { pid: process.pid, node_version: process.versions.node, platform: process.platform },
    caller: options.caller && ["codex", "claude", "bridge"].includes(options.caller) ? options.caller : "OTHER",
    delegation: options.delegationPolicy === "allow" || options.delegationPolicy === "deny" ? options.delegationPolicy : "unknown",
    identity: { capture: identity, current_disk: current, changed_since_start: changes,
      restart_required: knownChanges ? true : runtimeKnown ? false : null },
    database, registered_adapters: adapters,
    probes: { model_invoked: false, authentication_checked: false, adapter_health_checked: false,
      runtime_worker_versions_checked: false, loaded_modules_rehashed: false },
    limits: [
      "Startup hashes describe disk files at capture, not the exact bytes evaluated by every module loader.",
      "Matching hashes do not certify behavior, native client attachment, authentication, or worker readiness.",
      "Source and distribution have different encodings; their hashes cannot be compared for build freshness.",
      "Live aggregates are independent reads and may represent different instants during concurrent changes.",
      "Aggregates omit prompts, task identifiers, handles, paths, event payloads, command lines, and environment values.",
    ],
  };
}
