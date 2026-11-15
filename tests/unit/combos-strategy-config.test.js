import { describe, expect, it } from "vitest";
import { mergeStrategyPatch } from "../../src/app/(dashboard)/dashboard/combos/strategy-config.js";

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

  // Strategy-value semantics (ruling 2026-11-15): the dropdown selects fanout;
  // the fanout key rides along only while the entry routes as fanout.
  it("stores the strategy value without requiring a fanout key", () => {
    expect(mergeStrategyPatch({}, { fallbackStrategy: "fanout" })).toEqual({ fallbackStrategy: "fanout" });
  });

  it("keeps budgets once the strategy is fanout", () => {
    const next = mergeStrategyPatch({ fallbackStrategy: "fanout" }, { fanout: { enabled: true, budgets: { a: 6 } } });
    expect(next).toEqual({ fallbackStrategy: "fanout", fanout: { enabled: true, budgets: { a: 6 } } });
  });

  it("drops the budgets and prunes when the strategy is switched away from fanout", () => {
    const cur = { fallbackStrategy: "fanout", fanout: { enabled: true, budgets: { a: 6 } } };
    expect(mergeStrategyPatch(cur, { fallbackStrategy: "fallback" })).toBe(null);
  });

  it("drops budgets when a legacy checkbox entry is switched to another strategy", () => {
    const cur = { fanout: { enabled: true, budgets: { a: 6 } } };
    expect(mergeStrategyPatch(cur, { fallbackStrategy: "roundrobin" })).toEqual({ fallbackStrategy: "roundrobin" });
  });

  it("a legacy checkbox entry survives a budget edit that leaves the strategy untouched", () => {
    const cur = { fanout: { enabled: true, budgets: { a: 1 } } };
    expect(mergeStrategyPatch(cur, { fanout: { enabled: true, budgets: { a: 5 } } }))
      .toEqual({ fanout: { enabled: true, budgets: { a: 5 } } });
  });
});
