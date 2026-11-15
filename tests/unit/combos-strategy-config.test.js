import { describe, expect, it } from "vitest";
import { mergeStrategyPatch, memberProviders } from "../../src/app/(dashboard)/dashboard/combos/strategy-config.js";

describe("mergeStrategyPatch", () => {
  it("keeps an entry whose fanout is enabled even with default fallback strategy", () => {
    const next = mergeStrategyPatch({}, { fanout: { enabled: true, budgets: { a: 6 } } });
    expect(next).toEqual({ fanout: { enabled: true, budgets: { a: 6 } } });
  });

  it("drops a disabled fanout key and prunes the entry when nothing else remains", () => {
    const cur = { fallbackStrategy: "fallback", fanout: { enabled: true, budgets: {} } };
    expect(mergeStrategyPatch(cur, { fanout: null })).toBe(null);
  });

  it("keeps fusion extras when the fanout is removed", () => {
    const cur = { fallbackStrategy: "fusion", judgeModel: "j" };
    expect(mergeStrategyPatch(cur, { fanout: null })).toEqual({ fallbackStrategy: "fusion", judgeModel: "j" });
  });

  it("drops a stale disabled fanout object", () => {
    expect(mergeStrategyPatch({ fanout: { enabled: false } }, {})).toBe(null);
  });
});

describe("memberProviders", () => {
  // The page builds comboByName as name → models ARRAY (page.js:
  // Object.fromEntries(combos.map((c) => [c.name, c.models]))) — pin that shape.
  it("collects provider prefixes and recurses one nested combo", () => {
    const byName = { outer: ["inner", "other/gpt"], inner: ["openai/gpt-4"] };
    expect(memberProviders(["outer", "plain-model"], byName)).toEqual(new Set(["other", "openai"]));
  });

  it("also accepts name → {models} objects", () => {
    const byName = { outer: { models: ["openai/gpt-4"] } };
    expect(memberProviders(["outer"], byName)).toEqual(new Set(["openai"]));
  });

  it("is cycle-safe and depth-capped", () => {
    const byName = { a: ["b"], b: ["a"] };
    expect(memberProviders(["a"], byName)).toEqual(new Set());
  });
});
