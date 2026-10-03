// Browser-only projections of the versioned, already redacted tracking DTO.
// Keep every display value as text and copy only the explicitly supported fields.
export const TASK_STATES = Object.freeze({
  PENDING: "En attente", CLAIMED: "Attribuée", WORKING: "En cours",
  BLOCKED: "Bloquée", VERIFYING: "Vérification", DONE: "Terminée",
  FAILED: "Échec", CANCELLED: "Annulée",
});

const BUSINESS = { COMPLETE: "Résultat complet", PARTIAL: "Résultat partiel", FAILED: "Résultat en échec" };
const OBSERVATION = {
  PENDING: "Mesures en attente", COMPLETE: "Mesures complètes", INCOMPLETE: "Mesures incomplètes",
  REJECTED: "Mesures rejetées", LEGACY_UNKNOWN: "Mesures anciennes inconnues",
};
const PHASES = ["QUEUED", "RUNNING", "STOPPED", "QUARANTINED"];
const TELEMETRY_FIELDS = [
  "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "total_tokens",
  "turn_count", "wall_duration_ms", "attempt_wall_duration_ms", "runtime_duration_ms", "queue_duration_ms",
  "startup_duration_ms", "work_duration_ms", "seal_duration_ms", "delegation_elapsed_ms",
];

export function cleanLabel(value, fallback = "", maxLength = 120) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!text) return fallback;
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…` : text;
}

function id(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 180
    && !/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value) ? value : null;
}

function cursor(value) {
  return value === null || value === undefined ? null
    : typeof value === "string" && value.length > 0 && value.length <= 4096
      && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function count(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function timestamp(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function enumValue(value, values, fallback = null) {
  return values.includes(value) ? value : fallback;
}

export function normalizeObservation(value) {
  if (!value || typeof value !== "object") return null;
  const status = enumValue(value.status, Object.keys(OBSERVATION), "LEGACY_UNKNOWN");
  return {
    status, accepted: status === "COMPLETE" && value.accepted === true,
    strict_required: value.strict_required === true,
    category: cleanLabel(value.category, "", 60) || null,
  };
}

function normalizeTask(value) {
  if (!value || typeof value !== "object" || !id(value.task_id) || !id(value.run_id)) return null;
  return {
    task_id: id(value.task_id), run_id: id(value.run_id), parent_task_id: id(value.parent_task_id),
    delegation_depth: Math.min(16, count(value.delegation_depth)),
    owner: cleanLabel(value.owner, "", 64) || null,
    title: cleanLabel(value.title, "Délégation sans titre", 140),
    state: enumValue(value.state, Object.keys(TASK_STATES), "PENDING"),
    business_status: enumValue(value.business_status, Object.keys(BUSINESS)),
    execution_phase: enumValue(value.execution_phase, PHASES),
    runtime_stop_confirmed: typeof value.runtime_stop_confirmed === "boolean" ? value.runtime_stop_confirmed : null,
    cancel_requested: value.cancel_requested === true, attempt: count(value.attempt),
    observation: normalizeObservation(value.observation),
    created_at: timestamp(value.created_at), updated_at: timestamp(value.updated_at),
    verification: { passed: count(value.verification?.passed), failed: count(value.verification?.failed) },
  };
}

function normalizeAttempt(value) {
  if (!value || typeof value !== "object" || !id(value.task_id)) return null;
  const telemetry = value.telemetry && typeof value.telemetry === "object"
    ? Object.fromEntries(TELEMETRY_FIELDS.map((field) => [field, count(value.telemetry[field], null)])) : null;
  return {
    task_id: id(value.task_id), attempt: count(value.attempt), agent: cleanLabel(value.agent, "Agent inconnu", 64),
    resumed_from_attempt: count(value.resumed_from_attempt, null),
    started_at: timestamp(value.started_at), ended_at: timestamp(value.ended_at, null),
    outcome: cleanLabel(value.outcome, "", 64) || null,
    failure_category: enumValue(value.failure_category, ["quota", "auth", "transient", "profile", "contract", "turn_limit", "unknown"]),
    observation: normalizeObservation(value.observation), telemetry,
  };
}

export function normalizeSnapshot(value) {
  if (!value || value.schema_version !== 1 || !id(value.workspace_ref) || !id(value.view_id)
    || !Array.isArray(value.tasks) || !Array.isArray(value.attempts) || !Array.isArray(value.links)
    || !Number.isSafeInteger(value.snapshot_event_id) || value.snapshot_event_id < 0
    || !Number.isFinite(value.observed_at) || value.observed_at < 0
    || (value.run_id !== null && !id(value.run_id))) {
    throw new Error("Le format du suivi n’est pas compatible.");
  }
  const tasksById = new Map();
  for (const raw of value.tasks.slice(0, 500)) {
    const task = normalizeTask(raw);
    if (task && (!tasksById.has(task.task_id) || tasksById.get(task.task_id).updated_at <= task.updated_at)) {
      tasksById.set(task.task_id, task);
    }
  }
  const tasks = [...tasksById.values()].sort(compareTasks);
  const attempts = value.attempts.slice(0, 2000).map(normalizeAttempt).filter(Boolean)
    .filter((attempt) => tasksById.has(attempt.task_id))
    .sort((a, b) => a.attempt - b.attempt || a.started_at - b.started_at);
  const uniqueLinks = new Map();
  for (const link of value.links.slice(0, 1000)) {
    if (link?.kind === "delegation" && link.from !== link.to && tasksById.has(link.from) && tasksById.has(link.to)) {
      uniqueLinks.set(JSON.stringify([link.from, link.to]), { from: link.from, to: link.to, kind: "delegation" });
    }
  }
  return {
    schema_version: 1, workspace_ref: id(value.workspace_ref),
    workspace_label: cleanLabel(value.workspace_label, "Espace de travail", 80),
    view_id: id(value.view_id), run_id: id(value.run_id), snapshot_event_id: value.snapshot_event_id,
    next_cursor: cursor(value.next_cursor), has_more: value.has_more === true,
    observed_at: timestamp(value.observed_at), stale_after_ms: Math.min(60_000, Math.max(1000, count(value.stale_after_ms, 6000))),
    tasks, attempts, links: [...uniqueLinks.values()],
    truncated: value.truncated === true || value.tasks.length > 500 || value.attempts.length > 2000 || value.links.length > 1000,
  };
}

export function compareTasks(a, b) {
  return a.delegation_depth - b.delegation_depth || a.created_at - b.created_at || a.task_id.localeCompare(b.task_id);
}

// Each response is a full projection, not a patch. In particular, tasks removed
// by a bounded projection must not linger forever in the old browser snapshot.
export function mergeSnapshot(previous, incoming, { allowRunChange = false, allowEventReset = false } = {}) {
  const next = normalizeSnapshot(incoming);
  if (!previous) return next;
  if (previous.workspace_ref !== next.workspace_ref || previous.view_id !== next.view_id) {
    throw new Error("Cette réponse appartient à une autre vue de suivi.");
  }
  if (previous.run_id !== next.run_id && !allowRunChange) return previous;
  if (previous.run_id === next.run_id && next.snapshot_event_id < previous.snapshot_event_id && !allowEventReset) return previous;
  if (previous.run_id === next.run_id && next.snapshot_event_id === previous.snapshot_event_id
    && next.observed_at < previous.observed_at) return previous;
  return next;
}

export function chooseSelection(tasks, selectedId) {
  return tasks.some((task) => task.task_id === selectedId) ? selectedId
    : tasks.find((task) => task.delegation_depth === 0)?.task_id ?? tasks[0]?.task_id ?? null;
}

export function getFreshness(snapshot, now = Date.now(), { connected = true, visible = true } = {}) {
  if (!visible) return { kind: "paused", label: "Suivi en pause", description: "La lecture reprendra lorsque cette vue sera visible." };
  if (!connected) return { kind: "disconnected", label: "Déconnecté", description: "Les derniers états reçus sont conservés. Nouvelle connexion automatique." };
  if (!snapshot) return { kind: "loading", label: "Connexion…", description: "Lecture de la dernière observation." };
  if (snapshot.observed_at - now > snapshot.stale_after_ms) {
    return { kind: "stale", label: "Horloge incohérente", description: "L’heure de l’observation est dans le futur. L’activité n’est pas attestée." };
  }
  if (now - snapshot.observed_at >= snapshot.stale_after_ms) {
    return { kind: "stale", label: "Observation ancienne", description: "Ces états ne permettent plus d’attester une activité actuelle." };
  }
  return { kind: "fresh", label: "À jour", description: "Derniers états reçus." };
}

export function shouldAnimate(task, freshness, { reducedMotion = false } = {}) {
  return !reducedMotion && freshness.kind === "fresh" && task.state === "WORKING" && task.execution_phase === "RUNNING";
}

export function describeTask(task) {
  const business = task.business_status
    ? { label: BUSINESS[task.business_status], tone: task.business_status === "COMPLETE" ? "success" : task.business_status === "PARTIAL" ? "warning" : "danger" }
    : { label: "Résultat non livré", tone: "neutral" };
  const observation = task.observation
    ? { label: `${OBSERVATION[task.observation.status]}${task.observation.strict_required ? " · requises" : ""}`,
      tone: task.observation.status === "COMPLETE" && task.observation.accepted ? "success"
        : task.observation.status === "REJECTED" ? "danger" : "warning" }
    : { label: "Mesures non renseignées", tone: "neutral" };
  let execution = { label: "Exécution non renseignée", tone: "neutral" };
  if (task.execution_phase === "QUEUED") execution = { label: "En file d’attente", tone: "neutral" };
  if (task.execution_phase === "RUNNING") execution = { label: task.cancel_requested ? "Annulation demandée · arrêt attendu" : "Exécution en cours", tone: "info" };
  if (task.execution_phase === "STOPPED") execution = task.runtime_stop_confirmed === true
    ? { label: "Arrêt confirmé", tone: "success" } : { label: "Arrêt non attesté", tone: "warning" };
  if (task.execution_phase === "QUARANTINED") execution = { label: "Arrêt non confirmé · ressources réservées", tone: "warning" };
  return { state: TASK_STATES[task.state] ?? TASK_STATES.PENDING, business, observation, execution };
}

export function attemptLabel(attempt) {
  return attempt.resumed_from_attempt !== null && attempt.resumed_from_attempt !== undefined
    ? `Tentative ${attempt.attempt + 1} · reprise de la tentative ${attempt.resumed_from_attempt + 1}`
    : attempt.attempt === 0 ? "Tentative 1 · initiale" : `Tentative ${attempt.attempt + 1} · nouvelle tentative`;
}

export function knownMetric(value, unit = "") {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)}${unit ? ` ${unit}` : ""}` : "Non mesuré";
}

export function graphLayout(tasks) {
  const ordered = [...tasks].sort(compareTasks);
  const rows = new Map();
  const minimumDepth = ordered.length ? Math.min(...ordered.map((task) => task.delegation_depth)) : 0;
  const items = ordered.map((task) => {
    const column = task.delegation_depth - minimumDepth;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { task_id: task.task_id, column, row };
  });
  return {
    items, columns: Math.max(1, ...items.map((item) => item.column + 1)),
    rows: Math.max(1, ...items.map((item) => item.row + 1)),
  };
}

export function normalizeHistory(value) {
  if (!value || value.schema_version !== 1 || !id(value.workspace_ref) || !Array.isArray(value.items)) {
    throw new Error("Le format de l’historique n’est pas compatible.");
  }
  const byRun = new Map();
  for (const item of value.items.slice(0, 100)) {
    if (!item || !id(item.run_id)) continue;
    byRun.set(item.run_id, {
      run_id: id(item.run_id), created_at: timestamp(item.created_at), updated_at: timestamp(item.updated_at),
      task_count: count(item.task_count), active_count: count(item.active_count), root_task_id: id(item.root_task_id),
      title: cleanLabel(item.title, "Session sans titre", 120),
    });
  }
  return { schema_version: 1, workspace_ref: id(value.workspace_ref), items: [...byRun.values()],
    next_page_token: cursor(value.next_page_token), has_more: value.has_more === true };
}

export function mergeHistory(previousItems, nextItems) {
  const byRun = new Map(previousItems.map((item) => [item.run_id, item]));
  for (const item of nextItems) byRun.set(item.run_id, item);
  return [...byRun.values()].sort((a, b) => b.updated_at - a.updated_at || a.run_id.localeCompare(b.run_id));
}

export function hasActiveTasks(snapshot) {
  if (!Array.isArray(snapshot?.tasks)) return true;
  return snapshot.tasks.some((task) => task.execution_phase === "QUEUED" || task.execution_phase === "RUNNING"
    || ["PENDING", "CLAIMED", "WORKING", "VERIFYING"].includes(task.state));
}

export function pollingDelay({ failures = 0, hasMore = false, catchupPages = 0, active = true, random = 0.5 } = {}) {
  if (hasMore && failures === 0 && catchupPages < 5) return 100;
  if (!failures) return active ? 2000 : Math.round(15_000 * (0.8 + Math.max(0, Math.min(1, random)) * 0.4));
  const base = Math.min(30_000, 2000 * 2 ** Math.min(failures - 1, 8));
  return Math.min(30_000, Math.max(2000, Math.round(base * (0.8 + Math.max(0, Math.min(1, random)) * 0.4))));
}
