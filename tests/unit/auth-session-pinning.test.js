import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connections: [],
  settings: { fallbackStrategy: "fill-first" },
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => h.connections,
  getSettings: async () => h.settings,
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
  isModelLockActive: (c, m) => Boolean(c.locked && (!c.lockedModel || c.lockedModel === m)),
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
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
const { getPinnedConnectionId, pinSession, __resetSessionPins } = await import(
  "../../src/sse/services/sessionPin.js"
);

const conn = (id, over = {}) => ({
  id,
  provider: "openai",
  authType: "apiKey",
  apiKey: "k",
  isActive: true,
  ...over,
});

beforeEach(() => {
  __resetSessionPins();
  h.connections = [conn("b", { priority: 1 }), conn("a", { priority: 2 })];
  h.settings = { fallbackStrategy: "fill-first" };
});

describe("session pinning", () => {
  it("keeps a session on the account its last success pinned, over fill-first priority", async () => {
    h.connections = [conn("b", { priority: 1 }), conn("a", { priority: 2 })];
    const first = await getProviderCredentials("openai", null, "m", { sessionId: "conv:c1" });
    expect(first.connectionId).toBe("b");

    // What the chat handler does after a success.
    pinSession("openai", "conv:c1", "b");
    h.connections = [conn("a", { priority: 0 }), conn("b", { priority: 1 })];
    const second = await getProviderCredentials("openai", null, "m", { sessionId: "conv:c1" });
    expect(second.connectionId).toBe("b");
    expect(getPinnedConnectionId("openai", "conv:c1")).toBe("b");
  });

  it("rotates immediately when the pinned account is model-locked", async () => {
    pinSession("openai", "conv:c1", "b");
    h.connections = [
      conn("a", { priority: 2 }),
      conn("b", { priority: 1, locked: true, lockedModel: "m" }),
    ];
    const pick = await getProviderCredentials("openai", null, "m", { sessionId: "conv:c1" });
    expect(pick.connectionId).toBe("a");
  });

  it("changes nothing for a caller without a session id", async () => {
    h.connections = [conn("b", { priority: 1 }), conn("a", { priority: 2 })];
    const pick = await getProviderCredentials("openai", null, "m");
    expect(pick.connectionId).toBe("b");
  });

  it("expires a pin after the TTL and caps the map", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      pinSession("openai", "s1", "b");
      expect(getPinnedConnectionId("openai", "s1")).toBe("b");
      vi.setSystemTime(2 * 60 * 60 * 1000 + 1);
      expect(getPinnedConnectionId("openai", "s1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
