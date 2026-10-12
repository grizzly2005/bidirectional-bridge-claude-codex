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
export * from "./verification.js";
export * from "./artifact-transport.js";
export * from "./memory.js";

/** Wire capability version; minor additions preserve existing exported schema shapes. */
export const PROTOCOL_VERSION = "1.4.0";

/** Release identity; separate from the wire protocol and persisted schema versions. */
export const BRIDGE_VERSION = "0.4.0";
