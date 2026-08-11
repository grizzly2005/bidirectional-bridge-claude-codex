/**
 * MCP tool surface over the control plane.
 *
 * This is the coordination API both agents call. Every tool is a thin projection of a
 * control-plane operation — no business logic lives here, so the MCP transport can be
 * swapped (HTTP, in-process) without changing semantics.
 *
 * Two conventions worth knowing:
 *  - every mutating tool takes an optional `idempotency_key`, because an MCP call that
 *    times out leaves the caller unable to tell whether it applied (D-005);
 *  - errors come back as structured `BridgeError` JSON inside an `isError` result, so the
 *    calling agent can branch on `code` instead of parsing prose.
 */

import { z } from "zod";
import {
  BridgeError,
  MAX_TASK_MAX_TURNS,
  MIN_TASK_MAX_TURNS,
  DeliverableStatus,
  ErrorCode,
  TaskState,
  type AgentId,
  type Deliverable,
  type TaskSpec,
  type VerificationResult,
} from "@bridge/protocol";
import type { ControlPlane, Orchestrator } from "@bridge/control-plane";

/* ------------------------------------------------------------------ *
 * Zod shapes (the MCP SDK builds JSON Schema from these)
 * ------------------------------------------------------------------ */

const writeScopeShape = z.object({
  paths: z.array(z.string().min(1)).min(1).describe("Repo-relative glob patterns you intend to write."),
  note: z.string().optional(),
});

const taskSpecShape = z.object({
  objective: z.string().min(1).describe("One sentence stating what 'done' means."),
  scope: writeScopeShape,
  dependencies: z.array(z.string()).default([]).describe("Task ids that must be DONE first."),
  expected_deliverable: z.string().min(1),
  verification_criteria: z
    .array(z.string().min(1))
    .min(1)
    .describe("How completion will be checked. At least one is mandatory."),
  preferred_agent: z.string().optional(),
  deadline_ms: z.number().int().optional(),
  max_turns: z
    .number()
    .int()
    .min(MIN_TASK_MAX_TURNS)
    .max(MAX_TASK_MAX_TURNS)
    .optional()
    .describe("Finite worker turn ceiling; omit for the conservative runtime default."),
  priority: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string()).optional(),
});

const verificationShape = z.object({
  kind: z.enum(["test", "typecheck", "build", "lint", "static_analysis", "benchmark", "manual"]),
  command: z.string().min(1).describe("The exact command that was executed."),
  passed: z.boolean(),
  exit_code: z.number().int().nullable(),
  summary: z.string(),
  duration_ms: z.number().int().optional(),
  output_excerpt: z.string().optional(),
});

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

export interface ToolContext {
  readonly cp: ControlPlane;
  readonly orchestrator: Orchestrator;
  /** Identity bound when the server process starts. Tool arguments cannot override it. */
  readonly defaultAgent: AgentId;
  /** Generic server-side delegation policy selected when the process starts. */
  readonly delegationPolicy: DelegationPolicy;
}

export type DelegationPolicy = "allow" | "deny";

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: z.ZodRawShape;
  readonly handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
}

const agentArg = { agent: z.string().optional().describe("Calling agent id; defaults to the server's identity.") };
const idemArg = {
  idempotency_key: z
    .string()
    .optional()
    .describe("Replay-safety key. Retrying with the same key returns the original result."),
};
const lineageArgs = {
  run_id: z
    .string()
    .regex(/^run_[0-9a-hjkmnp-tv-z]{10}$/u)
    .optional()
    .describe("Durable run correlation id. Omit to create a new root run."),
  parent_task_id: z
    .string()
    .nullable()
    .optional()
    .describe("Immediate parent task. Child run/depth are validated against it."),
  delegation_depth: z.number().int().min(0).max(32).optional(),
};

const who = (args: Record<string, unknown>, ctx: ToolContext): AgentId => {
  const supplied = args["agent"] as string | undefined;
  if (supplied !== undefined && supplied !== ctx.defaultAgent) {
    throw new BridgeError(
      ErrorCode.INVALID_ARGUMENT,
      `caller '${supplied}' contradicts the server-bound identity '${ctx.defaultAgent}'`,
      { supplied_agent: supplied, bound_agent: ctx.defaultAgent },
    );
  }
  return ctx.defaultAgent;
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "bridge_server_info",
    title: "Inspect the bound bridge session",
    description:
      "Return the caller identity and delegation policy bound when this MCP server process " +
      "started. These values cannot be changed by tool arguments.",
    inputShape: {},
    handler: (_args, ctx) => ({
      caller: ctx.defaultAgent,
      delegation: ctx.delegationPolicy,
    }),
  },
  {
    name: "bridge_create_task",
    title: "Create a coordination task",
    description:
      "Register a bounded unit of work with an objective, write scope, dependencies, expected " +
      "deliverable and verification criteria. Returns the task_id. Create a task before doing " +
      "substantial work so the other agent can see ownership.",
    inputShape: { spec: taskSpecShape, ...lineageArgs, ...agentArg, ...idemArg },
    handler: (args, ctx) => {
      const task = ctx.cp.tasks.create({
        spec: args["spec"] as TaskSpec,
        created_by: who(args, ctx),
        ...(args["run_id"] ? { run_id: args["run_id"] as string } : {}),
        ...(args["parent_task_id"] !== undefined
          ? { parent_task_id: args["parent_task_id"] as string | null }
          : {}),
        ...(args["delegation_depth"] !== undefined
          ? { delegation_depth: args["delegation_depth"] as number }
          : {}),
        ...(args["idempotency_key"] ? { idempotency_key: args["idempotency_key"] as string } : {}),
      });
      return {
        task_id: task.task_id,
        run_id: task.run_id,
        parent_task_id: task.parent_task_id,
        delegation_depth: task.delegation_depth,
        state: task.state,
        created_at: task.created_at,
      };
    },
  },
  {
    name: "bridge_list_tasks",
    title: "List tasks",
    description:
      "List tasks, optionally filtered by state or owner. Call this before starting work to " +
      "avoid duplicating something the other agent already owns.",
    inputShape: {
      state: z
        .enum(["PENDING", "CLAIMED", "WORKING", "BLOCKED", "VERIFYING", "DONE", "FAILED", "CANCELLED"])
        .optional(),
      owner: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: (args, ctx) => {
      const tasks = ctx.cp.tasks.list({
        ...(args["state"] ? { state: args["state"] as TaskState } : {}),
        ...(args["owner"] ? { owner: args["owner"] as string } : {}),
        ...(args["limit"] ? { limit: args["limit"] as number } : {}),
      });
      return {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          run_id: t.run_id,
          parent_task_id: t.parent_task_id,
          delegation_depth: t.delegation_depth,
          state: t.state,
          owner: t.owner,
          objective: t.spec.objective,
          scope: t.spec.scope.paths,
          dependencies: t.spec.dependencies,
          blockers: t.blockers,
          attempt: t.attempt,
        })),
      };
    },
  },
  {
    name: "bridge_get_task",
    title: "Get one task in full",
    description: "Full task record plus dependency status, artifacts, latest status and deliverable.",
    inputShape: { task_id: z.string() },
    handler: (args, ctx) => {
      const task_id = args["task_id"] as string;
      const task = ctx.cp.tasks.get(task_id);
      return {
        task,
        dependencies: ctx.cp.tasks.checkDependencies(task_id),
        artifacts: ctx.cp.artifacts.list(task_id).map((a) => ({
          artifact_id: a.artifact_id,
          name: a.name,
          kind: a.kind,
          bytes: a.bytes,
          sha256: a.sha256,
        })),
        latest_status: ctx.cp.tasks.latestStatus(task_id) ?? null,
        deliverable: ctx.cp.deliverables.get(task_id) ?? null,
        verifications: ctx.cp.deliverables.listVerifications(task_id),
        attempts: ctx.cp.attempts.list(task_id),
        telemetry: ctx.cp.attempts.queryTelemetry({ task_id }),
      };
    },
  },
  {
    name: "bridge_set_execution_handle",
    title: "Save a resumable execution handle",
    description:
      "Persist an opaque pointer to this attempt's resumable session (a Codex thread id, a " +
      "Claude session id). Call it as soon as the session exists so a crash leaves something " +
      "to resume from. Never pass secrets, credentials, or conversation content — the " +
      "coordination database is shared with the other agent.",
    inputShape: {
      task_id: z.string(),
      execution_handle: z
        .string()
        .min(1)
        .describe("Opaque session/thread identifier. Max 512 printable ASCII characters."),
      attempt: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Defaults to the task's current attempt."),
      ...agentArg,
    },
    handler: (args, ctx) => {
      const task_id = args["task_id"] as string;
      const task = ctx.cp.tasks.get(task_id);
      const attempt = (args["attempt"] as number | undefined) ?? task.attempt;
      const record = ctx.cp.attempts.saveHandle(
        task_id,
        attempt,
        who(args, ctx),
        args["execution_handle"] as string,
      );
      return { task_id, attempt: record.attempt, saved: true, updated_at: record.updated_at };
    },
  },
  {
    name: "bridge_get_execution_handle",
    title: "Read a resumable execution handle",
    description:
      "Fetch the execution handle saved for an attempt, so a restarted agent can reconnect " +
      "to the session it was using instead of starting the task from cold. The handle may be " +
      "stale; treat a failed resume as a normal cold start.",
    inputShape: {
      task_id: z.string(),
      attempt: z.number().int().min(0).optional().describe("Defaults to the task's current attempt."),
    },
    handler: (args, ctx) => {
      const task_id = args["task_id"] as string;
      const task = ctx.cp.tasks.get(task_id);
      const attempt = (args["attempt"] as number | undefined) ?? task.attempt;
      const record = ctx.cp.attempts.get(task_id, attempt);
      return {
        task_id,
        attempt,
        execution_handle: record?.execution_handle ?? null,
        previous_execution_handle: ctx.cp.attempts.previousHandle(task_id, attempt),
      };
    },
  },
  {
    name: "bridge_resume_task",
    title: "Resume an existing stranded task",
    description:
      "Atomically create a new attempt for a recoverable task owned by this caller, reacquire " +
      "its persisted scope, and strictly resume its stored runtime session. Task identity, " +
      "lineage, owner, objective, scope, and execution handle come only from durable state; " +
      "this operation never creates a task or accepts replacement identity fields.",
    inputShape: {
      task_id: z.string(),
      ...idemArg,
    },
    handler: (args, ctx) =>
      ctx.orchestrator.resumeTask({
        task_id: args["task_id"] as string,
        requested_by: ctx.defaultAgent,
        ...(args["idempotency_key"]
          ? { idempotency_key: args["idempotency_key"] as string }
          : {}),
      }),
  },
  {
    name: "bridge_claim_task",
    title: "Claim ownership of a task",
    description:
      "Take ownership of an unowned task. Fails with NOT_OWNER if another agent already owns it. " +
      "Claiming does not grant write access — acquire a lease as well.",
    inputShape: { task_id: z.string(), ...agentArg, ...idemArg },
    handler: (args, ctx) => {
      const task = ctx.cp.tasks.claim(
        args["task_id"] as string,
        who(args, ctx),
        args["idempotency_key"] as string | undefined,
      );
      return { task_id: task.task_id, state: task.state, owner: task.owner };
    },
  },
  {
    name: "bridge_acquire_lease",
    title: "Acquire a write-scope lease",
    description:
      "Reserve exclusive write access to a set of path globs before editing files. Fails with " +
      "SCOPE_CONFLICT (listing the holder) if another agent is writing there. Leases expire, so a " +
      "crashed agent cannot block the scope forever.",
    inputShape: {
      task_id: z.string(),
      scope: writeScopeShape,
      ttl_ms: z.number().int().min(1000).default(900_000),
      ...agentArg,
    },
    handler: (args, ctx) => {
      const lease = ctx.cp.leases.acquire({
        task_id: args["task_id"] as string,
        holder: who(args, ctx),
        scope: args["scope"] as { paths: string[] },
        ttl_ms: (args["ttl_ms"] as number | undefined) ?? 900_000,
      });
      return {
        lease_id: lease.lease_id,
        expires_at: lease.expires_at,
        paths: lease.scope.paths,
      };
    },
  },
  {
    name: "bridge_check_scope",
    title: "Check whether a scope is free",
    description:
      "Non-mutating conflict check. Use before planning work to see whether the other agent is " +
      "already writing in the files you need.",
    inputShape: { scope: writeScopeShape, ...agentArg },
    handler: (args, ctx) => {
      const conflicts = ctx.cp.leases.findConflicts(
        args["scope"] as { paths: string[] },
        who(args, ctx),
      );
      return { free: conflicts.length === 0, conflicts };
    },
  },
  {
    name: "bridge_renew_lease",
    title: "Extend a lease",
    description: "Push back a lease's expiry during long work. Cannot revive an expired lease.",
    inputShape: { lease_id: z.string(), ttl_ms: z.number().int().min(1000), ...agentArg },
    handler: (args, ctx) => {
      const lease = ctx.cp.leases.renew(
        args["lease_id"] as string,
        who(args, ctx),
        args["ttl_ms"] as number,
      );
      return { lease_id: lease.lease_id, expires_at: lease.expires_at };
    },
  },
  {
    name: "bridge_release_lease",
    title: "Release a lease",
    description: "Free a write scope for the other agent. Safe to call twice.",
    inputShape: { lease_id: z.string(), ...agentArg },
    handler: (args, ctx) => {
      const lease = ctx.cp.leases.release(args["lease_id"] as string, who(args, ctx));
      return { lease_id: lease.lease_id, state: lease.state };
    },
  },
  {
    name: "bridge_set_state",
    title: "Change task state",
    description:
      "Move a task you own through the lifecycle: CLAIMED -> WORKING -> VERIFYING -> DONE, or to " +
      "BLOCKED/FAILED/CANCELLED. Entering WORKING is refused while dependencies are unsatisfied.",
    inputShape: {
      task_id: z.string(),
      to: z.enum(["CLAIMED", "WORKING", "BLOCKED", "VERIFYING", "DONE", "FAILED", "CANCELLED"]),
      reason: z.string().optional(),
      ...agentArg,
      ...idemArg,
    },
    handler: (args, ctx) => {
      const task = ctx.cp.tasks.transition({
        task_id: args["task_id"] as string,
        agent: who(args, ctx),
        to: args["to"] as TaskState,
        ...(args["reason"] ? { reason: args["reason"] as string } : {}),
        ...(args["idempotency_key"] ? { idempotency_key: args["idempotency_key"] as string } : {}),
      });
      return { task_id: task.task_id, state: task.state };
    },
  },
  {
    name: "bridge_report_status",
    title: "Report progress",
    description:
      "Publish a progress update an external supervisor can observe. Use at meaningful " +
      "milestones only — not for trivial internal steps.",
    inputShape: {
      task_id: z.string(),
      current_action: z.string(),
      next_action: z.string(),
      progress: z.number().min(0).max(1).nullable().optional(),
      ...agentArg,
    },
    handler: (args, ctx) => {
      const task_id = args["task_id"] as string;
      const task = ctx.cp.tasks.get(task_id);
      ctx.cp.tasks.reportStatus({
        task_id,
        agent: who(args, ctx),
        state: task.state,
        current_action: args["current_action"] as string,
        owned_scope: task.spec.scope.paths,
        progress: (args["progress"] as number | null | undefined) ?? null,
        artifacts: ctx.cp.artifacts.list(task_id).map((a) => a.artifact_id),
        blockers: task.blockers,
        next_action: args["next_action"] as string,
        at: ctx.cp.clock.now(),
      });
      return { ok: true };
    },
  },
  {
    name: "bridge_publish_artifact",
    title: "Publish an artifact",
    description:
      "Share a result as an artifact rather than pasting it into conversation. Provide either " +
      "inline content (small) or a repo-relative path. Content is hashed so consumers can detect drift.",
    inputShape: {
      task_id: z.string(),
      name: z.string(),
      kind: z.enum(["file", "diff", "log", "report", "test_result", "json"]).default("report"),
      inline: z.string().optional(),
      path: z.string().optional().describe("Repo-relative path. Mutually exclusive with 'inline'."),
      metadata: z.record(z.unknown()).optional(),
      ...agentArg,
    },
    handler: (args, ctx) => {
      const a = ctx.cp.artifacts.publish({
        task_id: args["task_id"] as string,
        produced_by: who(args, ctx),
        kind: (args["kind"] as "report") ?? "report",
        name: args["name"] as string,
        ...(args["inline"] !== undefined ? { inline: args["inline"] as string } : {}),
        ...(args["path"] !== undefined ? { path: args["path"] as string } : {}),
        ...(args["metadata"] ? { metadata: args["metadata"] as Record<string, unknown> } : {}),
      });
      return { artifact_id: a.artifact_id, sha256: a.sha256, bytes: a.bytes };
    },
  },
  {
    name: "bridge_read_artifact",
    title: "Read an artifact",
    description: "Fetch an artifact's content and metadata by id, with an integrity check.",
    inputShape: { artifact_id: z.string() },
    handler: (args, ctx) => {
      const id = args["artifact_id"] as string;
      const a = ctx.cp.artifacts.get(id);
      return {
        artifact: {
          artifact_id: a.artifact_id,
          task_id: a.task_id,
          name: a.name,
          kind: a.kind,
          media_type: a.media_type,
          bytes: a.bytes,
          sha256: a.sha256,
          produced_by: a.produced_by,
        },
        integrity: ctx.cp.artifacts.verifyIntegrity(id),
        content: ctx.cp.artifacts.read(id),
      };
    },
  },
  {
    name: "bridge_record_verification",
    title: "Record verification evidence",
    description:
      "Record a check that ACTUALLY RAN, with its real exit code. A task cannot be completed " +
      "without at least one passing check. Do not record a check you did not execute.",
    inputShape: { task_id: z.string(), result: verificationShape, ...agentArg },
    handler: (args, ctx) => {
      ctx.cp.deliverables.recordVerification(
        args["task_id"] as string,
        who(args, ctx),
        args["result"] as VerificationResult,
      );
      return { ok: true };
    },
  },
  {
    name: "bridge_submit_deliverable",
    title: "Submit the final deliverable",
    description:
      "Hand back the structured result and move the task to its terminal state. COMPLETE requires " +
      "at least one passing verification and no failing ones; otherwise submit PARTIAL or FAILED.",
    inputShape: {
      task_id: z.string(),
      status: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
      summary: z.string().min(1),
      changed_scope: z.array(z.string()).default([]),
      artifacts: z.array(z.string()).default([]),
      commit_or_diff: z.string().nullable().default(null),
      verification_results: z.array(verificationShape).default([]),
      remaining_risks: z.array(z.string()).default([]),
      recommended_next_action: z.string().default("review the artifacts"),
      ...agentArg,
    },
    handler: (args, ctx) => {
      const task_id = args["task_id"] as string;
      const deliverable: Deliverable = {
        task_id,
        agent: who(args, ctx),
        status: args["status"] as DeliverableStatus,
        summary: args["summary"] as string,
        changed_scope: (args["changed_scope"] as string[]) ?? [],
        artifacts: (args["artifacts"] as string[]) ?? [],
        commit_or_diff: (args["commit_or_diff"] as string | null) ?? null,
        verification_performed: ((args["verification_results"] as VerificationResult[]) ?? []).map(
          (v) => v.command,
        ),
        verification_results: (args["verification_results"] as VerificationResult[]) ?? [],
        remaining_risks: (args["remaining_risks"] as string[]) ?? [],
        dependencies_unblocked: ctx.cp.store.getDependents(task_id),
        recommended_next_action: (args["recommended_next_action"] as string) ?? "review the artifacts",
        at: ctx.cp.clock.now(),
      };
      const submitted = ctx.cp.deliverables.submit(deliverable);
      return {
        task_id,
        status: submitted.status,
        state: ctx.cp.tasks.get(task_id).state,
        dependencies_unblocked: submitted.dependencies_unblocked,
      };
    },
  },
  {
    name: "bridge_block_task",
    title: "Raise a blocker",
    description:
      "Escalate instead of guessing or working around another agent's scope. Moves the task to " +
      "BLOCKED with a recorded reason.",
    inputShape: { task_id: z.string(), reason: z.string().min(1), ...agentArg },
    handler: (args, ctx) => {
      const task = ctx.cp.tasks.block(
        args["task_id"] as string,
        who(args, ctx),
        args["reason"] as string,
      );
      return { task_id: task.task_id, state: task.state, blockers: task.blockers };
    },
  },
  {
    name: "bridge_add_dependency",
    title: "Declare a dependency",
    description:
      "Record that one task must wait for another. Cycles are rejected, so dependencies cannot " +
      "deadlock the two agents against each other.",
    inputShape: { task_id: z.string(), depends_on: z.string(), ...agentArg },
    handler: (args, ctx) => {
      const task = ctx.cp.tasks.addDependency(
        args["task_id"] as string,
        args["depends_on"] as string,
        who(args, ctx),
      );
      return { task_id: task.task_id, dependencies: task.spec.dependencies };
    },
  },
  {
    name: "bridge_delegate",
    title: "Delegate a task to another agent",
    description:
      "Hand a bounded task to another agent and wait for its deliverable. Requires a deadline, " +
      "which is what prevents open-ended agent-to-agent loops. Inputs are passed as artifact ids, " +
      "not conversation history.",
    inputShape: {
      to: z.string().describe("Target agent id, e.g. 'codex'."),
      spec: taskSpecShape,
      input_artifacts: z.array(z.string()).default([]),
      deadline_ms: z.number().int().min(1000).max(86_400_000),
      max_attempts: z.number().int().min(0).max(5).default(0),
      ...lineageArgs,
      ...agentArg,
      ...idemArg,
    },
    handler: async (args, ctx) => {
      if (ctx.delegationPolicy === "deny") {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          "delegation is denied by this server's startup policy",
          { policy: "deny", caller: ctx.defaultAgent, target: args["to"] },
        );
      }
      const outcome = await ctx.orchestrator.delegate({
        from: who(args, ctx),
        to: args["to"] as string,
        spec: args["spec"] as TaskSpec,
        ...(args["run_id"] ? { run_id: args["run_id"] as string } : {}),
        ...(args["parent_task_id"] !== undefined
          ? { parent_task_id: args["parent_task_id"] as string | null }
          : {}),
        ...(args["delegation_depth"] !== undefined
          ? { delegation_depth: args["delegation_depth"] as number }
          : {}),
        input_artifacts: (args["input_artifacts"] as string[]) ?? [],
        deadline_ms: args["deadline_ms"] as number,
        max_attempts: (args["max_attempts"] as number) ?? 0,
        ...(args["idempotency_key"] ? { idempotency_key: args["idempotency_key"] as string } : {}),
      });
      return outcome;
    },
  },
  {
    name: "bridge_query_telemetry",
    title: "Query normalized attempt telemetry",
    description:
      "Read final neutral telemetry records by run, task, agent, or attempt. Records never " +
      "contain raw prompts, conversation history, authentication data, or execution handles.",
    inputShape: {
      run_id: z.string().optional(),
      task_id: z.string().optional(),
      agent: z.string().optional(),
      attempt: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    handler: (args, ctx) => {
      // `agent` is a read filter here, not a caller assertion. Native callers may inspect
      // the opposite runtime's exported telemetry without impersonating it.
      const records = ctx.cp.attempts.queryTelemetry({
        ...(args["run_id"] ? { run_id: args["run_id"] as string } : {}),
        ...(args["task_id"] ? { task_id: args["task_id"] as string } : {}),
        ...(args["agent"] ? { agent: args["agent"] as string } : {}),
        ...(args["attempt"] !== undefined ? { attempt: args["attempt"] as number } : {}),
        limit: (args["limit"] as number | undefined) ?? 100,
      });
      return { count: records.length, records };
    },
  },
  {
    name: "bridge_snapshot",
    title: "Coordination snapshot",
    description:
      "One-shot view of the whole system: task counts by state, ready tasks, live leases and their " +
      "holders, registered adapters. The cheapest way to answer 'what is the other agent doing?'.",
    inputShape: {},
    handler: (_args, ctx) => ctx.cp.snapshot(),
  },
  {
    name: "bridge_read_events",
    title: "Tail the event log",
    description:
      "Read the append-only event log, optionally after a given event_id. This is the supervisor " +
      "feed: poll with the last id you saw to stream progress.",
    inputShape: {
      after: z.number().int().min(0).optional(),
      task_id: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    handler: (args, ctx) => {
      const events = ctx.cp.events({
        ...(args["after"] !== undefined ? { after: args["after"] as number } : {}),
        ...(args["task_id"] ? { task_id: args["task_id"] as string } : {}),
        limit: (args["limit"] as number) ?? 100,
      });
      return { events, last_event_id: ctx.cp.lastEventId() };
    },
  },
  {
    name: "bridge_recover",
    title: "Run crash recovery",
    description:
      "Expire leases whose holder went away and report tasks left mid-flight. Does not auto-fail " +
      "or auto-retry anything — recovery decisions stay explicit.",
    inputShape: {},
    handler: (_args, ctx) => ctx.cp.recover(),
  },
];

/** Wrap a handler result in the MCP content envelope, converting errors to structured JSON. */
export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await tool.handler(args, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const bridgeErr = BridgeError.from(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: bridgeErr.toJSON() }, null, 2) }],
      isError: true,
    };
  }
}
