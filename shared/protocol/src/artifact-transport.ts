import { invalidArgument } from "./errors.js";
import type { Artifact } from "./types.js";

/** Transport limits are independent: prompt characters versus stored UTF-8 bytes. */
export const MAX_INLINE_INPUT_CHARS = 100_000;
export const DEFAULT_INLINE_ARTIFACT_BYTES = 64 * 1024;
export const DEFAULT_INLINE_CHUNK_BYTES = 60 * 1024;

/** The same resolved input envelope is used by both native runtimes. Never truncate. */
export function artifactInputRecords(inputs: readonly Artifact[], runtime: string): object[] {
  const inlineChars = inputs.reduce((sum, artifact) => sum + (artifact.inline?.length ?? 0), 0);
  if (inlineChars > MAX_INLINE_INPUT_CHARS) {
    throw invalidArgument(`inline input artifacts exceed the ${runtime} prompt limit`, {
      inline_chars: inlineChars, maximum: MAX_INLINE_INPUT_CHARS,
    });
  }
  return inputs.map(artifact => ({
    artifact_id: artifact.artifact_id, kind: artifact.kind, name: artifact.name,
    media_type: artifact.media_type,
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.inline !== undefined ? { inline: artifact.inline } : {}),
    sha256: artifact.sha256, bytes: artifact.bytes,
    ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
  }));
}

/** Split only at code-point boundaries, respecting the byte budget (including Unicode). */
export function splitUtf8(value: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw invalidArgument("UTF-8 chunk budget must be an integer of at least four bytes");
  }
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0)!;
    if (scalar >= 0xd800 && scalar <= 0xdfff) {
      throw invalidArgument("inline artifact contains an unpaired Unicode surrogate");
    }
    const bytes = encoder.encode(codePoint).byteLength;
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current); current = ""; currentBytes = 0;
    }
    current += codePoint; currentBytes += bytes;
  }
  if (current || value.length === 0) chunks.push(current);
  return chunks;
}
