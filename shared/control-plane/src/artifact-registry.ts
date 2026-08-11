/**
 * Artifact registry — how agents exchange results instead of chat history.
 *
 * Small payloads are stored inline; anything above `inlineLimitBytes` must live on disk and
 * be referenced by repo-relative path. Content is always hashed, so a consumer can tell
 * whether an artifact it already read has changed, and two agents producing identical
 * output are visibly identical rather than merely similar.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ArtifactSchema,
  BridgeError,
  ErrorCode,
  EventType,
  assertValid,
  newArtifactId,
  normalizePath,
  type AgentId,
  type Artifact,
  type ArtifactId,
  type ArtifactKind,
  type RandomSource,
  type TaskId,
} from "@bridge/protocol";
import type { Clock } from "./clock.js";
import type { StateStore } from "./store/state-store.js";

export interface PublishArtifactInput {
  readonly task_id: TaskId;
  readonly produced_by: AgentId;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly media_type?: string;
  /** Provide exactly one of `inline` or `path`. */
  readonly inline?: string;
  /** Repo-relative path; the file must exist under `workspace_root`. */
  readonly path?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ArtifactRegistryOptions {
  readonly workspaceRoot: string;
  /** Above this size an inline payload is rejected in favour of a file. Default 64 KiB. */
  readonly inlineLimitBytes?: number;
}

const DEFAULT_INLINE_LIMIT = 64 * 1024;

export class ArtifactRegistry {
  private readonly workspaceRoot: string;
  private readonly inlineLimit: number;

  constructor(
    private readonly store: StateStore,
    private readonly clock: Clock,
    options: ArtifactRegistryOptions,
    private readonly rng?: RandomSource,
  ) {
    this.workspaceRoot = options.workspaceRoot;
    this.inlineLimit = options.inlineLimitBytes ?? DEFAULT_INLINE_LIMIT;
  }

  publish(input: PublishArtifactInput): Artifact {
    if ((input.inline === undefined) === (input.path === undefined)) {
      throw new BridgeError(
        ErrorCode.INVALID_ARGUMENT,
        "provide exactly one of 'inline' or 'path'",
        { name: input.name },
      );
    }

    let bytes: number;
    let sha256: string;
    let relPath: string | undefined;

    if (input.inline !== undefined) {
      const buf = Buffer.from(input.inline, "utf8");
      if (buf.byteLength > this.inlineLimit) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          `inline artifact is ${buf.byteLength} bytes, over the ${this.inlineLimit} limit; ` +
            `write it to a file and publish it by path`,
          { name: input.name, bytes: buf.byteLength },
        );
      }
      bytes = buf.byteLength;
      sha256 = createHash("sha256").update(buf).digest("hex");
    } else {
      relPath = normalizePath(input.path!);
      if (isAbsolute(input.path!)) {
        throw new BridgeError(
          ErrorCode.INVALID_ARGUMENT,
          "artifact path must be repo-relative so the reference survives a different checkout",
          { path: input.path },
        );
      }
      const abs = join(this.workspaceRoot, relPath);
      let content: Buffer;
      try {
        content = readFileSync(abs);
        bytes = statSync(abs).size;
      } catch (err) {
        throw new BridgeError(
          ErrorCode.NOT_FOUND,
          `artifact file not readable: ${relPath}`,
          { path: relPath, cause: (err as Error).message },
        );
      }
      sha256 = createHash("sha256").update(content).digest("hex");
    }

    const now = this.clock.now();
    const artifact: Artifact = {
      artifact_id: newArtifactId(this.rng),
      task_id: input.task_id,
      kind: input.kind,
      name: input.name,
      media_type: input.media_type ?? inferMediaType(input.name, input.kind),
      ...(relPath ? { path: relPath } : {}),
      ...(input.inline !== undefined ? { inline: input.inline } : {}),
      sha256,
      bytes,
      produced_by: input.produced_by,
      created_at: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    assertValid<Artifact>(artifact, ArtifactSchema, "Artifact");

    return this.store.transaction(() => {
      this.store.insertArtifact(artifact);
      this.store.appendEvent(
        {
          type: EventType.ARTIFACT_PUBLISHED,
          task_id: input.task_id,
          agent: input.produced_by,
          payload: {
            artifact_id: artifact.artifact_id,
            kind: artifact.kind,
            name: artifact.name,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
          },
        },
        now,
      );
      return artifact;
    });
  }

  get(id: ArtifactId): Artifact {
    const a = this.store.getArtifact(id);
    if (!a) throw new BridgeError(ErrorCode.NOT_FOUND, `no such artifact ${id}`, { artifact_id: id });
    return a;
  }

  resolveMany(ids: readonly ArtifactId[]): Artifact[] {
    return ids.map((id) => this.get(id));
  }

  list(task_id: TaskId): Artifact[] {
    return this.store.listArtifacts(task_id);
  }

  /** Read an artifact's content, whether it is inline or on disk. */
  read(id: ArtifactId): string {
    const a = this.get(id);
    if (a.inline !== undefined) return a.inline;
    if (!a.path) {
      throw new BridgeError(ErrorCode.INTERNAL, `artifact ${id} has neither inline content nor a path`);
    }
    return readFileSync(join(this.workspaceRoot, a.path), "utf8");
  }

  /** Has the on-disk content drifted from what was recorded at publish time? */
  verifyIntegrity(id: ArtifactId): { intact: boolean; expected: string; actual: string | null } {
    const a = this.get(id);
    if (a.inline !== undefined) {
      const actual = createHash("sha256").update(Buffer.from(a.inline, "utf8")).digest("hex");
      return { intact: actual === a.sha256, expected: a.sha256, actual };
    }
    try {
      const actual = createHash("sha256")
        .update(readFileSync(join(this.workspaceRoot, a.path!)))
        .digest("hex");
      return { intact: actual === a.sha256, expected: a.sha256, actual };
    } catch {
      return { intact: false, expected: a.sha256, actual: null };
    }
  }
}

function inferMediaType(name: string, kind: ArtifactKind): string {
  if (kind === "diff") return "text/x-diff";
  if (kind === "json") return "application/json";
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "json": return "application/json";
    case "md": return "text/markdown";
    case "ts": case "tsx": return "text/typescript";
    case "js": case "mjs": return "text/javascript";
    case "html": return "text/html";
    case "csv": return "text/csv";
    case "patch": case "diff": return "text/x-diff";
    default: return "text/plain";
  }
}
