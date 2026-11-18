import { describe, expect, it, vi } from "vitest";

const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = { "cc/cheap": base(1), "cc/dear": base(10) };
const COMBOS = { mixed: ["cc/cheap", "cc/dear"], loop: ["loop2"], loop2: ["loop"] };
const ctx = (rate = 25000) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});
const none = async () => null;

async function load() {
  vi.resetModules();
  return import("@/lib/pricing/effectiveSalePrice.js");
}

const usdRow = { name: "cc/cheap", kind: "model", unit: "usd", input: 1.2, output: 4.8, cached: 0.12, reasoning: 4.8, cacheCreation: 1.5, perImage: 0 };
const legacy = { name: "cc/cheap", kind: "model", input: 30000, output: 120000, cached: 3000, reasoning: 120000, cacheCreation: 37500, perImage: 0 };
const failing = async () => { throw new Error("no fx"); };

describe("effectiveSalePrice (credits)", () => {
  it("returns a stored legacy credit row untouched, even with a failing context", async () => {
    const { effectiveSalePrice } = await load();
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => legacy, ctx: ctx() })).toBe(legacy);
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => legacy, ctx: failing })).toBe(legacy);
  });

  it("converts a stored USD row to credits at the floor rate; null when the rate is unavailable", async () => {
    const { effectiveSalePrice } = await load();
    const p = await effectiveSalePrice("cc/cheap", { stored: async () => usdRow, ctx: ctx(25000) });
    expect(p).toMatchObject({ input: 30000, output: 120000, cached: 3000, reasoning: 120000, cacheCreation: 37500 });
    expect(p.unit).toBeUndefined();
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => usdRow, ctx: failing })).toBeNull();
  });

  it("derives a model price at base x rate when none is stored", async () => {
    const { effectiveSalePrice } = await load();
    expect(await effectiveSalePrice("cc/cheap", { stored: none, ctx: ctx(25000) })).toEqual({
      name: "cc/cheap", kind: "model", auto: true,
      input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250, perImage: 0,
    });
  });

  it("derives a combo price from the average of its members", async () => {
    const { effectiveSalePrice } = await load();
    const p = await effectiveSalePrice("mixed", { stored: none, ctx: ctx(25000) });
    expect(p).toMatchObject({ kind: "combo", auto: true, input: 137500, output: 550000, cached: 13750 });
  });

  it("null for an unknown model, a cyclic combo, or a failing context on the auto path", async () => {
    const { effectiveSalePrice } = await load();
    expect(await effectiveSalePrice("cc/unknown", { stored: none, ctx: ctx() })).toBeNull();
    expect(await effectiveSalePrice("loop", { stored: none, ctx: ctx() })).toBeNull();
    expect(await effectiveSalePrice("cc/cheap", { stored: none, ctx: failing })).toBeNull();
  });
});

describe("effectiveUsdPrice", () => {
  it("the auto combo price is never flagged by validateSalePrice at any rate", async () => {
    const { effectiveUsdPrice } = await load();
    const { validateSalePrice } = await import("@/lib/pricing/validateSalePrice.js");
    const c = ctx(25500);
    const p = await effectiveUsdPrice("mixed", { stored: none, ctx: c });
    expect(p).toMatchObject({ kind: "combo", unit: "usd", auto: true, input: 5.5, perImage: 0 });
    expect(await validateSalePrice(p, c)).toEqual({ ok: true });
  });

  it("returns a stored USD row as is, and converts a legacy row at the context rate", async () => {
    const { effectiveUsdPrice } = await load();
    expect(await effectiveUsdPrice("cc/cheap", { stored: async () => usdRow, ctx: ctx() })).toBe(usdRow);
    expect(await effectiveUsdPrice("cc/cheap", { stored: async () => legacy, ctx: ctx(25000) })).toMatchObject({ unit: "usd", input: 1.2, output: 4.8 });
  });

  it("null for a legacy row when there is no rate", async () => {
    const { effectiveUsdPrice } = await load();
    expect(await effectiveUsdPrice("cc/cheap", { stored: async () => legacy, ctx: failing })).toBeNull();
  });
});

describe("promotion expiry (USD)", () => {
  const restoreRow = { ...usdRow, input: 7.5 };
  const promo = (over) => ({ ...usdRow, input: 0.8, source: "promo", endsAt: 2000, restore: null, ...over });

  it("an active promotion sells as a credit row with source and endsAt", async () => {
    const { effectiveSalePrice } = await load();
    const p = await effectiveSalePrice("cc/cheap", { stored: async () => promo({}), ctx: ctx(25000), now: 1000 });
    expect(p).toMatchObject({ source: "promo", endsAt: 2000, input: 20000 });
  });

  it("an expired promotion falls back to its restore row (endsAt is exclusive)", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: restoreRow });
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: ctx(25000), now: 1000 })).toMatchObject({ input: 187500 });
  });

  it("an expired promotion with a null restore is sold at the auto price", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: null });
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: ctx(25000), now: 1000 })).toMatchObject({ auto: true, input: 25000 });
  });

  it("an expired promotion whose restore is a legacy row still resolves without a rate", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: legacy });
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: failing, now: 5000 })).toBe(legacy);
  });

  it("resolveStored passes null and non-promo rows through", async () => {
    const { resolveStored } = await load();
    expect(resolveStored(null, 1)).toBeNull();
    expect(resolveStored(usdRow, 1e15)).toBe(usdRow);
  });
});
