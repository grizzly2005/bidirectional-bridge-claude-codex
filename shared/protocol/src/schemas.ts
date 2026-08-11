/**
 * JSON Schemas for every message that crosses the bridge.
 *
 * These are the normative wire contract. TypeScript types in `types.ts` are the
 * ergonomic mirror; when they disagree, the schema wins, because Codex may be
 * validating against these schemas from a different toolchain.
 */

import {
  MAX_TASK_MAX_TURNS,
  MIN_TASK_MAX_TURNS,
} from "./types.js";
import type { JsonSchema } from "./validate.js";

const ISO_ID = (prefix: string): JsonSchema => ({
  type: "string",
  pattern: `^${prefix}[0-9a-hjkmnp-tv-z]{10}$`,
});

export const TaskIdSchema: JsonSchema = ISO_ID("task_");
export const RunIdSchema: JsonSchema = ISO_ID("run_");
export const LeaseIdSchema: JsonSchema = ISO_ID("lease_");
export const ArtifactIdSchema: JsonSchema = ISO_ID("art_");

export const AgentIdSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9._-]*$",
  description: "Lowercase agent identifier, e.g. 'claude', 'codex', 'supervisor'.",
};

export const WriteScopeSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/write-scope.json",
  title: "WriteScope",
  type: "object",
  required: ["paths"],
  additionalProperties: false,
  properties: {
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description: "Repo-relative glob patterns this agent intends to write.",
    },
    note: { type: "string", maxLength: 1024 },
  },
};

export const TaskSpecSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/task-spec.json",
  title: "TaskSpec",
  type: "object",
  required: ["objective", "scope", "dependencies", "expected_deliverable", "verification_criteria"],
  additionalProperties: false,
  properties: {
    objective: { type: "string", minLength: 1, maxLength: 2000 },
    scope: WriteScopeSchema,
    dependencies: { type: "array", items: TaskIdSchema, maxItems: 128 },
    expected_deliverable: { type: "string", minLength: 1, maxLength: 4000 },
    verification_criteria: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1000 },
      description: "At least one criterion is mandatory: a task with no definition of done is not delegatable.",
    },
    preferred_agent: AgentIdSchema,
    deadline_ms: { type: "integer", minimum: 1000, maximum: 86_400_000 },
    max_turns: {
      type: "integer",
      minimum: MIN_TASK_MAX_TURNS,
      maximum: MAX_TASK_MAX_TURNS,
      description: "Finite runtime turn ceiling; omitted tasks use the conservative runtime default.",
    },
    priority: { type: "integer", minimum: 0, maximum: 100 },
    tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
  },
};

export const TaskStateSchema: JsonSchema = {
  type: "string",
  enum: ["PENDING", "CLAIMED", "WORKING", "BLOCKED", "VERIFYING", "DONE", "FAILED", "CANCELLED"],
};

export const TaskSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/task.json",
  title: "Task",
  type: "object",
  required: [
    "task_id",
    "run_id",
    "parent_task_id",
    "delegation_depth",
    "spec",
    "state",
    "owner",
    "created_by",
    "created_at",
    "updated_at",
    "blockers",
    "version",
    "attempt",
  ],
  additionalProperties: false,
  properties: {
    task_id: TaskIdSchema,
    run_id: RunIdSchema,
    parent_task_id: { anyOf: [TaskIdSchema, { type: "null" }] },
    delegation_depth: { type: "integer", minimum: 0, maximum: 32 },
    spec: TaskSpecSchema,
    state: TaskStateSchema,
    owner: { anyOf: [AgentIdSchema, { type: "null" }] },
    created_by: AgentIdSchema,
    created_at: { type: "integer", minimum: 0 },
    updated_at: { type: "integer", minimum: 0 },
    claimed_at: { type: "integer", minimum: 0 },
    completed_at: { type: "integer", minimum: 0 },
    blockers: { type: "array", items: { type: "string", maxLength: 2000 } },
    version: { type: "integer", minimum: 1 },
    attempt: { type: "integer", minimum: 0 },
  },
};

export const VerificationResultSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/verification-result.json",
  title: "VerificationResult",
  type: "object",
  required: ["kind", "command", "passed", "exit_code", "summary"],
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["test", "typecheck", "build", "lint", "static_analysis", "benchmark", "manual"],
    },
    command: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description: "The exact command executed. Required so a supervisor can reproduce the claim.",
    },
    passed: { type: "boolean" },
    exit_code: { anyOf: [{ type: "integer" }, { type: "null" }] },
    summary: { type: "string", maxLength: 4000 },
    duration_ms: { type: "integer", minimum: 0 },
    output_excerpt: { type: "string", maxLength: 20000 },
    log_artifact_id: ArtifactIdSchema,
  },
};

export const ArtifactSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/artifact.json",
  title: "Artifact",
  type: "object",
  required: ["artifact_id", "task_id", "kind", "name", "media_type", "sha256", "bytes", "produced_by", "created_at"],
  additionalProperties: false,
  properties: {
    artifact_id: ArtifactIdSchema,
    task_id: TaskIdSchema,
    kind: { type: "string", enum: ["file", "diff", "log", "report", "test_result", "json"] },
    name: { type: "string", minLength: 1, maxLength: 512 },
    media_type: { type: "string", minLength: 1, maxLength: 255 },
    path: { type: "string", maxLength: 1024 },
    inline: { type: "string" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    bytes: { type: "integer", minimum: 0 },
    produced_by: AgentIdSchema,
    created_at: { type: "integer", minimum: 0 },
    metadata: { type: "object" },
  },
};

/**
 * An execution handle is a resumable pointer, not a payload. The length cap and the
 * character class are what keep transcripts and multi-line secrets out of the database:
 * control characters and newlines are rejected, so a pasted conversation cannot fit the
 * shape even before the length check applies.
 */
export const ExecutionHandleSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/execution-handle.json",
  title: "ExecutionHandle",
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[\\x20-\\x7E]+$",
  description:
    "Opaque agent-defined pointer to resumable execution state (e.g. a Codex thread id or " +
    "Claude session id). Must not contain secrets or conversation content.",
};

export const TaskAttemptSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/task-attempt.json",
  title: "TaskAttempt",
  type: "object",
  required: [
    "task_id",
    "attempt",
    "agent",
    "resumed_from_attempt",
    "execution_handle",
    "started_at",
    "updated_at",
  ],
  additionalProperties: false,
  properties: {
    task_id: TaskIdSchema,
    attempt: { type: "integer", minimum: 0 },
    agent: AgentIdSchema,
    resumed_from_attempt: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    execution_handle: { anyOf: [ExecutionHandleSchema, { type: "null" }] },
    started_at: { type: "integer", minimum: 0 },
    updated_at: { type: "integer", minimum: 0 },
    ended_at: { type: "integer", minimum: 0 },
    outcome: { type: "string", maxLength: 64 },
  },
};

const nullableNonNegativeInteger: JsonSchema = {
  anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
};

const nullableString = (maxLength: number): JsonSchema => ({
  anyOf: [{ type: "string", minLength: 1, maxLength }, { type: "null" }],
});

export const AttemptTelemetrySchema: JsonSchema = {
  $id: "https://bridge.local/schemas/attempt-telemetry.json",
  title: "AttemptTelemetry",
  type: "object",
  additionalProperties: false,
  required: [
    "run_id",
    "task_id",
    "attempt",
    "resumed_from_attempt",
    "agent",
    "runtime",
    "runtime_version",
    "requested_model",
    "requested_effort",
    "model",
    "parent_task_id",
    "delegation_depth",
    "orchestration_started_at",
    "runtime_started_at",
    "first_output_at",
    "runtime_ended_at",
    "completed_at",
    "wall_duration_ms",
    "runtime_duration_ms",
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "total_tokens",
    "turn_count",
    "cumulative_session_tokens",
    "reported_cost_usd",
    "cost_semantics",
    "billing_mode_known",
    "prompt_bytes",
    "input_artifact_count",
    "input_artifact_bytes",
    "termination_kind",
    "process_exit_code",
  ],
  properties: {
    run_id: RunIdSchema,
    task_id: TaskIdSchema,
    attempt: { type: "integer", minimum: 0 },
    resumed_from_attempt: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    agent: AgentIdSchema,
    runtime: nullableString(128),
    runtime_version: nullableString(128),
    requested_model: nullableString(256),
    requested_effort: nullableString(64),
    model: nullableString(256),
    parent_task_id: { anyOf: [TaskIdSchema, { type: "null" }] },
    delegation_depth: { type: "integer", minimum: 0, maximum: 32 },
    orchestration_started_at: { type: "integer", minimum: 0 },
    runtime_started_at: nullableNonNegativeInteger,
    first_output_at: nullableNonNegativeInteger,
    runtime_ended_at: nullableNonNegativeInteger,
    completed_at: { type: "integer", minimum: 0 },
    wall_duration_ms: { type: "integer", minimum: 0 },
    runtime_duration_ms: nullableNonNegativeInteger,
    input_tokens: nullableNonNegativeInteger,
    output_tokens: nullableNonNegativeInteger,
    cached_input_tokens: nullableNonNegativeInteger,
    cache_creation_input_tokens: nullableNonNegativeInteger,
    total_tokens: nullableNonNegativeInteger,
    turn_count: nullableNonNegativeInteger,
    cumulative_session_tokens: nullableNonNegativeInteger,
    reported_cost_usd: {
      anyOf: [{ type: "number", minimum: 0 }, { type: "null" }],
    },
    cost_semantics: {
      type: "string",
      enum: ["billed", "runtime_reported", "api_equivalent_estimate", "unavailable"],
    },
    billing_mode_known: { type: "boolean" },
    prompt_bytes: nullableNonNegativeInteger,
    input_artifact_count: { type: "integer", minimum: 0 },
    input_artifact_bytes: { type: "integer", minimum: 0 },
    termination_kind: {
      type: "string",
      enum: ["completed", "failed", "cancelled", "timeout", "crash", "unknown"],
    },
    process_exit_code: { anyOf: [{ type: "integer" }, { type: "null" }] },
  },
};

export const StatusUpdateSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/status-update.json",
  title: "StatusUpdate",
  type: "object",
  required: ["task_id", "agent", "state", "current_action", "owned_scope", "progress", "artifacts", "blockers", "next_action", "at"],
  additionalProperties: false,
  properties: {
    task_id: TaskIdSchema,
    agent: AgentIdSchema,
    state: TaskStateSchema,
    current_action: { type: "string", minLength: 1, maxLength: 2000 },
    owned_scope: { type: "array", items: { type: "string", maxLength: 512 } },
    progress: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
    artifacts: { type: "array", items: ArtifactIdSchema },
    blockers: { type: "array", items: { type: "string", maxLength: 2000 } },
    next_action: { type: "string", maxLength: 2000 },
    at: { type: "integer", minimum: 0 },
  },
};

export const DeliverableSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/deliverable.json",
  title: "Deliverable",
  type: "object",
  required: [
    "task_id", "agent", "status", "summary", "changed_scope", "artifacts",
    "commit_or_diff", "verification_performed", "verification_results",
    "remaining_risks", "dependencies_unblocked", "recommended_next_action", "at",
  ],
  additionalProperties: false,
  properties: {
    task_id: TaskIdSchema,
    agent: AgentIdSchema,
    status: { type: "string", enum: ["COMPLETE", "PARTIAL", "FAILED"] },
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    changed_scope: { type: "array", items: { type: "string", maxLength: 512 } },
    artifacts: { type: "array", items: ArtifactIdSchema },
    commit_or_diff: { anyOf: [{ type: "string", maxLength: 4000 }, { type: "null" }] },
    verification_performed: { type: "array", items: { type: "string", maxLength: 2000 } },
    verification_results: { type: "array", items: VerificationResultSchema },
    remaining_risks: { type: "array", items: { type: "string", maxLength: 2000 } },
    dependencies_unblocked: { type: "array", items: TaskIdSchema },
    recommended_next_action: { type: "string", maxLength: 2000 },
    at: { type: "integer", minimum: 0 },
  },
};

export const DelegationRequestSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/delegation-request.json",
  title: "DelegationRequest",
  type: "object",
  required: ["from", "to", "spec", "input_artifacts", "deadline_ms"],
  additionalProperties: false,
  properties: {
    from: AgentIdSchema,
    to: AgentIdSchema,
    run_id: RunIdSchema,
    parent_task_id: { anyOf: [TaskIdSchema, { type: "null" }] },
    delegation_depth: { type: "integer", minimum: 0, maximum: 32 },
    spec: TaskSpecSchema,
    input_artifacts: { type: "array", items: ArtifactIdSchema, maxItems: 128 },
    deadline_ms: {
      type: "integer",
      minimum: 1000,
      maximum: 86_400_000,
      description: "Hard stop. A delegation without a deadline would allow an open-ended agent loop.",
    },
    max_attempts: { type: "integer", minimum: 0, maximum: 5 },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  },
};

export const LeaseRequestSchema: JsonSchema = {
  $id: "https://bridge.local/schemas/lease-request.json",
  title: "LeaseRequest",
  type: "object",
  required: ["task_id", "holder", "scope", "ttl_ms"],
  additionalProperties: false,
  properties: {
    task_id: TaskIdSchema,
    holder: AgentIdSchema,
    scope: WriteScopeSchema,
    ttl_ms: { type: "integer", minimum: 1000, maximum: 86_400_000 },
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  },
};

/** Every schema, keyed by title, for registry-style lookup and doc generation. */
export const SCHEMAS = {
  WriteScope: WriteScopeSchema,
  TaskSpec: TaskSpecSchema,
  Task: TaskSchema,
  TaskAttempt: TaskAttemptSchema,
  AttemptTelemetry: AttemptTelemetrySchema,
  ExecutionHandle: ExecutionHandleSchema,
  Artifact: ArtifactSchema,
  VerificationResult: VerificationResultSchema,
  StatusUpdate: StatusUpdateSchema,
  Deliverable: DeliverableSchema,
  DelegationRequest: DelegationRequestSchema,
  LeaseRequest: LeaseRequestSchema,
} as const satisfies Record<string, JsonSchema>;

export type SchemaName = keyof typeof SCHEMAS;
