import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";
import { BridgeError, ErrorCode, EventType, seededRandom, type MemoryNoteDraft, type MemoryScope, type Task } from "@bridge/protocol";

const scope: MemoryScope = { namespace: "bug-bounty", context_id: "fixture-program", branch: null, application_version: "v1", epoch: "epoch-1" };
const draft = (overrides: Partial<MemoryNoteDraft> = {}): MemoryNoteDraft => ({ kind: "observation", title: "Working observation", summary: "A comparison still needs an independent witness.", lifecycle: "active", references: [], related_task_ids: [], abandonment: null, ...overrides });
let cp: ControlPlane, clock: ManualClock, dir: string, codex: Task, claude: Task;
function task(agent: string): Task {
  const created = cp.tasks.create({ created_by: agent, spec: { objective: "PRIVATE_OBJECTIVE", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "note", verification_criteria: ["local fixture"] } });
  cp.tasks.claim(created.task_id, agent); return cp.tasks.transition({ task_id: created.task_id, agent, to: "WORKING" });
}
function write(key: string, expected = 0, note = draft(), actor = codex, context = scope, idem = `${actor.task_id}:${key}:${expected}`) {
  return cp.memory.upsert({ scope: context, key, expected_revision: expected, note, task_id: actor.task_id, agent: actor.owner!, idempotency_key: idem });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-memory-service-")); clock = new ManualClock();
  cp = ControlPlane.open({ workspaceRoot: dir, databasePath: ":memory:", clock, rng: seededRandom(350) });
  codex = task("codex"); claude = task("claude");
});
afterEach(() => { cp.close(); rmSync(dir, { recursive: true, force: true }); });

describe("shared working-memory contracts", () => {
  it("binds provenance to the actual current task and keeps revisions from both agents", () => {
    const first = write("business-track");
    const second = write("business-track", 1, draft({ summary: "Claude identified the missing workflow prerequisite." }), claude);
    expect(first.provenance).toEqual({ agent: "codex", task_id: codex.task_id, run_id: codex.run_id, attempt: 0 });
    expect(second.provenance.agent).toBe("claude"); expect(second.revision).toBe(2);
    expect(cp.memory.getContext({ scope }).notes.map(note => note.summary)).toEqual([second.summary]);
    expect(cp.memory.getChanges({ scope }).changes.map(note => [note.revision, note.provenance.agent])).toEqual([[1, "codex"], [2, "claude"]]);
    expect(cp.store.readEvents({ types: [EventType.MEMORY_UPDATED] }).map(event => event.event_id)).toEqual([first.change_cursor, second.change_cursor]);
  });

  it("returns an explicit revision conflict rather than replacing a stale write", () => {
    write("track");
    expect(() => write("track", 0, draft({ summary: "stale" }), claude)).toThrow(expect.objectContaining({ code: ErrorCode.REVISION_CONFLICT, details: expect.objectContaining({ current_revision: 1 }) }));
    expect(cp.memory.getChanges({ scope }).changes).toHaveLength(1);
  });

  it("makes identical retries idempotent, rejects changed payload and returns no new revision", () => {
    const first = write("track", 0, draft(), codex, scope, "retry");
    expect(write("track", 0, draft(), codex, scope, "retry")).toEqual(first);
    expect(() => write("track", 0, draft({ summary: "changed" }), codex, scope, "retry")).toThrow(expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_MISMATCH }));
    expect(cp.memory.getChanges({ scope }).changes).toHaveLength(1);
  });

  it("requires caller ownership and an active task for a new write", () => {
    expect(() => cp.memory.upsert({ scope, key: "foreign", expected_revision: 0, note: draft(), task_id: codex.task_id, agent: "claude", idempotency_key: "foreign" })).toThrow(expect.objectContaining({ code: ErrorCode.NOT_OWNER }));
    cp.tasks.transition({ task_id: codex.task_id, agent: "codex", to: "BLOCKED", reason: "paused" });
    expect(() => write("inactive")).toThrow(expect.objectContaining({ code: ErrorCode.ILLEGAL_TRANSITION }));
    expect(cp.memory.getChanges({ scope }).changes).toEqual([]);
  });

  it("can replay a committed request after its task finishes without creating a new revision", () => {
    const first = write("completed", 0, draft(), codex, scope, "completed-request");
    cp.deliverables.submit({ task_id: codex.task_id, agent: "codex", status: "COMPLETE", summary: "Fixture assertions passed", changed_scope: [], artifacts: [], commit_or_diff: null,
      verification_performed: [], verification_results: [{ kind: "manual", command: "Assert memory write returned revision1", passed: true, exit_code: null, summary: "Fixture checked above" }], remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: clock.now() });
    expect(write("completed", 0, draft(), codex, scope, "completed-request")).toEqual(first);
    expect(() => write("new-after-complete")).toThrow(expect.objectContaining({ code: ErrorCode.ILLEGAL_TRANSITION }));
    expect(cp.memory.getChanges({ scope }).changes).toHaveLength(1);
  });

  it("preserves active/superseded/archived history without resurrecting an older active note", () => {
    write("decision"); write("decision", 1, draft({ lifecycle: "superseded" }), claude);
    expect(cp.memory.getContext({ scope }).notes).toEqual([]);
    expect(cp.memory.getContext({ scope, lifecycles: ["superseded"] }).notes[0]?.revision).toBe(2);
    write("decision", 2, draft({ lifecycle: "archived" }));
    expect(cp.memory.getContext({ scope, lifecycles: ["active", "superseded"] }).notes).toEqual([]);
    expect(cp.memory.getChanges({ scope }).changes.map(note => note.lifecycle)).toEqual(["active", "superseded", "archived"]);
  });

  it("keeps rejected-work rationale, tested conditions and reopening trigger explicit", () => {
    expect(() => write("abandoned", 0, draft({ kind: "abandoned-track" }))).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
    const abandonment = { reason: "Current actor cannot reach this transition.", tested_conditions: "Two controlled actors, v1, workflow draft.", reopen_when: "New actor or workflow transition becomes available." };
    write("abandoned", 0, draft({ kind: "abandoned-track", abandonment }));
    expect(cp.memory.getContext({ scope }).notes[0]?.abandonment).toEqual(abandonment);
    expect(() => write("fake-finding", 0, { ...draft(), verdict: "confirmed" } as MemoryNoteDraft)).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
  });

  it.each([
    { ...scope, context_id: "another-program" }, { ...scope, epoch: "epoch-2" },
    { ...scope, application_version: "v2" }, { ...scope, branch: "new-branch" },
    { ...scope, namespace: "development" as const },
  ])("does not mix a different explicit context %j", otherScope => {
    write("track"); expect(cp.memory.getContext({ scope: otherScope }).notes).toEqual([]);
    expect(cp.memory.getChanges({ scope: otherScope }).changes).toEqual([]);
  });

  it("uses explicit versionless scopes for durable notes without an implicit epoch merge", () => {
    const durable = { ...scope, namespace: "development" as const, application_version: null, epoch: null };
    write("architecture", 0, draft({ kind: "decision" }), codex, durable);
    expect(cp.memory.getContext({ scope: durable }).notes).toHaveLength(1);
    expect(cp.memory.getContext({ scope: { ...durable, epoch: "new" } }).notes).toHaveLength(0);
  });

  it("retains large-map artifact references without loading the 150 endpoints or 8 hypotheses", () => {
    const map = JSON.stringify({ endpoints: Array.from({ length: 150 }, (_, n) => `/fixture/objects/${n}`), hypotheses: Array.from({ length: 8 }, (_, n) => `fixture-hypothesis-${n}`), marker: "PRIVATE_CAPTURE_BODY" });
    const artifact = cp.artifacts.publish({ task_id: codex.task_id, produced_by: "codex", kind: "json", name: "campaign-map.json", inline: map });
    write("map", 0, draft({ references: [{ artifact_id: artifact.artifact_id, sha256: artifact.sha256, record_type: "campaign", source_epoch: "epoch-1" }], related_task_ids: [claude.task_id] }));
    const context = cp.memory.getContext({ scope, max_bytes: 2048 });
    expect(context.notes[0]?.references[0]?.artifact_id).toBe(artifact.artifact_id);
    expect(context.notes[0]?.reference_states[0]?.status).toBe("intact");
    expect(context.pending_tasks).toEqual([{ task_id: claude.task_id, state: "WORKING" }]);
    expect(JSON.stringify(context)).not.toContain("PRIVATE_CAPTURE_BODY");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_OBJECTIVE");
    expect(Buffer.byteLength(JSON.stringify(context, null, 2))).toBeLessThanOrEqual(2048);
  });

  it("refuses absent or wrong-hash sources and flags a later changed path source", () => {
    expect(() => write("missing", 0, draft({ references: [{ artifact_id: "art_missing", sha256: "a".repeat(64) }] }))).toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND }));
    writeFileSync(join(dir, "capture.json"), '{"capture":"original"}');
    const artifact = cp.artifacts.publish({ task_id: codex.task_id, produced_by: "codex", kind: "json", name: "capture.json", path: "capture.json" });
    expect(() => write("wrong", 0, draft({ references: [{ artifact_id: artifact.artifact_id, sha256: "a".repeat(64) }] }))).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
    write("capture", 0, draft({ references: [{ artifact_id: artifact.artifact_id, sha256: artifact.sha256 }] }));
    writeFileSync(join(dir, "capture.json"), '{"capture":"changed"}');
    expect(cp.memory.getContext({ scope }).notes[0]?.reference_states[0]?.status).toBe("content-changed");
    expect(cp.memory.getChanges({ scope }).changes[0]?.references[0]?.sha256).toBe(artifact.sha256);
  });

  it("reports oversized context notes explicitly and does not advance past an undelivered change", () => {
    write("long", 0, draft({ summary: "😀".repeat(800) }));
    const tiny = cp.memory.getContext({ scope, max_bytes: 2048 });
    expect(tiny.notes).toEqual([]); expect(tiny.omitted[0]?.key).toBe("long");
    expect(cp.memory.getContext({ scope, keys: ["long"], max_bytes: 16384 }).notes[0]?.summary).toBe("😀".repeat(800));
    expect(() => cp.memory.getChanges({ scope, change_cursor: 0, max_bytes: 2048 })).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT, details: expect.objectContaining({ change_cursor: 0 }) }));
    expect(cp.memory.getChanges({ scope, max_bytes: 16384 }).changes).toHaveLength(1);
  });

  it("returns a budget validation error when a valid multibyte scope cannot fit its empty envelope", () => {
    const largeScope: MemoryScope = { ...scope, context_id: "界".repeat(128), branch: "界".repeat(256), application_version: "界".repeat(256), epoch: "界".repeat(256) };
    expect(() => cp.memory.getContext({ scope: largeScope, max_bytes: 2048 })).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT, details: expect.objectContaining({ minimum_bytes: expect.any(Number) }) }));
    expect(() => cp.memory.getChanges({ scope: largeScope, max_bytes: 2048 })).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
    expect(cp.memory.getContext({ scope: largeScope, max_bytes: 8192 }).notes).toEqual([]);
    expect(cp.memory.getChanges({ scope: largeScope, max_bytes: 8192 }).changes).toEqual([]);
  });

  it("pages a consistent context snapshot despite a later lifecycle update", () => {
    write("a"); write("b");
    const first = cp.memory.getContext({ scope, limit: 1 });
    expect(first.notes[0]?.key).toBe("a"); expect(first.has_more).toBe(true);
    write("b", 1, draft({ lifecycle: "archived" }), claude);
    const second = cp.memory.getContext({ scope, limit: 1, after_key: first.next_key!, at_cursor: first.change_cursor });
    expect(second.notes.map(note => [note.key, note.revision])).toEqual([["b", 1]]);
    expect(cp.memory.getContext({ scope }).notes.map(note => note.key)).toEqual(["a"]);
  });

  it("pages only delivered deltas and recovers history across interleaved scopes/events", () => {
    const a = write("a"); task("codex");
    write("other", 0, draft(), codex, { ...scope, context_id: "other" });
    const b = write("b"); const c = write("a", 1, draft(), claude);
    const first = cp.memory.getChanges({ scope, limit: 1 });
    const later = write("later");
    const second = cp.memory.getChanges({ scope, limit: 1, change_cursor: first.change_cursor, until_cursor: first.head_cursor });
    const third = cp.memory.getChanges({ scope, limit: 1, change_cursor: second.change_cursor, until_cursor: first.head_cursor });
    expect([first.changes[0]?.change_cursor, second.changes[0]?.change_cursor, third.changes[0]?.change_cursor]).toEqual([a.change_cursor, b.change_cursor, c.change_cursor]);
    expect(third.has_more).toBe(false);
    expect(cp.memory.getChanges({ scope, change_cursor: third.change_cursor }).changes[0]?.change_cursor).toBe(later.change_cursor);
    expect(cp.memory.getChanges({ scope, change_cursor: later.change_cursor }).change_cursor).toBe(later.change_cursor);
    expect(() => cp.memory.getChanges({ scope, change_cursor: cp.store.lastEventId() + 1 })).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
  });

  it("rolls back the revision, change event and retry cache on storage failure", () => {
    const before = cp.store.lastEventId();
    const insert = vi.spyOn(cp.store, "insertMemoryNote").mockImplementationOnce(() => { throw new BridgeError(ErrorCode.INTERNAL, "simulated disk failure"); });
    expect(() => write("atomic", 0, draft(), codex, scope, "atomic")).toThrow("simulated disk failure");
    expect(cp.store.lastEventId()).toBe(before); expect(cp.memory.getChanges({ scope }).changes).toEqual([]);
    insert.mockRestore();
    expect(write("atomic", 0, draft(), codex, scope, "atomic").revision).toBe(1);
  });
});
