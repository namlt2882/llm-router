import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

beforeEach(() => {
  dropAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-hold-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  dropAdapter();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const T = "2026-11-17T10:00:00.000Z";
const entry = (extra = {}) => ({
  timestamp: T,
  provider: "cc",
  model: "cheap",
  connectionId: "c1",
  tokens: { prompt_tokens: 100, completion_tokens: 50 },
  ...extra,
});

async function load() {
  vi.resetModules();
  const usage = await import("@/lib/db/repos/usageRepo.js");
  const holds = await import("@/lib/db/repos/holdUsageRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { usage, holds, db: await getAdapter() };
}

const count = (db) => db.get("SELECT count(*) AS n FROM usageHistory").n;

describe("usage rows keyed by hold id", () => {
  it("two identical calls in the same millisecond with different hold ids are two rows", async () => {
    const { usage, db } = await load();
    await usage.saveRequestUsage(entry({ holdId: "h-1", costCredits: 10 }));
    await usage.saveRequestUsage(entry({ holdId: "h-2", costCredits: 10 }));
    expect(count(db)).toBe(2);
  });

  it("the same hold id twice dedupes to one row", async () => {
    const { usage, db } = await load();
    await usage.saveRequestUsage(entry({ holdId: "h-1", costCredits: 10 }));
    await usage.saveRequestUsage(entry({ holdId: "h-1", costCredits: 10 }));
    expect(count(db)).toBe(1);
  });

  it("rows without a hold id keep the old dedupe", async () => {
    const { usage, db } = await load();
    await usage.saveRequestUsage(entry());
    await usage.saveRequestUsage(entry());
    expect(count(db)).toBe(1);
  });
});

describe("getUsageByHoldId", () => {
  it("is null for a hold the router never recorded", async () => {
    const { holds } = await load();
    expect(await holds.getUsageByHoldId("nope")).toBeNull();
  });

  it("sums the cost over every attempt and counts them", async () => {
    const { usage, holds } = await load();
    await usage.saveRequestUsage(entry({ holdId: "h-1", costCredits: 12.5, timestamp: "2026-11-17T10:00:00.000Z" }));
    await usage.saveRequestUsage(entry({ holdId: "h-1", costCredits: 7.5, timestamp: "2026-11-17T10:00:01.000Z", connectionId: "c2" }));
    await usage.saveRequestUsage(entry({ holdId: "h-other", costCredits: 99 }));
    expect(await holds.getUsageByHoldId("h-1")).toEqual({ costCredits: 20, attempts: 2 });
  });

  it("a row with no costCredits counts as an attempt costing zero", async () => {
    const { usage, holds } = await load();
    await usage.saveRequestUsage(entry({ holdId: "h-1" }));
    expect(await holds.getUsageByHoldId("h-1")).toEqual({ costCredits: 0, attempts: 1 });
  });
});
