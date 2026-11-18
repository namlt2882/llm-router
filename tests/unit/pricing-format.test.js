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
