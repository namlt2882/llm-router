import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ connections: [], locked: new Set(), settings: {} }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => h.connections,
  getSettings: async () => ({ fallbackStrategy: "fill-first", ...h.settings }),
  updateProviderConnection: vi.fn(async () => {}),
  validateApiKey: async () => true,
  getProxyPools: async () => [],
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}),
  pickProxyPoolId: () => null,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (p) => p,
}));
vi.mock("open-sse/config/errorConfig.js", () => ({ MAX_RATE_LIMIT_COOLDOWN_MS: 60_000 }));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: (s) => s,
  checkFallbackError: () => ({ shouldFallback: false, cooldownMs: 0, backoffLevel: 0 }),
  isModelLockActive: (c) => h.locked.has(c.id),
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: (c) => (h.locked.has(c.id) ? "2026-11-13T10:00:00.000Z" : null),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(),
  getAntigravityModelQuota: () => null,
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const {
  __resetAccountInflight,
  tryAcquireAccountSlot,
  getInflightCount,
} = await import("../../src/sse/services/accountInflight.js");

const conn = (id, priority) => ({
  id,
  provider: "openai",
  authType: "apiKey",
  apiKey: "k",
  isActive: true,
  priority,
});

beforeEach(() => {
  __resetAccountInflight();
  h.locked.clear();
  h.settings = {};
  vi.unstubAllEnvs();
  h.connections = [conn("a", 1), conn("b", 2)];
});

describe("in-flight cap at selection", () => {
  it("skips an account at its cap and takes the slot on the winner", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    expect(tryAcquireAccountSlot("a", 1)).toBe(true); // a is busy
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.connectionId).toBe("b");
    expect(getInflightCount("b")).toBe(1);
  });

  it("answers a retryable busy state when every account is at its cap", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.allRateLimited).toBe(true);
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(pick.retryAfterHuman).toBe("2s");
  });

  it("a locked account is not counted as merely busy", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    // a is busy, b is model-locked: the answer must carry the lock, not "busy",
    // because a busy account frees itself in seconds and a lock does not.
    tryAcquireAccountSlot("a", 1);
    h.locked.add("b");
    h.connections[1].errorCode = "model_locked";
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.lastErrorCode).toBe("model_locked");
    expect(pick.retryAfter).toBe("2026-11-13T10:00:00.000Z");
  });
});

describe("priority wait at the cap", () => {
  it("waits for a release instead of answering busy, interactive first", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    const { releaseAccountSlot } = await import("../../src/sse/services/accountInflight.js");
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const got = [];
    const bg = getProviderCredentials("openai", null, "m", { priority: "background", upstreamWaitMs: 5000 }).then((r) => got.push(["bg", r.connectionId]));
    const ia = getProviderCredentials("openai", null, "m", { priority: "interactive", upstreamWaitMs: 5000 }).then((r) => got.push(["ia", r.connectionId]));
    await new Promise((r) => setTimeout(r, 20));
    releaseAccountSlot("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([["ia", "a"]]);
    releaseAccountSlot("b");
    await Promise.all([bg, ia]);
    expect(got).toEqual([["ia", "a"], ["bg", "b"]]);
  });

  it("falls back to account_busy when the wait times out", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const pick = await getProviderCredentials("openai", null, "m", { priority: "background", upstreamWaitMs: 50 });
    expect(pick.lastErrorCode).toBe("account_busy");
  });

  it("upstreamWaitMs 0 answers busy at once (today's behaviour)", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const t0 = Date.now();
    const pick = await getProviderCredentials("openai", null, "m", { priority: "interactive", upstreamWaitMs: 0 });
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("a raised upstream_wait_ms makes a capped chat request wait instead of account_busy", async () => {
    const { releaseAccountSlot } = await import("../../src/sse/services/accountInflight.js");
    h.settings = { accountMaxInflight: 1, upstreamWaitMs: 5000 };
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const waited = getProviderCredentials("openai", null, "m", { priority: "interactive", wait: true });
    await new Promise((r) => setTimeout(r, 20));
    releaseAccountSlot("a");
    expect((await waited).connectionId).toBe("a");
  });

  it("a caller that does not opt in keeps the immediate account_busy even with a wait configured", async () => {
    h.settings = { accountMaxInflight: 1, upstreamWaitMs: 5000 };
    tryAcquireAccountSlot("a", 1);
    tryAcquireAccountSlot("b", 1);
    const t0 = Date.now();
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
