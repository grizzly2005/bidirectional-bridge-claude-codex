import { z } from "zod";
import { MEMORY_DEFAULT_CONTEXT_BYTES, MEMORY_MAX_RESPONSE_BYTES, type MemoryScope, type MemoryNoteDraft } from "@bridge/protocol";
import type { ToolDefinition } from "./tools.js";

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u);
const scope = z.object({
  namespace: z.enum(["development", "bug-bounty"]), context_id: z.string().min(1).max(128),
  branch: z.string().min(1).max(256).nullable().default(null),
  application_version: z.string().min(1).max(256).nullable().default(null),
  epoch: z.string().min(1).max(256).nullable().default(null),
}).strict();
const lifecycle = z.enum(["active", "superseded", "archived"]);
const reference = z.object({
  artifact_id: z.string().min(1).max(64), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  record_type: z.string().min(1).max(64).optional(), record_id: z.string().min(1).max(256).optional(),
  source_revision: z.string().min(1).max(256).optional(), source_epoch: z.string().min(1).max(256).optional(),
}).strict();
const note = z.object({
  kind: z.enum(["context", "decision", "observation", "next-action", "abandoned-track"]),
  title: z.string().min(1).max(200), summary: z.string().min(1).max(2000),
  lifecycle: lifecycle.default("active"), references: z.array(reference).max(16).default([]),
  related_task_ids: z.array(z.string().min(1).max(64)).max(8).default([]),
  abandonment: z.object({ reason: z.string().min(1).max(1000), tested_conditions: z.string().min(1).max(1000), reopen_when: z.string().min(1).max(1000) }).strict().nullable().default(null),
}).strict();
const budget = z.number().int().min(2048).max(MEMORY_MAX_RESPONSE_BYTES).default(MEMORY_DEFAULT_CONTEXT_BYTES);
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** No prompt injector or campaign writer: these operations are called on demand. */
export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "memory_upsert", title: "Write a shared working-memory revision",
    description: "Create with expected_revision=0 or replace the exact revision read. A stale revision returns REVISION_CONFLICT; reread and merge. Immutable history, lifecycle and artifact references persist. Requires the bound caller's WORKING/VERIFYING task; author/run/attempt are supplied by the server. This writes notes, never campaign evidence or a finding verdict.",
    inputShape: { scope, key, expected_revision: cursor, note, task_id: z.string().min(1), idempotency_key: z.string().min(1).max(200) },
    handler: (args, ctx) => ctx.cp.memory.upsert({ scope: args["scope"] as MemoryScope, key: args["key"] as string,
      expected_revision: args["expected_revision"] as number, note: args["note"] as MemoryNoteDraft,
      task_id: args["task_id"] as string, agent: ctx.defaultAgent, idempotency_key: args["idempotency_key"] as string }),
  },
  {
    name: "memory_get_context", title: "Read a bounded shared working context",
    description: "Load current notes and references only when useful. Exact namespace/context/branch/version/epoch scope; lifecycle defaults to active. No artifact bodies or transcripts are loaded. Page with next_key and the same at_cursor=change_cursor. Oversized whole notes are explicitly listed in omitted; request those keys with a larger max_bytes. Returned change_cursor marks the snapshot for subsequent get_changes, and pending_tasks contains referenced nonterminal task IDs/states.",
    inputShape: { scope, keys: z.array(key).min(1).max(100).optional(), lifecycles: z.array(lifecycle).min(1).max(3).default(["active"]),
      after_key: key.optional(), at_cursor: cursor.optional(), limit: z.number().int().min(1).max(50).default(20), max_bytes: budget },
    handler: (args, ctx) => ctx.cp.memory.getContext({ scope: args["scope"] as MemoryScope, keys: args["keys"] as string[] | undefined,
      lifecycles: args["lifecycles"] as ("active" | "superseded" | "archived")[], after_key: args["after_key"] as string | undefined,
      at_cursor: args["at_cursor"] as number | undefined, limit: args["limit"] as number, max_bytes: args["max_bytes"] as number }),
  },
  {
    name: "memory_get_changes", title: "Read shared-memory changes and history",
    description: "Retrieve immutable revisions strictly after change_cursor, including superseded/archived states. Start at 0 to recover history. Persist the returned change_cursor with its database and scope; never substitute head_cursor while has_more. Freeze a paginated scan with until_cursor=head_cursor. A whole change above max_bytes returns an explicit error and keeps the cursor unchanged. Read access does not require ownership of old author tasks.",
    inputShape: { scope, change_cursor: cursor.default(0), until_cursor: cursor.optional(), limit: z.number().int().min(1).max(100).default(25), max_bytes: budget },
    handler: (args, ctx) => ctx.cp.memory.getChanges({ scope: args["scope"] as MemoryScope, change_cursor: args["change_cursor"] as number,
      until_cursor: args["until_cursor"] as number | undefined, limit: args["limit"] as number, max_bytes: args["max_bytes"] as number }),
  },
];
