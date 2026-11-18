import { describe, expect, it, vi } from "vitest";

const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = {
  "cc/cheap": base(1),
  "cc/dear": base(10),
  "cc/third": { input: 1 / 3, output: 1, cached: 0.1, reasoning: 1, cache_creation: 0.5 },
};
const COMBOS = { mixed: ["cc/cheap", "cc/dear"] };
const ctx = (rate = 25000) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});

const row = (over = {}) => ({
  name: "cc/cheap", kind: "model", unit: "usd", input: 1.2, output: 4.8, cached: 0.12, reasoning: 4.8, cacheCreation: 1.5, perImage: 0, ...over,
});
const legacyRow = (over = {}) => ({
  name: "cc/cheap", kind: "model", input: 30000, output: 120000, cached: 3000, reasoning: 120000, cacheCreation: 37500, perImage: 0, ...over,
});

function store(initial = []) {
  const m = new Map(initial.map((r) => [r.name, r]));
  return {
    m,
    stored: async (n) => m.get(n) ?? null,
    save: async (r) => { m.set(r.name, r); return r; },
    drop: async (n) => { m.delete(n); },
  };
}

async function load() {
  vi.resetModules();
  return import("@/lib/pricing/bulkPrice.js");
}

const run = async (s, input, { c = ctx(), now = 1000 } = {}) => {
  const { applyBulk } = await load();
  return applyBulk(input, { stored: s.stored, save: s.save, drop: s.drop, ctx: c, now });
};

describe("applyBulk markup", () => {
  it("raises an auto-priced name by pct on every field and records the source", async () => {
    const s = store();
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10, label: "ops cost" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "cc/cheap", ok: true, belowFloor: false });
    expect(s.m.get("cc/cheap")).toEqual({
      name: "cc/cheap", kind: "model", unit: "usd", input: 1.1, output: 4.4, cached: 0.11, reasoning: 4.4, cacheCreation: 1.375, perImage: 0,
      source: "markup", label: "ops cost", pct: 10,
    });
  });

  it("applies on top of a stored USD price", async () => {
    const s = store([row()]);
    await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(s.m.get("cc/cheap")).toMatchObject({ unit: "usd", input: 1.32, output: 5.28, source: "markup" });
  });

  it("a legacy credit row in the store is marked up in USD and stored as USD", async () => {
    const s = store([legacyRow()]);
    await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(s.m.get("cc/cheap")).toMatchObject({ unit: "usd", input: 1.32, source: "markup" });
  });

  it("rounds up so a fractional floor is never undercut", async () => {
    const s = store();
    const { results } = await run(s, { action: "markup", names: ["cc/third"], pct: 0.001 });
    expect(results[0].ok).toBe(true);
    const { validateSalePrice } = await import("@/lib/pricing/validateSalePrice.js");
    expect(await validateSalePrice(s.m.get("cc/third"), ctx())).toEqual({ ok: true });
  });

  it("refuses a name in an active promotion and writes nothing", async () => {
    const promo = row({ source: "promo", endsAt: 2000, restore: null });
    const s = store([promo]);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(results[0]).toMatchObject({ ok: false, error: "in_promotion" });
    expect(s.m.get("cc/cheap")).toBe(promo);
  });

  it("applies on the restore base when the promotion has expired", async () => {
    const s = store([row({ source: "promo", endsAt: 1000, restore: row({ input: 1.2 }) })]);
    await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 1.32, source: "markup" });
  });

  it("applies the rest of the batch when one name is unsellable", async () => {
    const s = store();
    const { results } = await run(s, { action: "markup", names: ["cc/cheap", "cc/unknown"], pct: 10 });
    expect(results.find((r) => r.name === "cc/cheap")).toMatchObject({ ok: true });
    expect(results.find((r) => r.name === "cc/unknown")).toMatchObject({ ok: false, error: "unsellable" });
    expect(s.m.has("cc/unknown")).toBe(false);
    expect(s.m.has("cc/cheap")).toBe(true);
  });

  it("refuses a stored price that sits under the floor and stays under it", async () => {
    const s = store([row({ input: 0.01, output: 0.01, cached: 0.01, reasoning: 0.01, cacheCreation: 0.01 })]);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(results[0]).toMatchObject({ ok: false, error: "below_floor" });
  });
});

describe("applyBulk markup refusal reasons", () => {
  it("reports too_high, not below_floor, when the markup pushes a price over the ceiling", async () => {
    const s = store([row({ input: 999_999, output: 999_999, cached: 999_999, reasoning: 999_999, cacheCreation: 999_999 })]);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(results[0]).toMatchObject({ ok: false, error: "too_high" });
  });
});

describe("applyBulk promo", () => {
  it("discounts an auto price, may end under the floor, and flags it", async () => {
    const s = store();
    const { results } = await run(s, { action: "promo", names: ["cc/cheap"], pct: 20, label: "launch", endsAt: 5000 });
    expect(results[0]).toMatchObject({ ok: true, belowFloor: true });
    expect(s.m.get("cc/cheap")).toEqual({
      name: "cc/cheap", kind: "model", unit: "usd", input: 0.8, output: 3.2, cached: 0.08, reasoning: 3.2, cacheCreation: 1, perImage: 0,
      source: "promo", label: "launch", pct: 20, endsAt: 5000, restore: null,
    });
  });

  it("keeps the prior stored row as restore and is not flagged when still above the floor", async () => {
    const prior = row();
    const s = store([prior]);
    const { results } = await run(s, { action: "promo", names: ["cc/cheap"], pct: 10, endsAt: 5000 });
    expect(results[0]).toMatchObject({ ok: true, belowFloor: false });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 1.08, source: "promo", restore: prior });
  });

  it("a second promotion discounts the original price and keeps the original restore", async () => {
    const s = store();
    await run(s, { action: "promo", names: ["cc/cheap"], pct: 20, endsAt: 5000 });
    await run(s, { action: "promo", names: ["cc/cheap"], pct: 50, endsAt: 6000 });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 0.5, endsAt: 6000, restore: null, pct: 50 });
  });
});

describe("applyBulk revert", () => {
  it("drops a markup row back to auto", async () => {
    const s = store([row({ source: "markup", pct: 10 })]);
    const { results } = await run(s, { action: "revert", names: ["cc/cheap"] });
    expect(results[0]).toMatchObject({ ok: true });
    expect(s.m.has("cc/cheap")).toBe(false);
  });

  it("restores the prior row of an active promotion", async () => {
    const prior = row();
    const s = store([row({ source: "promo", endsAt: 5000, restore: prior, input: 0.01 })]);
    await run(s, { action: "revert", names: ["cc/cheap"] });
    expect(s.m.get("cc/cheap")).toBe(prior);
  });

  it("drops an active promotion whose restore is null", async () => {
    const s = store([row({ source: "promo", endsAt: 5000, restore: null })]);
    await run(s, { action: "revert", names: ["cc/cheap"] });
    expect(s.m.has("cc/cheap")).toBe(false);
  });
});

describe("belowFloor", () => {
  const at = (input) => ({ name: "cc/cheap", kind: "model", unit: "usd", input, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25 });

  it("is true a micro-unit under the floor, false at it, false with no floor", async () => {
    const { belowFloor } = await load();
    expect(await belowFloor(at(0.999999), ctx())).toBe(true);
    expect(await belowFloor(at(1), ctx())).toBe(false);
    expect(await belowFloor({ name: "cc/unknown", kind: "model", unit: "usd", input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0 }, ctx())).toBe(false);
  });

  it("does not depend on the FX rate", async () => {
    const { belowFloor } = await load();
    expect(await belowFloor(at(1), ctx(25000))).toBe(false);
    expect(await belowFloor(at(1), ctx(40000))).toBe(false);
  });
});

describe("applyBulk with tiers", () => {
  it("a markup scales every tier and still passes the floor", async () => {
    const tiered = { ...base(1), tiers: [{ above: 100, input: 2, output: 8, cached: 0.2, reasoning: 8, cache_creation: 2.5 }] };
    const c = { rate: 25000, baseFor: async (n) => (n === "cc/tiered" ? tiered : null), comboModels: async () => null };
    const s = store();
    const { results } = await run(s, { action: "markup", names: ["cc/tiered"], pct: 10 }, { c });
    expect(results[0]).toMatchObject({ ok: true });
    expect(s.m.get("cc/tiered").tiers).toEqual([{ above: 100, input: 2.2, output: 8.8, cached: 0.22, reasoning: 8.8, cacheCreation: 2.75 }]);
  });

  it("a promotion scales the tiers down and reports belowFloor against the tier floor", async () => {
    const tiered = { ...base(1), tiers: [{ above: 100, input: 2, output: 8, cached: 0.2, reasoning: 8, cache_creation: 2.5 }] };
    const c = { rate: 25000, baseFor: async (n) => (n === "cc/tiered" ? tiered : null), comboModels: async () => null };
    const s = store();
    const { results } = await run(s, { action: "promo", names: ["cc/tiered"], pct: 20, endsAt: 5000 }, { c });
    expect(results[0]).toMatchObject({ ok: true, belowFloor: true });
    expect(s.m.get("cc/tiered").tiers[0]).toMatchObject({ above: 100, input: 1.6, output: 6.4 });
  });
});
