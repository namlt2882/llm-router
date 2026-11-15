import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/providers/registry/index.js", () => ({
  default: [
    {
      id: "glm",
      transports: [
        { format: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
        { format: "claude", baseUrl: "https://api.z.ai/api/anthropic/v1/messages" },
      ],
    },
    { id: "nogpt", transports: [{ format: "claude", baseUrl: "https://x/api/messages" }] },
  ],
}));

const { rampLevels, probeConnectionModel, makeDefaultDispatch } = await import("../../src/lib/fork/capacity/probe.js");

// Fake upstream: every call in a level is in flight together (the sync
// prefix of each dispatch runs before the first await resumes), so the
// position a call sees IS its 1-based concurrency. `fail(position)` lets a
// test shape what over-limit looks like.
const fakeUpstream = ({ limit = Infinity, fail }) => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const dispatch = async () => {
    calls += 1;
    active += 1;
    const position = active;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (position > limit) return fail ? fail(position) : { ok: false, status: 429, bodyText: "rate limit" };
    return { ok: true };
  };
  dispatch.peak = () => peak;
  dispatch.calls = () => calls;
  return dispatch;
};

const TASK = { provider: "glm", connection: { id: "c1" }, model: "m" };

describe("rampLevels", () => {
  it("doubles 1→32 and truncates at maxLevel", () => {
    expect(rampLevels()).toEqual([1, 2, 4, 8, 16, 32]);
    expect(rampLevels(8)).toEqual([1, 2, 4, 8]);
    expect(rampLevels(5)).toEqual([1, 2, 4]);
  });
});

describe("probeConnectionModel", () => {
  it("true limit 5: ramp fails at 8, two refine steps confirm 5, peak never exceeds 8", async () => {
    const dispatch = fakeUpstream({ limit: 5 });
    const result = await probeConnectionModel({ ...TASK, dispatch });
    expect(result).toEqual({ status: "ok", budget: 5 });
    expect(dispatch.peak()).toBeLessThanOrEqual(8);
    expect(dispatch.peak()).toBeGreaterThanOrEqual(5); // it really reached 5
  });

  it("a key refused at level 1 classifies instead of reporting a budget (throttle)", async () => {
    const dispatch = fakeUpstream({ limit: 0, fail: () => ({ ok: false, status: 429, bodyText: "rate limit exceeded" }) });
    const result = await probeConnectionModel({ ...TASK, dispatch });
    expect(result.status).toBe("throttle");
    expect(result.reason).toContain("rate limit");
    expect(result.budget).toBeUndefined();
  });

  it("level-1 auth refusal reports status auth", async () => {
    const dispatch = fakeUpstream({ limit: 0, fail: () => ({ ok: false, status: 401, bodyText: "token expired" }) });
    expect((await probeConnectionModel({ ...TASK, dispatch })).status).toBe("auth");
  });

  it("level-1 z.ai 1113 reports balance, 1211 reports config", async () => {
    const balance = fakeUpstream({ limit: 0, fail: () => ({ ok: false, status: 429, bodyText: '{"code":"1113"}' }) });
    expect((await probeConnectionModel({ ...TASK, dispatch: balance })).status).toBe("balance");
    const config = fakeUpstream({ limit: 0, fail: () => ({ ok: false, status: 400, bodyText: '{"code":"1211"}' }) });
    expect((await probeConnectionModel({ ...TASK, dispatch: config })).status).toBe("config");
  });

  it("fetch-level network failures report unreachable", async () => {
    const dispatch = fakeUpstream({ limit: 0, fail: () => ({ ok: false, status: null, bodyText: "AbortError: The operation was aborted" }) });
    expect((await probeConnectionModel({ ...TASK, dispatch })).status).toBe("unreachable");
  });

  it("an unsupported provider type stops after one call", async () => {
    const dispatch = fakeUpstream({ limit: 0, fail: () => ({ ok: false, unsupported: true }) });
    const result = await probeConnectionModel({ ...TASK, dispatch });
    expect(result).toEqual({ status: "unsupported", reason: "provider type not supported for probing" });
    expect(dispatch.calls()).toBe(1);
  });

  it("a limit above maxLevel caps the budget at maxLevel", async () => {
    const dispatch = fakeUpstream({ limit: 40 });
    const result = await probeConnectionModel({ ...TASK, maxLevel: 32, dispatch });
    expect(result).toEqual({ status: "ok", budget: 32 });
    expect(dispatch.peak()).toBeLessThanOrEqual(32);
  });

  it("a 200 without choices counts as failure (budget 2)", async () => {
    const dispatch = fakeUpstream({
      limit: 2,
      fail: () => ({ ok: false, status: 200, bodyText: '{"error":"no choices"}' }),
    });
    expect(await probeConnectionModel({ ...TASK, dispatch })).toEqual({ status: "ok", budget: 2 });
  });

  it("a dispatch that rejects reads as a failed call, not a crash", async () => {
    const dispatch = async () => { throw new Error("socket hangup"); };
    expect((await probeConnectionModel({ ...TASK, dispatch })).status).toBe("unreachable");
  });
});

describe("makeDefaultDispatch", () => {
  const baseConn = { id: "c1", provider: "glm", authType: "apiKey", apiKey: "sk-1", providerSpecificData: {} };

  it("posts the probe body to the openai transport with a Bearer apiKey", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    const dispatch = makeDefaultDispatch({ fetchImpl });
    const result = await dispatch({ ...TASK, connection: baseConn, model: "glm-5.3-flash" });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 8, stream: false });
    expect(init.signal).toBeDefined();
  });

  it("prefers the connection's own baseUrl and falls back to accessToken", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const dispatch = makeDefaultDispatch({ fetchImpl });
    await dispatch({ ...TASK, connection: { id: "c2", provider: "glm", authType: "oauth", accessToken: "tok-9", providerSpecificData: { baseUrl: "https://relay.example/v4/chat/completions" } } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://relay.example/v4/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer tok-9");
  });

  it("a 200 without choices is a failed call carrying status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"no choices"}', { status: 200 }));
    const result = await makeDefaultDispatch({ fetchImpl })(TASK);
    expect(result).toEqual({ ok: false, status: 200, bodyText: '{"error":"no choices"}' });
  });

  it("a provider with no openai transport is unsupported (never fetched)", async () => {
    const fetchImpl = vi.fn();
    const result = await makeDefaultDispatch({ fetchImpl })({ provider: "nogpt", connection: baseConn, model: "m" });
    expect(result).toEqual({ ok: false, unsupported: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an unknown provider id is unsupported", async () => {
    const result = await makeDefaultDispatch({ fetchImpl: vi.fn() })({ provider: "acme", connection: baseConn, model: "m" });
    expect(result).toEqual({ ok: false, unsupported: true });
  });

  it("a fetch throw reads as a network failure", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    const result = await makeDefaultDispatch({ fetchImpl })(TASK);
    expect(result.status).toBe(null);
    expect(result.ok).toBe(false);
    expect(result.bodyText).toContain("ECONNREFUSED");
  });

  it("passes the dispatcher through to fetch when set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }));
    const dispatcher = { agent: "undici-proxy" };
    await makeDefaultDispatch({ fetchImpl, dispatcher })(TASK);
    expect(fetchImpl.mock.calls[0][1].dispatcher).toBe(dispatcher);
  });
});
