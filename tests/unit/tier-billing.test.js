import { describe, expect, it } from "vitest";
import { actualCostCredits, maxTokensForBudget, createBudgetCut, fitBodyToAttempt, openAttempt } from "../../open-sse/utils/budget.js";

// Credits per 1M tokens; above 100K prompt tokens every token bills at the tier rate.
const SALE = {
  input: 1000, output: 4000, cached: 100, reasoning: 4000, cacheCreation: 1250,
  tiers: [{ above: 100_000, input: 2000, output: 8000, cached: 200, reasoning: 8000, cacheCreation: 2500 }],
};

describe("actualCostCredits with tiers", () => {
  it("a short prompt bills at the base rate", () => {
    expect(actualCostCredits({ prompt_tokens: 100_000, completion_tokens: 1_000 }, SALE)).toBe(100 + 4);
  });
  it("a long prompt bills every token at the tier rate, cached and output included", () => {
    // 50K uncached*2000 + 50K cached*200 + 1K output*8000 = 100 + 10 + 8
    expect(actualCostCredits({ prompt_tokens: 100_001, cached_tokens: 50_000, completion_tokens: 1_000 }, SALE)).toBe(Math.ceil(50_001 * 0.002 + 50_000 * 0.0002 + 1_000 * 0.008));
  });
  it("a row without tiers is unchanged", () => {
    const { tiers, ...flat } = SALE;
    expect(actualCostCredits({ prompt_tokens: 1_000_000, completion_tokens: 0 }, flat)).toBe(1000);
  });
});

describe("maxTokensForBudget with tiers", () => {
  it("uses the tier of the input tokens when the prompt is long", () => {
    // 200K input at 2000/M = 400; 500 credits left -> 100 / 8000 per M = 12,500 output tokens
    expect(maxTokensForBudget(500, SALE, 200_000, 0)).toBe(12_500);
  });
  it("uses the base rate for a short prompt", () => {
    // 50K input = 50 credits; 450 left / 4000 per M = 112,500
    expect(maxTokensForBudget(500, SALE, 50_000, 0)).toBe(112_500);
  });
});

describe("createBudgetCut with tiers", () => {
  it("cuts at the tier price for a long prompt", () => {
    const cut = createBudgetCut({ budgetCredits: 410, sale: SALE, inputTokens: 200_000 });
    expect(cut.onChunk({ completion_tokens: 1_000 })).toBe("continue");
    expect(cut.onChunk({ completion_tokens: 1_250 })).toBe("cut");
  });
});

describe("fitBodyToAttempt with tiers", () => {
  it("clamps with the long-prompt output rate", () => {
    const parent = { credits: 500, holdId: "h", sale: SALE, spent: 0 };
    const attempt = openAttempt(parent, { format: "openai", inputTokens: 200_000 });
    const { body } = fitBodyToAttempt({ model: "m", messages: [] }, "openai", attempt);
    expect(body.max_tokens).toBe(12_500);
  });
});

describe("the hold prices a prompt estimate that may undershoot the real count", () => {
  // credits per 1M tokens
  const SALE = { input: 1000, output: 5000, cached: 100, reasoning: 5000, cacheCreation: 1250,
    tiers: [{ above: 100_000, input: 5000, output: 25_000, cached: 500, reasoning: 25_000, cacheCreation: 6250 }] };

  it("priceForReserve takes the dearer of the tier at the estimate and at 1.25x the estimate", async () => {
    const { priceForReserve } = await import("../../open-sse/utils/priceTiers.js");
    expect(priceForReserve(SALE, 80_000)).toMatchObject({ input: 1000, output: 5000 });
    expect(priceForReserve(SALE, 80_001)).toMatchObject({ input: 5000, output: 25_000 });
    expect(priceForReserve(SALE, 120_000)).toMatchObject({ input: 5000 });
    expect(priceForReserve({ input: 1, output: 2 }, 5)).toEqual({ input: 1, output: 2 });
  });

  it("maxTokensForBudget clamps output at the dearer tier when the estimate is near the threshold", () => {
    const cap = maxTokensForBudget(1000, SALE, 90_000, 0);
    // 90k input at 5000 = 450, 550 left at 25000/M
    expect(cap).toBe(22_000);
    // the real prompt turns out 108k: every token at the tier; overshoot is only the input-count miss, not a 5x rate miss
    const billed = actualCostCredits({ prompt_tokens: 108_000, completion_tokens: cap }, SALE);
    expect(billed).toBeLessThanOrEqual(1000 + Math.ceil((18_000 * 5000) / 1e6));
  });

  it("the stream cut trips at the dearer rate while only the estimate is known, and at the real tier once the provider reports", () => {
    const est = createBudgetCut({ budgetCredits: 1000, sale: SALE, inputTokens: 90_000 });
    expect(est.onChunk({ completion_tokens: 23_000 })).toBe("cut");
    const real = createBudgetCut({ budgetCredits: 1000, sale: SALE, inputTokens: 90_000 });
    expect(real.onChunk({ prompt_tokens: 90_000, completion_tokens: 23_000 })).toBe("continue");
  });
});
