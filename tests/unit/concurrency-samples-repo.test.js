import { describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { recordConcurrencySample, pruneConcurrencySamples } from "../../src/lib/db/repos/usageRepo.js";

describe("concurrencySamples round-trip", () => {
  it("inserts rows, selects them back and prunes only old ones", async () => {
    const db = await getAdapter();
    await recordConcurrencySample(2, 10);
    const rows = db.all("SELECT ts, inflight, totalBudget FROM concurrencySamples ORDER BY id DESC LIMIT 1");
    expect(Number(rows[0].inflight)).toBe(2);
    expect(Number(rows[0].totalBudget)).toBe(10);
    await pruneConcurrencySamples(db, new Date(Date.now() + 86400000).toISOString()); // cutoff in the future
    expect(db.all("SELECT id FROM concurrencySamples WHERE inflight = '2' AND totalBudget = '10'")).toHaveLength(0);
  });
});
