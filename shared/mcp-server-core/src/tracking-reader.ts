/** A separate, query-only connection. Observation must never initialize or recover bridge.db. */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseCtor } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseCtor };
type Row = Record<string, unknown>;
const STATES = ["PENDING", "CLAIMED", "WORKING", "BLOCKED", "VERIFYING", "DONE", "FAILED", "CANCELLED"];
const OBS = ["PENDING", "COMPLETE", "INCOMPLETE", "REJECTED", "LEGACY_UNKNOWN"];
const METRICS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "total_tokens", "turn_count", "wall_duration_ms", "runtime_duration_ms", "attempt_wall_duration_ms", "queue_duration_ms", "startup_duration_ms", "work_duration_ms", "seal_duration_ms"];
export const TRACKING_NODE_LIMIT = 250;
export const TRACKING_ATTEMPT_LIMIT = 1000;
export const TRACKING_EVENT_LIMIT = 250;
export class TrackingError extends Error {
  constructor(readonly code: string) { super(code); }
}
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const member = (value: unknown, values: readonly string[]): string | null => typeof value === "string" && values.includes(value) ? value : null;
// Never derive a label from spec.objective, paths, errors, prompts or artifact names.
const agent = (value: unknown): string | null => member(value, ["claude", "codex", "bridge"]);
const id = (value: unknown): string => typeof value === "string" && /^(?:task|run)_[0-9a-hjkmnp-tv-z]{10}$/u.test(value) ? value : "unknown";
function json(value: unknown): Row {
  if (typeof value !== "string" || value.length > 64_000) return {};
  try { const result: unknown = JSON.parse(value); return result !== null && typeof result === "object" && !Array.isArray(result) ? result as Row : {}; } catch { return {}; }
}
function observation(value: unknown) {
  const row = json(value);
  const status = member(row["status"], OBS);
  return status ? { status, accepted: row["accepted"] === true, strict_required: row["strict_required"] === true,
    category: member(row["category"], ["STORAGE", "SCHEMA", "PRIVACY", "USAGE_UNAVAILABLE"]) } : null;
}
function telemetry(value: unknown) {
  if (value === null || value === undefined) return null;
  const row = json(value);
  return Object.fromEntries(METRICS.map(key => [key, number(row[key])]));
}
export interface HistoryPosition { upper: number; before_at: number; before_id: string }

export class TrackingReader {
  private db: InstanceType<typeof DatabaseCtor> | undefined;
  private identity = "missing";
  constructor(readonly path: string) {}
  close(): void { this.db?.close(); this.db = undefined; }

  private connect(): InstanceType<typeof DatabaseCtor> | undefined {
    if (!existsSync(this.path)) { this.close(); this.identity = "missing"; return undefined; }
    const stat = statSync(this.path);
    const identity = createHash("sha256").update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest("hex");
    if (identity !== this.identity || !this.db) {
      this.close();
      const db = new DatabaseSync(this.path, { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=150;");
        const version = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as Row | undefined;
        if (version?.["value"] !== "4") throw new TrackingError("UNSUPPORTED_SCHEMA");
      } catch (err) { db.close(); if (err instanceof TrackingError) throw err; throw new TrackingError("DATABASE_UNAVAILABLE"); }
      this.db = db; this.identity = identity;
    }
    return this.db;
  }

  private transaction<T>(read: (db: InstanceType<typeof DatabaseCtor> | undefined) => T): T {
    const db = this.connect();
    if (!db) return read(undefined);
    try {
      db.exec("BEGIN");
      if ((db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as Row | undefined)?.["value"] !== "4") throw new TrackingError("UNSUPPORTED_SCHEMA");
      const value = read(db); db.exec("COMMIT"); return value;
    }
    catch (err) { try { db.exec("ROLLBACK"); } catch { /* read transaction may already have ended */ }
      if (err instanceof TrackingError) throw err; throw new TrackingError("DATABASE_UNAVAILABLE"); }
  }

  runExists(runId: string): boolean {
    return this.transaction(db => Boolean(db?.prepare("SELECT 1 FROM tasks WHERE run_id=? LIMIT 1").get(runId)));
  }
  latestRun(): string | null {
    return this.transaction(db => {
      const value = (db?.prepare("SELECT run_id FROM tasks WHERE parent_task_id IS NULL ORDER BY rowid DESC LIMIT 1").get() as Row | undefined)?.["run_id"];
      if (value === undefined) return null;
      if (id(value) === "unknown") throw new TrackingError("DATABASE_UNAVAILABLE");
      return value as string;
    });
  }

  snapshot(runId: string | null, after?: { database: string; event: number }) {
    return this.transaction(db => {
      const head = db ? Number((db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM events").get() as Row)["id"]) : 0;
      if (after && (after.database !== this.identity || after.event > head)) throw new TrackingError("CURSOR_RESET_REQUIRED");
      if (!db || !runId) return { database: this.identity, snapshot_event_id: head, cursor_event: head, has_more: false, tasks: [], attempts: [], links: [], truncated: false };
      const rows = db.prepare(`SELECT t.task_id,t.run_id,t.parent_task_id,t.delegation_depth,t.state,t.owner,t.created_at,t.updated_at,t.attempt,
        d.status AS business_status,x.phase,CASE WHEN length(x.json)<=64000 THEN x.json END AS execution_json,
        CASE WHEN length(o.json)<=64000 THEN o.json END AS observation_json,
        (SELECT COUNT(*) FROM verifications v WHERE v.task_id=t.task_id AND v.passed=1) AS passed,
        (SELECT COUNT(*) FROM verifications v WHERE v.task_id=t.task_id AND v.passed=0) AS failed
        FROM tasks t LEFT JOIN deliverables d ON d.task_id=t.task_id LEFT JOIN task_executions x ON x.task_id=t.task_id
        LEFT JOIN attempt_observations o ON o.task_id=t.task_id AND o.attempt=t.attempt
        WHERE t.run_id=? ORDER BY t.delegation_depth,t.created_at,t.task_id LIMIT ?`).all(runId, TRACKING_NODE_LIMIT + 1) as Row[];
      const selected = rows.slice(0, TRACKING_NODE_LIMIT);
      const tasks = selected.map(t => {
        const execution = json(t["execution_json"]);
        return { task_id: id(t["task_id"]), run_id: id(t["run_id"]), parent_task_id: t["parent_task_id"] === null ? null : id(t["parent_task_id"]),
          delegation_depth: number(t["delegation_depth"]) ?? 0, owner: agent(t["owner"]), title: t["parent_task_id"] === null ? "Tâche maître" : "Délégation",
          state: member(t["state"], STATES) ?? "BLOCKED", business_status: member(t["business_status"], ["COMPLETE", "PARTIAL", "FAILED"]),
          execution_phase: member(t["phase"], ["QUEUED", "RUNNING", "STOPPED", "QUARANTINED"]),
          runtime_stop_confirmed: typeof execution["runtime_stop_confirmed"] === "boolean" ? execution["runtime_stop_confirmed"] : null,
          cancel_requested: number(execution["cancel_requested_at"]) !== null, attempt: number(t["attempt"]) ?? 0,
          observation: observation(t["observation_json"]), created_at: number(t["created_at"]), updated_at: number(t["updated_at"]),
          verification: { passed: number(t["passed"]) ?? 0, failed: number(t["failed"]) ?? 0 } };
      });
      const selectedIds = tasks.map(t => t.task_id);
      const attemptsRows = selectedIds.length ? db.prepare(`SELECT a.task_id,a.attempt,a.agent,a.resumed_from_attempt,a.started_at,a.ended_at,a.outcome,
        CASE WHEN length(o.json)<=64000 THEN o.json END AS observation_json,CASE WHEN length(m.json)<=64000 THEN m.json END AS telemetry_json FROM task_attempts a
        LEFT JOIN attempt_observations o ON o.task_id=a.task_id AND o.attempt=a.attempt
        LEFT JOIN attempt_telemetry m ON m.task_id=a.task_id AND m.attempt=a.attempt
        WHERE a.task_id IN (${selectedIds.map(() => "?").join(",")}) ORDER BY a.task_id,a.attempt DESC LIMIT ?`).all(...selectedIds, TRACKING_ATTEMPT_LIMIT + 1) as Row[] : [];
      const attempts = attemptsRows.slice(0, TRACKING_ATTEMPT_LIMIT).map(a => ({ task_id: id(a["task_id"]), attempt: number(a["attempt"]),
        agent: agent(a["agent"]), resumed_from_attempt: number(a["resumed_from_attempt"]), started_at: number(a["started_at"]), ended_at: number(a["ended_at"]),
        outcome: member(a["outcome"], ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED", "DONE", "TIMEOUT", "CRASH", "MAX_TURNS", "ABORTED"]),
        failure_category: member((json(a["telemetry_json"])["runtime_failure"] as Row | undefined)?.["category"], ["quota", "auth", "transient", "profile", "contract", "turn_limit", "unknown"]),
        observation: observation(a["observation_json"]), telemetry: telemetry(a["telemetry_json"]) }));
      const links = tasks.filter(t => t.parent_task_id && selectedIds.includes(t.parent_task_id)).map(t => ({ from: t.parent_task_id!, to: t.task_id, kind: "delegation" }));
      // Cursor is the last consumed matching event, never the global head of a truncated page.
      const events = after ? db.prepare(`SELECT e.event_id FROM events e JOIN tasks t ON t.task_id=e.task_id
        WHERE t.run_id=? AND e.event_id>? AND e.event_id<=? ORDER BY e.event_id LIMIT ?`).all(runId, after.event, head, TRACKING_EVENT_LIMIT + 1) as Row[] : [];
      return { database: this.identity, snapshot_event_id: head, cursor_event: after ? Number(events.slice(0, TRACKING_EVENT_LIMIT).at(-1)?.["event_id"] ?? after.event) : head,
        has_more: events.length > TRACKING_EVENT_LIMIT, tasks, attempts, links, truncated: rows.length > TRACKING_NODE_LIMIT || attemptsRows.length > TRACKING_ATTEMPT_LIMIT };
    });
  }

  history(options: { position?: HistoryPosition; state?: string; owner?: string; limit?: number } = {}) {
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    return this.transaction(db => {
      if (!db) return { database: this.identity, items: [], has_more: false, position: null };
      const upper = options.position?.upper ?? Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS id FROM tasks").get() as Row)["id"]);
      const filters = ["r.parent_task_id IS NULL", "r.rowid<=?"];
      const args: Array<string | number> = [upper];
      if (options.position) { filters.push("(r.created_at<? OR (r.created_at=? AND r.task_id<?))"); args.push(options.position.before_at, options.position.before_at, options.position.before_id); }
      if (options.state) { filters.push("EXISTS(SELECT 1 FROM tasks f WHERE f.run_id=r.run_id AND f.state=?)"); args.push(options.state); }
      if (options.owner) { filters.push("EXISTS(SELECT 1 FROM tasks f WHERE f.run_id=r.run_id AND f.owner=?)"); args.push(options.owner); }
      const rows = db.prepare(`SELECT r.task_id,r.run_id,r.created_at,
        (SELECT MAX(updated_at) FROM tasks c WHERE c.run_id=r.run_id) AS updated_at,
        (SELECT COUNT(*) FROM tasks c WHERE c.run_id=r.run_id) AS task_count,
        (SELECT COUNT(*) FROM tasks c WHERE c.run_id=r.run_id AND c.state NOT IN ('DONE','FAILED','CANCELLED')) AS active_count
        FROM tasks r WHERE ${filters.join(" AND ")} ORDER BY r.created_at DESC,r.task_id DESC LIMIT ?`).all(...args, limit + 1) as Row[];
      const items = rows.slice(0, limit).map(r => ({ run_id: id(r["run_id"]), root_task_id: id(r["task_id"]), title: "Tâche maître", created_at: number(r["created_at"]), updated_at: number(r["updated_at"]), task_count: number(r["task_count"]), active_count: number(r["active_count"]) }));
      const last = items.at(-1);
      return { database: this.identity, items, has_more: rows.length > limit,
        position: last && rows.length > limit ? { upper, before_at: last.created_at!, before_id: last.root_task_id } : null };
    });
  }
}
