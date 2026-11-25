import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, ManualClock } from "./index.js";
import { ErrorCode, seededRandom, type MemoryNoteDraft, type MemoryScope, type Task } from "@bridge/protocol";

const base: MemoryScope = { namespace: "development", context_id: "BELIEF", branch: null, application_version: null, epoch: null };
const draft = (kind: MemoryNoteDraft["kind"], title: string, extras: Partial<MemoryNoteDraft> = {}): MemoryNoteDraft =>
  ({ kind, title, summary: `${title} summary`, lifecycle: "active", references: [], related_task_ids: [], abandonment: null, ...extras });
let cp: ControlPlane, clock: ManualClock, root: string, manager: Task;
const task = (plane: ControlPlane, agent: string, objective = "fixture task") => {
  const created = plane.tasks.create({ created_by: agent, spec: { objective, scope: { paths: ["(no-write)/**"] }, dependencies: [], expected_deliverable: "fixture", verification_criteria: ["fixture"] } });
  plane.tasks.claim(created.task_id, agent);
  return plane.tasks.transition({ task_id: created.task_id, agent, to: "WORKING" });
};
const note = (scope: MemoryScope, key: string, value: MemoryNoteDraft, expected_revision = 0) =>
  cp.memory.upsert({ scope, key, note: value, expected_revision, task_id: manager.task_id, agent: "gemini", idempotency_key: `${scope.context_id}:${scope.branch ?? "-"}:${scope.epoch ?? "-"}:${key}-${expected_revision}` });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bridge-resume-") ); clock = new ManualClock();
  cp = ControlPlane.open({ workspaceRoot: root, databasePath: join(root, "bridge.db"), clock, rng: seededRandom(166) });
  manager = task(cp, "gemini"); });
afterEach(() => { cp.close(); rmSync(root, { recursive: true, force: true }); });

describe("project resume from canonical state", () => {
  it("discovers branchless and named branch/epoch scopes from a cold call and never resurrects inactive revisions", () => {
    const branchA = { ...base, branch: "main", epoch: "e1" };
    const branchB = { ...base, branch: "feature", epoch: "e2" };
    note(base, "architecture", draft("decision", "Architecture"));
    note(branchA, "archived", draft("decision", "Old decision"));
    note(branchA, "archived", draft("decision", "Old decision", { lifecycle: "archived" }), 1);
    note(branchB, "action", draft("next-action", "Next step"));
    note(branchB, "action", draft("next-action", "Next step", { lifecycle: "superseded" }), 1);
    const card = cp.resume.getProjectResume({});
    expect(card.project.schema_version).toBe(6);
    expect(card.project.scopes).toHaveLength(3);
    expect(card.project.scopes.map(row => row.scope.branch)).toEqual(["feature", "main", null]);
    expect(card.project.scopes.map(row => [row.active_note_count, row.total_revisions])).toEqual([[0, 2], [0, 2], [1, 1]]);
    expect(card.decisions.map(row => row.key)).toEqual(["architecture"]);
    expect(card.next_actions.items).toEqual([]);
    expect(cp.resume.getProjectResume({ branch: null }).project.scopes.map(row => row.scope.branch)).toEqual([null]);
    expect(cp.resume.getProjectResume({ branch: "main" }).project.scopes.map(row => row.scope.branch)).toEqual(["main"]);
  });

  it("promotes only passing canonical checks or intact references and labels degraded observations", () => {
    const worker = task(cp, "claude", "worker objective");
    const good = cp.artifacts.publish({ task_id: worker.task_id, produced_by: "claude", kind: "report", name: "intact.txt", inline: "PRIVATE_PROOF_BODY_MARKER" });
    writeFileSync(join(root, "mutable.txt"), "original");
    const mutable = cp.artifacts.publish({ task_id: worker.task_id, produced_by: "claude", kind: "report", name: "mutable.txt", path: "mutable.txt" });
    note(base, "intact", draft("observation", "Intact source", { references: [{ artifact_id: good.artifact_id, sha256: good.sha256 }] }));
    note(base, "changed", draft("observation", "Changed source", { references: [{ artifact_id: mutable.artifact_id, sha256: mutable.sha256 }] }));
    note(base, "prose", draft("observation", "Prose only"));
    writeFileSync(join(root, "mutable.txt"), "changed");
    cp.deliverables.submit({ task_id: worker.task_id, agent: "claude", status: "COMPLETE", summary: "Worker verified",
      changed_scope: [], artifacts: [good.artifact_id], commit_or_diff: null, verification_performed: ["fixture"],
      verification_results: [{ kind: "manual", command: "fixture assertion", passed: true, exit_code: null, summary: "checked" }],
      remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: clock.now() });
    note(base, "task-backed", draft("observation", "Task backed", { related_task_ids: [worker.task_id], contributed_by: "claude" }));
    const card = cp.resume.getProjectResume({});
    expect(card.verified_results.map(row => row.source === "task" ? row.task_id : row.key)).toEqual(expect.arrayContaining([worker.task_id, "intact", "task-backed"]));
    expect(card.unverified_observations.map(row => [row.key, row.unverified_reason])).toEqual(expect.arrayContaining([["changed", "content-changed"], ["prose", "no_canonical_proof"]]));
    expect(JSON.stringify(card)).not.toContain("original");
    expect(JSON.stringify(card)).not.toContain("PRIVATE_PROOF_BODY_MARKER");
    expect(card.verified_results.find(row => row.source === "note" && row.key === "task-backed")).toMatchObject({ recorded_by: "gemini", contributed_by: "claude", resolved_authors: ["claude"] });
    expect(() => note(base, "forged", draft("decision", "Forged", { contributed_by: "codex" })))
      .toThrow(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
    expect(Buffer.byteLength(JSON.stringify(cp.resume.getProjectResume({ max_bytes: 2048 }), null, 2), "utf8")).toBeLessThanOrEqual(2048);
  });

  it("isolates homonymous workspaces, their databases, notes and open tasks", () => {
    const desktop = join(root, "Desktop", "nok"), documents = join(root, "Documents", "ChatGPT", "nok");
    mkdirSync(desktop, { recursive: true }); mkdirSync(documents, { recursive: true });
    const a = ControlPlane.open({ workspaceRoot: desktop, databasePath: join(desktop, "bridge.db"), rng: seededRandom(98) });
    const b = ControlPlane.open({ workspaceRoot: documents, databasePath: join(documents, "bridge.db"), rng: seededRandom(99) });
    try {
      const author = task(a, "gemini", "desktop task"); task(b, "codex", "documents task");
      a.memory.upsert({ scope: { ...base, context_id: "nok" }, key: "only-desktop", note: draft("decision", "Desktop choice"),
        expected_revision: 0, task_id: author.task_id, agent: "gemini", idempotency_key: "desktop" });
      const first = a.resume.getProjectResume({}), second = b.resume.getProjectResume({});
      expect(first.project.project_name).toBe("nok"); expect(second.project.project_name).toBe("nok");
      expect(first.project.workspace_id).not.toBe(second.project.workspace_id);
      expect(first.project.database_path).not.toBe(second.project.database_path);
      expect(first.decisions.map(row => row.key)).toEqual(["only-desktop"]); expect(second.decisions).toEqual([]);
      expect(first.open_tasks.map(row => row.objective)).toEqual(["desktop task"]);
      expect(second.open_tasks.map(row => row.objective)).toEqual(["documents task"]);
    } finally { a.close(); b.close(); }
  });

  it("caps large scope inventories (250+ scopes) and preserves verified results during byte eviction", () => {
    for (let i = 0; i < 250; i++) {
      note({ namespace: "bug-bounty", context_id: `ctx-${i}`, branch: `b-${i}`, application_version: null, epoch: `e-${i}` },
        "item", draft("decision", `Decision ${i}`, { summary: "x".repeat(120) }));
    }
    const worker = task(cp, "claude", "verified check task");
    cp.deliverables.submit({ task_id: worker.task_id, agent: "claude", status: "COMPLETE", summary: "Verified run",
      changed_scope: [], artifacts: [], commit_or_diff: null, verification_performed: ["npm test"],
      verification_results: [{ kind: "test", command: "npm test", passed: true, exit_code: 0, summary: "ok" }],
      remaining_risks: [], dependencies_unblocked: [], recommended_next_action: "none", at: clock.now() });
    note(base, "next-step", draft("next-action", "Ship release"));
    const ownDecision = note(base, "manager-own", draft("decision", "Manager decision citing worker", { related_task_ids: [worker.task_id] }));
    expect(cp.memory.readNote(ownDecision).resolved_authors).toContain("gemini");

    const defaultCard = cp.resume.getProjectResume({});
    expect(Buffer.byteLength(JSON.stringify(defaultCard, null, 2), "utf8")).toBeLessThanOrEqual(16384);
    expect(defaultCard.omitted.scopes).toBeGreaterThan(200);
    expect(defaultCard.verified_results.some(r => r.source === "task" && r.task_id === worker.task_id)).toBe(true);
    expect(defaultCard.next_actions.items.some(a => a.key === "next-step")).toBe(true);

    const tightCard = cp.resume.getProjectResume({ max_bytes: 2048 });
    expect(Buffer.byteLength(JSON.stringify(tightCard, null, 2), "utf8")).toBeLessThanOrEqual(2048);
    expect(tightCard.omitted.scopes).toBeGreaterThan(240);
  });
});
