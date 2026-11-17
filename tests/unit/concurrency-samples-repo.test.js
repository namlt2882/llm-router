import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolated DATA_DIR — the adapter must never touch ~/.9router (see
// db-driver-chain.test.js for the original of this shape). resetModules so
// paths.js re-reads DATA_DIR per test — it caches at import time.
let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-concrepo-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("concurrencySamples round-trip", () => {
  it("inserts rows, selects them back and prunes only old ones", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { recordConcurrencySample, pruneConcurrencySamples } = await import("../../src/lib/db/repos/usageRepo.js");
    const db = await getAdapter();
    await recordConcurrencySample(2, 10);
    const rows = db.all("SELECT ts, inflight, totalBudget FROM concurrencySamples ORDER BY id DESC LIMIT 1");
    expect(Number(rows[0].inflight)).toBe(2);
    expect(Number(rows[0].totalBudget)).toBe(10);
    await pruneConcurrencySamples(db, new Date(Date.now() + 86400000).toISOString()); // cutoff in the future
    expect(db.all("SELECT id FROM concurrencySamples WHERE inflight = '2' AND totalBudget = '10'")).toHaveLength(0);
  });

  it("persists the per-provider split as JSON in byProvider, null when none given", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { recordConcurrencySample } = await import("../../src/lib/db/repos/usageRepo.js");
    const db = await getAdapter();
    await recordConcurrencySample(3, 10, { byProvider: { glm: 2, oc: 1 } });
    await recordConcurrencySample(1, 10);
    const rows = db.all("SELECT inflight, byProvider FROM concurrencySamples ORDER BY id ASC");
    expect(JSON.parse(rows[0].byProvider)).toEqual({ glm: 2, oc: 1 });
    expect(rows[1].byProvider).toBeNull();
  });
});
