import { describe, expect, it } from "vitest";
import { filterRows } from "@/app/(dashboard)/dashboard/pricing/filterRows.js";

const rows = [
  { name: "cc/Claude-Sonnet", kind: "model", status: "auto", belowFloor: false },
  { name: "mixed", kind: "combo", status: "custom", belowFloor: false },
  { name: "cc/other", kind: "model", status: "markup", belowFloor: false },
  { name: "cc/launch", kind: "model", status: "promo", belowFloor: true },
  { name: "cc/unknown", kind: "model", status: "no_base_price", belowFloor: false },
];
const names = (f, q = "") => filterRows(rows, { q, filter: f }).map((r) => r.name);

describe("filterRows", () => {
  it("all with an empty query returns every row unchanged", () => {
    expect(filterRows(rows, { q: "", filter: "all" })).toEqual(rows);
  });
  it("the query is a case-insensitive substring of the name", () => {
    expect(names("all", "SONNET")).toEqual(["cc/Claude-Sonnet"]);
    expect(names("all", "  cc/o ")).toEqual(["cc/other"]);
  });
  it("model and combo select by kind", () => {
    expect(names("combo")).toEqual(["mixed"]);
    expect(names("model")).toHaveLength(4);
  });
  it("custom covers custom and markup rows, promo covers promotions", () => {
    expect(names("custom")).toEqual(["mixed", "cc/other"]);
    expect(names("promo")).toEqual(["cc/launch"]);
  });
  it("below_floor selects rows flagged belowFloor", () => {
    expect(names("below_floor")).toEqual(["cc/launch"]);
  });
  it("a filter and a query combine", () => {
    expect(names("model", "cc/l")).toEqual(["cc/launch"]);
  });
});
