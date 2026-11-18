import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

const base = (n) => ({ input: n, output: n * 4, cached: n / 10, reasoning: n * 4, cache_creation: n * 1.25 });
const BASES = {
  "cc/cheap": base(1),
  "cc/dear": base(10),
  "cc/third": { input: 1 / 3, output: 1, cached: 0.1, reasoning: 1, cache_creation: 0.5 },
  "cl/free-model": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
  "cc/sparse": { input: 2, output: 8 },
};
const COMBOS = {
  mixed: ["cc/cheap", "cc/dear"],
  outer: ["mixed", "cc/cheap"],
  twice: ["cc/cheap", "cc/cheap", "cc/dear"],
  loop: ["loop2"],
  loop2: ["loop"],
  holey: ["cc/cheap", "cc/unknown"],
  sparsemix: ["cc/dear", "cc/sparse"],
};
const DEFAULTED = { input: 0.05, output: 0.1, cached: 0.005, reasoning: 0.1, cache_creation: 0.05, defaulted: true };
const ctxAt = (rate, { withDefault = false } = {}) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? (withDefault && name.includes("/") ? DEFAULTED : null),
  comboModels: async (name) => COMBOS[name] ?? null,
});
// A USD price row equal to a base (mult 1 = exactly the floor).
const usd = (mult, b) => ({
  unit: "usd",
  input: b.input * mult,
  output: b.output * mult,
  cached: b.cached * mult,
  reasoning: b.reasoning * mult,
  cacheCreation: b.cache_creation * mult,
});
const AVG_MIXED = { input: 5.5, output: 22, cached: 0.55, reasoning: 22, cache_creation: 6.875 };

async function load() {
  vi.resetModules();
  return import("@/lib/pricing/validateSalePrice.js");
}

describe("validateSalePrice (USD)", () => {
  it("a model priced exactly at its base passes, a micro-unit below fails", async () => {
    const { validateSalePrice } = await load();
    const at = { name: "cc/cheap", kind: "model", ...usd(1, BASES["cc/cheap"]) };
    expect(await validateSalePrice(at, ctxAt(25000))).toEqual({ ok: true });
    expect(await validateSalePrice({ ...at, output: 3.999999 }, ctxAt(25000))).toEqual({ ok: false, field: "output", minimum: 4 });
  });

  it("a combo floors at the average of its members, not the dearest", async () => {
    const { validateSalePrice } = await load();
    const atAvg = { name: "mixed", kind: "combo", ...usd(1, AVG_MIXED) };
    expect(await validateSalePrice(atAvg, ctxAt(25000))).toEqual({ ok: true });
    const atDear = { name: "mixed", kind: "combo", ...usd(1, BASES["cc/dear"]) };
    expect(await validateSalePrice(atDear, ctxAt(25000))).toEqual({ ok: true });
    const atCheap = { name: "mixed", kind: "combo", ...usd(1, BASES["cc/cheap"]) };
    expect(await validateSalePrice(atCheap, ctxAt(25000))).toEqual({ ok: false, field: "input", minimum: 5.5 });
  });

  it("a base that omits cached / reasoning / cache write is costed like the cost model does: at input / output / input", async () => {
    const { costFloor } = await load();
    const { floor } = await costFloor("cc/sparse", "model", ctxAt(25000));
    expect(floor).toMatchObject({ input: 2, output: 8, cached: 2, reasoning: 8, cacheCreation: 2 });
  });

  it("a combo averages the fallback, not zero, for a member that omits a field", async () => {
    const { costFloor } = await load();
    const { floor } = await costFloor("sparsemix", "combo", ctxAt(25000));
    // dear: input 10, cached 1, reasoning 40, cache write 12.5; sparse falls back to 2 / 2 / 8 / 2.
    expect(floor).toMatchObject({ input: 6, cached: 1.5, reasoning: 24, cacheCreation: 7.25 });
  });

  it("a nested combo counts as one member at its own average", async () => {
    const { costFloor } = await load();
    const { floor } = await costFloor("outer", "combo", ctxAt(25000));
    expect(floor).toMatchObject({ input: 3.25, output: 13 });
  });

  it("a duplicated member counts each time", async () => {
    const { costFloor } = await load();
    expect((await costFloor("twice", "combo", ctxAt(25000))).floor.input).toBe(4);
  });

  it("a fractional floor rounds up to 6 decimals", async () => {
    const { validateSalePrice } = await load();
    const row = { name: "cc/third", kind: "model", unit: "usd", input: 0.333334, output: 1, cached: 0.1, reasoning: 1, cacheCreation: 0.5 };
    expect(await validateSalePrice(row, ctxAt(25000))).toEqual({ ok: true });
    expect(await validateSalePrice({ ...row, input: 0.333333 }, ctxAt(25000))).toMatchObject({ ok: false, field: "input", minimum: 0.333334 });
  });

  it("the verdict does not depend on the FX rate", async () => {
    const { validateSalePrice } = await load();
    const at = { name: "cc/cheap", kind: "model", ...usd(1, BASES["cc/cheap"]) };
    expect(await validateSalePrice(at, ctxAt(25000))).toEqual({ ok: true });
    expect(await validateSalePrice(at, ctxAt(40000))).toEqual({ ok: true });
  });

  it("a free-namespace base of 0 accepts any non-negative price", async () => {
    const { validateSalePrice } = await load();
    const zero = { name: "cl/free-model", kind: "model", input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0 };
    expect(await validateSalePrice(zero, ctxAt(25000))).toEqual({ ok: true });
    expect((await validateSalePrice({ ...zero, input: -1 }, ctxAt(25000))).ok).toBe(false);
  });

  it("a name with no base is unsellable, and so is a combo with an unpriced member", async () => {
    const { validateSalePrice } = await load();
    const m = { name: "cc/unknown", kind: "model", ...usd(1, BASES["cc/cheap"]) };
    expect(await validateSalePrice(m, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "unsellable" });
    const c = { name: "holey", kind: "combo", ...usd(9, BASES["cc/dear"]) };
    expect(await validateSalePrice(c, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "unsellable" });
  });

  it("with a default base the unpriced member counts and the floor reports it defaulted", async () => {
    const { costFloor } = await load();
    const r = await costFloor("holey", "combo", ctxAt(25000, { withDefault: true }));
    expect(r.floor.input).toBe(0.525);
    expect(r.defaulted).toBe(true);
    const real = await costFloor("mixed", "combo", ctxAt(25000, { withDefault: true }));
    expect(real.defaulted).toBe(false);
  });

  it("a combo that references itself is refused, not looped on", async () => {
    const { validateSalePrice } = await load();
    const c = { name: "loop", kind: "combo", ...usd(9, BASES["cc/dear"]) };
    expect(await validateSalePrice(c, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "combo_cycle" });
  });

  it("refuses a price above 1,000,000 USD per 1M tokens (an old credit number saved as USD)", async () => {
    const { validateSalePrice } = await load();
    const c = ctxAt(25000);
    expect(await validateSalePrice({ name: "cc/cheap", kind: "model", ...usd(1, base(1)), input: 1_000_000 }, c)).toEqual({ ok: true });
    expect(await validateSalePrice({ name: "cc/cheap", kind: "model", ...usd(1, base(1)), output: 1_000_001 }, c)).toMatchObject({
      ok: false, field: "output", reason: "too_high", maximum: 1_000_000,
    });
  });

  it("refuses a missing or non-numeric field and a kind that does not match the name", async () => {
    const { validateSalePrice } = await load();
    const good = { name: "cc/cheap", kind: "model", ...usd(1, BASES["cc/cheap"]) };
    expect(await validateSalePrice({ ...good, cached: undefined }, ctxAt(25000))).toMatchObject({ ok: false, field: "cached" });
    expect(await validateSalePrice({ ...good, input: "9" }, ctxAt(25000))).toMatchObject({ ok: false, field: "input" });
    expect(await validateSalePrice({ ...good, kind: "combo" }, ctxAt(25000))).toMatchObject({ ok: false, field: "kind" });
  });
});

describe("sale price store", () => {
  function dropAdapter() {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
  }
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-sale-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("a rate move never flags a stored USD row; a legacy credit row is judged at the current rate", async () => {
    vi.resetModules();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    const { listFlagged } = await import("@/lib/pricing/validateSalePrice.js");
    const row = { name: "cc/cheap", kind: "model", ...usd(1, BASES["cc/cheap"]) };
    await repo.setSalePrice(row);
    expect(await listFlagged(ctxAt(25000))).toEqual([]);
    expect(await listFlagged(ctxAt(40000))).toEqual([]);
    expect(await repo.getSalePrice("cc/cheap")).toMatchObject({ input: 1, unit: "usd" });

    const credits = { name: "cc/cheap", kind: "model", input: 25000, output: 100000, cached: 2500, reasoning: 100000, cacheCreation: 31250 };
    await repo.setSalePrice(credits);
    expect(await listFlagged(ctxAt(25000))).toEqual([]);
    await repo.setSalePrice({ ...credits, input: 24999 });
    const flagged = await listFlagged(ctxAt(25000));
    expect(flagged.map((f) => f.name)).toEqual(["cc/cheap"]);
    expect(flagged[0].violation).toMatchObject({ ok: false, field: "input", minimum: 1 });
    expect(await repo.getSalePrice("cc/cheap")).toMatchObject({ input: 24999 });
  });

  it("listFlagged leaves a deliberate promotion out: it is under cost on purpose and the row badge already says so", async () => {
    vi.resetModules();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    const { listFlagged } = await import("@/lib/pricing/validateSalePrice.js");
    const cheap = BASES["cc/cheap"];
    await repo.setSalePrice({ name: "cc/cheap", kind: "model", ...usd(0.5, cheap), source: "promo", pct: 50, endsAt: Date.now() + 1e6, restore: null });
    expect(await listFlagged(ctxAt(25000))).toEqual([]);
    await repo.setSalePrice({ name: "cc/cheap", kind: "model", ...usd(0.5, cheap), source: "markup", pct: 0 });
    expect((await listFlagged(ctxAt(25000))).map((f) => f.name)).toEqual(["cc/cheap"]);
  });

  it("getSalePrice is null for an unpriced name and delete removes the row", async () => {
    vi.resetModules();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    expect(await repo.getSalePrice("nope")).toBeNull();
    await repo.setSalePrice({ name: "a", kind: "model", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1 });
    await repo.removeSalePrice("a");
    expect(await repo.getSalePrice("a")).toBeNull();
  });
});
