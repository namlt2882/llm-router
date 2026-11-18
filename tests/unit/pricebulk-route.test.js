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
  const repo = await import("@/lib/db/repos/salePriceRepo.js");
  const route = await import("@/app/api/fork/pricebulk/route.js");
  return { POST: route.POST, repo };
}

const post = (body, { token = "secret-token" } = {}) =>
  new Request("http://router/api/fork/pricebulk", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const NAME = "cc/claude-sonnet-4-6";
const FUTURE = () => Date.now() + 3_600_000;

describe("POST /api/fork/pricebulk", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-pricebulk-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/fx/fxRate.js");
    vi.doUnmock("@/lib/db/repos/pricingRepo.js");
    vi.doUnmock("@/lib/db/repos/combosRepo.js");
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("401 without the admin token", async () => {
    const { POST } = await loadRoute();
    expect((await POST(post({ action: "markup", names: [NAME], pct: 10 }, { token: null }))).status).toBe(401);
  });

  it("400 for malformed or out-of-range bodies", async () => {
    const { POST } = await loadRoute();
    const bad = [
      "not json",
      { action: "nope", names: [NAME], pct: 10 },
      { action: "markup", names: [NAME], pct: 0 },
      { action: "markup", names: [NAME], pct: 501 },
      { action: "promo", names: [NAME], pct: 101, endsAt: FUTURE() },
      { action: "promo", names: [NAME], pct: 10 },
      { action: "promo", names: [NAME], pct: 10, endsAt: Date.now() - 1000 },
      { action: "markup", names: [], pct: 10 },
      { action: "markup", names: [""], pct: 10 },
      { action: "markup", names: Array.from({ length: 501 }, (_, i) => `cc/m${i}`), pct: 10 },
    ];
    for (const body of bad) expect((await POST(post(body))).status, JSON.stringify(body).slice(0, 80)).toBe(400);
  });

  it("markup 10% saves 1.1x the floor and the stored row shows it", async () => {
    const { POST, repo } = await loadRoute();
    const res = await POST(post({ action: "markup", names: [NAME], pct: 10 }));
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[0]).toMatchObject({ name: NAME, ok: true });
    // floor input = $3 per 1M; x1.1 = $3.3
    expect(await repo.getSalePrice(NAME)).toMatchObject({ unit: "usd", input: 3.3, source: "markup", pct: 10 });
  });

  it("promo saves restore and endsAt and reports belowFloor", async () => {
    const { POST, repo } = await loadRoute();
    const endsAt = FUTURE();
    const { results } = await (await POST(post({ action: "promo", names: [NAME], pct: 20, endsAt }))).json();
    expect(results[0]).toMatchObject({ ok: true, belowFloor: true });
    expect(await repo.getSalePrice(NAME)).toMatchObject({ unit: "usd", input: 2.4, source: "promo", endsAt, restore: null });
  });

  it("reports a name without base pricing per name and still 200s", async () => {
    const { POST } = await loadRoute();
    const { results } = await (await POST(post({ action: "markup", names: [NAME, "cc/unknown"], pct: 10 }))).json();
    expect(results.find((r) => r.name === "cc/unknown")).toMatchObject({ ok: false, error: "unsellable" });
    expect(results.find((r) => r.name === NAME)).toMatchObject({ ok: true });
  });

  it("503 and nothing written when the floor rate is unavailable", async () => {
    const { POST, repo } = await loadRoute({ fxFails: true });
    const res = await POST(post({ action: "markup", names: [NAME], pct: 10 }));
    expect(res.status).toBe(503);
    expect(await repo.getSalePrice(NAME)).toBeNull();
  });
});
