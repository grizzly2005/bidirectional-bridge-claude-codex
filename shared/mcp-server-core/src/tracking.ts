import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, openSync, closeSync, chmodSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import type { DatabaseSync as DatabaseCtor } from "node:sqlite";
import { TrackingError, TrackingReader, type HistoryPosition } from "./tracking-reader.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseCtor };
type Row = Record<string, unknown>;
type View = { view_id: string; run_id: string | null; follow_current: number; latest_seen_run: string | null; expires_at: number };
const TTL = 24 * 60 * 60 * 1000;
export const TRACKING_RESOURCE_URI = "ui://bridge/delegation-tracking.html";
export interface TrackingOptions {
  workspaceRoot: string;
  databasePath?: string;
  /** Configured by the server, never accepted as a tool argument. */
  principal: string;
  now?: () => number;
}

/** Preferences live in their own sidecar; bridge.db remains query-only. */
export class TrackingCoordinator {
  readonly reader: TrackingReader;
  readonly workspaceRef: string;
  readonly workspaceLabel: string;
  readonly principal: string;
  readonly statePath: string;
  private state?: InstanceType<typeof DatabaseCtor>;
  private readonly now: () => number;
  constructor(options: TrackingOptions) {
    const workspace = realpathSync(options.workspaceRoot);
    const dbPath = resolve(options.databasePath ?? resolve(workspace, ".bridge", "bridge.db"));
    this.workspaceRef = createHash("sha256").update(workspace).update("\0").update(dbPath).digest("hex").slice(0, 24);
    // A directory basename can itself be private. Export only a neutral short reference.
    this.workspaceLabel = `Projet ${this.workspaceRef.slice(0, 8)}`;
    this.principal = options.principal;
    this.statePath = resolve(dirname(dbPath), `${basename(dbPath)}.tracking-ui.sqlite`);
    this.reader = new TrackingReader(dbPath);
    this.now = options.now ?? Date.now;
  }

  private store(create = true): InstanceType<typeof DatabaseCtor> | undefined {
    if (this.state) return this.state;
    if (!create && !existsSync(this.statePath)) return undefined;
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    // SQLite otherwise inherits umask (often 0644); an existing .bridge may be 0755.
    try { closeSync(openSync(this.statePath, "wx", 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    const stateStat = lstatSync(this.statePath);
    if (!stateStat.isFile() || stateStat.isSymbolicLink() || (process.getuid && stateStat.uid !== process.getuid())) throw new TrackingError("UNSAFE_TRACKING_STATE");
    if (process.platform !== "win32") chmodSync(this.statePath, 0o600);
    const db = new DatabaseSync(this.statePath);
    try {
      db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;");
      const hasMetadata = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tracking_meta'").get());
      if (hasMetadata && (db.prepare("SELECT value FROM tracking_meta WHERE key='version'").get() as Row | undefined)?.["value"] !== "1") {
        throw new TrackingError("UNSUPPORTED_TRACKING_STATE");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS tracking_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tracking_preferences(principal TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tracking_views(view_id TEXT PRIMARY KEY,principal TEXT NOT NULL,context_key TEXT NOT NULL,
          run_id TEXT,follow_current INTEGER NOT NULL,closed INTEGER NOT NULL,expires_at INTEGER NOT NULL,latest_seen_run TEXT);
        CREATE INDEX IF NOT EXISTS idx_tracking_context ON tracking_views(principal,context_key,closed);`);
      db.prepare("INSERT OR IGNORE INTO tracking_meta VALUES('version','1')").run();
      if ((db.prepare("SELECT value FROM tracking_meta WHERE key='version'").get() as Row)["value"] !== "1") throw new TrackingError("UNSUPPORTED_TRACKING_STATE");
      // Additive sidecar upgrade only; the bridge database remains query-only.
      const viewColumns = db.prepare("PRAGMA table_info(tracking_views)").all() as Row[];
      if (!viewColumns.some(column => column["name"] === "latest_seen_run")) db.exec("ALTER TABLE tracking_views ADD COLUMN latest_seen_run TEXT");
      db.prepare("INSERT OR IGNORE INTO tracking_meta VALUES('secret',?)").run(randomBytes(32).toString("hex"));
      db.exec("COMMIT");
      this.state = db; return db;
    } catch (err) { try { db.exec("ROLLBACK"); } catch { /* initialization may have failed before BEGIN */ } db.close(); throw err; }
  }

  private secret(): string { return (this.store()!.prepare("SELECT value FROM tracking_meta WHERE key='secret'").get() as Row)["value"] as string; }
  private sign(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify({ ...payload, workspace: this.workspaceRef, principal: this.principal })).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret()).update(body).digest("base64url")}`;
  }
  private verify(token: string, type: string): Row {
    if (token.length > 2048 || !this.store(false)) throw new TrackingError("INVALID_CURSOR");
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw new TrackingError("INVALID_CURSOR");
    const expected = createHmac("sha256", this.secret()).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TrackingError("INVALID_CURSOR");
    let payload: Row;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Row; } catch { throw new TrackingError("INVALID_CURSOR"); }
    if (payload["type"] !== type || payload["workspace"] !== this.workspaceRef || payload["principal"] !== this.principal) throw new TrackingError("INVALID_CURSOR");
    return payload;
  }
  private view(viewId: string): View {
    const view = this.store(false)?.prepare("SELECT view_id,run_id,follow_current,latest_seen_run,expires_at FROM tracking_views WHERE view_id=? AND principal=? AND closed=0").get(viewId, this.principal) as View | undefined;
    if (!view || view.expires_at <= this.now()) throw new TrackingError("VIEW_CLOSED_OR_EXPIRED");
    return view;
  }

  open(args: { run_id?: string; context_key?: string; follow_current?: boolean } = {}) {
    if (args.run_id && !this.reader.runExists(args.run_id)) throw new TrackingError("RUN_NOT_FOUND");
    const db = this.store()!;
    const context = args.context_key ?? "default";
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(context)) throw new TrackingError("INVALID_CONTEXT");
    db.exec("BEGIN IMMEDIATE");
    let viewId: string;
    try {
      db.prepare("DELETE FROM tracking_views WHERE expires_at<=? OR closed=1").run(this.now());
      const current = db.prepare("SELECT view_id FROM tracking_views WHERE principal=? AND context_key=? AND closed=0 LIMIT 1").get(this.principal, context) as Row | undefined;
      viewId = current?.["view_id"] as string ?? `view_${randomBytes(16).toString("hex")}`;
      if (!current && Number((db.prepare("SELECT COUNT(*) AS n FROM tracking_views WHERE principal=? AND closed=0").get(this.principal) as Row)["n"]) >= 32) throw new TrackingError("VIEW_LIMIT");
      const latestRun = this.reader.latestRun();
      const runId = args.run_id ?? latestRun;
      db.prepare(`INSERT INTO tracking_views(view_id,principal,context_key,run_id,follow_current,closed,expires_at,latest_seen_run)
        VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(view_id) DO UPDATE SET run_id=excluded.run_id,
        follow_current=excluded.follow_current,closed=0,expires_at=excluded.expires_at,latest_seen_run=excluded.latest_seen_run`)
        .run(viewId, this.principal, context, runId, args.follow_current ?? !args.run_id ? 1 : 0, this.now() + TTL, latestRun);
      db.prepare("INSERT INTO tracking_preferences VALUES(?,1) ON CONFLICT(principal) DO UPDATE SET enabled=1").run(this.principal);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    return this.read({ view_id: viewId });
  }

  /** Called before a blocking delegation or after a new root, without opting anybody in. */
  followRun(runId: string): void {
    const db = this.store(false);
    if (!db) return;
    const preference = db.prepare("SELECT enabled FROM tracking_preferences WHERE principal=?").get(this.principal) as Row | undefined;
    if (preference?.["enabled"] === 1) db.prepare("UPDATE tracking_views SET run_id=?,latest_seen_run=? WHERE principal=? AND follow_current=1 AND closed=0 AND expires_at>?")
      .run(runId, this.reader.latestRun(), this.principal, this.now());
  }

  bind(args: { view_id: string; run_id: string | null }) {
    this.view(args.view_id);
    if (args.run_id && !this.reader.runExists(args.run_id)) throw new TrackingError("RUN_NOT_FOUND");
    const latestRun = this.reader.latestRun();
    this.store(false)!.prepare("UPDATE tracking_views SET run_id=?,follow_current=?,latest_seen_run=? WHERE view_id=? AND principal=?")
      .run(args.run_id ?? latestRun, args.run_id === null ? 1 : 0, latestRun, args.view_id, this.principal);
    return this.read({ view_id: args.view_id });
  }

  read(args: { view_id: string; after?: string }) {
    let view = this.view(args.view_id);
    // An independent observer can discover a new root even if the manager uses an older build.
    if (view.follow_current) {
      const run = this.reader.latestRun();
      // Follow only a root created since the last association. Another already-existing
      // root must not overwrite the manager's explicit run when work runs concurrently.
      if (run && run !== view.latest_seen_run) {
        this.store(false)!.prepare("UPDATE tracking_views SET run_id=?,latest_seen_run=? WHERE view_id=? AND principal=?").run(run, run, view.view_id, this.principal);
        view = { ...view, run_id: run, latest_seen_run: run };
      }
    }
    const cursor = args.after ? this.verify(args.after, "events") : undefined;
    if (cursor && (cursor["view"] !== view.view_id || cursor["run"] !== view.run_id)) throw new TrackingError("CURSOR_RESET_REQUIRED");
    const snapshot = this.reader.snapshot(view.run_id, cursor ? { database: cursor["database"] as string, event: cursor["event"] as number } : undefined);
    const { database, cursor_event, ...projection } = snapshot;
    return { schema_version: 1, workspace_ref: this.workspaceRef, workspace_label: this.workspaceLabel, view_id: view.view_id,
      run_id: view.run_id, ...projection, next_cursor: this.sign({ type: "events", view: view.view_id, run: view.run_id, database, event: cursor_event }),
      observed_at: this.now(), stale_after_ms: snapshot.tasks.some(task => ["QUEUED", "RUNNING"].includes(task.execution_phase ?? "") || ["PENDING", "CLAIMED", "WORKING", "VERIFYING"].includes(task.state)) ? 6000 : 30_000 };
  }

  history(args: { view_id: string; page_token?: string; state?: string; owner?: string; limit?: number }) {
    this.view(args.view_id);
    const cursor = args.page_token ? this.verify(args.page_token, "history") : undefined;
    if (cursor && (cursor["view"] !== args.view_id || cursor["state"] !== (args.state ?? null) || cursor["owner"] !== (args.owner ?? null))) throw new TrackingError("INVALID_CURSOR");
    const page = this.reader.history({ ...args, position: cursor?.["position"] as HistoryPosition | undefined });
    if (cursor && cursor["database"] !== page.database) throw new TrackingError("CURSOR_RESET_REQUIRED");
    return { schema_version: 1, workspace_ref: this.workspaceRef, items: page.items, has_more: page.has_more,
      next_page_token: page.position ? this.sign({ type: "history", view: args.view_id, state: args.state ?? null, owner: args.owner ?? null, database: page.database, position: page.position }) : null };
  }

  closeView(args: { view_id: string; disable?: boolean }) {
    this.view(args.view_id);
    const db = this.store(false)!;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.view(args.view_id);
      if (args.disable) {
        db.prepare("UPDATE tracking_preferences SET enabled=0 WHERE principal=?").run(this.principal);
        db.prepare("DELETE FROM tracking_views WHERE principal=?").run(this.principal);
      } else db.prepare("DELETE FROM tracking_views WHERE view_id=? AND principal=?").run(args.view_id, this.principal);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    return { closed: true, disabled: args.disable === true };
  }
  browserToken(viewId: string): string {
    const view = this.view(viewId);
    return this.sign({ type: "browser", view: viewId, expires: view.expires_at });
  }
  authorizeBrowser(token: string, viewId: string): boolean {
    try { const payload = this.verify(token, "browser"); return payload["view"] === viewId && typeof payload["expires"] === "number" && payload["expires"] > this.now() && !!this.view(viewId); } catch { return false; }
  }
  close(): void { this.reader.close(); this.state?.close(); this.state = undefined; }
}
