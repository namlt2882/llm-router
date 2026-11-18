import { describe, expect, it } from "vitest";
import { fmtUsd, fmtVnd, parseDefaultBase, showPrice } from "@/app/(dashboard)/dashboard/pricing/formatPrice.js";

describe("pricing format", () => {
  it("fmtUsd keeps up to 6 decimals, trims trailing zeros and groups thousands", () => {
    expect(fmtUsd(0.05)).toBe("0.05");
    expect(fmtUsd(3)).toBe("3");
    expect(fmtUsd(0.000001)).toBe("0.000001");
    expect(fmtUsd(1234.5)).toBe("1,234.5");
    expect(fmtUsd(NaN)).toBe("-");
    expect(fmtUsd(undefined)).toBe("-");
  });

  it("fmtVnd is USD x rate rounded to an integer", () => {
    expect(fmtVnd(0.05, 25500)).toBe("1,275");
    expect(fmtVnd(1, 25000)).toBe("25,000");
    expect(fmtVnd(1, undefined)).toBe("-");
  });

  it("showPrice follows the mode", () => {
    expect(showPrice(1, "vnd", 25000)).toBe("25,000");
    expect(showPrice(1, "usd", 25000)).toBe("1");
  });

  it("parseDefaultBase refuses a blank or non-numeric field instead of saving it as 0", () => {
    const ok = parseDefaultBase({ enabled: true, input: "0.07", cached: 0.005, output: "0.1" });
    expect(ok).toEqual({ body: { enabled: true, input: 0.07, cached: 0.005, output: 0.1 } });
    for (const bad of ["", "  ", "abc", undefined, null]) {
      expect(parseDefaultBase({ enabled: true, input: 0.05, cached: bad, output: 0.1 }).error, String(bad)).toMatch(/cached/);
    }
    expect(parseDefaultBase({ enabled: false, input: "0", cached: "0", output: "0" }).body).toEqual({ enabled: false, input: 0, cached: 0, output: 0 });
  });
});

import { fmtTokens, tierLines, editTiersFrom, tiersForSave } from "@/app/(dashboard)/dashboard/pricing/formatPrice.js";

describe("context tiers in the pricing page", () => {
  const tiers = [{ above: 200_000, input: 4, cached: 0.6, output: 12, reasoning: 12, cacheCreation: 4 }];

  it("fmtTokens shortens a token count", () => {
    expect(fmtTokens(100_000)).toBe("100K");
    expect(fmtTokens(272_000)).toBe("272K");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(512)).toBe("512");
  });

  it("tierLines is empty for a flat row and one line per tier otherwise, in the chosen unit", () => {
    expect(tierLines({ input: 1 }, "usd", 25000)).toEqual([]);
    expect(tierLines({ tiers }, "usd", 25000)).toEqual(["> 200K: 4 / 0.6 / 12"]);
    expect(tierLines({ tiers }, "vnd", 25000)).toEqual(["> 200K: 100,000 / 15,000 / 300,000"]);
  });

  it("editTiersFrom starts from the live price's tiers, else the floor's, as strings", () => {
    const floor = { tiers };
    expect(editTiersFrom({ tiers: [{ ...tiers[0], input: 5 }] }, floor)[0].input).toBe("5");
    expect(editTiersFrom({}, floor)[0]).toMatchObject({ above: 200_000, input: "4", output: "12" });
    expect(editTiersFrom({}, {})).toEqual([]);
  });

  it("tiersForSave turns the edited strings into numbers and omits an empty list", () => {
    expect(tiersForSave([{ above: 200_000, input: "4", cached: "0.6", output: "12", reasoning: "12", cacheCreation: "4" }])).toEqual(tiers);
    expect(tiersForSave([])).toBeUndefined();
  });
});

import { scheduleLabel, calendarStaleNotice } from "@/app/(dashboard)/dashboard/pricing/formatPrice.js";

describe("peak / off-peak caption", () => {
  it("names the band now and when it changes", () => {
    expect(scheduleLabel({ id: "deepseek", band: "peak", nextChangeAt: Date.UTC(2026, 10, 18, 4), calendarStale: false })).toBe("Peak now · off-peak from 2026-11-18 04:00 UTC");
    expect(scheduleLabel({ id: "deepseek", band: "offpeak", nextChangeAt: Date.UTC(2026, 10, 23, 1), calendarStale: false })).toBe("Off-peak now · peak from 2026-11-23 01:00 UTC");
  });

  it("drops the change time when none is known", () => {
    expect(scheduleLabel({ id: "deepseek", band: "offpeak", nextChangeAt: null })).toBe("Off-peak now");
    expect(scheduleLabel({ id: "deepseek", band: "peak", nextChangeAt: null })).toBe("Peak now");
  });

  it("warns once about the holiday calendar only when a row is stale", () => {
    expect(calendarStaleNotice([{}, { schedule: { calendarStale: true } }])).toBe("Chinese holiday calendar is ending: add the next year's dates in open-sse/utils/priceSchedule.js");
    expect(calendarStaleNotice([{}])).toBeNull();
  });
});
