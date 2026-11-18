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
        new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json", ...(init.headers || {}) } }),
    },
  }));
  return import("@/app/api/fork/pricedefault/route.js");
}

const req = (method, body, { token = "secret-token" } = {}) =>
  new Request("http://router/api/fork/pricedefault", {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

describe("/api/fork/pricedefault", () => {
  beforeEach(() => {
    dropAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-pricedefault-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    dropAdapter();
    vi.unstubAllEnvs();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("401 without the admin token", async () => {
    const { GET, PUT } = await loadRoute();
    expect((await GET(req("GET", undefined, { token: null }))).status).toBe(401);
    expect((await PUT(req("PUT", { enabled: true }, { token: null }))).status).toBe(401);
  });

  it("a fresh database returns the factory default, off", async () => {
    const { GET } = await loadRoute();
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ default: { enabled: false, input: 0.05, cached: 0.005, output: 0.1 } });
  });

  it("PUT merges a partial patch and keeps the rest", async () => {
    const { GET, PUT } = await loadRoute();
    expect((await PUT(req("PUT", { enabled: true }))).status).toBe(200);
    expect((await (await GET(req("GET"))).json()).default).toEqual({ enabled: true, input: 0.05, cached: 0.005, output: 0.1 });
    const res = await PUT(req("PUT", { input: 0.07 }));
    expect((await res.json()).default).toEqual({ enabled: true, input: 0.07, cached: 0.005, output: 0.1 });
  });

  it("400 for invalid values and a bad body", async () => {
    const { PUT } = await loadRoute();
    for (const body of [{ input: -1 }, { input: "x" }, { enabled: "yes" }, { output: null }, { cached: 2e6 }, "{not json", [], null]) {
      expect((await PUT(req("PUT", body))).status, JSON.stringify(body)).toBe(400);
    }
  });
});
