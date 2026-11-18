import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(async () => {}),
  coreCalledAt: 0,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "c1", connectionName: "c1" }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: async () => {
    mocks.coreCalledAt = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    return { success: true, response: new Response("{}"), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  },
}));

const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");

describe("System One usage is priced at the request start", () => {
  it("passes startedAt taken before the upstream call", async () => {
    const before = Date.now();
    const res = await handleSystemone(
      new Request("http://localhost/v1/systemone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", state: {}, questions: { q: {} } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    const { startedAt } = mocks.saveRequestUsage.mock.calls[0][0];
    expect(Number.isFinite(startedAt)).toBe(true);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(mocks.coreCalledAt);
  });
});
