import { App } from "@modelcontextprotocol/ext-apps";
import { mountTrackingUI } from "../shared/mcp-server-core/ui/tracking-ui.mjs";

const root = document.getElementById("bridge-tracking");
const allowed = new Set(["bridge_tracking_read", "bridge_tracking_bind", "bridge_tracking_history", "bridge_tracking_close"]);
let mounted;
function error(code = "TRACKING_UNAVAILABLE") { const result = new Error(code); result.code = code; return result; }
function unwrap(result) {
  if (result.isError) {
    let code;
    try { code = JSON.parse(result.content?.find(item => item.type === "text")?.text ?? "{}").error?.code; } catch { /* no private errors */ }
    throw error(code);
  }
  if (!result.structuredContent || result.structuredContent.schema_version !== 1 && !result.structuredContent.closed) throw error("INVALID_RESPONSE");
  return result.structuredContent;
}
function message(text) { root.replaceChildren(); const node = document.createElement("p"); node.textContent = text; root.append(node); }
function methods(call, initial, view_id, expand) {
  return { initial, view_id, expand,
    read: args => call("bridge_tracking_read", args), history: args => call("bridge_tracking_history", args),
    bind: args => call("bridge_tracking_bind", args), close: args => call("bridge_tracking_close", args) };
}

async function browser() {
  const params = new URLSearchParams(location.hash.slice(1));
  const viewId = params.get("view"); const token = params.get("token");
  // The capability never enters requests as a URL, storage, a log or the DOM.
  history.replaceState(null, "", location.pathname);
  if (!/^view_[a-f0-9]{32}$/u.test(viewId ?? "") || !token || token.length > 2048) { message("Réactivez le suivi depuis le chat pour ouvrir une vue autorisée."); return; }
  const call = async (name, args) => {
    if (!allowed.has(name)) throw error("TOOL_NOT_ALLOWED");
    const response = await fetch("/api", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, arguments: args }), credentials: "omit", signal: AbortSignal.timeout(8000) });
    const result = await response.json();
    if (!response.ok) throw error(result.error?.code);
    return result;
  };
  mounted = mountTrackingUI({ root, transport: methods(call, null, viewId, async () => { await document.documentElement.requestFullscreen?.(); }) });
  window.addEventListener("pagehide", () => mounted?.destroy(), { once: true });
}

async function embedded() {
  const app = new App({ name: "Bridge delegation tracking", version: "0.2.0" }, {});
  const call = async (name, args) => {
    if (!allowed.has(name)) throw error("TOOL_NOT_ALLOWED");
    const result = await app.callServerTool({ name, arguments: args });
    const data = unwrap(result);
    if (name === "bridge_tracking_close") await app.requestTeardown().catch(() => undefined);
    return data;
  };
  app.ontoolresult = result => {
    const initial = result._meta?.tracking_snapshot ?? result.structuredContent;
    if (!initial || initial.schema_version !== 1 || !/^view_[a-f0-9]{32}$/u.test(initial.view_id ?? "")) return;
    mounted?.destroy();
    mounted = mountTrackingUI({ root, transport: methods(call, initial, initial.view_id, () => app.requestDisplayMode({ mode: "fullscreen" })) });
  };
  app.onteardown = async () => { mounted?.destroy(); return {}; };
  app.onhostcontextchanged = context => {
    if (context.theme === "dark" || context.theme === "light") document.documentElement.dataset.theme = context.theme;
  };
  message("En attente de l’ouverture du suivi…");
  await app.connect();
  const context = app.getHostContext();
  if (context?.theme === "dark" || context?.theme === "light") document.documentElement.dataset.theme = context.theme;
}

(window.parent === window ? browser() : embedded()).catch(() => message("Le suivi est indisponible. Réactivez-le depuis le chat ; les délégations continuent."));
