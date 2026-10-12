import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const predicate = (key, equals) => ({ kind: "json-equals", expectedStatus: 200, path: [key], equals, denialStatuses: [403, 404] });
const known = value => ({ kind: "known", value });
export function fixtureBundle(origin, overrides = {}) {
  const recipe = (id, actor, object, owner) => ({
    schemaVersion: 1, id, url: `${origin}/objects/${object}`,
    surface: { origin, method: "GET", routeTemplate: "/objects/{objectId}", parameterShape: ["objectId:string"], queryShape: [], bodyShape: [] },
    dimensions: { actorId: known(`fixture-${actor}`), actorRole: known("member"), objectId: known(`fixture-object-${object}`), objectOwnerId: known(`fixture-${owner}`), actorTenantId: known("fixture-tenant"), objectTenantId: known("fixture-tenant"), workflowState: known("active") },
    sessionRef: known(`fixture-session-${actor}`), headers: [{ name: "X-Fixture-Actor", value: `fixture-${actor}` }], secretHeaders: [],
    bodyBase64: "", timeoutMs: 1_000, maxResponseBytes: 65_536, discovery: "observed", replaySafety: "idempotent-read",
  });
  return {
    schemaVersion: 1, kind: "web-audit-import",
    program: { id: "synthetic-loopback-only", context: "local-fixture", allowedOrigins: [origin] },
    recipes: [recipe("own-a", "a", "a", "a"), recipe("own-b", "b", "b", "b"), recipe("cross-b-a", "b", "a", "a"), recipe("negative-b", "b", "missing", "none")],
    hypotheses: [{
      id: "fixture-object-isolation", question: "Does the controlled second actor receive the first actor's private fixture marker?",
      expected: { rule: "The synthetic fixture requires actor-owned objects", provenance: "local-fixture", reference: "examples/local-fixture.mjs controlled object relation" },
      preconditions: [
        { id: "owned-a", description: "First object's owner is controlled", state: "met", witnesses: [{ recipeId: "own-a", predicate: predicate("owner", "fixture-a") }] },
        { id: "tenant-a", description: "Object tenant is controlled", state: "met", witnesses: [{ recipeId: "own-a", predicate: predicate("tenant", "fixture-tenant") }] },
        { id: "state-a", description: "Object state is controlled", state: "met", witnesses: [{ recipeId: "own-a", predicate: predicate("state", "active") }] },
      ],
      predictions: [{ id: "isolation", description: "Cross-actor access is refused" }, { id: "exposure", description: "Cross-actor access returns the protected JSON marker" }],
      investigation: { recipeIds: ["own-a", "own-b", "cross-b-a", "negative-b"], discriminates: ["isolation", "exposure"], costMinutes: 2, risk: "read", businessLogic: false, promising: false },
      verification: { kind: "differential-read-v1", positiveRecipeId: "own-a", actorBaselineRecipeId: "own-b", probeRecipeId: "cross-b-a", negativeRecipeId: "negative-b", actorIdentityPath: ["actor"], protectedPredicate: predicate("private", "fixture-private-a"), actorBaselinePredicate: predicate("private", "fixture-private-b"), minimumRepetitions: 2, finding: { rootCauseKey: "fixture-missing-object-owner-check", affectedAssetKey: "fixture-object-read", impactClass: "fixture-private-data-read" } },
      patternId: null,
      ...overrides,
    }],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Provide a new JSON output path and optional loopback origin");
  await writeFile(process.argv[2], `${JSON.stringify(fixtureBundle(process.argv[3] ?? "http://127.0.0.1:8787"), null, 2)}\n`, { flag: "wx" });
}
