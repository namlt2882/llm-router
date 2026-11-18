import { describe, expect, it, vi } from "vitest";

const BASES = {
  "cc/cheap": { input: 1, output: 4, cached: 0.1, reasoning: 4, cache_creation: 1.25 },
  "cl/free-model": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
};

async function ctxWith(setting) {
  vi.resetModules();
  vi.doMock("@/lib/fx/fxRate.js", () => ({ getFloorRate: async () => ({ rate: 25500 }) }));
  vi.doMock("@/lib/db/repos/pricingRepo.js", () => ({
    getPricingForModel: async (provider, model) => BASES[`${provider}/${model}`] ?? null,
  }));
  vi.doMock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => null }));
  vi.doMock("@/lib/db/repos/priceDefaultRepo.js", () => ({
    getPriceDefault: async () => ({ enabled: false, input: 0.05, cached: 0.005, output: 0.1, ...setting }),
  }));
  const { defaultContext } = await import("@/lib/pricing/validateSalePrice.js");
  return defaultContext();
}

describe("defaultContext default base", () => {
  it("off: a name with no base pricing has no base", async () => {
    const ctx = await ctxWith({ enabled: false });
    expect(await ctx.baseFor("cc/unknown")).toBeNull();
  });

  it("on: a name with no base pricing gets the configured default, flagged defaulted", async () => {
    const ctx = await ctxWith({ enabled: true });
    expect(await ctx.baseFor("cc/unknown")).toEqual({
      input: 0.05, output: 0.1, cached: 0.005, reasoning: 0.1, cache_creation: 0.05, defaulted: true,
    });
  });

  it("on: configured prices flow through (reasoning follows output, cache write follows input)", async () => {
    const ctx = await ctxWith({ enabled: true, input: 0.2, cached: 0.02, output: 0.4 });
    expect(await ctx.baseFor("cc/unknown")).toMatchObject({ input: 0.2, cached: 0.02, output: 0.4, reasoning: 0.4, cache_creation: 0.2 });
  });

  it("on: a real base always wins, including a real all-zero base", async () => {
    const ctx = await ctxWith({ enabled: true });
    expect(await ctx.baseFor("cc/cheap")).toEqual(BASES["cc/cheap"]);
    expect(await ctx.baseFor("cl/free-model")).toEqual(BASES["cl/free-model"]);
  });

  it("on: a name without a provider prefix is never given a default", async () => {
    const ctx = await ctxWith({ enabled: true });
    expect(await ctx.baseFor("mixed")).toBeNull();
  });

  it("carries the floor rate", async () => {
    expect((await ctxWith({ enabled: true })).rate).toBe(25500);
  });
});
