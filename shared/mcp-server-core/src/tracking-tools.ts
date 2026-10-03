import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TrackingCoordinator, TRACKING_RESOURCE_URI } from "./tracking.js";
import { TrackingError } from "./tracking-reader.js";
import { TrackingHttpServer, openTrackingBrowser, trackingHtml } from "./tracking-http.js";

const viewId = z.string().regex(/^view_[a-f0-9]{32}$/u);
const runId = z.string().regex(/^run_[0-9a-hjkmnp-tv-z]{10}$/u);
const cursor = z.string().max(2048);
const schemas = {
  bridge_tracking_open: z.object({ run_id: runId.optional(), context_key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u).optional(), follow_current: z.boolean().optional(), display: z.enum(["inline", "browser"]).default("inline") }).strict(),
  bridge_tracking_bind: z.object({ view_id: viewId, run_id: runId.nullable() }).strict(),
  bridge_tracking_read: z.object({ view_id: viewId, after: cursor.optional() }).strict(),
  bridge_tracking_history: z.object({ view_id: viewId, page_token: cursor.optional(), state: z.enum(["PENDING", "CLAIMED", "WORKING", "BLOCKED", "VERIFYING", "DONE", "FAILED", "CANCELLED"]).optional(), owner: z.enum(["claude", "codex", "bridge"]).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  bridge_tracking_close: z.object({ view_id: viewId, disable: z.boolean().optional() }).strict(),
};
export const TRACKING_TOOL_NAMES = Object.keys(schemas);
const numeric = z.number().nonnegative().nullable();
const observation = z.object({ status: z.enum(["PENDING", "COMPLETE", "INCOMPLETE", "REJECTED", "LEGACY_UNKNOWN"]), accepted: z.boolean(), strict_required: z.boolean(), category: z.string().nullable() }).nullable();
const snapshotShape = {
  schema_version: z.literal(1), workspace_ref: z.string(), workspace_label: z.string(), view_id: viewId, run_id: runId.nullable(),
  snapshot_event_id: z.number().int().nonnegative(), next_cursor: cursor.nullable(), has_more: z.boolean(), observed_at: z.number(), stale_after_ms: z.number(), truncated: z.boolean(),
  tasks: z.array(z.object({ task_id: z.string(), run_id: z.string(), parent_task_id: z.string().nullable(), delegation_depth: z.number(), owner: z.string().nullable(), title: z.string(), state: z.string(), business_status: z.string().nullable(), execution_phase: z.string().nullable(), runtime_stop_confirmed: z.boolean().nullable(), cancel_requested: z.boolean(), attempt: z.number(), observation, created_at: numeric, updated_at: numeric, verification: z.object({ passed: z.number(), failed: z.number() }) })),
  attempts: z.array(z.object({ task_id: z.string(), attempt: numeric, agent: z.string().nullable(), resumed_from_attempt: numeric, started_at: numeric, ended_at: numeric, outcome: z.string().nullable(), failure_category: z.enum(["quota", "auth", "transient", "profile", "contract", "turn_limit", "unknown"]).nullable(), observation, telemetry: z.record(numeric).nullable() })),
  links: z.array(z.object({ from: z.string(), to: z.string(), kind: z.literal("delegation") })),
};
const historyShape = { schema_version: z.literal(1), workspace_ref: z.string(), items: z.array(z.object({ run_id: z.string(), root_task_id: z.string(), title: z.string(), created_at: numeric, updated_at: numeric, task_count: numeric, active_count: numeric })), next_page_token: cursor.nullable(), has_more: z.boolean() };
const openShape = { schema_version: z.literal(1), workspace_ref: z.string(), workspace_label: z.string(), view_id: viewId,
  run_id: runId.nullable(), task_count: z.number().int(), attempt_count: z.number().int(), truncated: z.boolean() };

/** The only HTTP operations. Open, workspace paths, caller identity and execution are absent. */
export function callTrackingOperation(tracking: TrackingCoordinator, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "bridge_tracking_bind": return tracking.bind(schemas.bridge_tracking_bind.parse(args));
    case "bridge_tracking_read": return tracking.read(schemas.bridge_tracking_read.parse(args));
    case "bridge_tracking_history": return tracking.history(schemas.bridge_tracking_history.parse(args));
    case "bridge_tracking_close": return tracking.closeView(schemas.bridge_tracking_close.parse(args));
    default: throw new TrackingError("TOOL_NOT_ALLOWED");
  }
}
export function registerTracking(server: McpServer, tracking: TrackingCoordinator, browser: TrackingHttpServer): void {
  registerAppResource(server, "Suivi des délégations", TRACKING_RESOURCE_URI,
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } },
    async () => ({ contents: [{ uri: TRACKING_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await trackingHtml(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));
  for (const [name, schema] of Object.entries(schemas)) {
    const isOpen = name === "bridge_tracking_open";
    const readOnly = name === "bridge_tracking_read" || name === "bridge_tracking_history";
    const registered = registerAppTool(server, name, {
      title: name.replace("bridge_tracking_", "Suivi : "),
      description: isOpen ? "Activate the opt-in read-only delegation view before a blocking bridge call. No worker, root or task is started. Choose browser for hosts without MCP Apps."
        : "Operate only this observation view; never change a task, cancel, recover, launch a worker or delegate.",
      inputSchema: schema.shape,
      outputSchema: isOpen ? openShape : name === "bridge_tracking_history" ? historyShape : name === "bridge_tracking_close" ? { closed: z.boolean(), disabled: z.boolean() } : snapshotShape,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...(isOpen ? { resourceUri: TRACKING_RESOURCE_URI } : {}), visibility: isOpen || name === "bridge_tracking_close" ? ["model", "app"] : ["app"] },
        ...(isOpen ? { "openai/outputTemplate": TRACKING_RESOURCE_URI, "openai/toolInvocation/invoking": "Ouverture du suivi", "openai/toolInvocation/invoked": "Suivi prêt" } : {}) },
    }, async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        let result: unknown; let meta: Record<string, unknown> | undefined;
        if (isOpen) {
          const parsed = schemas.bridge_tracking_open.parse(args);
          await trackingHtml();
          result = tracking.open(parsed);
          const snapshot = result as ReturnType<TrackingCoordinator["open"]>;
          // _meta is UI-only on Apps hosts: a large graph must not inflate model context.
          meta = { tracking_snapshot: snapshot };
          result = { schema_version: 1, workspace_ref: snapshot.workspace_ref, workspace_label: snapshot.workspace_label,
            view_id: snapshot.view_id, run_id: snapshot.run_id, task_count: snapshot.tasks.length,
            attempt_count: snapshot.attempts.length, truncated: snapshot.truncated };
          if (parsed.display === "browser") {
            try { await openTrackingBrowser(await browser.url(snapshot.view_id)); }
            catch (err) { meta["browser_error"] = err instanceof TrackingError ? err.code : "BROWSER_UNAVAILABLE"; }
          }
        } else result = callTrackingOperation(tracking, name, args as Record<string, unknown>);
        return { content: [{ type: "text", text: isOpen ? "Suivi activé. Les délégations continuent indépendamment de la vue." : "Vue de suivi actualisée." }], structuredContent: result as Record<string, unknown>, ...(meta ? { _meta: meta } : {}) };
      } catch (err) {
        const code = err instanceof TrackingError ? err.code : err instanceof z.ZodError ? "INVALID_ARGUMENT" : "TRACKING_UNAVAILABLE";
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code } }) }] };
      }
    });
    // The helper accepts raw shapes; preserve strict unknown-key rejection using the
    // registered SDK schema rather than its default object(shape) stripping behavior.
    registered.inputSchema = schema;
  }
}
