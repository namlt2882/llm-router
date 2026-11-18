import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
const NAME = "cc/claude-sonnet-4-6";
const usd = (over = {}) => ({ name: NAME, kind: "model", unit: "usd", input: 3, output: 15, cached: 0.3, reasoning: 15, cacheCreation: 3.75, perImage: 0, ...over });

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

async function loadRoute({ fxFails = false } = {}) {
  vi.resetModules();
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json", ...(init.headers || {}) } }),
    },
  }));
  vi.doMock("@/lib/fx/fxRate.js", () => ({
    getFloorRate: async () => {
      if (fxFails) throw new Error("no fx");
      return { rate: 25000, stale: false, source: "test", pinned: false };
    },
  }));
  vi.doMock("@/lib/db/repos/pricingRepo.js", () => ({
    getPricingForModel: async (provider, model) =>
      provider === "cc" && model === "claude-sonnet-4-6" ? { input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 } : null,
  }));
  vi.doMock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => null }));
  const repo = await import("@/lib/db/repos/salePriceRepo.js");
  const route = await import("@/app/api/fork/saleprice/route.js");
  return { ...route, repo };
}

const req = (method, { token = "secret-token", body, query = "" } = {}) =>
  new Request(`http://router/api/fork/saleprice${query}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/api/fork/saleprice (USD)", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-saleprice-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    for (const m of ["@/lib/fx/fxRate.js", "@/lib/db/repos/pricingRepo.js", "@/lib/db/repos/combosRepo.js"]) vi.doUnmock(m);
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses without the admin bearer", async () => {
    const { GET, PUT, DELETE } = await loadRoute();
    expect((await GET(req("GET", { token: null }))).status).toBe(401);
    expect((await PUT(req("PUT", { token: null, body: {} }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { token: null, query: "?name=x" }))).status).toBe(401);
  });

  it("PUT without unit usd is 400 unit_required", async () => {
    const { PUT } = await loadRoute();
    const { unit, ...legacy } = usd();
    for (const body of [legacy, { ...usd(), unit: "vnd" }]) {
      const res = await PUT(req("PUT", { body }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "unit_required" });
    }
  });

  it("PUT at the floor is stored verbatim; one micro-unit under is 422 below_floor with the USD minimum", async () => {
    const { PUT, repo } = await loadRoute();
    const good = usd({ source: "markup", pct: 0 });
    expect((await PUT(req("PUT", { body: good }))).status).toBe(200);
    expect(await repo.getSalePrice(NAME)).toEqual(good);
    const low = await PUT(req("PUT", { body: usd({ input: 2.999999 }) }));
    expect(low.status).toBe(422);
    expect(await low.json()).toMatchObject({ error: "below_floor", field: "input", minimum: 3 });
  });

  it("PUT keeps only known fields: no restore or endsAt, and only the markup source", async () => {
    const { PUT, repo } = await loadRoute();
    const res = await PUT(req("PUT", { body: usd({ source: "markup", pct: 5, label: "ops", endsAt: 9e15, restore: usd(), junk: 1 }) }));
    expect(res.status).toBe(200);
    expect(await repo.getSalePrice(NAME)).toEqual(usd({ source: "markup", pct: 5, label: "ops" }));
    for (const source of ["promo", "other"]) {
      const bad = await PUT(req("PUT", { body: usd({ source }) }));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_source" });
    }
  });

  it("PUT above the USD ceiling is 422 too_high", async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(req("PUT", { body: usd({ input: 1_000_001 }) }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "too_high", field: "input", maximum: 1_000_000 });
  });

  it("DELETE removes a price", async () => {
    const { PUT, DELETE, GET } = await loadRoute();
    await PUT(req("PUT", { body: usd() }));
    expect((await DELETE(req("DELETE", { query: `?name=${encodeURIComponent(NAME)}` }))).status).toBe(200);
    expect((await (await GET(req("GET"))).json()).prices).toEqual([]);
  });

  it("GET list migrates a legacy credit row to USD, in the response and in the store", async () => {
    const { GET, repo } = await loadRoute();
    await repo.setSalePrice({ name: NAME, kind: "model", input: 75000, output: 375000, cached: 7500, reasoning: 375000, cacheCreation: 93750, perImage: 0 });
    const body = await (await GET(req("GET"))).json();
    expect(body.rate).toBe(25000);
    expect(body.prices).toHaveLength(1);
    expect(body.prices[0]).toMatchObject({ unit: "usd", input: 3, output: 15 });
    expect(await repo.getSalePrice(NAME)).toMatchObject({ unit: "usd", input: 3 });
    expect(body.flagged).toEqual([]);
  });

  it("flagged lists a stored USD row under the floor with the USD minimum", async () => {
    const { GET, repo } = await loadRoute();
    await repo.setSalePrice(usd({ input: 2.9 }));
    const { flagged } = await (await GET(req("GET"))).json();
    expect(flagged.map((f) => f.name)).toEqual([NAME]);
    expect(flagged[0].violation).toMatchObject({ field: "input", minimum: 3 });
  });

  it("GET ?name= migrates too and returns the USD row", async () => {
    const { GET, repo } = await loadRoute();
    await repo.setSalePrice({ name: NAME, kind: "model", input: 75000, output: 375000, cached: 7500, reasoning: 375000, cacheCreation: 93750, perImage: 0 });
    const { price } = await (await GET(req("GET", { query: `?name=${encodeURIComponent(NAME)}` }))).json();
    expect(price).toMatchObject({ unit: "usd", input: 3 });
  });

  it("GET list is 503 without a floor rate and leaves legacy rows alone", async () => {
    const { GET, repo } = await loadRoute({ fxFails: true });
    const legacy = { name: NAME, kind: "model", input: 75000, output: 375000, cached: 7500, reasoning: 375000, cacheCreation: 93750, perImage: 0 };
    await repo.setSalePrice(legacy);
    expect((await GET(req("GET"))).status).toBe(503);
    expect(await repo.getSalePrice(NAME)).toEqual(legacy);
  });
});
