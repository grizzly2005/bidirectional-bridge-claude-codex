/**
 * `@bridge/control-plane` — shared coordination state for the Claude <-> Codex bridge.
 *
 * The control plane is the sole owner of task state, ownership, leases, dependencies,
 * artifacts, and the event log. Agents interact with it; they never write state directly.
 */

export { ControlPlane } from "./control-plane.js";
export type { ControlPlaneOptions, ControlPlaneSnapshot, RecoveryReport } from "./control-plane.js";

export { SimpleAdapterRegistry } from "./adapter-registry.js";

export { MAX_DELEGATION_DEPTH, TaskService } from "./task-service.js";
export type {
  BeginRecoveryInput,
  CreateTaskInput,
  DependencyReport,
  TransitionInput,
} from "./task-service.js";

export { LeaseManager } from "./lease-manager.js";
export type { AcquireLeaseInput, LeaseConflict } from "./lease-manager.js";

export { ArtifactRegistry } from "./artifact-registry.js";
export type { ArtifactRegistryOptions, PublishArtifactInput } from "./artifact-registry.js";

export { DeliverableService } from "./deliverable-service.js";
export type { SubmitOptions } from "./deliverable-service.js";

export { AttemptService, normalizeAttemptTelemetry } from "./attempt-service.js";
export type { NormalizeAttemptTelemetryInput } from "./attempt-service.js";

export { Orchestrator } from "./orchestrator.js";
export type { DelegateOptions } from "./orchestrator.js";

export { ManualClock, systemClock } from "./clock.js";
export type { Clock } from "./clock.js";

export { SqliteStateStore } from "./store/sqlite-store.js";
export type { JournalMode, SqliteStoreOptions } from "./store/sqlite-store.js";
export type {
  EventAppend,
  EventQuery,
  AttemptTelemetryQuery,
  IdempotencyRecord,
  StateStore,
  TaskQuery,
} from "./store/state-store.js";

export { hashRequest, runIdempotent, stableStringify } from "./idempotency.js";
export type { IdempotentOptions } from "./idempotency.js";
