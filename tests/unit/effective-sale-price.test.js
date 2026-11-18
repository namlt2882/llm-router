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

describe("effectiveSalePrice", () => {
  it("returns the stored sale price untouched when one is set", async () => {
    const { effectiveSalePrice } = await load();
    const stored = { name: "cc/cheap", kind: "model", input: 9, output: 9, cached: 9, reasoning: 9, cacheCreation: 9 };
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => stored, ctx: ctx() })).toBe(stored);
  });

  it("derives a model price at base x rate when none is stored", async () => {
    const { effectiveSalePrice } = await load();
    const p = await effectiveSalePrice("cc/cheap", { stored: none, ctx: ctx(25000) });
    expect(p).toEqual({
      name: "cc/cheap", kind: "model", auto: true,
      input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250, perImage: 0,
    });
  });

  it("derives a combo price from its dearest member", async () => {
    const { effectiveSalePrice } = await load();
    const p = await effectiveSalePrice("mixed", { stored: none, ctx: ctx(25000) });
    expect(p).toMatchObject({ kind: "combo", auto: true, input: 250000, output: 1000000 });
  });

  it("derived price passes validateSalePrice (never below the floor)", async () => {
    const { effectiveSalePrice } = await load();
    const { validateSalePrice } = await import("@/lib/pricing/validateSalePrice.js");
    const c = ctx(25500);
    const p = await effectiveSalePrice("mixed", { stored: none, ctx: c });
    expect(await validateSalePrice(p, c)).toEqual({ ok: true });
  });

  it("returns null for a model with no base pricing, a cyclic combo, or when the rate is unavailable", async () => {
    const { effectiveSalePrice } = await load();
    expect(await effectiveSalePrice("cc/unknown", { stored: none, ctx: ctx() })).toBeNull();
    expect(await effectiveSalePrice("loop", { stored: none, ctx: ctx() })).toBeNull();
    const failing = async () => { throw new Error("no fx"); };
    expect(await effectiveSalePrice("cc/cheap", { stored: none, ctx: failing })).toBeNull();
  });

  it("an explicit stored price still resolves when the rate is unavailable", async () => {
    const { effectiveSalePrice } = await load();
    const stored = { name: "cc/cheap", kind: "model", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1 };
    const failing = async () => { throw new Error("no fx"); };
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => stored, ctx: failing })).toBe(stored);
  });
});

describe("promotion expiry", () => {
  const cheapRow = { name: "cc/cheap", kind: "model", input: 5, output: 5, cached: 5, reasoning: 5, cacheCreation: 5, perImage: 0 };
  const restoreRow = { ...cheapRow, input: 7777 };
  const promo = (over) => ({ ...cheapRow, source: "promo", endsAt: 2000, restore: null, ...over });

  it("an active promotion row is returned untouched", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({});
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: ctx(), now: 1000 })).toBe(row);
  });

  it("an expired promotion falls back to its restore row (endsAt is exclusive)", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: restoreRow });
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: ctx(), now: 1000 })).toBe(restoreRow);
  });

  it("an expired promotion with a null restore is sold at the auto price", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: null });
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: ctx(25000), now: 1000 })).toMatchObject({ auto: true, input: 25000 });
  });

  it("an expired promotion resolves to its restore row even when the rate is unavailable", async () => {
    const { effectiveSalePrice } = await load();
    const row = promo({ endsAt: 1000, restore: restoreRow });
    const failing = async () => { throw new Error("no fx"); };
    expect(await effectiveSalePrice("cc/cheap", { stored: async () => row, ctx: failing, now: 5000 })).toBe(restoreRow);
  });

  it("resolveStored passes null and non-promo rows through", async () => {
    const { resolveStored } = await load();
    expect(resolveStored(null, 1)).toBeNull();
    expect(resolveStored(cheapRow, 1e15)).toBe(cheapRow);
  });
});
