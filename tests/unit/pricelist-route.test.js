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

let listBuilder = async () => [{ id: "cc/claude-sonnet-4-6", owned_by: "cc" }, { id: "cc/unknown", owned_by: "cc" }];

async function loadRoute({ fxFails = false } = {}) {
  vi.resetModules();
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json", ...(init.headers || {}) } }),
    },
  }));
  vi.doMock("@/lib/fx/fxRate.js", () => ({
    getFloorRate: async () => {
      if (fxFails) throw new Error("no fx");
      return { rate: 25500, stale: false, source: "test", pinned: false };
    },
  }));
  vi.doMock("@/lib/db/repos/pricingRepo.js", () => ({
    getPricingForModel: async (provider, model) =>
      provider === "cc" && model === "claude-sonnet-4-6" ? { input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 } : null,
  }));
  vi.doMock("@/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => null }));
  vi.doMock("@/app/api/v1/models/route.js", () => ({
    buildModelsList: (...a) => listBuilder(...a),
  }));
  const repo = await import("@/lib/db/repos/salePriceRepo.js");
  const route = await import("@/app/api/fork/pricelist/route.js");
  const defaults = await import("@/lib/db/repos/priceDefaultRepo.js");
  return { GET: route.GET, repo, defaults };
}

const get = ({ token = "secret-token" } = {}) =>
  new Request("http://router/api/fork/pricelist", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("GET /api/fork/pricelist", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-pricelist-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    for (const m of ["@/lib/fx/fxRate.js", "@/lib/db/repos/pricingRepo.js", "@/lib/db/repos/combosRepo.js", "@/app/api/v1/models/route.js"]) vi.doUnmock(m);
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("401 without the admin token", async () => {
    const { GET } = await loadRoute();
    expect((await GET(get({ token: null }))).status).toBe(401);
  });

  it("lists every served name with its status and the floor rate", async () => {
    const { GET } = await loadRoute();
    const res = await GET(get());
    expect(res.status).toBe(200);
    const { rows, rate } = await res.json();
    expect(rate).toBe(25500);
    expect(rows.find((r) => r.name === "cc/claude-sonnet-4-6")).toMatchObject({ kind: "model", status: "auto", floor: { input: 3 } });
    expect(rows.find((r) => r.name === "cc/unknown")).toMatchObject({ status: "no_base_price" });
  });

  it("removes an expired promotion row from the store when listing", async () => {
    const { GET, repo } = await loadRoute();
    await repo.setSalePrice({ name: "cc/claude-sonnet-4-6", kind: "model", unit: "usd", input: 1, output: 1, cached: 1, reasoning: 1, cacheCreation: 1, source: "promo", endsAt: 1, restore: null });
    const { rows } = await (await GET(get())).json();
    expect(rows.find((r) => r.name === "cc/claude-sonnet-4-6")).toMatchObject({ status: "auto" });
    expect(await repo.getSalePrice("cc/claude-sonnet-4-6")).toBeNull();
  });

  it("puts the restore row back when an expired promotion had one", async () => {
    const { GET, repo } = await loadRoute();
    const restore = { name: "cc/claude-sonnet-4-6", kind: "model", unit: "usd", input: 4, output: 16, cached: 0.4, reasoning: 16, cacheCreation: 5, perImage: 0 };
    await repo.setSalePrice({ ...restore, input: 1, source: "promo", endsAt: 1, restore });
    await GET(get());
    expect(await repo.getSalePrice("cc/claude-sonnet-4-6")).toEqual(restore);
  });

  it("returns a stored legacy credit row as USD and rewrites it in the store", async () => {
    const { GET, repo } = await loadRoute();
    await repo.setSalePrice({ name: "cc/claude-sonnet-4-6", kind: "model", input: 102000, output: 510000, cached: 10200, reasoning: 510000, cacheCreation: 127500, perImage: 0 });
    const { rows } = await (await GET(get())).json();
    const r = rows.find((x) => x.name === "cc/claude-sonnet-4-6");
    expect(r).toMatchObject({ status: "custom", stored: { unit: "usd", input: 4 }, effective: { unit: "usd", input: 4 } });
    expect(await repo.getSalePrice("cc/claude-sonnet-4-6")).toMatchObject({ unit: "usd", input: 4 });
  });

  it("carries the default base setting, off by default with the three factory prices", async () => {
    const { GET } = await loadRoute();
    expect((await (await GET(get())).json()).default).toEqual({ enabled: false, input: 0.05, cached: 0.005, output: 0.1 });
  });

  it("a served name with no base is auto with defaultBase once the default is enabled", async () => {
    const { GET, defaults } = await loadRoute();
    await defaults.setPriceDefault({ enabled: true });
    const { rows, default: d } = await (await GET(get())).json();
    expect(d.enabled).toBe(true);
    expect(rows.find((r) => r.name === "cc/unknown")).toMatchObject({ status: "auto", defaultBase: true, floor: { input: 0.05, cached: 0.005, output: 0.1 } });
    expect(rows.find((r) => r.name === "cc/claude-sonnet-4-6").defaultBase).toBe(false);
  });

  it("an expired names cache is served at once while discovery refreshes in the background", async () => {
    const { GET } = await loadRoute();
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      await GET(get());
      let release;
      const slow = new Promise((r) => { release = r; });
      const calls = vi.fn(async () => { await slow; return [{ id: "cc/new-model", owned_by: "cc" }]; });
      listBuilder = calls;
      clock.mockReturnValue(t0 + 61_000);
      const first = await (await GET(get())).json();
      expect(calls).toHaveBeenCalledTimes(1);
      expect(first.rows.map((r) => r.name)).toContain("cc/unknown");
      expect(first.rows.map((r) => r.name)).not.toContain("cc/new-model");
      release();
      await new Promise((r) => setTimeout(r, 10));
      const second = await (await GET(get())).json();
      expect(second.rows.map((r) => r.name)).toContain("cc/new-model");
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      listBuilder = async () => [{ id: "cc/claude-sonnet-4-6", owned_by: "cc" }, { id: "cc/unknown", owned_by: "cc" }];
    }
  });

  it("503 without a floor rate", async () => {
    const { GET } = await loadRoute({ fxFails: true });
    expect((await GET(get())).status).toBe(503);
  });
});
