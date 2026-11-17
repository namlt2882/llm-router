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
  "cl/free-model": { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
};
const COMBOS = {
  mixed: ["cc/cheap", "cc/dear"],
  outer: ["mixed", "cc/cheap"],
  loop: ["loop2"],
  loop2: ["loop"],
  holey: ["cc/cheap", "cc/unknown"],
};
const ctxAt = (rate) => ({
  rate,
  baseFor: async (name) => BASES[name] ?? null,
  comboModels: async (name) => COMBOS[name] ?? null,
});
const price = (mult, rate, b) => ({
  input: b.input * rate * mult,
  output: b.output * rate * mult,
  cached: b.cached * rate * mult,
  reasoning: b.reasoning * rate * mult,
  cacheCreation: b.cache_creation * rate * mult,
});

async function load() {
  vi.resetModules();
  return import("@/lib/pricing/validateSalePrice.js");
}

describe("validateSalePrice", () => {
  it("a model priced exactly at base × rate passes, one unit below fails", async () => {
    const { validateSalePrice } = await load();
    const at = { name: "cc/cheap", kind: "model", ...price(1, 25000, BASES["cc/cheap"]) };
    expect(await validateSalePrice(at, ctxAt(25000))).toEqual({ ok: true });
    const below = { ...at, output: at.output - 1 };
    expect(await validateSalePrice(below, ctxAt(25000))).toEqual({ ok: false, field: "output", minimum: at.output });
  });

  it("a combo floors at its dearest member", async () => {
    const { validateSalePrice } = await load();
    const atDear = { name: "mixed", kind: "combo", ...price(1, 25000, BASES["cc/dear"]) };
    expect(await validateSalePrice(atDear, ctxAt(25000))).toEqual({ ok: true });
    const atCheap = { name: "mixed", kind: "combo", ...price(1, 25000, BASES["cc/cheap"]) };
    const r = await validateSalePrice(atCheap, ctxAt(25000));
    expect(r.ok).toBe(false);
    expect(r.minimum).toBe(BASES["cc/dear"][r.field === "cacheCreation" ? "cache_creation" : r.field] * 25000);
  });

  it("a nested combo is expanded to its leaves", async () => {
    const { validateSalePrice } = await load();
    const atCheap = { name: "outer", kind: "combo", ...price(1, 25000, BASES["cc/cheap"]) };
    expect((await validateSalePrice(atCheap, ctxAt(25000))).ok).toBe(false);
    const atDear = { name: "outer", kind: "combo", ...price(1, 25000, BASES["cc/dear"]) };
    expect(await validateSalePrice(atDear, ctxAt(25000))).toEqual({ ok: true });
  });

  it("a free-namespace base of 0 accepts any non-negative price", async () => {
    const { validateSalePrice } = await load();
    const zero = { name: "cl/free-model", kind: "model", input: 0, output: 0, cached: 0, reasoning: 0, cacheCreation: 0 };
    expect(await validateSalePrice(zero, ctxAt(25000))).toEqual({ ok: true });
    expect((await validateSalePrice({ ...zero, input: -1 }, ctxAt(25000))).ok).toBe(false);
  });

  it("a name with no base price is unsellable, and so is a combo with an unpriced member", async () => {
    const { validateSalePrice } = await load();
    const m = { name: "cc/unknown", kind: "model", ...price(1, 25000, BASES["cc/cheap"]) };
    expect(await validateSalePrice(m, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "unsellable" });
    const c = { name: "holey", kind: "combo", ...price(9, 25000, BASES["cc/dear"]) };
    expect(await validateSalePrice(c, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "unsellable" });
  });

  it("a combo that references itself is refused, not looped on", async () => {
    const { validateSalePrice } = await load();
    const c = { name: "loop", kind: "combo", ...price(9, 25000, BASES["cc/dear"]) };
    expect(await validateSalePrice(c, ctxAt(25000))).toMatchObject({ ok: false, field: "name", reason: "combo_cycle" });
  });

  it("refuses a missing or non-numeric field and a kind that does not match the name", async () => {
    const { validateSalePrice } = await load();
    const good = { name: "cc/cheap", kind: "model", ...price(1, 25000, BASES["cc/cheap"]) };
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

  it("a raised rate flags a stored row without rewriting it", async () => {
    vi.resetModules();
    const repo = await import("@/lib/db/repos/salePriceRepo.js");
    const { listFlagged } = await import("@/lib/pricing/validateSalePrice.js");
    const row = { name: "cc/cheap", kind: "model", ...price(1, 25000, BASES["cc/cheap"]) };
    await repo.setSalePrice(row);
    expect(await listFlagged(ctxAt(25000))).toEqual([]);
    const flagged = await listFlagged(ctxAt(25000 * 1.05));
    expect(flagged.map((f) => f.name)).toEqual(["cc/cheap"]);
    expect(flagged[0].violation.ok).toBe(false);
    expect(await repo.getSalePrice("cc/cheap")).toMatchObject({ input: row.input });
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

describe("/api/fork/saleprice", () => {
  async function loadRoute() {
    vi.resetModules();
    vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
    vi.doMock("next/server", () => ({
      NextResponse: {
        json: (body, init = {}) =>
          new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
      },
    }));
    vi.doMock("@/lib/pricing/validateSalePrice.js", async (orig) => ({
      ...(await orig()),
      defaultContext: async () => ctxAt(25000),
    }));
    return import("@/app/api/fork/saleprice/route.js");
  }
  const req = (method, { token = "secret-token", body, query = "" } = {}) =>
    new Request(`http://router/api/fork/saleprice${query}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  function dropAdapter() {
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
  }
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-sale-api-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses without the admin bearer", async () => {
    const { GET, PUT, DELETE } = await loadRoute();
    expect((await GET(req("GET", { token: null }))).status).toBe(401);
    expect((await PUT(req("PUT", { token: null, body: {} }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { token: null, query: "?name=x" }))).status).toBe(401);
  });

  it("PUT stores a valid price, 422s a below-floor one, GET lists, DELETE removes", async () => {
    const { GET, PUT, DELETE } = await loadRoute();
    const good = { name: "cc/cheap", kind: "model", ...price(1, 25000, BASES["cc/cheap"]) };
    expect((await PUT(req("PUT", { body: good }))).status).toBe(200);
    const low = await PUT(req("PUT", { body: { ...good, input: good.input - 1 } }));
    expect(low.status).toBe(422);
    expect(await low.json()).toMatchObject({ error: "below_floor", field: "input", minimum: good.input });
    const list = await (await GET(req("GET"))).json();
    expect(list.prices.map((p) => p.name)).toEqual(["cc/cheap"]);
    expect((await DELETE(req("DELETE", { query: "?name=cc%2Fcheap" }))).status).toBe(200);
    expect((await (await GET(req("GET"))).json()).prices).toEqual([]);
  });
});
