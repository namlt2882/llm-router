// chat.js is the only place that knows the session identity when accounts are
// chosen, so it must hand it to selection AND re-pin the winner on success.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  pinSession: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_ctx, models) => models,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: "openai", model: m.split("/")[1] }),
  getComboModels: async () => null,
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
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

beforeEach(() => {
  mocks.getProviderCredentials.mockReset().mockResolvedValue({
    connectionId: "acct-1",
    connectionName: "A",
    authType: "apiKey",
    apiKey: "k",
    providerSpecificData: {},
    _connection: { id: "acct-1" },
  });
  mocks.handleChatCore.mockReset().mockImplementation(async ({ onRequestSuccess }) => {
    await onRequestSuccess();
    return { success: true, response: new Response("{}", { status: 200 }) };
  });
  mocks.pinSession.mockReset();
});

describe("chat session identity", () => {
  it("passes x-session-id to account selection and pins the winner on success", async () => {
    const request = new Request("http://router/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "conv:c1" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    await handleChat(request);
    expect(mocks.getProviderCredentials.mock.calls[0][3]).toMatchObject({
      requestedModel: "gpt-4o-mini",
      sessionId: "conv:c1",
      priority: "background",
      wait: true,
    });
    expect(mocks.pinSession).toHaveBeenCalledWith("openai", "conv:c1", "acct-1");
  });
});
