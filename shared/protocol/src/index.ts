/**
 * `@bridge/protocol` — the shared wire contract for the Claude <-> Codex bridge.
 *
 * Zero runtime dependencies by design: the Codex side must be able to import or vendor
 * this package without inheriting a dependency tree.
 */

export * from "./ids.js";
export * from "./errors.js";
export * from "./types.js";
export * from "./scope.js";
export * from "./validate.js";
export * from "./schemas.js";
export * from "./adapter.js";

/** Bumped when a breaking change lands in the wire contract. */
export const PROTOCOL_VERSION = "1.3.0";
