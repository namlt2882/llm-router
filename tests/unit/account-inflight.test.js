import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountInflightLimit,
  getInflightCount,
  tryAcquireAccountSlot,
  releaseAccountSlot,
  __resetAccountInflight,
} from "../../src/sse/services/accountInflight.js";

beforeEach(() => {
  __resetAccountInflight();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("account in-flight semaphore", () => {
  it("refuses past the limit and frees on release", () => {
    expect([1, 2, 3, 4].map(() => tryAcquireAccountSlot("a", 4))).toEqual([true, true, true, true]);
    expect(tryAcquireAccountSlot("a", 4)).toBe(false);
    expect(getInflightCount("a")).toBe(4);
    releaseAccountSlot("a");
    expect(tryAcquireAccountSlot("a", 4)).toBe(true);
  });

  it("never goes negative on a double release", () => {
    tryAcquireAccountSlot("a", 4);
    releaseAccountSlot("a");
    releaseAccountSlot("a");
    expect(getInflightCount("a")).toBe(0);
  });

  it("releases a leaked slot after ten minutes", () => {
    tryAcquireAccountSlot("a", 4);
    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(getInflightCount("a")).toBe(0);
  });

  it("reads ACCOUNT_MAX_INFLIGHT, defaulting to 4", () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "7");
    expect(accountInflightLimit()).toBe(7);
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "0");
    expect(accountInflightLimit()).toBe(4);
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "nope");
    expect(accountInflightLimit()).toBe(4);
  });

  it("treats a missing connection id as free", () => {
    expect(getInflightCount(null)).toBe(0);
    expect(tryAcquireAccountSlot(null, 4)).toBe(true);
    releaseAccountSlot(null);
  });
});
