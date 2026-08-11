/**
 * `@bridge/mcp-server-core` — the agent-neutral MCP server for the coordination bridge.
 *
 * Claude and Codex both build their launcher on this package. It deliberately depends only
 * on `@bridge/protocol` and `@bridge/control-plane`; importing an agent-specific package
 * from here would re-create the asymmetry this package exists to remove.
 */

export { BridgeMcpServer, DEFAULT_SERVER_INSTRUCTIONS } from "./server.js";
export type { BridgeServerOptions } from "./server.js";

export { serve, stderrLog } from "./lifecycle.js";
export type { LogSink, ServeHandle, ServeOptions } from "./lifecycle.js";

export { TOOLS, runTool } from "./tools.js";
export type { DelegationPolicy, ToolContext, ToolDefinition } from "./tools.js";

/** Re-exported so a launcher needs one import for the whole server surface. */
export { SimpleAdapterRegistry } from "@bridge/control-plane";
