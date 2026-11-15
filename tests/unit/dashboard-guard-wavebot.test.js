// The WaveBot ticket exchange route is the one dashboard path reachable
// without a cookie — it is what MINTs the cookie. These tests pin both halves:
// the exchange route gets through, and every other dashboard path still
// redirects to /login exactly as before.
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  redirect: vi.fn((url) => ({ status: 307, url }),
  ),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: mocks.redirect,
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

function request(urlPath) {
  // NextRequest.nextUrl.pathname never carries the query string.
  const u = new URL(`http://router.test${urlPath}`);
  const pathname = u.pathname;
  return {
    nextUrl: { pathname, searchParams: u.searchParams },
    headers: new Headers({ host: "router.test" }),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://router.test${urlPath}`,
  };
}

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue({ requireLogin: true });
  mocks.verifyDashboardAuthToken.mockReset().mockResolvedValue(false);
  mocks.redirect.mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("WaveBot ticket mode guard", () => {
  it("lets the exchange route through without a cookie", async () => {
    const res = await proxy(request("/dashboard/auth/ticket?ticket=t"));
    expect(res).toBe(mocks.nextResponse);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still redirects an unauthenticated dashboard visit to /login", async () => {
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(307);
    expect(String(res.url)).toContain("/login");
  });

  it("publishes the auth mode route", async () => {
    vi.stubEnv("WAVEBOT_AUTH_URL", "");
    const res = await proxy(request("/api/auth/mode"));
    expect(res).toBe(mocks.nextResponse);
  });
});

describe("requireLogin=false does not open a ticket-gated router", () => {
  beforeEach(() => mocks.getSettings.mockResolvedValue({ requireLogin: false }));

  it("still sends an unauthenticated /dashboard visit to /login in WaveBot mode", async () => {
    vi.stubEnv("WAVEBOT_AUTH_URL", "http://wavebot.test");
    const res = await proxy(request("/dashboard"));
    expect(res.status).toBe(307);
    expect(String(res.url)).toContain("/login");
  });

  it("still refuses an unauthenticated provider API call in WaveBot mode", async () => {
    vi.stubEnv("WAVEBOT_AUTH_URL", "http://wavebot.test");
    const res = await proxy(request("/api/providers"));
    expect(res.status).toBe(401);
  });

  it("keeps stock behaviour outside WaveBot mode (the toggle still works)", async () => {
    vi.stubEnv("WAVEBOT_AUTH_URL", "");
    expect(await proxy(request("/dashboard"))).toBe(mocks.nextResponse);
  });
});

describe("fork admin API through the guard (patch #18)", () => {
  const withHeaders = (urlPath, headers) => {
    const r = request(urlPath);
    r.headers = new Headers({ host: "router.test", ...headers });
    return r;
  };

  it("lets the fork admin bearer reach /api/fork/limits without a cookie", async () => {
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "fork-secret");
    const res = await proxy(withHeaders("/api/fork/limits", { authorization: "Bearer fork-secret" }));
    expect(res).toBe(mocks.nextResponse);
  });

  it("lets the fork admin bearer reach /api/fork/load", async () => {
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "fork-secret");
    const res = await proxy(withHeaders("/api/fork/load", { authorization: "Bearer fork-secret" }));
    expect(res).toBe(mocks.nextResponse);
  });

  it("still refuses a wrong bearer and an anonymous call with 401", async () => {
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "fork-secret");
    expect((await proxy(withHeaders("/api/fork/limits", { authorization: "Bearer nope" }))).status).toBe(401);
    expect((await proxy(request("/api/fork/limits"))).status).toBe(401);
  });

  it("an unset token never matches an empty bearer", async () => {
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "");
    expect((await proxy(withHeaders("/api/fork/limits", { authorization: "Bearer " }))).status).toBe(401);
  });
});
