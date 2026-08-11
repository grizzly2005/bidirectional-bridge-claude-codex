#!/usr/bin/env node
/**
 * Live proof of the real Claude execution path.
 *
 *   control plane -> ClaudeAdapter -> real `claude` runtime -> result
 *                 -> persisted session id -> Deliverable
 *
 * Then a second bounded delegation that RESUMES the persisted session, proving the handle
 * is a working pointer and not just a stored string.
 *
 * The delegated task is deliberately harmless and read-only: report runtime and repository
 * information. It runs with `--permission-mode plan`, so the runtime cannot edit files even
 * if it decided to.
 *
 * Usage:
 *   node claude/claude-side/scripts/live-claude-delegation.mjs [--workspace <path>]
 *
 * Requires an authenticated Claude Code (`claude /login`, or ANTHROPIC_API_KEY in the
 * environment). Exits 0 only if a real delegation completed, the resume produced the same
 * session id, AND the resumed run restated the first run's finding from session memory
 * without re-executing anything.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlane, Orchestrator } from "@bridge/control-plane";
import { ClaudeAdapter, ClaudeCodeRunner } from "@bridge/claude-side";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const workspace = resolve(flag("--workspace", repoRoot));
const claudeBin = flag("--claude-bin", "claude");
const dbDir = mkdtempSync(join(tmpdir(), "bridge-live-"));
const log = (...a) => process.stderr.write(`${a.join(" ")}\n`);

const SCOPE = { paths: ["docs/**"] }; // read-only task; nothing is written

function spec(objective, criteria) {
  return {
    objective,
    scope: SCOPE,
    dependencies: [],
    expected_deliverable: "a short structured report of what was observed",
    verification_criteria: criteria,
  };
}

let exitCode = 1;
const cp = ControlPlane.open({
  workspaceRoot: workspace,
  databasePath: join(dbDir, "live.db"),
  onWarning: (m) => log("[warn]", m),
});

try {
  const runner = new ClaudeCodeRunner({
    command: claudeBin,
    maxTurns: 6,
    permissionMode: "plan",
    log,
  });

  const health = await runner.probe();
  log(`[live] claude runtime: ${health.ok ? "ready" : "UNAVAILABLE"} ${health.detail ?? ""}`);
  if (!health.ok) {
    log("[live] FAILED: the claude binary is not runnable");
    process.exit(2);
  }

  cp.adapters.register(new ClaudeAdapter({ runner, agent: "claude" }));
  const orchestrator = new Orchestrator(cp);

  /* ---------- 1. real delegation ---------- */

  log("\n[live] === delegation 1: real Claude runtime ===");
  const first = await orchestrator.delegate({
    from: "codex",
    to: "claude",
    spec: spec(
      "Report the Node.js version and the name of the current working directory. " +
        "Do not modify any file. Run `node --version` to obtain the version.",
      ["node --version was executed and its output reported"],
    ),
    input_artifacts: [],
    deadline_ms: 180_000,
  });

  const task = cp.tasks.get(first.task_id);
  const attempt0 = cp.attempts.get(first.task_id, 0);

  log(`[live] task_id            : ${first.task_id}`);
  log(`[live] task state         : ${task.state}`);
  log(`[live] deliverable status : ${first.deliverable?.status ?? "none"}`);
  log(`[live] error              : ${first.error ? `${first.error.code}: ${first.error.message}` : "none"}`);
  log(`[live] execution_handle   : ${attempt0?.execution_handle ?? "NONE"}`);
  log(`[live] summary            : ${(first.deliverable?.summary ?? "").slice(0, 300)}`);
  log(`[live] verifications      : ${JSON.stringify(first.deliverable?.verification_results ?? [])}`);

  if (!attempt0?.execution_handle) {
    log("[live] FAILED: no session id was persisted — the run never reached the runtime");
    process.exit(3);
  }
  if (first.error) {
    log(`[live] FAILED: delegation errored (${first.error.code})`);
    process.exit(4);
  }

  /*
   * A PARTIAL here means the subprocess ran and minted a session but the model never
   * worked — almost always an unauthenticated CLI. Exiting 0 on that would report a live
   * proof that did not happen, so it is called out as its own failure mode.
   */
  if (first.deliverable?.status !== "COMPLETE") {
    log("");
    log(`[live] INCOMPLETE: the runtime started but returned ${first.deliverable?.status}.`);
    log(`[live] reason: ${(first.deliverable?.remaining_risks ?? []).join("; ") || "unknown"}`);
    log("[live] The subprocess path, session capture and persistence are proven;");
    log("[live] the model call is not. Authenticate Claude Code (`claude` then /login,");
    log("[live] or set ANTHROPIC_API_KEY) and re-run for a full live proof.");
    process.exit(6);
  }

  /* ---------- 2. resume the persisted session ---------- */

  log("\n[live] === delegation 2: resume the persisted session ===");
  const resumeTask = cp.tasks.create({
    spec: spec(
      "Continuing the previous exchange: restate the Node.js version you already reported. " +
        "Do not run any command again and do not modify any file.",
      ["the prior answer was restated from session memory"],
    ),
    created_by: "codex",
  });

  // Seed attempt 0 with the handle from delegation 1, then invoke attempt 1 so the
  // orchestrator hands it back as `previous_execution_handle`.
  cp.attempts.saveHandle(resumeTask.task_id, 0, "claude", attempt0.execution_handle);
  cp.tasks.claim(resumeTask.task_id, "claude");
  cp.tasks.transition({ task_id: resumeTask.task_id, agent: "claude", to: "WORKING" });
  const lease = cp.leases.acquire({
    task_id: resumeTask.task_id,
    holder: "claude",
    scope: SCOPE,
    ttl_ms: 200_000,
  });

  const adapter = cp.adapters.get("claude");
  const saved = [];
  const deliverable = await adapter.invoke(
    {
      task_id: resumeTask.task_id,
      spec: resumeTask.spec,
      inputs: [],
      workspace_root: workspace,
      lease_id: lease.lease_id,
      deadline_at: Date.now() + 180_000,
      attempt: 1,
      idempotency_key: `${resumeTask.task_id}:1`,
      previous_execution_handle: cp.attempts.previousHandle(resumeTask.task_id, 1),
    },
    {
      report: async () => {},
      publishArtifact: async () => "art_0000000000",
      recordVerification: async () => {},
      raiseBlocker: async () => {},
      saveExecutionHandle: async (h) => {
        saved.push(h);
        cp.attempts.saveHandle(resumeTask.task_id, 1, "claude", h);
      },
      signal: new AbortController().signal,
    },
  );
  cp.leases.release(lease.lease_id, "claude");

  const resumedHandle = saved[0];
  log(`[live] resumed task_id    : ${resumeTask.task_id}`);
  log(`[live] resumed handle     : ${resumedHandle ?? "NONE"}`);
  log(`[live] same session       : ${resumedHandle === attempt0.execution_handle}`);
  log(`[live] resumed status     : ${deliverable.status}`);
  log(`[live] resumed summary    : ${(deliverable.summary ?? "").slice(0, 300)}`);

  if (resumedHandle !== attempt0.execution_handle) {
    log("[live] FAILED: resume did not continue the same session");
    process.exit(5);
  }

  /*
   * Prove SEMANTIC continuation, not merely that the CLI accepted `--resume`.
   *
   * `buildPrompt` never embeds the value reported by delegation 1, so the only place the
   * runtime can obtain it is the session it is continuing. Restating it is the proof.
   *
   * Status is deliberately NOT asserted to be COMPLETE. This spec forbids re-running any
   * command, and the adapter's honesty gate grants COMPLETE only against a passing
   * verification that actually ran one — so a COMPLETE resume would mean the runtime
   * disobeyed the spec. PARTIAL with zero verifications is the correct outcome here, and
   * the empty verification list is itself the evidence that nothing was re-executed.
   */
  const reported = `${first.deliverable.summary ?? ""} ${(first.deliverable.verification_results ?? [])
    .map((v) => v.summary ?? "")
    .join(" ")}`;
  const version = reported.match(/v\d+\.\d+\.\d+/)?.[0];
  const resumedSummary = deliverable.summary ?? "";
  const resumedVerifications = deliverable.verification_results ?? [];

  log(`[live] value to continue  : ${version ?? "NONE"}`);
  log(`[live] restated on resume : ${version ? resumedSummary.includes(version) : false}`);
  log(`[live] resumed verifs     : ${resumedVerifications.length} (expected 0: commands were forbidden)`);

  if (!version) {
    log("[live] FAILED: delegation 1 reported no concrete value for the resume to continue from");
    process.exit(7);
  }
  if (!resumedSummary.includes(version)) {
    log(`[live] FAILED: resumed run never restated ${version} — the session carried no memory`);
    process.exit(7);
  }
  if (resumedVerifications.length > 0) {
    log("[live] FAILED: resumed run executed commands, so the restatement was not from memory");
    process.exit(8);
  }

  log("\n[live] PASS: real delegation completed and the session resumed");
  exitCode = 0;
} catch (err) {
  log(`[live] FAILED with an exception: ${err?.stack ?? String(err)}`);
  exitCode = 1;
} finally {
  cp.close();
  rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.exit(exitCode);
