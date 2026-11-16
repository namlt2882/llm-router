import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Isolated DATA_DIR — without this the adapter resolves to ~/.9router and the
// test would wipe real usage rows (this exact accident is why the guard
// exists). Same shape as db-driver-chain.test.js. resetModules so paths.js
// re-reads DATA_DIR per test — it caches at import time.
let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-concchart-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(async () => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const loadRepo = async () => {
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  const usageRepo = await import("../../src/lib/db/repos/usageRepo.js");
  return { getAdapter, usageRepo };
};

const iso = (s) => new Date(s).toISOString();
const seedUsage = async (db, ts, prompt, completion, cost) => {
  await db.run(
    "INSERT INTO usageHistory (timestamp, provider, model, promptTokens, completionTokens, cost, status) VALUES (?, 'glm', 'm', ?, ?, ?, 'ok')",
    [ts, prompt, completion, cost],
  );
};

describe("getConcurrencyChartData", () => {
  beforeEach(() => {});

  it("24h: average concurrency, budget-weighted rate, window-cumulative token/cost lines", async () => {
    const { getAdapter, usageRepo } = await loadRepo();
    const db = await getAdapter();
    // Mid-bucket (30min from any boundary) so the chart's own Date.now() ε
    // can never move a sample across a bucket line.
    const base = Date.now() - 2.5 * 3600000;
    // bucket A: two samples → avg (2+4)/2 = 3; next bucket: zero-budget sample → rate null
    await usageRepo.recordConcurrencySample(2, 10, { now: new Date(base) });
    await usageRepo.recordConcurrencySample(4, 10, { now: new Date(base + 60000) });
    await usageRepo.recordConcurrencySample(0, 0, { now: new Date(base + 3600000) });
    await seedUsage(db, iso(base), 100, 50, 0.01);
    await seedUsage(db, iso(base + 3600000), 10, 5, 0.02);

    const out = await usageRepo.getConcurrencyChartData("24h");
    expect(out).toHaveLength(24);
    expect(out.map((b) => b.utilityRate).filter((r) => r === null).length).toBeGreaterThan(0); // zero-budget bucket → null, not Infinity
    expect(out[out.length - 1].cumulativeTokens).toBe(165); // (150 + 15) window-cumulative
    expect(out[out.length - 1].cumulativeCost).toBeCloseTo(0.03, 6);
    const concurrencySum = out.reduce((s, b) => s + (b.concurrency || 0), 0);
    expect(concurrencySum).toBeCloseTo(3, 6); // bucket averages: (2+4)/2 + 0
    expect(out.every((b) => Number.isFinite(b.concurrency))).toBe(true);
    expect(await usageRepo.getConcurrencyChartData("all")).toEqual([]); // no usageDaily rows in a fresh dir
  });

  it("empty table → zeroed buckets with null rates, never NaN", async () => {
    const { usageRepo } = await loadRepo();
    const out = await usageRepo.getConcurrencyChartData("7d");
    expect(out).toHaveLength(7);
    expect(out.every((b) => b.concurrency === 0 && b.utilityRate === null && b.cumulativeTokens === 0)).toBe(true);
    expect(await usageRepo.getConcurrencyChartData("all")).toEqual([]);
  });
});
