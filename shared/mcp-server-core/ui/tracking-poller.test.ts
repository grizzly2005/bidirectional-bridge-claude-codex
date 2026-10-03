import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackingPoller } from "./tracking-poller.mjs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const page = (cursor: string, hasMore = false) => ({ next_cursor: cursor, has_more: hasMore });
const pollers: ReturnType<typeof createTrackingPoller>[] = [];
const make = (options: Record<string, any>) => {
  const value = createTrackingPoller({ view_id: "view-1", random: () => .5, onSnapshot: () => {}, ...options });
  pollers.push(value);
  return value;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const value of pollers.splice(0)) value.stop(); vi.useRealTimers(); });

describe("read-only tracking polling lifecycle", () => {
  it("stops reading a closed, revoked or expired view until explicitly reopened", async () => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error("revoked"), { code: "VIEW_UNAVAILABLE" }));
    const onConnection = vi.fn();
    const value = make({ read, onConnection });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    value.requestNow(); value.setVisible(false); value.setVisible(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onConnection).toHaveBeenCalledWith({ connected: false, failures: 0, terminal: true });
  });

  it("does not duplicate polling when started repeatedly or refreshed during a pending read", async () => {
    const first = deferred<any>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(page("cursor-2"));
    const value = make({ read });
    value.start(); value.start(); value.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    value.requestNow(); value.requestNow(); value.requestNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(page("cursor-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]).toEqual({ view_id: "view-1", after: "cursor-1" });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses hidden views, retains a completed pending observation, and resumes once", async () => {
    const pending = deferred<any>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(page("cursor-2"));
    const onSnapshot = vi.fn();
    const value = make({ read, onSnapshot });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    value.setVisible(false);
    pending.resolve(page("cursor-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    value.setVisible(true); value.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not start reading a view that is initially hidden", async () => {
    const read = vi.fn().mockResolvedValue(page("cursor-1"));
    const value = make({ read, visible: false });
    value.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).not.toHaveBeenCalled();
    value.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("backs off failed reads without replacing the last accepted snapshot or exposing errors", async () => {
    const read = vi.fn().mockResolvedValueOnce(page("cursor-1"))
      .mockRejectedValueOnce(new Error("private-token-and-stack"))
      .mockRejectedValueOnce(new Error("private-token-and-stack"))
      .mockResolvedValue(page("cursor-4"));
    const onConnection = vi.fn();
    const onSnapshot = vi.fn();
    const value = make({ read, onConnection, onSnapshot });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onConnection).toHaveBeenLastCalledWith({ connected: false, failures: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onConnection).toHaveBeenLastCalledWith({ connected: false, failures: 2 });
    await vi.advanceTimersByTimeAsync(3999);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onConnection).toHaveBeenLastCalledWith({ connected: true, failures: 0 });
    expect(read.mock.calls[3][0].after).toBe("cursor-1");
    expect(JSON.stringify(onConnection.mock.calls)).not.toContain("private-token");
  });

  it("ignores a late old-run response when history is rebound", async () => {
    const pending = deferred<any>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(page("cursor-newer"));
    const onSnapshot = vi.fn();
    const value = make({ read, onSnapshot });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    value.stop();
    value.reset(page("cursor-bound"));
    value.start();
    pending.resolve(page("cursor-old"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0].after).toBe("cursor-bound");
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(page("cursor-newer"));
  });

  it("slows down to fifteen seconds with no active work", async () => {
    const read = vi.fn().mockResolvedValue({ ...page("cursor-1"), tasks: [] });
    const value = make({ read });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resynchronizes after a typed cursor reset without retrying the obsolete cursor", async () => {
    const resetError = Object.assign(new Error("private detailed reason"), { code: "CURSOR_RESET_REQUIRED" });
    const read = vi.fn().mockRejectedValueOnce(resetError).mockResolvedValue(page("cursor-fresh"));
    const onReset = vi.fn();
    const onSnapshot = vi.fn();
    const value = make({ read, after: "cursor-obsolete", onReset, onSnapshot });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReset).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read.mock.calls[0][0].after).toBe("cursor-obsolete");
    expect(read.mock.calls[1][0]).toEqual({ view_id: "view-1" });
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(page("cursor-fresh"));
  });

  it("limits ordinary reads to thirty per minute even when refresh is repeatedly clicked", async () => {
    const read = vi.fn().mockResolvedValue(page("cursor-1"));
    const value = make({ read });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 599; index++) {
      value.requestNow();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(read).toHaveBeenCalledTimes(30);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("yields between bounded catch-up bursts and refuses a non-advancing cursor", async () => {
    let cursor = 0;
    const read = vi.fn(async () => page(`cursor-${++cursor}`, true));
    const value = make({ read });
    value.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1900);
    expect(read).toHaveBeenCalledTimes(6);
    value.stop();
    const badRead = vi.fn().mockResolvedValue(page("cursor-same", true));
    const onConnection = vi.fn();
    const onSnapshot = vi.fn();
    const stalled = make({ read: badRead, after: "cursor-same", onConnection, onSnapshot });
    stalled.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onConnection).toHaveBeenLastCalledWith({ connected: false, failures: 1 });
  });

  it("stops observation independently of work and ignores a pending response after teardown", async () => {
    const pending = deferred<any>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const onSnapshot = vi.fn();
    const onConnection = vi.fn();
    const value = make({ read, onSnapshot, onConnection });
    value.start();
    await vi.advanceTimersByTimeAsync(0);
    value.stop(); value.stop();
    pending.resolve(page("cursor-1"));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onConnection).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
