import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCreds: vi.fn(), order: vi.fn() }));
const h = vi.hoisted(() => ({ settings: {}, combo: [] }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => h.settings,
  getCombos: async () => [{ name: "search-combo", kind: "webSearch", models: h.combo }],
}));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccessProvider: async () => null }));
vi.mock("@/sse/services/fanoutModels.js", () => ({
  orderModelsByHeadroom: mocks.order,
  orderFanoutAttempt: async ({ models, fanoutCtx, attempt }) => {
    if (!fanoutCtx) return { models, attemptOrdered: attempt };
    const ordered = await mocks.order({ models });
    return { models: ordered.models, attemptOrdered: attempt };
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getCreds,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: async () => true,
}));
vi.mock("open-sse/services/combo.js", () => ({
  getComboModelsFromData: (name, combos) => combos.find((c) => c.name === name)?.models || null,
  handleComboChat: async ({ models, handleSingleModel }) => handleSingleModel({ query: "x" }, models[0]),
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: async () => ({ success: true, response: new Response("{}") }) }));
vi.mock("@/sse/services/accountInflight.js", () => ({ releaseAccountSlot: vi.fn(), parsePriority: () => "background" }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));

const { handleSearch } = await import("../../src/sse/handlers/search.js");

const post = (model, headers = {}) => new Request("http://r/v1/search", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, query: "x" }),
});

beforeEach(() => {
  mocks.getCreds.mockReset();
  mocks.order.mockReset();
  h.combo = ["ollama-search", "tavily"];
  h.settings = { requireApiKey: false, comboStrategies: { "search-combo": { fallbackStrategy: "fanout", fanout: {} } } };
});

describe("search combo fanout", () => {
  it("threads fanout, session and priority into BOTH credential legs", async () => {
    // ollama-search owns no connection and reuses the `ollama` chat key (credentialFallback).
    mocks.order.mockResolvedValue({ models: h.combo, release: vi.fn() });
    mocks.getCreds.mockImplementation(async (p) => (p === "ollama" ? { connectionId: "acct", connectionName: "A", apiKey: "k", providerSpecificData: {} } : null));
    await handleSearch(post("search-combo", { "x-session-id": "s2" }));
    expect(mocks.order).toHaveBeenCalledTimes(1);
    for (const call of mocks.getCreds.mock.calls) {
      expect(call[3]).toMatchObject({ fanout: { enabled: true, budgets: {}, percent: 100 }, sessionId: "s2", wait: true });
    }
    // Exactly two calls: the head member and its `credentialFallback` leg. The
    // `handleComboChat` mock above attempts `models[0]` only, so `tavily` is
    // never reached — do not assert it (an earlier draft did, and would fail).
    expect(mocks.getCreds.mock.calls.map((c) => c[0])).toEqual(["ollama-search", "ollama"]);
  });

  it("passes fanout: null when the combo is not fanout", async () => {
    h.settings.comboStrategies = { "search-combo": { fallbackStrategy: "fallback" } };
    mocks.getCreds.mockResolvedValue({ connectionId: "acct", connectionName: "A", apiKey: "k", providerSpecificData: {} });
    await handleSearch(post("search-combo"));
    expect(mocks.order).not.toHaveBeenCalled();
    for (const call of mocks.getCreds.mock.calls) expect(call[3]).toMatchObject({ fanout: null });
  });
});
