// Patch #31 pin: the sale-side default base price must never reach the usage/cost screens,
// which read usageHistory.cost computed from provider-base pricing only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let setPriceDefault;

const TOKENS = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-cost-pin-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ setPriceDefault } = await import("@/lib/db/repos/priceDefaultRepo.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function costOf(provider, model, at) {
  const entry = { provider, model, tokens: TOKENS, timestamp: at, status: "ok", connectionId: "c1" };
  await db.saveRequestUsage(entry);
  return entry.cost;
}

describe("usage cost is independent of the default base price", () => {
  it("a model with real pricing costs the same with the default base off and on", async () => {
    await setPriceDefault({ enabled: false });
    const off = await costOf("anthropic", "claude-sonnet-4-6", "2026-11-01T10:00:00.000Z");
    await setPriceDefault({ enabled: true, input: 9, cached: 9, output: 9 });
    const on = await costOf("anthropic", "claude-sonnet-4-6", "2026-11-01T11:00:00.000Z");
    expect(off).toBeGreaterThan(0);
    expect(on).toBe(off);
  });

  it("a model with no base pricing stays at cost 0 even with the default base enabled", async () => {
    await setPriceDefault({ enabled: true, input: 9, cached: 9, output: 9 });
    expect(await costOf("nopricing", "mystery-model", "2026-11-01T12:00:00.000Z")).toBe(0);
  });
});
