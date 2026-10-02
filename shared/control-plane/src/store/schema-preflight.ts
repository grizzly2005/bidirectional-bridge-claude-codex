/** Inspect schema metadata on a disposable snapshot before opening the original writable. */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { BridgeError, ErrorCode } from "@bridge/protocol";

export function assertSchemaVersion(value: unknown, supported: number): void {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) > supported) {
    throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Database schema is newer than this bridge build or malformed");
  }
}

function signature(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Database snapshot requires a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function inspectSchemaBeforeWrite(path: string, supported: number,
  Database: typeof DatabaseSync): void {
  if (path === ":memory:" || !existsSync(path)) return;
  const scratch = mkdtempSync(join(tmpdir(), "bridge-schema-preflight-"));
  try {
    // A stable file signature is not a SQLite transaction boundary. A copied rollback
    // journal can be hot even while its original writer is alive, and WAL sidecars may
    // disappear between stat and copy. Wait a bounded time for a readable snapshot rather
    // than opening/checkpointing the original to discover its schema.
    for (let tries = 0; tries < 50; tries++) {
      if (tries > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const paths = [path, `${path}-wal`, `${path}-journal`];
      const before = paths.map(signature);
      // File copies keep memory bounded and request a filesystem clone when available.
      // Never copy SHM: SQLite may create or alter it even for a read-only connection.
      const candidate = join(scratch, "candidate.db");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { unlinkSync(`${candidate}${suffix}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try {
        for (let n = 0; n < paths.length; n++) {
          if (before[n] !== null) copyFileSync(paths[n]!, `${candidate}${n === 0 ? "" : n === 1 ? "-wal" : "-journal"}`, constants.COPYFILE_FICLONE);
        }
        if (JSON.stringify(paths.map(signature)) !== JSON.stringify(before)) continue;
        const db = new Database(candidate, { readOnly: true });
        try {
          db.exec("PRAGMA query_only=ON");
          const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
          const row = table ? db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() : undefined;
          if (row) assertSchemaVersion(row["value"], supported);
          return;
        } finally { db.close(); }
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { errcode?: number };
        const sqliteBaseCode = typeof e.errcode === "number" ? e.errcode & 0xff : null;
        if (e.code === "ENOENT" || [5, 6, 8, 14].includes(sqliteBaseCode ?? -1)) continue;
        throw error;
      }
    }
    throw new BridgeError(ErrorCode.OPERATION_IN_PROGRESS, "Database changed throughout schema preflight; retry startup");
  } finally {
    // Only direct files in the private directory are removed; no recursive traversal.
    for (const name of readdirSync(scratch)) unlinkSync(join(scratch, name));
    rmdirSync(scratch);
  }
}
