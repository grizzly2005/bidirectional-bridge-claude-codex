#!/usr/bin/env node
import { readFile, writeFile, rename, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  parseCampaign, parseImport, importCampaign, planInvestigations, replay, reviewHypothesis,
  reopenHypothesis, refutationPacket, matrix, assessHypothesis, campaignMetrics, compareCampaigns,
  startSession, stopSession, authorPattern, parsePattern, instantiatePattern,
} from "../shared/web-audit/dist/index.js";

const help = `Experimental web audit MVP (JSON v1; build with npm run build first).
node scripts/web-audit.mjs import <bundle.json> <new-campaign.json>
node scripts/web-audit.mjs plan <campaign.json>
node scripts/web-audit.mjs replay <campaign.json> <hypothesis-id> [repeat-count=1]
node scripts/web-audit.mjs verify <campaign.json> <hypothesis-id>
node scripts/web-audit.mjs reopen <campaign.json> <hypothesis-id> <reason>
node scripts/web-audit.mjs refutation-input <campaign.json> <hypothesis-id> <new-packet.json>
node scripts/web-audit.mjs report <campaign.json> [new-report.json]
node scripts/web-audit.mjs time-start <campaign.json> <session-id> <lane>
node scripts/web-audit.mjs time-stop <campaign.json> <session-id>
node scripts/web-audit.mjs compare <campaign.json> <other-campaign.json> [...]
node scripts/web-audit.mjs pattern-export <authored-abstract-draft.json> <new-pattern.json> [source-campaign.json]
node scripts/web-audit.mjs pattern-import <pattern.json> <campaign.json> <new-hypothesis-binding.json>
Lanes: single-agent, memory, two-agent, two-agent-oracle.
Automatic replay only executes explicit idempotent-read recipes. No redirects/retries.
Local fixture metrics do not measure bug-bounty performance. Files use a single writer.`;

const readJson = async path => JSON.parse(await readFile(resolve(path), "utf8"));
const readCampaign = async path => parseCampaign(await readJson(path));
async function save(path, value, createOnly = false) {
  const destination = resolve(path);
  if (createOnly) {
    let exists = false;
    try { await access(destination); exists = true; } catch {}
    if (exists) throw new Error(`Refusing to replace existing history/output: ${destination}`);
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
}
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const required = (args, count, command) => { if (args.length < count) throw new Error(`Missing ${command} arguments. Use --help.`); };

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["--help", "help", "-h"].includes(command)) process.stdout.write(`${help}\n`);
  else if (command === "import") {
    required(args, 2, command);
    const campaign = importCampaign(parseImport(await readJson(args[0])));
    await save(args[1], campaign, true);
    print({ campaign: resolve(args[1]), recipes: campaign.recipes.length, hypotheses: campaign.hypotheses.length, context: campaign.program.context });
  } else if (command === "compare") {
    required(args, 2, command);
    print(compareCampaigns(await Promise.all(args.map(readCampaign))));
  } else if (command === "pattern-export") {
    required(args, 2, command);
    const source = args[2] ? await readCampaign(args[2]) : null;
    const facts = source ? [source.program.id, ...source.program.allowedOrigins, ...source.recipes.flatMap(r => [r.id, r.url, r.sessionRef.kind === "known" ? r.sessionRef.value : "", ...[r.dimensions.actorId, r.dimensions.objectId, r.dimensions.objectOwnerId, r.dimensions.actorTenantId, r.dimensions.objectTenantId].filter(f => f.kind === "known").map(f => f.value)])] : [];
    const pattern = authorPattern(await readJson(args[0]), facts);
    await save(args[1], pattern, true);
    print({ patternId: pattern.id, output: resolve(args[1]), sourceFactsChecked: Boolean(source), abstractionReview: "human review still required for arbitrary names/short IDs" });
  } else if (command === "pattern-import") {
    required(args, 3, command);
    const campaign = await readCampaign(args[1]);
    const h = instantiatePattern(parsePattern(await readJson(args[0])), await readJson(args[2]));
    if (campaign.hypotheses.some(existing => existing.id === h.id)) throw new Error("New hypothesis ID required");
    campaign.hypotheses.push(h);
    await save(args[1], parseCampaign(campaign));
    print({ hypothesisId: h.id, status: h.status, patternId: h.patternId });
  } else {
    required(args, 1, command);
    const campaign = await readCampaign(args[0]);
    if (command === "plan") print(planInvestigations(campaign));
    else if (command === "replay") {
      required(args, 2, command);
      const h = campaign.hypotheses.find(item => item.id === args[1]);
      if (!h) throw new Error(`Unknown hypothesis ${args[1]}`);
      const repeats = Number(args[2] ?? 1);
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("repeat-count must be an integer from 1 to 100");
      const recipeIds = new Set([...h.investigation.recipeIds, ...h.preconditions.flatMap(p => p.witnesses.map(w => w.recipeId))]);
      if (h.verification) for (const id of [h.verification.positiveRecipeId, h.verification.actorBaselineRecipeId, h.verification.probeRecipeId, h.verification.negativeRecipeId]) recipeIds.add(id);
      const recipes = [...recipeIds].map(id => campaign.recipes.find(r => r.id === id));
      if (!recipes.length || recipes.some(r => !r || r.replaySafety !== "idempotent-read")) throw new Error("Automatic replay requires available idempotent-read recipes; stateful operations use separate causal capture");
      const receipts = [];
      for (let n = 0; n < repeats; n++) {
        const runId = randomUUID();
        for (const recipe of recipes) {
          const capture = await replay(recipe, campaign.program, runId, { command: JSON.stringify([process.execPath, ...process.argv.slice(1)]) });
          campaign.captures.push(capture); receipts.push({ id: capture.id, runId, recipeId: capture.recipeId, transport: capture.transport.outcome });
          // Save each actual result, including timeouts/partial bodies; a later failure cannot erase it.
          await save(args[0], parseCampaign(campaign));
        }
      }
      print({ context: campaign.program.context, receipts });
    } else if (command === "verify") {
      required(args, 2, command);
      const reviewed = reviewHypothesis(campaign, args[1]);
      await save(args[0], reviewed.campaign); print(reviewed.assessment);
    } else if (command === "reopen") {
      required(args, 3, command);
      const reopened = reopenHypothesis(campaign, args[1], args.slice(2).join(" "));
      await save(args[0], reopened); print({ hypothesisId: args[1], status: "hypothesis" });
    } else if (command === "refutation-input") {
      required(args, 3, command);
      const packet = refutationPacket(campaign, args[1]);
      await save(args[2], packet, true); print({ output: resolve(args[2]), inputSha256: packet.inputSha256 });
    } else if (command === "time-start") {
      required(args, 3, command);
      await save(args[0], startSession(campaign, args[1], args[2])); print({ started: args[1], lane: args[2] });
    } else if (command === "time-stop") {
      required(args, 2, command);
      await save(args[0], stopSession(campaign, args[1])); print({ stopped: args[1] });
    } else if (command === "report") {
      const report = { schemaVersion: 1, kind: "web-audit-report", program: campaign.program, matrix: matrix(campaign), hypotheses: campaign.hypotheses.map(h => ({ id: h.id, question: h.question, recordedStatus: h.status, assessment: assessHypothesis(campaign, h.id) })), metrics: campaignMetrics(campaign) };
      if (args[1]) await save(args[1], report, true);
      print(report);
    } else throw new Error(`Unknown command ${command}. Use --help.`);
  }
} catch (error) {
  process.stderr.write(`web-audit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
