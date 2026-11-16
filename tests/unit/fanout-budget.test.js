import { describe, expect, it } from "vitest";
import { parseFanoutCtx, effectiveFanoutBudget, rankFanout, isFanoutEntry, fanoutCtxForEntry, detectedBudgetFor, effectiveBaseCap } from "../../src/sse/services/fanoutBudget.js";

describe("parseFanoutCtx", () => {
  it("returns null unless enabled is exactly true", () => {
    expect(parseFanoutCtx(null)).toBe(null);
    expect(parseFanoutCtx(undefined)).toBe(null);
    expect(parseFanoutCtx({})).toBe(null);
    expect(parseFanoutCtx({ enabled: false, budgets: { a: 3 } })).toBe(null);
    expect(parseFanoutCtx({ enabled: "true" })).toBe(null);
  });

  it("keeps only integer budgets >= 1", () => {
    expect(parseFanoutCtx({ enabled: true, budgets: { a: 6, b: 0, c: "3", d: 2.5, e: -1 } }))
      .toEqual({ budgets: { a: 6 }, percent: 100 });
  });

  it("allows an absent or empty budgets map", () => {
    expect(parseFanoutCtx({ enabled: true })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, budgets: {} })).toEqual({ budgets: {}, percent: 100 });
  });

  it("parses percent as an integer 1-100, defaulting to 100 on anything else", () => {
    expect(parseFanoutCtx({ enabled: true, percent: 80 })).toEqual({ budgets: {}, percent: 80 });
    expect(parseFanoutCtx({ enabled: true, percent: 1 })).toEqual({ budgets: {}, percent: 1 });
    expect(parseFanoutCtx({ enabled: true, percent: 100 })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, percent: 0 })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, percent: 150 })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, percent: "80" })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, percent: Number.NaN })).toEqual({ budgets: {}, percent: 100 });
    expect(parseFanoutCtx({ enabled: true, percent: 80.5 })).toEqual({ budgets: {}, percent: 100 });
  });
});

describe("effectiveFanoutBudget", () => {
  it("uses the per-connection budget when present, else the global limit", () => {
    const ctx = parseFanoutCtx({ enabled: true, budgets: { a: 6 } });
    expect(effectiveFanoutBudget(ctx, "a", 4)).toBe(6);
    expect(effectiveFanoutBudget(ctx, "unknown", 4)).toBe(4);
    expect(effectiveFanoutBudget(null, "a", 4)).toBe(4);
  });
});

describe("rankFanout", () => {
  const row = (over) => ({ id: "?", budget: 4, inflight: 0, backoffLevel: 0, lastUsedAt: "", priority: 999, ...over });

  it("ranks by headroom ratio, not absolute inflight", () => {
    const ranked = rankFanout([row({ id: "b", budget: 2, inflight: 1 }), row({ id: "a", budget: 8, inflight: 3 })]);
    expect(ranked.map((r) => r.id)).toEqual(["a", "b"]); // a: 0.625 free, b: 0.5 free
  });

  it("breaks a ratio tie by backoff, then oldest use, then priority", () => {
    const backoff = rankFanout([
      row({ id: "a", backoffLevel: 2, lastUsedAt: "2026-01-01T00:00:00Z" }),
      row({ id: "b", backoffLevel: 0, lastUsedAt: "2026-01-02T00:00:00Z" }),
    ]);
    expect(backoff[0].id).toBe("b");
    const recency = rankFanout([
      row({ id: "a", lastUsedAt: "2026-01-03T00:00:00Z" }),
      row({ id: "b", lastUsedAt: "2026-01-02T00:00:00Z" }),
    ]);
    expect(recency[0].id).toBe("b");
    const never = rankFanout([row({ id: "a", lastUsedAt: "2026-01-01T00:00:00Z" }), row({ id: "b", lastUsedAt: "" })]);
    expect(never[0].id).toBe("b"); // never-used sorts oldest-first
    const prio = rankFanout([row({ id: "a", priority: 0 }), row({ id: "b", priority: 9 })]);
    expect(prio[0].id).toBe("a");
  });

  it("does not mutate its input", () => {
    const rows = [row({ id: "b" }), row({ id: "a" })];
    rankFanout(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("isFanoutEntry / fanoutCtxForEntry (strategy-value semantics)", () => {
  // Steve's ruling (2026-11-15): fanout is a combo STRATEGY value in the
  // dropdown, not an additive checkbox. An entry is fanout when its
  // fallbackStrategy is "fanout", or — legacy checkbox entries — its
  // fanout.enabled is exactly true.
  it("recognises the strategy value", () => {
    expect(isFanoutEntry({ fallbackStrategy: "fanout", fanout: { budgets: { a: 2 } } })).toBe(true);
    expect(isFanoutEntry({ fallbackStrategy: "fanout" })).toBe(true);
    expect(isFanoutEntry({ fallbackStrategy: "fusion" })).toBe(false);
    expect(isFanoutEntry({})).toBe(false);
    expect(isFanoutEntry(null)).toBe(false);
  });

  it("recognises the legacy checkbox entry so existing settings keep working", () => {
    expect(isFanoutEntry({ fanout: { enabled: true, budgets: { a: 2 } } })).toBe(true);
    expect(isFanoutEntry({ fanout: { enabled: false, budgets: { a: 2 } } })).toBe(false);
    expect(isFanoutEntry({ fallbackStrategy: "fallback", fanout: { enabled: true } })).toBe(true);
  });

  it("derives an auth.js-ready ctx with sanitized budgets", () => {
    expect(fanoutCtxForEntry({ fallbackStrategy: "fanout", fanout: { budgets: { a: 2, junk: "x", neg: -1 } } }))
      .toEqual({ enabled: true, budgets: { a: 2 }, percent: 100 });
    expect(fanoutCtxForEntry({ fallbackStrategy: "fanout" })).toEqual({ enabled: true, budgets: {}, percent: 100 });
    expect(fanoutCtxForEntry({ fallbackStrategy: "fusion" })).toBe(null);
    expect(fanoutCtxForEntry({ fanout: { enabled: true, budgets: { a: 1 } } })).toEqual({ enabled: true, budgets: { a: 1 }, percent: 100 });
  });

  it("carries percent through the derived ctx", () => {
    expect(fanoutCtxForEntry({ fallbackStrategy: "fanout", fanout: { enabled: true, percent: 80 } }))
      .toEqual({ enabled: true, budgets: {}, percent: 80 });
    expect(fanoutCtxForEntry({ fallbackStrategy: "fanout", fanout: { enabled: true, percent: 300 } }))
      .toEqual({ enabled: true, budgets: {}, percent: 100 });
  });
});

describe("detectedBudgetFor / effectiveBaseCap (per-(connection, model) scan results)", () => {
  const detected = { c1: { m1: { budget: 16 } } };

  it("reads the (connection, model) pair only", () => {
    expect(detectedBudgetFor(detected, "c1", "m1")).toBe(16);
    expect(detectedBudgetFor(detected, "c1", "m2")).toBe(null);
    expect(detectedBudgetFor(detected, "c2", "m1")).toBe(null);
    expect(detectedBudgetFor(detected, "c2", "m2")).toBe(null);
  });

  it("reads only integer budgets >= 1", () => {
    expect(detectedBudgetFor({ c: { m: { budget: 0 } } }, "c", "m")).toBe(null);
    expect(detectedBudgetFor({ c: { m: { budget: "3" } } }, "c", "m")).toBe(null);
    expect(detectedBudgetFor({ c: { m: {} } }, "c", "m")).toBe(null);
    expect(detectedBudgetFor({ c: { m: { budget: 2.5 } } }, "c", "m")).toBe(null);
  });

  it("tolerates a missing detected map", () => {
    expect(detectedBudgetFor(null, "c1", "m1")).toBe(null);
    expect(detectedBudgetFor(undefined, "c1", "m1")).toBe(null);
    expect(detectedBudgetFor({}, "c1", "m1")).toBe(null);
  });

  it("base cap: detected pair, else the global limit", () => {
    expect(effectiveBaseCap(detected, "c1", "m1", 4)).toBe(16);
    expect(effectiveBaseCap(detected, "c1", "untested", 4)).toBe(4); // untested model → global
    expect(effectiveBaseCap(null, "c1", "m1", 4)).toBe(4);
  });
});

describe("effectiveFanoutBudget chain (manual > percent×detected > global)", () => {
  const global = 4;

  it("a manual budget wins unscaled, regardless of percent or detected", () => {
    const ctx = parseFanoutCtx({ enabled: true, budgets: { c1: 2 }, percent: 80 });
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 5 } } }, "m")).toBe(2);
  });

  it("percent scales the detected budget with a floor of 1", () => {
    const ctx = parseFanoutCtx({ enabled: true, percent: 80 });
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 5 } } }, "m")).toBe(4); // floor(5×0.8)
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 3 } } }, "m")).toBe(2); // floor(2.4)
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 1 } } }, "m")).toBe(1);
  });

  it("percent 100 passes the detected budget through unchanged", () => {
    const ctx = parseFanoutCtx({ enabled: true, percent: 100 });
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 9 } } }, "m")).toBe(9);
  });

  it("an untested model on that connection falls back to the global limit", () => {
    const ctx = parseFanoutCtx({ enabled: true, percent: 80 });
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { other: { budget: 5 } } }, "m")).toBe(4);
    expect(effectiveFanoutBudget(ctx, "cx", global, { c1: { m: { budget: 5 } } }, "m")).toBe(4);
  });

  it("without detected or model the chain is manual → global (3-arg behavior unchanged)", () => {
    const ctx = parseFanoutCtx({ enabled: true, budgets: { c1: 6 }, percent: 80 });
    expect(effectiveFanoutBudget(ctx, "c1", global)).toBe(6);
    expect(effectiveFanoutBudget(ctx, "unknown", global)).toBe(4);
    expect(effectiveFanoutBudget(null, "c1", global)).toBe(4);
    expect(effectiveFanoutBudget(ctx, "c1", global, { c1: { m: { budget: 9 } } })).toBe(6); // manual unscaled even here
  });
});

describe("keylessLaneLimit (shared free lanes cannot sustain a wide fan-out)", () => {
  it("caps the resolved budget at the default ceiling of 6", async () => {
    const { keylessLaneLimit } = await import("@/sse/services/fanoutBudget.js");
    expect(keylessLaneLimit(32, {})).toBe(6);
    expect(keylessLaneLimit(3, {})).toBe(3);
    expect(keylessLaneLimit(4, null)).toBe(4);
  });
  it("honours settings.keylessMaxInflight when it is an integer >= 1, ignores junk", async () => {
    const { keylessLaneLimit } = await import("@/sse/services/fanoutBudget.js");
    expect(keylessLaneLimit(32, { keylessMaxInflight: 10 })).toBe(10);
    expect(keylessLaneLimit(32, { keylessMaxInflight: 0 })).toBe(6);
    expect(keylessLaneLimit(32, { keylessMaxInflight: "9" })).toBe(6);
    expect(keylessLaneLimit(32, { keylessMaxInflight: 2.5 })).toBe(6);
  });
});
