import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BRIDGE_VERSION } from "@bridge/protocol";
import { TrackingCoordinator, type TrackingOptions } from "./tracking.js";
import { TrackingHttpServer } from "./tracking-http.js";
import { registerTracking, TRACKING_TOOL_NAMES } from "./tracking-tools.js";

/** Independent reader for a private MCP tunnel. No ControlPlane, adapter, worker or recovery. */
export class TrackingMcpServer {
  readonly tracking: TrackingCoordinator;
  readonly browser: TrackingHttpServer;
  readonly mcp: McpServer;
  readonly toolNames = TRACKING_TOOL_NAMES;
  private closed = false;
  constructor(options: TrackingOptions) {
    this.tracking = new TrackingCoordinator(options);
    this.browser = new TrackingHttpServer(this.tracking);
    this.mcp = new McpServer({ name: "bridge-tracking-observer", version: BRIDGE_VERSION },
      { instructions: "Read-only bridge observation. Activate bridge_tracking_open on explicit request. Closing the view does not cancel tasks. This server cannot delegate, recover, resume or mutate bridge tasks." });
    registerTracking(this.mcp, this.tracking, this.browser);
  }
  async connect(transport?: Transport): Promise<void> { await this.mcp.connect(transport ?? new StdioServerTransport()); }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { await this.mcp.close(); } finally { await this.browser.close(); this.tracking.close(); }
  }
}
