import { describe, expect, it, vi } from "vitest";

const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = { "cc/cheap": base(1), "cc/dear": base(10) };
const DEFAULTED = { input: 0.05, output: 0.1, cached: 0.005, reasoning: 0.1, cache_creation: 0.05, defaulted: true };
const COMBOS = { mixed: ["cc/cheap", "cc/dear"] };
const ctx = (rate = 25000) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? (name === "cc/defaulted" ? DEFAULTED : null),
  comboModels: async (name) => COMBOS[name] ?? null,
});
const row = (over = {}) => ({
  name: "cc/cheap", kind: "model", unit: "usd", input: 1.2, output: 4.8, cached: 0.12, reasoning: 4.8, cacheCreation: 1.5, perImage: 0, ...over,
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
    expect(r.floor).toMatchObject({ input: 1, output: 4, cached: 0.1 });
    expect(r.effective).toMatchObject({ input: 1, unit: "usd", auto: true });
  });

  it("a plain stored row is custom, a markup row is markup", async () => {
    expect(byName(await list(["cc/cheap"], [row()]), "cc/cheap")).toMatchObject({ status: "custom", effective: { input: 1.2 } });
    expect(byName(await list(["cc/cheap"], [row({ source: "markup", pct: 10 })]), "cc/cheap")).toMatchObject({ status: "markup" });
  });

  it("an active promotion carries endsAt and belowFloor when under the floor", async () => {
    const r = byName(await list(["cc/cheap"], [row({ source: "promo", input: 0.8, endsAt: 5000, restore: null })]), "cc/cheap");
    expect(r).toMatchObject({ status: "promo", endsAt: 5000, belowFloor: true });
  });

  it("an expired promotion shows the status of its restore row, or auto", async () => {
    const custom = byName(await list(["cc/cheap"], [row({ source: "promo", endsAt: 1000, restore: row({ input: 1.3 }) })]), "cc/cheap");
    expect(custom).toMatchObject({ status: "custom", effective: { input: 1.3 } });
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

  it("a legacy credit row comes back as USD", async () => {
    const legacy = { name: "cc/cheap", kind: "model", input: 30000, output: 120000, cached: 3000, reasoning: 120000, cacheCreation: 37500, perImage: 0 };
    const r = byName(await list(["cc/cheap"], [legacy]), "cc/cheap");
    expect(r.stored).toMatchObject({ unit: "usd", input: 1.2 });
    expect(r.effective).toMatchObject({ unit: "usd", input: 1.2 });
    expect(r.status).toBe("custom");
  });

  it("a combo with no stored price shows the averaged floor", async () => {
    const r = byName(await list(["mixed"]), "mixed");
    expect(r).toMatchObject({ status: "auto", floor: { input: 5.5, output: 22 }, effective: { input: 5.5, unit: "usd", auto: true } });
  });

  it("defaultBase is true only for a name served from the default base", async () => {
    const rows = await list(["cc/defaulted", "cc/cheap", "mixed"]);
    expect(byName(rows, "cc/defaulted")).toMatchObject({ status: "auto", defaultBase: true, floor: { input: 0.05 } });
    expect(byName(rows, "cc/cheap").defaultBase).toBe(false);
    expect(byName(rows, "mixed").defaultBase).toBe(false);
  });
});
