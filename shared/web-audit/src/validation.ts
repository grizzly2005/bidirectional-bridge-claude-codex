import type { Campaign, Capture, HypothesisDraft, ImportBundle, Json, Recipe } from "./model.js";
import { canonical, digest, hypothesisDefinition, queryShape, sha256 } from "./model.js";

type Check = (value: unknown, path: string) => void;
const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`); };
const str: Check = (v, p) => { if (typeof v !== "string" || !v.trim()) fail(p, "expected nonempty string"); };
const anyString: Check = (v, p) => { if (typeof v !== "string") fail(p, "expected string"); };
const number = (min: number, max = Number.MAX_SAFE_INTEGER): Check => (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(p, `expected number in [${min}, ${max}]`);
};
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Check => (v, p) => {
  number(min, max)(v, p); if (!Number.isInteger(v)) fail(p, "expected integer");
};
const choices = (...values: unknown[]): Check => (v, p) => { if (!values.includes(v)) fail(p, `expected ${values.join(" | ")}`); };
const bool: Check = (v, p) => { if (typeof v !== "boolean") fail(p, "expected boolean"); };
const array = (check: Check, min = 0): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min) fail(p, `expected array with at least ${min} items`);
  (v as unknown[]).forEach((item, i) => check(item, `${p}[${i}]`));
};
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p); };
const object = (shape: Record<string, Check>): Check => (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "expected object");
  const value = v as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!(key in shape)) fail(`${p}.${key}`, "unknown field");
  for (const [key, check] of Object.entries(shape)) check(value[key], `${p}.${key}`);
};
const json: Check = (v, p) => { try { canonical(v); } catch { fail(p, "expected finite JSON"); } };
const timestamp: Check = (v, p) => { str(v, p); if (!Number.isFinite(Date.parse(v as string))) fail(p, "invalid timestamp"); };
const hash: Check = (v, p) => { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail(p, "invalid SHA-256"); };
const base64: Check = (v, p) => {
  anyString(v, p); if (Buffer.from(v as string, "base64").toString("base64") !== v) fail(p, "noncanonical base64");
};
const fact: Check = (v, p) => {
  if (v && typeof v === "object" && "kind" in v && v.kind === "known") object({ kind: choices("known"), value: str })(v, p);
  else object({ kind: choices("unknown"), reason: str })(v, p);
};
const dimensions = object({ actorId: fact, actorRole: fact, objectId: fact, objectOwnerId: fact, actorTenantId: fact, objectTenantId: fact, workflowState: fact });
const header = object({ name: str, value: anyString });
const surface = object({ origin: str, method: str, routeTemplate: str, parameterShape: array(str), queryShape: array(object({ name: anyString, occurrence: integer(1) })), bodyShape: array(str) });
const predicate = object({ kind: choices("json-equals"), expectedStatus: integer(200, 599), path: array(str, 1), equals: json, denialStatuses: array(integer(400, 599)) });
const recipeCheck = object({ schemaVersion: choices(1), id: str, url: str, surface, dimensions, sessionRef: fact, headers: array(header), secretHeaders: array(object({ name: str, env: str })), bodyBase64: base64, timeoutMs: integer(1, 300_000), maxResponseBytes: integer(1, 16_777_216), discovery: choices("observed", "discovered"), replaySafety: choices("idempotent-read", "stateful-manual") });
const verification = object({
  kind: choices("differential-read-v1"), positiveRecipeId: str, actorBaselineRecipeId: str, probeRecipeId: str, negativeRecipeId: str,
  actorIdentityPath: array(str, 1), protectedPredicate: predicate, actorBaselinePredicate: predicate, minimumRepetitions: integer(2, 100),
  finding: object({ rootCauseKey: str, affectedAssetKey: str, impactClass: str }),
});
const draftShape = {
  id: str, question: str, expected: object({ rule: str, provenance: choices("provided-policy", "local-fixture", "inference"), reference: str }),
  preconditions: array(object({ id: str, description: str, state: choices("met", "unknown", "unmet"), witnesses: array(object({ recipeId: str, predicate })) })),
  predictions: array(object({ id: str, description: str }), 2),
  investigation: object({ recipeIds: array(str), discriminates: array(str, 2), costMinutes: number(0.01), risk: choices("passive", "read", "write"), businessLogic: bool, promising: bool }),
  verification: nullable(verification), patternId: nullable(str),
};
const status = choices("hypothesis", "tested-inconclusive", "rejected", "confirmed-with-evidence");
const history = object({ sequence: integer(0), at: timestamp, kind: choices("created", "reviewed", "reopened"), status, reason: str, receiptIds: array(str), definitionSha256: hash, previousSha256: nullable(hash), sha256: hash });
const hypothesis = object({ ...draftShape, status, evidenceSince: timestamp, history: array(history, 1) });
const program = object({ id: str, context: choices("local-fixture", "authorized-program"), allowedOrigins: array(str, 1) });
const captureCheck = object({
  schemaVersion: choices(1), id: str, runId: str, recipeId: str, recipeSha256: hash, context: choices("local-fixture", "authorized-program"),
  execution: object({ tool: choices("node-http-v1"), command: str, startedAt: timestamp, endedAt: timestamp, durationMs: number(0) }),
  transport: object({ outcome: choices("complete", "timeout", "error", "truncated"), detail: nullable(str) }),
  request: object({ method: str, url: str, headers: array(header), redactedHeaders: array(str), bodyBase64: base64 }),
  response: nullable(object({ status: integer(100, 599), headers: array(header), bodyBase64: base64 })),
  derived: object({ bodyUtf8: nullable(anyString), json: json, jsonParsed: bool, transformations: array(str) }),
  integrity: object({ requestSha256: hash, responseBodySha256: nullable(hash), recordSha256: hash }),
});
const campaignCheck = object({ schemaVersion: choices(1), kind: choices("web-audit-campaign"), program, recipes: array(recipeCheck), hypotheses: array(hypothesis), captures: array(captureCheck), sessions: array(object({ id: str, lane: choices("single-agent", "memory", "two-agent", "two-agent-oracle"), startedAt: timestamp, endedAt: nullable(timestamp) })) });
const bundleCheck = object({ schemaVersion: choices(1), kind: choices("web-audit-import"), program, recipes: array(recipeCheck), hypotheses: array(object(draftShape)) });

export function derive(response: Capture["response"]): Capture["derived"] {
  if (!response) return { bodyUtf8: null, json: null, jsonParsed: false, transformations: [] };
  const body = Buffer.from(response.bodyBase64, "base64");
  // Fatal decoding avoids treating replacement characters as retained response bytes.
  try {
    const bodyUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(body);
    try { return { bodyUtf8, json: JSON.parse(bodyUtf8) as Json, jsonParsed: true, transformations: ["utf8", "json-parse"] }; }
    catch { return { bodyUtf8, json: null, jsonParsed: false, transformations: ["utf8"] }; }
  } catch { return { bodyUtf8: null, json: null, jsonParsed: false, transformations: ["binary-retained"] }; }
}
export function sealCapture(value: Omit<Capture, "id" | "integrity" | "derived">): Capture {
  const derived = derive(value.response);
  const integrity = { requestSha256: digest(value.request), responseBodySha256: value.response ? sha256(Buffer.from(value.response.bodyBase64, "base64")) : null };
  const recordSha256 = digest({ ...value, derived, integrity });
  return { ...value, id: `capture-${recordSha256}`, derived, integrity: { ...integrity, recordSha256 } };
}
export function validateCapture(value: unknown): asserts value is Capture {
  captureCheck(value, "capture");
  const capture = value as Capture;
  const { id: _id, integrity: _integrity, derived: _derived, ...base } = capture;
  const sealed = sealCapture(base);
  if (canonical(sealed) !== canonical(capture)) fail("capture", "retained bytes, derived view, or receipt integrity mismatch");
  if (Date.parse(capture.execution.endedAt) < Date.parse(capture.execution.startedAt)) fail("capture", "negative elapsed interval");
  if (capture.transport.outcome === "complete" && !capture.response) fail("capture", "complete requires an HTTP response");
}
export function validateRecipe(value: unknown): asserts value is Recipe {
  recipeCheck(value, "recipe");
  const r = value as Recipe;
  const url = new URL(r.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("recipe.url", "HTTP URL without credentials or fragment required");
  // Match the serializer used by Node's HTTP request target; do not retain a path that was rewritten before sending.
  if (r.url !== `${url.origin}${url.pathname}${url.search}`) fail("recipe.url", "canonical HTTP URL required; serialize dot segments, spaces and Unicode before defining the recipe");
  if (r.surface.origin !== url.origin || canonical(r.surface.queryShape) !== canonical(queryShape(r.url))) fail("recipe.surface", "origin/query shape diverges from exact URL");
  if (!/^[A-Z]+$/.test(r.surface.method) || !r.surface.routeTemplate.startsWith("/")) fail("recipe.surface", "uppercase method and absolute route template required");
  if (r.replaySafety === "idempotent-read" && (!["GET", "HEAD"].includes(r.surface.method) || r.bodyBase64 !== "")) fail("recipe.replaySafety", "idempotent-read requires GET/HEAD with no request body");
  const headers = [...r.headers, ...r.secretHeaders];
  const names = headers.map(h => h.name.toLowerCase());
  if (headers.some(h => !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(h.name))) fail("recipe.headers", "invalid HTTP header name");
  if (names.some(n => ["host", ":authority", "content-length", "transfer-encoding"].includes(n))) fail("recipe.headers", "authority/framing is derived from URL/body; conflicting override refused");
  for (const h of r.headers) if (/[\r\n]/.test(h.name + h.value)) fail("recipe.headers", "invalid newline");
  for (const h of r.secretHeaders) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(h.env) || /[\r\n]/.test(h.name)) fail("recipe.secretHeaders", "invalid environment/header name");
  if (r.headers.some(h => ["authorization", "cookie", "proxy-authorization"].includes(h.name.toLowerCase()))) fail("recipe.headers", "use secretHeaders environment references for credentials");
  if (new Set(names.filter(n => r.secretHeaders.some(h => h.name.toLowerCase() === n))).size !== r.secretHeaders.length || r.headers.some(h => r.secretHeaders.some(s => s.name.toLowerCase() === h.name.toLowerCase()))) fail("recipe.secretHeaders", "ambiguous public/secret header binding");
}
export function validateDraft(value: unknown): asserts value is HypothesisDraft {
  object(draftShape)(value, "hypothesis");
  const h = value as HypothesisDraft;
  unique(h.predictions, "predictions"); unique(h.preconditions, "preconditions");
  if (new Set(h.investigation.discriminates).size < 2 || h.investigation.discriminates.some(id => !h.predictions.some(p => p.id === id))) fail("hypothesis.investigation", "must discriminate at least two existing predictions");
  if (h.verification && h.verification.protectedPredicate.denialStatuses.includes(h.verification.protectedPredicate.expectedStatus)) fail("hypothesis.verification", "expected status cannot also be denied");
}
function unique(values: { id: string }[], path: string): void {
  if (new Set(values.map(v => v.id)).size !== values.length) fail(path, "duplicate ID");
}
function semantic(programValue: Campaign["program"], recipes: Recipe[], drafts: HypothesisDraft[]): void {
  for (const origin of programValue.allowedOrigins) {
    const u = new URL(origin);
    if (u.origin !== origin || !["http:", "https:"].includes(u.protocol)) fail("program.allowedOrigins", "exact URL origins required, including port");
  }
  unique(recipes, "recipes"); unique(drafts, "hypotheses");
  for (const r of recipes) {
    validateRecipe(r);
    if (!programValue.allowedOrigins.includes(r.surface.origin)) fail("recipe.surface.origin", "not in program origins");
    if (programValue.context === "local-fixture" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(r.url).hostname)) fail("recipe.url", "local-fixture requires loopback");
  }
  for (const h of drafts) {
    const { status: _status, evidenceSince: _since, history: _history, ...draft } = h as Campaign["hypotheses"][number];
    validateDraft(draft);
    const ids = [...h.investigation.recipeIds, ...h.preconditions.flatMap(p => p.witnesses.map(w => w.recipeId))];
    if (h.verification) ids.push(h.verification.positiveRecipeId, h.verification.actorBaselineRecipeId, h.verification.probeRecipeId, h.verification.negativeRecipeId);
    if (ids.some(id => !recipes.some(r => r.id === id))) fail("hypothesis", "references missing recipe");
  }
}
export function parseImport(value: unknown): ImportBundle {
  bundleCheck(value, "import");
  const bundle = value as ImportBundle;
  semantic(bundle.program, bundle.recipes, bundle.hypotheses);
  return structuredClone(bundle);
}
export function parseCampaign(value: unknown): Campaign {
  campaignCheck(value, "campaign");
  const campaign = value as Campaign;
  semantic(campaign.program, campaign.recipes, campaign.hypotheses);
  unique(campaign.captures, "captures"); unique(campaign.sessions, "sessions");
  for (const c of campaign.captures) {
    validateCapture(c);
    const recipe = campaign.recipes.find(r => r.id === c.recipeId);
    if (!recipe) throw new Error("capture: missing recipe binding");
    if (digest(recipe) !== c.recipeSha256 || c.request.url !== recipe.url || c.request.method !== recipe.surface.method || c.request.bodyBase64 !== recipe.bodyBase64 || c.context !== campaign.program.context) fail("capture", "recipe/context binding mismatch");
    const expectedHeaders = [...recipe.headers, ...recipe.secretHeaders.map(h => ({ name: h.name, value: "[redacted]" }))];
    if (canonical(c.request.headers) !== canonical(expectedHeaders) || canonical(c.request.redactedHeaders) !== canonical(recipe.secretHeaders.map(h => h.name))) fail("capture", "request header binding mismatch");
  }
  for (const h of campaign.hypotheses) {
    let previous: string | null = null;
    for (const [i, event] of h.history.entries()) {
      const { sha256: saved, ...body } = event;
      if (event.sequence !== i || event.previousSha256 !== previous || event.definitionSha256 !== digest(hypothesisDefinition(h)) || digest(body) !== saved || (i === 0 && (event.kind !== "created" || event.status !== "hypothesis")) || (i > 0 && (event.kind === "created" || Date.parse(event.at) < Date.parse(h.history[i - 1]!.at))) || event.receiptIds.some(id => !campaign.captures.some(c => c.id === id))) fail("hypothesis.history", "broken append-only chain, changed definition or missing receipt");
      previous = saved;
    }
    if (h.history.at(-1)?.status !== h.status) fail("hypothesis.status", "must match last history event");
    const reset = [...h.history].reverse().find(e => e.kind === "reopened" || e.kind === "created");
    if (h.evidenceSince !== reset?.at) fail("hypothesis.evidenceSince", "must match creation or latest reopening");
  }
  for (const s of campaign.sessions) if (s.endedAt !== null && Date.parse(s.endedAt) <= Date.parse(s.startedAt)) fail("session", "end must follow start");
  return structuredClone(campaign);
}
