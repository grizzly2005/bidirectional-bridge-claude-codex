import {
  assertValid, BridgeError, ErrorCode, EventType, TaskState, TERMINAL_STATES,
  MemoryNoteDraftSchema, MemoryScopeSchema, MEMORY_MAX_NOTE_BYTES,
  MEMORY_DEFAULT_CONTEXT_BYTES, MEMORY_MAX_RESPONSE_BYTES,
  type AgentId, type MemoryScope, type MemoryNote, type MemoryNoteDraft,
  type MemoryLifecycle, type TaskId,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { ArtifactRegistry } from "./artifact-registry.js";
import type { StateStore } from "./store/state-store.js";
import { runIdempotent } from "./idempotency.js";

export interface MemoryUpsertInput {
  readonly scope: MemoryScope;
  readonly key: string;
  readonly expected_revision: number;
  readonly note: MemoryNoteDraft;
  readonly task_id: TaskId;
  readonly agent: AgentId;
  readonly idempotency_key: string;
}
export interface MemoryContextInput {
  readonly scope: MemoryScope;
  readonly keys?: readonly string[];
  readonly lifecycles?: readonly MemoryLifecycle[];
  readonly after_key?: string;
  readonly at_cursor?: number;
  readonly limit?: number;
  readonly max_bytes?: number;
}
export interface MemoryChangesInput {
  readonly scope: MemoryScope;
  readonly change_cursor?: number;
  readonly until_cursor?: number;
  readonly limit?: number;
  readonly max_bytes?: number;
}
// Match the MCP text envelope rather than undercounting its pretty-printed payload.
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;
function checkKey(key: string): void {
  if (typeof key !== "string" || !keyPattern.test(key)) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory key must be a stable 1-128 character identifier");
}
function integer(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `${name} must be an integer from ${min} to ${max}`);
  return selected;
}
function scopeCopy(scope: MemoryScope): MemoryScope {
  assertValid(scope, MemoryScopeSchema, "Memory scope");
  if (Object.values(scope).some(value => typeof value === "string" && (!value.trim() || /[\u0000-\u001f]/u.test(value)))) {
    throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory scope fields must be nonblank identifiers without control characters");
  }
  return structuredClone(scope);
}
function requireBudget(value: unknown, budget: number): void {
  const minimum = bytes(value);
  if (minimum > budget) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "The memory scope envelope exceeds max_bytes; increase the budget", { minimum_bytes: minimum, max_bytes: budget });
}
export interface MemoryReferenceState {
  readonly artifact_id: string;
  readonly status: "intact" | "missing" | "hash-mismatch" | "content-changed" | "context-mismatch";
}
export type MemoryReadNote = MemoryNote & { readonly reference_states: readonly MemoryReferenceState[] };

/** Working notes reference canonical evidence; this service never changes a campaign. */
export class MemoryService {
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly artifacts: ArtifactRegistry) {}

  upsert(input: MemoryUpsertInput): MemoryNote {
    const scope = scopeCopy(input.scope);
    checkKey(input.key);
    const expected = integer(input.expected_revision, -1, 0, Number.MAX_SAFE_INTEGER - 1, "expected_revision");
    assertValid(input.note, MemoryNoteDraftSchema, "Memory note");
    if (new Set(input.note.related_task_ids).size !== input.note.related_task_ids.length) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Duplicate related task IDs");
    if (input.note.kind === "abandoned-track" && input.note.abandonment === null) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "An abandoned track needs its reason, tested conditions and reopening trigger");
    if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim() || input.idempotency_key.length > 200) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "A bounded idempotency_key is required");
    const draft = structuredClone(input.note);
    if (bytes(draft) > MEMORY_MAX_NOTE_BYTES) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory note is too large; publish detailed content as an artifact");
    const request = { scope, key: input.key, expected_revision: expected, note: draft, task_id: input.task_id, agent: input.agent };
    return this.store.transaction(() => {
      const task = this.store.getTask(input.task_id);
      if (!task) throw new BridgeError(ErrorCode.NOT_FOUND, "Current memory-writing task does not exist", { task_id: input.task_id });
      if (task.owner !== input.agent) throw new BridgeError(ErrorCode.NOT_OWNER, "Memory writes must belong to the caller's current task", { task_id: input.task_id });
      return runIdempotent(this.store, this.clock, {
        key: `memory.upsert:${input.agent}:${input.idempotency_key}`, operation: "memory.upsert", request,
      }, () => {
        if (task.state !== TaskState.WORKING && task.state !== TaskState.VERIFYING) throw new BridgeError(ErrorCode.ILLEGAL_TRANSITION, "Memory writes require a WORKING or VERIFYING task");
        const current = this.store.getMemoryNote(scope, input.key);
        if ((current?.revision ?? 0) !== expected) throw new BridgeError(ErrorCode.REVISION_CONFLICT, "Memory changed; reread and merge before writing", { key: input.key, expected_revision: expected, current_revision: current?.revision ?? 0 });
        for (const ref of draft.references) {
          const artifact = this.store.getArtifact(ref.artifact_id);
          if (!artifact) throw new BridgeError(ErrorCode.NOT_FOUND, "Memory artifact reference does not exist", { artifact_id: ref.artifact_id });
          if (artifact.sha256 !== ref.sha256 || !this.artifacts.verifyIntegrity(ref.artifact_id).intact) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory artifact reference hash or retained content differs", { artifact_id: ref.artifact_id });
        }
        for (const id of draft.related_task_ids) if (!this.store.getTask(id)) throw new BridgeError(ErrorCode.NOT_FOUND, "Related memory task does not exist", { task_id: id });
        const at = this.clock.now();
        const event = this.store.appendEvent({ type: EventType.MEMORY_UPDATED, task_id: task.task_id, agent: input.agent,
          payload: { scope, key: input.key, revision: expected + 1, lifecycle: draft.lifecycle }, idempotency_key: input.idempotency_key }, at);
        const note: MemoryNote = { schema_version: 1, scope, key: input.key, revision: expected + 1, ...draft,
          change_cursor: event.event_id, at,
          provenance: { agent: input.agent, task_id: task.task_id, run_id: task.run_id, attempt: task.attempt } };
        if (bytes(note) > MEMORY_MAX_NOTE_BYTES) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory revision exceeds byte limit; use artifact references");
        this.store.insertMemoryNote(note, expected);
        return note;
      });
    });
  }

  private readNote(note: MemoryNote): MemoryReadNote {
    const reference_states: MemoryReferenceState[] = note.references.map(ref => {
      const artifact = this.store.getArtifact(ref.artifact_id);
      let status: MemoryReferenceState["status"] = "intact";
      if (!artifact) status = "missing";
      else if (artifact.sha256 !== ref.sha256) status = "hash-mismatch";
      else if (!this.artifacts.verifyIntegrity(ref.artifact_id).intact) status = "content-changed";
      else if (note.scope.epoch !== null && ref.source_epoch !== undefined && ref.source_epoch !== note.scope.epoch) status = "context-mismatch";
      return { artifact_id: ref.artifact_id, status };
    });
    return { ...note, reference_states };
  }

  private cursor(requested: number | undefined, head: number, name: string): number {
    return integer(requested, head, 0, head, name);
  }

  getContext(input: MemoryContextInput) {
    const scope = scopeCopy(input.scope);
    const limit = integer(input.limit, 20, 1, 50, "limit");
    const budget = integer(input.max_bytes, MEMORY_DEFAULT_CONTEXT_BYTES, 2048, MEMORY_MAX_RESPONSE_BYTES, "max_bytes");
    if (input.after_key !== undefined) checkKey(input.after_key);
    if (input.keys !== undefined && (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 100)) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "keys must contain 1-100 identifiers");
    input.keys?.forEach(checkKey);
    const lifecycles = input.lifecycles ?? ["active"];
    if (!Array.isArray(lifecycles) || !lifecycles.length || lifecycles.some(value => !["active", "superseded", "archived"].includes(value))) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Invalid memory lifecycles");
    const head = this.cursor(input.at_cursor, this.store.lastEventId(), "at_cursor");
    const rows = this.store.listMemoryNotes({ scope, before_cursor: head, after_key: input.after_key, keys: input.keys, lifecycles, limit: limit + 1 });
    const result = { schema_version: 1, scope, change_cursor: head, notes: [] as MemoryReadNote[],
      pending_tasks: [] as { task_id: string; state: string }[],
      omitted: [] as { key: string; revision: number; reason: string; minimum_bytes: number }[],
      has_more: false, next_key: null as string | null };
    requireBudget(result, budget);
    let last = input.after_key ?? null;
    let processed = 0;
    for (const row of rows.slice(0, limit)) {
      const note = this.readNote(row);
      const tasks = new Map(result.pending_tasks.map(task => [task.task_id, task]));
      for (const id of row.related_task_ids) {
        const task = this.store.getTask(id);
        if (task && !TERMINAL_STATES.has(task.state)) tasks.set(id, { task_id: id, state: task.state });
      }
      const candidate = { ...result, notes: [...result.notes, note], pending_tasks: [...tasks.values()], next_key: row.key };
      if (bytes(candidate) > budget) {
        if (result.notes.length) break; // next page can return this whole note
        const omitted = { key: row.key, revision: row.revision, reason: "increase-max_bytes-to-load-whole-note", minimum_bytes: bytes(candidate) };
        const omission = { ...result, omitted: [...result.omitted, omitted], next_key: row.key };
        if (bytes(omission) > budget) {
          if (!processed) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Memory omission metadata exceeds max_bytes; increase the budget", { minimum_bytes: bytes(omission), max_bytes: budget });
          break;
        }
        result.omitted.push(omitted);
      } else {
        result.notes.push(note); result.pending_tasks = [...tasks.values()];
      }
      last = row.key; processed++;
    }
    result.has_more = processed < rows.length;
    result.next_key = result.has_more ? last : null;
    if (bytes(result) > budget) throw new BridgeError(ErrorCode.INTERNAL, "Memory context byte-budget invariant failed");
    return result;
  }

  getChanges(input: MemoryChangesInput) {
    const scope = scopeCopy(input.scope);
    const limit = integer(input.limit, 25, 1, 100, "limit");
    const budget = integer(input.max_bytes, MEMORY_DEFAULT_CONTEXT_BYTES, 2048, MEMORY_MAX_RESPONSE_BYTES, "max_bytes");
    const head = this.cursor(input.until_cursor, this.store.lastEventId(), "until_cursor");
    const after = integer(input.change_cursor, 0, 0, head, "change_cursor");
    const rows = this.store.listMemoryChanges({ scope, after, before_cursor: head, limit: limit + 1 });
    const result = { schema_version: 1, scope, changes: [] as MemoryReadNote[], change_cursor: after, head_cursor: head, has_more: false };
    requireBudget(result, budget);
    for (const row of rows.slice(0, limit)) {
      const note = this.readNote(row);
      const candidate = { ...result, changes: [...result.changes, note], change_cursor: row.change_cursor };
      if (bytes(candidate) > budget) {
        if (!result.changes.length) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "The next whole memory change exceeds max_bytes; increase the budget without advancing the cursor", { minimum_bytes: bytes(candidate), change_cursor: after, key: row.key });
        break;
      }
      result.changes.push(note); result.change_cursor = row.change_cursor;
    }
    result.has_more = result.changes.length < rows.length;
    if (bytes(result) > budget) throw new BridgeError(ErrorCode.INTERNAL, "Memory changes byte-budget invariant failed");
    return result;
  }
}
