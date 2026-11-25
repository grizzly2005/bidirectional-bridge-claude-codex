import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BridgeError, ErrorCode, type MemoryNote, type MemoryScopeSummary, type ProjectResumeCard } from "@bridge/protocol";
import type { ArtifactRegistry } from "./artifact-registry.js";
import type { MemoryService } from "./memory-service.js";
import type { StateStore } from "./store/state-store.js";

export interface ProjectResumeInput {
  readonly namespace?: "development" | "bug-bounty";
  readonly context_id?: string;
  readonly branch?: string | null;
  readonly max_bytes?: number;
  readonly max_items_per_section?: number;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max)
    throw new BridgeError(ErrorCode.INVALID_ARGUMENT, `${name} must be an integer from ${min} to ${max}`);
  return selected;
}
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** A bounded projection over one selected database, with no artifact bodies or runtime handles. */
export class ResumeService {
  constructor(
    private readonly store: StateStore,
    private readonly memory: MemoryService,
    private readonly artifacts: ArtifactRegistry,
    private readonly workspaceRoot: string,
  ) {}

  getProjectResume(input: ProjectResumeInput = {}): ProjectResumeCard {
    const budget = bounded(input.max_bytes, 16384, 2048, 65536, "max_bytes");
    const limit = bounded(input.max_items_per_section, 10, 1, 25, "max_items_per_section");
    if (input.namespace !== undefined && !["development", "bug-bounty"].includes(input.namespace))
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "Invalid namespace");
    if (input.context_id !== undefined && (typeof input.context_id !== "string" || !input.context_id.trim()))
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "context_id must be a nonblank string");
    if (input.branch !== undefined && input.branch !== null && (typeof input.branch !== "string" || !input.branch.trim()))
      throw new BridgeError(ErrorCode.INVALID_ARGUMENT, "branch must be a nonblank string or null");

    const root = canonical(this.workspaceRoot);
    const databasePath = this.store.databasePath();
    const database_path = databasePath === ":memory:" ? databasePath : canonical(databasePath);
    const workspace_id = createHash("sha256").update(`bridge-workspace-v1\0${root}\0${database_path}`).digest("hex").slice(0, 16);

    const snapshot = this.store.transaction(() => {
      const head = this.store.lastEventId();
      const allScopes = this.store.listMemoryScopes().filter(({ scope }) =>
        (input.namespace === undefined || scope.namespace === input.namespace) &&
        (input.context_id === undefined || scope.context_id === input.context_id) &&
        (input.branch === undefined || scope.branch === input.branch));
      const notes: MemoryNote[] = [];
      for (const { scope, active_note_count } of allScopes) {
        if (!active_note_count) continue;
        notes.push(...this.store.listMemoryNotes({ scope, before_cursor: head, lifecycles: ["active"], limit: active_note_count }));
        if (notes.length >= limit * 6) break;
      }
      const tasks = this.store.listTasks();
      const quarantined = this.store.listHeldLeases().filter(lease => lease.state === "QUARANTINED").length;
      return { head, allScopes, notes, tasks, quarantined };
    });

    const { head, allScopes, notes, tasks, quarantined } = snapshot;
    notes.sort((a, b) => b.change_cursor - a.change_cursor);

    type Decision = ProjectResumeCard["decisions"][number];
    type Result = ProjectResumeCard["verified_results"][number];
    type Unverified = ProjectResumeCard["unverified_observations"][number];
    type OpenTask = ProjectResumeCard["open_tasks"][number];
    type Action = ProjectResumeCard["next_actions"]["items"][number];
    type Abandoned = ProjectResumeCard["next_actions"]["abandoned_tracks"][number];
    const shownScopes: MemoryScopeSummary[] = [...allScopes];
    const decisions: Decision[] = [];
    const verified_results: Result[] = [];
    const unverified_observations: Unverified[] = [];
    const open_tasks: OpenTask[] = [];
    const actions: Action[] = [];
    const abandoned: Abandoned[] = [];
    const omitted = { scopes: 0, decisions: 0, verified_results: 0, unverified_observations: 0, open_tasks: 0, next_actions: 0 };

    const verifiedTaskIds = new Set<string>();
    const verifiedTasks: Array<{ at: number; value: Result }> = [];
    const sortedTasks = [...tasks].sort((a, b) => b.updated_at - a.updated_at || a.task_id.localeCompare(b.task_id));
    for (const task of sortedTasks) {
      if (task.state === "PENDING" || task.state === "CLAIMED" || task.state === "WORKING" || task.state === "VERIFYING" || task.state === "BLOCKED") {
        open_tasks.push({ task_id: task.task_id, state: task.state, owner: task.owner, delegation_depth: task.delegation_depth,
          objective: task.spec.objective, blockers: task.blockers.map(message => ({ code: "BLOCKED", message })), updated_at: task.updated_at });
      }
      const deliverable = this.store.getDeliverable(task.task_id);
      if (task.state !== "DONE" && !(task.state === "BLOCKED" && deliverable?.status === "PARTIAL")) continue;
      const checks = deliverable ? deliverable.verification_results : this.store.listVerifications(task.task_id);
      if (!checks.some(check => check.passed && (check.kind === "manual" || check.exit_code === 0)) || checks.some(check => !check.passed)) continue;
      verifiedTaskIds.add(task.task_id);
      if (verifiedTasks.length >= limit * 2) continue;
      const artifactIds = deliverable ? deliverable.artifacts : this.store.listArtifacts(task.task_id).map(artifact => artifact.artifact_id);
      const intact_artifacts = artifactIds.flatMap(id => {
        const artifact = this.store.getArtifact(id);
        return artifact && this.artifacts.verifyIntegrity(id).intact
          ? [{ artifact_id: id, name: artifact.name, sha256: artifact.sha256, produced_by: artifact.produced_by }] : [];
      });
      verifiedTasks.push({ at: deliverable?.at ?? task.updated_at, value: {
        source: "task", task_id: task.task_id, state: task.state, author: deliverable?.agent ?? task.owner,
        summary: deliverable?.summary ?? task.spec.objective, changed_scope: deliverable?.changed_scope ?? [],
        checks: checks.filter(check => check.passed && (check.kind === "manual" || check.exit_code === 0))
          .map(({ kind, command, exit_code, summary }) => ({ kind, command, exit_code, summary })), intact_artifacts,
      } });
    }

    const verifiedNotes: Array<{ at: number; value: Result }> = [];
    for (const note of notes) {
      const read = this.memory.readNote(note);
      const base = { scope: note.scope, key: note.key, revision: note.revision, title: note.title,
        summary: note.summary, recorded_by: read.recorded_by, contributed_by: read.contributed_by ?? null,
        resolved_authors: read.resolved_authors };
      if (note.kind === "decision" || note.kind === "context") {
        decisions.push({ ...base, kind: note.kind, reference_states: read.reference_states, at: note.at });
      } else if (note.kind === "observation") {
        const degraded = read.reference_states.find(state => state.status !== "intact");
        const proven = !degraded && ((note.references.length > 0 && read.reference_states.every(state => state.status === "intact")) ||
          note.related_task_ids.some(id => verifiedTaskIds.has(id)));
        if (proven) verifiedNotes.push({ at: note.at, value: { source: "note", ...base,
          references: note.references, related_task_ids: note.related_task_ids } });
        else unverified_observations.push({ ...base, unverified_reason: degraded?.status ?? "no_canonical_proof" });
      } else if (note.kind === "next-action") {
        actions.push({ scope: note.scope, key: note.key, revision: note.revision, title: note.title,
          summary: note.summary, recorded_by: read.recorded_by, resolved_authors: read.resolved_authors,
          related_task_ids: note.related_task_ids });
      } else if (note.kind === "abandoned-track") {
        abandoned.push({ title: note.title, summary: note.summary, abandonment: note.abandonment });
      }
    }
    verified_results.push(...[...verifiedTasks, ...verifiedNotes].sort((a, b) => b.at - a.at).map(row => row.value));
    const recommendation = () => actions.length ? `${actions[0]!.title}: ${actions[0]!.summary}`.slice(0, 400)
      : open_tasks.length ? `Resume/complete ${open_tasks[0]!.task_id} (${open_tasks[0]!.state}): ${open_tasks[0]!.objective}`.slice(0, 400)
      : "Aucune action en attente enregistrée";
    const next_actions = { items: actions, abandoned_tracks: abandoned, recommended_next_action: recommendation() };

    const cap = (rows: unknown[], section: keyof typeof omitted, sectionLimit = limit) => {
      if (rows.length > sectionLimit) { omitted[section] += rows.length - sectionLimit; rows.splice(sectionLimit); }
    };
    cap(shownScopes, "scopes", Math.max(limit * 2, 20));
    cap(decisions, "decisions");
    cap(verified_results, "verified_results");
    cap(unverified_observations, "unverified_observations");
    cap(open_tasks, "open_tasks");
    while (actions.length + abandoned.length > limit) {
      if (abandoned.length) abandoned.pop(); else actions.pop();
      omitted.next_actions++;
    }
    next_actions.recommended_next_action = recommendation();

    const card: ProjectResumeCard = {
      project: { project_name: basename(root), workspace_root: root, database_path, workspace_id,
        schema_version: this.store.schemaVersion(), head_cursor: head, scopes: shownScopes,
        quarantined_leases_count: quarantined },
      decisions, verified_results, unverified_observations, open_tasks,
      next_actions, omitted,
    };

    const minimalSize = bytes({
      project: { ...card.project, scopes: [] },
      decisions: [], verified_results: [], unverified_observations: [], open_tasks: [],
      next_actions: { items: [], abandoned_tracks: [], recommended_next_action: "Aucune action en attente enregistrée" },
      omitted,
    });
    if (minimalSize > budget) throw new BridgeError(ErrorCode.INVALID_ARGUMENT,
      "The project resume envelope exceeds max_bytes; increase the budget", { minimum_bytes: minimalSize, max_bytes: budget });

    // Balanced eviction: trim the largest collection first; on equal length, drop lower-signal
    // metadata (unverified observations, extra scopes, abandoned tracks) before core resume
    // pillars (open_tasks, decisions, verified_results, next_actions).
    while (bytes(card) > budget) {
      const choices = ([
        { rows: unverified_observations as unknown[], section: "unverified_observations" as const, priority: 1 },
        { rows: shownScopes as unknown[], section: "scopes" as const, priority: 2 },
        { rows: abandoned as unknown[], section: "next_actions" as const, priority: 3 },
        { rows: open_tasks as unknown[], section: "open_tasks" as const, priority: 4 },
        { rows: decisions as unknown[], section: "decisions" as const, priority: 5 },
        { rows: verified_results as unknown[], section: "verified_results" as const, priority: 6 },
        { rows: actions as unknown[], section: "next_actions" as const, priority: 7 },
      ]).filter(choice => choice.rows.length > 0)
       .sort((a, b) => b.rows.length - a.rows.length || a.priority - b.priority);
      const target = choices[0];
      if (!target) throw new BridgeError(ErrorCode.INTERNAL, "Project resume budget invariant failed");
      target.rows.pop();
      omitted[target.section]++;
      next_actions.recommended_next_action = recommendation();
    }
    return card;
  }
}
