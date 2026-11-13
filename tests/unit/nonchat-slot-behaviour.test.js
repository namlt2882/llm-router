import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork patch #5 acquired a per-account in-flight slot inside
 * getProviderCredentials but only the chat surface released it, so every
 * image/TTS/STT/search/embeddings/fetch/video call leaked one slot until the
 * ten-minute TTL and four of them wedged the account into `account_busy`.
 *
 * This drives the real TTS handler and the real semaphore, mocking only the
 * upstream core, and asserts the account is left free.
 */

const h = vi.hoisted(() => ({ credentials: null, coreResult: null, coreCalls: 0, coreThrow: null }));

vi.mock("../../src/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Use the REAL selection path? No — selection reads the DB. Take the same
    // slot the real function takes, then hand back fixed credentials, so this
    // test sees exactly the acquire/release contract the handlers rely on.
    getProviderCredentials: async () => {
      const { tryAcquireAccountSlot } = await import("../../src/sse/services/accountInflight.js");
      tryAcquireAccountSlot("conn-1", 4);
      return h.credentials;
    },
    markAccountUnavailable: async () => ({ shouldFallback: false }),
  };
});
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: async () => ({ provider: "minimax", model: "speech-2.8-hd" }), getComboModels: async () => null }));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => ({}),
  enforceKeyAccess: async () => null,
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  handleTtsCore: async () => { h.coreCalls += 1; if (h.coreThrow) throw h.coreThrow; return h.coreResult; },
}));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), request: vi.fn(), line: vi.fn() }));

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { __resetAccountInflight, getInflightCount } = await import("../../src/sse/services/accountInflight.js");

const request = () => new Request("http://x/v1/audio/speech", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "minimax/speech-2.8-hd", input: "hello" }),
});

beforeEach(() => {
  __resetAccountInflight();
  h.coreCalls = 0;
  h.coreThrow = null;
  h.credentials = {
    connectionId: "conn-1", connectionName: "acct", providerSpecificData: {},
  };
  h.coreResult = { success: true, response: new Response("audio") };
});
afterEach(() => vi.clearAllMocks());

describe("non-chat handlers give the in-flight slot back", () => {
  it("releases on success", async () => {
    const res = await handleTts(request());
    expect(res.status).toBe(200);
    expect(h.coreCalls).toBe(1);
    expect(getInflightCount("conn-1")).toBe(0);
  });

  it("releases when the upstream call fails terminally", async () => {
    h.coreResult = { success: false, status: 400, error: "bad input", response: new Response("bad", { status: 400 }) };
    await handleTts(request());
    expect(getInflightCount("conn-1")).toBe(0);
  });

  it("releases even when the core throws", async () => {
    h.coreThrow = new Error("boom");
    await expect(handleTts(request())).rejects.toThrow("boom");
    expect(getInflightCount("conn-1")).toBe(0);
  });
});
