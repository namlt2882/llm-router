import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ connections: [], locked: new Set() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => h.connections,
  getSettings: async () => ({ fallbackStrategy: "fill-first" }),
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
