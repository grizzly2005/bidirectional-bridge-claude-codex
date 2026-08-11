/**
 * Identifier conventions for the bridge.
 *
 * IDs are human-greppable on purpose: an external supervisor reading the event log
 * should be able to tell what an ID refers to without a lookup.
 */

export type TaskId = string; // "task_<base32>"
export type RunId = string; // "run_<base32>"
export type LeaseId = string; // "lease_<base32>"
export type ArtifactId = string; // "art_<base32>"
export type EventId = number; // monotonic, assigned by the event log
export type AgentId = string; // "claude" | "codex" | "supervisor" | custom worker id

export const ID_PREFIX = {
  task: "task_",
  lease: "lease_",
  artifact: "art_",
  request: "req_",
  run: "run_",
} as const;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, no i/l/o/u

/** Injectable randomness so tests can be deterministic. */
export interface RandomSource {
  /** Returns `n` random bytes. */
  bytes(n: number): Uint8Array;
}

export const cryptoRandom: RandomSource = {
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    // globalThis.crypto is available on Node >= 19 without an import.
    globalThis.crypto.getRandomValues(out);
    return out;
  },
};

/** Deterministic counter-based source. Test-only; never use in production paths. */
export function seededRandom(seed = 1): RandomSource {
  let state = seed >>> 0;
  return {
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        // xorshift32
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        out[i] = state & 0xff;
      }
      return out;
    },
  };
}

export function newId(prefix: string, rng: RandomSource = cryptoRandom): string {
  const raw = rng.bytes(10);
  let s = "";
  for (const b of raw) s += ALPHABET[b % 32];
  return prefix + s;
}

export const newTaskId = (rng?: RandomSource): TaskId => newId(ID_PREFIX.task, rng);
export const newLeaseId = (rng?: RandomSource): LeaseId => newId(ID_PREFIX.lease, rng);
export const newArtifactId = (rng?: RandomSource): ArtifactId => newId(ID_PREFIX.artifact, rng);
export const newRunId = (rng?: RandomSource): RunId => newId(ID_PREFIX.run, rng);
