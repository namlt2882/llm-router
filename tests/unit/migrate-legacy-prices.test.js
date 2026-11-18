import { describe, expect, it, vi } from "vitest";

const legacy = (name, input = 30000, restore) => ({
  name, kind: "model", input, output: input * 4, cached: input / 10, reasoning: input * 4, cacheCreation: input * 1.25, perImage: 0,
  ...(restore !== undefined ? { source: "promo", endsAt: 9e15, restore } : {}),
});
const usd = (name) => ({ name, kind: "model", unit: "usd", input: 1, output: 4, cached: 0.1, reasoning: 4, cacheCreation: 1.25, perImage: 0 });

async function load() {
  vi.resetModules();
  return import("@/lib/pricing/migrateLegacyPrices.js");
}
const fake = (rows) => {
  const store = new Map(rows.map((r) => [r.name, r]));
  const set = vi.fn(async (r) => { store.set(r.name, r); });
  const update = vi.fn(async (name, fn) => {
    const next = fn(store.get(name) ?? null);
    if (next !== undefined) await set(next);
  });
  return { store, set, update, list: async () => [...store.values()], get: async (n) => store.get(n) ?? null };
};

describe("migrateLegacyPrices", () => {
  it("writes a legacy row once as USD, converting the nested restore row", async () => {
    const { migrateLegacyPrices } = await load();
    const f = fake([legacy("cc/a", 30000, legacy("cc/a", 25000)), usd("cc/b")]);
    expect(await migrateLegacyPrices({ rate: 25000, ...f })).toBe(1);
    expect(f.set).toHaveBeenCalledTimes(1);
    const written = f.store.get("cc/a");
    expect(written).toMatchObject({ unit: "usd", input: 1.2, source: "promo" });
    expect(written.restore).toMatchObject({ unit: "usd", input: 1 });
    expect(f.store.get("cc/b")).toEqual(usd("cc/b"));
  });

  it("a second run writes nothing", async () => {
    const { migrateLegacyPrices } = await load();
    const f = fake([legacy("cc/a")]);
    await migrateLegacyPrices({ rate: 25000, ...f });
    expect(await migrateLegacyPrices({ rate: 25000, ...f })).toBe(0);
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it("skips a row that a concurrent PUT turned into USD after the list", async () => {
    const { migrateLegacyPrices } = await load();
    const f = fake([legacy("cc/a")]);
    const racing = { ...f, update: async (name, fn) => { const next = fn(usd(name)); if (next !== undefined) await f.set(next); } };
    expect(await migrateLegacyPrices({ rate: 25000, ...racing })).toBe(0);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("decides inside one atomic update, so a PUT can never be overwritten between a read and a write", async () => {
    const { migrateLegacyPrices } = await load();
    const f = fake([legacy("cc/a")]);
    await migrateLegacyPrices({ rate: 25000, ...f });
    expect(f.update).toHaveBeenCalledWith("cc/a", expect.any(Function));
  });

  it("writes nothing without a positive finite rate", async () => {
    const { migrateLegacyPrices } = await load();
    for (const rate of [undefined, 0, -1, NaN, Infinity]) {
      const f = fake([legacy("cc/a")]);
      expect(await migrateLegacyPrices({ rate, ...f })).toBe(0);
      expect(f.set).not.toHaveBeenCalled();
    }
  });
});
