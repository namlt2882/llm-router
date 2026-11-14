// Fork policy: `requireApiKey: false` must open /v1 at the PROXY layer too,
// not only inside the route handlers. The WaveBot dashboard is the one client;
// its server-side calls arrive from a container peer (not loopback, no CLI
// token, no API key) — stock upstream refuses those with
// "API key required for remote API access" regardless of the route-level
// setting, which is exactly the key the fork is removing.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
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

// Host is not loopback and there is no trusted-peer header: a remote peer,
// which is what every WaveBot container-to-container call looks like.
function request(urlPath) {
  const u = new URL(`http://router.test${urlPath}`);
  return {
    nextUrl: { pathname: u.pathname, searchParams: u.searchParams },
    headers: new Headers({ host: "router.test" }),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://router.test${urlPath}`,
  };
}

beforeEach(() => {
  mocks.getSettings.mockReset();
  mocks.validateApiKey.mockReset().mockResolvedValue(false);
  mocks.getConsistentMachineId.mockReset();
  mocks.verifyDashboardAuthToken.mockReset().mockResolvedValue(false);
  mocks.jsonResponse.mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("proxy honors the fork's requireApiKey:false for /v1", () => {
  it("lets a remote keyless request through when requireApiKey is false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, requireLogin: true });
    await expect(proxy(request("/v1/models"))).resolves.toBe(mocks.nextResponse);
    await expect(proxy(request("/v1/chat/completions"))).resolves.toBe(mocks.nextResponse);
  });

  it("still demands a key when requireApiKey is true or unreadable", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true, requireLogin: true });
    await expect(proxy(request("/v1/models"))).resolves.toEqual({
      status: 401,
      body: { error: "API key required for remote API access" },
    });
    // DB failure: fall through to stock behavior, never open by accident.
    mocks.getSettings.mockRejectedValue(new Error("db down"));
    await expect(proxy(request("/v1/models"))).resolves.toEqual({
      status: 401,
      body: { error: "API key required for remote API access" },
    });
  });
});
