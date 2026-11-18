import { describe, expect, it } from "vitest";
import { ceil6, round6, toUsdRow, toCredits, defaultBase, DEFAULT_BASE_SETTING, FIELDS, TOKEN_FIELDS } from "@/lib/pricing/priceUnit.js";

const legacy = (over = {}) => ({
  name: "cc/cheap", kind: "model", input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250, perImage: 0, ...over,
});

describe("rounding", () => {
  it("ceil6 rounds up to 6 decimals and ignores float noise", () => {
    expect(ceil6(0.30000000000000004)).toBe(0.3);
    expect(ceil6(1 / 3)).toBe(0.333334);
    expect(ceil6(0.0000011)).toBe(0.000002);
  });
  it("round6 rounds to nearest 6 decimals", () => {
    expect(round6(1 / 3)).toBe(0.333333);
  });
});

describe("constants", () => {
  it("lists the fields and the factory default base", () => {
    expect(TOKEN_FIELDS).toEqual(["input", "output", "cached", "reasoning", "cacheCreation"]);
    expect(FIELDS).toEqual([...TOKEN_FIELDS, "perImage"]);
    expect(DEFAULT_BASE_SETTING).toEqual({ enabled: false, input: 0.05, cached: 0.005, output: 0.1 });
  });
});

describe("toUsdRow", () => {
  it("converts a legacy credit row to USD at the given rate", () => {
    const r = toUsdRow(legacy({ source: "markup", pct: 10 }), 25000);
    expect(r).toEqual({
      name: "cc/cheap", kind: "model", unit: "usd", input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, perImage: 0, source: "markup", pct: 10,
    });
  });

  it("rounds up so the USD value never undercuts the credit value", () => {
    expect(toUsdRow(legacy(), 25500).input).toBe(0.980393);
  });

  it("converts a nested legacy restore row and keeps a null restore", () => {
    const withRestore = toUsdRow(legacy({ source: "promo", endsAt: 5, restore: legacy({ input: 50000 }) }), 25000);
    expect(withRestore.restore).toMatchObject({ unit: "usd", input: 2, output: 4 });
    expect(toUsdRow(legacy({ source: "promo", endsAt: 5, restore: null }), 25000).restore).toBeNull();
  });

  it("returns a USD row as the same object and null as null", () => {
    const usd = { name: "cc/cheap", kind: "model", unit: "usd", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1, perImage: 0 };
    expect(toUsdRow(usd, 25000)).toBe(usd);
    expect(toUsdRow(null, 25000)).toBeNull();
  });
});

describe("toCredits", () => {
  it("converts a USD row to the credit-shaped row the billing path reads", () => {
    const usd = {
      name: "cc/cheap", kind: "model", unit: "usd", auto: true, input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, perImage: 0.002,
      source: "promo", endsAt: 5, restore: { name: "cc/cheap", unit: "usd", input: 9 },
    };
    expect(toCredits(usd, 25000)).toEqual({
      name: "cc/cheap", kind: "model", auto: true, source: "promo", endsAt: 5,
      input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250, perImage: 50,
    });
  });
});

describe("defaultBase", () => {
  it("maps the three configured prices to a snake_case base", () => {
    expect(defaultBase({ input: 0.05, cached: 0.005, output: 0.1 })).toEqual({
      input: 0.05, output: 0.1, cached: 0.005, reasoning: 0.1, cache_creation: 0.05,
    });
  });
});
