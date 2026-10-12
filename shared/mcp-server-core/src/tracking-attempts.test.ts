/** Read-only compatibility against local database fixtures, never a user bridge database. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane, ManualClock } from "@bridge/control-plane";
import { seededRandom, type Deliverable, type VerificationResult } from "@bridge/protocol";
import { TrackingReader } from "./tracking-reader.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const pass: VerificationResult = { kind: "test", command: "PRIVATE_PASS", passed: true, exit_code: 0, summary: "PRIVATE_PASS_SUMMARY" };
const fail: VerificationResult = { ...pass, command: "PRIVATE_FAIL", passed: false, exit_code: 1 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-tracking-attempts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.db"); const clock = new ManualClock();
  const cp = ControlPlane.open({ workspaceRoot: dir, databasePath: path, journalMode: "DELETE", clock, rng: seededRandom(972) });
  cleanups.push(() => cp.close());
  const task = cp.tasks.create({ created_by: "codex", spec: { objective: "PRIVATE_OBJECTIVE", scope: { paths: ["(no-write)/**"] },
    dependencies: [], expected_deliverable: "report", verification_criteria: ["check"] } });
  cp.tasks.claim(task.task_id, "codex"); cp.tasks.transition({ task_id: task.task_id, agent: "codex", to: "WORKING" });
  const reader = new TrackingReader(path); cleanups.push(() => reader.close());
  const submit = (checks: VerificationResult[], status: Deliverable["status"]) => cp.deliverables.submit({ task_id: task.task_id, agent: "codex",
    status, summary: "PRIVATE_SUMMARY", changed_scope: [], artifacts: [], commit_or_diff: null, verification_performed: [],
    verification_results: checks, remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: clock.now() });
  return { path, cp, task, reader, submit };
}
function writable(path: string) { const db = new DatabaseSync(path); cleanups.push(() => db.close()); return db; }

describe("tracking schema4/5/6 and attempt freshness", () => {
  it("counts only the new attempt's callback checks and ignores an old partial deliverable", () => {
    const { path, cp, task, reader, submit } = fixture();
    cp.deliverables.recordVerification(task.task_id, "codex", fail); submit([fail], "PARTIAL");
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 0, failed: 1 });
    const db = writable(path); db.prepare("UPDATE tasks SET attempt=1,state='WORKING' WHERE task_id=?").run(task.task_id);
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 0, failed: 0 });
    cp.deliverables.recordVerification(task.task_id, "codex", pass, 1);
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 1, failed: 0 });
    submit([pass], "COMPLETE");
    const snapshot = reader.snapshot(task.run_id);
    expect(snapshot.tasks[0]?.verification).toEqual({ passed: 1, failed: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
  });

  it("ignores NULL historical freshness in schema5 while retaining the rows", () => {
    const { path, task, reader } = fixture(); const db = writable(path);
    db.prepare("INSERT INTO verifications(task_id,kind,passed,json,attempt) VALUES(?,'test',1,?,NULL)").run(task.task_id, JSON.stringify(pass));
    db.prepare("INSERT INTO deliverables(task_id,agent,status,at,json,attempt) VALUES(?,'codex','COMPLETE',1,?,NULL)")
      .run(task.task_id, JSON.stringify({ verification_results: [pass] }));
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 0, failed: 0 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM verifications").get()).toMatchObject({ total: 1 });
  });

  it("reads a schema4 database without attempt columns and does not migrate or write it", () => {
    const { path, cp, task, reader } = fixture();
    cp.deliverables.recordVerification(task.task_id, "codex", pass); cp.close();
    const db = writable(path);
    db.exec("DROP INDEX idx_verif_task_attempt; ALTER TABLE verifications DROP COLUMN attempt; ALTER TABLE deliverables DROP COLUMN attempt; UPDATE schema_meta SET value='4' WHERE key='schema_version';");
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 1, failed: 0 });
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
    const unchanged = new DatabaseSync(path, { readOnly: true });
    try {
      expect(unchanged.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toMatchObject({ value: "4" });
      expect(unchanged.prepare("PRAGMA table_info(verifications)").all().some(row => row["name"] === "attempt")).toBe(false);
    } finally { unchanged.close(); }
  });

  it("detects a schema4-to5 upgrade on an already-open reader", () => {
    const { path, cp, task, reader } = fixture(); cp.deliverables.recordVerification(task.task_id, "codex", pass);
    const db = writable(path); db.exec("UPDATE schema_meta SET value='4' WHERE key='schema_version';");
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 1, failed: 0 });
    db.exec("UPDATE schema_meta SET value='5' WHERE key='schema_version'; UPDATE verifications SET attempt=NULL;");
    expect(reader.snapshot(task.run_id).tasks[0]?.verification).toEqual({ passed: 0, failed: 0 });
  });

  it("reads schema6 memory alongside attempt evidence without exposing working-note content", () => {
    const { path, cp, task, reader } = fixture();
    cp.deliverables.recordVerification(task.task_id, "codex", pass);
    cp.memory.upsert({ task_id: task.task_id, agent: "codex", key: "private-note", expected_revision: 0, idempotency_key: "private-note",
      scope: { namespace: "development", context_id: "PRIVATE_CONTEXT", branch: null, application_version: null, epoch: null },
      note: { kind: "decision", title: "PRIVATE_TITLE", summary: "PRIVATE_MEMORY", lifecycle: "active", references: [], related_task_ids: [], abandonment: null } });
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toMatchObject({ value: "6" }); } finally { db.close(); }
    const snapshot = reader.snapshot(task.run_id);
    expect(snapshot.tasks[0]?.verification).toEqual({ passed: 1, failed: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
  });
});
