/** Shared-memory storage: real on-disk files, immutable revisions and cross-process CAS. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeError,
  ErrorCode,
  EventType,
  type MemoryLifecycle,
  type MemoryNote,
  type MemoryScope,
} from "@bridge/protocol";
import { SqliteStateStore } from "./sqlite-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-memory-store-"));
  resources.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}
function open(path: string): SqliteStateStore {
  const store = new SqliteStateStore({ path });
  resources.push(() => { try { store.close(); } catch { /* already closed */ } });
  return store;
}

const SCOPE: MemoryScope = { namespace: "development", context_id: "bridge", branch: "main", application_version: null, epoch: null };
const GLOBAL: MemoryScope = { namespace: "development", context_id: "bridge", branch: null, application_version: null, epoch: null };

function draft(scope: MemoryScope, key: string, revision: number, lifecycle: MemoryLifecycle = "active",
  extra: Partial<MemoryNote> = {}): MemoryNote {
  return {
    schema_version: 1, scope, key, revision, change_cursor: 0, at: 1_000 + revision, lifecycle,
    kind: "decision", title: `${key} r${revision}`, summary: `summary of ${key} at revision ${revision}`,
    references: [], related_task_ids: [], abandonment: null,
    provenance: { agent: "codex", task_id: "task_0000000001", run_id: "run_0000000001", attempt: 1 },
    ...extra,
  };
}

/** What the manager service does: event first, its id becomes the cursor, one transaction. */
function write(store: SqliteStateStore, note: MemoryNote, expected = note.revision - 1): MemoryNote {
  return store.transaction(() => {
    const event = store.appendEvent({ type: EventType.MEMORY_UPDATED, task_id: note.provenance.task_id,
      agent: note.provenance.agent, payload: { key: note.key, revision: note.revision } }, note.at);
    const stored = { ...note, change_cursor: event.event_id };
    store.insertMemoryNote(stored, expected);
    return stored;
  });
}

function caught(fn: () => unknown): BridgeError {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(BridgeError); return error as BridgeError; }
  throw new Error("expected a BridgeError");
}

describe("shared memory SQLite storage", () => {
  it("persists every immutable revision across a real close and reopen", () => {
    const path = join(directory(), "bridge.db");
    let store = open(path);
    const first = write(store, draft(SCOPE, "auth/flow", 1, "active", {
      references: [{ artifact_id: "art_0000000001", sha256: "a".repeat(64), record_type: "hypothesis", record_id: "h-1" }],
      related_task_ids: ["task_0000000007"],
    }));
    const second = write(store, draft(SCOPE, "auth/flow", 2, "archived", {
      kind: "abandoned-track", summary: "track closed: é ✓",
      abandonment: { reason: "no exploitable path", tested_conditions: "roles A/B, stale token", reopen_when: "new role ships" },
    }));
    store.close();

    store = open(path);
    expect(store.getMemoryNote(SCOPE, "auth/flow")).toEqual(second);
    expect(store.getMemoryNote(SCOPE, "auth/flow", first.change_cursor)).toEqual(first);
    expect(store.getMemoryNote(SCOPE, "auth/flow", first.change_cursor - 1)).toBeUndefined();
    expect(store.listMemoryChanges({ scope: SCOPE, after: 0, before_cursor: store.lastEventId(), limit: 10 }))
      .toEqual([first, second]);
    store.close();

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "6" });
      expect(() => raw.prepare("UPDATE memory_notes SET lifecycle='active'").run()).toThrow(/immutable/);
      expect(() => raw.prepare("DELETE FROM memory_notes").run()).toThrow(/immutable/);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM memory_notes").get()).toEqual({ n: 2 });
      const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_notes'").all().map(row => row["name"]);
      expect(indexes).toEqual(expect.arrayContaining(["idx_memory_scope_key_revision", "idx_memory_scope_cursor"]));
    } finally { raw.close(); }
  });

  it("filters on each key's latest revision so archived history never resurrects an older active note", () => {
    const store = open(join(directory(), "bridge.db"));
    write(store, draft(SCOPE, "a", 1));
    const archived = write(store, draft(SCOPE, "a", 2, "archived"));
    const b = write(store, draft(SCOPE, "b", 1));
    write(store, draft(SCOPE, "c", 1));
    write(store, draft(SCOPE, "c", 2, "superseded"));
    const c3 = write(store, draft(SCOPE, "c", 3, "active"));
    const now = store.lastEventId();

    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, lifecycles: ["active"], limit: 10 })).toEqual([b, c3]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, limit: 10 })).toEqual([archived, b, c3]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, lifecycles: ["superseded"], limit: 10 })).toEqual([]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, keys: ["a", "c", "missing"], lifecycles: ["active", "archived"], limit: 10 }))
      .toEqual([archived, c3]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, keys: [], limit: 10 })).toEqual([]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: now, lifecycles: [], limit: 10 })).toEqual([]);
    // Before the archive the active revision 1 was the latest and is the correct snapshot answer.
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: archived.change_cursor - 1, keys: ["a"], lifecycles: ["active"], limit: 10 })
      .map(note => note.revision)).toEqual([1]);
    expect(store.getMemoryNote(SCOPE, "a")?.lifecycle).toBe("archived");
  });

  it("keeps cursor snapshots and pages stable while newer revisions are appended", () => {
    const store = open(join(directory(), "bridge.db"));
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    const initial = keys.map(key => write(store, draft(SCOPE, key, 1)));
    const snapshot = store.lastEventId();
    const page1 = store.listMemoryNotes({ scope: SCOPE, before_cursor: snapshot, limit: 2 });
    write(store, draft(SCOPE, "k3", 2, "archived"));
    write(store, draft(SCOPE, "k0", 1));
    write(store, draft(SCOPE, "k9", 1));
    const page2 = store.listMemoryNotes({ scope: SCOPE, before_cursor: snapshot, after_key: page1.at(-1)!.key, limit: 2 });
    const page3 = store.listMemoryNotes({ scope: SCOPE, before_cursor: snapshot, after_key: page2.at(-1)!.key, limit: 2 });
    expect([...page1, ...page2, ...page3]).toEqual(initial);
    expect(store.getMemoryNote(SCOPE, "k3", snapshot)).toEqual(initial[2]);

    const latest = store.lastEventId();
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: latest, limit: 100 }).map(n => `${n.key}:${n.revision}`))
      .toEqual(["k0:1", "k1:1", "k2:1", "k3:2", "k4:1", "k5:1", "k9:1"]);
    const changes = store.listMemoryChanges({ scope: SCOPE, after: snapshot, before_cursor: latest, limit: 100 });
    expect(changes.map(n => `${n.key}:${n.revision}`)).toEqual(["k3:2", "k0:1", "k9:1"]);
    expect(changes.map(n => n.change_cursor)).toEqual([...changes.map(n => n.change_cursor)].sort((x, y) => x - y));
    // Inclusive upper bound, exclusive lower bound, limit.
    expect(store.listMemoryChanges({ scope: SCOPE, after: snapshot, before_cursor: changes[0]!.change_cursor, limit: 100 })).toEqual([changes[0]]);
    expect(store.listMemoryChanges({ scope: SCOPE, after: changes[0]!.change_cursor, before_cursor: latest, limit: 1 })).toEqual([changes[1]]);
    expect(caught(() => store.listMemoryNotes({ scope: SCOPE, before_cursor: latest, limit: 0 })).code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(caught(() => store.listMemoryChanges({ scope: SCOPE, after: -1, before_cursor: latest, limit: 1 })).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it("orders keys by binary comparison with an exclusive after_key", () => {
    const store = open(join(directory(), "bridge.db"));
    for (const key of ["b", "B", "a", "_", "aa", "é"]) write(store, draft(SCOPE, key, 1));
    const all = store.listMemoryNotes({ scope: SCOPE, before_cursor: store.lastEventId(), limit: 100 }).map(n => n.key);
    expect(all).toEqual(["B", "_", "a", "aa", "b", "é"]);
    expect(store.listMemoryNotes({ scope: SCOPE, before_cursor: store.lastEventId(), after_key: "a", limit: 2 }).map(n => n.key))
      .toEqual(["aa", "b"]);
  });

  it("separates scopes exactly, including explicit null qualifiers, with no implicit mixing", () => {
    const store = open(join(directory(), "bridge.db"));
    const scopes: MemoryScope[] = [
      SCOPE, GLOBAL,
      { ...GLOBAL, branch: "null" },
      { ...SCOPE, namespace: "bug-bounty" },
      { ...SCOPE, context_id: "bridge-2" },
      { ...SCOPE, application_version: "1.2.0" },
      { ...SCOPE, epoch: "2026-10" },
    ];
    const written = scopes.map((scope, index) => write(store, draft(scope, "shared-key", 1, "active", { title: `scope ${index}` })));
    const now = store.lastEventId();
    scopes.forEach((scope, index) => {
      expect(store.getMemoryNote(scope, "shared-key")).toEqual(written[index]);
      expect(store.listMemoryNotes({ scope, before_cursor: now, limit: 100 })).toEqual([written[index]]);
      expect(store.listMemoryChanges({ scope, after: 0, before_cursor: now, limit: 100 })).toEqual([written[index]]);
    });
    // A revision in one scope does not satisfy or conflict with another scope's CAS.
    write(store, draft(SCOPE, "shared-key", 2));
    expect(store.getMemoryNote(GLOBAL, "shared-key")?.revision).toBe(1);
    expect(caught(() => write(store, draft(GLOBAL, "shared-key", 3), 2)).code).toBe(ErrorCode.REVISION_CONFLICT);
  });

  it("compare-and-swap never silently overwrites and rejects malformed revisions or cursors", () => {
    const store = open(join(directory(), "bridge.db"));
    const first = write(store, draft(SCOPE, "plan", 1));
    const duplicate = caught(() => write(store, draft(SCOPE, "plan", 1, "active", { summary: "competing create" })));
    expect(duplicate.code).toBe(ErrorCode.REVISION_CONFLICT);
    expect(duplicate.details).toEqual({ key: "plan", expected_revision: 0, current_revision: 1 });
    const second = write(store, draft(SCOPE, "plan", 2));
    const stale = caught(() => write(store, draft(SCOPE, "plan", 2, "active", { summary: "stale merge" }), 1));
    expect(stale.details).toEqual({ key: "plan", expected_revision: 1, current_revision: 2 });
    const ahead = caught(() => write(store, draft(SCOPE, "plan", 6), 5));
    expect(ahead).toMatchObject({ code: ErrorCode.REVISION_CONFLICT, details: { key: "plan", expected_revision: 5, current_revision: 2 } });
    expect(caught(() => write(store, draft(SCOPE, "plan", 4), 2)).code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(caught(() => write(store, draft(SCOPE, "plan", 0), -1)).code).toBe(ErrorCode.INVALID_ARGUMENT);
    // The cursor must be a new, globally increasing event id.
    expect(caught(() => store.insertMemoryNote({ ...draft(SCOPE, "other", 1), change_cursor: second.change_cursor }, 0)).code)
      .toBe(ErrorCode.INVALID_ARGUMENT);
    expect(caught(() => store.insertMemoryNote({ ...draft(SCOPE, "other", 1), change_cursor: 0 }, 0)).code)
      .toBe(ErrorCode.INVALID_ARGUMENT);
    expect(store.listMemoryChanges({ scope: SCOPE, after: 0, before_cursor: store.lastEventId(), limit: 100 })).toEqual([first, second]);
  });

  it("rolls back the outer event and idempotency reservation when the insert fails", () => {
    const store = open(join(directory(), "bridge.db"));
    const first = write(store, draft(SCOPE, "plan", 1));
    const lastEvent = store.lastEventId();
    const error = caught(() => store.transaction(() => {
      store.putIdempotency({ key: "memory-write-1", operation: "memory.write", request_hash: "f".repeat(64), response_json: "{}", created_at: 5 });
      const event = store.appendEvent({ type: EventType.MEMORY_UPDATED, task_id: "task_0000000001", agent: "codex", payload: { key: "plan" } }, 5);
      store.insertMemoryNote({ ...draft(SCOPE, "plan", 1, "archived"), change_cursor: event.event_id }, 0);
    }));
    expect(error.code).toBe(ErrorCode.REVISION_CONFLICT);
    expect(store.lastEventId()).toBe(lastEvent);
    expect(store.readEvents({ after: lastEvent })).toEqual([]);
    expect(store.getIdempotency("memory-write-1")).toBeUndefined();
    expect(store.getMemoryNote(SCOPE, "plan")).toEqual(first);

    // A failure after a successful insert also removes the note, not just the event.
    const lastBefore = store.lastEventId();
    expect(() => store.transaction(() => {
      write(store, draft(SCOPE, "plan", 2));
      throw new Error("later step failed");
    })).toThrow("later step failed");
    expect(store.lastEventId()).toBe(lastBefore);
    expect(store.getMemoryNote(SCOPE, "plan")).toEqual(first);
    // The storage layer emitted no event of its own: one write, one manager event.
    const next = write(store, draft(SCOPE, "plan", 2));
    expect(store.readEvents({ after: lastBefore }).map(event => [event.event_id, event.type]))
      .toEqual([[next.change_cursor, EventType.MEMORY_UPDATED]]);
  });

  it("lets exactly one of two independent processes win the same revision on one SQLite file", async () => {
    const dir = directory(), path = join(dir, "bridge.db");
    const bundle = join(dir, "sqlite-store.bundle.mjs");
    // Bundle the current source, not a possibly stale dist build.
    await build({
      entryPoints: [join(sourceRoot, "shared/control-plane/src/store/sqlite-store.ts")],
      bundle: true, platform: "node", format: "esm", target: "node22", outfile: bundle, logLevel: "silent",
      alias: { "@bridge/protocol": join(sourceRoot, "shared/protocol/src/index.ts") },
    });
    const worker = join(dir, "race.mjs");
    writeFileSync(worker, `import { existsSync } from 'node:fs';
import { SqliteStateStore } from ${JSON.stringify(pathToFileURL(bundle).href)};
const [database, barrier, agent, expected, noteJson] = process.argv.slice(2);
const store = new SqliteStateStore({ path: database });
process.stdout.write('ready\\n');
for (let n = 0; !existsSync(barrier); n++) { if (n > 2000) throw new Error('fixture barrier timeout'); await new Promise(r => setTimeout(r, 2)); }
let result;
try {
  store.transaction(() => {
    const note = { ...JSON.parse(noteJson), provenance: { agent, task_id: 'task_0000000001', run_id: 'run_0000000001', attempt: 1 } };
    const event = store.appendEvent({ type: 'memory.updated', task_id: 'task_0000000001', agent, payload: { key: note.key } }, note.at);
    store.insertMemoryNote({ ...note, change_cursor: event.event_id }, Number(expected));
  });
  result = { agent, ok: true };
} catch (error) {
  // An expected conflict is a successful fixture outcome: report it and exit 0.
  result = { agent, ok: false, code: error.code ?? null, details: error.details ?? null, message: String(error.message) };
} finally { store.close(); }
process.stdout.write(JSON.stringify(result) + '\\n');
`);
    const seed = open(path);
    write(seed, draft(SCOPE, "existing", 1));
    seed.close();

    async function race(round: string, key: string, expected: number): Promise<any[]> {
      const barrier = join(dir, `${round}.marker`);
      const children = ["claude", "codex"].map(agent => {
        const child = spawn(process.execPath, [worker, path, barrier, agent, String(expected), JSON.stringify(draft(SCOPE, key, expected + 1, "active", { summary: `${agent} wins` }))],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        resources.push(() => { if (child.exitCode === null) child.kill(); });
        let stdout = "", stderr = "", markReady!: () => void;
        const ready = new Promise<void>(r => { markReady = r; });
        child.stdout!.on("data", value => { stdout += String(value); if (stdout.startsWith("ready\n")) markReady(); });
        child.stderr!.on("data", value => { stderr += String(value); });
        const done = new Promise<any>((resolveDone, reject) => {
          child.once("error", reject);
          child.once("close", code => {
            if (code !== 0) reject(new Error(`race worker exited ${code}: ${stderr.slice(-500)}`));
            else { try { resolveDone(JSON.parse(stdout.trim().split("\n").at(-1)!)); } catch (error) { reject(error); } }
          });
        });
        return { ready, done };
      });
      await Promise.all(children.map(c => c.ready));
      writeFileSync(barrier, "go");
      return Promise.all(children.map(c => c.done));
    }

    for (const [round, key, expected] of [["create", "contested", 0], ["update", "existing", 1]] as const) {
      const results = await race(round, key, expected);
      const winners = results.filter(r => r.ok), losers = results.filter(r => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ code: ErrorCode.REVISION_CONFLICT, details: { key, expected_revision: expected, current_revision: expected + 1 } });
      const store = open(path);
      try {
        const stored = store.getMemoryNote(SCOPE, key)!;
        expect(stored.revision).toBe(expected + 1);
        expect(stored.provenance.agent).toBe(winners[0].agent);
        expect(stored.summary).toBe(`${winners[0].agent} wins`);
        // The loser's event rolled back with its insert: cursor is the latest event id.
        expect(stored.change_cursor).toBe(store.lastEventId());
        expect(store.listMemoryChanges({ scope: SCOPE, after: 0, before_cursor: store.lastEventId(), limit: 100 })
          .filter(n => n.key === key).map(n => n.revision)).toEqual(Array.from({ length: expected + 1 }, (_, i) => i + 1));
      } finally { store.close(); }
    }
    expect(existsSync(bundle)).toBe(true);
  });
});
