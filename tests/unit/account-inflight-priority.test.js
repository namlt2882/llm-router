import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePriority,
  createWaitTicket,
  waitForCapacity,
  getQueueStats,
  recordAccountBusy,
  tryAcquireAccountSlot,
  releaseAccountSlot,
  __resetAccountInflight,
} from "../../src/sse/services/accountInflight.js";

beforeEach(() => {
  __resetAccountInflight();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("priority-ordered upstream wait", () => {
  it("queued interactive is woken before an earlier background when a slot frees", async () => {
    tryAcquireAccountSlot("a", 1);
    const order = [];
    const bg = createWaitTicket("background");
    const ia = createWaitTicket("interactive");
    const pb = waitForCapacity(bg, 10_000).then(() => order.push("bg"));
    const pi = waitForCapacity(ia, 10_000).then(() => order.push("ia"));
    releaseAccountSlot("a");
    await Promise.all([pb, pi]);
    expect(order).toEqual(["ia", "bg"]);
  });

  it("same tier is woken FIFO", async () => {
    tryAcquireAccountSlot("a", 1);
    const order = [];
    const t1 = createWaitTicket("background");
    const t2 = createWaitTicket("background");
    const p2 = waitForCapacity(t2, 10_000).then(() => order.push(2));
    const p1 = waitForCapacity(t1, 10_000).then(() => order.push(1));
    releaseAccountSlot("a");
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("times out to false after waitMs and leaves the queue", async () => {
    const t = createWaitTicket("background");
    const p = waitForCapacity(t, 5_000);
    expect(getQueueStats().queued.background).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe(false);
    expect(getQueueStats().queued.background).toBe(0);
  });

  it("missing header parses to background", () => {
    expect(parsePriority(new Headers())).toBe("background");
    expect(parsePriority({})).toBe("background");
    expect(parsePriority(new Headers({ "x-wavebot-priority": "interactive" }))).toBe("interactive");
    expect(parsePriority({ "x-wavebot-priority": "bogus" })).toBe("background");
  });

  it("an aborted signal leaves the queue and resolves false", async () => {
    const ac = new AbortController();
    const p = waitForCapacity(createWaitTicket("interactive"), 10_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBe(false);
    expect(getQueueStats().queued.interactive).toBe(0);
  });

  it("waitMs 0 resolves false immediately without queueing", async () => {
    await expect(waitForCapacity(createWaitTicket("interactive"), 0)).resolves.toBe(false);
    expect(getQueueStats().queued.interactive).toBe(0);
  });

  it("reports oldest wait and busy count over 5 minutes", async () => {
    const p = waitForCapacity(createWaitTicket("background"), 60_000);
    vi.setSystemTime(3_000);
    expect(getQueueStats().oldestWaitMs).toBe(3_000);
    recordAccountBusy();
    recordAccountBusy();
    expect(getQueueStats().busy5m).toBe(2);
    vi.setSystemTime(5 * 60_000 + 4_000);
    expect(getQueueStats().busy5m).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
  });
});
