#!/usr/bin/env node
/** Local synthetic read benchmark: never a provider/model performance claim. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { ControlPlane } from "../shared/control-plane/dist/index.js";
import { TrackingCoordinator } from "../shared/mcp-server-core/dist/tracking.js";

const workspace = mkdtempSync(join(tmpdir(), "bridge-tracking-benchmark-"));
const cp = ControlPlane.open({ workspaceRoot: workspace });
const tracking = new TrackingCoordinator({ workspaceRoot: workspace, principal: "benchmark" });
const db = new DatabaseSync(join(workspace, ".bridge", "bridge.db"));
const spec = { objective: "Synthetic benchmark fixture", scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "fixture", verification_criteria: ["read bounds"] };
const percentile = (samples, p) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
try {
  const root = cp.tasks.create({ spec, created_by: "codex" });
  const children = Array.from({ length: 260 }, () => cp.tasks.create({ spec, created_by: "codex", run_id: root.run_id, parent_task_id: root.task_id, delegation_depth: 1 }));
  const add = db.prepare("INSERT INTO task_attempts VALUES(?,?,?,?,?,?,?,?,?)");
  db.exec("BEGIN IMMEDIATE");
  for (const child of children) for (let attempt = 0; attempt < 5; attempt++) add.run(child.task_id, attempt, "claude", attempt ? attempt - 1 : null, null, Date.now(), Date.now(), Date.now(), "PARTIAL");
  db.exec("COMMIT");
  const start = performance.now(); const view = tracking.open({ run_id: root.run_id }); const openMs = performance.now() - start;
  assert.equal(view.tasks.length, 250); assert.equal(view.attempts.length, 1000); assert.equal(view.truncated, true);
  const samples = []; let snapshot = view;
  for (let n = 0; n < 30; n++) { const started = performance.now(); snapshot = tracking.read({ view_id: view.view_id, after: snapshot.next_cursor }); samples.push(performance.now() - started); }
  process.stdout.write(JSON.stringify({ scope: "synthetic local query-only reader; no model call or throughput comparison", node: process.version, platform: process.platform,
    fixture_tasks: 261, fixture_attempts: 1300, exported_tasks: snapshot.tasks.length, exported_attempts: snapshot.attempts.length, truncated: snapshot.truncated,
    samples: samples.length, open_ms: Number(openMs.toFixed(2)), read_p50_ms: Number(percentile(samples, .5).toFixed(2)), read_p95_ms: Number(percentile(samples, .95).toFixed(2)),
    snapshot_bytes: Buffer.byteLength(JSON.stringify(snapshot)), regular_active_reads_per_minute: 30, regular_idle_reads_per_minute: "3.3–5", hidden_reads_per_minute: 0 }, null, 2) + "\n");
} finally {
  tracking.close(); db.close(); cp.close();
  assert(workspace.startsWith(join(tmpdir(), "bridge-tracking-benchmark-")));
  rmSync(workspace, { recursive: true, force: true });
}
