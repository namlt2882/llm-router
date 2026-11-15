import { describe, expect, it } from "vitest";
import { mergeStrategyPatch, memberProviders, fanoutBudgetRows } from "../../src/app/(dashboard)/dashboard/combos/strategy-config.js";

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

describe("fanoutBudgetRows", () => {
  // Live-found defect (dev router 2026-11-15): a custom-endpoint member is
  // written with its DISPLAY prefix ("fnt/model-id") while the connection's
  // `provider` field is the full dynamic id ("openai-compatible-chat-<uuid>"),
  // so matching on provider alone never matched and the budget editor stayed
  // empty. A row must appear when the member prefix matches the connection's
  // provider id OR its providerSpecificData.prefix.
  const byName = {};
  it("matches custom-endpoint connections by their providerSpecificData prefix", () => {
    const providers = [
      { id: "a1", provider: "openai-compatible-chat-uuid-1", providerSpecificData: { prefix: "fnt" }, name: "fnt-a" },
      { id: "b1", provider: "openai-compatible-chat-uuid-1", providerSpecificData: { prefix: "fnt" }, name: "fnt-b" },
      { id: "w1", provider: "openai-compatible-chat-uuid-2", providerSpecificData: { prefix: "wvl" }, name: "wavelabs" },
    ];
    const rows = fanoutBudgetRows(providers, ["fnt/model-id"], byName);
    expect(rows.map((r) => r.id)).toEqual(["a1", "b1"]);
  });

  it("matches standard providers by their provider id", () => {
    const providers = [
      { id: "o1", provider: "openai", name: "oa" },
      { id: "c1", provider: "claude", name: "cl" },
    ];
    const rows = fanoutBudgetRows(providers, ["openai/gpt-4"], byName);
    expect(rows.map((r) => r.id)).toEqual(["o1"]);
  });

  it("returns no rows for plain model members", () => {
    const providers = [{ id: "o1", provider: "openai", name: "oa" }];
    expect(fanoutBudgetRows(providers, ["some-bare-model"], byName)).toEqual([]);
  });
});
