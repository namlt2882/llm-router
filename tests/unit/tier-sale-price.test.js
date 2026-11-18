import { describe, expect, it } from "vitest";
import { costFloor, validateSalePrice } from "@/lib/pricing/validateSalePrice.js";
import { toCredits, toUsdRow } from "@/lib/pricing/priceUnit.js";
import { priceForPrompt } from "../../open-sse/utils/priceTiers.js";

const BASES = {
  "cc/tiered": { input: 1, output: 5, cached: 0.1, reasoning: 5, cache_creation: 1.25, tiers: [{ above: 100_000, input: 2, output: 10, cached: 0.2, reasoning: 10, cache_creation: 2.5 }] },
  "cc/other": { input: 3, output: 9, cached: 0.3, reasoning: 9, cache_creation: 3.75, tiers: [{ above: 200_000, input: 6, output: 18, cached: 0.6, reasoning: 18, cache_creation: 7.5 }] },
  "cc/flat": { input: 1, output: 4, cached: 0.1, reasoning: 4, cache_creation: 1.25 },
  "cc/sparse": { input: 2, output: 8, tiers: [{ above: 50_000, input: 4, output: 16 }] },
};
const COMBOS = { duo: ["cc/tiered", "cc/other"], mixed: ["cc/tiered", "cc/flat"] };
const ctx = { rate: 25000, baseFor: async (n) => BASES[n] ?? null, comboModels: async (n) => COMBOS[n] ?? null };

describe("costFloor with tiers", () => {
  it("a tiered model's floor carries its tiers in sale field names", async () => {
    const { floor } = await costFloor("cc/tiered", "model", ctx);
    expect(floor).toMatchObject({ input: 1, cached: 0.1, output: 5, cacheCreation: 1.25 });
    expect(floor.tiers).toEqual([{ above: 100_000, input: 2, cached: 0.2, output: 10, reasoning: 10, cacheCreation: 2.5 }]);
  });

  it("a flat model has no tiers key", async () => {
    expect((await costFloor("cc/flat", "model", ctx)).floor.tiers).toBeUndefined();
  });

  it("fills cached/reasoning/cache write fallbacks inside a tier too", async () => {
    const { floor } = await costFloor("cc/sparse", "model", ctx);
    expect(floor.tiers[0]).toMatchObject({ above: 50_000, input: 4, output: 16, cached: 4, reasoning: 16, cacheCreation: 4 });
  });

  it("a combo averages its members at every threshold of any member", async () => {
    const { floor } = await costFloor("duo", "combo", ctx);
    expect(floor).toMatchObject({ input: 2, output: 7 });
    // above 100K: tiered goes to 2/10, other still 3/9 -> 2.5 / 9.5 ; above 200K: 2/10 and 6/18 -> 4 / 14
    expect(floor.tiers.map((t) => [t.above, t.input, t.output])).toEqual([[100_000, 2.5, 9.5], [200_000, 4, 14]]);
  });

  it("a combo of a tiered and a flat member steps only where the tiered one does", async () => {
    const { floor } = await costFloor("mixed", "combo", ctx);
    expect(floor.tiers.map((t) => [t.above, t.input])).toEqual([[100_000, 1.5]]);
  });
});

describe("validateSalePrice with tiers", () => {
  const flatRow = (over) => ({ name: "cc/tiered", kind: "model", unit: "usd", input: 1, output: 5, cached: 0.1, reasoning: 5, cacheCreation: 1.25, ...over });
  const tiers = [{ above: 100_000, input: 2, output: 10, cached: 0.2, reasoning: 10, cacheCreation: 2.5 }];

  it("accepts the floor itself, tiers included", async () => {
    expect((await validateSalePrice(flatRow({ tiers }), ctx)).ok).toBe(true);
  });

  it("refuses a flat price that is under the long-prompt floor", async () => {
    const v = await validateSalePrice(flatRow(), ctx);
    expect(v).toMatchObject({ ok: false, field: "input", minimum: 2 });
  });

  it("refuses a tier priced under its floor", async () => {
    const low = [{ ...tiers[0], output: 9.99 }];
    expect(await validateSalePrice(flatRow({ tiers: low }), ctx)).toMatchObject({ ok: false, field: "output", minimum: 10 });
  });

  it("accepts a flat price at or above the top-tier floor", async () => {
    expect((await validateSalePrice(flatRow({ input: 2, output: 10, cached: 0.2, reasoning: 10, cacheCreation: 2.5 }), ctx)).ok).toBe(true);
  });

  it.each([
    ["not an array", "x"],
    ["a non-positive threshold", [{ above: 0, input: 2 }]],
    ["a duplicate threshold", [{ above: 5, input: 2 }, { above: 5, input: 3 }]],
    ["a negative rate", [{ above: 5, input: -1 }]],
    ["more than 8 tiers", Array.from({ length: 9 }, (_, i) => ({ above: i + 1 }))],
    ["a fractional threshold", [{ above: 1.5, input: 2 }]],
    ["a threshold past 100M tokens", [{ above: 100_000_001, input: 2 }]],
    ["a snake_case cache_creation key (sale rows use cacheCreation)", [{ above: 5, cache_creation: 0 }]],
    ["an unknown field", [{ above: 5, inptu: 2 }]],
  ])("rejects tiers that are %s", async (_, bad) => {
    expect(await validateSalePrice(flatRow({ tiers: bad }), ctx)).toMatchObject({ ok: false, field: "tiers", reason: "invalid" });
  });
});

describe("unit conversion scales tiers", () => {
  const usd = { name: "n", kind: "model", unit: "usd", input: 1, output: 5, tiers: [{ above: 10, input: 2, output: 10 }] };
  it("toCredits multiplies tier rates by the rate and keeps thresholds", () => {
    const c = toCredits(usd, 25000);
    expect(c.tiers).toEqual([{ above: 10, input: 50000, output: 250000 }]);
    expect(priceForPrompt(c, 11).input).toBe(50000);
  });
  it("toUsdRow divides a legacy credit row's tiers", () => {
    const back = toUsdRow({ name: "n", kind: "model", input: 25000, output: 125000, tiers: [{ above: 10, input: 50000, output: 250000 }] }, 25000);
    expect(back.tiers).toEqual([{ above: 10, input: 2, output: 10 }]);
  });
});
