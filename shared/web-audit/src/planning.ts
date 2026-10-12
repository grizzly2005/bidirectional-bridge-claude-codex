import type { Campaign, Hypothesis } from "./model.js";
import { parseCampaign } from "./validation.js";
import { assessHypothesis } from "./evidence.js";

export function routeInvestigation(hypothesis: Hypothesis): { agents: 1 | 2; reason: string } {
  if (hypothesis.investigation.businessLogic) return { agents: 2, reason: "Business-state reasoning warrants an independent refutation pass" };
  if (hypothesis.investigation.promising) return { agents: 2, reason: "A promising authored hypothesis warrants bounded refutation" };
  return { agents: 1, reason: "Mechanical surface/capture exploration can stay with one agent" };
}
export function planInvestigations(input: Campaign, availableEnvNames: string[] = Object.keys(process.env)) {
  const campaign = parseCampaign(input);
  const candidates = campaign.hypotheses.map(h => ({ h, assessment: assessHypothesis(campaign, h.id) })).filter(({ assessment }) => assessment.status !== "rejected" && assessment.status !== "confirmed-with-evidence").map(({ h, assessment }) => {
    const recipes = h.investigation.recipeIds.map(id => campaign.recipes.find(r => r.id === id)!);
    const blockers: string[] = [];
    if (!recipes.length) blockers.push("No executable recipe selected");
    for (const p of h.preconditions) if (p.state !== "met") blockers.push(`Prerequisite ${p.id}: ${p.state}`);
    for (const r of recipes) for (const binding of r.secretHeaders) if (!availableEnvNames.includes(binding.env)) blockers.push(`Missing runtime binding ${binding.env}`);
    const alternatives = new Set(h.investigation.discriminates).size;
    const missingWitnesses = recipes.filter(r => !campaign.captures.some(c => c.recipeId === r.id && Date.parse(c.execution.startedAt) >= Date.parse(h.evidenceSince) && c.transport.outcome === "complete" && c.response !== null && (!h.verification || (c.derived.jsonParsed && ![301, 302, 303, 307, 308, 401].includes(c.response.status))))).length;
    const riskPenalty = { passive: 0, read: 3, write: 12 }[h.investigation.risk];
    const score = Math.round(((10 * alternatives + 2 * missingWitnesses - riskPenalty) / h.investigation.costMinutes) * 1_000_000) / 1_000_000;
    return {
      hypothesisId: h.id, currentStatus: assessment.status, eligible: blockers.length === 0, score, routing: routeInvestigation(h),
      reasons: [`Separates ${alternatives} declared predictions (+${10 * alternatives})`, `${missingWitnesses} capture gaps (+${2 * missingWitnesses})`, `${h.investigation.risk} risk penalty (-${riskPenalty})`, `Estimated cost ${h.investigation.costMinutes} minutes (denominator)`, ...blockers],
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || (a.hypothesisId < b.hypothesisId ? -1 : a.hypothesisId > b.hypothesisId ? 1 : 0));
  return {
    algorithm: "heuristic-v1", measuredInformationGain: false,
    formula: "(10 * declared alternatives + 2 * missing captures - risk penalty) / estimated minutes",
    selectedHypothesisId: candidates.find(c => c.eligible)?.hypothesisId ?? null, candidates,
  };
}
