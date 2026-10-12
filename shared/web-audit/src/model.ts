import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fact = { kind: "known"; value: string } | { kind: "unknown"; reason: string };
export const known = (value: string): Fact => ({ kind: "known", value });
export const unknown = (reason: string): Fact => ({ kind: "unknown", reason });
export interface Dimensions {
  actorId: Fact;
  actorRole: Fact;
  objectId: Fact;
  objectOwnerId: Fact;
  actorTenantId: Fact;
  objectTenantId: Fact;
  workflowState: Fact;
}
export interface Surface {
  origin: string;
  method: string;
  routeTemplate: string;
  parameterShape: string[];
  queryShape: { name: string; occurrence: number }[];
  bodyShape: string[];
}
export interface Header { name: string; value: string }
export interface Recipe {
  schemaVersion: 1;
  id: string;
  url: string;
  surface: Surface;
  dimensions: Dimensions;
  sessionRef: Fact;
  headers: Header[];
  secretHeaders: { name: string; env: string }[];
  bodyBase64: string;
  timeoutMs: number;
  maxResponseBytes: number;
  discovery: "observed" | "discovered";
  replaySafety: "idempotent-read" | "stateful-manual";
}
export interface Predicate {
  kind: "json-equals";
  expectedStatus: number;
  path: string[];
  equals: Json;
  denialStatuses: number[];
}
export interface Capture {
  schemaVersion: 1;
  id: string;
  runId: string;
  recipeId: string;
  recipeSha256: string;
  context: "local-fixture" | "authorized-program";
  execution: {
    tool: "node-http-v1";
    command: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
  transport: { outcome: "complete" | "timeout" | "error" | "truncated"; detail: string | null };
  request: { method: string; url: string; headers: Header[]; redactedHeaders: string[]; bodyBase64: string };
  response: { status: number; headers: Header[]; bodyBase64: string } | null;
  derived: { bodyUtf8: string | null; json: Json | null; jsonParsed: boolean; transformations: string[] };
  integrity: { requestSha256: string; responseBodySha256: string | null; recordSha256: string };
}
export type Status = "hypothesis" | "tested-inconclusive" | "rejected" | "confirmed-with-evidence";
export interface HistoryEvent {
  sequence: number;
  at: string;
  kind: "created" | "reviewed" | "reopened";
  status: Status;
  reason: string;
  receiptIds: string[];
  definitionSha256: string;
  previousSha256: string | null;
  sha256: string;
}
export interface Verification {
  kind: "differential-read-v1";
  positiveRecipeId: string;
  actorBaselineRecipeId: string;
  probeRecipeId: string;
  negativeRecipeId: string;
  actorIdentityPath: string[];
  protectedPredicate: Predicate;
  actorBaselinePredicate: Predicate;
  minimumRepetitions: number;
  finding: { rootCauseKey: string; affectedAssetKey: string; impactClass: string };
}
export interface HypothesisDraft {
  id: string;
  question: string;
  expected: { rule: string; provenance: "provided-policy" | "local-fixture" | "inference"; reference: string };
  preconditions: {
    id: string;
    description: string;
    state: "met" | "unknown" | "unmet";
    witnesses: { recipeId: string; predicate: Predicate }[];
  }[];
  predictions: { id: string; description: string }[];
  investigation: {
    recipeIds: string[];
    discriminates: string[];
    costMinutes: number;
    risk: "passive" | "read" | "write";
    businessLogic: boolean;
    promising: boolean;
  };
  verification: Verification | null;
  patternId: string | null;
}
export interface Hypothesis extends HypothesisDraft {
  status: Status;
  evidenceSince: string;
  history: HistoryEvent[];
}
export function hypothesisDefinition(hypothesis: Hypothesis): HypothesisDraft {
  const { status: _status, evidenceSince: _since, history: _history, ...draft } = hypothesis;
  return draft;
}
export type Lane = "single-agent" | "memory" | "two-agent" | "two-agent-oracle";
export interface TimedSession { id: string; lane: Lane; startedAt: string; endedAt: string | null }
export interface Program {
  id: string;
  context: "local-fixture" | "authorized-program";
  allowedOrigins: string[];
}
export interface ImportBundle {
  schemaVersion: 1;
  kind: "web-audit-import";
  program: Program;
  recipes: Recipe[];
  hypotheses: HypothesisDraft[];
}
export interface Campaign {
  schemaVersion: 1;
  kind: "web-audit-campaign";
  program: Program;
  recipes: Recipe[];
  hypotheses: Hypothesis[];
  captures: Capture[];
  sessions: TimedSession[];
}
export interface MatrixCell {
  key: string;
  surface: Surface;
  dimensions: Dimensions;
  exactUrls: string[];
  recipeIds: string[];
  receiptIds: string[];
  state: "not-tested" | "response-observed" | "transport-inconclusive";
  unknowns: string[];
}

/** A digest binds retained JSON/bytes. It is neither a signature nor a business oracle. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Non-JSON value");
}
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const digest = (value: unknown): string => sha256(canonical(value));

/** Receipt/run labels and invocation text do not create another physical HTTP execution. */
export function executionFingerprint(capture: Capture): string {
  const { tool, startedAt, endedAt, durationMs } = capture.execution;
  return digest({ tool, startedAt, endedAt, durationMs, transport: capture.transport, request: capture.request, response: capture.response });
}
export function uniqueExecutions(captures: Capture[]): Capture[] {
  const seen = new Set<string>();
  return captures.filter(capture => {
    const fingerprint = executionFingerprint(capture);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export function queryShape(url: string): Surface["queryShape"] {
  const seen = new Map<string, number>();
  return [...new URL(url).searchParams.keys()].map(name => {
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    return { name, occurrence };
  });
}
export function surfaceFromUrl(url: string, method: string, routeTemplate: string, parameterShape: string[] = [], bodyShape: string[] = []): Surface {
  return { origin: new URL(url).origin, method, routeTemplate, parameterShape, queryShape: queryShape(url), bodyShape };
}
export function matrix(campaign: Campaign): MatrixCell[] {
  const cells = new Map<string, MatrixCell>();
  for (const recipe of campaign.recipes) {
    const key = digest({ surface: recipe.surface, dimensions: recipe.dimensions });
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        key, surface: recipe.surface, dimensions: recipe.dimensions, exactUrls: [], recipeIds: [], receiptIds: [], state: "not-tested",
        unknowns: Object.entries(recipe.dimensions).filter(([, fact]) => fact.kind === "unknown").map(([name]) => name),
      };
      cells.set(key, cell);
    }
    if (!cell.exactUrls.includes(recipe.url)) cell.exactUrls.push(recipe.url);
    cell.recipeIds.push(recipe.id);
    const captures = campaign.captures.filter(c => c.recipeId === recipe.id && c.recipeSha256 === digest(recipe));
    cell.receiptIds.push(...captures.map(c => c.id));
    if (captures.some(c => c.transport.outcome === "complete")) cell.state = "response-observed";
    else if (captures.length && cell.state !== "response-observed") cell.state = "transport-inconclusive";
  }
  return [...cells.values()].sort((a, b) => a.key.localeCompare(b.key));
}
