import type { AgentId, ArtifactId, RunId, TaskId } from "./ids.js";

/** Workspace identity is the selected bridge database; contexts never mix implicitly. */
export interface MemoryScope {
  readonly namespace: "development" | "bug-bounty";
  readonly context_id: string;
  readonly branch: string | null;
  readonly application_version: string | null;
  readonly epoch: string | null;
}
export type MemoryLifecycle = "active" | "superseded" | "archived";
export type MemoryKind = "context" | "decision" | "observation" | "next-action" | "abandoned-track";
export interface MemoryArtifactReference {
  readonly artifact_id: ArtifactId;
  readonly sha256: string;
  readonly record_type?: string;
  readonly record_id?: string;
  readonly source_revision?: string;
  readonly source_epoch?: string;
}
export interface MemoryNoteDraft {
  /** Canonical worker attribution, verified against referenced bridge state at write time. */
  readonly contributed_by?: AgentId | null;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly summary: string;
  readonly lifecycle: MemoryLifecycle;
  readonly references: readonly MemoryArtifactReference[];
  readonly related_task_ids: readonly TaskId[];
  readonly abandonment: {
    readonly reason: string;
    readonly tested_conditions: string;
    readonly reopen_when: string;
  } | null;
}
/** An immutable revision; no finding verdict, session token or transcript field. */
export interface MemoryNote extends MemoryNoteDraft {
  readonly schema_version: 1;
  readonly scope: MemoryScope;
  readonly key: string;
  readonly revision: number;
  readonly change_cursor: number;
  readonly at: number;
  readonly provenance: {
    readonly agent: AgentId;
    readonly task_id: TaskId;
    readonly run_id: RunId;
    readonly attempt: number;
  };
}
export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly active_note_count: number;
  readonly total_revisions: number;
  readonly latest_change_cursor: number;
}

export interface ProjectResumeCard {
  readonly project: {
    readonly project_name: string;
    readonly workspace_root: string;
    readonly database_path: string;
    readonly workspace_id: string;
    readonly schema_version: number;
    readonly head_cursor: number;
    readonly scopes: readonly MemoryScopeSummary[];
    readonly quarantined_leases_count: number;
  };
  readonly decisions: ReadonlyArray<{ scope: MemoryScope; key: string; revision: number; kind: MemoryKind; title: string; summary: string; recorded_by: AgentId; contributed_by: AgentId | null; resolved_authors: readonly AgentId[]; reference_states: readonly { artifact_id: ArtifactId; status: string }[]; at: number }>;
  readonly verified_results: ReadonlyArray<
    { source: "task"; task_id: TaskId; state: string; author: AgentId | null; summary: string; changed_scope: readonly string[]; checks: readonly { kind: string; command: string; exit_code: number | null; summary: string }[]; intact_artifacts: readonly { artifact_id: ArtifactId; name: string; sha256: string; produced_by: AgentId }[] } |
    { source: "note"; scope: MemoryScope; key: string; revision: number; title: string; summary: string; recorded_by: AgentId; contributed_by: AgentId | null; resolved_authors: readonly AgentId[]; references: readonly MemoryArtifactReference[]; related_task_ids: readonly TaskId[] }
  >;
  readonly unverified_observations: ReadonlyArray<{ scope: MemoryScope; key: string; revision: number; title: string; summary: string; recorded_by: AgentId; contributed_by: AgentId | null; resolved_authors: readonly AgentId[]; unverified_reason: string }>;
  readonly open_tasks: ReadonlyArray<{ task_id: TaskId; state: string; owner: AgentId | null; delegation_depth: number; objective: string; blockers: readonly { code: string; message: string }[]; updated_at: number }>;
  readonly next_actions: {
    readonly items: ReadonlyArray<{ scope: MemoryScope; key: string; revision: number; title: string; summary: string; recorded_by: AgentId; resolved_authors: readonly AgentId[]; related_task_ids: readonly TaskId[] }>;
    readonly abandoned_tracks: ReadonlyArray<{ title: string; summary: string; abandonment: MemoryNoteDraft["abandonment"] }>;
    readonly recommended_next_action: string;
  };
  readonly omitted: { scopes: number; decisions: number; verified_results: number; unverified_observations: number; open_tasks: number; next_actions: number };
}
/** Fixed-field serialization supplies a portable stable composite identity. */
export function memoryScopeKey(scope: MemoryScope): string {
  return JSON.stringify([scope.namespace, scope.context_id, scope.branch, scope.application_version, scope.epoch]);
}
export const MEMORY_MAX_NOTE_BYTES = 32 * 1024;
export const MEMORY_DEFAULT_CONTEXT_BYTES = 16 * 1024;
export const MEMORY_MAX_RESPONSE_BYTES = 64 * 1024;

const text = (maximum: number) => ({ type: "string" as const, minLength: 1, maxLength: maximum });
const nullableText = { anyOf: [text(256), { type: "null" as const }] };
export const MemoryScopeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    namespace: { enum: ["development", "bug-bounty"] }, context_id: text(128),
    branch: nullableText, application_version: nullableText, epoch: nullableText,
  }, required: ["namespace", "context_id", "branch", "application_version", "epoch"],
} as const;
export const MemoryNoteDraftSchema = {
  type: "object", additionalProperties: false,
  properties: {
    kind: { enum: ["context", "decision", "observation", "next-action", "abandoned-track"] },
    contributed_by: { anyOf: [{ enum: ["claude", "codex", "gemini"] }, { type: "null" }] },
    title: text(200), summary: text(2000), lifecycle: { enum: ["active", "superseded", "archived"] },
    references: {
      type: "array", maxItems: 16, items: {
        type: "object", additionalProperties: false,
        properties: {
          artifact_id: text(64), sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          record_type: text(64), record_id: text(256), source_revision: text(256), source_epoch: text(256),
        }, required: ["artifact_id", "sha256"],
      },
    },
    related_task_ids: { type: "array", maxItems: 8, items: text(64) },
    abandonment: { anyOf: [{ type: "null" }, {
      type: "object", additionalProperties: false,
      properties: { reason: text(1000), tested_conditions: text(1000), reopen_when: text(1000) },
      required: ["reason", "tested_conditions", "reopen_when"],
    }] },
  }, required: ["kind", "title", "summary", "lifecycle", "references", "related_task_ids", "abandonment"],
} as const;
