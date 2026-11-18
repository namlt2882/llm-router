import { describe, expect, it } from "vitest";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

// docs.z.ai/guides/overview/pricing (USD per 1M tokens): the glob "glm-5*" priced these at glm-5's $1 / $4.
describe("GLM 5.3 base pricing", () => {
  it.each([
    ["glm-5.3", { input: 1.4, output: 4.4, cached: 0.26 }],
    ["glm-5.3-flash", { input: 0.15, output: 0.5, cached: 0.03 }],
    ["glm-5.3-flashx", { input: 0.37, output: 1.25, cached: 0.075 }],
  ])("%s uses its own list price", (model, expected) => {
    expect(getPricingForModel("glm", model)).toMatchObject(expected);
    expect(getPricingForModel("opencode-go", `glm/${model}`)).toMatchObject(expected);
  });

  it("keeps glm-5 on its own price", () => {
    expect(getPricingForModel("glm", "glm-5")).toMatchObject({ input: 1, output: 4, cached: 0.5 });
  });
});
