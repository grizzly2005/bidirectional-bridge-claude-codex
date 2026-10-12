import { createHash } from "node:crypto";
import { DEFAULT_INLINE_ARTIFACT_BYTES, DEFAULT_INLINE_CHUNK_BYTES, splitUtf8, BridgeError, ErrorCode,
  type ArtifactId, type InvocationContext } from "@bridge/protocol";
import type { CodexArtifactDraft } from "./prompt.js";

/** A publication failure after a valid runtime result is recoverable partial business work. */
export class ArtifactOutputPublicationError extends BridgeError {
  constructor(error: unknown, sequence: number, parts: number) {
    const source = BridgeError.from(error);
    super(ErrorCode.ADAPTER_FAILURE, `Output publication incomplete (${source.code}); missing part/manifest ${sequence} of ${parts}: ${source.message}`,
      { reason: "artifact_output_publication", source_code: source.code, missing_sequence: sequence, total_parts: parts });
  }
}

async function publishPart(ctx: InvocationContext, draft: Parameters<InvocationContext["publishArtifact"]>[0],
  sequence: number, total: number): Promise<ArtifactId> {
  try { return await ctx.publishArtifact(draft); }
  catch (error) {
    const recoverablePublication: readonly string[] = [ErrorCode.INVALID_ARGUMENT, ErrorCode.INTERNAL, ErrorCode.ADAPTER_FAILURE];
    if (error instanceof BridgeError && !recoverablePublication.includes(error.code)) throw error;
    throw new ArtifactOutputPublicationError(error, sequence, total);
  }
}

/** Preserve oversized inline output using ordinary artifacts and a self-contained manifest. */
export async function publishCodexArtifact(draft: CodexArtifactDraft, ctx: InvocationContext,
  published: ArtifactId[]): Promise<void> {
  const limit = ctx.max_inline_artifact_bytes ?? DEFAULT_INLINE_ARTIFACT_BYTES;
  if (draft.inline === undefined || Buffer.byteLength(draft.inline, "utf8") <= limit) {
    published.push(await ctx.publishArtifact(draft));
    return;
  }
  const text = draft.inline;
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const chunks = splitUtf8(text, Math.min(limit, DEFAULT_INLINE_CHUNK_BYTES));
  const base = draft.name.slice(0, 440);
  const parts: Array<{ artifact_id: ArtifactId; sequence: number; bytes: number; sha256: string }> = [];
  for (const [index, inline] of chunks.entries()) {
    const id = await publishPart(ctx, { kind: "file",
      name: `${base}.part-${String(index + 1).padStart(3, "0")}-of-${chunks.length}.txt`,
      media_type: "text/plain; charset=utf-8", inline,
      metadata: { source: "codex-inline-fragment", complete_sha256: sha256, sequence: index + 1,
        total_parts: chunks.length, original_kind: draft.kind, original_media_type: draft.media_type } }, index + 1, chunks.length + 1);
    published.push(id);
    parts.push({ artifact_id: id, sequence: index + 1, bytes: Buffer.byteLength(inline, "utf8"),
      sha256: createHash("sha256").update(inline, "utf8").digest("hex") });
  }
  const manifest = { schema_version: 1, type: "bridge-inline-artifact-manifest", encoding: "utf-8",
    original: { kind: draft.kind, name: draft.name, media_type: draft.media_type,
      bytes: Buffer.byteLength(text, "utf8"), sha256, ...(draft.metadata ? { metadata: draft.metadata } : {}) },
    parts };
  published.push(await publishPart(ctx, { kind: "json", name: `${base}.manifest.json`,
    media_type: "application/json", inline: JSON.stringify(manifest),
    metadata: { source: "codex-inline-manifest", complete_sha256: sha256 } }, chunks.length + 1, chunks.length + 1));
}
