import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SALE = { name: "cc/cheap", kind: "model", input: 1000, output: 4000, cached: 100, reasoning: 5000, cacheCreation: 1250 };
const originalDataDir = process.env.DATA_DIR;
let tempDir;

function dropAdapter() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
}

async function loadRoute() {
  vi.resetModules();
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
    },
  }));
  vi.doMock("@/lib/fx/fxRate.js", () => ({ getFloorRate: async () => ({ rate: 25500, stale: false, source: "test", pinned: false }) }));
  const repo = await import("@/lib/db/repos/salePriceRepo.js");
  await repo.setSalePrice(SALE);
  await repo.setSalePrice({ ...SALE, name: "cc/pic", perImage: 3 });
  return import("@/app/api/fork/quote/route.js");
}

const post = (body, { token = "secret-token" } = {}) =>
  new Request("http://router/api/fork/quote", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/fork/quote", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-quote-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/fx/fxRate.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the worst case ceil((in*input + max*output + reasoning*reasoning)/1e6) with the sale price and floor rate", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ model: "cc/cheap", inputTokens: 100_000, maxTokens: 10_000, reasoningAllowance: 2_000 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 100000*1000 + 10000*4000 + 2000*5000 = 150,000,000 / 1e6 = 150
    expect(body.creditsWorstCase).toBe(150);
    expect(body.sale).toMatchObject({ input: 1000, output: 4000, cached: 100, reasoning: 5000, cacheCreation: 1250 });
    expect(body.floorRate).toBe(25500);
  });

  it("rounds a fractional worst case up", async () => {
    const { POST } = await loadRoute();
    const body = await (await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 0 }))).json();
    expect(body.creditsWorstCase).toBe(1);
  });

  it("adds the per-image price for attached images", async () => {
    const { POST } = await loadRoute();
    const body = await (await POST(post({ model: "cc/pic", inputTokens: 0, maxTokens: 0, images: 4 }))).json();
    expect(body.creditsWorstCase).toBe(12);
  });

  it("401 without the admin bearer", async () => {
    const { POST } = await loadRoute();
    expect((await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 1 }, { token: null }))).status).toBe(401);
    expect((await POST(post({ model: "cc/cheap", inputTokens: 1, maxTokens: 1 }, { token: "wrong" }))).status).toBe(401);
  });

  it("402 not_sellable for a model with no sale price", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ model: "no/such", inputTokens: 1, maxTokens: 1 }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "not_sellable" });
  });

  it("400 on malformed numbers or JSON", async () => {
    const { POST } = await loadRoute();
    for (const bad of [{ model: "cc/cheap", inputTokens: -1, maxTokens: 1 }, { model: "cc/cheap", inputTokens: 1, maxTokens: "x" }, { inputTokens: 1, maxTokens: 1 }, { model: "cc/cheap", inputTokens: 1e18, maxTokens: 1 }, "{nope"]) {
      expect((await POST(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
