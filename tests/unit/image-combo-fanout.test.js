import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ order: vi.fn(), getCreds: vi.fn(), imgCore: vi.fn(), combo: vi.fn() }));
const h = vi.hoisted(() => ({ settings: {}, order: null, combo: [] }));

vi.mock("@/lib/localDb", () => ({ getSettings: async () => h.settings }));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null, enforceKeyAccess: async () => null }));
vi.mock("@/sse/services/fanoutModels.js", () => ({
  orderModelsByHeadroom: mocks.order,
  orderFanoutAttempt: async ({ models, comboName, sessionId, fanoutCtx, getModelInfo, attempt }) => {
    if (!fanoutCtx) return { models, attemptOrdered: attempt };
    const ordered = await mocks.order({ models, comboName, sessionId, fanoutCtx, getModelInfo });
    let released = false;
    return {
      models: ordered.models,
      attemptOrdered: async (b, m) => { try { return await attempt(b, m); } finally { if (!released) { released = true; ordered.release(); } } },
    };
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getCreds,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: m.split("/")[0], model: m.split("/").slice(1).join("/") }),
  getComboModels: async (m) => (m === "img-combo" ? h.combo : null),
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: (...args) => mocks.combo(...args),
}));
// The core is mocked because this suite is about routing. Task 3 adds a guard
// inside the real core (after the adapter check) that this mock deliberately
// does not model — the guard's own behaviour is pinned by
// tests/unit/image-capability.test.js and tests/unit/image-generation.test.js.
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.imgCore }));
// parsePriority stays REAL: the first case asserts `priority: "interactive"`
// arrives from the `x-wavebot-priority` header, which a stubbed parsePriority
// can never produce. accountInflight.js imports nothing, so importActual is free.
vi.mock("@/sse/services/accountInflight.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, releaseAccountSlot: vi.fn(), releaseSlotWithBody: (r) => r };
});

const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");

const req = (model, headers = {}) => new Request("http://r/v1/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, prompt: "p" }),
});

const okResponse = () => new Response("{}", { status: 200 });

beforeEach(() => {
  mocks.order.mockReset();
  mocks.getCreds.mockReset().mockResolvedValue({ connectionId: "acct", connectionName: "A", apiKey: "k", providerSpecificData: {} });
  mocks.imgCore.mockReset().mockResolvedValue({ success: true, response: okResponse() });
  // The mock loop: attempt the first member only, like the real one on a healthy lane.
  mocks.combo.mockReset().mockImplementation(async ({ models, handleSingleModel }) => handleSingleModel({ prompt: "p" }, models[0]));
  h.combo = ["openai/dall-e-3", "fal-ai/fal-ai/flux/dev"];
  h.settings = {
    requireApiKey: false,
    comboStrategies: { "img-combo": { fallbackStrategy: "fanout", fanout: { budgets: { acct: 2 }, percent: 80 } } },
  };
});

describe("image combo fanout", () => {
  it("orders members and threads fanout, session and priority into credential selection", async () => {
    const release = vi.fn();
    mocks.order.mockResolvedValue({ models: ["fal-ai/fal-ai/flux/dev", "openai/dall-e-3"], release });
    await handleImageGeneration(req("img-combo", { "x-session-id": "s1", "x-wavebot-priority": "interactive" }));
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.getCreds).toHaveBeenCalledWith("fal-ai", expect.anything(), "fal-ai/flux/dev",
      expect.objectContaining({ fanout: { enabled: true, budgets: { acct: 2 }, percent: 80 }, sessionId: "s1", priority: "interactive", wait: true }));
  });

  it("passes fanout: null for a non-fanout combo and never orders", async () => {
    h.settings.comboStrategies = { "img-combo": { fallbackStrategy: "fallback" } };
    await handleImageGeneration(req("img-combo"));
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.getCreds).toHaveBeenCalledWith("openai", expect.anything(), "dall-e-3",
      expect.objectContaining({ fanout: null, wait: true }));
  });

  it("releases the headroom reservation exactly once across several attempts", async () => {
    // Review Focus #6. One attempt cannot distinguish "released once" from
    // "released per attempt" — the real loop may try every member. Red today:
    // `release` is called 0 times because nothing orders.
    const release = vi.fn();
    mocks.order.mockResolvedValue({ models: ["fal-ai/fal-ai/flux/dev", "openai/dall-e-3"], release });
    mocks.combo.mockImplementation(async ({ models, handleSingleModel }) => {
      await handleSingleModel({}, models[0]);
      return handleSingleModel({}, models[1]);
    });
    await handleImageGeneration(req("img-combo"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("hands every member to the combo loop when none has a usable account", async () => {
    // `handleComboChat` is mocked to attempt only models[0], so credential calls
    // cannot show "every member was kept". Assert the LIST the loop received.
    mocks.order.mockResolvedValue({ models: h.combo, release: vi.fn() });
    mocks.getCreds.mockResolvedValue(null);          // no lane is usable
    await handleImageGeneration(req("img-combo"));
    expect(mocks.combo.mock.calls[0][0].models).toEqual(h.combo);
  });

  it("never reads the member's response body", async () => {
    const sentinel = { ok: true, body: { locked: true } };
    // Ordering now happens by default (beforeEach settings are fanout), so the
    // order mock must resolve or the handler never reaches the attempt below.
    mocks.order.mockResolvedValue({ models: h.combo, release: vi.fn() });
    mocks.imgCore.mockResolvedValue({ success: true, response: sentinel });
    await expect(handleImageGeneration(req("img-combo"))).resolves.toBe(sentinel);
  });
});
