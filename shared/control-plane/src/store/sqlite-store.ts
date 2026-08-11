/**
 * SQLite implementation of `StateStore`, on Node's built-in `node:sqlite`.
 *
 * Uses the built-in driver rather than a native addon so the bridge installs with no
 * compiler toolchain — relevant because both agents may bootstrap this repo independently.
 *
 * Journal mode: WAL is requested by default (concurrent readers while a writer commits,
 * which is what makes an external supervisor able to tail state during a run). Some
 * filesystems — network shares, FUSE mounts, certain container bind mounts — cannot
 * provide the shared-memory file WAL needs and fail with SQLITE_IOERR. Rather than
 * refusing to start, `journalMode: "auto"` falls back to DELETE and reports it, so a
 * developer on such a mount still gets a working bridge.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import {
  BridgeError,
  ErrorCode,
  type AgentId,
  type Artifact,
  type ArtifactId,
  type AttemptTelemetry,
  type BridgeEvent,
  type Deliverable,
  type EventType,
  type Lease,
  type LeaseId,
  type StatusUpdate,
  type Task,
  type TaskAttempt,
  type TaskId,
  type TaskState,
  type VerificationResult,
} from "@bridge/protocol";
import type {
  AttemptTelemetryQuery,
  EventAppend,
  EventQuery,
  IdempotencyRecord,
  StateStore,
  TaskQuery,
} from "./state-store.js";
import { assertSupportedNodeVersion } from "../runtime-version.js";

/**
 * `node:sqlite` is a *prefix-only* builtin: it is absent from `module.builtinModules`, so
 * tooling that normalises the `node:` prefix (Vite/Vitest, several bundlers) strips it,
 * then fails to resolve a bare `sqlite` package. Loading it through `createRequire` keeps
 * the specifier opaque to static analysis, so the same source works under Node directly,
 * under Vitest, and inside a bundle. The type-only import above is erased at compile time
 * and costs nothing at runtime.
 */
const nodeRequire = createRequire(import.meta.url);
assertSupportedNodeVersion();
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncCtor };
type DatabaseSync = InstanceType<typeof DatabaseSyncCtor>;

export type JournalMode = "WAL" | "DELETE" | "auto";

export interface SqliteStoreOptions {
  /** File path, or `:memory:` for an ephemeral store. */
  readonly path: string;
  readonly journalMode?: JournalMode;
  /** Called when the requested journal mode could not be applied. */
  readonly onJournalFallback?: (requested: string, actual: string, reason: string) => void;
}

const SCHEMA_VERSION = 3;
/** Bound concurrent native-server startup without failing immediately on schema/WAL locks. */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id      TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  parent_task_id TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  spec_json    TEXT NOT NULL,
  state        TEXT NOT NULL,
  owner        TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  claimed_at   INTEGER,
  completed_at INTEGER,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  version      INTEGER NOT NULL DEFAULT 1,
  attempt      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on);

-- One row per attempt at a task. execution_handle is an opaque resumable pointer
-- (Codex thread id, Claude session id); it is never parsed by the control plane and is
-- length-capped by the protocol so it cannot become a transcript store.
CREATE TABLE IF NOT EXISTS task_attempts (
  task_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL,
  agent            TEXT NOT NULL,
  resumed_from_attempt INTEGER,
  execution_handle TEXT,
  started_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  outcome          TEXT,
  PRIMARY KEY (task_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, attempt);

-- Exactly one normalized final record per attempt. Runtime-specific frames are reduced
-- before this boundary; raw prompts, execution handles, and authentication data have no
-- columns and are rejected by the protocol schema.
CREATE TABLE IF NOT EXISTS attempt_telemetry (
  task_id   TEXT NOT NULL,
  attempt   INTEGER NOT NULL,
  run_id    TEXT NOT NULL,
  agent     TEXT NOT NULL,
  json      TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_run ON attempt_telemetry(run_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON attempt_telemetry(agent, task_id, attempt);

CREATE TABLE IF NOT EXISTS leases (
  lease_id    TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  holder      TEXT NOT NULL,
  scope_json  TEXT NOT NULL,
  state       TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leases_state ON leases(state);
CREATE INDEX IF NOT EXISTS idx_leases_task ON leases(task_id);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  path          TEXT,
  inline        TEXT,
  sha256        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  produced_by   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS status_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  agent      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_task ON status_updates(task_id, id);

CREATE TABLE IF NOT EXISTS deliverables (
  task_id TEXT PRIMARY KEY,
  agent   TEXT NOT NULL,
  status  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  passed  INTEGER NOT NULL,
  json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verif_task ON verifications(task_id);

-- Append-only. No UPDATE or DELETE statement anywhere in this file touches it.
CREATE TABLE IF NOT EXISTS events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  task_id         TEXT,
  agent           TEXT NOT NULL,
  at              INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS idempotency (
  key           TEXT PRIMARY KEY,
  operation     TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  private depth = 0;
  readonly journalMode: string;

  constructor(options: SqliteStoreOptions) {
    const { path, journalMode = "auto" } = options;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // Codex and Claude each own a separate MCP stdio process and may open the same project
    // database at virtually the same instant. Schema creation and `journal_mode` briefly
    // require an exclusive lock; SQLite's default zero wait turns that harmless bootstrap
    // race into `database is locked`. Keep the wait finite so a genuinely wedged holder is
    // still surfaced rather than hanging client startup indefinitely.
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.journalMode = this.configureJournal(path, journalMode, options.onJournalFallback);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(DDL);
    this.migrateSchema();
    this.db
      .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  /** Upgrade certified v1 databases without invalidating their existing task history. */
  private migrateSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as Row[]).map(
        (row) => row["name"] as string,
      ),
    );
    if (!columns.has("run_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN run_id TEXT");
      // Historical tasks predate run correlation. Giving each one a deterministic run id
      // preserves isolation and satisfies the current syntax without inventing a lineage.
      this.db.exec("UPDATE tasks SET run_id = 'run_' || substr(task_id, 6) WHERE run_id IS NULL");
    }
    if (!columns.has("parent_task_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
    }
    if (!columns.has("delegation_depth")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id, delegation_depth)");

    const attemptColumns = new Set(
      (this.db.prepare("PRAGMA table_info(task_attempts)").all() as Row[]).map(
        (row) => row["name"] as string,
      ),
    );
    if (!attemptColumns.has("resumed_from_attempt")) {
      this.db.exec("ALTER TABLE task_attempts ADD COLUMN resumed_from_attempt INTEGER");
    }
  }

  private configureJournal(
    path: string,
    requested: JournalMode,
    onFallback?: SqliteStoreOptions["onJournalFallback"],
  ): string {
    // :memory: databases cannot use WAL at all; SQLite keeps them in "memory" mode.
    if (path === ":memory:") return "memory";
    const tryMode = (mode: string): string | null => {
      try {
        const row = this.db.prepare(`PRAGMA journal_mode = ${mode}`).get() as Row | undefined;
        return (row?.["journal_mode"] as string | undefined) ?? null;
      } catch {
        return null;
      }
    };
    if (requested === "DELETE") return tryMode("DELETE") ?? "delete";
    const wal = tryMode("WAL");
    if (wal === "wal") return "wal";
    if (requested === "WAL") {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `WAL journal mode was required but this filesystem rejected it (got ${wal ?? "error"}). ` +
          `Use journalMode:"auto" to fall back, or place the database on a local disk.`,
        { path },
      );
    }
    const fallback = tryMode("DELETE") ?? "delete";
    onFallback?.("WAL", fallback, "filesystem does not support WAL shared-memory files");
    return fallback;
  }

  transaction<T>(fn: () => T): T {
    // Nested calls join the outer transaction; SQLite has no true nesting without
    // savepoints and the control plane never needs partial rollback.
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback of an already-aborted transaction is not an error worth masking with */
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  /* ---------------- tasks ---------------- */

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks(task_id, run_id, parent_task_id, delegation_depth, spec_json, state,
                           owner, created_by, created_at, updated_at, claimed_at, completed_at,
                           blockers_json, version, attempt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        task.task_id,
        task.run_id,
        task.parent_task_id,
        task.delegation_depth,
        JSON.stringify(task.spec),
        task.state,
        task.owner,
        task.created_by,
        task.created_at,
        task.updated_at,
        task.claimed_at ?? null,
        task.completed_at ?? null,
        JSON.stringify(task.blockers),
        task.version,
        task.attempt,
      );
    for (const dep of task.spec.dependencies) this.addDependency(task.task_id, dep);
  }

  getTask(id: TaskId): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  updateTask(task: Task): void {
    const res = this.db
      .prepare(
        `UPDATE tasks SET spec_json=?, state=?, owner=?, updated_at=?, claimed_at=?,
                          completed_at=?, blockers_json=?, version=?, attempt=?
         WHERE task_id=? AND version=?`,
      )
      .run(
        JSON.stringify(task.spec),
        task.state,
        task.owner,
        task.updated_at,
        task.claimed_at ?? null,
        task.completed_at ?? null,
        JSON.stringify(task.blockers),
        task.version,
        task.attempt,
        task.task_id,
        task.version - 1,
      );
    if (res.changes === 0) {
      throw new BridgeError(
        ErrorCode.INTERNAL,
        `optimistic concurrency failure writing ${task.task_id} at version ${task.version}`,
        { task_id: task.task_id, expected_version: task.version - 1 },
      );
    }
  }

  listTasks(query: TaskQuery = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.state) {
      const states = Array.isArray(query.state) ? query.state : [query.state as TaskState];
      where.push(`state IN (${states.map(() => "?").join(",")})`);
      params.push(...states);
    }
    if (query.owner !== undefined) {
      if (query.owner === null) where.push("owner IS NULL");
      else {
        where.push("owner = ?");
        params.push(query.owner);
      }
    }
    const sql =
      `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY created_at ASC LIMIT ?`;
    params.push(query.limit ?? 1000);
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    const tasks = rows.map(rowToTask);
    return query.tag ? tasks.filter((t) => (t.spec.tags ?? []).includes(query.tag!)) : tasks;
  }

  /* ---------------- dependencies ---------------- */

  addDependency(task_id: TaskId, depends_on: TaskId): void {
    this.db
      .prepare("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on) VALUES(?,?)")
      .run(task_id, depends_on);
  }

  getDependencies(task_id: TaskId): TaskId[] {
    const rows = this.db
      .prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on")
      .all(task_id) as Row[];
    return rows.map((r) => r["depends_on"] as string);
  }

  getDependents(task_id: TaskId): TaskId[] {
    const rows = this.db
      .prepare("SELECT task_id FROM task_dependencies WHERE depends_on = ? ORDER BY task_id")
      .all(task_id) as Row[];
    return rows.map((r) => r["task_id"] as string);
  }

  /* ---------------- attempts ---------------- */

  upsertAttempt(a: TaskAttempt): void {
    this.db
      .prepare(
        `INSERT INTO task_attempts(task_id, attempt, agent, resumed_from_attempt, execution_handle, started_at, updated_at, ended_at, outcome)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id, attempt) DO UPDATE SET
           agent=excluded.agent,
           resumed_from_attempt=COALESCE(excluded.resumed_from_attempt, task_attempts.resumed_from_attempt),
           execution_handle=COALESCE(excluded.execution_handle, task_attempts.execution_handle),
           updated_at=excluded.updated_at,
           ended_at=COALESCE(excluded.ended_at, task_attempts.ended_at),
           outcome=COALESCE(excluded.outcome, task_attempts.outcome)`,
      )
      .run(
        a.task_id,
        a.attempt,
        a.agent,
        a.resumed_from_attempt,
        a.execution_handle,
        a.started_at,
        a.updated_at,
        a.ended_at ?? null,
        a.outcome ?? null,
      );
  }

  getAttempt(task_id: TaskId, attempt: number): TaskAttempt | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_attempts WHERE task_id = ? AND attempt = ?")
      .get(task_id, attempt) as Row | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  listAttempts(task_id: TaskId): TaskAttempt[] {
    const rows = this.db
      .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC")
      .all(task_id) as Row[];
    return rows.map(rowToAttempt);
  }

  /* ---------------- normalized attempt telemetry ---------------- */

  insertAttemptTelemetry(t: AttemptTelemetry): void {
    this.db
      .prepare(
        `INSERT INTO attempt_telemetry(task_id, attempt, run_id, agent, json)
         VALUES(?,?,?,?,?)`,
      )
      .run(t.task_id, t.attempt, t.run_id, t.agent, JSON.stringify(t));
  }

  listAttemptTelemetry(query: AttemptTelemetryQuery = {}): AttemptTelemetry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.run_id !== undefined) {
      where.push("run_id = ?");
      params.push(query.run_id);
    }
    if (query.task_id !== undefined) {
      where.push("task_id = ?");
      params.push(query.task_id);
    }
    if (query.agent !== undefined) {
      where.push("agent = ?");
      params.push(query.agent);
    }
    if (query.attempt !== undefined) {
      where.push("attempt = ?");
      params.push(query.attempt);
    }
    const sql =
      `SELECT json FROM attempt_telemetry${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY run_id ASC, task_id ASC, attempt ASC LIMIT ?`;
    params.push(query.limit ?? 1000);
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    return rows.map((row) => {
      const parsed = JSON.parse(row["json"] as string) as AttemptTelemetry;
      return {
        ...parsed,
        resumed_from_attempt: parsed.resumed_from_attempt ?? null,
        requested_model: parsed.requested_model ?? null,
        requested_effort: parsed.requested_effort ?? null,
      };
    });
  }

  /* ---------------- leases ---------------- */

  insertLease(lease: Lease): void {
    this.db
      .prepare(
        `INSERT INTO leases(lease_id, task_id, holder, scope_json, state, acquired_at, expires_at, released_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        lease.lease_id,
        lease.task_id,
        lease.holder,
        JSON.stringify(lease.scope),
        lease.state,
        lease.acquired_at,
        lease.expires_at,
        lease.released_at ?? null,
      );
  }

  getLease(id: LeaseId): Lease | undefined {
    const row = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(id) as Row | undefined;
    return row ? rowToLease(row) : undefined;
  }

  updateLease(lease: Lease): void {
    this.db
      .prepare("UPDATE leases SET state=?, expires_at=?, released_at=? WHERE lease_id=?")
      .run(lease.state, lease.expires_at, lease.released_at ?? null, lease.lease_id);
  }

  listHeldLeases(): Lease[] {
    const rows = this.db
      .prepare("SELECT * FROM leases WHERE state = 'HELD' ORDER BY acquired_at ASC")
      .all() as Row[];
    return rows.map(rowToLease);
  }

  /* ---------------- artifacts ---------------- */

  insertArtifact(a: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts(artifact_id, task_id, kind, name, media_type, path, inline,
                               sha256, bytes, produced_by, created_at, metadata_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.artifact_id,
        a.task_id,
        a.kind,
        a.name,
        a.media_type,
        a.path ?? null,
        a.inline ?? null,
        a.sha256,
        a.bytes,
        a.produced_by,
        a.created_at,
        a.metadata ? JSON.stringify(a.metadata) : null,
      );
  }

  getArtifact(id: ArtifactId): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(id) as Row | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  listArtifacts(task_id: TaskId): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(task_id) as Row[];
    return rows.map(rowToArtifact);
  }

  /* ---------------- status / deliverables / verification ---------------- */

  insertStatus(u: StatusUpdate): void {
    this.db
      .prepare("INSERT INTO status_updates(task_id, agent, at, json) VALUES(?,?,?,?)")
      .run(u.task_id, u.agent, u.at, JSON.stringify(u));
  }

  latestStatus(task_id: TaskId): StatusUpdate | undefined {
    const row = this.db
      .prepare("SELECT json FROM status_updates WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(task_id) as Row | undefined;
    return row ? (JSON.parse(row["json"] as string) as StatusUpdate) : undefined;
  }

  insertDeliverable(d: Deliverable): void {
    this.db
      .prepare(
        `INSERT INTO deliverables(task_id, agent, status, at, json) VALUES(?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET agent=excluded.agent, status=excluded.status,
                                            at=excluded.at, json=excluded.json`,
      )
      .run(d.task_id, d.agent, d.status, d.at, JSON.stringify(d));
  }

  getDeliverable(task_id: TaskId): Deliverable | undefined {
    const row = this.db.prepare("SELECT json FROM deliverables WHERE task_id = ?").get(task_id) as
      | Row
      | undefined;
    return row ? (JSON.parse(row["json"] as string) as Deliverable) : undefined;
  }

  insertVerification(task_id: TaskId, r: VerificationResult): void {
    this.db
      .prepare("INSERT INTO verifications(task_id, kind, passed, json) VALUES(?,?,?,?)")
      .run(task_id, r.kind, r.passed ? 1 : 0, JSON.stringify(r));
  }

  listVerifications(task_id: TaskId): VerificationResult[] {
    const rows = this.db
      .prepare("SELECT json FROM verifications WHERE task_id = ? ORDER BY id ASC")
      .all(task_id) as Row[];
    return rows.map((r) => JSON.parse(r["json"] as string) as VerificationResult);
  }

  /* ---------------- event log ---------------- */

  appendEvent(event: EventAppend, at: number): BridgeEvent {
    const res = this.db
      .prepare(
        "INSERT INTO events(type, task_id, agent, at, payload_json, idempotency_key) VALUES(?,?,?,?,?,?)",
      )
      .run(
        event.type,
        event.task_id,
        event.agent,
        at,
        JSON.stringify(event.payload),
        event.idempotency_key ?? null,
      );
    return {
      event_id: Number(res.lastInsertRowid),
      type: event.type,
      task_id: event.task_id,
      agent: event.agent,
      at,
      payload: event.payload,
      ...(event.idempotency_key ? { idempotency_key: event.idempotency_key } : {}),
    };
  }

  readEvents(query: EventQuery = {}): BridgeEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.after !== undefined) {
      where.push("event_id > ?");
      params.push(query.after);
    }
    if (query.task_id) {
      where.push("task_id = ?");
      params.push(query.task_id);
    }
    if (query.types?.length) {
      where.push(`type IN (${query.types.map(() => "?").join(",")})`);
      params.push(...query.types);
    }
    const sql =
      `SELECT * FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY event_id ASC LIMIT ?`;
    params.push(query.limit ?? 1000);
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    return rows.map((r) => ({
      event_id: Number(r["event_id"]),
      type: r["type"] as EventType,
      task_id: (r["task_id"] as string | null) ?? null,
      agent: r["agent"] as AgentId,
      at: Number(r["at"]),
      payload: JSON.parse(r["payload_json"] as string) as Record<string, unknown>,
      ...(r["idempotency_key"] ? { idempotency_key: r["idempotency_key"] as string } : {}),
    }));
  }

  lastEventId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS m FROM events").get() as Row;
    return Number(row["m"]);
  }

  /* ---------------- idempotency ---------------- */

  getIdempotency(key: string): IdempotencyRecord | undefined {
    const row = this.db.prepare("SELECT * FROM idempotency WHERE key = ?").get(key) as Row | undefined;
    if (!row) return undefined;
    return {
      key: row["key"] as string,
      operation: row["operation"] as string,
      request_hash: row["request_hash"] as string,
      response_json: row["response_json"] as string,
      created_at: Number(row["created_at"]),
    };
  }

  putIdempotency(r: IdempotencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO idempotency(key, operation, request_hash, response_json, created_at)
         VALUES(?,?,?,?,?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(r.key, r.operation, r.request_hash, r.response_json, r.created_at);
  }

  close(): void {
    this.db.close();
  }
}

/* ---------------- row mappers ---------------- */

function rowToTask(r: Row): Task {
  return {
    task_id: r["task_id"] as string,
    run_id: r["run_id"] as string,
    parent_task_id: (r["parent_task_id"] as string | null) ?? null,
    delegation_depth: Number(r["delegation_depth"]),
    spec: JSON.parse(r["spec_json"] as string),
    state: r["state"] as TaskState,
    owner: (r["owner"] as string | null) ?? null,
    created_by: r["created_by"] as AgentId,
    created_at: Number(r["created_at"]),
    updated_at: Number(r["updated_at"]),
    ...(r["claimed_at"] != null ? { claimed_at: Number(r["claimed_at"]) } : {}),
    ...(r["completed_at"] != null ? { completed_at: Number(r["completed_at"]) } : {}),
    blockers: JSON.parse((r["blockers_json"] as string) ?? "[]"),
    version: Number(r["version"]),
    attempt: Number(r["attempt"]),
  };
}

function rowToAttempt(r: Row): TaskAttempt {
  return {
    task_id: r["task_id"] as string,
    attempt: Number(r["attempt"]),
    agent: r["agent"] as AgentId,
    resumed_from_attempt:
      r["resumed_from_attempt"] == null ? null : Number(r["resumed_from_attempt"]),
    execution_handle: (r["execution_handle"] as string | null) ?? null,
    started_at: Number(r["started_at"]),
    updated_at: Number(r["updated_at"]),
    ...(r["ended_at"] != null ? { ended_at: Number(r["ended_at"]) } : {}),
    ...(r["outcome"] != null ? { outcome: r["outcome"] as string } : {}),
  };
}

function rowToLease(r: Row): Lease {
  return {
    lease_id: r["lease_id"] as string,
    task_id: r["task_id"] as string,
    holder: r["holder"] as AgentId,
    scope: JSON.parse(r["scope_json"] as string),
    state: r["state"] as Lease["state"],
    acquired_at: Number(r["acquired_at"]),
    expires_at: Number(r["expires_at"]),
    ...(r["released_at"] != null ? { released_at: Number(r["released_at"]) } : {}),
  };
}

function rowToArtifact(r: Row): Artifact {
  return {
    artifact_id: r["artifact_id"] as string,
    task_id: r["task_id"] as string,
    kind: r["kind"] as Artifact["kind"],
    name: r["name"] as string,
    media_type: r["media_type"] as string,
    ...(r["path"] != null ? { path: r["path"] as string } : {}),
    ...(r["inline"] != null ? { inline: r["inline"] as string } : {}),
    sha256: r["sha256"] as string,
    bytes: Number(r["bytes"]),
    produced_by: r["produced_by"] as AgentId,
    created_at: Number(r["created_at"]),
    ...(r["metadata_json"] != null
      ? { metadata: JSON.parse(r["metadata_json"] as string) as Record<string, unknown> }
      : {}),
  };
}
