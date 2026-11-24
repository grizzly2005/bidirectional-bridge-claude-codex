/**
 * Persisted per-runtime model/effort preferences, shared by every native bridge process of
 * one workspace (Claude, Codex and Gemini callers) through a small JSON file next to the
 * control-plane database. Each delegation reads the file afresh, so a preference changed
 * from any manager applies to the next attempt without restarting a client.
 *
 * The file holds no credentials, prompts or handles: only runtime ids, slugs and audit
 * metadata. Writes are atomic (temporary file + rename) and bounded.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BridgeError, ErrorCode } from "@bridge/protocol";
import { assertEffort, assertModelSlug, type ModelPreference } from "./model-selection.js";

export const MODEL_PREFERENCES_FILE = "model-preferences.json";
const MAX_FILE_BYTES = 64 * 1024;
const RUNTIME_ID = /^[a-z][a-z0-9-]{0,31}$/u;

export interface StoredModelPreference extends ModelPreference {
  readonly updated_at: number;
  readonly updated_by: string;
}

interface PreferencesDocument {
  readonly schema_version: 1;
  readonly runtimes: Record<string, StoredModelPreference>;
}

export class ModelPreferenceStore {
  readonly path: string;

  /** `directory` is normally the directory of the control-plane database. */
  constructor(directory: string, private readonly now: () => number = () => Date.now()) {
    this.path = join(directory, MODEL_PREFERENCES_FILE);
  }

  static forDatabase(databasePath: string): ModelPreferenceStore {
    return new ModelPreferenceStore(dirname(databasePath));
  }

  /** All valid stored preferences. A missing file is an empty document. */
  readAll(): Record<string, StoredModelPreference> {
    let raw: string;
    try {
      if (statSync(this.path).size > MAX_FILE_BYTES) {
        throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "model preference file exceeds 64 KiB");
      }
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<PreferencesDocument>;
    if (parsed.schema_version !== 1 || !parsed.runtimes || typeof parsed.runtimes !== "object") {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "model preference file has an unsupported shape");
    }
    const result: Record<string, StoredModelPreference> = {};
    for (const [runtime, value] of Object.entries(parsed.runtimes)) {
      if (!RUNTIME_ID.test(runtime) || !value || typeof value !== "object") continue;
      try {
        result[runtime] = {
          model: assertModelSlug(value.model, "model"),
          effort: assertEffort(value.effort, "effort"),
          updated_at: Number.isSafeInteger(value.updated_at) ? value.updated_at : 0,
          updated_by: typeof value.updated_by === "string" && RUNTIME_ID.test(value.updated_by) ? value.updated_by : "unknown",
        };
      } catch {
        // A hand-edited invalid entry is ignored, never passed to a runtime CLI.
      }
    }
    return result;
  }

  get(runtime: string): StoredModelPreference | undefined {
    return this.readAll()[runtime];
  }

  /** A reader suitable for `resolveModelSelection`; failures degrade to runtime default. */
  reader(runtime: string): () => ModelPreference | undefined {
    return () => this.get(runtime);
  }

  /**
   * Set or clear one runtime's preference. `model`/`effort` `null` restores the runtime
   * default for that dimension; `undefined` keeps the current stored value.
   */
  set(runtime: string, update: { model?: string | null; effort?: string | null }, updatedBy: string): StoredModelPreference | null {
    if (!RUNTIME_ID.test(runtime)) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "runtime must be a lowercase agent id");
    if (!RUNTIME_ID.test(updatedBy)) throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "caller id is invalid");
    const all = this.readAll();
    const current = all[runtime];
    const model = update.model === undefined ? current?.model ?? null : assertModelSlug(update.model, "model");
    const effort = update.effort === undefined ? current?.effort ?? null : assertEffort(update.effort, "effort");
    const next: Record<string, StoredModelPreference> = { ...all };
    let stored: StoredModelPreference | null = null;
    if (model === null && effort === null) delete next[runtime];
    else next[runtime] = stored = { model, effort, updated_at: this.now(), updated_by: updatedBy };
    const document: PreferencesDocument = { schema_version: 1, runtimes: next };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "model preference file would exceed 64 KiB");
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${this.now()}.tmp`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    // Windows can briefly refuse a replace while another bridge process reads the file.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, this.path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    return stored;
  }
}
