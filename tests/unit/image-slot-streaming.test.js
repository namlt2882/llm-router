/**
 * Fork patch #5, image surface: codex image generation returns a LIVE SSE
 * response (adapter.parseResponse → { sseResponse }), so the handler used to
 * release the account slot in a `finally` — i.e. before the client had read
 * a single byte. Four concurrent streams then looked like one in-flight.
 *
 * Drives the real handleImageGeneration and the real semaphore; only the
 * credential lookup, the core and the DB-backed helpers are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ coreResult: null }));

vi.mock("../../src/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProviderCredentials: async () => {
      const { tryAcquireAccountSlot } = await import("../../src/sse/services/accountInflight.js");
      tryAcquireAccountSlot("img-conn", 4);
      return { connectionId: "img-conn", connectionName: "img", providerSpecificData: {}, apiKey: "k" };
    },
    markAccountUnavailable: async () => ({ shouldFallback: false }),
    clearAccountError: async () => {},
    extractApiKey: () => "k",
    isValidApiKey: async () => true,
  };
});
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "gpt-image-1" }),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => ({}),
  enforceKeyAccess: async () => null,
}));
vi.mock("open-sse/handlers/imageProviders/index.js", () => ({
  getImageAdapter: () => ({ canUseCredentials: () => true }),
}));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: async () => h.coreResult,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: async () => {},
  checkAndRefreshToken: async (_p, c) => c,
}));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: async () => new Response("combo") }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: async () => {} }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
}));

const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { __resetAccountInflight, getInflightCount } = await import("../../src/sse/services/accountInflight.js");

const request = () =>
  new Request("http://x/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-image-1", prompt: "a cat" }),
  });

const sseBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

beforeEach(() => {
  __resetAccountInflight();
  h.coreResult = null;
});
afterEach(() => vi.clearAllMocks());

describe("image generation keeps the slot while an SSE body streams", () => {
  it("holds the slot until the returned stream is consumed", async () => {
    h.coreResult = { success: true, response: sseBody() };

    const response = await handleImageGeneration(request());
    expect(response.status).toBe(200);
    expect(getInflightCount("img-conn")).toBe(1);

    await response.text();
    expect(getInflightCount("img-conn")).toBe(0);
  });

  it("releases a non-streaming result once its body is read", async () => {
    h.coreResult = { success: true, response: Response.json({ data: [{ url: "u" }] }) };

    const response = await handleImageGeneration(request());
    expect(response.status).toBe(200);
    // Still transferring, so still in flight; the account frees on completion.
    expect(getInflightCount("img-conn")).toBe(1);
    await response.text();
    expect(getInflightCount("img-conn")).toBe(0);
  });
});
