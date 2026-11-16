import { describe, expect, it } from "vitest";
import { matchesQuotaHints } from "../../src/lib/fork/capacity/classifyError.js";
import { parseResetsIn } from "../../src/sse/services/quotaCollapse.js";

describe("matchesQuotaHints", () => {
  it("matches the scan's quota dialects", () => {
    expect(matchesQuotaHints(`{"error":{"type":"GoUsageLimitError"}}`)).toBe(true);
    expect(matchesQuotaHints("usage limit reached (monthly)")).toBe(true);
  });
  it("does not match generic throttle or unrelated text", () => {
    expect(matchesQuotaHints("rate limit exceeded")).toBe(false);
    expect(matchesQuotaHints("")).toBe(false);
    expect(matchesQuotaHints(undefined)).toBe(false);
  });
});

describe("parseResetsIn", () => {
  it("parses days+hours and hours+minutes into milliseconds", () => {
    expect(parseResetsIn("You've hit your plan limit. Resets in 8d 4h")).toBe((8 * 24 + 4) * 3600000);
    expect(parseResetsIn("quota window resets in 5h 20m")).toBe((5 * 60 + 20) * 60000);
  });
  it("returns null without a resets-in phrase or with no numbers", () => {
    expect(parseResetsIn("GoUsageLimitError")).toBe(null);
    expect(parseResetsIn("resets in soon")).toBe(null);
    expect(parseResetsIn(undefined)).toBe(null);
  });
});
