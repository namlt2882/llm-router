import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const body = (message, code = "1308") => JSON.stringify({ error: { code, message } });
const LIMIT = "Usage limit reached for 5 hour. Your limit will reset at 2026-11-16 16:02:50";

describe("GLM 1308 usage-limit parseError", () => {
  it.each(["glm", "glm-cn"])("reads the reset time as UTC+8 on %s", (provider) => {
    const parsed = getExecutor(provider).parseError({ status: 429 }, body(LIMIT));
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("Usage limit reached");
    expect(parsed.resetsAtMs).toBe(new Date("2026-11-16T16:02:50+08:00").getTime());
  });

  it("accepts a numeric error code", () => {
    const parsed = getExecutor("glm").parseError({ status: 429 }, body(LIMIT, 1308));
    expect(parsed.resetsAtMs).toBe(Date.UTC(2026, 10, 16, 8, 2, 50));
  });

  it("leaves other 429s on the default path (no resetsAtMs)", () => {
    const parsed = getExecutor("glm").parseError({ status: 429 }, body("Rate limit, slow down", "1302"));
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("leaves a 1308 with no parseable time on the default path", () => {
    const parsed = getExecutor("glm").parseError({ status: 429 }, body("Usage limit reached"));
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("does not touch other providers", () => {
    const parsed = getExecutor("openai").parseError({ status: 429 }, body(LIMIT));
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});

describe("markAccountUnavailable with a GLM reset time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T03:02:50.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.getProviderConnections.mockResolvedValue([{ id: "glm-acct", backoffLevel: 3 }]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["glm", "glm-cn"])("locks %s until the stated reset, not capped at 30 minutes", async (provider) => {
    const resetsAtMs = Date.now() + 5 * 3600_000;
    await markAccountUnavailable("glm-acct", 429, LIMIT, provider, "glm-5.3-flash", resetsAtMs);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("glm-acct", expect.objectContaining({
      "modelLock_glm-5.3-flash": new Date(resetsAtMs).toISOString(),
      backoffLevel: 0,
      errorCode: 429,
    }));
  });

  it("still caps other providers at 30 minutes", async () => {
    await markAccountUnavailable("glm-acct", 429, "limit", "codex", "m", Date.now() + 5 * 3600_000);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("glm-acct", expect.objectContaining({
      "modelLock_m": new Date(Date.now() + 30 * 60_000).toISOString(),
    }));
  });
});
