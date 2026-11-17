
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveUsageMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveUsageMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : vi.fn()) })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  // chatCore also imports these (fb543a1f); a mock missing them fails the import.
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: saveUsageMock,
}));


const SALE = { input: 1000, output: 4000, cached: 100, reasoning: 4000, cacheCreation: 1250, perImage: 0 };
const enc = new TextEncoder();

function makeOptions(budgetParent, extra = {}, bodyExtra = {}) {
  const body = { model: "deepseek-chat", messages: [{ role: "user", content: "hello" }], ...bodyExtra };
  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    budgetParent,
    ...extra,
  };
}
const parent = (credits = 4) => ({ credits, holdId: "hold-1", sale: SALE, spent: 0 });
const jsonResult = (usage) => ({
  response: new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage }), { status: 200, headers: { "content-type": "application/json" } }),
  url: "http://upstream", headers: {}, transformedBody: {},
});
const sseResult = (chunks) => ({
  response: new Response(new ReadableStream({ start(c) { for (const l of chunks) c.enqueue(enc.encode(l)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  url: "http://upstream", headers: {}, transformedBody: {},
});
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe("chatCore under a WaveBot budget (fork patch #26)", { timeout: 20_000 }, () => {
  // chatCore's module graph is slow to import under full-suite load; pay for it once, outside any test,
  // so a slow import cannot time a test out and leak its late executor call into the next test.
  beforeAll(async () => {
    await import("../../open-sse/handlers/chatCore.js");
  }, 120_000);

  beforeEach(() => {
    executeMock.mockReset();
    saveUsageMock.mockClear();
  });

  it("clamps the output cap the executor sees to what the budget buys", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue(jsonResult({ prompt_tokens: 3, completion_tokens: 5 }));
    await handleChatCore(makeOptions(parent(4), {}, { max_tokens: 90000 }));
    const sent = executeMock.mock.calls[0][0].body;
    const cap = sent.max_tokens ?? sent.max_completion_tokens;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(1000);
  });

  it("refuses with 402 ai_credit_exhausted, success:true (no cooldown) and never calls upstream", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const p = parent(1);
    const result = await handleChatCore(makeOptions(p, {}, { messages: [{ role: "user", content: "x".repeat(30_000_000) }] }));
    expect(executeMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(402);
    expect((await result.response.json()).error.code).toBe("ai_credit_exhausted");
    expect(p.reserved || 0).toBe(0);
  });

  it("non-stream success carries the cost and hold id headers and records them on the usage row", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue(jsonResult({ prompt_tokens: 100_000, completion_tokens: 10_000 }));
    const p = parent(500);
    const result = await handleChatCore(makeOptions(p));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("x-wavebot-cost-credits")).toBe("140");
    expect(result.response.headers.get("x-wavebot-hold-id")).toBe("hold-1");
    expect(p.spent).toBe(140);
    expect(p.reserved || 0).toBe(0);
    const row = saveUsageMock.mock.calls.map((c) => c[0]).find((r) => r.holdId);
    expect(row).toMatchObject({ holdId: "hold-1", costCredits: "140" });
  });

  it("a stream is cut at the budget, ends with length and a stamped cost, and releases the attempt", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const chunks = [];
    for (let i = 0; i < 60; i++) chunks.push(sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x".repeat(300) }, finish_reason: null }] }));
    chunks.push(sse({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 6000 } }));
    chunks.push("data: [DONE]\n\n");
    executeMock.mockResolvedValue(sseResult(chunks));
    const p = parent(4);
    const result = await handleChatCore(makeOptions(p, {}, { stream: true }));
    expect(result.success).toBe(true);
    const text = await result.response.text();
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    const last = events[events.length - 1];
    expect(last.choices[0].finish_reason).toBe("length");
    expect(last.wavebot_hold_id).toBe("hold-1");
    expect(last.wavebot_cost_credits).toBeLessThanOrEqual(4);
    expect(p.spent).toBe(last.wavebot_cost_credits);
    expect(p.reserved || 0).toBe(0);
  });

  it("a format that cannot be clamped fails closed with 400 budget_unsupported_format", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const opts = makeOptions(parent(10));
    opts.modelInfo = { provider: "kiro", model: "kiro-model" };
    const result = await handleChatCore(opts);
    expect(executeMock).not.toHaveBeenCalled();
    expect(result.response?.status).toBe(400);
  });

  it("without a budget the request is untouched (no max_tokens injected, no headers)", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockResolvedValue(jsonResult({ prompt_tokens: 1, completion_tokens: 1 }));
    const result = await handleChatCore(makeOptions(null));
    expect(executeMock.mock.calls[0][0].body.max_tokens).toBeUndefined();
    expect(result.response.headers.get("x-wavebot-cost-credits")).toBeNull();
  });
});
