/**
 * Time is injected everywhere so lease expiry, deadlines, and retry backoff are
 * deterministically testable. Nothing in the control plane calls `Date.now()` directly.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or immediately for a controlled clock that has been advanced. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Manually advanced clock for tests. */
export class ManualClock implements Clock {
  private current: number;
  private readonly waiters: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.current + ms, resolve });
    });
  }

  /** Move time forward and release any sleepers whose deadline has passed. */
  advance(ms: number): void {
    this.current += ms;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.at <= this.current) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  set(at: number): void {
    this.advance(at - this.current);
  }
}
