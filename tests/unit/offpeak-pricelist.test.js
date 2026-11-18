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

describe("price list bands", () => {
  it("a scheduled name carries its sale price in both bands, whichever band it is now", async () => {
    for (const now of [PEAK, OFF]) {
      const r = (await rows(now))["ds/pro"];
      expect(r.bands.peak.input).toBe(10);
      expect(r.bands.offpeak.input).toBe(5);
    }
  });

  it("a combo averages its members in each band", async () => {
    const r = (await rows(PEAK)).mix;
    expect(r.bands.peak.input).toBe(5.5);
    expect(r.bands.offpeak.input).toBe(3);
  });

  it("a name with no schedule has no bands", async () => {
    expect("bands" in (await rows(PEAK))["cc/cheap"]).toBe(false);
  });

  it("a hand-set price is the same in both bands", async () => {
    const hand = async () => [{ name: "ds/pro", kind: "model", unit: "usd", input: 20, output: 40, cached: 2, reasoning: 40, cacheCreation: 20 }];
    const [r] = await listPrices({ names: ["ds/pro"], stored: hand, ctx: ctx(), now: PEAK });
    expect(r.bands.peak.input).toBe(20);
    expect(r.bands.offpeak.input).toBe(20);
  });
});
