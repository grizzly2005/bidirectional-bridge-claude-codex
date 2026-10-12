import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import type { Capture, Header, Program, Recipe } from "./model.js";
import { digest } from "./model.js";
import { parseImport, sealCapture } from "./validation.js";

/** No redirects, retries, fallback body, or inferred success. Secrets resolve only in this call. */
export async function replay(recipe: Recipe, program: Program, runId: string, options: {
  environment?: Record<string, string | undefined>;
  command?: string;
} = {}): Promise<Capture> {
  const snapshot = parseImport({ schemaVersion: 1, kind: "web-audit-import", program, recipes: [recipe], hypotheses: [] });
  recipe = snapshot.recipes[0]!;
  program = snapshot.program;
  if (recipe.replaySafety !== "idempotent-read") throw new Error("stateful-manual recipe requires a separate before/after runner; unsupported by automatic replay MVP");
  if (!runId.trim()) throw new Error("runId required");
  const environment = options.environment ?? process.env;
  const headers: Header[] = [...recipe.headers];
  for (const binding of recipe.secretHeaders) {
    const value = environment[binding.env];
    if (!value) throw new Error(`Missing environment binding ${binding.env} for recipe ${recipe.id}`);
    if (/[\r\n]/.test(value)) throw new Error(`Invalid header environment binding ${binding.env}`);
    headers.push({ name: binding.name, value });
  }
  const retainedHeaders = [...recipe.headers, ...recipe.secretHeaders.map(h => ({ name: h.name, value: "[redacted]" }))];
  const url = new URL(recipe.url);
  const body = Buffer.from(recipe.bodyBase64, "base64");
  const wireHeaders = [...headers, { name: "Host", value: url.host }];
  if (body.length) wireHeaders.push({ name: "Content-Length", value: String(body.length) });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const command = options.command ?? JSON.stringify({ api: "@bridge/web-audit.replay", recipeId: recipe.id, runId });
  return await new Promise<Capture>(resolve => {
    let response: Capture["response"] = null;
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: Capture["transport"]["outcome"], detail: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (response) response.bodyBase64 = Buffer.concat(chunks).toString("base64");
      resolve(sealCapture({
        schemaVersion: 1, runId, recipeId: recipe.id, recipeSha256: digest(recipe), context: program.context,
        execution: { tool: "node-http-v1", command, startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start },
        transport: { outcome, detail },
        request: { method: recipe.surface.method, url: recipe.url, headers: retainedHeaders, redactedHeaders: recipe.secretHeaders.map(h => h.name), bodyBase64: recipe.bodyBase64 },
        response,
      }));
    };
    const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = makeRequest(url, {
      method: recipe.surface.method,
      headers: wireHeaders.flatMap(h => [h.name, h.value]),
    }, res => {
      const raw: Header[] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push({ name: res.rawHeaders[i]!, value: res.rawHeaders[i + 1]! });
      response = { status: res.statusCode!, headers: raw, bodyBase64: "" };
      res.on("data", (chunk: Buffer) => {
        const available = recipe.maxResponseBytes - length;
        if (chunk.length > available) {
          if (available > 0) chunks.push(chunk.subarray(0, available));
          length += Math.max(0, available);
          finish("truncated", `Retained ${recipe.maxResponseBytes} bytes; response exceeded maxResponseBytes`);
          req.destroy();
          return;
        }
        chunks.push(chunk);
        length += chunk.length;
      });
      res.on("end", () => finish("complete", null));
      res.on("aborted", () => finish("error", "HTTP response aborted before complete body"));
      res.on("error", () => finish("error", "HTTP response stream failed"));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      // Error messages can echo inputs. Preserve the transport code rather than header secrets.
      finish("error", error.code ?? "HTTP request failed");
    });
    timeout = setTimeout(() => { finish("timeout", `Deadline ${recipe.timeoutMs}ms elapsed`); req.destroy(); }, recipe.timeoutMs);
    req.end(body);
  });
}
