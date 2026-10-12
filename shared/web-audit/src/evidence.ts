import type { Campaign, Capture, Fact, HistoryEvent, Hypothesis, HypothesisDraft, ImportBundle, Predicate, Recipe, Status } from "./model.js";
import { canonical, digest, hypothesisDefinition, uniqueExecutions } from "./model.js";
import { parseCampaign, parseImport, validateDraft } from "./validation.js";

export type PredicateResult = "match" | "mismatch" | "inconclusive";
export interface Assessment {
  hypothesisId: string;
  status: Status;
  reason: string;
  receiptIds: string[];
  runs: { runId: string; outcome: "supported" | "refuted" | "inconclusive"; reason: string; completedAt: string }[];
  verifiedAt: string | null;
  lastObservationAt: string | null;
  duplicateExecutionReceiptIds: string[];
}
export function evaluatePredicate(capture: Capture, predicate: Predicate): PredicateResult {
  if (capture.transport.outcome !== "complete" || !capture.response || [301, 302, 303, 307, 308, 401].includes(capture.response.status)) return "inconclusive";
  if (predicate.denialStatuses.includes(capture.response.status)) return "mismatch";
  if (capture.response.status !== predicate.expectedStatus || !capture.derived.jsonParsed) return "inconclusive";
  let value: unknown = capture.derived.json;
  for (const key of predicate.path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return "mismatch";
    value = (value as Record<string, unknown>)[key];
  }
  return canonical(value) === canonical(predicate.equals) ? "match" : "mismatch";
}
function event(h: Hypothesis | null, status: Status, reason: string, receiptIds: string[], at: string, kind: HistoryEvent["kind"], definition?: HypothesisDraft): HistoryEvent {
  if (!Number.isFinite(Date.parse(at)) || (h && Date.parse(at) < Date.parse(h.history.at(-1)!.at))) throw new Error("History timestamp must follow prior event");
  const body = { sequence: h?.history.length ?? 0, at, kind, status, reason, receiptIds: [...receiptIds], definitionSha256: digest(definition ?? hypothesisDefinition(h!)), previousSha256: h?.history.at(-1)?.sha256 ?? null };
  return Object.freeze({ ...body, sha256: digest(body) });
}
export function createHypothesis(draft: HypothesisDraft, at = new Date().toISOString(), reason = "New unconfirmed hypothesis"): Hypothesis {
  validateDraft(draft);
  const history = [event(null, "hypothesis", reason, [], at, "created", draft)];
  return { ...structuredClone(draft), status: "hypothesis", evidenceSince: at, history };
}
export function importCampaign(input: ImportBundle | unknown, at = new Date().toISOString()): Campaign {
  const bundle = parseImport(input);
  return { schemaVersion: 1, kind: "web-audit-campaign", program: bundle.program, recipes: bundle.recipes, hypotheses: bundle.hypotheses.map(h => createHypothesis(h, at)), captures: [], sessions: [] };
}
const value = (fact: Fact): string | null => fact.kind === "known" ? fact.value : null;
function comparisonContext(positive: Recipe, baseline: Recipe, probe: Recipe, negative: Recipe): string | null {
  const recipes = [positive, baseline, probe, negative];
  if (recipes.some(r => r.surface.method !== "GET" || r.discovery !== "observed" || r.replaySafety !== "idempotent-read")) return "Read oracle requires observed idempotent GET recipes";
  if (recipes.some(r => Object.values(r.dimensions).some(f => f.kind !== "known") || r.sessionRef.kind !== "known")) return "Actor/object/tenant/state/session facts are incomplete";
  if (recipes.some(r => canonical(r.surface) !== canonical(positive.surface))) return "Origin/method/route/query/parameter shapes differ between controls";
  const a = positive.dimensions, b = baseline.dimensions, p = probe.dimensions, n = negative.dimensions;
  if (value(a.actorId) === value(p.actorId) || value(a.actorId) !== value(a.objectOwnerId) || value(b.actorId) !== value(b.objectOwnerId)) return "Distinct actors and controlled owned-object baselines required";
  if (value(p.actorId) !== value(b.actorId) || value(n.actorId) !== value(p.actorId) || value(p.actorRole) !== value(b.actorRole) || value(p.actorTenantId) !== value(b.actorTenantId) || value(n.actorTenantId) !== value(p.actorTenantId)) return "Probe/negative do not preserve the tested actor/tenant";
  if (value(p.objectId) !== value(a.objectId) || value(p.objectOwnerId) !== value(a.objectOwnerId) || value(p.objectTenantId) !== value(a.objectTenantId) || value(n.objectId) === value(p.objectId) || value(b.objectId) === value(a.objectId)) return "Probe must reuse the protected object; controls need distinct objects";
  if (recipes.some(r => value(r.dimensions.workflowState) !== value(a.workflowState))) return "Workflow state differs between comparisons";
  if (value(probe.sessionRef) !== value(baseline.sessionRef) || value(negative.sessionRef) !== value(probe.sessionRef) || value(positive.sessionRef) === value(probe.sessionRef)) return "Session references do not preserve two distinct actors";
  return null;
}
export function assessHypothesis(input: Campaign, hypothesisId: string): Assessment {
  let lastObservationAt: string | null = null;
  const empty = (reason: string): Assessment => ({ hypothesisId, status: "tested-inconclusive", reason, receiptIds: [], runs: [], verifiedAt: null, lastObservationAt, duplicateExecutionReceiptIds: [] });
  let campaign: Campaign;
  try { campaign = parseCampaign(input); } catch (error) { return empty(`Invalid evidence: ${(error as Error).message}`); }
  const hypothesis = campaign.hypotheses.find(h => h.id === hypothesisId);
  if (!hypothesis) throw new Error(`Unknown hypothesis ${hypothesisId}`);
  const v = hypothesis.verification;
  const observationIds = [...hypothesis.investigation.recipeIds, ...hypothesis.preconditions.flatMap(p => p.witnesses.map(w => w.recipeId))];
  if (v) observationIds.push(v.positiveRecipeId, v.actorBaselineRecipeId, v.probeRecipeId, v.negativeRecipeId);
  const observations = campaign.captures.filter(c => observationIds.includes(c.recipeId) && Date.parse(c.execution.startedAt) >= Date.parse(hypothesis.evidenceSince));
  lastObservationAt = observations.map(c => c.execution.endedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  if (!v) return empty("No reproducible differential-read verification recipe");
  if (hypothesis.expected.provenance === "inference") return empty("Expected policy is an inference, not an established invariant");
  if (!hypothesis.preconditions.length || hypothesis.preconditions.some(p => p.state !== "met" || !p.witnesses.length)) return empty("Prerequisites need known conditions and explicit capture predicates");
  const ids = [v.positiveRecipeId, v.actorBaselineRecipeId, v.probeRecipeId, v.negativeRecipeId];
  if (new Set(ids).size !== 4) return empty("Positive, actor baseline, probe and negative require distinct recipes");
  const recipes = ids.map(id => campaign.recipes.find(r => r.id === id)!);
  const contextFailure = comparisonContext(recipes[0]!, recipes[1]!, recipes[2]!, recipes[3]!);
  if (contextFailure) return empty(contextFailure);
  const needed = [...new Set([...ids, ...hypothesis.preconditions.flatMap(p => p.witnesses.map(w => w.recipeId))])];
  const captures = uniqueExecutions(observations.filter(c => needed.includes(c.recipeId)));
  const retainedIds = new Set(captures.map(c => c.id));
  const duplicateExecutionReceiptIds = observations.filter(c => needed.includes(c.recipeId) && !retainedIds.has(c.id)).map(c => c.id).sort();
  const groups = new Map<string, Capture[]>();
  for (const capture of captures) groups.set(capture.runId, [...(groups.get(capture.runId) ?? []), capture]);
  const receiptIds = captures.map(c => c.id).sort();
  const runs: Assessment["runs"] = [];
  for (const [runId, group] of [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const selected = new Map<string, Capture>();
    const invalid = needed.some(id => { const matching = group.filter(c => c.recipeId === id); if (matching.length === 1) selected.set(id, matching[0]!); return matching.length !== 1; });
    let reason: string | null = invalid ? "Incomplete or ambiguous capture set in this run" : null;
    if (!reason) {
      for (const recipe of recipes) {
        const capture = selected.get(recipe.id)!;
        const identity: Predicate = { kind: "json-equals", expectedStatus: capture.response?.status ?? 200, path: v.actorIdentityPath, equals: value(recipe.dimensions.actorId), denialStatuses: [] };
        if (evaluatePredicate(capture, identity) !== "match") { reason = "Session actor identity is not demonstrated in this run"; break; }
      }
    }
    if (!reason) {
      for (const precondition of hypothesis.preconditions) {
        if (precondition.witnesses.some(w => evaluatePredicate(selected.get(w.recipeId)!, w.predicate) !== "match")) { reason = `Precondition ${precondition.id} was not verified`; break; }
      }
    }
    if (!reason && (evaluatePredicate(selected.get(v.positiveRecipeId)!, v.protectedPredicate) !== "match" || evaluatePredicate(selected.get(v.actorBaselineRecipeId)!, v.actorBaselinePredicate) !== "match")) reason = "Positive owned-object/actor baselines did not match";
    if (!reason && evaluatePredicate(selected.get(v.negativeRecipeId)!, v.protectedPredicate) !== "mismatch") reason = "Negative witness is contaminated or inconclusive";
    const probe = reason ? "inconclusive" : evaluatePredicate(selected.get(v.probeRecipeId)!, v.protectedPredicate);
    const completedAt = group.map(c => c.execution.endedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
    runs.push({ runId, outcome: reason || probe === "inconclusive" ? "inconclusive" : probe === "match" ? "supported" : "refuted", reason: reason ?? (probe === "match" ? "Protected JSON matched only after valid baselines and negative witness" : probe === "mismatch" ? "Protected JSON predicate was refuted" : "Probe response/transport inconclusive"), completedAt });
  }
  let status: Status = "tested-inconclusive";
  let reason = "Insufficient repeatable comparisons";
  if (runs.some(r => r.outcome === "inconclusive")) reason = "At least one run lacks valid controls, identity or complete transport";
  else if (runs.length >= v.minimumRepetitions) {
    if (runs.every(r => r.outcome === "supported")) { status = "confirmed-with-evidence"; reason = "Repeatable protected-data predicate with positive and negative controls"; }
    else if (runs.every(r => r.outcome === "refuted")) { status = "rejected"; reason = "Repeated comparisons refuted the protected-data predicate"; }
    else reason = "Contradictory supported/refuted captures require investigation";
  }
  const verifiedAt = status === "confirmed-with-evidence" ? runs.map(r => r.completedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[v.minimumRepetitions - 1]! : null;
  return { hypothesisId, status, reason, receiptIds, runs, verifiedAt, lastObservationAt, duplicateExecutionReceiptIds };
}
export function reviewHypothesis(campaign: Campaign, id: string, at = new Date().toISOString()): { campaign: Campaign; assessment: Assessment } {
  const result = parseCampaign(campaign);
  const assessment = assessHypothesis(result, id);
  const h = result.hypotheses.find(item => item.id === id)!;
  h.history = [...h.history, event(h, assessment.status, assessment.reason, assessment.receiptIds, at, "reviewed")];
  h.status = assessment.status;
  return { campaign: result, assessment };
}
export function reopenHypothesis(campaign: Campaign, id: string, reason: string, at = new Date().toISOString()): Campaign {
  if (!reason.trim()) throw new Error("Reopening reason required");
  const result = parseCampaign(campaign);
  const h = result.hypotheses.find(item => item.id === id);
  if (!h) throw new Error(`Unknown hypothesis ${id}`);
  h.history = [...h.history, event(h, "hypothesis", reason, [], at, "reopened")];
  h.status = "hypothesis"; h.evidenceSince = at;
  return result;
}

/** Receipt-centered review input; intentionally omits the first analyst's status, history and assessment. */
export function refutationPacket(input: Campaign, id: string) {
  const campaign = parseCampaign(input);
  const h = campaign.hypotheses.find(item => item.id === id);
  if (!h) throw new Error(`Unknown hypothesis ${id}`);
  const ids = new Set([...h.investigation.recipeIds, ...h.preconditions.flatMap(p => p.witnesses.map(w => w.recipeId))]);
  if (h.verification) for (const recipeId of [h.verification.positiveRecipeId, h.verification.actorBaselineRecipeId, h.verification.probeRecipeId, h.verification.negativeRecipeId]) ids.add(recipeId);
  const content = {
    schemaVersion: 1, kind: "web-audit-refutation-input", question: "Do these retained controlled comparisons establish an authorization violation under the supplied expected policy?", expected: h.expected,
    recipes: campaign.recipes.filter(r => ids.has(r.id)),
    receipts: campaign.captures.filter(c => ids.has(c.recipeId) && Date.parse(c.execution.startedAt) >= Date.parse(h.evidenceSince)),
    instruction: "Independently evaluate identities, policy, controls and contradictory captures before seeing another analyst verdict",
  };
  return { ...content, inputSha256: digest(content) };
}
