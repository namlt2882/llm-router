import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connections: [], update: vi.fn(), inflight: {}, settings: {}, acquired: [], pins: {},
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => h.connections,
  getSettings: async () => h.settings,
  updateProviderConnection: h.update,
  validateApiKey: async () => true,
  getProxyPools: async () => [],
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: () => null }));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: (s) => s,
  checkFallbackError: () => ({ shouldFallback: false, cooldownMs: 0, backoffLevel: 0 }),
  isModelLockActive: () => false,
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
}));
vi.mock("../../src/sse/services/accountInflight.js", () => ({
  accountInflightLimit: () => 4,
  getInflightCount: (id) => h.inflight[id] || 0,
  tryAcquireAccountSlot: (id, limit) => { h.acquired.push([id, limit]); return true; },
  releaseAccountSlot: () => {},
  createWaitTicket: () => ({}),
  waitForCapacity: async () => false,
  recordAccountBusy: () => {},
  __resetAccountInflight: () => {},
}));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({}));
vi.mock("../../src/sse/services/sessionPin.js", () => ({
  getPinnedConnectionId: (provider, session) => h.pins[session] || null,
  pinSession: () => {},
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const conn = (id, over = {}) => ({ id, provider: "openai", authType: "apiKey", apiKey: "k", isActive: true, ...over });
const FANOUT = { enabled: true, budgets: { a: 8, b: 2 } };

beforeEach(() => {
  h.update.mockReset().mockResolvedValue(undefined);
  h.acquired.length = 0;
  h.pins = {};
  h.inflight = {};
  h.settings = { fallbackStrategy: "spread" };
  h.connections = [conn("a", { priority: 0, lastUsedAt: "2026-01-01T00:00:00Z" }), conn("b", { priority: 9, lastUsedAt: "2026-01-02T00:00:00Z" })];
});

describe("fanout selection", () => {
  it("ranks by headroom ratio where spread would pick the least absolute inflight", async () => {
    h.inflight = { a: 3, b: 1 }; // ratio a: 5/8 free, b: 1/2 free → a wins
    const pick = await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(pick.connectionId).toBe("a");
  });

  it("excludes an account at its own (smaller) budget even when under the global limit", async () => {
    h.inflight = { a: 0, b: 2 }; // b budget 2 → busy; a is the only candidate
    const pick = await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(pick.connectionId).toBe("a");
  });

  it("admits an account above the global limit when its own budget is larger", async () => {
    h.inflight = { a: 5, b: 0 }; // a budget 8 → available; ratio 3/8 vs b 1
    const pick = await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(pick.connectionId).toBe("b");
  });

  it("falls back to the global limit for accounts without a budget entry", async () => {
    h.connections = [conn("a"), conn("x", { priority: 9 })];
    h.inflight = { a: 4 }; // no budget for "x" → global 4; a at global cap → busy
    const pick = await getProviderCredentials("openai", null, "m", { fanout: { enabled: true, budgets: {} } });
    expect(pick.connectionId).toBe("x");
  });

  it("overrides the provider strategy for this leg", async () => {
    h.settings = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 };
    h.connections = [conn("a", { priority: 0, lastUsedAt: "2026-01-05T00:00:00Z", consecutiveUseCount: 1 }), conn("b", { priority: 9, lastUsedAt: "2026-01-02T00:00:00Z" })];
    h.inflight = { a: 6, b: 2 }; // ratio a: 2/8 free, b: 0 → a wins despite recency/sticky
    const pick = await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(pick.connectionId).toBe("a");
  });

  it("acquires the slot with the chosen account's own budget", async () => {
    h.inflight = { a: 0, b: 0 }; // both fully free → ratio tie → oldest (a) wins
    await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(h.acquired[h.acquired.length - 1]).toEqual(["a", 8]); // a's own budget, not the global 4
  });

  it("answers account_busy when every account sits at its own budget", async () => {
    h.inflight = { a: 8, b: 2 };
    const pick = await getProviderCredentials("openai", null, "m", { fanout: FANOUT });
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(pick.retryAfterHuman).toBe("2s");
  });

  it("honours a session pin that still has headroom, migrates by ratio when it does not", async () => {
    h.pins = { s1: "b" };
    h.inflight = { a: 0, b: 1 }; // b pinned, has headroom (budget 2)
    expect((await getProviderCredentials("openai", null, "m", { fanout: FANOUT, sessionId: "s1" })).connectionId).toBe("b");
    h.inflight = { a: 0, b: 2 }; // b pinned but at cap → filter drops it → ratio picks a
    expect((await getProviderCredentials("openai", null, "m", { fanout: FANOUT, sessionId: "s1" })).connectionId).toBe("a");
  });

  it("keeps existing behaviour when no fanout ctx is present", async () => {
    h.inflight = { a: 3, b: 0 }; // spread picks least absolute inflight
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.connectionId).toBe("b");
    expect(h.acquired[h.acquired.length - 1]).toEqual(["b", 4]); // global limit at the slot
  });
});
