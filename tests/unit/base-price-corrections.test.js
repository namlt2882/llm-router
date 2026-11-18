import { describe, expect, it } from "vitest";
import { getPricingForModel, priceForPrompt } from "../../open-sse/providers/pricing.js";

// Official list prices, USD per 1M tokens (input / cached / output); cache write bills at input unless a case says otherwise.
// Several names used to fall to a vendor glob (glm-5*, grok-*, qwen*, MiniMax-*) and were priced as another model.
const flat = (input, cached, output, extra = {}) => ({ input, cached, output, reasoning: output, cache_creation: input, ...extra });

describe("base prices match the vendor list", () => {
  it.each([
    ["glm", "glm-5.1", flat(1.4, 0.26, 4.4)],
    ["glm", "glm-5.2", flat(1.4, 0.26, 4.4)],
    ["opencode-go", "glm/glm-5.1", flat(1.4, 0.26, 4.4)],
    ["opencode-go", "glm/glm-5.2", flat(1.4, 0.26, 4.4)],
    ["glm", "glm-5", flat(1, 0.2, 3.2)],
    ["glm", "glm-4.7", flat(0.6, 0.11, 2.2)],
    ["glm", "glm-4.6", flat(0.6, 0.11, 2.2)],
    ["glm", "glm-4.6v", flat(0.3, 0.05, 0.9)],
    ["glm", "glm-5-turbo", flat(1.2, 0.24, 4)],
    ["xai", "grok-4.6", flat(2, 0.5, 6)],
    ["xai", "grok-4.7", flat(2, 0.5, 6)],
    ["xai", "grok-4.5", flat(2, 0.3, 6)],
    ["minimax", "MiniMax-M3", flat(0.3, 0.06, 1.2)],
    ["minimax", "minimax-m3", flat(0.3, 0.06, 1.2)],
    ["minimax", "MiniMax-M2.7", flat(0.3, 0.06, 1.2)],
    ["minimax", "minimax-m2.7", flat(0.3, 0.06, 1.2)],
    ["minimax", "MiniMax-M2.5", flat(0.3, 0.03, 1.2)],
    ["minimax", "minimax-m2.5", flat(0.3, 0.03, 1.2)],
    ["kimi", "kimi-k2.5", flat(0.6, 0.1, 3)],
    ["kimi", "kimi-k2.6", flat(0.95, 0.16, 4)],
    ["qwen", "qwen3.5-plus", flat(0.4, 0.08, 2.4)],
    ["qwen", "qwen3.6-plus", flat(0.5, 0.1, 3)],
    ["qwen", "qwen3.7-plus", flat(0.4, 0.08, 1.6)],
    ["qwen", "qwen3.7-max", flat(2.5, 0.5, 7.5)],
    ["qwen", "qwen3.8-flash", flat(0.15, 0.03, 0.47)],
    ["qwen", "qwen3.8-max", flat(2, 0.25, 6)],
    // DeepSeek bills a peak rate; we price at the peak so a sale never sits under cost.
    ["deepseek", "deepseek-flash", flat(0.3, 0.006, 1.2)],
    ["deepseek", "deepseek-v4-flash", flat(0.3, 0.006, 1.2)],
    ["deepseek", "deepseek-v4.1-flash", flat(0.3, 0.006, 1.2)],
    ["deepseek", "deepseek-v4-pro", flat(1.32, 0.044, 3.96)],
  ])("%s %s", (provider, model, expected) => {
    expect(getPricingForModel(provider, model)).toMatchObject(expected);
  });

  it("keeps the short-context rate in the base row of a tiered model", () => {
    expect(getPricingForModel("anthropic", "claude-haiku-5-5")).toMatchObject({ input: 0.1, cached: 0.01, output: 0.5, cache_creation: 0.125 });
    expect(getPricingForModel("openai", "gpt-5.6-luna")).toMatchObject({ input: 0.2, cached: 0.02, output: 1.2 });
    expect(getPricingForModel("openai", "gpt-6-luna")).toMatchObject({ input: 0.1, cached: 0.01, output: 0.5 });
  });
});

describe("no served family falls to a wrong glob", () => {
  // A name that reaches a glob is priced as its vendor's generic model; these are the names the audit found doing so.
  it("glm-5.x, glm-4.x, grok-4.x and qwen3.x names above have exact rows", () => {
    const glob = getPricingForModel("glm", "glm-5-nonexistent");
    expect(glob).not.toBeNull();
    for (const m of ["glm-5.1", "glm-5.2", "qwen3.8-max"]) {
      expect(getPricingForModel("x", m)).not.toBe(getPricingForModel("x", `${m}-nonexistent`));
    }
  });
});

describe("suffixed variants of a tiered model keep its tiers", () => {
  it.each([
    ["qwen", "qwen3.6-plus-2026-02-01", 256_000, { input: 2, output: 6 }],
    ["qwen", "qwen3.7-plus-thinking", 256_000, { input: 1.2, output: 4.8 }],
    ["qwen", "qwen3.5-plus-latest", 256_000, { input: 0.5, output: 3 }],
    ["minimax", "Minimax-M3", 512_000, { input: 0.6, output: 2.4 }],
    ["minimax", "MiniMax-M3-highspeed", 512_000, { input: 0.6, output: 2.4 }],
    ["openai", "gpt-5.6-luna[1m]", 272_000, { input: 0.4, output: 1.8 }],
    ["openai", "gpt-6-luna[1m]", 272_000, { input: 0.2, output: 0.75 }],
    ["anthropic", "claude-haiku-5-5-thinking", 100_000, { input: 0.5, output: 2.5 }],
    ["anthropic", "claude-haiku-5-5[1m]", 100_000, { input: 0.5, output: 2.5 }],
  ])("%s %s steps up above %i", (provider, model, above, tier) => {
    const row = getPricingForModel(provider, model);
    expect(row, model).not.toBeNull();
    expect(row.tiers?.[0]?.above, model).toBe(above);
    expect(priceForPrompt(row, above + 1)).toMatchObject(tier);
  });
});
