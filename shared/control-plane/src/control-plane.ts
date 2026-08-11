/**
 * The control plane facade.
 *
 * One object wiring together the store, clock, task lifecycle, leases, artifacts and
 * deliverables. Adapters and the MCP server talk to this and nothing below it, which is
 * what keeps D-003 ("the control plane is the only writer of state") enforceable rather
 * than aspirational.
 */

import {
  type AdapterRegistry,
  type AgentId,
  type BridgeEvent,
  type RandomSource,
} from "@bridge/protocol";
import { SimpleAdapterRegistry } from "./adapter-registry.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { AttemptService } from "./attempt-service.js";
import { type Clock, systemClock } from "./clock.js";
import { DeliverableService } from "./deliverable-service.js";
import { LeaseManager } from "./lease-manager.js";
import { SqliteStateStore, type JournalMode } from "./store/sqlite-store.js";
import type { EventQuery, StateStore } from "./store/state-store.js";
import { TaskService } from "./task-service.js";

export interface ControlPlaneOptions {
  /** Absolute path to the repository the agents operate on. */
  readonly workspaceRoot: string;
  /** Database file path, or `:memory:`. Defaults to `<workspaceRoot>/.bridge/bridge.db`. */
  readonly databasePath?: string;
  readonly journalMode?: JournalMode;
  readonly clock?: Clock;
  /** Test-only deterministic id source. */
  readonly rng?: RandomSource;
  /** Inject a different backend; bypasses SQLite entirely. */
  readonly store?: StateStore;
  readonly inlineArtifactLimitBytes?: number;
  readonly onWarning?: (message: string, details?: Record<string, unknown>) => void;
}

export class ControlPlane {
  readonly store: StateStore;
  readonly clock: Clock;
  readonly tasks: TaskService;
  readonly leases: LeaseManager;
  readonly artifacts: ArtifactRegistry;
  readonly deliverables: DeliverableService;
  readonly attempts: AttemptService;
  readonly adapters: AdapterRegistry;
  readonly workspaceRoot: string;

  private constructor(options: ControlPlaneOptions, store: StateStore) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = store;
    this.clock = options.clock ?? systemClock;
    this.tasks = new TaskService(store, this.clock, options.rng);
    this.leases = new LeaseManager(store, this.clock, options.rng);
    this.artifacts = new ArtifactRegistry(
      store,
      this.clock,
      {
        workspaceRoot: options.workspaceRoot,
        ...(options.inlineArtifactLimitBytes !== undefined
          ? { inlineLimitBytes: options.inlineArtifactLimitBytes }
          : {}),
      },
      options.rng,
    );
    this.deliverables = new DeliverableService(store, this.clock, this.tasks);
    this.attempts = new AttemptService(store, this.clock);
    this.adapters = new SimpleAdapterRegistry();
  }

  static open(options: ControlPlaneOptions): ControlPlane {
    const store =
      options.store ??
      new SqliteStateStore({
        path: options.databasePath ?? `${options.workspaceRoot}/.bridge/bridge.db`,
        journalMode: options.journalMode ?? "auto",
        onJournalFallback: (requested, actual, reason) =>
          options.onWarning?.(
            `SQLite journal mode fell back from ${requested} to ${actual}: ${reason}. ` +
              `Concurrent reads during writes will block; move the database to a local disk to restore WAL.`,
            { requested, actual },
          ),
      });
    return new ControlPlane(options, store);
  }

  /* ---------------- supervisor-facing reads ---------------- */

  /** Tail the event log. An external supervisor polls with the last id it saw. */
  events(query?: EventQuery): BridgeEvent[] {
    return this.store.readEvents(query);
  }

  lastEventId(): number {
    return this.store.lastEventId();
  }

  /** One-shot picture of the system, for a supervisor or a `bridge status` command. */
  snapshot(): ControlPlaneSnapshot {
    const tasks = this.store.listTasks();
    const live = this.leases.listLive();
    const byState: Record<string, number> = {};
    for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;
    return {
      at: this.clock.now(),
      task_count: tasks.length,
      tasks_by_state: byState,
      ready_task_ids: this.tasks.readyTasks().map((t) => t.task_id),
      live_leases: live.map((l) => ({
        lease_id: l.lease_id,
        holder: l.holder,
        task_id: l.task_id,
        paths: l.scope.paths,
        expires_at: l.expires_at,
      })),
      last_event_id: this.store.lastEventId(),
      adapters: this.adapters.list().map((a) => ({
        agent: a.info.agent,
        implementation: a.info.implementation,
        capabilities: a.info.capabilities,
      })),
    };
  }

  /**
   * Crash recovery. Marks leases whose holder went away as EXPIRED so their scopes become
   * acquirable, and reports tasks stuck mid-flight for an operator or supervisor to decide on.
   * Deliberately does not auto-fail or auto-retry: guessing at recovery is how a bridge
   * silently discards another agent's work.
   */
  recover(): RecoveryReport {
    const expired = this.leases.reapExpired();
    const now = this.clock.now();
    const stuck = this.store
      .listTasks({ state: ["WORKING", "VERIFYING", "CLAIMED"] })
      .map((t) => ({
        task_id: t.task_id,
        owner: t.owner,
        state: t.state,
        stale_ms: now - t.updated_at,
        has_live_lease: this.leases.listLive().some((l) => l.task_id === t.task_id),
      }));
    return { expired_leases: expired.map((l) => l.lease_id), in_flight_tasks: stuck, at: now };
  }

  close(): void {
    this.store.close();
  }
}

export interface ControlPlaneSnapshot {
  readonly at: number;
  readonly task_count: number;
  readonly tasks_by_state: Record<string, number>;
  readonly ready_task_ids: readonly string[];
  readonly live_leases: ReadonlyArray<{
    lease_id: string;
    holder: string;
    task_id: string;
    paths: readonly string[];
    expires_at: number;
  }>;
  readonly last_event_id: number;
  readonly adapters: ReadonlyArray<{
    agent: string;
    implementation: string;
    capabilities: readonly string[];
  }>;
}

export interface RecoveryReport {
  readonly expired_leases: readonly string[];
  readonly in_flight_tasks: ReadonlyArray<{
    task_id: string;
    owner: string | null;
    state: string;
    stale_ms: number;
    has_live_lease: boolean;
  }>;
  readonly at: number;
}
