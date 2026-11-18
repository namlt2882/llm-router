import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

const BASE = { provider: "deepseek", model: "deepseek-v4-pro", connectionId: "c1" };
const tokens = () => ({ prompt_tokens: 1_000_000, completion_tokens: 0 });
const save = async (usage, extra) => {
  const entry = { ...BASE, tokens: tokens(), ...extra };
  await usage.saveRequestUsage(entry);
  return entry.cost;
};

describe("usage cost follows the request start time", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-offpeak-usage-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });
  afterEach(() => {
    dropAdapter();
    vi.doUnmock("@/lib/usageDb.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("bills peak when the request started at peak", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    expect(await save(usage, { startedAt: Date.UTC(2026, 10, 18, 2), timestamp: "2026-11-18T02:00:30.000Z" })).toBeCloseTo(1.32, 9);
  });

  it("bills off-peak when the request started off-peak", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    expect(await save(usage, { startedAt: Date.UTC(2026, 10, 18, 5), timestamp: "2026-11-18T05:00:30.000Z" })).toBeCloseTo(0.66, 9);
  });

  it("a call that started at 03:59:59 and is saved after 04:00 is billed at peak", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    expect(await save(usage, { startedAt: Date.UTC(2026, 10, 18, 3, 59, 59), timestamp: "2026-11-18T04:00:30.000Z" })).toBeCloseTo(1.32, 9);
  });

  it("falls back to the entry timestamp when there is no startedAt", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    expect(await save(usage, { timestamp: "2026-11-18T05:00:00.000Z" })).toBeCloseTo(0.66, 9);
  });

  it("an unparsable timestamp and no startedAt prices at peak, finite", async () => {
    const usage = await import("@/lib/db/repos/usageRepo.js");
    const cost = await save(usage, { timestamp: "not a date" });
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeCloseTo(1.32, 9);
  });
});

describe("saveUsageStats forwards startedAt", () => {
  afterEach(() => vi.doUnmock("@/lib/usageDb.js"));

  it("puts startedAt on the usage entry", async () => {
    vi.resetModules();
    const saveRequestUsage = vi.fn(() => Promise.resolve());
    vi.doMock("@/lib/usageDb.js", () => ({
      saveRequestUsage,
      appendRequestLog: vi.fn(() => Promise.resolve()),
      saveRequestDetail: vi.fn(() => Promise.resolve()),
      trackPendingRequest: vi.fn(),
    }));
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
    saveUsageStats({ provider: "deepseek", model: "m", tokens: { prompt_tokens: 10, completion_tokens: 5 }, startedAt: 12345, silent: true });
    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ startedAt: 12345 }));
  });
});
