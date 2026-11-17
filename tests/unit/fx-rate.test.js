import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

const VCB_XML = `<ExrateList><Exrate CurrencyCode="EUR" Sell="29,057.60" /><Exrate CurrencyCode="USD" CurrencyName="US DOLLAR" Buy="25,520.00" Transfer="25,550.00" Sell="25,930.00" /></ExrateList>`;

function stubFetch(over = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    const key = u.includes("open.er-api") ? "er" : u.includes("jsdelivr") ? "cdn" : "vcb";
    if (over[key] === "fail") throw new Error("network down");
    if (over[key] === "html") return new Response("<html>Service unavailable</html>", { status: 200 });
    if (key === "er") return new Response(JSON.stringify({ result: "success", rates: { VND: 25747.080419 } }));
    if (key === "cdn") return new Response(JSON.stringify({ date: "2026-11-17", usd: { vnd: 25688.73818947 } }));
    return new Response(VCB_XML);
  });
}

async function load() {
  vi.resetModules();
  return import("@/lib/fx/fxRate.js");
}

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

beforeEach(() => {
  dropAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-fx-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  dropAdapter();
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("fx floor rate", () => {
  it("is the highest fresh source times 1.02", async () => {
    const { refreshFxRates, getFloorRate } = await load();
    await refreshFxRates({ fetchImpl: stubFetch(), now: T0 });
    const r = await getFloorRate(T0);
    expect(r.rate).toBeCloseTo(25930 * 1.02, 6);
    expect(r).toMatchObject({ stale: false, pinned: false, source: "vietcombank" });
  });

  it("skips a source that answers HTML and still uses the others", async () => {
    const { refreshFxRates, getFloorRate } = await load();
    await refreshFxRates({ fetchImpl: stubFetch({ vcb: "html" }), now: T0 });
    const r = await getFloorRate(T0);
    expect(r.rate).toBeCloseTo(25747.080419 * 1.02, 6);
    expect(r.source).toBe("open.er-api.com");
  });

  it("keeps the last known value when every source fails, and goes stale only after 72h", async () => {
    const { refreshFxRates, getFloorRate } = await load();
    await refreshFxRates({ fetchImpl: stubFetch(), now: T0 });
    const dead = stubFetch({ er: "fail", cdn: "fail", vcb: "html" });
    await refreshFxRates({ fetchImpl: dead, now: T0 + 71 * HOUR });
    const early = await getFloorRate(T0 + 71 * HOUR);
    expect(early.stale).toBe(false);
    expect(early.rate).toBeCloseTo(25930 * 1.02, 6);
    const late = await getFloorRate(T0 + 73 * HOUR);
    expect(late.stale).toBe(true);
    expect(late.rate).toBeCloseTo(25930 * 1.02, 6);
  });

  it("an active pin wins; an expired pin is ignored", async () => {
    const { refreshFxRates, getFloorRate, pinRate } = await load();
    await refreshFxRates({ fetchImpl: stubFetch(), now: T0 });
    await pinRate({ rate: 27000, expiresAt: T0 + 2 * HOUR });
    expect(await getFloorRate(T0 + HOUR)).toMatchObject({ rate: 27000, pinned: true, stale: false });
    const after = await getFloorRate(T0 + 3 * HOUR);
    expect(after.pinned).toBe(false);
    expect(after.rate).toBeCloseTo(25930 * 1.02, 6);
  });

  it("rejects an absurd pin and refuses to answer when no rate was ever fetched", async () => {
    const { getFloorRate, pinRate } = await load();
    await expect(pinRate({ rate: 12, expiresAt: T0 + HOUR })).rejects.toThrow(/rate/);
    await expect(getFloorRate(T0)).rejects.toThrow(/fx_rate_unavailable/);
  });

  it("maybeRefreshFxRates skips a second call inside the 6h interval", async () => {
    const { maybeRefreshFxRates } = await load();
    const f = stubFetch();
    await maybeRefreshFxRates({ fetchImpl: f, now: T0 });
    const first = f.mock.calls.length;
    await maybeRefreshFxRates({ fetchImpl: f, now: T0 + 5 * HOUR });
    expect(f.mock.calls.length).toBe(first);
    await maybeRefreshFxRates({ fetchImpl: f, now: T0 + 7 * HOUR });
    expect(f.mock.calls.length).toBe(first * 2);
  });
});

describe("/api/fork/fx", () => {
  async function loadRoute() {
    vi.resetModules();
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
    vi.doMock("next/server", () => ({
      NextResponse: {
        json: (body, init = {}) =>
          new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
      },
    }));
    return import("@/app/api/fork/fx/route.js");
  }
  const req = (method, { token, body } = {}) =>
    new Request("http://router/api/fork/fx", {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("refuses without the admin bearer", async () => {
    const { GET, PUT } = await loadRoute();
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await PUT(req("PUT", { body: {} }))).status).toBe(401);
  });

  it("PUT pins a rate and GET reports it", async () => {
    const { GET, PUT } = await loadRoute();
    const expiresAt = Date.now() + HOUR;
    const put = await PUT(req("PUT", { token: "secret-token", body: { pin: { rate: 26000, expiresAt } } }));
    expect(put.status).toBe(200);
    const got = await (await GET(req("GET", { token: "secret-token" }))).json();
    expect(got).toMatchObject({ rate: 26000, pinned: true });
  });

  it("PUT rejects a malformed body", async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(req("PUT", { token: "secret-token", body: { pin: { rate: "x" } } }));
    expect(res.status).toBe(400);
  });
});
