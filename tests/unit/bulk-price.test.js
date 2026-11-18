import { describe, expect, it, vi } from "vitest";

const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = { "cc/cheap": base(1), "cc/dear": base(10) };
const COMBOS = { mixed: ["cc/cheap", "cc/dear"] };
const ctx = (rate = 25000) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});

const row = (over = {}) => ({
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
      name: "cc/cheap", kind: "model", input: 27500, output: 110000, cached: 2750, reasoning: 110000, cacheCreation: 34375, perImage: 0,
      source: "markup", label: "ops cost", pct: 10,
    });
  });

  it("applies on top of a stored price", async () => {
    const s = store([row()]);
    await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 33000, output: 132000, source: "markup" });
  });

  it("rounds up so a fractional floor is never undercut", async () => {
    const s = store();
    const c = ctx(25000.6);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 0.001 }, { c });
    expect(results[0].ok).toBe(true);
    const { validateSalePrice } = await import("@/lib/pricing/validateSalePrice.js");
    expect(await validateSalePrice(s.m.get("cc/cheap"), c)).toEqual({ ok: true });
  });

  it("refuses a name in an active promotion and writes nothing", async () => {
    const promo = row({ source: "promo", endsAt: 2000, restore: null });
    const s = store([promo]);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(results[0]).toMatchObject({ ok: false, error: "in_promotion" });
    expect(s.m.get("cc/cheap")).toBe(promo);
  });

  it("applies on the restore base when the promotion has expired", async () => {
    const s = store([row({ source: "promo", endsAt: 1000, restore: row({ input: 30000 }) })]);
    await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 33000, source: "markup" });
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
    const s = store([row({ input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1 })]);
    const { results } = await run(s, { action: "markup", names: ["cc/cheap"], pct: 10 });
    expect(results[0]).toMatchObject({ ok: false, error: "below_floor" });
  });
});

describe("applyBulk promo", () => {
  it("discounts an auto price, may end under the floor, and flags it", async () => {
    const s = store();
    const { results } = await run(s, { action: "promo", names: ["cc/cheap"], pct: 20, label: "launch", endsAt: 5000 });
    expect(results[0]).toMatchObject({ ok: true, belowFloor: true });
    expect(s.m.get("cc/cheap")).toEqual({
      name: "cc/cheap", kind: "model", input: 20000, output: 80000, cached: 2000, reasoning: 80000, cacheCreation: 25000, perImage: 0,
      source: "promo", label: "launch", pct: 20, endsAt: 5000, restore: null,
    });
  });

  it("keeps the prior stored row as restore and is not flagged when still above the floor", async () => {
    const prior = row();
    const s = store([prior]);
    const { results } = await run(s, { action: "promo", names: ["cc/cheap"], pct: 10, endsAt: 5000 });
    expect(results[0]).toMatchObject({ ok: true, belowFloor: false });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 27000, source: "promo", restore: prior });
  });

  it("a second promotion discounts the original price and keeps the original restore", async () => {
    const s = store();
    await run(s, { action: "promo", names: ["cc/cheap"], pct: 20, endsAt: 5000 });
    await run(s, { action: "promo", names: ["cc/cheap"], pct: 50, endsAt: 6000 });
    expect(s.m.get("cc/cheap")).toMatchObject({ input: 12500, endsAt: 6000, restore: null, pct: 50 });
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
    const s = store([row({ source: "promo", endsAt: 5000, restore: prior, input: 1 })]);
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
  it("is true when any token field is under the floor, false at the floor, false with no floor", async () => {
    const { belowFloor } = await load();
    const c = ctx();
    expect(await belowFloor({ name: "cc/cheap", kind: "model", input: 24999, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250 }, c)).toBe(true);
    expect(await belowFloor({ name: "cc/cheap", kind: "model", input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250 }, c)).toBe(false);
    expect(await belowFloor({ name: "cc/unknown", kind: "model", input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0 }, c)).toBe(false);
  });
});
