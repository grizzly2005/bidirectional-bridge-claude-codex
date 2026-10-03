import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { z } from "zod";
import { TrackingError } from "./tracking-reader.js";
import type { TrackingCoordinator } from "./tracking.js";

export async function trackingHtml(): Promise<string> {
  try { return await readFile(new URL("../dist/tracking-ui.html", import.meta.url), "utf8"); }
  catch { throw new TrackingError("UI_BUILD_REQUIRED"); }
}

/** Loopback-only fallback. No cookies, query credentials, CORS, arbitrary paths or mutable tools. */
export class TrackingHttpServer {
  private server?: Server;
  private origin?: string;
  private starting?: Promise<string>;
  constructor(private readonly tracking: TrackingCoordinator) {}
  start(): Promise<string> {
    if (this.origin) return Promise.resolve(this.origin);
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async listen(): Promise<string> {
    const html = await trackingHtml();
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      try {
        if (request.headers.host !== new URL(this.origin!).host || (request.headers.origin && request.headers.origin !== this.origin)) { response.writeHead(403).end(); return; }
        const url = new URL(request.url ?? "/", this.origin);
        if (url.pathname === "/" && request.method === "GET" && !url.search) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
        if (url.pathname !== "/api" || url.search || request.method !== "POST" || request.headers["content-type"] !== "application/json") { response.writeHead(404).end(); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 8192) { response.writeHead(413).end(); return; } chunks.push(buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const args = body["arguments"] as Record<string, unknown> | undefined;
        const authorization = request.headers.authorization;
        if (!args || typeof args["view_id"] !== "string" || !authorization?.startsWith("Bearer ") || !this.tracking.authorizeBrowser(authorization.slice(7), args["view_id"])) {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { code: "VIEW_UNAVAILABLE" } })); return;
        }
        const { callTrackingOperation } = await import("./tracking-tools.js");
        const result = callTrackingOperation(this.tracking, String(body["name"]), args);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } catch (err) {
        response.writeHead(err instanceof TrackingError || err instanceof z.ZodError || err instanceof SyntaxError ? 400 : 500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: err instanceof TrackingError ? err.code : err instanceof z.ZodError || err instanceof SyntaxError ? "INVALID_ARGUMENT" : "TRACKING_UNAVAILABLE" } }));
      }
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new TrackingError("BROWSER_UNAVAILABLE"); }
    this.server = server; this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }
  async url(viewId: string): Promise<string> {
    const origin = await this.start();
    return `${origin}/#view=${encodeURIComponent(viewId)}&token=${encodeURIComponent(this.tracking.browserToken(viewId))}`;
  }
  async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server; this.server = undefined; this.origin = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

/** Explicit browser display requested by the caller; no shell or model data interpolation. */
export async function openTrackingBrowser(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new TrackingError("BROWSER_OPEN_FAILED")));
    // Some launchers stay alive with their browser. Opening must not block delegation.
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
