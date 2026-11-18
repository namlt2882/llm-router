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

const OP = { schedule: "deepseek", factor: 0.5 };

describe("an admin base-price override keeps the vendor's off-peak schedule", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-offpeak-override-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });
  afterEach(() => {
    dropAdapter();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("an edited deepseek-v4-pro row still carries offPeak", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    await repo.updatePricing({ deepseek: { "deepseek-v4-pro": { input: 3, output: 6 } } });
    const row = await repo.getPricingForModel("deepseek", "deepseek-v4-pro");
    expect(row.input).toBe(3);
    expect(row.offPeak).toEqual(OP);
  });

  it("an override that sets its own offPeak wins", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    const own = { schedule: "deepseek", factor: 0.25 };
    await repo.updatePricing({ deepseek: { "deepseek-v4-pro": { input: 3, output: 6, offPeak: own } } });
    expect((await repo.getPricingForModel("deepseek", "deepseek-v4-pro")).offPeak).toEqual(own);
  });

  it("an override of a flat legacy model stays flat", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    await repo.updatePricing({ deepseek: { "deepseek-chat": { input: 1, output: 2 } } });
    expect((await repo.getPricingForModel("deepseek", "deepseek-chat")).offPeak).toBeUndefined();
  });
});
