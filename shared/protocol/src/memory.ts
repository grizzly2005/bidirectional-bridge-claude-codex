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
