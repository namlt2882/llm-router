// chat.js owns the combo expansion, so it must hand the combo's fanout config
// (raw settings object) to account selection. The nested rule: the INNERMOST
// combo's own config wins for its legs — an outer combo's fanout never leaks
// into an inner combo that did not opt in.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  pinSession: vi.fn(),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));
const h = vi.hoisted(() => ({ settings: {}, combos: {} }));

vi.mock("@/lib/localDb", () => ({ getSettings: async () => h.settings }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_ctx, models) => models,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    if (h.combos[m]) return { provider: null, model: m };
    const idx = m.indexOf("/");
    return idx > 0 ? { provider: m.slice(0, idx), model: m.slice(idx + 1) } : { provider: "openai", model: m };
  },
  getComboModels: async (m) => h.combos[m] || null,
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: () => new Set(),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/utils/sessionManager.js", () => ({
  resolveSessionIdentity: ({ headers }) => ({ sessionId: headers?.["x-session-id"] || null }),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: () => {} }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: async () => null,
  clearAntigravityStrikes: () => {},
}));
vi.mock("@/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => "k",
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/sessionPin.js", () => ({ pinSession: mocks.pinSession }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: async () => null }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const chatRequest = (model) => new Request("http://router/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
});

beforeEach(() => {
  h.settings = { requireApiKey: false, comboStrategies: {} };
  h.combos = {};
  for (const fn of [mocks.getProviderCredentials, mocks.handleComboChat, mocks.handleFusionChat, mocks.pinSession]) fn.mockReset();
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: "acct-1", connectionName: "A", authType: "apiKey", apiKey: "k",
    providerSpecificData: {}, _connection: { id: "acct-1" },
  });
  mocks.handleChatCore.mockReset().mockImplementation(async ({ onRequestSuccess }) => {
    await onRequestSuccess();
    return { success: true, response: new Response("{}", { status: 200 }) };
  });
});

const fanoutOf = () => mocks.getProviderCredentials.mock.calls[0][3].fanout;

describe("combo fanout threading", () => {
  it("combo fanout config reaches getProviderCredentials", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    h.settings.comboStrategies["fanout-combo"] = { fanout: { enabled: true, budgets: { c1: 9 } } };
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toEqual({ enabled: true, budgets: { c1: 9 }, percent: 100 });
  });

  it("combo without fanout passes fanout null", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toBe(null);
  });

  it("fusion callback threads the combo fanout config", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    h.settings.comboStrategies["fanout-combo"] = {
      fallbackStrategy: "fusion",
      fanout: { enabled: true, budgets: { c2: 3 } },
    };
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleFusionChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4", false);
    expect(fanoutOf()).toEqual({ enabled: true, budgets: { c2: 3 }, percent: 100 });
  });

  it("nested combo legs use the inner combo's own fanout config", async () => {
    h.combos["outer-c"] = ["inner-c"];
    h.combos["inner-c"] = ["openai/gpt-4"];
    h.settings.comboStrategies["outer-c"] = { fanout: { enabled: true, budgets: { c9: 1 } } };
    await handleChat(chatRequest("outer-c"));
    const outerProps = mocks.handleComboChat.mock.calls[0][0];
    await outerProps.handleSingleModel({}, "inner-c"); // member is itself a combo
    const innerProps = mocks.handleComboChat.mock.calls[1][0];
    await innerProps.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toBe(null); // inner did not opt in → outer's fanout must NOT leak

    mocks.getProviderCredentials.mockClear();
    h.settings.comboStrategies = { "inner-c": { fanout: { enabled: true, budgets: { c2: 3 } } } };
    await handleChat(chatRequest("outer-c"));
    const outerProps2 = mocks.handleComboChat.mock.calls[2][0];
    await outerProps2.handleSingleModel({}, "inner-c");
    const innerProps2 = mocks.handleComboChat.mock.calls[3][0];
    await innerProps2.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toEqual({ enabled: true, budgets: { c2: 3 }, percent: 100 });
  });

  it("plain single-model request never carries fanout", async () => {
    await handleChat(chatRequest("openai/gpt-4"));
    expect(mocks.getProviderCredentials.mock.calls[0][3].fanout ?? null).toBe(null);
  });

  // Strategy-value semantics (ruling 2026-11-15): the dropdown writes
  // fallbackStrategy: "fanout", not a checkbox. No `enabled` field required.
  it("strategy value fanout derives the ctx without an enabled flag", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    h.settings.comboStrategies["fanout-combo"] = { fallbackStrategy: "fanout", fanout: { budgets: { c1: 9 } } };
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toEqual({ enabled: true, budgets: { c1: 9 }, percent: 100 });
  });

  it("strategy value fanout with no budgets map derives an empty ctx", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    h.settings.comboStrategies["fanout-combo"] = { fallbackStrategy: "fanout" };
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toEqual({ enabled: true, budgets: {}, percent: 100 });
  });

  it("an unselected strategy with a stale disabled fanout passes null", async () => {
    h.combos["fanout-combo"] = ["openai/gpt-4"];
    h.settings.comboStrategies["fanout-combo"] = {
      fallbackStrategy: "fallback",
      fanout: { enabled: false, budgets: { c1: 9 } },
    };
    await handleChat(chatRequest("fanout-combo"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/gpt-4");
    expect(fanoutOf()).toBe(null);
  });
});
