import { describe, expect, it } from "vitest";
import {
  cleanLabel, normalizeSnapshot, normalizeObservation, mergeSnapshot, chooseSelection, getFreshness,
  shouldAnimate, describeTask, attemptLabel, knownMetric, graphLayout, normalizeHistory, mergeHistory, pollingDelay, hasActiveTasks,
} from "./tracking-state.mjs";
import { textElement } from "./tracking-ui.mjs";

const task = (changes = {}) => ({
  task_id: "root-1", run_id: "run-1", parent_task_id: null, delegation_depth: 0,
  owner: "codex", title: "Manager", state: "WORKING", business_status: null,
  execution_phase: "RUNNING", runtime_stop_confirmed: null, cancel_requested: false, attempt: 0,
  observation: null, created_at: 100, updated_at: 500, verification: { passed: 0, failed: 0 }, ...changes,
});
const snapshot = (changes = {}) => ({
  schema_version: 1, workspace_ref: "workspace-hash", workspace_label: "Bridge", view_id: "view-1",
  run_id: "run-1", snapshot_event_id: 5, next_cursor: "cursor-5", has_more: false,
  observed_at: 1000, stale_after_ms: 6000, tasks: [task()], attempts: [], links: [], truncated: false, ...changes,
});

describe("tracking projection and display boundaries", () => {
  it("drops private and unsupported fields even inside attempts and observations", () => {
    const raw = snapshot({
      prompt: "secret-prompt", transcript: "secret-transcript", execution_handle: "secret-handle",
      tasks: [task({ prompt: "secret-task", execution_handle: "secret-handle", scope: { paths: ["secret-path"] } })],
      attempts: [{ task_id: "root-1", attempt: 0, agent: "codex", started_at: 1, ended_at: null,
        resumed_from_attempt: null, outcome: null, observation: { status: "INCOMPLETE", accepted: false,
          strict_required: false, category: "storage", transcript: "secret-transcript" },
        telemetry: { input_tokens: 0, output_tokens: null, total_tokens: 22, turn_count: 3, turns: 900, raw_output: "secret-output", execution_handle: "secret-handle" },
        execution_handle: "secret-handle", prompt: "secret-prompt" }],
    });
    const normalized = normalizeSnapshot(raw);
    expect(JSON.stringify(normalized)).not.toContain("secret-");
    expect(normalized.attempts[0].telemetry.input_tokens).toBe(0);
    expect(normalized.attempts[0].telemetry.output_tokens).toBeNull();
    expect(normalized.attempts[0].telemetry.runtime_duration_ms).toBeNull();
    expect(normalized.attempts[0].telemetry.turn_count).toBe(3);
    expect(normalized.attempts[0].telemetry).not.toHaveProperty("turns");
  });

  it("renders hostile labels as inert text and removes deceptive bidi controls", () => {
    const payload = '<img src=x onerror="globalThis.compromised=true"><script>alert(1)</script>';
    const label = normalizeSnapshot(snapshot({ tasks: [task({ title: payload })] })).tasks[0].title;
    let writtenText = "";
    const document = {
      createElement(tag: string) {
        expect(tag).toBe("span");
        return {
          set textContent(value: string) { writtenText = value; },
          set innerHTML(_value: string) { throw new Error("HTML interpolation is forbidden"); },
        };
      },
    };
    textElement(document, "span", label);
    expect(writtenText).toBe(payload);
    expect(cleanLabel("a\u202eb\u0000 c\n d")).toBe("a b c d");
    expect(cleanLabel("🤝".repeat(10), "", 4)).toBe("🤝🤝🤝…");
  });

  it("keeps complete business output independent from missing strict observations", () => {
    const description = describeTask(task({ state: "DONE", business_status: "COMPLETE",
      observation: { status: "INCOMPLETE", accepted: false, strict_required: true }, execution_phase: "STOPPED", runtime_stop_confirmed: true }));
    expect(description.state).toBe("Terminée");
    expect(description.business).toEqual({ label: "Résultat complet", tone: "success" });
    expect(description.observation).toEqual({ label: "Mesures incomplètes · requises", tone: "warning" });
    expect(description.execution.label).toBe("Arrêt confirmé");
  });

  it("never treats a rejected or inconsistent observation as accepted", () => {
    expect(normalizeObservation({ status: "REJECTED", accepted: true, strict_required: false }).accepted).toBe(false);
    expect(normalizeObservation({ status: "COMPLETE", accepted: false, strict_required: true }).accepted).toBe(false);
    expect(describeTask(task({ observation: { status: "REJECTED", accepted: false, strict_required: false } })).observation.tone).toBe("danger");
  });

  it("distinguishes an annotation of cancellation from a confirmed runtime stop", () => {
    const requested = describeTask(task({ cancel_requested: true }));
    expect(requested.execution.label).toContain("arrêt attendu");
    expect(describeTask(task({ state: "CANCELLED", execution_phase: "QUARANTINED", runtime_stop_confirmed: false })).execution)
      .toEqual({ label: "Arrêt non confirmé · ressources réservées", tone: "warning" });
    expect(describeTask(task({ execution_phase: "STOPPED", runtime_stop_confirmed: false })).execution.label).toBe("Arrêt non attesté");
  });

  it("requires fresh known running state for animated graph edges", () => {
    const current = normalizeSnapshot(snapshot());
    const fresh = getFreshness(current, 1200);
    expect(shouldAnimate(current.tasks[0], fresh)).toBe(true);
    expect(shouldAnimate(current.tasks[0], fresh, { reducedMotion: true })).toBe(false);
    for (const options of [{ connected: false }, { visible: false }]) {
      expect(shouldAnimate(current.tasks[0], getFreshness(current, 1200, options))).toBe(false);
    }
    expect(shouldAnimate(current.tasks[0], getFreshness(current, 7000))).toBe(false);
    expect(shouldAnimate(task({ execution_phase: "QUARANTINED" }), fresh)).toBe(false);
    expect(shouldAnimate(task({ state: "BLOCKED" }), fresh)).toBe(false);
    expect(shouldAnimate(task({ execution_phase: null }), fresh)).toBe(false);
  });

  it("stops animation at the freshness boundary and for a future server clock", () => {
    const current = normalizeSnapshot(snapshot());
    expect(getFreshness(current, 6999).kind).toBe("fresh");
    expect(getFreshness(current, 7000).kind).toBe("stale");
    expect(getFreshness(normalizeSnapshot(snapshot({ observed_at: 20_000 })), 1000).kind).toBe("stale");
  });

  it("labels a retry and a durable resume differently, including resume from attempt zero", () => {
    expect(attemptLabel({ attempt: 0, resumed_from_attempt: null })).toBe("Tentative 1 · initiale");
    expect(attemptLabel({ attempt: 1, resumed_from_attempt: null })).toBe("Tentative 2 · nouvelle tentative");
    expect(attemptLabel({ attempt: 1, resumed_from_attempt: 0 })).toBe("Tentative 2 · reprise de la tentative 1");
  });

  it("keeps unknown metrics distinct from measured zero without inventing totals", () => {
    expect(knownMetric(null)).toBe("Non mesuré");
    expect(knownMetric(undefined)).toBe("Non mesuré");
    expect(knownMetric(-1)).toBe("Non mesuré");
    expect(knownMetric(0, "ms")).toBe("0 ms");
    const attempt = normalizeSnapshot(snapshot({ attempts: [{ task_id: "root-1", attempt: 0, agent: "codex",
      started_at: 1, ended_at: 5, resumed_from_attempt: null, outcome: "COMPLETE", observation: null,
      telemetry: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: null } }] })).attempts[0];
    expect(attempt.telemetry.total_tokens).toBeNull();
    expect(attempt.telemetry.input_tokens).toBe(100);
  });

  it("fails closed for unsupported schemas and cross-view data", () => {
    expect(() => normalizeSnapshot(snapshot({ schema_version: 2 }))).toThrow("format");
    expect(() => normalizeSnapshot(snapshot({ snapshot_event_id: -1 }))).toThrow("format");
    const current = normalizeSnapshot(snapshot());
    expect(() => mergeSnapshot(current, snapshot({ workspace_ref: "other-workspace" }))).toThrow("autre vue");
    expect(() => mergeSnapshot(current, snapshot({ view_id: "other-view" }))).toThrow("autre vue");
  });

  it("replaces full snapshots, ignores older observations, and switches runs only explicitly", () => {
    const child = task({ task_id: "child-1", parent_task_id: "root-1", delegation_depth: 1 });
    const current = normalizeSnapshot(snapshot({ tasks: [task(), child] }));
    expect(mergeSnapshot(current, snapshot({ snapshot_event_id: 4, observed_at: 2000 }))).toBe(current);
    expect(mergeSnapshot(current, snapshot({ snapshot_event_id: 4, observed_at: 2000 }), { allowEventReset: true }).snapshot_event_id).toBe(4);
    expect(mergeSnapshot(current, snapshot({ observed_at: 999 }))).toBe(current);
    expect(mergeSnapshot(current, snapshot({ snapshot_event_id: 6 })).tasks).toHaveLength(1);
    expect(mergeSnapshot(current, snapshot({ run_id: "run-2", tasks: [task({ run_id: "run-2" })] }))).toBe(current);
    expect(mergeSnapshot(current, snapshot({ run_id: "run-2", tasks: [task({ run_id: "run-2" })] }), { allowRunChange: true }).run_id).toBe("run-2");
  });

  it("preserves selection on state refresh and returns to the root when a task disappears", () => {
    const tasks = [task(), task({ task_id: "child-1", delegation_depth: 1 })];
    expect(chooseSelection(tasks, "child-1")).toBe("child-1");
    expect(chooseSelection([task()], "child-1")).toBe("root-1");
    expect(chooseSelection([], "child-1")).toBeNull();
  });

  it("deduplicates tasks and keeps only resolvable delegation links", () => {
    const current = normalizeSnapshot(snapshot({
      tasks: [task({ updated_at: 10, title: "Old" }), task({ updated_at: 20, title: "New" }),
        task({ task_id: "child", delegation_depth: 1 }), task({ task_id: "bad\nidentifier" })],
      links: [{ from: "root-1", to: "child", kind: "delegation" }, { from: "root-1", to: "child", kind: "delegation" },
        { from: "root-1", to: "root-1", kind: "delegation" }, { from: "root-1", to: "missing", kind: "delegation" },
        { from: "child", to: "root-1", kind: "secret-relationship" }],
    }));
    expect(current.tasks).toHaveLength(2);
    expect(current.tasks.find((value: any) => value.task_id === "root-1").title).toBe("New");
    expect(current.links).toEqual([{ from: "root-1", to: "child", kind: "delegation" }]);
  });

  it("lays out delegation depth deterministically when the reader order changes", () => {
    const tasks = [task({ task_id: "second", delegation_depth: 1, created_at: 5 }),
      task({ task_id: "first", delegation_depth: 1, created_at: 4 }), task()];
    expect(graphLayout(tasks)).toEqual(graphLayout([...tasks].reverse()));
    expect(graphLayout(tasks)).toMatchObject({ columns: 2, rows: 2,
      items: [{ task_id: "root-1", column: 0, row: 0 }, { task_id: "first", column: 1, row: 0 }, { task_id: "second", column: 1, row: 1 }] });
    expect(graphLayout([task({ delegation_depth: 3 })]).columns).toBe(1);
  });

  it("bounds pathological projections and explicitly marks them as truncated", () => {
    const current = normalizeSnapshot(snapshot({ tasks: Array.from({ length: 501 }, (_, index) => task({ task_id: `task-${index}` })) }));
    expect(current.tasks).toHaveLength(500);
    expect(current.truncated).toBe(true);
  });

  it("merges history pages by session without dropping legitimate updates", () => {
    const item = { run_id: "run-1", created_at: 1, updated_at: 2, task_count: 2, active_count: 1, root_task_id: "root-1", title: "Earlier" };
    const page = normalizeHistory({ schema_version: 1, workspace_ref: "workspace-hash",
      items: [item, { ...item, run_id: "run-2", title: "Later", updated_at: 3, prompt: "secret-prompt" }],
      next_page_token: "opaque-page", has_more: true });
    expect(page.next_page_token).toBe("opaque-page");
    expect(JSON.stringify(page)).not.toContain("secret-prompt");
    expect(mergeHistory(page.items, [{ ...item, title: "Updated", updated_at: 4 }])).toEqual([
      { ...item, title: "Updated", updated_at: 4 }, page.items[1],
    ]);
  });

  it("uses a bounded retry delay and yields after a finite event catch-up burst", () => {
    expect(pollingDelay()).toBe(2000);
    expect(pollingDelay({ failures: 1 })).toBe(2000);
    expect(pollingDelay({ failures: 2 })).toBe(4000);
    expect(pollingDelay({ failures: 30, random: 1 })).toBe(30_000);
    expect(pollingDelay({ failures: 1, random: 0 })).toBe(2000);
    expect(pollingDelay({ hasMore: true, catchupPages: 4 })).toBe(100);
    expect(pollingDelay({ hasMore: true, catchupPages: 5 })).toBe(2000);
    expect(pollingDelay({ active: false })).toBe(15_000);
    expect(pollingDelay({ active: false, random: 0 })).toBe(12_000);
    expect(pollingDelay({ active: false, random: 1 })).toBe(18_000);
  });

  it("keeps queued work active and slows down only settled or stopped blocked work", () => {
    expect(hasActiveTasks({ tasks: [] })).toBe(false);
    expect(hasActiveTasks({ tasks: [task({ state: "PENDING", execution_phase: null })] })).toBe(true);
    expect(hasActiveTasks({ tasks: [task({ state: "BLOCKED", execution_phase: "QUEUED" })] })).toBe(true);
    expect(hasActiveTasks({ tasks: [task({ state: "DONE", execution_phase: "STOPPED" })] })).toBe(false);
    expect(hasActiveTasks({ tasks: [task({ state: "BLOCKED", execution_phase: "STOPPED" })] })).toBe(false);
    expect(hasActiveTasks({ tasks: [task({ state: "BLOCKED", execution_phase: "QUARANTINED" })] })).toBe(false);
  });
});
