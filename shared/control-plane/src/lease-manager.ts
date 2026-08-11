/**
 * Write-scope leases.
 *
 * Two agents editing the same files is the failure this bridge exists to prevent, so a
 * lease is required before any write and is checked against every other *live* lease.
 *
 * Why time-bounded leases rather than locks (D-004): a crashed agent holding a lock would
 * deadlock the system with no operator present. A lease simply stops being live, and the
 * scope becomes acquirable again. Expiry is evaluated lazily against the injected clock —
 * no background timer — which keeps behaviour deterministic under test.
 */

import {
  BridgeError,
  ErrorCode,
  LeaseState,
  conflictingPairs,
  newLeaseId,
  normalizeScope,
  scopeAllows,
  type AgentId,
  type Lease,
  type LeaseId,
  type RandomSource,
  type TaskId,
  type WriteScope,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { StateStore } from "./store/state-store.js";

export interface AcquireLeaseInput {
  readonly task_id: TaskId;
  readonly holder: AgentId;
  readonly scope: WriteScope;
  readonly ttl_ms: number;
}

export interface LeaseConflict {
  readonly lease_id: LeaseId;
  readonly holder: AgentId;
  readonly task_id: TaskId;
  readonly overlapping: ReadonlyArray<readonly [string, string]>;
}

export class LeaseManager {
  constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
    private readonly rng?: RandomSource,
  ) {}

  /** A lease is live if it is HELD and has not passed its expiry. */
  isLive(lease: Lease, now = this.clock.now()): boolean {
    return lease.state === LeaseState.HELD && lease.expires_at > now;
  }

  /**
   * Acquire a lease over `scope`, or throw SCOPE_CONFLICT listing who holds the overlap.
   *
   * Same-holder overlap is allowed: an agent extending or subdividing its own scope is
   * not a conflict, and refusing it would force agents to release-then-reacquire, opening
   * a window for the other agent to steal the scope mid-task.
   */
  acquire(input: AcquireLeaseInput): Lease {
    const scope = normalizeScope(input.scope);
    if (input.ttl_ms <= 0) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "lease ttl_ms must be positive", {
        ttl_ms: input.ttl_ms,
      });
    }

    const now = this.clock.now();

    // Conflict detection happens before the write transaction opens, because the denial
    // must be *recorded*. Logging it inside the transaction that then throws would roll
    // the event back with everything else, and denials — near-collisions between the two
    // agents — are exactly what a supervisor needs to see.
    const conflicts = this.findConflicts(scope, input.holder, now);
    if (conflicts.length > 0) {
      this.store.transaction(() => {
        this.store.appendEvent(
          {
            type: "lease.denied",
            task_id: input.task_id,
            agent: input.holder,
            payload: { requested: scope.paths, conflicts },
          },
          now,
        );
      });
      throw new BridgeError(
        ErrorCode.SCOPE_CONFLICT,
        `write scope conflicts with ${conflicts.length} live lease(s) held by ` +
          `${[...new Set(conflicts.map((c) => c.holder))].join(", ")}`,
        { conflicts },
      );
    }

    return this.store.transaction(() => {
      // Re-check inside the transaction: another agent may have acquired an overlapping
      // scope between the check above and the write below.
      const raced = this.findConflicts(scope, input.holder, this.clock.now());
      if (raced.length > 0) {
        throw new BridgeError(
          ErrorCode.SCOPE_CONFLICT,
          `write scope was taken concurrently by ${[...new Set(raced.map((c) => c.holder))].join(", ")}`,
          { conflicts: raced },
        );
      }

      const lease: Lease = {
        lease_id: newLeaseId(this.rng),
        task_id: input.task_id,
        holder: input.holder,
        scope,
        state: LeaseState.HELD,
        acquired_at: now,
        expires_at: now + input.ttl_ms,
      };
      this.store.insertLease(lease);
      this.store.appendEvent(
        {
          type: "lease.acquired",
          task_id: input.task_id,
          agent: input.holder,
          payload: { lease_id: lease.lease_id, paths: scope.paths, expires_at: lease.expires_at },
        },
        now,
      );
      return lease;
    });
  }

  /** Conflicts against currently-live leases held by a different agent. */
  findConflicts(scope: WriteScope, holder: AgentId, now = this.clock.now()): LeaseConflict[] {
    const out: LeaseConflict[] = [];
    for (const held of this.store.listHeldLeases()) {
      if (!this.isLive(held, now)) continue;
      if (held.holder === holder) continue;
      const overlapping = conflictingPairs(scope, held.scope);
      if (overlapping.length > 0) {
        out.push({
          lease_id: held.lease_id,
          holder: held.holder,
          task_id: held.task_id,
          overlapping,
        });
      }
    }
    return out;
  }

  /** Throws unless `lease_id` is live, held by `holder`, and covers `path`. */
  assertWritable(lease_id: LeaseId, holder: AgentId, path: string): void {
    const lease = this.store.getLease(lease_id);
    if (!lease) {
      throw new BridgeError(ErrorCode.NOT_FOUND, `no such lease ${lease_id}`, { lease_id });
    }
    const now = this.clock.now();
    if (!this.isLive(lease, now)) {
      throw new BridgeError(
        ErrorCode.LEASE_INVALID,
        `lease ${lease_id} is ${lease.state === LeaseState.HELD ? "expired" : lease.state.toLowerCase()}`,
        { lease_id, expires_at: lease.expires_at, now },
      );
    }
    if (lease.holder !== holder) {
      throw new BridgeError(ErrorCode.NOT_OWNER, `lease ${lease_id} is held by ${lease.holder}`, {
        lease_id,
        holder: lease.holder,
        caller: holder,
      });
    }
    if (!scopeAllows(lease.scope, path)) {
      throw new BridgeError(
        ErrorCode.SCOPE_CONFLICT,
        `path '${path}' is outside the leased scope`,
        { path, scope: lease.scope.paths },
      );
    }
  }

  /** Extend a live lease. Refuses to resurrect an expired one — that scope may be taken. */
  renew(lease_id: LeaseId, holder: AgentId, ttl_ms: number): Lease {
    return this.store.transaction(() => {
      const lease = this.store.getLease(lease_id);
      if (!lease) throw new BridgeError(ErrorCode.NOT_FOUND, `no such lease ${lease_id}`);
      if (lease.holder !== holder) {
        throw new BridgeError(ErrorCode.NOT_OWNER, `lease ${lease_id} is held by ${lease.holder}`);
      }
      const now = this.clock.now();
      if (!this.isLive(lease, now)) {
        throw new BridgeError(
          ErrorCode.LEASE_INVALID,
          `cannot renew a lease that is no longer live; re-acquire instead`,
          { lease_id, state: lease.state, expires_at: lease.expires_at, now },
        );
      }
      const renewed: Lease = { ...lease, expires_at: now + ttl_ms };
      this.store.updateLease(renewed);
      return renewed;
    });
  }

  release(lease_id: LeaseId, holder: AgentId): Lease {
    return this.store.transaction(() => {
      const lease = this.store.getLease(lease_id);
      if (!lease) throw new BridgeError(ErrorCode.NOT_FOUND, `no such lease ${lease_id}`);
      if (lease.holder !== holder) {
        throw new BridgeError(ErrorCode.NOT_OWNER, `lease ${lease_id} is held by ${lease.holder}`);
      }
      const now = this.clock.now();
      // Releasing an already-released lease is a no-op, not an error: release is on the
      // cleanup path and must be safe to retry after a crash.
      if (lease.state !== LeaseState.HELD) return lease;
      const released: Lease = { ...lease, state: LeaseState.RELEASED, released_at: now };
      this.store.updateLease(released);
      this.store.appendEvent(
        {
          type: "lease.released",
          task_id: lease.task_id,
          agent: holder,
          payload: { lease_id, paths: lease.scope.paths },
        },
        now,
      );
      return released;
    });
  }

  /**
   * Mark timed-out leases EXPIRED and log it. Purely cosmetic for correctness —
   * `isLive` already treats them as dead — but it gives a supervisor an explicit signal
   * that an agent went away without cleaning up.
   */
  reapExpired(): Lease[] {
    return this.store.transaction(() => {
      const now = this.clock.now();
      const reaped: Lease[] = [];
      for (const lease of this.store.listHeldLeases()) {
        if (lease.expires_at > now) continue;
        const expired: Lease = { ...lease, state: LeaseState.EXPIRED };
        this.store.updateLease(expired);
        this.store.appendEvent(
          {
            type: "lease.expired",
            task_id: lease.task_id,
            agent: lease.holder,
            payload: { lease_id: lease.lease_id, paths: lease.scope.paths, expired_at: lease.expires_at },
          },
          now,
        );
        reaped.push(expired);
      }
      return reaped;
    });
  }

  listLive(): Lease[] {
    const now = this.clock.now();
    return this.store.listHeldLeases().filter((l) => this.isLive(l, now));
  }
}
