import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SALE = { name: "cc/cheap", kind: "model", input: 1000, output: 4000, cached: 100, reasoning: 5000, cacheCreation: 1250 };
const originalDataDir = process.env.DATA_DIR;
let tempDir;

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
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
    },
  }));
  vi.doMock("@/lib/fx/fxRate.js", () => ({ getFloorRate: async () => { if (fxFails) throw new Error("no fx"); return { rate: 25000, stale: false, source: "test", pinned: false }; } }));
  const repo = await import("@/lib/db/repos/salePriceRepo.js");
  await repo.setSalePrice(SALE);
  await repo.setSalePrice({ ...SALE, name: "cc/pic", perImage: 3 });
  return import("@/app/api/fork/quote/route.js");
}

const post = (body, { token = "secret-token" } = {}) =>
  new Request("http://router/api/fork/quote", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/fork/quote", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-quote-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/fx/fxRate.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the worst case ceil((in*input + max*output + reasoning*reasoning)/1e6) with the sale price and floor rate", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ model: "cc/cheap", inputTokens: 100_000, maxTokens: 10_000, reasoningAllowance: 2_000 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 100000*1000 + 10000*4000 + 2000*5000 = 150,000,000 / 1e6 = 150
    expect(body.creditsWorstCase).toBe(150);
    expect(body.fxHeadroom).toBe(1);
    expect(body.sale).toMatchObject({ input: 1000, output: 4000, cached: 100, reasoning: 5000, cacheCreation: 1250 });
    expect(body.floorRate).toBe(25000);
  });

  it("rounds a fractional worst case up", async () => {
    const { POST } = await loadRoute();
    const body = await (await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 0 }))).json();
    expect(body.creditsWorstCase).toBe(1);
  });

  it("adds the per-image price for attached images", async () => {
    const { POST } = await loadRoute();
    const body = await (await POST(post({ model: "cc/pic", inputTokens: 0, maxTokens: 0, images: 4 }))).json();
    expect(body.creditsWorstCase).toBe(12);
  });

  it("flags a promotion price with endsAt and belowFloor", async () => {
    const { POST } = await loadRoute();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    const endsAt = Date.now() + 3_600_000;
    await repo.setSalePrice({ ...SALE, name: "cc/promo", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1, source: "promo", endsAt, restore: null });
    const body = await (await POST(post({ model: "cc/promo", inputTokens: 1, maxTokens: 1 }))).json();
    expect(body.sale).toMatchObject({ endsAt });
    expect(body.sale.belowFloor).toBeUndefined();
  });

  it("marks a promotion under the cost floor as belowFloor", async () => {
    vi.doMock("@/lib/db/repos/pricingRepo.js", () => ({
      getPricingForModel: async () => ({ input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 }),
    }));
    vi.doMock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => null }));
    try {
      const { POST } = await loadRoute();
      const repo = await import("@/lib/db/repos/salePriceRepo.js");
      const endsAt = Date.now() + 3_600_000;
      await repo.setSalePrice({ ...SALE, name: "cc/promo", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1, source: "promo", endsAt, restore: null });
      const body = await (await POST(post({ model: "cc/promo", inputTokens: 1, maxTokens: 1 }))).json();
      expect(body.sale).toMatchObject({ endsAt, belowFloor: true });
    } finally {
      vi.doUnmock("@/lib/db/repos/pricingRepo.js");
      vi.doUnmock("@/lib/db/repos/combosRepo.js");
    }
  });

  it("prices a stored USD row in credits at the floor rate", async () => {
    const { POST } = await loadRoute();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    await repo.setSalePrice({ name: "cc/usd", kind: "model", unit: "usd", input: 1.2, output: 4.8, cached: 0.12, reasoning: 4.8, cacheCreation: 1.5, perImage: 0 });
    const body = await (await POST(post({ model: "cc/usd", inputTokens: 1000, maxTokens: 1000 }))).json();
    // 150 credits at the current rate + 1% headroom for a rate refresh before billing = ceil(151.5)
    expect(body.creditsWorstCase).toBe(152);
    expect(body.fxHeadroom).toBe(1.01);
    expect(body.sale).toMatchObject({ input: 30000, output: 120000, cached: 3000 });
    expect(body.sale.unit).toBeUndefined();
  });

  it("402 not_sellable for a stored USD row when there is no FX rate", async () => {
    const { POST } = await loadRoute({ fxFails: true });
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    await repo.setSalePrice({ name: "cc/usd", kind: "model", unit: "usd", input: 1.2, output: 4.8, cached: 0.12, reasoning: 4.8, cacheCreation: 1.5, perImage: 0 });
    const res = await POST(post({ model: "cc/usd", inputTokens: 1000, maxTokens: 1000 }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "not_sellable" });
  });

  it("marks an active USD promotion under the cost floor as belowFloor", async () => {
    vi.doMock("@/lib/db/repos/pricingRepo.js", () => ({
      getPricingForModel: async () => ({ input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 }),
    }));
    vi.doMock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => null }));
    try {
      const { POST } = await loadRoute();
      const repo = await import("@/lib/db/repos/salePriceRepo.js");
      const endsAt = Date.now() + 3_600_000;
      await repo.setSalePrice({ name: "cc/promo", kind: "model", unit: "usd", input: 2.9, output: 15, cached: 0.3, reasoning: 15, cacheCreation: 3.75, perImage: 0, source: "promo", endsAt, restore: null });
      const body = await (await POST(post({ model: "cc/promo", inputTokens: 1, maxTokens: 1 }))).json();
      expect(body.sale).toMatchObject({ endsAt, belowFloor: true });
    } finally {
      vi.doUnmock("@/lib/db/repos/pricingRepo.js");
      vi.doUnmock("@/lib/db/repos/combosRepo.js");
    }
  });

  it("401 without the admin bearer", async () => {
    const { POST } = await loadRoute();
    expect((await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 1 }, { token: null }))).status).toBe(401);
    expect((await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 1 }, { token: "wrong" }))).status).toBe(401);
  });

  it("402 not_sellable for a model with no sale price", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ model: "no/such", inputTokens: 1, maxTokens: 1 }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "not_sellable" });
  });

  it("quotes an unset model at its auto price (base x floor rate) and flags it auto", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ model: "cc/claude-sonnet-4-6", inputTokens: 1_000_000, maxTokens: 0 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // base input $3 per 1M x rate 25000
    expect(body.creditsWorstCase).toBe(75_750);
    expect(body.fxHeadroom).toBe(1.01);
    expect(body.sale).toMatchObject({ input: 75_000, output: 375_000, auto: true });
  });

  it("400 on malformed numbers or JSON", async () => {
    const { POST } = await loadRoute();
    for (const bad of [{ model: "cc/cheap", inputTokens: -1, maxTokens: 1 }, { model: "cc/cheap", inputTokens: 1, maxTokens: "x" }, { inputTokens: 1, maxTokens: 1 }, { model: "cc/cheap", inputTokens: 1e18, maxTokens: 1 }, "{nope"]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("POST /api/fork/quote with context tiers", () => {
  const TIERED = { name: "cc/tiered", kind: "model", unit: "usd", input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, perImage: 0,
    tiers: [{ above: 100_000, input: 2, output: 8, cached: 0.2, reasoning: 8, cacheCreation: 2.5 }] };
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-quote-tier-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/fx/fxRate.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reserves at the tier of the input size and returns the tiers in credits", async () => {
    const { POST } = await loadRoute();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    await repo.setSalePrice(TIERED);
    // The caller only estimates the prompt, so the hold uses the dearer of the tier at the input size and at 1.25x it.
    const short = await (await POST(post({ model: "cc/tiered", inputTokens: 80_000, maxTokens: 10_000 }))).json();
    const nearEdge = await (await POST(post({ model: "cc/tiered", inputTokens: 80_001, maxTokens: 10_000 }))).json();
    const long = await (await POST(post({ model: "cc/tiered", inputTokens: 100_001, maxTokens: 10_000 }))).json();
    expect(short.creditsWorstCase).toBe(Math.ceil(((80_000 * 25_000 + 10_000 * 100_000) / 1e6) * 1.01 - 1e-9));
    expect(nearEdge.creditsWorstCase).toBe(Math.ceil(((80_001 * 50_000 + 10_000 * 200_000) / 1e6) * 1.01 - 1e-9));
    expect(long.creditsWorstCase).toBe(Math.ceil(((100_001 * 50_000 + 10_000 * 200_000) / 1e6) * 1.01 - 1e-9));
    expect(long.sale.tiers).toEqual([{ above: 100_000, input: 50_000, output: 200_000, cached: 5_000, reasoning: 200_000, cacheCreation: 62_500 }]);
  });
});

describe("POST /api/fork/quote and the band", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-quote-band-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    vi.useRealTimers();
    dropAdapter();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/fx/fxRate.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("an auto-priced DeepSeek name reserves the peak figure even when called off-peak", async () => {
    const out = [];
    for (const at of [Date.UTC(2026, 10, 18, 2), Date.UTC(2026, 10, 18, 5)]) {
      const { POST } = await loadRoute();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      const body = await (await POST(post({ model: "deepseek/deepseek-v4-pro", inputTokens: 1_000_000, maxTokens: 0 }))).json();
      vi.useRealTimers();
      out.push(body.creditsWorstCase);
    }
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBeGreaterThan(30000);
  });
});
