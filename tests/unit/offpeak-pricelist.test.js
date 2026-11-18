import { describe, expect, it } from "vitest";
import { listPrices } from "@/lib/pricing/priceList.js";
import { scheduleOf } from "@/lib/pricing/scheduleOf.js";

const PEAK = Date.UTC(2026, 10, 18, 2);
const OFF = Date.UTC(2026, 10, 18, 5);
const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = {
  "cc/cheap": base(1),
  "ds/pro": { ...base(10), offPeak: { schedule: "deepseek", factor: 0.5 } },
};
const COMBOS = { mix: ["cc/cheap", "ds/pro"], loop: ["loop2"], loop2: ["loop"] };
const ctx = () => ({
  rate: 25000,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});
const stored = async () => [];
const rows = async (now) => Object.fromEntries((await listPrices({ names: ["ds/pro", "cc/cheap", "mix"], stored, ctx: ctx(), now })).map((r) => [r.name, r]));

describe("price list schedule", () => {
  it("reports the peak band, the next change and the peak floor", async () => {
    const r = (await rows(PEAK))["ds/pro"];
    expect(r.schedule).toEqual({ id: "deepseek", band: "peak", nextChangeAt: Date.UTC(2026, 10, 18, 4), calendarStale: false });
    expect(r.floor.input).toBe(10);
    expect(r.effective.input).toBe(10);
  });

  it("off-peak the effective auto price halves while the floor stays peak", async () => {
    const r = (await rows(OFF))["ds/pro"];
    expect(r.schedule.band).toBe("offpeak");
    expect(r.effective.input).toBe(5);
    expect(r.floor.input).toBe(10);
  });

  it("a flat model has no schedule key and a combo inherits its member's", async () => {
    const all = await rows(PEAK);
    expect("schedule" in all["cc/cheap"]).toBe(false);
    expect(all.mix.schedule.id).toBe("deepseek");
  });

  it("flags a stale calendar near its end", async () => {
    expect((await rows(Date.UTC(2027, 11, 15, 2)))["ds/pro"].schedule.calendarStale).toBe(true);
  });

  it("scheduleOf resolves a combo cycle to null", async () => {
    expect(await scheduleOf("loop", ctx())).toBeNull();
  });
});
