import { pollingDelay, hasActiveTasks } from "./tracking-state.mjs";

// One timeout and one in-flight read, including during visibility changes,
// reconnection, refresh clicks and history rebinding. Stopping observation
// deliberately does not abort or cancel any bridge execution.
export function createTrackingPoller({
  read, view_id, after = null, onSnapshot, onConnection = () => {}, onReset = () => {}, visible = true,
  schedule = (callback, delay) => setTimeout(callback, delay), cancel = (timer) => clearTimeout(timer),
  random = Math.random, now = Date.now,
}) {
  let timer = null;
  let inFlight = false;
  let stopped = true;
  let generation = 0;
  let failures = 0;
  let catchupPages = 0;
  let nextCursor = after;
  let immediateRequested = false;
  let lastReadStarted = null;
  let active = true;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function queue(delay, catchup = false) {
    clearTimer();
    const remaining = lastReadStarted === null ? 0 : Math.max(0, 2000 - (now() - lastReadStarted));
    if (!stopped && visible && !inFlight) timer = schedule(() => { timer = null; void tick(); }, catchup ? delay : Math.max(delay, remaining));
  }

  async function tick() {
    if (stopped || !visible || inFlight) return;
    inFlight = true;
    lastReadStarted = now();
    immediateRequested = false;
    const startedGeneration = generation;
    let hasMore = false;
    try {
      const snapshot = await read({ view_id, ...(nextCursor ? { after: nextCursor } : {}) });
      if (stopped || startedGeneration !== generation) return;
      if (snapshot.has_more && (!snapshot.next_cursor || snapshot.next_cursor === nextCursor)) {
        throw new Error("Le curseur de lecture n’a pas progressé.");
      }
      onSnapshot(snapshot);
      active = hasActiveTasks(snapshot);
      nextCursor = snapshot.next_cursor;
      hasMore = snapshot.has_more === true;
      catchupPages = hasMore ? catchupPages + 1 : 0;
      failures = 0;
      onConnection({ connected: true, failures: 0 });
    } catch (error) {
      if (!stopped && startedGeneration === generation) {
        if (["VIEW_CLOSED_OR_EXPIRED", "VIEW_UNAVAILABLE"].includes(error?.code)) {
          stopped = true;
          nextCursor = null;
          onConnection({ connected: false, failures: 0, terminal: true });
          return;
        }
        if (error?.code === "CURSOR_RESET_REQUIRED") {
          nextCursor = null;
          onReset();
        }
        failures += 1;
        catchupPages = 0;
        onConnection({ connected: false, failures });
      }
    } finally {
      inFlight = false;
      if (!stopped && visible) queue(immediateRequested || startedGeneration !== generation ? 0
        : pollingDelay({ failures, hasMore, catchupPages, active, random: random() }),
      hasMore && failures === 0 && catchupPages < 5 && !immediateRequested && startedGeneration === generation);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      queue(0);
    },
    setVisible(nextVisible) {
      const changed = visible !== Boolean(nextVisible);
      visible = Boolean(nextVisible);
      if (!visible) clearTimer();
      else if (changed) this.requestNow();
    },
    requestNow() {
      if (stopped) return;
      clearTimer();
      if (inFlight) immediateRequested = true;
      else queue(0);
    },
    reset(snapshot = null) {
      generation += 1;
      nextCursor = snapshot?.next_cursor ?? null;
      failures = 0;
      catchupPages = 0;
      if (snapshot) active = hasActiveTasks(snapshot);
      this.requestNow();
    },
    stop() {
      stopped = true;
      generation += 1;
      immediateRequested = false;
      clearTimer();
    },
  };
}
