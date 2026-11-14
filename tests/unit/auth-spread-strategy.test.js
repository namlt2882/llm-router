import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ connections: [], update: vi.fn(), inflight: {}, settings: {} }));
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
  tryAcquireAccountSlot: () => true,
  releaseAccountSlot: () => {},
  createWaitTicket: () => ({}),
  waitForCapacity: async () => false,
  recordAccountBusy: () => {},
  __resetAccountInflight: () => {},
}));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const conn = (id, over = {}) => ({ id, provider: "openai", authType: "apiKey", apiKey: "k", isActive: true, ...over });

beforeEach(() => {
  h.update.mockReset().mockResolvedValue(undefined);
  h.settings = { fallbackStrategy: "spread" };
  h.inflight = {};
  h.connections = [conn("a", { priority: 0, lastUsedAt: "2026-01-01T00:00:00Z" }), conn("b", { priority: 9, lastUsedAt: "2026-01-02T00:00:00Z" })];
});

describe("spread strategy", () => {
  it("prefers the account with the fewest in-flight requests over priority", async () => {
    h.inflight = { a: 3, b: 0 };
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.connectionId).toBe("b");
    expect(h.update).toHaveBeenCalledWith("b", expect.objectContaining({ lastUsedAt: expect.any(String) }));
  });

  it("breaks an in-flight tie by backoff level, then oldest use, then priority", async () => {
    h.connections = [
      conn("a", { priority: 0, backoffLevel: 2, lastUsedAt: "2026-01-03T00:00:00Z" }),
      conn("b", { priority: 9, backoffLevel: 0, lastUsedAt: "2026-01-02T00:00:00Z" }),
    ];
    expect((await getProviderCredentials("openai", null, "m")).connectionId).toBe("b");
    h.connections = [conn("a", { priority: 0, lastUsedAt: "2026-01-03T00:00:00Z" }), conn("b", { priority: 9, lastUsedAt: "2026-01-02T00:00:00Z" })];
    expect((await getProviderCredentials("openai", null, "m")).connectionId).toBe("b");
  });
});
