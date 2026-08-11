/**
 * Idempotency (D-005).
 *
 * MCP calls cross a process boundary; a timeout or crash leaves the caller unable to tell
 * whether the mutation applied. Callers therefore attach an `idempotency_key`, and a replay
 * returns the original response rather than applying the operation twice.
 *
 * Reusing a key with a *different* payload is rejected rather than silently returning the
 * old answer — that combination almost always means a caller bug, and hiding it would
 * produce a result the caller never asked for.
 */

import { createHash } from "node:crypto";
import { BridgeError, ErrorCode } from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { StateStore } from "./store/state-store.js";

export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Key-sorted JSON so `{a,b}` and `{b,a}` hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface IdempotentOptions {
  readonly key?: string;
  readonly operation: string;
  readonly request: unknown;
}

/**
 * Wraps a mutation so it applies at most once per key.
 *
 * The cache write happens inside the same transaction as `fn`, so a crash between the two
 * cannot leave a cached response for an operation that rolled back.
 */
export function runIdempotent<T>(
  store: StateStore,
  clock: Clock,
  opts: IdempotentOptions,
  fn: () => T,
): T {
  if (!opts.key) return fn();

  const requestHash = hashRequest(opts.request);
  const existing = store.getIdempotency(opts.key);
  if (existing) {
    if (existing.operation !== opts.operation || existing.request_hash !== requestHash) {
      throw new BridgeError(
        ErrorCode.IDEMPOTENCY_MISMATCH,
        `idempotency key '${opts.key}' was already used for a different request ` +
          `(${existing.operation}); pick a fresh key`,
        { key: opts.key, previous_operation: existing.operation, operation: opts.operation },
      );
    }
    return JSON.parse(existing.response_json) as T;
  }

  return store.transaction(() => {
    // Re-read inside the transaction: two concurrent replays could both miss above.
    const raced = store.getIdempotency(opts.key!);
    if (raced) return JSON.parse(raced.response_json) as T;

    const result = fn();
    store.putIdempotency({
      key: opts.key!,
      operation: opts.operation,
      request_hash: requestHash,
      response_json: JSON.stringify(result ?? null),
      created_at: clock.now(),
    });
    return result;
  });
}
