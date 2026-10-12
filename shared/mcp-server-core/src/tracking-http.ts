import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export interface TrackingLauncher { command: string; args: string[]; cwd: string }

/** The observer only ever displays its own loopback page; any other target is refused. */
function loopbackTarget(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TrackingError("BROWSER_OPEN_FAILED"); }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new TrackingError("BROWSER_OPEN_FAILED");
  }
  return parsed.href;
}

/** lstat, not stat: a launcher replaced by a link is not the trusted system binary. */
function systemFile(path: string): boolean {
  try { return isAbsolute(path) && lstatSync(path).isFile(); } catch { return false; }
}

/** System locations from the inherited trusted environment; path shape is not an ownership proof. */
function launcherDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  // Posix separators stay literal: the candidate set must not depend on the host running the check.
  if (platform !== "win32") return platform === "darwin" ? ["/usr/bin"] : ["/usr/bin", "/bin"];
  const roots = [env["SystemRoot"], env["windir"], "C:\\Windows"]
    .filter((root): root is string => typeof root === "string" && /^[a-zA-Z]:[\\/](?![\\/])/u.test(root));
  // join normalizes traversal segments; the regex already rejected relative and UNC roots.
  return [...new Set(roots.map(root => join(root, "System32")))];
}

/**
 * Resolve an absolute launcher installed in a system directory. Windows resolves a bare
 * executable from the working directory first and every platform searches a caller-controlled
 * PATH, so a repository checkout could otherwise supply the "browser".
 */
export function resolveTrackingLauncher(url: string, options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isSystemFile?: (path: string) => boolean;
} = {}): TrackingLauncher {
  const platform = options.platform ?? process.platform;
  const isSystemFile = options.isSystemFile ?? systemFile;
  const target = loopbackTarget(url);
  for (const directory of launcherDirectories(platform, options.env ?? process.env)) {
    if (platform === "win32") {
      const command = join(directory, "rundll32.exe");
      // url.dll carries the protocol handler itself; a missing one only fails after spawning.
      if (!isSystemFile(command) || !isSystemFile(join(directory, "url.dll"))) continue;
      // cwd is that same system directory, so the legacy CWD-first DLL search cannot be hijacked.
      return { command, args: ["url.dll,FileProtocolHandler", target], cwd: directory };
    }
    const command = `${directory}/${platform === "darwin" ? "open" : "xdg-open"}`;
    if (isSystemFile(command)) return { command, args: [target], cwd: directory };
  }
  throw new TrackingError("BROWSER_UNAVAILABLE");
}

/** Explicit browser display requested by the caller; no shell or model data interpolation. */
export async function openTrackingBrowser(url: string): Promise<void> {
  const launcher = resolveTrackingLauncher(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher.command, launcher.args, { cwd: launcher.cwd, shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new TrackingError("BROWSER_OPEN_FAILED")));
    // Some launchers stay alive with their browser. Opening must not block delegation.
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
