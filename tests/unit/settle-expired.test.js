import { describe, expect, it, vi } from "vitest";

const promo = (over = {}) => ({ name: "cc/m", kind: "model", input: 5, output: 5, cached: 5, reasoning: 5, cacheCreation: 5, perImage: 0, source: "promo", endsAt: 1000, restore: null, ...over });
const markup = { name: "cc/m", kind: "model", input: 9, output: 9, cached: 9, reasoning: 9, cacheCreation: 9, perImage: 0, source: "markup", pct: 10 };

async function run({ list, current, now = 1000 }) {
  vi.resetModules();
  const { settleExpired } = await import("@/lib/pricing/settleExpired.js");
  const set = vi.fn(async (r) => r);
  const remove = vi.fn(async () => {});
  await settleExpired({ list: async () => list, get: async () => current, set, remove, now });
  return { set, remove };
}

describe("settleExpired", () => {
  it("writes the restore row back for an expired promotion", async () => {
    const restore = { ...markup, source: undefined, input: 7 };
    const p = promo({ restore });
    const { set, remove } = await run({ list: [p], current: p });
    expect(set).toHaveBeenCalledWith(restore);
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the row when the expired promotion has no restore", async () => {
    const p = promo();
    const { set, remove } = await run({ list: [p], current: p });
    expect(remove).toHaveBeenCalledWith("cc/m");
    expect(set).not.toHaveBeenCalled();
  });

  it("leaves an active promotion alone", async () => {
    const p = promo({ endsAt: 2000 });
    const { set, remove } = await run({ list: [p], current: p });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer price written after the snapshot was taken", async () => {
    const p = promo({ restore: { ...markup, input: 7 } });
    const { set, remove } = await run({ list: [p], current: markup });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does nothing when the row was already removed after the snapshot", async () => {
    const { set, remove } = await run({ list: [promo()], current: null });
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
