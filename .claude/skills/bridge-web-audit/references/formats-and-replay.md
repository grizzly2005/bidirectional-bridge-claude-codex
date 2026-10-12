# JSON formats and executable replay

The experimental package is `@bridge/web-audit`, with no runtime dependencies on PDX, BELIEF, SQLite or a new MCP server. The CLI is `scripts/web-audit.mjs`. Run commands from the repository root after `npm run build`.

## Local end-to-end verification

```powershell
node node_modules/vitest/vitest.mjs run shared/web-audit/src/web-audit.test.ts
node shared/web-audit/examples/cli-smoke.mjs
```

The smoke starts an actual HTTP server on a random loopback port. It executes import, plan, timers, two replay rounds, verification, report, receipt-centered refutation input, pattern export/import and cross-campaign dedupe. It then changes the synthetic server to deny the previously exposed object and verifies that contradictory evidence becomes inconclusive. It uses synthetic actors, objects and private markers. It cleans only its own temporary package directory and prints commands/exits; this does not test an external target or measure real BBP performance.

For a persistent manual fixture, start the server in one terminal:

```powershell
node shared/web-audit/examples/local-fixture.mjs vulnerable 8787
```

In another terminal, choose a new campaign path:

```powershell
node shared/web-audit/examples/fixture-bundle.mjs fixture-import.json http://127.0.0.1:8787
node scripts/web-audit.mjs import fixture-import.json fixture-campaign.json
node scripts/web-audit.mjs time-start fixture-campaign.json local-clock single-agent
node scripts/web-audit.mjs plan fixture-campaign.json
node scripts/web-audit.mjs replay fixture-campaign.json fixture-object-isolation 2
node scripts/web-audit.mjs verify fixture-campaign.json fixture-object-isolation
node scripts/web-audit.mjs time-stop fixture-campaign.json local-clock
node scripts/web-audit.mjs report fixture-campaign.json fixture-report.json
node scripts/web-audit.mjs refutation-input fixture-campaign.json fixture-object-isolation refutation-input.json
```

The import generator is executable and shows every required field. Inspect its generated JSON when preparing an application-specific bundle. Use new output names for import/report/pattern packets: the CLI refuses to overwrite those outputs. Campaign updates save after each actual capture so partial results survive a later runner failure. JSON storage assumes a single writer; there is no multi-process transaction/lock protocol.

## Contracts

Every envelope has `schemaVersion=1`. Unknown fields or missing dimensions are rejected rather than guessed. Expected-policy provenance is `provided-policy`, `local-fixture` or `inference`; inference cannot confirm a finding.

| Envelope/data | Required content and semantics |
|---|---|
| `web-audit-import` | `program`, `recipes`, newly authored `hypotheses`; imported hypotheses have no status or history. |
| `web-audit-campaign` | Program, recipes, hypotheses with hash-bound history, captures and timed sessions. |
| Program | ID, `local-fixture`/`authorized-program` context, exact allowed origins including ports. This binds recipes, not a replacement for the user's authorization. |
| Recipe | Exact URL; surface origin/method/route, parameter/query/body shapes; all dimensions; session reference; headers/environment bindings; body base64; timeout/size; discovery state and replay safety. |
| Dimensions | `actorId`, `actorRole`, `objectId`, `objectOwnerId`, `actorTenantId`, `objectTenantId`, `workflowState`. Each is `{kind: "known", value: "…"}` or `{kind: "unknown", reason: "…"}`. A non-tenanted application must explicitly establish its absence, for example known `no-tenant`. |
| Capture | Run and recipe IDs/hash, context, tool/invocation, wall-clock timestamps and monotonic duration; explicit complete/error/timeout/truncated transport; retained request/response, derived view and hashes. |
| Hypothesis | Question; expected rule/source; known/unknown/unmet prerequisites with witness recipe/predicate; competing predictions; discrimination/cost/risk/routing; optional differential verification; append-only status events. |
| Predicate | `json-equals`, exact expected HTTP status, JSON property path, expected JSON value and explicit denial statuses. Status alone cannot match a protected field. |
| Verification | Four distinct recipe IDs: owner positive, second actor's own-object baseline, second actor protected-object probe, second actor negative control; actor JSON path; protected and actor-baseline predicates; at least two repetitions; authored root-cause/asset/impact key. |
| Session | Session ID, lane, timer start and optional stop. An active interval is excluded from final hours/rates. |

The matrix key includes the full surface and all dimensions. It does not merge actors by role, hosts by basename, ports, methods or query order/duplicates. Exact URLs and receipts remain attached. Matrix states indicate not-tested, a complete response observed or transport inconclusive; they are not finding verdicts.

The recorder stores request method, exact serialized URL, public header representation and body. Recipe URLs must equal Node's HTTP serialization (`origin + pathname + search`); unresolved dot segments, literal spaces/Unicode and other rewritten forms are refused before sending. Encode them explicitly and preserve query order/duplicates. Secret headers appear as `[redacted]`; Host and body length derive from the URL/body. `requestSha256` covers that retained representation, not original wire bytes or a token attestation. `responseBodySha256` covers retained response entity bytes; headers keep Node's original pairs including duplicates. Bodies above the limit are explicitly truncated and cannot confirm. Derived UTF-8/JSON is recomputed from retained bytes. There is no browser/TLS packet capture, automatic redirect following or hidden fallback to source-as-success.

## Evidence decisions

Captures are first deduplicated by an execution fingerprint covering reported tool/timing, transport and retained request/response, independently of receipt ID, run ID and invocation label. Renaming/resealing a receipt cannot supply a second repetition. This detects copied reported executions, not fabricated timestamps or other malicious rewrites of the unsigned record. The remaining captures join only by their exact `runId`; each required recipe must have exactly one matching independent capture per run. A missing, corrupt, partial or ambiguous comparison prevents promotion. All independent runs since the latest creation/reopening participate; two positive runs cannot hide a newer refutation. Mixed support/refutation becomes `tested-inconclusive`; consistently refuted complete comparisons become `rejected`.

`verifiedAt` is the completion time of the earliest sufficient set of supported independent runs within the current evidence epoch. Later concordant replays preserve it; `lastObservationAt` tracks the latest observation separately. A contradiction removes current confirmation. Duplicate execution receipt IDs are reported separately from the receipt IDs used for the comparisons.

The differential read checks distinct actors, controlled owned-object baselines, a preserved protected object and session references, origin/method/query/route shape, workflow state, actual response actor identity and the authored precondition predicates. The four responses must expose the actor marker at `actorIdentityPath`; without it the runner cannot establish identity and remains inconclusive. Supplied tenant/state/policy facts are still contextual inputs: hashes do not establish their business truth. A more general identity/session registry or a mutation oracle is outside this MVP.

`verify` appends an event and returns current witnesses. `report` and metrics re-evaluate evidence rather than trusting the saved status. History includes the immutable definition hash and a previous-event hash. It detects accidental modification against the saved chain, but a party that rewrites the entire unsigned JSON can recompute hashes. For changed recipe content use a new recipe ID/version and hypothesis/campaign; existing receipts retain the earlier recipe hash.

```powershell
node scripts/web-audit.mjs reopen fixture-campaign.json fixture-object-isolation "Application version changed"
```

Reopening retains earlier events and receipts but advances `evidenceSince`. A new hypothesis is required when the definition changes.

## Selection and routing

`plan` emits a serialized total ordering: eligible first, descending numeric score, then ascending hypothesis ID. It filters the current assessment, so new contradictions can reopen a recorded rejection for investigation. Preconditions and environment bindings determine eligibility. Capture gaps use only complete usable receipts from the current evidence epoch; reopening requires new captures. Differential verification also excludes login/redirect/non-JSON captures from usable capture coverage. The score is `(10 × declared alternative count + 2 × missing capture count − risk penalty) / estimated minutes`; risk penalties are passive 0, read 3, write 12. It reports every component. It is a transparent heuristic without calibrated probabilities, measured entropy or promises of discovery.

`routeInvestigation` returns one agent for mechanical exploration, two for an authored promising track or business-state reasoning, with a reason. It returns a recommendation and does not automatically delegate. Receipt-centered `refutation-input` omits the hypothesis's registered status, question, history and oracle assessment; its neutral question, policy, recipes and receipts let a second analyst refute the evidence. A shared workspace remains shared, and policy prose must also be checked for verdict contamination.

## Abstract lessons

An authored draft contains only `applicationContext`, `rootCause`, `suspicionSignals`, `confirmationTest`, `refutationTest`, `variants` and minimal provenance `{kind: "manually-authored-abstraction", reviewedForTargetFacts: true, authoredAt: "ISO time"}`. It has no source campaign/actor/session fields or prior verdict. There is deliberately no automatic finding-to-pattern converter.

```powershell
node scripts/web-audit.mjs pattern-export abstract-draft.json abstract-pattern.json source-campaign.json
node scripts/web-audit.mjs pattern-import abstract-pattern.json other-campaign.json new-hypothesis-binding.json
```

The new binding has the same shape as an imported hypothesis draft and references recipes belonging to the new campaign. The new history starts at `hypothesis` with zero inherited receipt references. Built-in string rules reject common URL/domain/IP/email/UUID/credential/ID assignment/verdict forms; supplied source facts add direct comparisons. Human review remains necessary for short IDs, arbitrary names, unusual hosts and token formats. This is abstraction validation, not exhaustive secret scanning.

## Campaign metrics

```powershell
node scripts/web-audit.mjs compare campaign-single.json campaign-two-agent.json
```

The key is program ID + authored root-cause key + affected-asset key + impact class. It intentionally depends on the campaign's reviewed key granularity; duplicate labels cannot define a universal vulnerability identity. The earliest sufficient confirmation among currently verified variants of a key determines its discovery attribution before lane deduplication, including across saved campaigns. A later concordant replay or a later duplicate hypothesis cannot transfer that key to another lane. Overlapping completed wall-clock intervals count once. An earliest confirmation that overlaps different lanes has ambiguous attribution and is excluded from lane finding counts. Unmeasured duration yields a null rate.

`compare` returns per-program groups and per-lane totals across campaigns, with local-fixture and authorized-program context separated. Reports always declare comparability unestablished. Real campaigns must have comparable scope, budgets and conditions before evaluating collaboration. Keep fixture counts separate, and include time spent on negative/refutation results. The implementation supplies descriptive unique verified findings per hour; it does not establish a causal speedup or current real-program yield.
