import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock recipe copied from auth-fanout-strategy.test.js (same module surface).
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
  checkFallbackError: () => (h.shouldFallback ? { shouldFallback: true, cooldownMs: 1000, backoffLevel: 1 } : { shouldFallback: false, cooldownMs: 0, backoffLevel: 0 }),
  isModelLockActive: () => false,
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
}));
vi.mock("../../src/sse/services/accountInflight.js", () => ({
  accountInflightLimit: () => 4,
  getInflightCount: (id) => h.inflight[id] || 0,
  tryAcquireAccountSlot: (id, limit) => { h.acquired.push([id, limit]); return h.acquireOk !== false; },
  releaseAccountSlot: () => {},
  createWaitTicket: () => ({}),
  waitForCapacity: async () => (h.onWait ? (h.onWait(), true) : false),
  recordAccountBusy: () => {},
  __resetAccountInflight: () => {},
}));
const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: logger.warn, debug: vi.fn(), error: vi.fn() }));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({}));
vi.mock("../../src/sse/services/sessionPin.js", () => ({
  getPinnedConnectionId: (provider, session) => h.pins[session] || null,
  pinSession: () => {},
}));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");
const conn = (id, over = {}) => ({ id, provider: "openai", authType: "apiKey", apiKey: "k", isActive: true, ...over });

beforeEach(() => {
  h.update.mockReset().mockResolvedValue(undefined);
  h.acquired.length = 0;
  h.pins = {};
  h.inflight = {};
  h.acquireOk = true;
  h.shouldFallback = false;
  h.onWait = null;
  logger.warn.mockClear();
  h.settings = { fallbackStrategy: "spread" };
  h.connections = [conn("conn-1", { priority: 0 }), conn("conn-2", { priority: 9 })];
});

describe("detected budgets govern the base cap for every strategy", () => {
  it("a connection at its detected cap is busy on a NON-fanout request (ruling: every strategy)", async () => {
    h.settings.detectedBudgets = { "conn-1": { "glm-4.5-flash": { budget: 2 } } };
    h.inflight = { "conn-1": 2, "conn-2": 4 };
    // conn-1 limit 2 (detected, tested model), conn-2 limit 4 (global) — both full
    const pick = await getProviderCredentials("openai", null, "glm-4.5-flash");
    expect(pick?.lastErrorCode ?? null).toBe("account_busy");
  });

  it("the detected cap is model-scoped: an untested model on the same connection stays global", async () => {
    h.settings.detectedBudgets = { "conn-1": { "glm-4.5-flash": { budget: 2 } } };
    h.inflight = { "conn-1": 2, "conn-2": 4 };
    // conn-1 limit 4 for glm-5.3 (untested) → available; conn-2 at global 4 → busy
    const pick = await getProviderCredentials("openai", null, "glm-5.3");
    expect(pick?.connectionId).toBe("conn-1");
  });

  it("settings without detectedBudgets behave exactly like today (global 4)", async () => {
    h.inflight = { "conn-1": 0, "conn-2": 3 }; // spread: least absolute inflight wins
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick?.connectionId).toBe("conn-1");
    expect(h.acquired[h.acquired.length - 1]).toEqual(["conn-1", 4]);
    h.inflight = { "conn-1": 4, "conn-2": 4 };
    const busy = await getProviderCredentials("openai", null, "m");
    expect(busy?.lastErrorCode ?? null).toBe("account_busy");
  });
});

describe("fanout chain layers percent over detected budgets", () => {
  it("percent 80 scales detected 10 to an effective cap of 8 — busy under global 4, free under 8", async () => {
    h.settings.detectedBudgets = { "conn-1": { "m": { budget: 10 } } };
    h.inflight = { "conn-1": 4, "conn-2": 4 };
    // conn-1 effective floor(10×0.8)=8 → 4 free → picked; conn-2 untested → global 4 → full
    const pick = await getProviderCredentials("openai", null, "m", { fanout: { enabled: true, percent: 80 } });
    expect(pick?.connectionId).toBe("conn-1");
    expect(h.acquired[h.acquired.length - 1]).toEqual(["conn-1", 8]);
  });

  it("a manual combo budget wins unscaled over percent×detected", async () => {
    h.settings.detectedBudgets = { "conn-1": { "m": { budget: 50 } } };
    h.inflight = { "conn-1": 2, "conn-2": 4 };
    // conn-1 manual 2 → busy at 2; conn-2 untested → global 4 → busy; all full
    const pick = await getProviderCredentials("openai", null, "m", { fanout: { enabled: true, budgets: { "conn-1": 2 }, percent: 80 } });
    expect(pick?.lastErrorCode ?? null).toBe("account_busy");
  });

  it("fanout ranking uses the percent×detected budget (headroom ratio on the effective cap)", async () => {
    h.settings.detectedBudgets = { "conn-1": { "m": { budget: 20 } } };
    h.inflight = { "conn-1": 4, "conn-2": 2 };
    // conn-1 effective 16 (20×0.8), ratio 0.75 free; conn-2 global 4, ratio 0.5 → conn-1 wins
    const pick = await getProviderCredentials("openai", null, "m", { fanout: { enabled: true, percent: 80 } });
    expect(pick?.connectionId).toBe("conn-1");
  });
});

// Keyless (noAuth) providers have no connection rows, so the capacity scan
// measures them under detectedBudgets[providerId]. The virtual lane's
// connection id IS the provider id: the existing per-key chain resolves it, and
// the lane now takes a real in-flight slot instead of running uncapped.
describe("keyless provider lane (noauth) admission", () => {
  it("takes a slot keyed by the provider id, capped at the detected budget", async () => {
    h.settings.detectedBudgets = { opencode: { "m-free": { budget: 3 } } };
    const pick = await getProviderCredentials("opencode", null, "m-free");
    expect(pick.connectionId).toBe("opencode");
    expect(h.acquired).toEqual([["opencode", 3]]);
  });

  it("an unmeasured model keeps the global limit", async () => {
    h.settings.detectedBudgets = { opencode: { "m-free": { budget: 3 } } };
    await getProviderCredentials("opencode", null, "other-model");
    expect(h.acquired).toEqual([["opencode", 4]]);
  });

  it("at its cap the lane answers the retryable account_busy, like any account", async () => {
    h.settings.detectedBudgets = { opencode: { "m-free": { budget: 3 } } };
    h.acquireOk = false;
    const pick = await getProviderCredentials("opencode", null, "m-free");
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(pick.allRateLimited).toBe(true);
  });

  it("a fanout combo's percent margin scales the detected budget", async () => {
    h.settings.detectedBudgets = { opencode: { "m-free": { budget: 4 } } };
    await getProviderCredentials("opencode", null, "m-free", { fanout: { enabled: true, budgets: {}, percent: 50 } });
    expect(h.acquired).toEqual([["opencode", 2]]);
  });

  it("a failure never locks or falls back off the keyless lane (no connection row to lock)", async () => {
    h.shouldFallback = true; // the classifier WOULD fall back for a real account
    expect(await markAccountUnavailable("opencode", 429, "slow down", "opencode", "m-free"))
      .toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(h.update).not.toHaveBeenCalled();
    await clearAccountError("opencode", { id: "opencode" }, "m-free");
    expect(h.update).not.toHaveBeenCalled();
  });
});
