import { describe, expect, it, vi } from "vitest";

// Review finding 1 (final review): a shim member-output failure (the model
// answered prose, or the reply truncated past max_tokens and stopped being
// JSON) is a property of the MODEL, never the credential. Before this rule it
// fell through to the default transient arm: markAccountUnavailable wrote a
// 30 s modelLock_<model> + testStatus "unavailable" on a healthy connection —
// locking its CHAT traffic too — and nothing on the systemone path ever
// cleared it; the combo loop additionally slept the cooldown before advancing.
// `systemone-shim:` in the error text is the marker. The wrapped shape
// ("[glm/glm-5.3-flash] systemone-shim: …") is what the combo loop extracts
// from the response body — both must classify the same way.

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

describe("checkFallbackError: systemone shim member-output failures", () => {
  it("classifies a bare shim error as request-scoped, no cooldown", () => {
    const r = checkFallbackError(502, "systemone-shim: member glm/glm-5.3-flash returned no JSON object", 0, "glm");
    expect(r).toMatchObject({ shouldFallback: false, requestScoped: true, cooldownMs: 0 });
  });
  it("classifies the combo-wrapped shape the same way", () => {
    const r = checkFallbackError(502, "[glm/glm-5.3-flash] systemone-shim: member glm/glm-5.3-flash missing answer for question \"billing\"", 0, "glm");
    expect(r).toMatchObject({ shouldFallback: false, requestScoped: true, cooldownMs: 0 });
  });
  it("does not swallow unrelated transient 502s", () => {
    const r = checkFallbackError(502, "upstream exploded", 0, "glm");
    expect(r.shouldFallback).toBe(true);
    expect(r.requestScoped).toBeUndefined();
  });
});

// The shim branch must also forward onRequestSuccess: the caller's closure
// clears stale account errors, and a successful shim call is a success — the
// health signal it emits must clear what an earlier failure wrote.
const shimMocks = vi.hoisted(() => ({ shim: vi.fn() }));
vi.mock("open-sse/handlers/systemoneShim.js", () => ({ handleSystemoneShim: shimMocks.shim, validateSystemoneAnswers: vi.fn() }));

const { handleSystemoneCore } = await import("../../open-sse/handlers/systemoneCore.js");

describe("handleSystemoneCore: the shim branch forwards onRequestSuccess", () => {
  const call = () => {
    const onRequestSuccess = vi.fn(async () => {});
    const res = handleSystemoneCore({
      body: { state: "s", questions: {} },
      modelInfo: { provider: "openai", model: "gpt-5.4" },   // resolves "shim"
      credentials: { apiKey: "k" },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      onRequestSuccess,
    });
    return { onRequestSuccess, res };
  };

  it("calls it when the shim succeeds", async () => {
    shimMocks.shim.mockResolvedValueOnce({ success: true, response: new Response("{}", { status: 200 }) });
    const { onRequestSuccess, res } = call();
    await res;
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });
  it("does not call it when the shim fails", async () => {
    shimMocks.shim.mockResolvedValueOnce({ success: false, status: 502, response: new Response("{}", { status: 502 }) });
    const { onRequestSuccess, res } = call();
    await res;
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});
