import { describe, expect, it } from "vitest";
import { classifyProbeError, PROVIDER_THROTTLE_CODES } from "../../src/lib/fork/capacity/classifyError.js";

describe("classifyProbeError", () => {
  it("z.ai 1305 overloaded reads as throttle", () => {
    expect(classifyProbeError({ provider: "glm", status: 429, bodyText: '{"error":{"code":"1305","message":"The service may be temporarily overloaded"}}' })).toBe("throttle");
  });

  it("z.ai 1113 insufficient balance reads as balance", () => {
    expect(classifyProbeError({ provider: "glm", status: 429, bodyText: '{"error":{"code":"1113","message":"Insufficient balance"}}' })).toBe("balance");
  });

  it("z.ai 1211 reads as config regardless of status", () => {
    expect(classifyProbeError({ provider: "glm", status: 400, bodyText: '{"error":{"code":"1211","message":"model not found"}}' })).toBe("config");
    expect(classifyProbeError({ provider: "glm", status: 500, bodyText: "code 1211" })).toBe("config");
  });

  it("z.ai 401 with token-expiry text reads as auth", () => {
    expect(classifyProbeError({ provider: "glm", status: 401, bodyText: "token expired" })).toBe("auth");
  });

  it("generic 429 without a provider code reads as throttle", () => {
    expect(classifyProbeError({ provider: "openai", status: 429, bodyText: "slow down" })).toBe("throttle");
    expect(classifyProbeError({ provider: "openai", status: 429, bodyText: "Too Many Requests" })).toBe("throttle");
    expect(classifyProbeError({ provider: "openai", status: 500, bodyText: "resource exhausted" })).toBe("throttle");
    expect(classifyProbeError({ provider: "openai", status: 500, bodyText: "The model is overloaded" })).toBe("throttle");
  });

  it("unmatched 5xx reads as throttle (conservative: never over-runs a budget)", () => {
    expect(classifyProbeError({ provider: "openai", status: 503, bodyText: "upstream error" })).toBe("throttle");
    expect(classifyProbeError({ provider: "openai", status: 500, bodyText: "internal error" })).toBe("throttle");
  });

  it("fetch-level failures read as network", () => {
    expect(classifyProbeError({ provider: "glm", status: null, bodyText: "AbortError: The operation was aborted" })).toBe("network");
    expect(classifyProbeError({ provider: "glm", status: undefined, bodyText: "fetch failed: ECONNREFUSED 1.2.3.4:443" })).toBe("network");
    expect(classifyProbeError({ provider: "openai", status: null, bodyText: "request timeout after 30000ms" })).toBe("network");
    expect(classifyProbeError({ provider: "openai", status: null, bodyText: "getaddrinfo ENOTFOUND api.example.com" })).toBe("network");
  });

  it("unknown provider with an unmatched 400 reads as throttle", () => {
    expect(classifyProbeError({ provider: "acme", status: 400, bodyText: "bad request" })).toBe("throttle");
  });

  it("provider-code auth beats generic status (403 with a throttle code stays provider-mapped first)", () => {
    // 1002 is in the z.ai auth family; a provider code match precedes generic status rules
    expect(classifyProbeError({ provider: "glm", status: 403, bodyText: '{"code":"1002"}' })).toBe("auth");
  });
});

describe("PROVIDER_THROTTLE_CODES", () => {
  it("enumerates the z.ai family the scan UI and docs advertise", () => {
    expect(PROVIDER_THROTTLE_CODES).toHaveProperty("glm");
    expect(PROVIDER_THROTTLE_CODES.glm["1305"]).toBe("throttle");
    expect(PROVIDER_THROTTLE_CODES.glm["1113"]).toBe("balance");
    expect(PROVIDER_THROTTLE_CODES.glm["1211"]).toBe("config");
    for (const code of ["1002", "1003"]) expect(PROVIDER_THROTTLE_CODES.glm[code]).toBe("auth");
    expect(PROVIDER_THROTTLE_CODES["glm-cn"]).toEqual(PROVIDER_THROTTLE_CODES.glm);
    expect(PROVIDER_THROTTLE_CODES["z.ai"]).toEqual(PROVIDER_THROTTLE_CODES.glm);
  });
});
