import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { listenFixture } from "./local-fixture.mjs";
import { fixtureBundle } from "./fixture-bundle.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../../../scripts/web-audit.mjs", import.meta.url));
const directory = await mkdtemp(join(packageRoot, ".cli-smoke-"));
const fixture = await listenFixture();
const results = [];
const run = async (...args) => {
  const result = await promisify(execFile)(process.execPath, [cli, ...args], { windowsHide: true, maxBuffer: 4_000_000 });
  results.push({ command: ["node scripts/web-audit.mjs", ...args.map(arg => arg.startsWith(directory) ? `<fixture-temp>/${basename(arg)}` : arg)].join(" "), exit: 0 });
  return JSON.parse(result.stdout);
};
try {
  const bundle = join(directory, "bundle.json"), campaign = join(directory, "campaign.json");
  await writeFile(bundle, JSON.stringify(fixtureBundle(fixture.origin)));
  await run("import", bundle, campaign);
  assert.equal((await run("plan", campaign)).selectedHypothesisId, "fixture-object-isolation");
  await run("time-start", campaign, "fixture-wall-clock", "single-agent");
  assert.equal((await run("replay", campaign, "fixture-object-isolation", "2")).receipts.length, 8);
  assert.equal((await run("verify", campaign, "fixture-object-isolation")).status, "confirmed-with-evidence");
  await run("time-stop", campaign, "fixture-wall-clock");
  const report = await run("report", campaign);
  assert.equal(report.metrics.uniqueVerifiedFindings, 1);
  assert.ok(report.metrics.totalHours > 0);
  assert.match(report.metrics.performanceEvidence, /no measured bug-bounty performance/);
  const packetPath = join(directory, "refutation.json");
  await run("refutation-input", campaign, "fixture-object-isolation", packetPath);
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  assert.equal(packet.receipts.length, 8);
  for (const key of ["status", "history", "assessment", "verdict", "hypotheses"]) assert.equal(Object.hasOwn(packet, key), false);
  const abstractDraft = {
    applicationContext: "Multi-user API with private object reads", rootCause: "Object-level permission check omitted",
    suspicionSignals: ["Own-object and cross-actor reads differ from the expected isolation rule"],
    confirmationTest: "Compare two owned-object baselines, a cross-actor request and a forbidden-object witness",
    refutationTest: "Apply the same protected-field predicate to a corrected application and an error response",
    variants: ["Export endpoint and secondary object read"],
    provenance: { kind: "manually-authored-abstraction", reviewedForTargetFacts: true, authoredAt: new Date().toISOString() },
  };
  const draftPath = join(directory, "abstract-draft.json"), patternPath = join(directory, "pattern.json"), bindingPath = join(directory, "binding.json");
  await writeFile(draftPath, JSON.stringify(abstractDraft));
  await run("pattern-export", draftPath, patternPath, campaign);
  const binding = fixtureBundle(fixture.origin).hypotheses[0]; binding.id = "fresh-pattern-hypothesis";
  await writeFile(bindingPath, JSON.stringify(binding));
  assert.equal((await run("pattern-import", patternPath, campaign, bindingPath)).status, "hypothesis");
  assert.equal((await run("verify", campaign, binding.id)).status, "tested-inconclusive");
  assert.equal((await run("compare", campaign, campaign)).groups[0].uniqueVerifiedFindings, 1);
  fixture.setMode("fixed");
  await run("replay", campaign, "fixture-object-isolation");
  assert.equal((await run("verify", campaign, "fixture-object-isolation")).status, "tested-inconclusive");
  assert.equal((await run("report", campaign)).metrics.uniqueVerifiedFindings, 0);
  process.stdout.write(`${JSON.stringify({ context: "local-fixture", actualLoopbackHttp: true, commands: results, assertions: "CLI import/plan/timer/replay/verify/report/refutation/pattern/compare and contradictory corrected replay passed", bbpPerformanceMeasured: false }, null, 2)}\n`);
} finally {
  await fixture.close();
  // This is only this script's generated directory, resolved inside its own package.
  if (dirname(directory) !== packageRoot.replace(/[\\/]$/, "") || !basename(directory).startsWith(".cli-smoke-")) throw new Error("Unexpected temporary directory; cleanup refused");
  await rm(directory, { recursive: true, force: true });
}
