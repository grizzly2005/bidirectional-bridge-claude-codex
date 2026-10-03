import {
  TASK_STATES, cleanLabel, normalizeSnapshot, mergeSnapshot, chooseSelection, getFreshness,
  shouldAnimate, describeTask, attemptLabel, knownMetric, graphLayout, normalizeHistory, mergeHistory,
} from "./tracking-state.mjs";
import { createTrackingPoller } from "./tracking-poller.mjs";

const mountedRoots = new WeakMap();
let nextMountId = 0;
const SVG_NS = "http://www.w3.org/2000/svg";

// In particular, titles, identifiers and provider values never enter HTML,
// selectors, SVG markup, URLs or event-handler attributes.
export function textElement(document, tag, text, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(document, label, className = "bt-button") {
  const node = textElement(document, "button", label, className);
  node.type = "button";
  return node;
}

function badge(document, value) {
  return textElement(document, "span", value.label, `bt-badge bt-${value.tone}`);
}

function ownerLabel(owner) {
  return owner === "codex" ? "Codex" : owner === "claude" || owner === "claude-code" ? "Claude" : owner || "Sans responsable";
}

function formatDate(value) {
  if (!value || !Number.isFinite(value)) return "Non renseigné";
  try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" }).format(value); }
  catch { return "Non renseigné"; }
}

function definition(document, pairs) {
  const node = textElement(document, "dl", undefined, "bt-facts");
  for (const [label, value] of pairs) {
    node.append(textElement(document, "dt", label), textElement(document, "dd", value));
  }
  return node;
}

/**
 * Mount a read-only tracking view. The transport owns all authenticated IO.
 * initial: Snapshot|null; view_id: string; read/history/bind/close: async DTO APIs;
 * expand: optional host display action. No task mutation is ever requested.
 * Returns { destroy, refresh, setVisible }; mounting twice on a root is idempotent.
 */
export function mountTrackingUI({ root, transport }) {
  if (!root?.ownerDocument || !transport || typeof transport.read !== "function") {
    throw new Error("Une racine DOM et un transport de lecture sont requis.");
  }
  const existing = mountedRoots.get(root);
  if (existing) return existing;
  const document = root.ownerDocument;
  const window = document.defaultView;
  const mountId = `bridge-tracking-${++nextMountId}`;
  let snapshot = null;
  let initialInvalid = false;
  try { if (transport.initial) snapshot = normalizeSnapshot(transport.initial); }
  catch { initialInvalid = true; }
  const viewId = snapshot?.view_id ?? transport.view_id;
  if (typeof viewId !== "string" || !viewId || viewId.length > 180 || /\s/u.test(viewId)) {
    throw new Error("La vue de suivi n’est pas identifiée.");
  }
  let selectedId = chooseSelection(snapshot?.tasks ?? [], null);
  let connected = !initialInvalid;
  let documentVisible = document.visibilityState !== "hidden";
  let hostVisible = true;
  let viewportVisible = true;
  let graphMode = true;
  let autoFollow = true;
  let destroyed = false;
  let closed = false;
  let closing = false;
  let viewUnavailable = false;
  let binding = false;
  let historyOpen = false;
  let historyItems = [];
  let historyPage = null;
  let historyHasMore = false;
  let historyLoading = false;
  let historyGeneration = 0;
  let bindingGeneration = 0;
  let lastDetailsKey = "";
  let lastSummary = "";
  let allowEventReset = false;
  let lastLinksKey = "";
  let freshnessTimer = null;
  let drawFrame = null;
  const cardNodes = new Map();
  const listeners = [];
  const media = window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reducedMotion = media?.matches ?? false;

  function listen(target, name, callback) {
    target.addEventListener(name, callback);
    listeners.push(() => target.removeEventListener(name, callback));
  }

  const panel = textElement(document, "section", undefined, "bt-panel");
  panel.setAttribute("aria-label", "Suivi des délégations du bridge");
  panel.setAttribute("lang", "fr");
  const header = textElement(document, "header", undefined, "bt-header");
  const headingBlock = textElement(document, "div", undefined, "bt-heading");
  const heading = textElement(document, "h1", "Suivi des délégations");
  const workspace = textElement(document, "p", snapshot?.workspace_label ?? "Espace de travail", "bt-workspace");
  headingBlock.append(heading, workspace);
  const headerActions = textElement(document, "div", undefined, "bt-header-actions");
  const expandButton = button(document, "Agrandir");
  if (typeof transport.expand === "function") headerActions.append(expandButton);
  const closeButton = button(document, "Fermer", "bt-button bt-close");
  closeButton.setAttribute("aria-label", "Fermer le suivi ; les délégations continuent");
  headerActions.append(closeButton);
  header.append(headingBlock, headerActions);

  const statusRow = textElement(document, "div", undefined, "bt-status-row");
  const status = textElement(document, "span", "Connexion…", "bt-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const observed = textElement(document, "span", "", "bt-observed");
  const refreshButton = button(document, "Actualiser");
  statusRow.append(status, observed, refreshButton);
  const statusExplanation = textElement(document, "p", "", "bt-status-explanation");

  const toolbar = textElement(document, "div", undefined, "bt-toolbar");
  const modes = textElement(document, "div", undefined, "bt-modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Présentation des délégations");
  const graphButton = button(document, "Graphe");
  const listButton = button(document, "Liste");
  graphButton.setAttribute("aria-pressed", "true");
  listButton.setAttribute("aria-pressed", "false");
  modes.append(graphButton, listButton);
  const historyButton = button(document, "Historique");
  historyButton.setAttribute("aria-expanded", "false");
  historyButton.setAttribute("aria-controls", `${mountId}-history`);
  const followButton = button(document, "Revenir au suivi en cours");
  followButton.hidden = true;
  toolbar.append(modes, historyButton, followButton);

  const notice = textElement(document, "p", "", "bt-notice");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  const historySection = textElement(document, "section", undefined, "bt-history");
  historySection.id = `${mountId}-history`;
  historySection.hidden = true;
  const historyHeading = textElement(document, "h2", "Sessions précédentes");
  const filters = textElement(document, "div", undefined, "bt-history-filters");
  const stateFilter = document.createElement("select");
  stateFilter.setAttribute("aria-label", "Filtrer les sessions par état de tâche");
  const allStates = textElement(document, "option", "Tous les états");
  allStates.value = "";
  stateFilter.append(allStates);
  for (const [value, label] of Object.entries(TASK_STATES)) {
    const option = textElement(document, "option", label);
    option.value = value;
    stateFilter.append(option);
  }
  const ownerFilter = document.createElement("select");
  ownerFilter.setAttribute("aria-label", "Filtrer les sessions par responsable");
  for (const [value, label] of [["", "Tous les responsables"], ["codex", "Codex"], ["claude", "Claude"]]) {
    const option = textElement(document, "option", label);
    option.value = value;
    ownerFilter.append(option);
  }
  filters.append(stateFilter, ownerFilter);
  const historyStatus = textElement(document, "p", "", "bt-muted");
  historyStatus.setAttribute("role", "status");
  const historyList = textElement(document, "ul", undefined, "bt-history-list");
  const moreButton = button(document, "Charger les sessions précédentes");
  moreButton.hidden = true;
  historySection.append(historyHeading, filters, historyStatus, historyList, moreButton);

  const summary = textElement(document, "p", "Aucune délégation reçue.", "bt-summary");
  summary.setAttribute("aria-live", "polite");
  summary.setAttribute("aria-atomic", "true");
  const content = textElement(document, "div", undefined, "bt-content");
  const graphViewport = textElement(document, "div", undefined, "bt-graph-viewport");
  graphViewport.setAttribute("aria-label", "Délégations ; sélectionnez une tâche pour lire ses détails");
  const graphCanvas = textElement(document, "div", undefined, "bt-graph-canvas");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "bt-links");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const cards = textElement(document, "ul", undefined, "bt-cards");
  cards.setAttribute("aria-label", "Tâches de la session");
  const empty = textElement(document, "p", "La vue est prête. La prochaine délégation apparaîtra ici.", "bt-empty");
  graphCanvas.append(svg, cards, empty);
  graphViewport.append(graphCanvas);
  const details = textElement(document, "aside", undefined, "bt-details");
  details.setAttribute("aria-label", "Détails de la tâche sélectionnée");
  content.append(graphViewport, details);
  const legend = textElement(document, "p", "Lignes pointillées : délégation entre tâches. Les tentatives et les reprises sont détaillées dans la tâche sélectionnée.", "bt-legend");
  const footer = textElement(document, "footer", undefined, "bt-footer");
  footer.append(textElement(document, "span", "Lecture seule · fermer cette vue laisse les tâches continuer."));
  const disableButton = button(document, "Désactiver le suivi");
  disableButton.setAttribute("aria-label", "Désactiver le suivi des prochaines délégations ; les tâches continuent");
  footer.append(disableButton);
  panel.append(header, statusRow, statusExplanation, toolbar, notice, historySection, summary, content, legend, footer);
  root.replaceChildren(panel);

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = !message;
  }

  function visible() { return documentVisible && hostVisible && viewportVisible; }
  function freshness() { return getFreshness(snapshot, Date.now(), { connected, visible: visible() }); }

  function renderFreshness() {
    if (destroyed || closed) return;
    const value = freshness();
    panel.dataset.freshness = value.kind;
    panel.classList.toggle("bt-reduced-motion", reducedMotion);
    if (status.textContent !== value.label) status.textContent = value.label;
    status.className = `bt-status bt-status-${value.kind}`;
    statusExplanation.textContent = value.description;
    observed.textContent = snapshot ? `Observé le ${formatDate(snapshot.observed_at)}` : "";
    for (const task of snapshot?.tasks ?? []) {
      cardNodes.get(task.task_id)?.button.classList.toggle("bt-running", shouldAnimate(task, value, { reducedMotion }));
    }
    for (const path of svg.children) {
      const task = snapshot?.tasks.find((candidate) => candidate.task_id === path.dataset.target);
      path.classList.toggle("bt-link-active", Boolean(task && shouldAnimate(task, value, { reducedMotion })));
    }
  }

  function heartbeat() {
    if (freshnessTimer !== null) window?.clearTimeout(freshnessTimer);
    freshnessTimer = null;
    if (destroyed || closed || !visible() || !window) return;
    renderFreshness();
    freshnessTimer = window.setTimeout(heartbeat, 1000);
  }

  function updateVisibility() {
    if (destroyed || closed) return;
    poller.setVisible(visible());
    renderFreshness();
    heartbeat();
  }

  function drawLinks() {
    drawFrame = null;
    if (destroyed || closed || !graphMode || !snapshot) return;
    const canvasBox = graphCanvas.getBoundingClientRect();
    const width = Math.max(1, graphCanvas.scrollWidth, canvasBox.width);
    const height = Math.max(1, graphCanvas.scrollHeight, canvasBox.height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const paths = [];
    const shapeKeys = [];
    for (const link of snapshot.links) {
      const from = cardNodes.get(link.from)?.button.getBoundingClientRect();
      const to = cardNodes.get(link.to)?.button.getBoundingClientRect();
      if (!from || !to) continue;
      const x1 = from.right - canvasBox.left;
      const y1 = from.top + from.height / 2 - canvasBox.top;
      const x2 = to.left - canvasBox.left;
      const y2 = to.top + to.height / 2 - canvasBox.top;
      const bend = Math.max(16, Math.abs(x2 - x1) / 2);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", "bt-link");
      path.dataset.target = link.to;
      paths.push(path);
      shapeKeys.push([link.from, link.to, path.getAttribute("d")]);
    }
    const key = JSON.stringify(shapeKeys);
    if (key !== lastLinksKey) { svg.replaceChildren(...paths); lastLinksKey = key; }
    renderFreshness();
  }

  function queueDraw() {
    if (drawFrame !== null || !window || destroyed || closed) return;
    drawFrame = window.requestAnimationFrame(drawLinks);
  }

  function renderDetails() {
    const task = snapshot?.tasks.find((candidate) => candidate.task_id === selectedId);
    const attempts = snapshot?.attempts.filter((attempt) => attempt.task_id === selectedId) ?? [];
    const key = JSON.stringify([task, attempts]);
    if (key === lastDetailsKey) return;
    lastDetailsKey = key;
    if (!task) {
      details.replaceChildren(textElement(document, "h2", "Détails"), textElement(document, "p", "Sélectionnez une tâche pour voir sa lignée et ses tentatives.", "bt-muted"));
      return;
    }
    const description = describeTask(task);
    const title = textElement(document, "h2", task.title);
    const resultBadges = textElement(document, "div", undefined, "bt-result-badges");
    resultBadges.append(badge(document, description.business), badge(document, description.observation));
    const execution = textElement(document, "p", description.execution.label, `bt-execution bt-${description.execution.tone}`);
    const facts = definition(document, [
      ["État", description.state], ["Responsable", ownerLabel(task.owner)], ["Tâche", task.task_id],
      ["Parent", task.parent_task_id ?? "Racine"], ["Profondeur", String(task.delegation_depth)],
      ["Créée", formatDate(task.created_at)], ["Mise à jour", formatDate(task.updated_at)],
      ["Vérifications", task.verification.passed || task.verification.failed
        ? `${task.verification.passed} réussies · ${task.verification.failed} en échec` : "Aucune renseignée"],
    ]);
    const attemptsHeading = textElement(document, "h3", "Tentatives et reprises");
    const attemptList = textElement(document, "ol", undefined, "bt-attempts");
    for (const attempt of attempts) {
      const item = textElement(document, "li", undefined, "bt-attempt");
      item.append(textElement(document, "h4", attemptLabel(attempt)), textElement(document, "p", ownerLabel(attempt.agent), "bt-muted"));
      const attemptObservation = describeTask({ state: task.state, business_status: null, observation: attempt.observation }).observation;
      item.append(badge(document, attemptObservation));
      item.append(definition(document, [
        ["Début", formatDate(attempt.started_at)], ["Fin", attempt.ended_at === null ? "Non renseignée" : formatDate(attempt.ended_at)],
        ["Issue", attempt.outcome ?? "Non renseignée"],
        ["Motif runtime", ({ quota: "Quota fournisseur", auth: "Authentification requise", transient: "Incident temporaire", profile: "Profil runtime incompatible", contract: "Contrat de résultat invalide", turn_limit: "Limite de tours", unknown: "Cause inconnue" })[attempt.failure_category] ?? "Non renseigné"],
        ["Durée de la tentative", knownMetric(attempt.telemetry?.attempt_wall_duration_ms, "ms")],
        ["Durée cumulée de délégation", knownMetric(attempt.telemetry?.wall_duration_ms, "ms")],
        ["Durée runtime", knownMetric(attempt.telemetry?.runtime_duration_ms, "ms")],
        ["Attente en file", knownMetric(attempt.telemetry?.queue_duration_ms, "ms")],
        ["Tokens d’entrée", knownMetric(attempt.telemetry?.input_tokens)],
        ["Tokens de sortie", knownMetric(attempt.telemetry?.output_tokens)],
        ["Tokens en cache", knownMetric(attempt.telemetry?.cached_input_tokens)],
        ["Total communiqué", knownMetric(attempt.telemetry?.total_tokens)],
        ["Tours communiqués", knownMetric(attempt.telemetry?.turn_count)],
      ]));
      attemptList.append(item);
    }
    const metricNote = textElement(document, "p", "Valeurs communiquées par le runtime. Les tokens en cache ne s’ajoutent pas au total ; une valeur absente reste non mesurée.", "bt-metric-note");
    details.replaceChildren(title, resultBadges, execution, facts, attemptsHeading,
      attempts.length ? attemptList : textElement(document, "p", "Aucune tentative enregistrée. Une tâche en attente peut ne pas avoir démarré de runtime.", "bt-muted"), metricNote);
  }

  function selectTask(taskId, focus = false) {
    selectedId = chooseSelection(snapshot?.tasks ?? [], taskId);
    for (const [id, node] of cardNodes) {
      const selected = id === selectedId;
      node.button.setAttribute("aria-pressed", String(selected));
      node.button.tabIndex = selected ? 0 : -1;
      node.button.classList.toggle("bt-selected", selected);
    }
    renderDetails();
    if (focus) cardNodes.get(selectedId)?.button.focus();
  }

  function renderTasks() {
    const tasks = snapshot?.tasks ?? [];
    selectedId = chooseSelection(tasks, selectedId);
    const taskIds = new Set(tasks.map((task) => task.task_id));
    for (const [id, node] of cardNodes) {
      if (!taskIds.has(id)) { node.item.remove(); cardNodes.delete(id); }
    }
    const layout = graphLayout(tasks);
    cards.style.gridTemplateColumns = graphMode ? `repeat(${layout.columns}, minmax(210px, 1fr))` : "1fr";
    graphCanvas.classList.toggle("bt-list-mode", !graphMode);
    svg.hidden = !graphMode;
    let position = 0;
    for (const layoutItem of layout.items) {
      const task = tasks.find((candidate) => candidate.task_id === layoutItem.task_id);
      let node = cardNodes.get(task.task_id);
      if (!node) {
        const item = textElement(document, "li", undefined, "bt-card-item");
        const card = button(document, "", "bt-card");
        const owner = textElement(document, "span", "", "bt-card-owner");
        const title = textElement(document, "span", "", "bt-card-title");
        const state = textElement(document, "span", "", "bt-card-state");
        const results = textElement(document, "span", undefined, "bt-card-results");
        const execution = textElement(document, "span", "", "bt-card-execution");
        const attempt = textElement(document, "span", "", "bt-card-attempt");
        card.append(owner, title, state, results, execution, attempt);
        card.addEventListener("click", () => selectTask(task.task_id));
        item.append(card);
        node = { item, button: card, owner, title, state, results, execution, attempt, key: "" };
        cardNodes.set(task.task_id, node);
      }
      const recordedAttempt = snapshot?.attempts.some((attempt) => attempt.task_id === task.task_id);
      const key = JSON.stringify([task, recordedAttempt]);
      if (node.key !== key) {
        const description = describeTask(task);
        node.key = key;
        node.owner.textContent = `${ownerLabel(task.owner)} · niveau ${task.delegation_depth}`;
        node.title.textContent = task.title;
        node.state.textContent = description.state;
        node.state.className = `bt-card-state bt-state-${task.state.toLowerCase()}`;
        node.results.replaceChildren(badge(document, description.business), badge(document, description.observation));
        node.execution.textContent = description.execution.label;
        node.attempt.textContent = `${recordedAttempt ? `Tentative ${task.attempt + 1}` : "Pas de tentative enregistrée"} · ${cleanLabel(task.task_id, "", 18)}`;
        node.button.setAttribute("aria-label", `${task.title}. ${description.state}. ${ownerLabel(task.owner)}. ${description.business.label}. ${description.observation.label}. ${description.execution.label}.`);
      }
      node.item.style.gridColumn = graphMode ? String(layoutItem.column + 1) : "1";
      node.item.style.gridRow = graphMode ? String(layoutItem.row + 1) : String(position + 1);
      // Preserve existing nodes and keyboard focus when only their state changes.
      if (cards.children[position] !== node.item) cards.insertBefore(node.item, cards.children[position] ?? null);
      position += 1;
    }
    empty.hidden = tasks.length > 0;
    const working = tasks.filter((task) => task.state === "WORKING" || task.state === "VERIFYING").length;
    const blocked = tasks.filter((task) => task.state === "BLOCKED").length;
    const text = tasks.length ? `${tasks.length} tâches · ${working} en cours · ${blocked} bloquées${snapshot?.truncated ? " · vue limitée" : ""}` : "Aucune délégation reçue.";
    if (text !== lastSummary) { summary.textContent = text; lastSummary = text; }
    followButton.hidden = autoFollow;
    graphButton.setAttribute("aria-pressed", String(graphMode));
    listButton.setAttribute("aria-pressed", String(!graphMode));
    selectTask(selectedId);
    renderFreshness();
    queueDraw();
  }

  function applySnapshot(incoming, allowRunChange = autoFollow) {
    snapshot = mergeSnapshot(snapshot, incoming, { allowRunChange, allowEventReset });
    allowEventReset = false;
    workspace.textContent = snapshot.workspace_label;
    renderTasks();
    return snapshot;
  }

  const poller = createTrackingPoller({
    view_id: viewId, after: snapshot?.next_cursor ?? null, visible: visible(),
    read: async (args) => normalizeSnapshot(await transport.read(args)),
    onSnapshot: (incoming) => applySnapshot(incoming),
    onConnection: ({ connected: nextConnected, terminal }) => {
      connected = nextConnected;
      if (terminal) {
        viewUnavailable = true;
        refreshButton.disabled = true; historyButton.disabled = true; disableButton.disabled = true;
        showNotice("Cette vue a expiré ou a été fermée. Réactivez le suivi depuis le chat pour reprendre l’affichage.");
      }
      renderFreshness();
    },
    onReset: () => { allowEventReset = true; },
  });

  function renderHistory() {
    moreButton.hidden = !historyHasMore;
    moreButton.disabled = historyLoading || binding;
    historyList.replaceChildren();
    for (const item of historyItems) {
      const li = textElement(document, "li");
      const open = button(document, "", "bt-history-item");
      open.disabled = binding;
      if (item.run_id === snapshot?.run_id) open.setAttribute("aria-current", "true");
      open.append(textElement(document, "strong", item.title),
        textElement(document, "span", `${item.task_count} tâches · ${item.active_count} actives`, "bt-muted"),
        textElement(document, "span", formatDate(item.updated_at), "bt-muted"));
      open.addEventListener("click", () => { void bindRun(item.run_id); });
      li.append(open);
      historyList.append(li);
    }
    if (historyLoading) historyStatus.textContent = "Lecture de l’historique…";
    else historyStatus.textContent = historyItems.length ? `${historyItems.length} sessions affichées.` : "Aucune session pour ces filtres.";
  }

  async function loadHistory(append = false) {
    if (destroyed || closed || typeof transport.history !== "function" || historyLoading && append) return;
    const generation = ++historyGeneration;
    const pageToken = append ? historyPage : null;
    if (!append) { historyItems = []; historyPage = null; historyHasMore = false; }
    historyLoading = true;
    renderHistory();
    try {
      const page = normalizeHistory(await transport.history({ view_id: viewId,
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(stateFilter.value ? { state: stateFilter.value } : {}),
        ...(ownerFilter.value ? { owner: ownerFilter.value } : {}),
      }));
      if (destroyed || closed || generation !== historyGeneration) return;
      if (snapshot && page.workspace_ref !== snapshot.workspace_ref) throw new Error("Historique d’un autre espace.");
      if (page.has_more && (!page.next_page_token || page.next_page_token === pageToken)) throw new Error("Page sans progression.");
      historyItems = mergeHistory(append ? historyItems : [], page.items);
      historyPage = page.next_page_token;
      historyHasMore = page.has_more;
      historyLoading = false;
      renderHistory();
    } catch {
      if (!destroyed && !closed && generation === historyGeneration) {
        historyLoading = false;
        renderHistory();
        historyStatus.textContent = "Historique indisponible. Rouvrez l’historique ou actualisez les filtres pour réessayer.";
      }
    }
  }

  async function bindRun(runId) {
    if (destroyed || closed || binding || typeof transport.bind !== "function") return;
    const generation = ++bindingGeneration;
    binding = true;
    poller.stop();
    renderHistory();
    followButton.disabled = true;
    try {
      const next = normalizeSnapshot(await transport.bind({ view_id: viewId, run_id: runId }));
      if (destroyed || closed || generation !== bindingGeneration) return;
      autoFollow = runId === null;
      applySnapshot(next, true);
      connected = true;
      poller.reset(next);
      historyOpen = false;
      historySection.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
      showNotice(autoFollow ? "Suivi en cours rétabli. La prochaine session sera suivie automatiquement." : "Session historique sélectionnée. Les états reçus continuent à être actualisés.");
      selectTask(selectedId, true);
    } catch {
      if (!destroyed && !closed && generation === bindingGeneration) showNotice("Impossible d’ouvrir cette session. La vue précédente est conservée.");
    } finally {
      binding = false;
      if (!destroyed && !closed) {
        followButton.disabled = false;
        renderHistory();
        poller.start();
        renderFreshness();
      }
    }
  }

  async function closeView(disable) {
    if (closing || closed || destroyed) return;
    closing = true;
    closeButton.disabled = true;
    disableButton.disabled = true;
    try {
      if (typeof transport.close !== "function") throw new Error("Fermeture indisponible.");
      if (!viewUnavailable) await transport.close({ view_id: viewId, disable });
      if (destroyed) return;
      closed = true;
      cleanup();
      const completion = textElement(document, "section", undefined, "bt-panel bt-closed");
      completion.setAttribute("role", "status");
      completion.append(textElement(document, "h1", disable ? "Suivi désactivé" : "Suivi fermé"),
        textElement(document, "p", "Les délégations continuent indépendamment de cette vue."),
        textElement(document, "p", "Pour rouvrir la vue, demandez dans le chat : « Active le suivi de délégation ».", "bt-muted"));
      root.replaceChildren(completion);
    } catch {
      if (!destroyed) {
        showNotice("La fermeture n’a pas été confirmée. Réessayez ; les tâches continuent.");
        closeButton.disabled = false;
        disableButton.disabled = false;
      }
    } finally { closing = false; }
  }

  listen(refreshButton, "click", () => { poller.requestNow(); if (historyOpen) void loadHistory(); });
  listen(graphButton, "click", () => { graphMode = true; renderTasks(); });
  listen(listButton, "click", () => { graphMode = false; renderTasks(); });
  listen(historyButton, "click", () => {
    historyOpen = !historyOpen;
    historySection.hidden = !historyOpen;
    historyButton.setAttribute("aria-expanded", String(historyOpen));
    if (historyOpen) void loadHistory();
  });
  listen(stateFilter, "change", () => { void loadHistory(); });
  listen(ownerFilter, "change", () => { void loadHistory(); });
  listen(moreButton, "click", () => { void loadHistory(true); });
  listen(followButton, "click", () => { void bindRun(null); });
  listen(closeButton, "click", () => { void closeView(false); });
  listen(disableButton, "click", () => { void closeView(true); });
  if (typeof transport.expand === "function") listen(expandButton, "click", () => {
    Promise.resolve().then(() => transport.expand()).catch(() => { if (!destroyed && !closed) showNotice("L’agrandissement n’est pas disponible dans ce client."); });
  });
  listen(cards, "keydown", (event) => {
    const ids = snapshot?.tasks.map((task) => task.task_id) ?? [];
    const index = Math.max(0, ids.indexOf(selectedId));
    let next = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = ids[Math.min(ids.length - 1, index + 1)];
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = ids[Math.max(0, index - 1)];
    if (event.key === "Home") next = ids[0];
    if (event.key === "End") next = ids.at(-1);
    if (next) { event.preventDefault(); selectTask(next, true); }
  });
  listen(panel, "keydown", (event) => {
    if (event.key === "Escape" && historyOpen) {
      event.preventDefault();
      historyOpen = false;
      historySection.hidden = true;
      historyButton.setAttribute("aria-expanded", "false");
      historyButton.focus();
    }
  });
  listen(document, "visibilitychange", () => { documentVisible = document.visibilityState !== "hidden"; updateVisibility(); });
  if (window) listen(window, "resize", queueDraw);
  if (media?.addEventListener) listen(media, "change", (event) => { reducedMotion = event.matches; renderFreshness(); });
  const resizeObserver = window?.ResizeObserver ? new window.ResizeObserver(queueDraw) : null;
  resizeObserver?.observe(graphCanvas);
  const intersectionObserver = window?.IntersectionObserver ? new window.IntersectionObserver((entries) => {
    viewportVisible = entries.some((entry) => entry.isIntersecting);
    updateVisibility();
  }, { threshold: 0 }) : null;
  intersectionObserver?.observe(root);

  function cleanup() {
    poller.stop();
    historyGeneration += 1;
    bindingGeneration += 1;
    if (freshnessTimer !== null) window?.clearTimeout(freshnessTimer);
    if (drawFrame !== null) window?.cancelAnimationFrame(drawFrame);
    freshnessTimer = null;
    drawFrame = null;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    for (const remove of listeners.splice(0)) remove();
    if (mountedRoots.get(root) === api) mountedRoots.delete(root);
  }

  const api = {
    destroy() {
      if (destroyed) return;
      const ownsRoot = !mountedRoots.has(root) || mountedRoots.get(root) === api;
      destroyed = true;
      cleanup();
      if (ownsRoot) root.replaceChildren();
    },
    refresh() { if (!destroyed && !closed) poller.requestNow(); },
    setVisible(value) { hostVisible = Boolean(value); updateVisibility(); },
  };
  mountedRoots.set(root, api);
  renderTasks();
  poller.start();
  heartbeat();
  return api;
}
