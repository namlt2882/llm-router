import { describe, expect, it, vi } from "vitest";

const PEAK = Date.UTC(2026, 10, 18, 2);
const OFF = Date.UTC(2026, 10, 18, 5);
const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = {
  "cc/cheap": base(1),
  "ds/pro": { ...base(10), offPeak: { schedule: "deepseek", factor: 0.5 } },
};
const COMBOS = { mix: ["cc/cheap", "ds/pro"] };
const ctx = (rate = 25000) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});
const none = async () => null;
const stored = { name: "ds/pro", kind: "model", unit: "usd", input: 12, output: 48, cached: 1.2, reasoning: 48, cacheCreation: 15, perImage: 0 };

const loadEffective = () => (vi.resetModules(), import("@/lib/pricing/effectiveSalePrice.js"));
const loadValidate = () => (vi.resetModules(), import("@/lib/pricing/validateSalePrice.js"));

describe("auto price follows the band", () => {
  it("is the peak floor at peak and half of it off-peak, in credits", async () => {
    const { effectiveSalePrice } = await loadEffective();
    expect((await effectiveSalePrice("ds/pro", { stored: none, ctx: ctx(), now: PEAK })).input).toBe(250000);
    const off = await effectiveSalePrice("ds/pro", { stored: none, ctx: ctx(), now: OFF });
    expect(off).toMatchObject({ input: 125000, output: 500000, cached: 12500 });
  });

  it("at: null forces the peak price", async () => {
    const { effectiveSalePrice, effectiveUsdPrice } = await loadEffective();
    expect((await effectiveSalePrice("ds/pro", { stored: none, ctx: ctx(), now: OFF, at: null })).input).toBe(250000);
    expect((await effectiveUsdPrice("ds/pro", { stored: none, ctx: ctx(), now: OFF, at: null })).input).toBe(10);
  });

  it("a flat model is unaffected", async () => {
    const { effectiveUsdPrice } = await loadEffective();
    expect((await effectiveUsdPrice("cc/cheap", { stored: none, ctx: ctx(), now: OFF })).input).toBe(1);
  });

  it("a combo averages its members, each priced at the same time", async () => {
    const { effectiveUsdPrice } = await loadEffective();
    expect((await effectiveUsdPrice("mix", { stored: none, ctx: ctx(), now: PEAK })).input).toBe(5.5);
    expect((await effectiveUsdPrice("mix", { stored: none, ctx: ctx(), now: OFF })).input).toBe(3);
  });

  it("a hand-set stored row is identical in both bands", async () => {
    const { effectiveUsdPrice } = await loadEffective();
    const a = await effectiveUsdPrice("ds/pro", { stored: async () => stored, ctx: ctx(), now: PEAK });
    const b = await effectiveUsdPrice("ds/pro", { stored: async () => stored, ctx: ctx(), now: OFF });
    expect(b).toEqual(a);
    expect(b.input).toBe(12);
  });
});

describe("floor and validation stay on peak", () => {
  it("costFloor is peak without at and settled with at", async () => {
    const { costFloor } = await loadValidate();
    expect((await costFloor("ds/pro", "model", ctx())).floor.input).toBe(10);
    expect((await costFloor("ds/pro", "model", ctx(), { at: OFF })).floor.input).toBe(5);
    expect((await costFloor("ds/pro", "model", ctx(), { at: PEAK })).floor.input).toBe(10);
  });

  it("a price between the off-peak and peak floor is refused", async () => {
    const { validateSalePrice } = await loadValidate();
    const row = { name: "ds/pro", kind: "model", unit: "usd", input: 6, output: 40, cached: 1, reasoning: 40, cacheCreation: 12.5 };
    expect(await validateSalePrice(row, ctx())).toMatchObject({ ok: false, field: "input", minimum: 10 });
    expect(await validateSalePrice({ ...row, input: 10 }, ctx())).toEqual({ ok: true });
  });
});
