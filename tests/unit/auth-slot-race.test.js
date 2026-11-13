import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ connections: [], onUpdate: null }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => h.connections,
  getSettings: async () => ({ fallbackStrategy: "spread" }),
  updateProviderConnection: vi.fn(async (id) => { h.onUpdate?.(id); }),
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
  isModelLockActive: () => false,
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
const {
  __resetAccountInflight,
  tryAcquireAccountSlot,
  getInflightCount,
} = await import("../../src/sse/services/accountInflight.js");

const conn = (id, priority) => ({
  id, provider: "openai", authType: "apiKey", apiKey: "k", isActive: true, priority,
});

beforeEach(() => {
  __resetAccountInflight();
  h.onUpdate = null;
  vi.unstubAllEnvs();
  h.connections = [conn("a", 1), conn("b", 2)];
});

describe("a lost slot race does not serve past the cap", () => {
  it("refuses with the retryable busy state instead of serving an account that is now full", async () => {
    vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "1");
    // Between choosing "a" and taking its slot, selection awaits the DB write
    // of lastUsedAt. Something else fills the account in that window.
    h.onUpdate = (id) => { if (id === "a") tryAcquireAccountSlot("a", 1); };

    const pick = await getProviderCredentials("openai", null, "m");

    expect(pick.connectionId).toBeUndefined();
    expect(pick.allRateLimited).toBe(true);
    expect(pick.lastErrorCode).toBe("account_busy");
    expect(getInflightCount("a")).toBe(1); // still only the other holder
  });
});
