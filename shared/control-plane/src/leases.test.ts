/**
 * Write-scope leases — the mechanism that stops Claude and Codex editing the same files.
 *
 * The expiry tests use a `ManualClock`, so they assert real behaviour at exact instants
 * rather than sleeping and hoping.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, LeaseState, seededRandom, type TaskSpec } from "@bridge/protocol";
import { ControlPlane } from "./control-plane.js";
import { ManualClock } from "./clock.js";

const TTL = 60_000;

function spec(paths: string[]): TaskSpec {
  return {
    objective: "work",
    scope: { paths },
    dependencies: [],
    expected_deliverable: "artifact",
    verification_criteria: ["tests pass"],
  };
}

let cp: ControlPlane;
let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
  cp = ControlPlane.open({
    workspaceRoot: "/tmp/bridge-test",
    databasePath: ":memory:",
    clock,
    rng: seededRandom(7),
  });
});

function task(paths: string[]) {
  return cp.tasks.create({ spec: spec(paths), created_by: "claude" }).task_id;
}

describe("acquisition", () => {
  it("grants disjoint scopes to both agents concurrently", () => {
    const a = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    const b = cp.leases.acquire({ task_id: task(["codex/**"]), holder: "codex", scope: { paths: ["codex/**"] }, ttl_ms: TTL });
    expect(a.state).toBe(LeaseState.HELD);
    expect(b.state).toBe(LeaseState.HELD);
    expect(cp.leases.listLive()).toHaveLength(2);
  });

  it("refuses an overlapping scope and names the holder", () => {
    cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    let thrown: any;
    try {
      cp.leases.acquire({
        task_id: task(["claude/control-plane/src/x.ts"]),
        holder: "codex",
        scope: { paths: ["claude/control-plane/src/x.ts"] },
        ttl_ms: TTL,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.code).toBe(ErrorCode.SCOPE_CONFLICT);
    expect(thrown.message).toContain("claude");
    expect(thrown.details.conflicts[0].holder).toBe("claude");
  });

  it("logs a denial so a supervisor can see the near-collision", () => {
    cp.leases.acquire({ task_id: task(["shared/**"]), holder: "claude", scope: { paths: ["shared/**"] }, ttl_ms: TTL });
    expect(() =>
      cp.leases.acquire({ task_id: task(["shared/protocol/**"]), holder: "codex", scope: { paths: ["shared/protocol/**"] }, ttl_ms: TTL }),
    ).toThrow();
    expect(cp.events({ types: ["lease.denied"] })).toHaveLength(1);
  });

  it("lets the same holder take an overlapping scope, so it need not release to subdivide", () => {
    const t = task(["claude/**"]);
    cp.leases.acquire({ task_id: t, holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    expect(() =>
      cp.leases.acquire({ task_id: t, holder: "claude", scope: { paths: ["claude/control-plane/**"] }, ttl_ms: TTL }),
    ).not.toThrow();
  });

  it("rejects a non-positive ttl", () => {
    expect(() =>
      cp.leases.acquire({ task_id: task(["a/**"]), holder: "claude", scope: { paths: ["a/**"] }, ttl_ms: 0 }),
    ).toThrow(/positive/);
  });
});

describe("expiry", () => {
  it("holds the scope for exactly the ttl and frees it after", () => {
    const t = task(["claude/**"]);
    cp.leases.acquire({ task_id: t, holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });

    clock.advance(TTL - 1);
    expect(cp.leases.listLive()).toHaveLength(1);

    clock.advance(1);
    expect(cp.leases.listLive()).toHaveLength(0);
    expect(() =>
      cp.leases.acquire({ task_id: task(["claude/**"]), holder: "codex", scope: { paths: ["claude/**"] }, ttl_ms: TTL }),
    ).not.toThrow();
  });

  it("does not let a crashed agent deadlock the scope forever", () => {
    cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    clock.advance(TTL + 1); // claude never released — it died

    const reaped = cp.leases.reapExpired();
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.state).toBe(LeaseState.EXPIRED);
    expect(cp.events({ types: ["lease.expired"] })).toHaveLength(1);
  });

  it("refuses to renew a lapsed lease, since the scope may already be taken", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    clock.advance(TTL + 1);
    expect(() => cp.leases.renew(lease.lease_id, "claude", TTL)).toThrow(/no longer live/);
  });

  it("extends a live lease so long work does not lapse mid-edit", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    clock.advance(TTL - 100);
    const renewed = cp.leases.renew(lease.lease_id, "claude", TTL);
    expect(renewed.expires_at).toBe(clock.now() + TTL);
    clock.advance(TTL - 1);
    expect(cp.leases.listLive()).toHaveLength(1);
  });
});

describe("write enforcement", () => {
  it("permits a path inside the lease and refuses one outside", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    expect(() => cp.leases.assertWritable(lease.lease_id, "claude", "claude/control-plane/src/x.ts")).not.toThrow();
    expect(() => cp.leases.assertWritable(lease.lease_id, "claude", "codex/adapter.ts")).toThrow(/outside the leased scope/);
  });

  it("refuses a write by anyone other than the holder", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    expect(() => cp.leases.assertWritable(lease.lease_id, "codex", "claude/x.ts")).toThrow(/held by claude/);
  });

  it("refuses a write under an expired lease", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    clock.advance(TTL + 1);
    expect(() => cp.leases.assertWritable(lease.lease_id, "claude", "claude/x.ts")).toThrow(/expired/);
  });
});

describe("release", () => {
  it("frees the scope for the other agent", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    cp.leases.release(lease.lease_id, "claude");
    expect(() =>
      cp.leases.acquire({ task_id: task(["claude/**"]), holder: "codex", scope: { paths: ["claude/**"] }, ttl_ms: TTL }),
    ).not.toThrow();
  });

  it("is idempotent, so cleanup can be retried after a crash", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    cp.leases.release(lease.lease_id, "claude");
    expect(() => cp.leases.release(lease.lease_id, "claude")).not.toThrow();
    expect(cp.events({ types: ["lease.released"] })).toHaveLength(1);
  });

  it("refuses release by a non-holder", () => {
    const lease = cp.leases.acquire({ task_id: task(["claude/**"]), holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });
    expect(() => cp.leases.release(lease.lease_id, "codex")).toThrow(/held by claude/);
  });
});

describe("recovery", () => {
  it("frees orphaned scopes and reports what was in flight, without guessing", () => {
    const t = task(["claude/**"]);
    cp.tasks.claim(t, "claude");
    cp.tasks.transition({ task_id: t, agent: "claude", to: "WORKING" });
    cp.leases.acquire({ task_id: t, holder: "claude", scope: { paths: ["claude/**"] }, ttl_ms: TTL });

    clock.advance(TTL + 1); // process died here

    const report = cp.recover();
    expect(report.expired_leases).toHaveLength(1);
    expect(report.in_flight_tasks).toHaveLength(1);
    expect(report.in_flight_tasks[0]).toMatchObject({ task_id: t, state: "WORKING", has_live_lease: false });
    // Recovery must not silently fail or complete the task on the agent's behalf.
    expect(cp.tasks.get(t).state).toBe("WORKING");
  });
});
