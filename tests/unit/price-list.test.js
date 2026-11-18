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

async function list(names, rows = [], now = 1000) {
  vi.resetModules();
  const { listPrices } = await import("@/lib/pricing/priceList.js");
  return listPrices({ names, stored: async () => rows, ctx: ctx(), now });
}
const byName = (rows, n) => rows.find((r) => r.name === n);

describe("listPrices", () => {
  it("an unpriced name is auto and its effective price equals the floor", async () => {
    const r = byName(await list(["cc/cheap"]), "cc/cheap");
    expect(r).toMatchObject({ kind: "model", status: "auto", stored: null, belowFloor: false });
    expect(r.floor).toMatchObject({ input: 25000, output: 100000 });
    expect(r.effective).toMatchObject({ input: 25000, auto: true });
  });

  it("a plain stored row is custom, a markup row is markup", async () => {
    expect(byName(await list(["cc/cheap"], [row()]), "cc/cheap")).toMatchObject({ status: "custom", effective: { input: 30000 } });
    expect(byName(await list(["cc/cheap"], [row({ source: "markup", pct: 10 })]), "cc/cheap")).toMatchObject({ status: "markup" });
  });

  it("an active promotion carries endsAt and belowFloor when under the floor", async () => {
    const r = byName(await list(["cc/cheap"], [row({ source: "promo", input: 20000, endsAt: 5000, restore: null })]), "cc/cheap");
    expect(r).toMatchObject({ status: "promo", endsAt: 5000, belowFloor: true });
  });

  it("an expired promotion shows the status of its restore row, or auto", async () => {
    const custom = byName(await list(["cc/cheap"], [row({ source: "promo", endsAt: 1000, restore: row({ input: 31000 }) })]), "cc/cheap");
    expect(custom).toMatchObject({ status: "custom", effective: { input: 31000 } });
    expect(custom.endsAt).toBeUndefined();
    const auto = byName(await list(["cc/cheap"], [row({ source: "promo", endsAt: 1000, restore: null })]), "cc/cheap");
    expect(auto).toMatchObject({ status: "auto", stored: null });
  });

  it("a name with no base price is no_base_price with no floor and no effective price", async () => {
    expect(byName(await list(["cc/unknown"]), "cc/unknown")).toMatchObject({ status: "no_base_price", floor: null, effective: null, belowFloor: false });
  });

  it("a combo is kind combo, names are deduped and sorted, a stored name outside names is still listed", async () => {
    const rows = await list(["mixed", "cc/dear", "cc/dear"], [row()]);
    expect(rows.map((r) => r.name)).toEqual(["cc/cheap", "cc/dear", "mixed"]);
    expect(byName(rows, "mixed")).toMatchObject({ kind: "combo", status: "auto" });
  });
});
