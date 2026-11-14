import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) =>
      new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ accountMaxInflight: null, upstreamWaitMs: null }),
  updateSettings: vi.fn(),
}));

const { GET } = await import("@/app/api/fork/load/route.js");
const inflight = await import("../../src/sse/services/accountInflight.js");

const req = (token) =>
  new Request("http://router/api/fork/load", { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  inflight.__resetAccountInflight();
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.stubEnv("ACCOUNT_MAX_INFLIGHT", "3");
});

describe("/api/fork/load", () => {
  it("rejects a request with no or wrong bearer with 401", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("nope"))).status).toBe(401);
  });

  it("load reports per-account inflight/limit and queued counts", async () => {
    inflight.tryAcquireAccountSlot("acct-a", 3);
    inflight.tryAcquireAccountSlot("acct-a", 3);
    inflight.tryAcquireAccountSlot("acct-b", 3);
    const w1 = inflight.waitForCapacity(inflight.createWaitTicket("interactive"), 5000);
    const w2 = inflight.waitForCapacity(inflight.createWaitTicket("background"), 5000);
    const w3 = inflight.waitForCapacity(inflight.createWaitTicket("background"), 5000);
    inflight.recordAccountBusy();

    const res = await GET(req("secret-token"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toEqual(
      expect.arrayContaining([
        { id: "acct-a", inflight: 2, limit: 3 },
        { id: "acct-b", inflight: 1, limit: 3 },
      ]),
    );
    expect(body.queued).toEqual({ interactive: 1, background: 2 });
    expect(body.oldestWaitMs).toBeGreaterThanOrEqual(0);
    expect(body.busy5m).toBe(1);
    inflight.__resetAccountInflight();
    await Promise.all([w1, w2, w3].map((p) => Promise.race([p, Promise.resolve()])));
  });
});
