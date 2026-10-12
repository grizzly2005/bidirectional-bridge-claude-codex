/**
 * Storage abstraction.
 *
 * The control plane talks only to this interface, so SQLite can be swapped for another
 * backend (Postgres for multi-machine operation, for example) without touching lifecycle,
 * lease, or dependency logic. Per D-001 the storage layer stays replaceable.
 *
 * Implementations MUST provide:
 *  - serialisable transactions (`transaction` runs its body atomically);
 *  - an append-only event log written in the SAME transaction as the state change it
 *    describes, so the log can never disagree with the state;
 *  - monotonically increasing `event_id`.
 */

import type {
  AgentId,
  Artifact,
  ArtifactId,
  AttemptTelemetry,
  BridgeEvent,
  Deliverable,
  DelegationOutcome,
  DelegationRequest,
  ObservationStatus,
  EventType,
  Lease,
  LeaseId,
  MemoryLifecycle,
  MemoryNote,
  MemoryScope,
  StatusUpdate,
  Task,
  TaskAttempt,
  TaskId,
  TaskState,
  VerificationResult,
} from "@bridge/protocol";

export interface EventAppend {
  readonly type: EventType;
  readonly task_id: TaskId | null;
  readonly agent: AgentId;
  readonly payload: Record<string, unknown>;
  readonly idempotency_key?: string;
}

export interface TaskQuery {
  readonly state?: TaskState | readonly TaskState[];
  readonly owner?: AgentId | null;
  readonly tag?: string;
  readonly limit?: number;
}

export interface EventQuery {
  /** Return events with `event_id` strictly greater than this. */
  readonly after?: number;
  readonly task_id?: TaskId;
  readonly types?: readonly EventType[];
  readonly limit?: number;
}

export interface AttemptTelemetryQuery {
  readonly run_id?: string;
  readonly task_id?: TaskId;
  readonly agent?: AgentId;
  readonly attempt?: number;
  readonly limit?: number;
}

/** Cached result of a previously-applied idempotent operation. */
export interface IdempotencyRecord {
  readonly key: string;
  readonly operation: string;
  /** Hash of the request payload, to detect a key reused with different arguments. */
  readonly request_hash: string;
  readonly response_json: string;
  readonly created_at: number;
}

export interface DelegationOperation {
  readonly caller: AgentId;
  readonly key: string;
  readonly request_hash: string;
  readonly task_id: TaskId;
  readonly request: DelegationRequest;
  readonly phase: "PREPARING" | "AUTHORIZED" | "FINISHED" | "UNCERTAIN";
  readonly executor_id: string;
  readonly executor_pid: number;
  readonly started_at: number;
  readonly updated_at: number;
  readonly outcome: DelegationOutcome | null;
}

/** Internal generation and stop evidence. Never expose the generation as MCP authority. */
export interface ExecutionRecord {
  readonly task_id: TaskId;
  readonly attempt: number;
  readonly generation: string;
  readonly agent: AgentId;
  readonly phase: "QUEUED" | "RUNNING" | "STOPPED" | "QUARANTINED";
  readonly executor_pid: number;
  readonly max_concurrency: number;
  readonly queued_at: number;
  readonly queue_ticket: number;
  readonly admitted_at: number | null;
  readonly runtime_stop_confirmed: boolean | null;
  readonly lease_id: LeaseId | null;
  readonly cancel_requested_at: number | null;
  readonly cancel_requested_by: AgentId | null;
  readonly updated_at: number;
}

/**
 * Latest revision of each key in exactly one scope as of `before_cursor` (inclusive).
 * The snapshot is taken first; lifecycle/key filters apply to that latest revision only,
 * so an archived revision can never resurrect an older active one. Keys are ordered by
 * binary comparison; `after_key` is exclusive. An explicit empty filter matches nothing.
 */
export interface MemoryNoteQuery {
  readonly scope: MemoryScope;
  readonly before_cursor: number;
  readonly after_key?: string;
  readonly keys?: readonly string[];
  readonly lifecycles?: readonly MemoryLifecycle[];
  readonly limit: number;
}

/** Every immutable revision in exactly one scope with `after < change_cursor <= before_cursor`. */
export interface MemoryChangeQuery {
  readonly scope: MemoryScope;
  readonly after: number;
  readonly before_cursor: number;
  readonly limit: number;
}

export interface AttemptObservation extends ObservationStatus {
  readonly task_id: TaskId;
  readonly attempt: number;
  readonly telemetry: AttemptTelemetry | null;
  readonly updated_at: number;
}

/**
 * All methods are synchronous: SQLite is synchronous, and keeping the store sync means
 * `transaction` can guarantee atomicity without await points that could interleave.
 */
export interface StateStore {
  /** Runs `fn` inside an immediate write transaction. Rolls back on throw. */
  transaction<T>(fn: () => T): T;

  // ---- tasks ----
  insertTask(task: Task): void;
  getTask(id: TaskId): Task | undefined;
  updateTask(task: Task): void;
  listTasks(query?: TaskQuery): Task[];

  // ---- dependencies (edge table; `spec.dependencies` is the projection) ----
  addDependency(task_id: TaskId, depends_on: TaskId): void;
  getDependencies(task_id: TaskId): TaskId[];
  getDependents(task_id: TaskId): TaskId[];

  // ---- attempts (resumable execution handles) ----
  upsertAttempt(attempt: TaskAttempt): void;
  getAttempt(task_id: TaskId, attempt: number): TaskAttempt | undefined;
  listAttempts(task_id: TaskId): TaskAttempt[];

  // ---- final normalized attempt telemetry ----
  insertAttemptTelemetry(telemetry: AttemptTelemetry): void;
  listAttemptTelemetry(query?: AttemptTelemetryQuery): AttemptTelemetry[];

  // ---- leases ----
  insertLease(lease: Lease): void;
  getLease(id: LeaseId): Lease | undefined;
  updateLease(lease: Lease): void;
  /** Every lease still in HELD state, regardless of wall-clock expiry. */
  listHeldLeases(): Lease[];

  // ---- artifacts ----
  insertArtifact(artifact: Artifact): void;
  getArtifact(id: ArtifactId): Artifact | undefined;
  listArtifacts(task_id: TaskId): Artifact[];

  // ---- status / deliverables / verification ----
  insertStatus(update: StatusUpdate): void;
  latestStatus(task_id: TaskId): StatusUpdate | undefined;
  insertDeliverable(deliverable: Deliverable, attempt?: number): void;
  getDeliverable(task_id: TaskId): Deliverable | undefined;
  insertVerification(task_id: TaskId, result: VerificationResult, attempt: number): void;
  /** Undefined returns history; null selects legacy rows whose attempt is unknown. */
  listVerifications(task_id: TaskId, attempt?: number | null): VerificationResult[];

  // ---- event log ----
  appendEvent(event: EventAppend, at: number): BridgeEvent;
  readEvents(query?: EventQuery): BridgeEvent[];
  lastEventId(): number;

  // ---- idempotency ----
  getIdempotency(key: string): IdempotencyRecord | undefined;
  putIdempotency(record: IdempotencyRecord): void;
  /** Finalize an existing reservation only if its operation and request identity match. */
  updateIdempotencyResponse(record: IdempotencyRecord): void;

  getDelegationOperation(caller: AgentId, key: string): DelegationOperation | undefined;
  firstDelegationOperation(task_id: TaskId): DelegationOperation | undefined;
  putDelegationOperation(record: DelegationOperation): void;
  getExecution(task_id: TaskId): ExecutionRecord | undefined;
  putExecution(record: ExecutionRecord): void;
  listExecutions(agent?: AgentId): ExecutionRecord[];
  getObservation(task_id: TaskId, attempt: number): AttemptObservation | undefined;
  putObservation(record: AttemptObservation): void;
  listObservations(task_id?: TaskId): AttemptObservation[];

  // ---- shared memory (immutable revisions; no update or delete) ----
  /** Latest revision at or before `before_cursor` (inclusive), or the current latest. */
  getMemoryNote(scope: MemoryScope, key: string, before_cursor?: number): MemoryNote | undefined;
  /**
   * Compare-and-swap append. `expected_revision` 0 creates; `note.revision` must equal
   * `expected_revision + 1`; a different current revision throws REVISION_CONFLICT.
   * The caller appends the `memory.updated` event in the same outer transaction and
   * supplies its event id as `note.change_cursor`; storage emits no event itself.
   */
  insertMemoryNote(note: MemoryNote, expected_revision: number): void;
  listMemoryNotes(query: MemoryNoteQuery): MemoryNote[];
  listMemoryChanges(query: MemoryChangeQuery): MemoryNote[];

  close(): void;
}
