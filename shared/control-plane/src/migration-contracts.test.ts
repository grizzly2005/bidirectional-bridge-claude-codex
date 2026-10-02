/** Independent historical layouts and byte-level safeguards; no production database. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { SqliteStateStore, type JournalMode } from "./store/sqlite-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });

const ROOT_TASK = "task_0000000001", CHILD_TASK = "task_0000000002", RUN = "run_0000000099";
const RAW_SPEC = JSON.stringify({ objective: "historical fixture", scope: { paths: ["legacy/**"] },
  dependencies: [], expected_deliverable: "retained result", verification_criteria: ["fixture check"], old_optional_field: "retained" }, null, 2);
const OLD_PAYLOAD = '{ "reason": "history", "unknown_optional_field": [1, "é"] }';

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-schema-contract-"));
  resources.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}

/** Fixed fixtures from the documented pre-v4 layouts, not extracted from current DDL. */
function historicalDatabase(path: string, version: 1 | 2 | 3): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        ${version >= 2 ? "run_id TEXT NOT NULL, parent_task_id TEXT, delegation_depth INTEGER NOT NULL DEFAULT 0," : ""}
        spec_json TEXT NOT NULL, state TEXT NOT NULL, owner TEXT, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER,
        completed_at INTEGER, blockers_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1, attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id, depends_on));
      CREATE TABLE task_attempts(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, agent TEXT NOT NULL,
        ${version === 3 ? "resumed_from_attempt INTEGER," : ""}
        execution_handle TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        ended_at INTEGER, outcome TEXT, PRIMARY KEY(task_id, attempt));
      CREATE TABLE leases(lease_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, holder TEXT NOT NULL,
        scope_json TEXT NOT NULL, state TEXT NOT NULL, acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, released_at INTEGER);
      CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, media_type TEXT NOT NULL, path TEXT, inline TEXT, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, produced_by TEXT NOT NULL, created_at INTEGER NOT NULL, metadata_json TEXT);
      CREATE TABLE status_updates(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        agent TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE deliverables(task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, status TEXT NOT NULL,
        at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE verifications(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        kind TEXT NOT NULL, passed INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
        task_id TEXT, agent TEXT NOT NULL, at INTEGER NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT);
      CREATE TABLE idempotency(key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE operator_extension(key TEXT PRIMARY KEY, value BLOB NOT NULL);
    `);
    db.prepare("INSERT INTO schema_meta VALUES('schema_version', ?), ('operator_note', 'keep')").run(String(version));
    for (const [id, state, attempt] of [[ROOT_TASK, "DONE", 0], [CHILD_TASK, "FAILED", 1]] as const) {
      const values: Array<string | number | null> = [id];
      if (version >= 2) values.push(RUN, id === ROOT_TASK ? null : ROOT_TASK, id === ROOT_TASK ? 0 : 1);
      values.push(RAW_SPEC, state, "codex", "claude", 10, 25, 11, 24, "[]", 6, attempt);
      db.prepare(`INSERT INTO tasks VALUES(${values.map(() => "?").join(",")})`).run(...values);
    }
    db.prepare("INSERT INTO task_dependencies VALUES(?, ?)").run(CHILD_TASK, ROOT_TASK);
    for (const attempt of [0, 1]) {
      const values: Array<string | number | null> = [CHILD_TASK, attempt, "codex"];
      if (version === 3) values.push(attempt === 1 ? 0 : null);
      values.push(`retained-session-${attempt}`, 12 + attempt, 20 + attempt, 22 + attempt, "TIMEOUT");
      db.prepare(`INSERT INTO task_attempts VALUES(${values.map(() => "?").join(",")})`).run(...values);
    }
    db.prepare("INSERT INTO leases VALUES('lease_0000000001', ?, 'codex', ?, 'HELD', 12, 20, NULL)")
      .run(CHILD_TASK, '{ "paths": ["legacy/**"] }');
    db.prepare("INSERT INTO artifacts VALUES('artifact_0000000001', ?, 'report', 'old result', 'text/plain', NULL, 'retained', ?, 8, 'codex', 20, ?)")
      .run(ROOT_TASK, "b".repeat(64), OLD_PAYLOAD);
    db.prepare("INSERT INTO status_updates VALUES(3, ?, 'codex', 20, ?)").run(CHILD_TASK, OLD_PAYLOAD);
    db.prepare("INSERT INTO deliverables VALUES(?, 'codex', 'COMPLETE', 24, ?)").run(ROOT_TASK, OLD_PAYLOAD);
    db.prepare("INSERT INTO verifications VALUES(4, ?, 'test', 1, ?)").run(ROOT_TASK, OLD_PAYLOAD);
    db.prepare("INSERT INTO events VALUES(7, 'task.created', ?, 'claude', 10, ?, 'old-create')").run(ROOT_TASK, OLD_PAYLOAD);
    db.prepare("INSERT INTO events VALUES(9, 'task.failed', ?, 'codex', 25, ?, NULL)").run(CHILD_TASK, OLD_PAYLOAD);
    db.prepare("INSERT INTO idempotency VALUES('old-key', 'task.create', ?, ?, 10)").run("a".repeat(64), OLD_PAYLOAD);
    db.prepare("INSERT INTO operator_extension VALUES('opaque', ?)").run(Buffer.from([0, 255, 128, 13, 10]));
    if (version === 3) {
      db.exec("CREATE TABLE attempt_telemetry(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, run_id TEXT NOT NULL, agent TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(task_id, attempt));");
      db.prepare("INSERT INTO attempt_telemetry VALUES(?, 0, ?, 'codex', ?)").run(CHILD_TASK, RUN,
        '{ "task_id": "task_0000000002", "attempt": 0, "duration_measurement_version": 1, "input_tokens": null, "wall_duration_ms": 30 }');
    }
  } finally { db.close(); }
}

interface Snapshot {
  readonly columns: Record<string, string[]>;
  readonly rows: Record<string, Array<Record<string, any>>>;
  readonly schema: Array<Record<string, any>>;
}
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
function snapshot(path: string, columns?: Snapshot["columns"]): Snapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const selected = columns ?? Object.fromEntries(schema.filter(row => row["type"] === "table").map(row => {
      const table = String(row["name"]);
      return [table, db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => String(column["name"]))];
    }));
    const rows = Object.fromEntries(Object.entries(selected).map(([table, fields]) =>
      [table, db.prepare(`SELECT ${fields.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${table === "schema_meta" ? quote("key") : "rowid"}`).all()]));
    return { columns: selected, rows, schema };
  } finally { db.close(); }
}
function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).filter(name => name.startsWith("candidate.db")).sort().map(name =>
    [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
}
function hashFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function rejectedOpen(path: string, journalMode: JournalMode = "auto"): unknown {
  let store: SqliteStateStore | undefined;
  try { store = new SqliteStateStore({ path, journalMode }); return null; }
  catch (error) { return error; }
  finally { store?.close(); }
}

describe("v4 migration contracts", () => {
  it.each([1, 2, 3] as const)("upgrades a copy of schema v%s while preserving the original snapshot and every historical field", version => {
    const dir = directory(), original = join(dir, "snapshot.db"), working = join(dir, "candidate.db");
    historicalDatabase(original, version);
    const originalHash = hashFile(original), before = snapshot(original);
    copyFileSync(original, working);
    const cp = ControlPlane.open({ workspaceRoot: dir, databasePath: working, journalMode: "DELETE" });
    try {
      expect(cp.store.listTasks()).toHaveLength(2);
      expect(cp.store.getTask(ROOT_TASK)).toMatchObject({
        run_id: version === 1 ? "run_0000000001" : RUN, parent_task_id: null, delegation_depth: 0,
        owner: "codex", created_by: "claude", state: "DONE", created_at: 10, updated_at: 25, version: 6,
      });
      expect(cp.store.getTask(CHILD_TASK)).toMatchObject({
        run_id: version === 1 ? "run_0000000002" : RUN,
        parent_task_id: version === 1 ? null : ROOT_TASK, delegation_depth: version === 1 ? 0 : 1, attempt: 1,
      });
      expect(cp.store.listAttempts(CHILD_TASK).map(attempt => [attempt.execution_handle, attempt.resumed_from_attempt]))
        .toEqual([["retained-session-0", null], ["retained-session-1", version === 3 ? 0 : null]]);
      expect(cp.attempts.observation(CHILD_TASK, 0)).toEqual({ status: "LEGACY_UNKNOWN", category: null, accepted: false, strict_required: false });
      expect(cp.store.listObservations()).toEqual([]);
      expect(cp.store.listExecutions()).toEqual([]);
      expect(cp.store.lastEventId()).toBe(9);
    } finally { cp.close(); }
    const after = snapshot(working, before.columns);
    const historicalRows = { ...before.rows,
      schema_meta: before.rows["schema_meta"]!.map(row => row["key"] === "schema_version" ? { ...row, value: "4" } : row) };
    expect(after.rows).toEqual(historicalRows);
    const upgraded = snapshot(working);
    expect(upgraded.schema.filter(row => row["type"] === "table").map(row => row["name"]))
      .toEqual(expect.arrayContaining(["delegation_operations", "task_executions", "attempt_observations", "attempt_telemetry", "operator_extension"]));
    expect(hashFile(original)).toBe(originalHash);
    expect(snapshot(original)).toEqual(before);
    const reopened = new SqliteStateStore({ path: working, journalMode: "DELETE" });
    try { expect(reopened.listTasks()).toHaveLength(2); expect(reopened.lastEventId()).toBe(9); }
    finally { reopened.close(); }
    expect(snapshot(working, before.columns).rows).toEqual(historicalRows);
  });

  it("rolls back all DDL and projected run ids when the final version commit fails", () => {
    const dir = directory(), path = join(dir, "candidate.db");
    historicalDatabase(path, 1);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_schema_commit BEFORE INSERT ON schema_meta WHEN NEW.key='schema_version' AND NEW.value='4' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;");
    db.close();
    const before = snapshot(path), error = rejectedOpen(path, "DELETE");
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("fixture commit failure");
    expect(snapshot(path)).toEqual(before);
    const usable = new DatabaseSync(path);
    // Failed construction must close its connection and release migration write locks.
    usable.exec("BEGIN EXCLUSIVE; DROP TRIGGER reject_schema_commit; COMMIT;");
    usable.close();
    const store = new SqliteStateStore({ path, journalMode: "DELETE" });
    try { expect(store.getTask(ROOT_TASK)?.run_id).toBe("run_0000000001"); }
    finally { store.close(); }
  });

  it.each(["auto", "DELETE", "WAL"] as const)("refuses a future schema before changing its bytes or journal mode (%s)", journalMode => {
    const dir = directory(), path = join(dir, "candidate.db");
    historicalDatabase(path, 3);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE schema_meta SET value='99' WHERE key='schema_version'").run();
    db.close();
    const before = snapshot(path), originalHashes = hashes(dir);
    expect(rejectedOpen(path, journalMode)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(hashes(dir)).toEqual(originalHashes);
    expect(snapshot(path)).toEqual(before);
  });

  it("refuses a future WAL snapshot without checkpointing it or creating/removing original sidecars", () => {
    const dir = directory(), source = join(dir, "live-source.db"), candidate = join(dir, "candidate.db");
    const writer = new DatabaseSync(source);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO schema_meta VALUES('schema_version', '99'); CREATE TABLE preserved(payload BLOB); INSERT INTO preserved VALUES(X'00FF800D0A');");
      copyFileSync(source, candidate);
      copyFileSync(`${source}-wal`, `${candidate}-wal`);
      expect(existsSync(`${candidate}-shm`)).toBe(false);
      const before = hashes(dir);
      expect(rejectedOpen(candidate)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
      expect(hashes(dir)).toEqual(before);
    } finally { writer.close(); }
  });

  it.each(["-1", "", " ", "3.5", "NaN", "not-a-version"])("refuses malformed schema metadata '%s' without replacing it with v4", value => {
    const dir = directory(), path = join(dir, "candidate.db");
    historicalDatabase(path, 3);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE schema_meta SET value=? WHERE key='schema_version'").run(value);
    db.close();
    const before = hashes(dir);
    expect(rejectedOpen(path)).toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(hashes(dir)).toEqual(before);
  });

  it("serializes two independent process upgrades and preserves each historical event", async () => {
    const dir = directory(), path = join(dir, "candidate.db"), barrier = join(dir, "start.marker");
    historicalDatabase(path, 1);
    const before = snapshot(path);
    const modulePath = join(repoRoot, "shared/control-plane/dist/store/sqlite-store.js");
    expect(existsSync(modulePath), "Build the bridge before the independent process migration fixture").toBe(true);
    const worker = join(dir, "migrate.mjs");
    writeFileSync(worker, `import { existsSync } from 'node:fs';\nimport { SqliteStateStore } from ${JSON.stringify(pathToFileURL(modulePath).href)};\nconst [database, barrier] = process.argv.slice(2);\nprocess.stdout.write('ready\\n');\nfor (let n=0; !existsSync(barrier); n++) { if(n>1000) throw new Error('fixture barrier timeout'); await new Promise(resolve=>setTimeout(resolve,5)); }\nconst store = new SqliteStateStore({path:database});\ntry { process.stdout.write(JSON.stringify({tasks:store.listTasks().length, events:store.lastEventId()})+'\\n'); } finally { store.close(); }\n`);
    function start(): { ready: Promise<void>; done: Promise<any>; child: ChildProcess } {
      const child = spawn(process.execPath, [worker, path, barrier], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", markReady: () => void;
      const ready = new Promise<void>(resolveReady => { markReady = resolveReady; });
      child.stdout!.on("data", value => { stdout += String(value); if (stdout.startsWith("ready\n")) markReady(); });
      child.stderr!.on("data", value => { stderr += String(value); });
      const done = new Promise((resolveDone, reject) => {
        child.once("error", reject);
        child.once("close", code => {
          if (code !== 0) reject(new Error(`Migration fixture exited ${code}: ${stderr.slice(-500)}`));
          else { try { resolveDone(JSON.parse(stdout.trim().split("\n").at(-1)!)); } catch (error) { reject(error); } }
        });
      });
      resources.push(() => { if (child.exitCode === null) child.kill(); });
      return { ready, done, child };
    }
    const a = start(), b = start();
    await Promise.all([a.ready, b.ready]);
    writeFileSync(barrier, "go");
    expect(await Promise.all([a.done, b.done])).toEqual([{ tasks: 2, events: 9 }, { tasks: 2, events: 9 }]);
    const rows = snapshot(path, before.columns).rows;
    expect(rows["events"]).toEqual(before.rows["events"]);
    expect(rows["task_attempts"]).toEqual(before.rows["task_attempts"]);
    expect(rows["schema_meta"]).toEqual(before.rows["schema_meta"]!.map(row => row["key"] === "schema_version" ? { ...row, value: "4" } : row));
  });

  it("waits for a copied hot rollback journal to become readable before opening the original", async () => {
    const dir = directory(), path = join(dir, "candidate.db"), worker = join(dir, "hold-transaction.mjs");
    historicalDatabase(path, 1);
    const before = snapshot(path);
    writeFileSync(worker, `import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[2]);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE pressure(payload BLOB); BEGIN IMMEDIATE; UPDATE schema_meta SET value='99' WHERE key='schema_version'; INSERT INTO pressure VALUES(zeroblob(1048576));");
      process.stdout.write('ready\\n');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 350);
    `);
    const child = spawn(process.execPath, [worker, path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", value => { stderr += String(value); });
    const done = new Promise<void>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolveDone() : reject(new Error(`Fixture writer failed: ${stderr}`)));
    });
    resources.push(() => { if (child.exitCode === null) child.kill(); });
    await new Promise<void>((resolveReady, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", value => String(value).startsWith("ready") ? resolveReady() : reject(new Error("Missing fixture barrier")));
    });
    expect(existsSync(`${path}-journal`)).toBe(true);
    const store = new SqliteStateStore({ path });
    try {
      expect(store.listTasks()).toHaveLength(2);
      expect(store.lastEventId()).toBe(9);
    } finally { store.close(); }
    await done;
    const rows = snapshot(path, before.columns).rows;
    expect(rows["events"]).toEqual(before.rows["events"]);
    expect(rows["task_attempts"]).toEqual(before.rows["task_attempts"]);
    expect(rows["schema_meta"]).toEqual(before.rows["schema_meta"]!.map(row => row["key"] === "schema_version" ? { ...row, value: "4" } : row));
  });
});
