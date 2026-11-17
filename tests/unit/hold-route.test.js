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

async function loadRoute() {
  vi.resetModules();
  vi.stubEnv("WAVEBOT_FORK_ADMIN_TOKEN", "secret-token");
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }),
    },
  }));
  const usage = await import("@/lib/db/repos/usageRepo.js");
  const route = await import("@/app/api/fork/hold/[id]/route.js");
  return { usage, GET: route.GET };
}

const get = (id, { token = "secret-token" } = {}) => [
  new Request(`http://router/api/fork/hold/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  { params: Promise.resolve({ id }) },
];

describe("GET /api/fork/hold/:id", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-holdroute-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns what the router recorded for the hold, summed over its calls", async () => {
    const { usage, GET } = await loadRoute();
    const base = { timestamp: "2026-11-17T10:00:00.000Z", provider: "cc", model: "cheap", connectionId: "c1", tokens: { prompt_tokens: 1, completion_tokens: 1 } };
    await usage.saveRequestUsage({ ...base, holdId: "h-42", costCredits: 30 });
    await usage.saveRequestUsage({ ...base, timestamp: "2026-11-17T10:00:01.000Z", holdId: "h-42", costCredits: 12 });
    const res = await GET(...get("h-42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ holdId: "h-42", costCredits: 42, attempts: 2 });
  });

  it("answers 404 for a hold the router never saw, so the caller can tell unknown from free", async () => {
    const { GET } = await loadRoute();
    const res = await GET(...get("never-seen"));
    expect(res.status).toBe(404);
  });

  it("401 without the admin bearer", async () => {
    const { GET } = await loadRoute();
    expect((await GET(...get("h-1", { token: null }))).status).toBe(401);
    expect((await GET(...get("h-1", { token: "wrong" }))).status).toBe(401);
  });
});
