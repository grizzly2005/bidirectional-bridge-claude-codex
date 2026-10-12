#!/usr/bin/env node
/** Real local MCP processes and SQLite persistence. Default mode invokes no model. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = { namespace: "bug-bounty", context_id: "shared-memory-fixture", branch: "experimental", application_version: "fixture-v1", epoch: "fixture-epoch-1" };
const note = (kind, title, summary, extra = {}) => ({ kind, title, summary, lifecycle: "active", references: [], related_task_ids: [], abandonment: null, ...extra });
let openedProcesses = 0;
async function peer(caller, db) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(workspace, "scripts/native-bridge-mcp.mjs"), "--caller", caller, "--delegation", "deny", "--workspace", workspace, "--db", db], cwd: workspace, stderr: "pipe" });
  const client = new Client({ name: `shared-memory-${caller}`, version: "1.0.0" });
  transport.stderr?.on("data", () => {});
  await client.connect(transport); openedProcesses++;
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    let value; try { value = JSON.parse(text); } catch { value = { message: text }; }
    if (result.isError) throw Object.assign(new Error(`${name}: ${JSON.stringify(value)}`), { code: value.error?.code, detail: value.error?.details });
    return { value, text };
  };
  const info = (await call("bridge_server_info")).value;
  assert.equal(info.caller, caller); assert.equal(info.delegation, "deny");
  assert.deepEqual((await client.listTools()).tools.filter(tool => tool.name.startsWith("memory_")).map(tool => tool.name).sort(), ["memory_get_changes", "memory_get_context", "memory_upsert"]);
  const create = async (label, active = true) => {
    const task = (await call("bridge_create_task", { spec: { objective: label, scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "Local continuity result", verification_criteria: ["Actual MCP assertions"] } })).value;
    if (active) { await call("bridge_claim_task", { task_id: task.task_id }); await call("bridge_set_state", { task_id: task.task_id, to: "WORKING" }); }
    return task;
  };
  const finish = async task => call("bridge_submit_deliverable", { task_id: task.task_id, status: "COMPLETE", summary: "Local memory assertions passed.", changed_scope: [], artifacts: [], commit_or_diff: null,
    verification_results: [{ kind: "manual", command: "Assert actual shared-memory MCP responses", passed: true, exit_code: null, summary: "Recorded fixture values and references matched after MCP calls." }], remaining_risks: [], recommended_next_action: "Next independent client." });
  return { call, create, finish, close: () => client.close() };
}
function saveFrame(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
const readFrame = file => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, "memory-restart-fixture");
  assert.equal(resolve(value.db), join(dirname(resolve(file)), "restart-fixture.db"), "Fixture must use its own adjacent database");
  assert.deepEqual(value.scope, scope, "Only the synthetic test scope is supported");
  return value;
};
async function seed(file) {
  const db = join(dirname(file), "restart-fixture.db");
  if (existsSync(file) || existsSync(db)) throw new Error("Choose a fresh fixture path; existing memory history will not be replaced");
  const codex = await peer("codex", db);
  try {
    const task = await codex.create("Codex records working context before closing its client");
    const pending = await codex.create("Acquire the missing second controlled actor", false);
    const canonical = { kind: "local-surface-map-fixture", endpoints: Array.from({ length: 150 }, (_, n) => `/fixture/objects/${n}`),
      hypotheses: Array.from({ length: 8 }, (_, n) => ({ id: `hypothesis-${n}`, question: `Does control ${n} preserve the actor/object boundary?`, status: "unconfirmed" })), marker: "DO-NOT-LOAD-FIXTURE-RAW-MAP" };
    const artifact = (await codex.call("bridge_publish_artifact", { task_id: task.task_id, name: "surface-map-fixture.json", kind: "json", inline: JSON.stringify(canonical) })).value;
    const references = [{ artifact_id: artifact.artifact_id, sha256: artifact.sha256, record_type: "surface-map", record_id: scope.context_id, source_epoch: scope.epoch }];
    const summary = note("context", "Current investigation", "150 endpoints mapped and 8 unconfirmed hypotheses. Next work: establish the second actor and state prerequisites.", { references, related_task_ids: [pending.task_id] });
    const upsert = async (key, value) => (await codex.call("memory_upsert", { task_id: task.task_id, scope, key, expected_revision: 0, idempotency_key: `seed:${key}`, note: value })).value;
    const first = await upsert("working-summary", summary);
    await upsert("abandoned-actor-track", note("abandoned-track", "Investigation paused", "The comparison lacks a controlled second actor.", {
      references, abandonment: { reason: "Second actor unavailable.", tested_conditions: "Fixture v1, epoch 1; only owner baseline available.", reopen_when: "A second controlled actor becomes available or the workflow version changes." },
    }));
    await upsert("next-investigation", note("next-action", "Next witness", "Establish actor and state controls before testing the cross-object hypothesis.", { references, related_task_ids: [pending.task_id] }));
    const context = await codex.call("memory_get_context", { scope, max_bytes: 8192 });
    assert.equal(context.value.notes.length, 3); assert(context.value.notes.every(row => row.reference_states.every(ref => ref.status === "intact")));
    assert(!context.text.includes(canonical.marker)); assert(Buffer.byteLength(context.text) <= 8192);
    assert(context.value.pending_tasks.some(row => row.task_id === pending.task_id));
    await codex.finish(task);
    const frame = { schemaVersion: 1, kind: "memory-restart-fixture", db, scope, artifact, pendingTaskId: pending.task_id,
      codexTaskId: task.task_id, snapshotCursor: context.value.change_cursor, initialRevision: first.revision,
      contextBytes: Buffer.byteLength(context.text), mappedEndpoints: 150, unconfirmedHypotheses: 8 };
    saveFrame(file, frame); return frame;
  } finally { await codex.close(); }
}
async function enrich(file, summary = "Claude identified a missing workflow-state prerequisite; obtain an independent actor/state witness before the next comparison.") {
  const frame = readFrame(file), claude = await peer("claude", frame.db);
  try {
    const context = (await claude.call("memory_get_context", { scope: frame.scope, max_bytes: 8192 })).value;
    const previous = context.notes.find(row => row.key === "working-summary");
    if (frame.claudeRevision === 2) {
      assert.equal(previous.revision, 2); assert.equal(previous.summary, frame.claudeSummary);
      // A resumed reviewer replays the original committed request, without another write.
      const replayed = (await claude.call("memory_upsert", { scope: frame.scope, key: previous.key,
        expected_revision: 1, task_id: frame.claudeTaskId, idempotency_key: "claude:workflow-prerequisite",
        note: note(previous.kind, previous.title, frame.claudeSummary, { references: previous.references, related_task_ids: previous.related_task_ids }) })).value;
      assert.equal(replayed.change_cursor, frame.claudeChangeCursor); assert.equal(replayed.revision, 2);
      return { caller: "claude", revision: 2, changeCursor: replayed.change_cursor, referencesPreserved: true,
        idempotentReplay: true, newObservationApplied: false };
    }
    assert.equal(previous.revision, 1); assert.equal(previous.provenance.agent, "codex");
    assert(context.notes.find(row => row.key === "abandoned-actor-track").abandonment.reopen_when.includes("second controlled actor"));
    assert(previous.references.some(ref => ref.artifact_id === frame.artifact.artifact_id && ref.sha256 === frame.artifact.sha256));
    const task = await claude.create("Claude enriches context after the previous MCP client closed");
    const revision = (await claude.call("memory_upsert", { scope: frame.scope, key: previous.key, expected_revision: previous.revision,
      task_id: task.task_id, idempotency_key: "claude:workflow-prerequisite", note: note(previous.kind, previous.title, summary,
        { references: previous.references, related_task_ids: previous.related_task_ids }) })).value;
    assert.equal(revision.revision, 2); assert.equal(revision.provenance.agent, "claude");
    await claude.finish(task);
    const updated = { ...frame, claudeTaskId: task.task_id, claudeRevision: revision.revision, claudeChangeCursor: revision.change_cursor, claudeSummary: summary };
    saveFrame(file, updated); return { caller: "claude", revision: revision.revision, changeCursor: revision.change_cursor, referencesPreserved: true };
  } finally { await claude.close(); }
}
async function history(peer, frame) {
  const result = []; let cursor = 0, upper;
  for (let n = 0; n < 100; n++) {
    const page = (await peer.call("memory_get_changes", { scope: frame.scope, change_cursor: cursor, limit: 1, ...(upper === undefined ? {} : { until_cursor: upper }) })).value;
    upper ??= page.head_cursor; result.push(...page.changes); cursor = page.change_cursor;
    if (!page.has_more) return result;
  }
  throw new Error("History pagination failed to terminate");
}
async function resume(file) {
  const frame = readFrame(file), codex = await peer("codex", frame.db);
  try {
    const delta = (await codex.call("memory_get_changes", { scope: frame.scope, change_cursor: frame.snapshotCursor })).value;
    assert.deepEqual(delta.changes.map(row => [row.key, row.revision, row.provenance.agent]), [["working-summary", 2, "claude"]]);
    assert.equal(delta.changes[0].summary, frame.claudeSummary);
    assert.equal(delta.changes[0].references[0].sha256, frame.artifact.sha256);
    assert(delta.changes[0].reference_states.every(row => row.status === "intact"));
    const revisions = (await history(codex, frame)).filter(row => row.key === "working-summary");
    assert.deepEqual(revisions.map(row => [row.revision, row.provenance.agent]), [[1, "codex"], [2, "claude"]]);
    const context = (await codex.call("memory_get_context", { scope: frame.scope, max_bytes: 8192 })).value;
    assert(context.notes.find(row => row.key === "abandoned-actor-track").abandonment.reason);
    assert(context.pending_tasks.some(row => row.task_id === frame.pendingTaskId));
    assert.equal((await codex.call("memory_get_context", { scope: { ...frame.scope, epoch: "fixture-epoch-2" } })).value.notes.length, 0);
    const result = { continuity: "codex-close-claude-close-codex", revision: 2, deltaOnly: true, historyRecovered: true,
      referencesPreserved: true, abandonedReasonPreserved: true, oldEpochExcluded: true, campaignBodyLoadedIntoContext: false };
    saveFrame(join(dirname(file), "restart-result.json"), result); return result;
  } finally { await codex.close(); }
}
async function race(file) {
  const frame = readFrame(file), a = await peer("codex", frame.db), b = await peer("claude", frame.db);
  try {
    const ta = await a.create("Race participant Codex"), tb = await b.create("Race participant Claude");
    const value = note("decision", "Concurrent decision", "The current revision must be read before merging.");
    await a.call("memory_upsert", { scope: frame.scope, key: "race-entry", expected_revision: 0, task_id: ta.task_id, idempotency_key: "race:create", note: value });
    const results = await Promise.allSettled([
      a.call("memory_upsert", { scope: frame.scope, key: "race-entry", expected_revision: 1, task_id: ta.task_id, idempotency_key: "race:codex", note: { ...value, summary: "Codex update" } }),
      b.call("memory_upsert", { scope: frame.scope, key: "race-entry", expected_revision: 1, task_id: tb.task_id, idempotency_key: "race:claude", note: { ...value, summary: "Claude update" } }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "REVISION_CONFLICT").length, 1);
    await a.call("memory_upsert", { scope: frame.scope, key: "race-entry", expected_revision: 2, task_id: ta.task_id, idempotency_key: "race:archive", note: { ...value, lifecycle: "archived" } });
    assert.equal((await a.call("memory_get_context", { scope: frame.scope, keys: ["race-entry"] })).value.notes.length, 0);
    assert.deepEqual((await history(a, frame)).filter(row => row.key === "race-entry").map(row => row.lifecycle), ["active", "active", "archived"]);
    await a.finish(ta); await b.finish(tb);
    return { separateMcpProcesses: 2, successes: 1, revisionConflicts: 1, archivedHistoryRecovered: true };
  } finally { await a.close(); await b.close(); }
}

const [mode, fileArg, summaryArg] = process.argv.slice(2);
if (["--prepare-live", "--claude-enrich", "--codex-resume"].includes(mode)) {
  if (!fileArg) throw new Error("An explicit fixture JSON path is required");
  const file = resolve(fileArg); mkdirSync(dirname(file), { recursive: true });
  const value = mode === "--prepare-live" ? await seed(file) : mode === "--claude-enrich" ? await enrich(file, summaryArg) : await resume(file);
  console.log(JSON.stringify({ mode, value, actualMcpProcesses: openedProcesses, providerInvokedByScript: false }));
} else {
  if (mode && mode !== "--keep") throw new Error("Use no args, --keep <new-output-directory>, or a live stage flag with fixture path");
  const retained = mode === "--keep";
  const dir = retained ? resolve(fileArg ?? (() => { throw new Error("--keep requires an output directory"); })()) : mkdtempSync(join(tmpdir(), "bridge-shared-memory-"));
  mkdirSync(dir, { recursive: true }); const file = join(dir, "fixture.json");
  try {
    await seed(file); await enrich(file); const restart = await resume(file); const concurrency = await race(file);
    console.log(JSON.stringify({ status: "PASS", restart, concurrency, actualMcpProcesses: openedProcesses,
      providerCalls: 0, targetNetworkCalls: 0, realBugBountyPerformanceMeasured: false, ...(retained ? { evidenceDirectory: dir } : {}) }));
  } finally {
    if (!retained) {
      const absolute = resolve(dir);
      if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("bridge-shared-memory-")) throw new Error("Refusing recursive cleanup outside the generated temporary fixture");
      rmSync(absolute, { recursive: true, force: true });
    }
  }
}
