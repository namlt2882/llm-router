// Fanout model spread: chat.js orders a fanout combo's models by lane headroom.
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
  order: vi.fn(),
  remember: vi.fn(),
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
vi.mock("@/sse/services/fanoutModels.js", () => ({
  orderModelsByHeadroom: mocks.order,
  rememberServedModel: mocks.remember,
  // chat.js now imports the shared wrapper (Task 1); reproduce it against
  // mocks.order so this file still pins ordering via the real call chain.
  orderFanoutAttempt: async ({ models, comboName, sessionId, fanoutCtx, getModelInfo, attempt, onServed }) => {
    if (!fanoutCtx) return { models, attemptOrdered: attempt };
    const ordered = await mocks.order({ models, comboName, sessionId, fanoutCtx, getModelInfo });
    let released = false;
    const release = () => { if (!released) { released = true; ordered.release(); } };
    const attemptOrdered = async (b, m) => {
      try {
        const result = await attempt(b, m);
        if (result?.ok && onServed) onServed(b, m);
        return result;
      } finally { release(); }
    };
    return { models: ordered.models, attemptOrdered };
  },
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

const chatRequest = (model, headers = {}) => new Request("http://router/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
});

let release;
beforeEach(() => {
  h.settings = { requireApiKey: false, comboStrategies: {} };
  h.combos = { wb: ["glm/a", "openai/b"] };
  release = vi.fn();
  for (const fn of [mocks.getProviderCredentials, mocks.handleComboChat, mocks.handleFusionChat, mocks.pinSession, mocks.remember]) fn.mockReset();
  mocks.order.mockReset().mockResolvedValue({ models: ["openai/b", "glm/a"], release });
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: "acct-1", connectionName: "A", authType: "apiKey", apiKey: "k",
    providerSpecificData: {}, _connection: { id: "acct-1" },
  });
  mocks.handleChatCore.mockReset().mockImplementation(async ({ onRequestSuccess }) => {
    await onRequestSuccess();
    return { success: true, response: new Response("{}", { status: 200 }) };
  });
});

describe("fanout model spread wiring", () => {
  it("a fanout combo hands handleComboChat the headroom-ordered models", async () => {
    h.settings.comboStrategies.wb = { fallbackStrategy: "fanout" };
    await handleChat(chatRequest("wb", { "x-session-id": "s1" }));
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(mocks.order.mock.calls[0][0]).toMatchObject({ models: ["glm/a", "openai/b"], comboName: "wb", sessionId: "s1" });
    expect(mocks.handleComboChat.mock.calls[0][0].models).toEqual(["openai/b", "glm/a"]);
  });

  it("the legacy fanout.enabled flag orders too", async () => {
    h.settings.comboStrategies.wb = { fanout: { enabled: true } };
    await handleChat(chatRequest("wb"));
    expect(mocks.order).toHaveBeenCalledTimes(1);
  });

  it.each(["fallback", "round-robin", "smart", undefined])("strategy %s is never reordered", async (s) => {
    h.settings.comboStrategies.wb = s ? { fallbackStrategy: s } : {};
    await handleChat(chatRequest("wb"));
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.handleComboChat.mock.calls[0][0].models).toEqual(["glm/a", "openai/b"]);
  });

  it("releases the reservation once the first attempt returns, and only once", async () => {
    h.settings.comboStrategies.wb = { fallbackStrategy: "fanout" };
    await handleChat(chatRequest("wb"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    expect(release).not.toHaveBeenCalled();
    await props.handleSingleModel({}, "openai/b");
    expect(release).toHaveBeenCalledTimes(1);
    await props.handleSingleModel({}, "glm/a");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases even when the first attempt throws", async () => {
    h.settings.comboStrategies.wb = { fallbackStrategy: "fanout" };
    mocks.handleChatCore.mockReset().mockRejectedValue(new Error("boom"));
    await handleChat(chatRequest("wb"));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/b").catch(() => {});
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("remembers the model that served the session on success only", async () => {
    h.settings.comboStrategies.wb = { fallbackStrategy: "fanout" };
    await handleChat(chatRequest("wb", { "x-session-id": "s1" }));
    const props = mocks.handleComboChat.mock.calls[0][0];
    await props.handleSingleModel({}, "openai/b");
    expect(mocks.remember).toHaveBeenCalledWith("wb", "s1", "openai/b");
    mocks.remember.mockClear();
    mocks.handleChatCore.mockReset().mockResolvedValue({ success: false, status: 503, error: "x", response: new Response("{}", { status: 503 }) });
    await props.handleSingleModel({}, "glm/a");
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});
