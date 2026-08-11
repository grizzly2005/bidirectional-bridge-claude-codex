/**
 * Error taxonomy shared by both agents.
 *
 * Every failure crossing the bridge is a `BridgeError` with a stable machine-readable
 * `code`. Adapters branch on `code`, never on message text.
 */

export const ErrorCode = {
  /** Payload failed JSON Schema validation. */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  /** Referenced task/lease/artifact does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** State machine forbids this transition (e.g. DONE -> WORKING). */
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  /** Caller is not the owner of the task it is trying to mutate. */
  NOT_OWNER: "NOT_OWNER",
  /** Requested write scope overlaps a live lease held by someone else. */
  SCOPE_CONFLICT: "SCOPE_CONFLICT",
  /** Lease expired or was released; the write must not proceed. */
  LEASE_INVALID: "LEASE_INVALID",
  /** Task cannot start because dependencies are unsatisfied. */
  DEPENDENCY_UNSATISFIED: "DEPENDENCY_UNSATISFIED",
  /** Dependency edge would create a cycle. */
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
  /** Same idempotency key replayed with a different payload. */
  IDEMPOTENCY_MISMATCH: "IDEMPOTENCY_MISMATCH",
  /** Adapter/agent did not respond within its deadline. */
  TIMEOUT: "TIMEOUT",
  /** Adapter failed for an agent-specific reason; see `details`. */
  ADAPTER_FAILURE: "ADAPTER_FAILURE",
  /** Runtime-reported execution profile contradicts the bridge-owned profile. */
  RUNTIME_PROFILE_MISMATCH: "RUNTIME_PROFILE_MISMATCH",
  /** Operation is not implemented by this build (e.g. deferred features). */
  UNIMPLEMENTED: "UNIMPLEMENTED",
  /** Unclassified internal fault. */
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Codes where an identical retry may succeed later. */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.SCOPE_CONFLICT,
  ErrorCode.DEPENDENCY_UNSATISFIED,
  ErrorCode.TIMEOUT,
  ErrorCode.INTERNAL,
]);

export interface BridgeErrorJSON {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  toJSON(): BridgeErrorJSON {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }

  static from(err: unknown): BridgeError {
    if (err instanceof BridgeError) return err;
    if (err instanceof Error) {
      return new BridgeError(ErrorCode.INTERNAL, err.message, { cause: err.name });
    }
    return new BridgeError(ErrorCode.INTERNAL, String(err));
  }
}

export const invalidArgument = (m: string, d?: Record<string, unknown>) =>
  new BridgeError(ErrorCode.INVALID_ARGUMENT, m, d);
export const notFound = (m: string, d?: Record<string, unknown>) =>
  new BridgeError(ErrorCode.NOT_FOUND, m, d);
export const scopeConflict = (m: string, d?: Record<string, unknown>) =>
  new BridgeError(ErrorCode.SCOPE_CONFLICT, m, d);
