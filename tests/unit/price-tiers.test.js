import { describe, expect, it } from "vitest";
import { calculateCostFromTokens, getPricingForModel, priceForPrompt } from "../../open-sse/providers/pricing.js";

const TIERED = {
  input: 1, cached: 0.1, output: 5, reasoning: 5, cache_creation: 1.25,
  tiers: [{ above: 100_000, input: 2, cached: 0.2, output: 10, reasoning: 10, cache_creation: 2.5 }],
};

describe("priceForPrompt", () => {
  it("returns the row unchanged when it has no tiers", () => {
    const flat = { input: 1, output: 2 };
    expect(priceForPrompt(flat, 5_000_000)).toBe(flat);
  });

  it("uses the base rate up to and including the threshold, the tier strictly above it", () => {
    expect(priceForPrompt(TIERED, 100_000)).toMatchObject({ input: 1, output: 5 });
    expect(priceForPrompt(TIERED, 100_001)).toMatchObject({ input: 2, cached: 0.2, output: 10, cache_creation: 2.5 });
  });

  it("picks the highest tier whose threshold is crossed and fills missing tier fields from the base", () => {
    const row = { input: 1, cached: 0.1, output: 5, tiers: [{ above: 200, input: 3 }, { above: 100, input: 2, output: 7 }] };
    expect(priceForPrompt(row, 150)).toMatchObject({ input: 2, output: 7, cached: 0.1 });
    expect(priceForPrompt(row, 250)).toMatchObject({ input: 3, output: 5, cached: 0.1 });
  });

  it("the result carries no tiers of its own", () => {
    expect(priceForPrompt(TIERED, 200_000).tiers).toBeUndefined();
  });
});

describe("calculateCostFromTokens with tiers", () => {
  it("bills every token of a long request at the tier rate", () => {
    const short = calculateCostFromTokens({ prompt_tokens: 100_000, completion_tokens: 1_000 }, TIERED);
    expect(short).toBeCloseTo(0.1 * 1 + 0.001 * 5, 9);
    const long = calculateCostFromTokens({ prompt_tokens: 200_000, cached_tokens: 100_000, completion_tokens: 1_000 }, TIERED);
    expect(long).toBeCloseTo(0.1 * 2 + 0.1 * 0.2 + 0.001 * 10, 9);
  });

  it("a flat row is unaffected", () => {
    const flat = { input: 1, output: 5 };
    expect(calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 0 }, flat)).toBeCloseTo(1, 9);
  });
});

describe("tier thresholds of the served models", () => {
  it.each([
    ["claude-haiku-5-5", 100_000, { input: 0.5, cached: 0.05, output: 2.5, cache_creation: 0.625 }],
    ["gpt-5.6-luna", 272_000, { input: 0.4, cached: 0.04, output: 1.8 }],
    ["gpt-6-luna", 272_000, { input: 0.2, cached: 0.02, output: 0.75 }],
    ["grok-4.5", 200_000, { input: 4, cached: 0.6, output: 12 }],
    ["grok-4.6", 200_000, { input: 4, cached: 1, output: 12 }],
    ["grok-4.7", 200_000, { input: 4, cached: 1, output: 12 }],
    ["MiniMax-M3", 512_000, { input: 0.6, cached: 0.12, output: 2.4 }],
    ["minimax-m3", 512_000, { input: 0.6, cached: 0.12, output: 2.4 }],
    ["qwen3.5-plus", 256_000, { input: 0.5, cached: 0.1, output: 3 }],
    ["qwen3.6-plus", 256_000, { input: 2, cached: 0.4, output: 6 }],
    ["qwen3.7-plus", 256_000, { input: 1.2, cached: 0.24, output: 4.8 }],
  ])("%s steps up above %i prompt tokens", (model, above, tier) => {
    const row = getPricingForModel("x", model);
    expect(priceForPrompt(row, above).input).toBe(row.input);
    expect(priceForPrompt(row, above + 1)).toMatchObject(tier);
  });
});
