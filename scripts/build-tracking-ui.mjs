import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const result = await build({ absWorkingDir: root, entryPoints: ["scripts/tracking-ui-entry.mjs"], bundle: true,
  write: false, format: "iife", platform: "browser", target: ["es2022"], minify: true, legalComments: "inline",
  define: { __BRIDGE_VERSION__: JSON.stringify(version) },
  // The SDK's development transport logs full frames. No protocol data belongs in logs.
  drop: ["console", "debugger"] });
const script = result.outputFiles[0].text.replace(/<\/script/giu, "<\\/script");
const style = (await readFile(resolve(root, "shared/mcp-server-core/ui/tracking-ui.css"), "utf8")).replace(/<\/style/giu, "<\\/style");
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>Suivi des délégations</title><style>${style}</style></head><body><main id="bridge-tracking"></main><script>${script}</script></body></html>`;
await mkdir(resolve(root, "shared/mcp-server-core/dist"), { recursive: true });
await writeFile(resolve(root, "shared/mcp-server-core/dist/tracking-ui.html"), html, "utf8");
