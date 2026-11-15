import { describe, expect, it } from "vitest";
import { parseFanoutCtx, effectiveFanoutBudget, rankFanout } from "../../src/sse/services/fanoutBudget.js";

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
      .toEqual({ budgets: { a: 6 } });
  });

  it("allows an absent or empty budgets map", () => {
    expect(parseFanoutCtx({ enabled: true })).toEqual({ budgets: {} });
    expect(parseFanoutCtx({ enabled: true, budgets: {} })).toEqual({ budgets: {} });
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
