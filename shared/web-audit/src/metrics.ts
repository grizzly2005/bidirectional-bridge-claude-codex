import type { Campaign, Lane } from "./model.js";
import { canonical } from "./model.js";
import { assessHypothesis } from "./evidence.js";
import { parseCampaign } from "./validation.js";

export function startSession(input: Campaign, id: string, lane: Lane, at = new Date().toISOString()): Campaign {
  const campaign = parseCampaign(input);
  if (!id.trim() || campaign.sessions.some(s => s.id === id) || !Number.isFinite(Date.parse(at)) || !["single-agent", "memory", "two-agent", "two-agent-oracle"].includes(lane)) throw new Error("Invalid/new session ID, lane or timestamp");
  campaign.sessions.push({ id, lane, startedAt: at, endedAt: null });
  return campaign;
}
export function stopSession(input: Campaign, id: string, at = new Date().toISOString()): Campaign {
  const campaign = parseCampaign(input);
  const session = campaign.sessions.find(s => s.id === id);
  if (!session || session.endedAt !== null || !Number.isFinite(Date.parse(at)) || Date.parse(at) <= Date.parse(session.startedAt)) throw new Error("Session must be active and have positive measured duration");
  session.endedAt = at;
  return campaign;
}
function unionHours(intervals: [number, number][]): number {
  const ordered = intervals.sort((a, b) => a[0] - b[0]);
  let start = 0, end = 0, ms = 0;
  for (const [a, b] of ordered) {
    if (a > end) { ms += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return (ms + end - start) / 3_600_000;
}
/** A pragmatic campaign key, not a universal vulnerability equivalence relation. */
export function findingKey(campaign: Campaign, hypothesisId: string): string {
  const finding = campaign.hypotheses.find(h => h.id === hypothesisId)?.verification?.finding;
  if (!finding) throw new Error("Finding key requires an authored root cause/asset/impact definition");
  return canonical([campaign.program.id, finding.rootCauseKey, finding.affectedAssetKey, finding.impactClass]);
}
interface VerifiedFinding { key: string; hypothesisId: string; verifiedAt: string }
function currentFindings(campaign: Campaign): VerifiedFinding[] {
  const findings = new Map<string, VerifiedFinding>();
  for (const h of campaign.hypotheses) {
    const assessment = assessHypothesis(campaign, h.id);
    if (assessment.status !== "confirmed-with-evidence") continue;
    const key = findingKey(campaign, h.id);
    const prior = findings.get(key);
    if (!prior || Date.parse(assessment.verifiedAt!) < Date.parse(prior.verifiedAt)) findings.set(key, { key, hypothesisId: h.id, verifiedAt: assessment.verifiedAt! });
  }
  return [...findings.values()];
}
export function campaignMetrics(input: Campaign) {
  const campaign = parseCampaign(input);
  const finished = campaign.sessions.filter(s => s.endedAt !== null);
  const verified = currentFindings(campaign);
  const lanes: Lane[] = ["single-agent", "memory", "two-agent", "two-agent-oracle"];
  const ambiguousAttribution: string[] = [];
  const attributed = verified.map(x => {
    const instant = Date.parse(x.verifiedAt);
    const activeLanes = [...new Set(finished.filter(s => Date.parse(s.startedAt) <= instant && instant <= Date.parse(s.endedAt!)).map(s => s.lane))];
    if (activeLanes.length !== 1) ambiguousAttribution.push(x.hypothesisId);
    return { ...x, lane: activeLanes.length === 1 ? activeLanes[0] : null };
  });
  return {
    programId: campaign.program.id, context: campaign.program.context,
    clock: "saved wall-clock intervals; overlapping intervals count once; active sessions excluded",
    deduplication: "programId + authored rootCauseKey + affectedAssetKey + impactClass",
    findingAttributions: attributed,
    uniqueVerifiedFindings: verified.length,
    totalHours: unionHours(finished.map(s => [Date.parse(s.startedAt), Date.parse(s.endedAt!)])),
    activeSessions: campaign.sessions.filter(s => s.endedAt === null).map(s => s.id), ambiguousAttribution,
    lanes: lanes.map(lane => {
      const hours = unionHours(finished.filter(s => s.lane === lane).map(s => [Date.parse(s.startedAt), Date.parse(s.endedAt!)]));
      const count = new Set(attributed.filter(x => x.lane === lane).map(x => x.key)).size;
      return { lane, hours, uniqueVerifiedFindings: count, verifiedPerHour: hours > 0 ? count / hours : null };
    }),
    comparability: "not-established; compare real campaigns only after matching scope, budget and conditions",
    performanceEvidence: campaign.program.context === "local-fixture" ? "local fixture arithmetic only; no measured bug-bounty performance" : "descriptive saved campaign intervals; no causal performance gain claimed",
  };
}

export function compareCampaigns(inputs: Campaign[]) {
  const groups = new Map<string, { programId: string; context: Campaign["program"]["context"]; lane: Lane; intervals: [number, number][]; keys: Set<string> }>();
  const findings = new Map<string, VerifiedFinding & { programId: string; context: Campaign["program"]["context"] }>();
  const timed = [] as { programId: string; context: Campaign["program"]["context"]; lane: Lane; start: number; end: number }[];
  for (const input of inputs) {
    const campaign = parseCampaign(input);
    const sessions = campaign.sessions.filter(s => s.endedAt !== null);
    for (const session of sessions) {
      const key = canonical([campaign.program.id, campaign.program.context, session.lane]);
      let group = groups.get(key);
      if (!group) { group = { programId: campaign.program.id, context: campaign.program.context, lane: session.lane, intervals: [], keys: new Set() }; groups.set(key, group); }
      group.intervals.push([Date.parse(session.startedAt), Date.parse(session.endedAt!)]);
      timed.push({ programId: campaign.program.id, context: campaign.program.context, lane: session.lane, start: Date.parse(session.startedAt), end: Date.parse(session.endedAt!) });
    }
    for (const finding of currentFindings(campaign)) {
      const key = canonical([campaign.program.context, finding.key]);
      const prior = findings.get(key);
      if (!prior || Date.parse(finding.verifiedAt) < Date.parse(prior.verifiedAt)) findings.set(key, { ...finding, programId: campaign.program.id, context: campaign.program.context });
    }
  }
  for (const finding of findings.values()) {
    const instant = Date.parse(finding.verifiedAt);
    const lanes = [...new Set(timed.filter(s => s.programId === finding.programId && s.context === finding.context && s.start <= instant && instant <= s.end).map(s => s.lane))];
    if (lanes.length === 1) groups.get(canonical([finding.programId, finding.context, lanes[0]]))!.keys.add(finding.key);
  }
  const totals = new Map<string, { context: Campaign["program"]["context"]; lane: Lane; intervals: [number, number][]; keys: Set<string> }>();
  for (const group of groups.values()) {
    const key = canonical([group.context, group.lane]);
    let total = totals.get(key);
    if (!total) { total = { context: group.context, lane: group.lane, intervals: [], keys: new Set() }; totals.set(key, total); }
    total.intervals.push(...group.intervals);
    for (const finding of group.keys) total.keys.add(finding);
  }
  return {
    comparability: "not-established; descriptive counts only, with local fixtures kept separate",
    laneTotals: [...totals.values()].map(total => {
      const hours = unionHours(total.intervals);
      return { context: total.context, lane: total.lane, hours, uniqueVerifiedFindings: total.keys.size, verifiedPerHour: hours ? total.keys.size / hours : null };
    }).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0),
    groups: [...groups.values()].map(g => {
      const hours = unionHours(g.intervals);
      return { programId: g.programId, context: g.context, lane: g.lane, hours, uniqueVerifiedFindings: g.keys.size, verifiedPerHour: hours ? g.keys.size / hours : null };
    }).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0),
  };
}
