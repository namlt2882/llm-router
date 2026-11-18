import { describe, expect, it } from "vitest";
import { bulkPreview, selectedVisible } from "@/app/(dashboard)/dashboard/pricing/bulkPreview.js";

const row = (over = {}) => ({
  name: "cc/a", status: "auto",
  floor: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25 },
  effective: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25 },
  stored: null, ...over,
});

describe("bulkPreview", () => {
  it("a markup rounds up to 6 decimals and is never under the floor", () => {
    expect(bulkPreview(row(), "markup", 10)).toMatchObject({ from: 1, to: 1.1, under: false, skip: null });
  });
  it("a promotion is under the floor when ANY token field falls below its floor, not only input", () => {
    const r = row({ floor: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25 }, effective: { input: 2, output: 4.2, cached: 0.2, reasoning: 4.2, cacheCreation: 2 } });
    expect(bulkPreview(r, "promo", 10)).toMatchObject({ under: true });
    expect(bulkPreview(row({ effective: { input: 2, output: 8, cached: 0.2, reasoning: 8, cacheCreation: 2.5 } }), "promo", 10).under).toBe(false);
  });
  it("a markup on an active promotion is skipped the way the server refuses it", () => {
    const r = row({ status: "promo", stored: { source: "promo", restore: null } });
    expect(bulkPreview(r, "markup", 10)).toMatchObject({ skip: "in_promotion" });
    expect(bulkPreview(r, "promo", 10).skip).toBeNull();
  });
  it("nothing to preview without a base or a positive percent", () => {
    expect(bulkPreview(row({ effective: null, floor: null }), "markup", 10)).toBeNull();
    expect(bulkPreview(row(), "markup", 0)).toBeNull();
  });
});

describe("selectedVisible", () => {
  const rows = [{ name: "a", status: "auto" }, { name: "b", status: "auto" }, { name: "c", status: "no_base_price" }];
  it("only names that are visible, selected and sellable are acted on", () => {
    expect(selectedVisible(rows, new Set(["a", "b", "c"])).map((r) => r.name)).toEqual(["a", "b"]);
    expect(selectedVisible([rows[1]], new Set(["a", "b"])).map((r) => r.name)).toEqual(["b"]);
  });
});

describe("bulkPreview with tiers", () => {
  const tiered = (over = {}) => row({
    floor: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, tiers: [{ above: 100, input: 2, output: 8, cached: 0.2, reasoning: 8, cacheCreation: 2.5 }] },
    effective: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, tiers: [{ above: 100, input: 2, output: 8, cached: 0.2, reasoning: 8, cacheCreation: 2.5 }] },
    ...over,
  });
  it("a promotion is under the floor when only a tier falls below its tier floor", () => {
    expect(bulkPreview(tiered(), "promo", 10)).toMatchObject({ under: true });
  });
  it("a markup keeps every tier at or above its floor", () => {
    expect(bulkPreview(tiered(), "markup", 10)).toMatchObject({ to: 1.1, under: false });
  });
  it("a flat stored price under a tiered floor is under the floor even before the percent", () => {
    const r = tiered({ effective: { input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25 } });
    expect(bulkPreview(r, "markup", 10)).toMatchObject({ under: true });
  });
});
