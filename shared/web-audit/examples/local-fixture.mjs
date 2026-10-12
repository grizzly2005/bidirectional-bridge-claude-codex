import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Synthetic loopback application. Its private markers are fixture strings, not target secrets. */
export async function listenFixture(initialMode = "vulnerable", port = 0) {
  let mode = initialMode;
  const server = createServer((req, res) => {
    const actor = req.headers["x-fixture-actor"];
    const actorId = actor === "fixture-a" ? "fixture-a" : actor === "fixture-b" ? "fixture-b" : null;
    const object = new URL(req.url, "http://127.0.0.1").pathname.split("/").at(-1);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Fixture-Only", "synthetic-loopback-no-bbp-performance");
    res.setHeader("X-Repeated", ["first", "second"]);
    const reply = (status, payload) => { res.statusCode = status; res.end(JSON.stringify({ actor: actorId, ...payload })); };
    if (req.method !== "GET" || !actorId) return reply(401, { error: "fixture identity missing" });
    if (!req.url.startsWith("/objects/") || !["a", "b"].includes(object)) return reply(404, { error: "fixture object absent" });
    if (actorId === "fixture-b" && object === "a") {
      if (mode === "fixed") return reply(403, { error: "fixture authorization denied" });
      if (mode === "error") return reply(200, { error: "fixture application error" });
      if (mode === "login") { res.setHeader("Location", "/login"); return reply(302, { error: "fixture login redirect" }); }
      if (mode === "timeout") { const timer = setTimeout(() => reply(200, { error: "fixture delayed" }), 10_000); res.once("close", () => clearTimeout(timer)); return; }
    }
    reply(200, { objectId: `fixture-object-${object}`, owner: `fixture-${object}`, tenant: "fixture-tenant", state: "active", private: `fixture-private-${object}` });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setMode(value) { mode = value; },
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await listenFixture(process.argv[2] ?? "vulnerable", Number(process.argv[3] ?? 8787));
  process.stdout.write(`${JSON.stringify({ context: "local-fixture", origin: fixture.origin, mode: process.argv[2] ?? "vulnerable" })}\n`);
  process.on("SIGINT", async () => { await fixture.close(); process.exitCode = 0; });
  process.on("SIGTERM", async () => { await fixture.close(); process.exitCode = 0; });
}
