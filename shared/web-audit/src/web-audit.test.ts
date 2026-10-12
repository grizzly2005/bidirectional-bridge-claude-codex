import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Campaign, HypothesisDraft, ImportBundle } from "./index.js";
import {
  assessHypothesis, authorPattern, campaignMetrics, compareCampaigns, createHypothesis, digest,
  executionFingerprint, findingKey, importCampaign, instantiatePattern, matrix, parseCampaign, parseImport, parsePattern,
  planInvestigations, refutationPacket, reopenHypothesis, replay, reviewHypothesis,
  routeInvestigation, sealCapture, sha256, startSession, stopSession, surfaceFromUrl, unknown, validateCapture,
} from "./index.js";
// These JavaScript examples create an actual synthetic loopback HTTP server; they are not target evidence.
import { listenFixture } from "../examples/local-fixture.mjs";
import { fixtureBundle } from "../examples/fixture-bundle.mjs";

let fixture: Awaited<ReturnType<typeof listenFixture>>;
const initial = "2000-01-01T00:00:00.000Z";
const seed = (): Campaign => importCampaign(fixtureBundle(fixture.origin) as ImportBundle, initial);
const hId = "fixture-object-isolation";
async function collect(campaign: Campaign, count = 2): Promise<Campaign> {
  for (let n = 0; n < count; n++) {
    const runId = randomUUID();
    for (const recipe of campaign.recipes) campaign.captures.push(await replay(recipe, campaign.program, runId));
  }
  return campaign;
}
beforeAll(async () => { fixture = await listenFixture(); });
beforeEach(() => { fixture.setMode("vulnerable"); });
afterAll(async () => { await fixture.close(); });

describe("versioned matrix and exact context", () => {
  it("keeps same-role actors, owner, tenant and state separate", () => {
    const campaign = seed();
    const cells = matrix(campaign);
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map(c => JSON.stringify(c.dimensions.actorId))).size).toBe(2);
    expect(new Set(cells.map(c => JSON.stringify(c.dimensions.actorRole))).size).toBe(1);
    expect(cells.every(c => c.state === "not-tested")).toBe(true);
    campaign.recipes[0]!.dimensions.objectTenantId = unknown("Object tenant not observed");
    expect(matrix(campaign).find(c => c.recipeIds.includes("own-a"))!.unknowns).toEqual(["objectTenantId"]);
    expect(campaign.recipes[0]!.dimensions.actorTenantId.kind).toBe("known");
  });
  it("preserves origin/port, method, duplicate query order and exact URLs", () => {
    const campaign = seed();
    const first = campaign.recipes[0]!;
    const copies = [
      { id: "other-port", url: "http://127.0.0.1:65534/objects/a?x=1&x=2&y=3", method: "GET" },
      { id: "other-host", url: "http://localhost:65534/objects/a?x=1&x=2&y=3", method: "GET" },
      { id: "other-query", url: `${fixture.origin}/objects/a?y=3&x=1&x=2`, method: "GET" },
      { id: "other-method", url: `${fixture.origin}/objects/a`, method: "HEAD" },
    ];
    for (const copy of copies) {
      const surface = surfaceFromUrl(copy.url, copy.method, first.surface.routeTemplate, ["objectId:string"]);
      campaign.program.allowedOrigins.push(surface.origin);
      campaign.recipes.push({ ...structuredClone(first), id: copy.id, url: copy.url, surface });
    }
    expect(matrix(parseCampaign(campaign))).toHaveLength(8);
    expect(campaign.recipes[4]!.surface.queryShape).toEqual([{ name: "x", occurrence: 1 }, { name: "x", occurrence: 2 }, { name: "y", occurrence: 1 }]);
    expect(matrix(campaign).flatMap(c => c.exactUrls)).toContain(copies[0]!.url);
  });
  it("refuses incomplete structures, authority mismatch and plaintext session credentials", () => {
    const bundle = fixtureBundle(fixture.origin);
    const missing = structuredClone(bundle); delete missing.recipes[0].dimensions.objectTenantId;
    expect(() => parseImport(missing)).toThrow(/objectTenantId/);
    const authority = structuredClone(bundle); authority.recipes[0].surface.origin = "http://localhost:65534";
    expect(() => parseImport(authority)).toThrow(/origin/);
    const host = structuredClone(bundle); host.recipes[0].headers.push({ name: "Host", value: "other.invalid" });
    expect(() => parseImport(host)).toThrow(/authority/);
    const credentials = structuredClone(bundle); credentials.recipes[0].headers.push({ name: "Authorization", value: "fixture-value" });
    expect(() => parseImport(credentials)).toThrow(/secretHeaders/);
    expect(() => parseImport({ ...bundle, schemaVersion: 99 })).toThrow(/schemaVersion/);
    expect(() => parseImport({ ...bundle, status: "COMPLETE" })).toThrow(/unknown field/);
  });
  it.each(["/shadow/../objects/a", "/objects/a b", "/objets/été", "/objects/a?q=été"])("refuses noncanonical HTTP URL %s before capture", async path => {
    const campaign = seed();
    campaign.recipes[0]!.url = `${fixture.origin}${path}`;
    expect(() => parseCampaign(campaign)).toThrow(/canonical HTTP URL/);
    await expect(replay(campaign.recipes[0]!, campaign.program, "noncanonical")).rejects.toThrow(/canonical HTTP URL/);
  });
  it("matches the actual Node request target for serialized Unicode/spaces and preserves port/query duplicates", async () => {
    const server = createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ target: req.url, host: req.headers.host })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture expected a TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (const path of ["/objects/a%20b?x=1&x=2&q=a+b", "/objets/%C3%A9?q=%C3%A9&x=1&x=2", "/objects/a?b=1&a=2&b=3"]) {
        const bundle = fixtureBundle(origin) as ImportBundle;
        const recipe = bundle.recipes[0]!;
        recipe.url = `${origin}${path}`;
        recipe.surface = surfaceFromUrl(recipe.url, "GET", "/objects/{objectId}", ["objectId:string"]);
        const capture = await replay(recipe, bundle.program, "serialized-wire-target");
        expect(capture.derived.json).toEqual({ target: path, host: new URL(recipe.url).host });
        expect(capture.request.url).toBe(`${origin}${path}`);
        expect(() => parseCampaign({ ...importCampaign(bundle, initial), captures: [capture] })).not.toThrow();
      }
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
});

describe("real local replay and differential evidence", () => {
  it("captures exact retained response bytes, duplicate headers and verified raw/derived integrity", async () => {
    const campaign = await collect(seed(), 1);
    const capture = campaign.captures[0]!;
    expect(capture.transport.outcome).toBe("complete");
    expect(capture.context).toBe("local-fixture");
    const bytes = Buffer.from(capture.response!.bodyBase64, "base64");
    expect(capture.integrity.responseBodySha256).toBe(sha256(bytes));
    expect(capture.response!.headers.filter(h => h.name.toLowerCase() === "x-repeated").map(h => h.value)).toEqual(["first", "second"]);
    expect(capture.derived.json).toMatchObject({ owner: "fixture-a", actor: "fixture-a" });
    expect(() => validateCapture(capture)).not.toThrow();
    expect(matrix(campaign).every(c => c.state === "response-observed")).toBe(true);
    const tampered = structuredClone(capture); tampered.derived.json = { invented: true };
    expect(() => validateCapture(tampered)).toThrow(/integrity mismatch/);
    const corrupted = structuredClone(capture); corrupted.response!.bodyBase64 = Buffer.from("different").toString("base64");
    expect(() => validateCapture(corrupted)).toThrow(/integrity mismatch/);
    const { id: _id, integrity: _integrity, derived: _derived, ...base } = capture;
    const wrongBinding = sealCapture({ ...base, request: { ...base.request, url: "http://127.0.0.1:65534/objects/a" } });
    expect(() => parseCampaign({ ...campaign, captures: [wrongBinding] })).toThrow(/recipe\/context binding mismatch/);
  });
  it("confirms only two repeatable controlled comparisons and appends history without mutation", async () => {
    const campaign = await collect(seed());
    const before = JSON.stringify(campaign.hypotheses[0]!.history);
    const result = reviewHypothesis(campaign, hId);
    expect(result.assessment.status).toBe("confirmed-with-evidence");
    expect(result.assessment.receiptIds).toHaveLength(8);
    expect(result.assessment.runs.every(r => r.outcome === "supported")).toBe(true);
    expect(JSON.stringify(campaign.hypotheses[0]!.history)).toBe(before);
    expect(result.campaign.hypotheses[0]!.history).toHaveLength(2);
    const tampered = structuredClone(result.campaign); tampered.hypotheses[0]!.history[0]!.reason = "rewritten";
    expect(() => parseCampaign(tampered)).toThrow(/append-only chain/);
    const claimed = seed(); claimed.hypotheses[0]!.status = "confirmed-with-evidence";
    expect(assessHypothesis(claimed, hId).status).toBe("tested-inconclusive");
  });
  it("does not count resealed receipt/run/command labels as independent HTTP executions", async () => {
    const campaign = await collect(seed(), 1);
    const actual = [...campaign.captures];
    const runId = randomUUID();
    for (const capture of actual) {
      const { id: _id, integrity: _integrity, derived: _derived, ...base } = capture;
      const renamed = sealCapture({ ...base, runId, execution: { ...base.execution, command: "different receipt label, same physical execution" } });
      expect(executionFingerprint(renamed)).toBe(executionFingerprint(capture));
      campaign.captures.push(renamed);
    }
    const assessment = assessHypothesis(campaign, hId);
    expect(campaign.captures).toHaveLength(8);
    expect(assessment.status).toBe("tested-inconclusive");
    expect(assessment.receiptIds).toHaveLength(4);
    expect(assessment.runs).toHaveLength(1);
    expect(assessment.duplicateExecutionReceiptIds).toHaveLength(4);
    await collect(campaign, 1);
    expect(assessHypothesis(campaign, hId).status).toBe("confirmed-with-evidence");
    expect(assessHypothesis(campaign, hId).receiptIds).toHaveLength(8);
  });
  it("keeps a single run, missing control and unknown object tenant inconclusive", async () => {
    const campaign = await collect(seed(), 1);
    expect(assessHypothesis(campaign, hId).status).toBe("tested-inconclusive");
    await collect(campaign, 1);
    const missing = structuredClone(campaign); missing.captures = missing.captures.filter(c => c.recipeId !== "negative-b");
    expect(assessHypothesis(missing, hId).status).toBe("tested-inconclusive");
    const unknownTenant = seed(); unknownTenant.recipes[2]!.dimensions.objectTenantId = unknown("not supplied");
    await collect(unknownTenant);
    expect(assessHypothesis(unknownTenant, hId).reason).toMatch(/incomplete/);
  });
  it.each(["fixed", "error"])("refutes the protected predicate for fixture mode %s without treating HTTP status as proof", async mode => {
    fixture.setMode(mode);
    const campaign = await collect(seed());
    expect(assessHypothesis(campaign, hId).status).toBe("rejected");
  });
  it.each(["login", "timeout"])("keeps fixture mode %s inconclusive", async mode => {
    fixture.setMode(mode);
    const campaign = seed(); campaign.recipes.forEach(r => { r.timeoutMs = 40; });
    await collect(campaign);
    expect(assessHypothesis(campaign, hId).status).toBe("tested-inconclusive");
    const probes = campaign.captures.filter(c => c.recipeId === "cross-b-a");
    if (mode === "timeout") expect(probes.every(c => c.transport.outcome === "timeout" && c.response === null)).toBe(true);
    else expect(probes.every(c => c.response?.status === 302 && c.request.url.endsWith("/objects/a"))).toBe(true);
  });
  it("invalidates confirmed evidence on contradictory actual captures, and reopening excludes old runs", async () => {
    let campaign = reviewHypothesis(await collect(seed()), hId).campaign;
    fixture.setMode("fixed"); await collect(campaign, 1);
    const contradiction = assessHypothesis(campaign, hId);
    expect(contradiction.status).toBe("tested-inconclusive");
    expect(contradiction.reason).toMatch(/Contradictory/);
    expect(campaignMetrics(campaign).uniqueVerifiedFindings).toBe(0);
    const latest = Math.max(...campaign.captures.map(c => Date.parse(c.execution.endedAt)), Date.parse(campaign.hypotheses[0]!.history.at(-1)!.at));
    campaign = reopenHypothesis(campaign, hId, "Fixture behavior changed", new Date(latest + 1).toISOString());
    expect(campaign.hypotheses[0]!.history).toHaveLength(3);
    expect(assessHypothesis(campaign, hId).receiptIds).toHaveLength(0);
    expect(assessHypothesis(campaign, hId).status).toBe("tested-inconclusive");
  });
  it("does not promote a mismatched actor identity or failed state predicate", async () => {
    const wrongActor = seed(); wrongActor.recipes[2]!.headers[0]!.value = "fixture-a";
    await collect(wrongActor);
    expect(assessHypothesis(wrongActor, hId).runs.every(r => r.outcome === "inconclusive")).toBe(true);
    const bundle = fixtureBundle(fixture.origin); bundle.hypotheses[0].preconditions[2].witnesses[0].predicate.equals = "deleted";
    const wrongState = importCampaign(bundle, initial);
    await collect(wrongState);
    expect(assessHypothesis(wrongState, hId).status).toBe("tested-inconclusive");
  });
  it("retains truncation explicitly and refuses stateful automatic recipes", async () => {
    const campaign = seed(); campaign.recipes.forEach(r => { r.maxResponseBytes = 16; });
    await collect(campaign);
    expect(campaign.captures.every(c => c.transport.outcome === "truncated" && Buffer.from(c.response!.bodyBase64, "base64").length === 16)).toBe(true);
    expect(assessHypothesis(campaign, hId).status).toBe("tested-inconclusive");
    expect(planInvestigations(campaign, []).candidates[0]!.reasons).toContain("4 capture gaps (+8)");
    const stateful = { ...seed().recipes[0]!, replaySafety: "stateful-manual" as const };
    await expect(replay(stateful, campaign.program, "stateful")).rejects.toThrow(/separate before\/after runner/);
  });
  it("resolves environment credentials only at capture time and redacts retained request headers", async () => {
    const campaign = seed();
    const recipe = campaign.recipes[0]!; recipe.headers = []; recipe.secretHeaders = [{ name: "X-Fixture-Actor", env: "FIXTURE_ACTOR" }];
    await expect(replay(recipe, campaign.program, "missing", { environment: {} })).rejects.toThrow(/Missing environment binding/);
    const capture = await replay(recipe, campaign.program, "bound", { environment: { FIXTURE_ACTOR: "fixture-a" } });
    expect(capture.request.headers).toEqual([{ name: "X-Fixture-Actor", value: "[redacted]" }]);
    expect(capture.request.redactedHeaders).toEqual(["X-Fixture-Actor"]);
    expect(capture.derived.json).toMatchObject({ actor: "fixture-a" });
    expect(() => parseCampaign({ ...campaign, captures: [capture] })).not.toThrow();
  });
  it("binds the recipe snapshot actually executed when the caller mutates input during HTTP capture", async () => {
    const campaign = seed();
    const recipe = campaign.recipes[0]!, original = structuredClone(recipe);
    const pending = replay(recipe, campaign.program, "snapshot");
    recipe.url = "http://127.0.0.1:65534/changed";
    recipe.headers[0]!.value = "fixture-b";
    const capture = await pending;
    expect(capture.recipeSha256).toBe(digest(original));
    expect(capture.request.url).toBe(original.url);
    expect(capture.request.headers).toEqual(original.headers);
    expect(capture.derived.json).toMatchObject({ actor: "fixture-a" });
    expect(() => validateCapture(capture)).not.toThrow();
  });
  it("produces receipt-centered refutation input without the first analyst assessment/history", async () => {
    const campaign = reviewHypothesis(await collect(seed()), hId).campaign;
    const packet = refutationPacket(campaign, hId);
    expect(packet.receipts).toHaveLength(8);
    expect(packet.recipes).toHaveLength(4);
    expect(packet).not.toHaveProperty("status"); expect(packet).not.toHaveProperty("assessment"); expect(packet).not.toHaveProperty("history");
    const { inputSha256, ...body } = packet;
    expect(inputSha256).toBe(digest(body));
  });
});

describe("next investigation and two speeds", () => {
  it("uses current contradictions instead of recorded rejection and ignores pre-reopening captures for gaps", async () => {
    fixture.setMode("fixed");
    let campaign = reviewHypothesis(await collect(seed()), hId).campaign;
    expect(campaign.hypotheses[0]!.status).toBe("rejected");
    expect(planInvestigations(campaign, []).candidates).toEqual([]);
    fixture.setMode("vulnerable"); await collect(campaign, 1);
    expect(assessHypothesis(campaign, hId).status).toBe("tested-inconclusive");
    expect(planInvestigations(campaign, []).selectedHypothesisId).toBe(hId);
    expect(planInvestigations(campaign, []).candidates[0]!.currentStatus).toBe("tested-inconclusive");
    const resetAt = new Date(Math.max(...campaign.captures.map(c => Date.parse(c.execution.endedAt)), ...campaign.hypotheses[0]!.history.map(e => Date.parse(e.at))) + 1).toISOString();
    campaign = reopenHypothesis(campaign, hId, "Independent new evidence epoch", resetAt);
    expect(assessHypothesis(campaign, hId).receiptIds).toHaveLength(0);
    expect(planInvestigations(campaign, []).candidates[0]!.reasons).toContain("4 capture gaps (+8)");
  });
  it("ranks deterministically, explains arithmetic, blocks missing prerequisites and uses total ID tie-break", () => {
    const campaign = seed();
    const draft = fixtureBundle(fixture.origin).hypotheses[0] as HypothesisDraft;
    campaign.hypotheses = [createHypothesis({ ...draft, id: "z" }, initial), createHypothesis({ ...draft, id: "a" }, initial), createHypothesis({ ...draft, id: "blocked", preconditions: [{ id: "identity", description: "not available", state: "unknown", witnesses: [] }], investigation: { ...draft.investigation, costMinutes: 0.1 } }, initial)];
    const first = planInvestigations(campaign, []);
    expect(first.selectedHypothesisId).toBe("a");
    expect(first.measuredInformationGain).toBe(false);
    expect(first.candidates.map(c => c.hypothesisId)).toEqual(["a", "z", "blocked"]);
    expect(first.candidates[0]!.score).toBe((20 + 8 - 3) / 2);
    expect(JSON.stringify(planInvestigations(campaign, []))).toBe(JSON.stringify(first));
    expect(first.candidates[2]!.reasons).toContain("Prerequisite identity: unknown");
    expect(routeInvestigation(campaign.hypotheses[0]!).agents).toBe(1);
    expect(routeInvestigation({ ...campaign.hypotheses[0]!, investigation: { ...campaign.hypotheses[0]!.investigation, businessLogic: true } }).agents).toBe(2);
    expect(routeInvestigation({ ...campaign.hypotheses[0]!, investigation: { ...campaign.hypotheses[0]!.investigation, promising: true } }).agents).toBe(2);
    campaign.recipes[0]!.secretHeaders = [{ name: "X-Binding", env: "MISSING_BINDING" }];
    expect(planInvestigations(campaign, []).selectedHypothesisId).toBeNull();
  });
});

const abstractDraft = () => ({
  applicationContext: "Multi-user API with private objects", rootCause: "Object-level authorization omitted",
  suspicionSignals: ["Protected fields appear during a cross-actor comparison"],
  confirmationTest: "Use two owned-object baselines and a negative control under established identities",
  refutationTest: "Compare with a corrected application and a valid denial", variants: ["Secondary resource reads"],
  provenance: { kind: "manually-authored-abstraction" as const, reviewedForTargetFacts: true as const, authoredAt: initial },
});
describe("manually authored cross-program abstractions", () => {
  it.each(["api.example.test", "api.company.biz", "https://target.fr/a", "127.0.0.1", "actor_id=alice", "tenant-1234", "Bearer fixture-token", "token=fixture-value", "api key: fixture-value", "sk_fixturevalue12345678", "/api/customer/1826", "verdict: confirmed", "status: COMPLETE", "confirmed-with-evidence", "01a1299d-4ea7-7c62-a99f-104cee4a12dc"])("rejects common concrete target fact %s", concrete => {
    expect(() => authorPattern({ ...abstractDraft(), suspicionSignals: [concrete] })).toThrow(/concrete/);
  });
  it("requires manual abstraction review, validates source terms and starts a fresh unconfirmed target hypothesis", () => {
    expect(() => authorPattern({ ...abstractDraft(), programId: "source-target" })).toThrow(/unsupported\/source-target/);
    expect(() => authorPattern({ ...abstractDraft(), provenance: { kind: "manually-authored-abstraction", reviewedForTargetFacts: false, authoredAt: initial } })).toThrow(/review/);
    expect(() => authorPattern({ ...abstractDraft(), suspicionSignals: ["alice can read the object"] }, ["alice"])).toThrow(/source-target/);
    const pattern = authorPattern(abstractDraft());
    const draft = fixtureBundle(fixture.origin).hypotheses[0] as HypothesisDraft;
    const imported = instantiatePattern(pattern, { ...draft, id: "new-target-question" }, initial);
    expect(imported.status).toBe("hypothesis");
    expect(imported.history[0]!.receiptIds).toEqual([]);
    expect(imported.patternId).toBe(pattern.id);
    expect(pattern).not.toHaveProperty("verdict"); expect(pattern).not.toHaveProperty("programId"); expect(pattern).not.toHaveProperty("captures");
    expect(() => parsePattern({ ...pattern, rootCause: "Changed contents without rebinding digest" })).toThrow(/digest/);
  });
});

describe("campaign time and unique verified findings", () => {
  it("keeps earliest sufficient confirmation and deduplicates temporal finding variants before assigning lanes", async () => {
    const campaign = await collect(seed());
    const original = assessHypothesis(campaign, hId);
    campaign.sessions = [{ id: "original-discovery", lane: "single-agent", startedAt: new Date(Math.min(...campaign.captures.map(c => Date.parse(c.execution.startedAt))) - 1).toISOString(), endedAt: original.verifiedAt }];
    const originalSnapshot = structuredClone(campaign);
    expect(campaignMetrics(campaign).lanes[0]!.uniqueVerifiedFindings).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    const originalLength = campaign.captures.length;
    await collect(campaign);
    const later = campaign.captures.slice(originalLength);
    const repeated = assessHypothesis(campaign, hId);
    expect(repeated.verifiedAt).toBe(original.verifiedAt);
    expect(Date.parse(repeated.lastObservationAt!)).toBeGreaterThan(Date.parse(original.verifiedAt!));
    campaign.sessions.push({ id: "mere-replay", lane: "two-agent-oracle", startedAt: new Date(Math.min(...later.map(c => Date.parse(c.execution.startedAt))) - 1).toISOString(), endedAt: repeated.lastObservationAt });
    const draft = fixtureBundle(fixture.origin).hypotheses[0] as HypothesisDraft;
    const duplicate = createHypothesis({ ...draft, id: "same-finding-later-epoch" }, later[0]!.execution.startedAt);
    campaign.hypotheses.push(duplicate);
    expect(Date.parse(assessHypothesis(campaign, duplicate.id).verifiedAt!)).toBeGreaterThan(Date.parse(original.verifiedAt!));
    const metrics = campaignMetrics(campaign);
    expect(metrics.uniqueVerifiedFindings).toBe(1);
    expect(metrics.lanes[0]!.uniqueVerifiedFindings).toBe(1);
    expect(metrics.lanes[3]!.uniqueVerifiedFindings).toBe(0);
    expect(metrics.findingAttributions[0]!.verifiedAt).toBe(original.verifiedAt);
    const laterOnly = { ...structuredClone(campaign), hypotheses: [duplicate], captures: later, sessions: campaign.sessions.slice(1) };
    const compared = compareCampaigns([laterOnly, originalSnapshot]);
    expect(compared.groups.find(g => g.lane === "single-agent")!.uniqueVerifiedFindings).toBe(1);
    expect(compared.groups.find(g => g.lane === "two-agent-oracle")!.uniqueVerifiedFindings).toBe(0);
    expect(compared.laneTotals.reduce((sum, lane) => sum + lane.uniqueVerifiedFindings, 0)).toBe(1);
  });
  it("deduplicates root cause/asset/impact across repeats and campaigns and unions real wall-clock intervals", async () => {
    let campaign = await collect(seed());
    const draft = fixtureBundle(fixture.origin).hypotheses[0] as HypothesisDraft;
    campaign.hypotheses.push(createHypothesis({ ...draft, id: "duplicate-finding" }, initial));
    campaign = reviewHypothesis(campaign, hId).campaign;
    campaign = reviewHypothesis(campaign, "duplicate-finding").campaign;
    const time = Date.parse(campaign.captures[0]!.execution.startedAt);
    campaign.sessions = [
      { id: "first", lane: "single-agent", startedAt: new Date(time - 600_000).toISOString(), endedAt: new Date(time + 3_000_000).toISOString() },
      { id: "overlap", lane: "single-agent", startedAt: new Date(time + 1_200_000).toISOString(), endedAt: new Date(time + 4_800_000).toISOString() },
    ];
    const metrics = campaignMetrics(campaign);
    expect(metrics.uniqueVerifiedFindings).toBe(1);
    expect(findingKey(campaign, hId)).toBe(findingKey(campaign, "duplicate-finding"));
    expect(metrics.totalHours).toBe(1.5);
    expect(metrics.lanes[0]!.verifiedPerHour).toBe(1 / 1.5);
    expect(metrics.performanceEvidence).toMatch(/no measured bug-bounty performance/);
    const compared = compareCampaigns([campaign, structuredClone(campaign)]);
    expect(compared.groups[0]!.hours).toBe(1.5);
    expect(compared.groups[0]!.uniqueVerifiedFindings).toBe(1);
    expect(compared.laneTotals[0]!.uniqueVerifiedFindings).toBe(1);
    expect(compared.comparability).toMatch(/not-established/);
    campaign.sessions.push({ id: "ambiguous-other-lane", lane: "two-agent", startedAt: new Date(time - 1_000).toISOString(), endedAt: new Date(time + 5_000).toISOString() });
    expect(campaignMetrics(campaign).ambiguousAttribution).toContain(hId);
    expect(campaignMetrics(campaign).lanes.every(l => l.uniqueVerifiedFindings === 0)).toBe(true);
  });
  it("uses saved timer boundaries, excludes active sessions and never invents zero/negative hours", () => {
    let campaign = startSession(seed(), "timer", "memory", "2026-10-12T10:00:00.000Z");
    expect(campaignMetrics(campaign).activeSessions).toEqual(["timer"]);
    expect(campaignMetrics(campaign).lanes[1]!.verifiedPerHour).toBeNull();
    expect(() => stopSession(campaign, "timer", "2026-10-12T10:00:00.000Z")).toThrow(/positive measured duration/);
    campaign = stopSession(campaign, "timer", "2026-10-12T11:00:00.000Z");
    expect(campaignMetrics(campaign).totalHours).toBe(1);
    expect(() => stopSession(campaign, "timer")).toThrow(/active/);
  });
});
