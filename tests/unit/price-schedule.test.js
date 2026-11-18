import { describe, it, expect } from "vitest";
import { bandFor, nextBoundary, calendarStale, hasSchedule } from "../../open-sse/utils/priceSchedule.js";

const U = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s);

describe("deepseek schedule bands", () => {
  it.each([
    [[0, 59, 59], "offpeak"],
    [[1, 0, 0], "peak"],
    [[3, 59, 59], "peak"],
    [[4, 0, 0], "offpeak"],
    [[5, 59, 59], "offpeak"],
    [[6, 0, 0], "peak"],
    [[9, 59, 59], "peak"],
    [[10, 0, 0], "offpeak"],
  ])("Wed 2026-11-18 at %j is %s", ([h, mi, s], band) => {
    expect(bandFor("deepseek", U(2026, 11, 18, h, mi, s))).toBe(band);
  });

  it("weekends are off-peak", () => {
    expect(bandFor("deepseek", U(2026, 11, 21, 2))).toBe("offpeak");
    expect(bandFor("deepseek", U(2026, 11, 22, 2))).toBe("offpeak");
  });

  it.each([[2026, 6, 19], [2026, 10, 1], [2026, 10, 7], [2027, 2, 5], [2027, 6, 9], [2027, 9, 15]])(
    "listed holiday %i-%i-%i is off-peak",
    (y, m, d) => {
      expect(bandFor("deepseek", U(y, m, d, 2))).toBe("offpeak");
    },
  );

  it("an unlisted weekday is peak", () => {
    expect(bandFor("deepseek", U(2026, 10, 8, 2))).toBe("peak");
  });

  it("unknown schedule and non-finite time are peak", () => {
    expect(bandFor("nope", U(2026, 11, 18, 2))).toBe("peak");
    expect(bandFor("deepseek", NaN)).toBe("peak");
    expect(bandFor("deepseek", undefined)).toBe("peak");
  });
});

describe("nextBoundary", () => {
  it("finds the next change", () => {
    expect(nextBoundary("deepseek", U(2026, 11, 18, 2))).toBe(U(2026, 11, 18, 4));
    expect(nextBoundary("deepseek", U(2026, 11, 20, 10))).toBe(U(2026, 11, 23, 1));
    expect(nextBoundary("deepseek", U(2026, 9, 30, 11))).toBe(U(2026, 10, 8, 1));
  });
  it("is null for an unknown schedule", () => {
    expect(nextBoundary("nope", U(2026, 11, 18, 2))).toBeNull();
  });
});

describe("calendarStale and hasSchedule", () => {
  it("flips 30 days before the coverage end", () => {
    expect(calendarStale("deepseek", U(2027, 11, 30, 12))).toBe(false);
    expect(calendarStale("deepseek", U(2027, 12, 1))).toBe(true);
    expect(calendarStale("deepseek", U(2028, 3, 1))).toBe(true);
  });
  it("hasSchedule knows only registered ids", () => {
    expect(hasSchedule("deepseek")).toBe(true);
    expect(hasSchedule("nope")).toBe(false);
  });
});
