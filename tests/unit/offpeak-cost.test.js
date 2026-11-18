import { describe, it, expect } from "vitest";
import { settleBand, priceAt } from "../../open-sse/utils/priceTiers.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";

const PEAK = Date.UTC(2026, 10, 18, 2);
const OFF = Date.UTC(2026, 10, 18, 5);
const OP = { schedule: "deepseek", factor: 0.5 };
const row = () => ({ input: 2, output: 8, offPeak: { ...OP }, tiers: [{ above: 100, input: 4 }] });

describe("settleBand", () => {
  it("returns a row without offPeak as the same object", () => {
    const flat = { input: 1, output: 2 };
    expect(settleBand(flat, OFF)).toBe(flat);
  });

  it("halves every field and tier off-peak and drops the offPeak key", () => {
    const r = settleBand(row(), OFF);
    expect(r.input).toBe(1);
    expect(r.output).toBe(4);
    expect(r.tiers[0].input).toBe(2);
    expect("offPeak" in r).toBe(false);
  });

  it("keeps the peak rates at peak and with no time", () => {
    for (const r of [settleBand(row(), PEAK), settleBand(row())]) {
      expect(r.input).toBe(2);
      expect(r.tiers[0].input).toBe(4);
      expect("offPeak" in r).toBe(false);
    }
  });
});

describe("priceAt", () => {
  it("applies the size tier first, then the band", () => {
    expect(priceAt(row(), { promptTokens: 101, at: OFF }).input).toBe(2);
    expect(priceAt(row(), { promptTokens: 101 }).input).toBe(4);
    expect(priceAt(row(), { promptTokens: 10, at: OFF }).input).toBe(1);
  });

  it.each([
    ["factor 0", { schedule: "deepseek", factor: 0 }],
    ["factor 2", { schedule: "deepseek", factor: 2 }],
    ["factor NaN", { schedule: "deepseek", factor: NaN }],
    ["factor -1", { schedule: "deepseek", factor: -1 }],
    ["unknown schedule", { schedule: "nope", factor: 0.5 }],
  ])("a bad offPeak (%s) prices at peak", (_n, offPeak) => {
    const r = priceAt({ ...row(), offPeak }, { promptTokens: 10, at: OFF });
    expect(r.input).toBe(2);
    expect(Number.isFinite(r.output)).toBe(true);
  });
});

describe("DeepSeek base rows", () => {
  it.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro"])("%s carries the schedule", (m) => {
    expect(getPricingForModel("deepseek", m).offPeak).toEqual(OP);
  });

  it.each(["deepseek-chat", "deepseek-reasoner"])("legacy %s stays flat", (m) => {
    expect(getPricingForModel("deepseek", m).offPeak).toBeUndefined();
  });

  it("v4-pro costs half off-peak and full at peak or with no time", () => {
    const p = getPricingForModel("deepseek", "deepseek-v4-pro");
    const t = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    expect(calculateCostFromTokens(t, p, OFF)).toBeCloseTo(0.66, 9);
    expect(calculateCostFromTokens(t, p, PEAK)).toBeCloseTo(1.32, 9);
    expect(calculateCostFromTokens(t, p)).toBeCloseTo(1.32, 9);
  });
});
